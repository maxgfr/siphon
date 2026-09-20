/**
 * Refresh the bundled list of public instances — and measure which of them
 * answer a web page for a video today.
 *
 * The lists: Invidious's own (https://docs.invidious.io/instances/, generated
 * from https://api.invidious.io, so the JSON is asked first and the page
 * parsed only when it cannot be), Piped's (https://piped-instances.kavin.rocks),
 * and the opt-in list behind cobalt.directory — each with a short seed of
 * long-standing instances behind it. Clearnet HTTPS only: onion, I2P and
 * Yggdrasil addresses are unreachable from a browser.
 *
 * Then the measurement, which is the part that matters to a visitor: every
 * instance is asked exactly what the page asks — the video endpoint with an
 * Origin header, the first bytes of the media it names — and only the ones
 * that answer all of it, with the cross-origin headers a browser needs, go
 * into `open`. That is the list the settings sheet offers as chips; an empty
 * `open` means no chips, because offering an address that will refuse is
 * worse than offering none. The full lists stay beside it for the walk.
 *
 * The result goes to web/instances.json, which the Pages deploy publishes
 * beside the app: same origin, no CORS, no directory to reach at runtime. A
 * GitHub Action runs this daily and commits a change.
 *
 *   node scripts/instances.mjs            # rewrite web/instances.json
 *   node scripts/instances.mjs --check    # print what would be written
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { promises as dns } from 'node:dns';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateCobalt, fromSource } from './relay-config.mjs';

export const API_URL = 'https://api.invidious.io/instances.json?sort_by=type,users';
export const DOCS_URL = 'https://docs.invidious.io/instances/';
export const PIPED_URL = 'https://piped-instances.kavin.rocks/';

/** What a page sends, and the video it asks about: the first one ever uploaded. */
export const ORIGIN = 'https://maxgfr.github.io';
export const SAMPLE_ID = 'jNQXAC9IVRw';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TARGET = join(HERE, '..', 'web', 'instances.json');

const trimSlash = (value) => String(value || '').trim().replace(/\/+$/, '');

/** Hosts that appear as links on the docs page but are not instances. */
const NOT_INSTANCES = /(^|\.)(invidious\.io|github\.com|githubusercontent\.com|uptime\.invidious\.io|matrix\.to|reddit\.com)$/i;

/**
 * Whether a browser on the open internet can even resolve the host.
 *
 * The API lists overlay-network addresses under type "https" too — a
 * Yggdrasil `.ygg`, a Tor `.onion`, an I2P `.i2p` — and none of those is an
 * address a phone's browser can reach. They would cost a probe each and
 * never answer.
 */
export function reachable(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && hostname.includes('.') && !/\.(onion|i2p|ygg|local|lan|internal)$/i.test(hostname);
  } catch {
    return false;
  }
}

/**
 * Well-known instances, kept behind whatever the official list says.
 *
 * The official list is generated from a monitor, and a monitor has opinions:
 * on a given day it may list three instances with the API on, two of them
 * overlay-network addresses. These are long-standing public instances that
 * serve the API; being here is not a promise that one answers today — the
 * app probes every address before use — only that it is worth asking.
 */
export const SEED = Object.freeze([
  'https://inv.nadeko.net',
  'https://yewtu.be',
  'https://invidious.nerdvpn.de',
  'https://yt.chocolatemoo53.com',
  'https://invidious.tiekoetter.com',
  'https://inv.thepixora.com',
]);

/**
 * Piped instances worth asking, behind whatever its directory says: the
 * project's own, and the community ones its documentation lists.
 */
export const PIPED_SEED = Object.freeze([
  'https://pipedapi.kavin.rocks',
  'https://pipedapi-libre.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.yt',
  'https://pipedapi.leptons.xyz',
  'https://pipedapi.nosebs.ru',
  'https://piped-api.privacy.com.de',
  'https://pipedapi.drgns.space',
  'https://pipedapi.owo.si',
  'https://pipedapi.ducks.party',
]);

/** Piped's directory answers a list of `{ name, api_url, … }`. */
export function fromPipedDirectory(body) {
  return unique(
    (Array.isArray(body) ? body : [])
      .map((entry) => (entry && typeof entry.api_url === 'string' ? trimSlash(entry.api_url) : ''))
      .filter(reachable),
  );
}

/**
 * The API answers `[name, details]` pairs. `api: true` is the filter, the
 * same one the app applies: the clearnet instances that say their API is
 * on are the candidates, and the measurement below is the truth about each.
 */
export function fromDirectory(body) {
  return unique(
    (Array.isArray(body) ? body : [])
      .map((entry) => (Array.isArray(entry) ? entry[1] : null))
      .filter((d) => d && d.type === 'https' && d.api === true && d.uri)
      .map((d) => trimSlash(d.uri))
      .filter(reachable),
  );
}

/**
 * The docs page, when the API is down.
 *
 * The page groups instances under one heading per address type — https,
 * onion, i2p — so the links between the "https" heading and the next one
 * are the clearnet instances. Written against the page's shape rather than
 * its markup: any heading level, any list or table around the links.
 */
