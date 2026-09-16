/**
 * Refresh the bundled list of public Invidious instances.
 *
 * The page at https://docs.invidious.io/instances/ is the list the project
 * itself publishes, and it is generated from https://api.invidious.io — so
 * that JSON is asked first, and the page is parsed only when the API cannot
 * be reached. Either way the result goes to web/instances.json, which the
 * Pages deploy publishes beside the app: same origin, no CORS, no directory
 * to reach at runtime. A GitHub Action runs this daily and commits a change.
 *
 * What is kept: clearnet HTTPS instances with the API on. Onion and I2P
 * addresses are unreachable from a browser, and an instance that has turned
 * its API off answers nothing a page can read. Nothing here is trusted
 * blindly either way — the app still probes every address before use.
 *
 *   node scripts/instances.mjs            # rewrite web/instances.json
 *   node scripts/instances.mjs --check    # print what would be written
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { promises as dns } from 'node:dns';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const API_URL = 'https://api.invidious.io/instances.json?sort_by=type,users';
export const DOCS_URL = 'https://docs.invidious.io/instances/';

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
 * The API answers `[name, details]` pairs. Only clearnet ones with the API
 * on are of use to a page; the `cors` flag is honoured when present.
 */
export function fromDirectory(body) {
  return unique(
    (Array.isArray(body) ? body : [])
      .map((entry) => (Array.isArray(entry) ? entry[1] : null))
      .filter((d) => d && d.type === 'https' && d.api !== false && d.cors !== false && d.uri)
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

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const check = process.argv.includes('--check');
  const found = await refresh();
  const next = { updated: new Date().toISOString().slice(0, 10), source: found.source, invidious: found.invidious };
  let before = null;
  try {
    before = JSON.parse(readFileSync(TARGET, 'utf8'));
  } catch {
    /* first run */
  }
  const same = before && JSON.stringify(before.invidious) === JSON.stringify(next.invidious);
  console.log(`${next.invidious.length} instances from ${next.source}${same ? ' — unchanged' : ''}`);
  for (const url of next.invidious) console.log(`  ${url}`);
  // The date only moves when the list does, so a daily run leaves no churn.
  if (check || same) process.exit(0);
  writeFileSync(TARGET, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`wrote ${TARGET}`);
}
