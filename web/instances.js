/**
 * Finding a public instance, so the first visit is not a dead end.
 *
 * With no helper, a YouTube link fails on arrival — correctly, but the person
 * pasting it did not come here to read about CORS. A public instance fixes
 * that with nothing to deploy, and the addresses of those instances are
 * published by the projects themselves. So: ask the directories, fall back to
 * a short seed list, and *probe* every candidate before trusting any of it.
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
]);

/**
 * A short fallback, for when the directories themselves cannot be reached.
 *
 * Deliberately short and deliberately unverified: these are long-standing
 * addresses, not a promise that any of them answers today. Every one is
 * probed before use, and a dead entry costs one failed request.
 */
export const SEED = Object.freeze([
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.private.coffee',
  'https://pipedapi.reallyaweso.me',
  'https://pipedapi.darkness.services',
]);

/** cobalt reaches many sites; Piped reaches YouTube. Try the broader one first. */
const RANK = { cobalt: 0, piped: 1 };

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

/**
 * Find a public instance that actually answers.
 *
 * @param {object} options
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(address: string) => Promise<object>} options.detect  the same probe the settings sheet runs
 * @param {number} [options.candidates]  how many addresses to probe at most
 * @param {number} [options.timeout]  per-request budget, milliseconds
 * @returns {Promise<{ endpoint: string, helper: object }|null>}
 */
export async function findInstance({ fetchImpl = globalThis.fetch, detect, candidates = 8, timeout = 6000 } = {}) {
  const listed = (await Promise.all(DIRECTORIES.map((d) => askDirectory(d, fetchImpl, timeout)))).flat();

  // Directory entries first, seed behind them, duplicates dropped. The cap is
  // what keeps a first visit from firing forty requests at strangers.
  const seen = new Set();
  const addresses = [...listed, ...SEED.map(trimSlash)].filter((address) => {
    if (!address || seen.has(address)) return false;
    seen.add(address);
    return true;
  }).slice(0, candidates);

  const found = (
    await Promise.all(
      addresses.map(async (endpoint) => {
        try {
          const helper = await detect(endpoint);
          // A siphon server or a relay in a public instance list is not what
          // was asked for; only the two kinds that answer for a video count.
          return helper && (helper.kind === 'cobalt' || helper.kind === 'piped') ? { endpoint, helper } : null;
        } catch {
          return null;
        }
      }),
    )
  ).filter(Boolean);

  if (found.length === 0) return null;
  found.sort((a, b) => RANK[a.helper.kind] - RANK[b.helper.kind]);
  return found[0];
}
