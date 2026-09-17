/**
 * Finding a public instance, so the first visit is not a dead end.
 *
 * With no helper, a YouTube link fails on arrival — correctly, but the person
 * pasting it did not come here to read about CORS. A public instance — cobalt,
 * Invidious or Piped — fixes that with nothing to deploy, and the addresses of
 * those instances are published by the projects themselves. So: ask the
 * directories, fall back to a short seed list, and *probe* every candidate
 * before trusting any of it.
 *
 * The directory is a hint; the probe is the truth. A list can be stale, a host
 * can be down, an instance can be blocked by YouTube this week — none of which
 * a JSON file knows. Nothing is used here until it has answered for itself,
 * through the same detection the settings sheet uses.
 *
 * This sends the person's links to someone else's server, which is exactly
 * what the app otherwise avoids, so two rules hold everywhere below:
 * whichever instance is chosen is *named* on screen, and clearing it is one
 * tap. It is a starting point, not a commitment.
 */

const trimSlash = (value) => String(value || '').trim().replace(/\/+$/, '');

/**
 * Whether a browser on the open internet can even resolve the host: the
 * directories list overlay-network addresses under "https" too — `.ygg`,
 * `.onion`, `.i2p` — and each would cost a probe and never answer.
 */
const reachable = (url) => {
  try {
    const { hostname } = new URL(url);
    return hostname.includes('.') && !/\.(onion|i2p|ygg|local|lan|internal)$/i.test(hostname);
  } catch {
    return false;
  }
};

/**
 * cobalt's instance directory. `instances.cobalt.best` — the list the project
 * pointed at for years — left DNS in 2026; `cobalt.directory` is the same
 * author's successor, and this endpoint is the one that lists the APIs found
 * working, per service, at its last test.
 */
export const COBALT_DIRECTORY = 'https://cobalt.directory/api/working?type=api';

const passes = (value) =>
  value === true || value === 1 || (typeof value === 'string' && /^(ok|pass(ed)?|success|working|true|online|up)$/i.test(value)) ||
  (value && typeof value === 'object' && (value.ok === true || value.working === true || value.success === true || value.passed === true || passes(value.status)));
const fails = (value) =>
  value === false || value === 0 || (typeof value === 'string' && !passes(value)) ||
  (value && typeof value === 'object' && (value.ok === false || value.working === false || value.success === false || value.passed === false || (typeof value.status === 'string' && !passes(value.status))));

const ADDRESS_KEYS = ['api', 'api_url', 'apiUrl', 'url', 'host', 'hostname', 'domain', 'instance'];
const RESULT_KEYS = ['services', 'tests', 'results', 'working'];

/**
 * @param {unknown} body whatever the cobalt directory answered
 * @returns {{ api: string, score: number }[]} the https API addresses it lists as up, with YouTube not marked failing
 *
 * Written to survive the directory changing shape, because it has: the answer
 * may be a bare array, or `{ lastUpdatedUTC, data }` where `data` is an array
 * of entries, a map keyed by service (`youtube: [...]`), or a map keyed by
 * host. An entry may be a hostname, an address, or an object naming its API
 * under one of a few keys, with online flags, a score and per-service
 * results. Only an explicit "down" or an explicit YouTube failure excludes
 * an entry; the measurement that follows is the real test. Anything
 * unrecognised yields nothing rather than throwing.
 */
