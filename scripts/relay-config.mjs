/**
 * Find a relay that works, and make it the site's default.
 *
 * YouTube refuses web pages, and public Invidious instances close their video
 * endpoint to pages too — but not to a plain client, and a relay is a plain
 * client. The best relay is one you deploy (relay/); until then, a public CORS
 * proxy can carry the same requests. Which of those work changes month to
 * month, so this is measured rather than assumed: from a machine with real
 * network (a GitHub runner), each candidate is asked exactly what the page
 * asks, and the first that passes is written to web/config.json, which the
 * Pages deploy publishes beside the app. The app adopts it for a visitor
 * with nothing set, names it on screen, and respects a clear.
 *
 * What "passes" means, in the order it is checked:
 *   1. it fetches youtube.com/robots.txt for a page (200, a User-agent line,
 *      Access-Control-Allow-Origin present when asked with an Origin);
 *   2. through it, some bundled Invidious instance answers the video endpoint
 *      with a stream list — the instance is recorded too, to be tried first;
 *   3. through it, the first bytes of that instance's proxied media arrive
 *      (a Range for 64 KB → 200 or 206 with a video/audio content type).
 *
 * Your own relay, given as SIPHON_RELAY_URL, is tried first and wins when it
 * passes. Nothing passing leaves the file with an empty relay — no visitor is
 * pointed at a proxy that does not work.
 *
 *   SIPHON_RELAY_URL=https://you.workers.dev node scripts/relay-config.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cobaltEntries, COBALT_DIRECTORY } from '../web/instances.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TARGET = join(HERE, '..', 'web', 'config.json');
const INSTANCES = join(HERE, '..', 'web', 'instances.json');

export const ORIGIN = 'https://maxgfr.github.io';
export const ROBOTS = 'https://www.youtube.com/robots.txt';
export const VIDEO_ID = 'jNQXAC9IVRw';

/**
 * Public CORS proxies, as templates: `{url}` is the encoded target, `{raw}`
 * the target as is. Free tiers come and go, some refuse an Origin they do not
 * know, some carry GET only — all of which the checks below find out.
 */
export const PUBLIC_RELAYS = Object.freeze([
  'https://corsproxy.io/?url={url}',
  'https://api.cors.lol/?url={url}',
  'https://proxy.corsfix.com/?{raw}',
  'https://api.codetabs.com/v1/proxy/?quest={raw}',
  'https://api.allorigins.win/raw?url={url}',
  'https://cors.eu.org/{raw}',
  'https://thingproxy.freeboard.io/fetch/{raw}',
]);

/** Where a request for `url` goes through `relay` — a template, or one of ours. */
export function through(relay, url) {
  if (/\{(url|raw)\}/.test(relay)) return relay.replace('{url}', encodeURIComponent(url)).replace('{raw}', url);
  return `${relay.replace(/\/+$/, '')}/?url=${encodeURIComponent(url)}`;
}

const headers = (extra = {}) => ({ Origin: ORIGIN, Accept: '*/*', ...extra });

async function get(fetchImpl, url, { range = '', ms = 20_000 } = {}) {
  const response = await fetchImpl(url, { headers: headers(range ? { Range: range } : {}), redirect: 'follow', signal: AbortSignal.timeout(ms) });
  return response;
}

/**
 * Run the three checks against one relay. Returns what passed and why the
 * rest did not, so the log says which door was shut.
 */
