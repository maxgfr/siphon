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
 * The API answers `[name, details]` pairs. Only clearnet ones with the API
 * on are of use to a page; the `cors` flag is honoured when present.
 */
export function fromDirectory(body) {
  return unique(
    (Array.isArray(body) ? body : [])
      .map((entry) => (Array.isArray(entry) ? entry[1] : null))
      .filter((d) => d && d.type === 'https' && d.api !== false && d.cors !== false && d.uri)
      .map((d) => trimSlash(d.uri)),
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
        return !NOT_INSTANCES.test(hostname) && (pathname === '' || pathname === '/');
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

/** Ask the API, then the page; say which one answered. */
export async function refresh({ fetchImpl = fetchText } = {}) {
  try {
    const list = fromDirectory(JSON.parse(await fetchImpl(API_URL)));
    if (list.length > 0) return { source: 'api.invidious.io', invidious: list };
  } catch {
    /* the page below is the fallback */
  }
  const list = fromDocsPage(await fetchImpl(DOCS_URL));
  if (list.length === 0) throw new Error('neither the API nor the docs page listed a single instance');
  return { source: 'docs.invidious.io', invidious: list };
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