export function fromDocsPage(html) {
  const text = String(html || '');
  const sections = text.split(/(?=<h[1-6][\s>])/i);
  // A heading whose id or whose first word is "https", whatever markup the
  // site generator wraps around it — mkdocs puts a permalink anchor inside.
  const isHttpsHeading = (section) =>
    /^<h[1-6][^>]*\bid="https?"/i.test(section) || /^<h[1-6][^>]*>(?:\s|<[^>]*>)*https?\b/i.test(section);
  const https = sections.find(isHttpsHeading);
  if (!https) return [];
  const links = [...https.matchAll(/href="(https:\/\/[^"#?]+)"/gi)].map((m) => trimSlash(m[1]));
  return unique(
    links.filter((url) => {
      try {
        const { hostname, pathname } = new URL(url);
        return !NOT_INSTANCES.test(hostname) && (pathname === '' || pathname === '/') && reachable(url);
      } catch {
        return false;
      }
    }),
  );
}

function unique(list) {
  const seen = new Set();
  return list.filter((item) => item && !seen.has(item) && seen.add(item));
}

async function fetchText(url, ms = 20_000) {
  const response = await fetch(url, { headers: { Accept: 'application/json, text/html' }, signal: AbortSignal.timeout(ms) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

/**
 * Whether the name points at the internet at all.
 *
 * A clearnet-looking name can carry only a Yggdrasil address (200::/7) in
 * public DNS — inv-ygg.nadeko.net does — and a browser fails to connect to
 * it every time. A name that does not resolve is the same case. A resolver
 * that itself errors is not the host's fault, so the host is kept then.
 */
export async function onTheInternet(url, resolve = dns) {
  const { hostname } = new URL(url);
  const [v4, v6] = await Promise.all([
    resolve.resolve4(hostname).catch((error) => (error?.code === 'ENOTFOUND' || error?.code === 'ENODATA' ? [] : null)),
    resolve.resolve6(hostname).catch((error) => (error?.code === 'ENOTFOUND' || error?.code === 'ENODATA' ? [] : null)),
  ]);
  if (v4 === null && v6 === null) return true; // the resolver failed, not the host
  if ((v4 || []).length > 0) return true;
  return (v6 || []).some((address) => !/^[23][0-9a-f]{2}:/i.test(address));
}

/** Ask the API, then the page; say which one answered; the seed behind either. */
export async function refresh({ fetchImpl = fetchText, resolve = dns } = {}) {
  let source = 'api.invidious.io';
  let list = [];
  try {
    list = fromDirectory(JSON.parse(await fetchImpl(API_URL)));
  } catch {
    /* the page below is the fallback */
  }
  if (list.length === 0) {
    source = 'docs.invidious.io';
    list = fromDocsPage(await fetchImpl(DOCS_URL));
  }
  if (list.length === 0) throw new Error('neither the API nor the docs page listed a single instance');
  const merged = unique([...list, ...SEED]);
  const reachableOnes = await Promise.all(merged.map((url) => onTheInternet(url, resolve)));
  return { source: `${source} + seed`, invidious: merged.filter((_, i) => reachableOnes[i]) };
}

/** Piped's directory, the seed behind it; a directory that is down costs only the directory. */
export async function refreshPiped({ fetchImpl = fetchText, resolve = dns } = {}) {
  let listed = [];
  try {
    listed = fromPipedDirectory(JSON.parse(await fetchImpl(PIPED_URL)));
  } catch {
    /* the seed is what is left */
  }
  const merged = unique([...listed, ...PIPED_SEED]);
  const reachableOnes = await Promise.all(merged.map((url) => onTheInternet(url, resolve)));
  return merged.filter((_, i) => reachableOnes[i]);
}

/* ------------------------------------------------------------ measuring */

const brief = (error) => (error?.name === 'TimeoutError' ? 'no answer in 15s' : String(error?.cause?.code || error?.message || error).slice(0, 60));

/** A GET as a page makes it: with its Origin, no credentials. */
async function asPage(fetchImpl, url, { range = '', timeout = 15_000 } = {}) {
  return fetchImpl(url, {
    headers: { Origin: ORIGIN, Accept: 'application/json, */*', ...(range ? { Range: range } : {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
}

/** Whether a response may be read by a page from ORIGIN. */
const readable = (response) => {
  const allow = response.headers.get('access-control-allow-origin');
  return allow === '*' || allow === ORIGIN;
};

/**
 * Ask one instance exactly what a page asks, and say what it answered.
 *
 * Two doors, both of which a download goes through: the video endpoint,
 * which must answer with a stream list and the header that lets a foreign
 * page read it; then the media it named, which must stream the first bytes
 * with that header too — an instance whose API is open but whose proxy is
 * not delivers nothing. cobalt is asked the one way the app asks it: a POST
 * of the link, then the tunnel it answers with, which needs no header
 * because the browser saves it as a download rather than reading it.
 *
 * @returns {Promise<{ ok: boolean, verdict: string }>}
 */
export async function answersPage(url, kind, { fetchImpl = globalThis.fetch } = {}) {
  const base = trimSlash(url);
  if (kind === 'cobalt') {
    const report = await evaluateCobalt(base, { fetchImpl });
    return { ok: report.ok, verdict: report.ok ? `tunnel ${report.media}` : `answer ${report.answer}${report.media ? `, media ${report.media}` : ''}` };
  }
  const path = kind === 'piped' ? `/streams/${SAMPLE_ID}` : `/api/v1/videos/${SAMPLE_ID}?local=true`;
  const started = Date.now();
  let body;
  let media;
  try {
    const response = await asPage(fetchImpl, `${base}${path}`);
    const cors = readable(response);
    const text = await response.text();
    if (response.status !== 200 || !cors) {
      return { ok: false, verdict: `videos HTTP ${response.status}, cors=${cors ? 'yes' : 'NONE'} — ${text.replace(/\s+/g, ' ').slice(0, 80)}` };
    }
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, verdict: `videos HTTP 200 but not JSON — ${text.replace(/\s+/g, ' ').slice(0, 80)}` };
    }
    const streams = kind === 'piped'
      ? [...(body?.videoStreams || []), ...(body?.audioStreams || [])]
      : [...(body?.formatStreams || []), ...(body?.adaptiveFormats || [])];
    media = streams.map((stream) => stream?.url).find(Boolean);
    if (!media) return { ok: false, verdict: `videos HTTP 200, cors=yes, but no streams — ${text.replace(/\s+/g, ' ').slice(0, 80)}` };
  } catch (error) {
    return { ok: false, verdict: `videos ${brief(error)}` };
  }
  const mediaUrl = media.startsWith('/') ? `${base}${media}` : media;
  try {
    const response = await asPage(fetchImpl, mediaUrl, { range: 'bytes=0-65535' });
    const cors = readable(response);
    const type = response.headers.get('content-type') || '';
    const bytes = (await response.arrayBuffer()).byteLength;
    const ok = (response.status === 200 || response.status === 206) && cors && bytes > 0 && !/^text\//.test(type);
    return {
      ok,
      verdict: ok
        ? `ok in ${Date.now() - started}ms — videos and ${bytes} media bytes, both readable by a page`
        : `videos ok, media HTTP ${response.status}, cors=${cors ? 'yes' : 'NONE'}, ${type || '(no type)'} ${bytes} bytes`,
    };
  } catch (error) {
    return { ok: false, verdict: `videos ok, media ${brief(error)}` };
  }
}

/**
 * Every instance of every kind, asked in turn; the ones that answer a page
 * for a video, in the order asked. Each verdict is said, so the log is the
 * measurement.
 */
export async function measure({ invidious = [], piped = [], cobalt = [] }, { fetchImpl = globalThis.fetch, say = () => {} } = {}) {
  const open = [];
  for (const [kind, list] of [['invidious', invidious], ['piped', piped], ['cobalt', cobalt]]) {
    for (const url of list) {
      const { ok, verdict } = await answersPage(url, kind, { fetchImpl });
      say(`${ok ? 'open' : 'shut'}  ${kind.padEnd(9)} ${new URL(url).host.padEnd(30)} ${verdict}`);
      if (ok) open.push({ url: trimSlash(url), kind });
    }
  }
  return open;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const check = process.argv.includes('--check');
  const say = (line) => console.log(line);
  const found = await refresh();
  const piped = await refreshPiped();
  console.log(`${found.invidious.length} Invidious instances from ${found.source}, ${piped.length} Piped from ${PIPED_URL} + seed`);
  console.log('\ncobalt instances, from the list behind cobalt.directory:');
  const cobalt = await fromSource({ say, limit: 12 });
  console.log('\nasked as a page asks, with an Origin header:');
  const open = await measure({ invidious: found.invidious, piped, cobalt }, { say });
  const today = new Date().toISOString().slice(0, 10);
  const next = { updated: today, source: found.source, invidious: found.invidious, piped, open, measured: today };
  let before = null;
  try {
    before = JSON.parse(readFileSync(TARGET, 'utf8'));
  } catch {
    /* first run */
  }
  const same =
    before &&
    JSON.stringify(before.invidious) === JSON.stringify(next.invidious) &&
    JSON.stringify(before.piped || []) === JSON.stringify(next.piped) &&
    JSON.stringify(before.open || []) === JSON.stringify(next.open);
  console.log(`\n${open.length} instance(s) answer a page for a video today${same ? ' — unchanged' : ''}`);
  for (const entry of open) console.log(`  ${entry.kind}  ${entry.url}`);
  if (open.length === 0) console.log('  none: the sheet offers no chips, only the field');
  // The dates move only when the lists do, so a daily run leaves no churn.
  if (check || same) process.exit(0);
  writeFileSync(TARGET, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`wrote ${TARGET}`);
}
