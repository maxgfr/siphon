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
export const COBALT_DIRECTORY = 'https://instances.cobalt.best/api/instances.json';
export const WATCH = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

/** The directory's entries → API addresses worth asking, most trusted first. */
export function cobaltCandidates(body, { limit = 12 } = {}) {
  return (Array.isArray(body) ? body : [])
    .filter((e) => e && e.api && e.online !== false && e.api_online !== false && e.protocol !== 'http')
    .filter((e) => !e.services || e.services.youtube !== false)
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))
    .map((e) => `https://${String(e.api).replace(/\/+$/, '')}`)
    .filter((api, i, all) => all.indexOf(api) === i)
    .slice(0, limit);
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
export async function chooseCobalt({ fetchImpl = globalThis.fetch, say = () => {}, limit = 12 } = {}) {
  let listed = [];
  try {
    const r = await fetchImpl(COBALT_DIRECTORY, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    listed = cobaltCandidates(await r.json(), { limit });
  } catch (error) {
    say(`no   cobalt directory: ${String(error?.message || error).slice(0, 80)}`);
    return '';
  }
  if (listed.length === 0) say('no   cobalt directory: no instance listed as online for YouTube');
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