export async function evaluate(relay, { fetchImpl = globalThis.fetch, instances = [] } = {}) {
  const report = { relay, robots: '', instance: '', media: '', ok: false };
  try {
    const r = await get(fetchImpl, through(relay, ROBOTS));
    const body = await r.text();
    const cors = r.headers.get('access-control-allow-origin');
    if (r.status !== 200) return { ...report, robots: `HTTP ${r.status}` };
    if (!/user-agent/i.test(body)) return { ...report, robots: 'answered, but not with robots.txt' };
    if (!cors) return { ...report, robots: '200 but no Access-Control-Allow-Origin' };
    report.robots = `ok (cors=${cors})`;
  } catch (error) {
    return { ...report, robots: error?.name === 'TimeoutError' ? 'no answer in 20s' : String(error?.cause?.code || error?.message || error) };
  }

  for (const instance of instances) {
    let body;
    try {
      const r = await get(fetchImpl, through(relay, `${instance}/api/v1/videos/${VIDEO_ID}?local=true`));
      if (r.status !== 200) {
        report.instance = `${new URL(instance).host}: HTTP ${r.status}`;
        continue;
      }
      body = await r.json();
    } catch (error) {
      report.instance = `${new URL(instance).host}: ${error?.name === 'TimeoutError' ? 'no answer' : String(error?.message || error).slice(0, 60)}`;
      continue;
    }
    const streams = [...(body?.formatStreams || []), ...(body?.adaptiveFormats || [])].filter((f) => f?.url);
    if (streams.length === 0) {
      report.instance = `${new URL(instance).host}: ${body?.error ? String(body.error).slice(0, 60) : 'no streams'}`;
      continue;
    }
    const media = streams[0].url.startsWith('/') ? `${instance}${streams[0].url}` : streams[0].url;
    try {
      const r = await get(fetchImpl, through(relay, media), { range: 'bytes=0-65535', ms: 30_000 });
      const type = r.headers.get('content-type') || '';
      const bytes = (await r.arrayBuffer()).byteLength;
      if ((r.status === 200 || r.status === 206) && /^(video|audio)\//.test(type) && bytes > 0) {
        return { ...report, instance, media: `${r.status} ${type} ${bytes} bytes`, ok: true };
      }
      report.media = `${new URL(instance).host}: HTTP ${r.status} ${type || '(no type)'} ${bytes} bytes`;
    } catch (error) {
      report.media = `${new URL(instance).host}: ${error?.name === 'TimeoutError' ? 'no answer' : String(error?.message || error).slice(0, 60)}`;
    }
    report.instance = `${new URL(instance).host}: streams, but the media did not come through`;
  }
  return report;
}

/* ------------------------------------------------------------- cobalt */

/**
 * cobalt is the other shape of "it just works in a browser": the instance
 * does the whole download and streams the file back, so the page needs no
 * CORS on the media at all — the file is a navigation, not a fetch. The
 * public cobalt.tools instance is keyed and Turnstile-gated and blocked by
 * YouTube; community instances come and go, some open, some keyed. The
 * directory lists them, and the only test that matters is the one the app
 * makes: POST a YouTube link, get a tunnel, read its first bytes.
 */
/**
 * Where the instances are listed: the app's directory (the APIs found working
 * per service at the last test) first, the full test table behind it in case
 * the first is ever empty or gone. instances.cobalt.best, the list before
 * these, left DNS — the first measurement from a runner found no such host.
 */
export const COBALT_DIRECTORIES = [COBALT_DIRECTORY, 'https://cobalt.directory/api/tests'];
export { COBALT_DIRECTORY };
/**
 * The directory's own source, behind it: the opt-in list its repository on
 * Codeberg keeps at backend/instances — measured to be one file there, read
 * whether it is one file or a folder of them. The site answers anything that
 * is not a browser with a challenge page (measured: HTTP 403 "Just a
 * moment..."); the repository's API answers plainly.
 */
export const COBALT_SOURCE = 'https://codeberg.org/api/v1/repos/hyperdefined/cobalt.directory/contents/backend/instances';
export const WATCH = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
/** Named, as the directory asks of anything that is not a browser. */
export const USER_AGENT = 'siphon relay-config (+https://github.com/maxgfr/siphon)';

/** The directory's entries → API addresses worth asking, most trusted first. */
export function cobaltCandidates(body, { limit = 12 } = {}) {
  return cobaltEntries(body)
    .sort((a, b) => b.score - a.score)
    .map((e) => e.api)
    .filter((api, i, all) => all.indexOf(api) === i)
    .slice(0, limit);
}

/**
 * One file of the source → the entries it lists. JSON is read as the
 * directory's own answer would be; anything else is read line by line — a
 * hostname or an address per line, or an `api = …` line, comments dropped —
 * which is what a plain list of instances looks like in any text format.
 */
