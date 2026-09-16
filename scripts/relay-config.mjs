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
  const found = await choose({ own: process.env.SIPHON_RELAY_URL || '', instances, say: (line) => console.log(line) });
  const next = { relay: found.relay, relayKind: found.relayKind, instance: found.instance, checked: new Date().toISOString().slice(0, 10) };
  let before = {};
  try {
    before = JSON.parse(readFileSync(TARGET, 'utf8'));
  } catch {
    /* first run */
  }
  const same = before.relay === next.relay && before.instance === next.instance;
  console.log(found.relay ? `\nrelay: ${found.relay} (${found.relayKind}), instance ${found.instance}${same ? ' — unchanged' : ''}` : '\nno relay passed; the site keeps none');
  // The date only moves with the answer, so a daily run leaves no churn.
  if (same) process.exit(0);
  writeFileSync(TARGET, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`wrote ${TARGET}`);
}
