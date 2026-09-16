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
    url: 'https://instances.cobalt.best/api/instances.json',
    read: (body) =>
      (Array.isArray(body) ? body : [])
        .filter((entry) => entry && entry.api && entry.online !== false && entry.api_online !== false)
        .map((entry) => `${entry.protocol === 'http' ? 'http' : 'https'}://${entry.api}`),
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
        .map((d) => d.uri),
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

/**
 * @returns {Promise<string[]>} the bundled Invidious addresses, [] when the file is missing
 *
 * Read once per fetch implementation: the app always passes the same one, so
 * the file is fetched once; a test with a stubbed fetch gets its own read.
 */
export function invidiousInstances({ fetchImpl = globalThis.fetch, timeout = 6000, fresh = false } = {}) {
  if (!bundledPromise || fresh || bundledBy !== fetchImpl) {
    bundledBy = fetchImpl;
    bundledPromise = (async () => {
      try {
        const response = await fetchImpl(BUNDLED_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
        if (!response.ok) return [];
        const body = await response.json();
        return (Array.isArray(body?.invidious) ? body.invidious : []).map(trimSlash).filter(Boolean);
      } catch {
        return [];
      }
    })();
  }
  return bundledPromise;
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

/**
 * Find a public instance that actually answers.
 *
 * @param {object} options
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(address: string) => Promise<object>} options.detect  the same probe the settings sheet runs
 * @param {number} [options.candidates]  how many addresses to probe at most
 * @param {number} [options.timeout]  per-request budget, milliseconds
 * @param {string[]} [options.exclude]  addresses already known not to work
 * @returns {Promise<{ endpoint: string, helper: object }|null>}
 */
export async function findInstance({ fetchImpl = globalThis.fetch, detect, candidates = 8, timeout = 6000, exclude = [] } = {}) {
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
            // was asked for; only the kinds that answer for a video count.
            return helper && PUBLIC.has(helper.kind) ? { endpoint, helper } : null;
          } catch {
            return null;
          }
        }),
      )
    ).filter(Boolean);
    found.sort((a, b) => RANK[a.helper.kind] - RANK[b.helper.kind]);
    return found[0] || null;
  };

  // Round one: the list published beside the app. It is the plan, so it gets
  // the whole budget to itself before a single directory is contacted.
  const bundled = await probe(fresh(await invidiousInstances({ fetchImpl, timeout })));
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