export function sourceEntries(text) {
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON: a list, TOML, YAML, .env */
  }
  if (body !== null && typeof body === 'object') return cobaltEntries(body);
  const entries = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+(#|\/\/).*$/, '').trim();
    if (!line || /^(#|\/\/|;)/.test(line)) continue;
    const keyed = /^["']?api(?:_url|Url)?["']?\s*[:=]\s*["']?((?:https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:\/[^\s"',]*)?)/i.exec(line);
    const bare = /^(?:https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i.test(line);
    const address = keyed ? keyed[1] : bare ? line : null;
    if (address) entries.push(...cobaltEntries([address]));
  }
  return entries;
}

/**
 * The source: what the repository's API answers for that path — a folder
 * (an array of files) or one file (an object carrying its content) — then
 * every file's text, read as entries.
 */
export async function fromSource({ fetchImpl = globalThis.fetch, say = () => {}, source = COBALT_SOURCE, limit = 12, files = 40 } = {}) {
  const ask = (url) => fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
  let listing;
  try {
    const r = await ask(source);
    const text = await r.text();
    const peek = text.replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!r.ok) {
      say(`no   source ${source}: HTTP ${r.status} — ${peek}`);
      return [];
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const isFile = (f) => f && typeof f === 'object' && (typeof f.download_url === 'string' || typeof f.content === 'string');
    listing = (Array.isArray(body) ? body.filter((f) => isFile(f) && f.type !== 'dir') : isFile(body) ? [body] : []).slice(0, files);
    if (listing.length === 0) {
      say(`no   source ${source}: no file there — ${peek}`);
      return [];
    }
  } catch (error) {
    say(`no   source ${source}: ${String(error?.cause?.code || error?.cause?.message || error?.message || error).slice(0, 80)}`);
    return [];
  }
  // A file answered with its content needs no second request; one answered
  // by reference is fetched.
  const texts = await Promise.all(listing.map((f) =>
    typeof f.content === 'string' && f.encoding === 'base64'
      ? Promise.resolve(Buffer.from(f.content, 'base64').toString('utf8'))
      : typeof f.content === 'string' && !f.encoding
        ? Promise.resolve(f.content)
        : ask(f.download_url).then((r) => (r.ok ? r.text() : '')).catch(() => ''),
  ));
  const candidates = cobaltCandidates(texts.flatMap(sourceEntries), { limit });
  const first = texts.find(Boolean) || '';
  say(`     source ${source}: ${listing.length} file(s), ${candidates.length} instance(s) to ask${candidates.length ? '' : ` — ${first.replace(/\s+/g, ' ').trim().slice(0, 160)}`}`);
  return candidates;
}

/** Ask one cobalt instance for the sample video, the way the app does. */
export async function evaluateCobalt(api, { fetchImpl = globalThis.fetch } = {}) {
  const report = { api, answer: '', media: '', ok: false };
  let body;
  try {
    const r = await fetchImpl(`${api}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: ORIGIN },
      body: JSON.stringify({ url: WATCH, downloadMode: 'auto', videoQuality: '480' }),
      signal: AbortSignal.timeout(30_000),
    });
    body = await r.json().catch(() => ({}));
    if (body?.status === 'error' || !r.ok) return { ...report, answer: `HTTP ${r.status} ${body?.error?.code || ''}`.trim() };
    if (!['tunnel', 'redirect'].includes(body?.status) || !body?.url) return { ...report, answer: `status ${body?.status || '?'}` };
    report.answer = `${body.status}`;
  } catch (error) {
    return { ...report, answer: error?.name === 'TimeoutError' ? 'no answer in 30s' : String(error?.cause?.code || error?.message || error).slice(0, 80) };
  }
  try {
    const r = await fetchImpl(body.url, { headers: { Range: 'bytes=0-65535', Origin: ORIGIN }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    const type = r.headers.get('content-type') || '';
    const bytes = (await r.arrayBuffer()).byteLength;
    if ((r.status === 200 || r.status === 206) && bytes > 0 && !/^text\//.test(type)) {
      return { ...report, media: `${r.status} ${type || '(no type)'} ${bytes} bytes`, ok: true };
    }
    return { ...report, media: `HTTP ${r.status} ${type || '(no type)'} ${bytes} bytes` };
  } catch (error) {
    return { ...report, media: error?.name === 'TimeoutError' ? 'no answer in 30s' : String(error?.message || error).slice(0, 80) };
  }
}

/** The directory, then each instance until one delivers; say what every one said. */
export async function chooseCobalt({ fetchImpl = globalThis.fetch, say = () => {}, limit = 12, directories = COBALT_DIRECTORIES, source = COBALT_SOURCE } = {}) {
  let listed = [];
  for (const directory of directories) {
    // Each directory is named with what it said, so a log reads on its own:
    // unreachable (and why), answering but in a shape nothing here reads
    // (its first bytes shown, so the reader can be taught), or a count.
    try {
      const r = await fetchImpl(directory, { headers: { Accept: 'application/json', 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
      const text = await r.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      const peek = text.replace(/\s+/g, ' ').trim().slice(0, 160);
      if (!r.ok) {
        say(`no   directory ${directory}: HTTP ${r.status} — ${peek}`);
        continue;
      }
      listed = cobaltCandidates(body, { limit });
      if (listed.length === 0) {
        say(`no   directory ${directory}: nothing listed as up for YouTube — ${peek}`);
        continue;
      }
      say(`     directory ${directory}: ${listed.length} instance(s) to ask`);
      break;
    } catch (error) {
      say(`no   directory ${directory}: ${String(error?.cause?.code || error?.cause?.message || error?.message || error).slice(0, 80)}`);
    }
  }
  // The directories shut, the list behind them: the source they are built from.
  if (listed.length === 0 && source) listed = await fromSource({ fetchImpl, say, source, limit });
  for (const api of listed) {
    const report = await evaluateCobalt(api, { fetchImpl });
    say(`${report.ok ? 'ok  ' : 'no  '} ${api}\n       answer: ${report.answer}\n       media: ${report.media || '-'}`);
    if (report.ok) return api;
  }
  return '';
}

/** The candidates in order: the owner's relay, then the public ones. */
export function candidates(own = '') {
  const mine = String(own || '').trim();
  return mine ? [mine, ...PUBLIC_RELAYS] : [...PUBLIC_RELAYS];
}

/** Try each until one passes; say what every one said. */
export async function choose({ own = '', fetchImpl = globalThis.fetch, instances = [], say = () => {} } = {}) {
  for (const relay of candidates(own)) {
    const report = await evaluate(relay, { fetchImpl, instances });
    say(`${report.ok ? 'ok  ' : 'no  '} ${relay}\n       robots: ${report.robots}\n       instance: ${report.instance || '-'}\n       media: ${report.media || '-'}`);
    if (report.ok) return { relay, relayKind: relay === own.trim() ? 'own' : 'public', instance: report.instance };
  }
  return { relay: '', relayKind: '', instance: '' };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const instances = JSON.parse(readFileSync(INSTANCES, 'utf8')).invidious || [];
  const say = (line) => console.log(line);
  console.log('relays:');
  const found = await choose({ own: process.env.SIPHON_RELAY_URL || '', instances, say });
  console.log('\ncobalt instances:');
  const cobalt = await chooseCobalt({ say });
  const next = {
    relay: found.relay,
    relayKind: found.relayKind,
    instance: found.instance,
    cobalt,
    checked: new Date().toISOString().slice(0, 10),
  };
  let before = {};
  try {
    before = JSON.parse(readFileSync(TARGET, 'utf8'));
  } catch {
    /* first run */
  }
  const same = before.relay === next.relay && before.instance === next.instance && (before.cobalt || '') === next.cobalt;
  console.log(found.relay ? `\nrelay: ${found.relay} (${found.relayKind}), instance ${found.instance}${same ? ' — unchanged' : ''}` : '\nno relay passed; the site keeps none');
  console.log(cobalt ? `cobalt: ${cobalt}${same ? ' — unchanged' : ''}` : 'no cobalt instance delivered; the site keeps none');
  // The date only moves with the answer, so a daily run leaves no churn.
  if (same) process.exit(0);
  writeFileSync(TARGET, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`wrote ${TARGET}`);
}