export function cobaltEntries(body) {
  const data = body && typeof body === 'object' && !Array.isArray(body) && 'data' in body ? body.data : body;
  const isEntry = (value) => value && typeof value === 'object' && ADDRESS_KEYS.some((key) => typeof value[key] === 'string');
  let list = [];
  if (Array.isArray(data)) list = data;
  // One entry on its own — a file describing a single instance.
  else if (isEntry(data)) list = [data];
  else if (data && typeof data === 'object') {
    const service = Object.keys(data).find((key) => /^youtube$/i.test(key));
    const byService = service ? data[service] : null;
    if (Array.isArray(byService)) list = byService;
    else if (byService && typeof byService === 'object') list = Object.entries(byService).map(([host, rest]) => ({ host, ...(rest && typeof rest === 'object' ? rest : {}) }));
    else list = Object.entries(data).map(([host, rest]) => (rest && typeof rest === 'object' ? { host, ...rest } : null)).filter(Boolean);
  }
  const entries = [];
  for (const entry of list) {
    const record = typeof entry === 'string' ? { api: entry } : entry && typeof entry === 'object' ? entry : null;
    if (!record) continue;
    const address = ADDRESS_KEYS.map((key) => record[key]).find((value) => typeof value === 'string' && value.trim());
    if (!address) continue;
    if (record.online === false || record.api_online === false || record.protocol === 'http' || fails(record.status)) continue;
    const results = RESULT_KEYS.map((key) => record[key]).find((value) => value && typeof value === 'object');
    const youtubeKey = results && Object.keys(results).find((key) => /^youtube$/i.test(key));
    if (youtubeKey && fails(results[youtubeKey])) continue;
    const api = trimSlash(/^[a-z]+:\/\//i.test(address) ? address : `https://${address.trim()}`);
    if (!api.startsWith('https://')) continue;
    entries.push({ api, score: Number(record.score) || 0 });
  }
  return entries;
}

/**
 * Where the projects publish their own instance lists.
 *
 * `read` pulls addresses out of whatever shape the directory answers with, and
 * is written to tolerate a changed schema by returning nothing rather than
 * throwing: a directory that has moved on is a reason to fall back to the
 * seed, not a reason for the app to break.
 */
export const DIRECTORIES = Object.freeze([
  {
    kind: 'cobalt',
    url: COBALT_DIRECTORY,
    read: (body) => cobaltEntries(body).map((entry) => entry.api),
  },
  {
    kind: 'piped',
    url: 'https://piped-instances.kavin.rocks/',
    read: (body) => (Array.isArray(body) ? body : []).map((entry) => entry && entry.api_url).filter(Boolean),
  },
  {
    kind: 'invidious',
    url: 'https://api.invidious.io/instances.json',
    // Entries are [name, details] pairs. Only clearnet ones with the API on
    // are any use to a page: an onion address is unreachable from a browser,
    // and an instance that has turned its API off answers nothing a page
    // can read.
    read: (body) =>
      (Array.isArray(body) ? body : [])
        .map((entry) => (Array.isArray(entry) ? entry[1] : null))
        .filter((d) => d && d.type === 'https' && d.api !== false && d.cors !== false && d.uri)
        .map((d) => d.uri)
        .filter(reachable),
  },
]);

/**
 * The list published beside the app.
 *
 * web/instances.json is the Invidious project's own instance list, refreshed
 * by a daily workflow (scripts/instances.mjs) and deployed with the page. It
 * is same-origin, so it needs no directory to be reachable and no CORS from
 * anyone — which makes it the first thing tried, and the only thing the
 * YouTube resolver walks when its instance goes quiet.
 */
const BUNDLED_URL = new URL('./instances.json', import.meta.url).href;
let bundledPromise = null;
let bundledBy = null;

const EMPTY = Object.freeze({ invidious: [], piped: [], open: [], measured: '' });

/**
 * @returns {Promise<{ invidious: string[], piped: string[], open: {url: string, kind: string}[], measured: string }>}
 *   the file beside the app, empty lists when it is missing
 *
 * Read once per fetch implementation: the app always passes the same one, so
 * the file is fetched once; a test with a stubbed fetch gets its own read.
 */
export function bundledInfo({ fetchImpl = globalThis.fetch, timeout = 6000, fresh = false } = {}) {
  if (!bundledPromise || fresh || bundledBy !== fetchImpl) {
    bundledBy = fetchImpl;
    bundledPromise = (async () => {
      try {
        const response = await fetchImpl(BUNDLED_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
        if (!response.ok) return EMPTY;
        const body = await response.json();
        const addresses = (list) => (Array.isArray(list) ? list : []).map(trimSlash).filter(Boolean);
        return {
          invidious: addresses(body?.invidious),
          piped: addresses(body?.piped),
          // Only the kinds the app can use are offered, whatever the file says.
          open: (Array.isArray(body?.open) ? body.open : [])
            .filter((entry) => entry && typeof entry.url === 'string' && PUBLIC.has(entry.kind))
            .map((entry) => ({ url: trimSlash(entry.url), kind: entry.kind }))
            .filter((entry) => entry.url),
          measured: typeof body?.measured === 'string' ? body.measured : '',
        };
      } catch {
        return EMPTY;
      }
    })();
  }
  return bundledPromise;
}

/** The bundled Invidious addresses, [] when the file is missing. */
export async function invidiousInstances(options = {}) {
  return (await bundledInfo(options)).invidious;
}

/**
 * The instances the daily measurement saw answer a page for a video — the
 * only ones the sheet offers as chips. Empty means none did that day, and
 * then nothing is offered: an address that will refuse is worse than none.
 */
export async function openInstances(options = {}) {
  return (await bundledInfo(options)).open;
}

/**
 * A short fallback, for when neither the bundled list nor the directories
 * can be reached.
 *
 * Deliberately short and deliberately unverified: these are long-standing
 * addresses, not a promise that any of them answers today. Every one is
 * probed before use, and a dead entry costs one failed request.
 */
export const SEED = Object.freeze([
  'https://inv.nadeko.net',
  'https://yewtu.be',
  'https://invidious.nerdvpn.de',
  'https://yt.chocolatemoo53.com',
  'https://invidious.tiekoetter.com',
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.private.coffee',
]);

/**
 * Invidious is the plan for YouTube: its public network is the one still
 * standing, and its API answers a page directly. cobalt reaches more sites
 * but its public instances mostly want a key or a Turnstile pass today;
 * Piped's network has largely gone dark. So: Invidious, then the others.
 */
const RANK = { invidious: 0, cobalt: 1, piped: 2 };
/** The kinds a public list is searched for; a mirror or a relay in one is not. */
const PUBLIC = new Set(Object.keys(RANK));

/** Ask one directory for addresses, and never let it fail the search. */
async function askDirectory(directory, fetchImpl, ms) {
  try {
    const response = await fetchImpl(directory.url, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      signal: AbortSignal.timeout(ms),
    });
    if (!response.ok) return [];
    return directory.read(await response.json()).map(trimSlash).filter(Boolean);
  } catch {
    return [];
  }
}

/** One from each list in turn, until every list is spent. */
function interleave(lists) {
  const out = [];
  for (let i = 0; lists.some((list) => i < list.length); i += 1) {
    for (const list of lists) if (i < list.length) out.push(list[i]);
  }
  return out;
}

/** A public video that is not going anywhere: the first one ever uploaded. */
const SAMPLE_ID = 'jNQXAC9IVRw';

/**
 * Whether an instance will answer a *page* for a video, not just for its
 * own name.
 *
 * The probe that recognises an instance is its stats endpoint, which every
 * public instance answers to anyone. The endpoint a download needs is a
 * different door, and most public instances now keep it shut to web pages:
 * a 403 "Endpoint disabled", a reverse proxy's 403, no CORS header. Taking
 * such an instance as the helper hands the person a failure later, with a
 * sentence about cross-origin headers. So the video endpoint is asked, from
 * this page, before an instance is adopted — a fetch that the browser
 * refuses is a no, exactly as it would be for the real link.
 */
export async function servesPages(endpoint, helper, { fetchImpl = globalThis.fetch, timeout = 8000 } = {}) {
  const kind = helper?.kind;
  const path = kind === 'invidious' ? `/api/v1/videos/${SAMPLE_ID}?local=true` : kind === 'piped' ? `/streams/${SAMPLE_ID}` : null;
  if (!path) return true;
  try {
    const response = await fetchImpl(`${trimSlash(endpoint)}${path}`, { credentials: 'omit', signal: AbortSignal.timeout(timeout) });
    if (!response.ok) return false;
    const body = await response.json();
    const streams = kind === 'invidious'
      ? [...(body?.formatStreams || []), ...(body?.adaptiveFormats || [])]
      : [...(body?.videoStreams || []), ...(body?.audioStreams || [])];
    return streams.some((stream) => stream?.url);
  } catch {
    return false;
  }
}

/**
 * Find a public instance that actually answers.
 *
 * @param {object} options
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(address: string) => Promise<object>} options.detect  the same probe the settings sheet runs
 * @param {number} [options.candidates]  how many addresses to probe at most
 * @param {number} [options.timeout]  per-request budget, milliseconds
 * @param {string[]} [options.exclude]  addresses already known not to work
 * @param {(endpoint: string, helper: object) => Promise<boolean>} [options.verify]
 *   a second question after recognition — the app asks `servesPages`, so an
 *   instance that will refuse the page for a video is never adopted
 * @returns {Promise<{ endpoint: string, helper: object }|null>}
 */
export async function findInstance({ fetchImpl = globalThis.fetch, detect, candidates = 8, timeout = 6000, exclude = [], verify = async () => true } = {}) {
  const seen = new Set(exclude.map(trimSlash));
  const fresh = (addresses) =>
    addresses.filter((address) => {
      if (!address || seen.has(address)) return false;
      seen.add(address);
      return true;
    });
  const probe = async (addresses) => {
    const found = (
      await Promise.all(
        addresses.slice(0, candidates).map(async (endpoint) => {
          try {
            const helper = await detect(endpoint);
            // A siphon server or a relay in a public instance list is not what
            // was asked for; only the kinds that answer for a video count —
            // and only if they answer this page for one.
            if (!helper || !PUBLIC.has(helper.kind)) return null;
            return (await verify(endpoint, helper)) ? { endpoint, helper } : null;
          } catch {
            return null;
          }
        }),
      )
    ).filter(Boolean);
    found.sort((a, b) => RANK[a.helper.kind] - RANK[b.helper.kind]);
    return found[0] || null;
  };

  // Round zero: what the daily measurement saw answer a page — the shortest
  // list and the likeliest, so it goes first and alone.
  const info = await bundledInfo({ fetchImpl, timeout });
  const measured = await probe(fresh(info.open.map((entry) => entry.url)));
  if (measured) return measured;

  // Round one: the list published beside the app. It is the plan, so it gets
  // the whole budget to itself before a single directory is contacted.
  const bundled = await probe(fresh([...info.invidious, ...info.piped]));
  if (bundled) return bundled;

  // Round two: the projects' live directories, round-robin across them
  // rather than one list after another, so the cap on strangers spans every
  // kind — a long cobalt list must not crowd the others out — and the seed
  // behind them. Anything already known not to work is left out, which is
  // what makes this usable when the instance in use dies, not only on a
  // first visit.
  const listed = interleave(await Promise.all(DIRECTORIES.map((d) => askDirectory(d, fetchImpl, timeout))));
  return probe(fresh([...listed, ...SEED.map(trimSlash)]));
}

/**
 * Whether a failure reads like the helper being gone rather than the video.
 *
 * The distinction decides whether looking for another instance would help at
 * all. A private video is private on every instance in the world, and
 * switching would waste the person's time and someone else's bandwidth to
 * arrive at the same answer. An instance that has stopped answering, started
 * refusing, or been blocked by YouTube — "sign in to confirm you're not a
 * bot" is that, said to the instance — is exactly what the next one might
 * not be.
 */
export function looksUnreachable(message) {
  const text = String(message || '');
  if (/private|members-only|age-restricted|unavailable|no formats|not recognise|has no video/i.test(text)) return false;
  return /could not reach|did not answer|does not let a web page|answered 5\d\d|answered 4(0[38]|29)|rate.?limit|kept breaking|timed out|refused|sign in to confirm|not a bot|no streams|every instance/i.test(text);
}
