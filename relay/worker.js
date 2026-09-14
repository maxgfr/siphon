/**
 * The smallest thing that makes YouTube work in the browser.
 *
 * siphon's browser mode does the extraction itself — reading the link, solving
 * the signature, picking a format, merging with ffmpeg.wasm. The one thing it
 * cannot do is read a response the host never offered to a web page, and
 * YouTube offers nothing to anyone but itself. This adds the missing header
 * and gets out of the way.
 *
 * It is not a downloader. There is no yt-dlp here, no ffmpeg, no queue, no
 * disk, no state between requests — which is why it fits in one file, runs on
 * a free tier, and needs no maintenance when YouTube changes: the part that
 * changes is running in the browser, not here.
 *
 * Deploy:
 *
 *   npx wrangler deploy
 *   npx wrangler secret put ALLOWED_ORIGINS   # https://you.github.io
 *
 * Then paste the worker's URL into siphon's settings under "Relay".
 *
 * Two guards, both worth understanding before you deploy:
 *
 * - ALLOWED_HOSTS is what stops this being an open proxy. Anyone with the URL
 *   can make it fetch — so it will only fetch the media hosts below.
 * - ALLOWED_ORIGINS is what stops other people's pages using yours. It is
 *   checked here rather than left to CORS, because CORS only stops a browser
 *   reading the answer, not this worker from making the request.
 */

/** Suffix matches, so `googlevideo.com` covers `rr3---sn-4g5e6nez.googlevideo.com`. */
const DEFAULT_HOSTS = [
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'googlevideo.com',
  'ytimg.com',
  'ggpht.com',
  'youtubei.googleapis.com',
];

/** Headers that describe one hop and must not be copied to the next. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

/**
 * Never forward the caller's credentials, and never carry ours.
 *
 * A relay that passes cookies through would let a page on any allowed origin
 * act as the signed-in user of whatever it fetched.
 */
const NEVER_FORWARD = new Set(['cookie', 'set-cookie', 'authorization', 'origin', 'referer']);

function list(value, fallback = []) {
  const items = String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function hostAllowed(hostname, allowed) {
  const host = hostname.toLowerCase();
  return allowed.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Refuse anything that is not a public web address.
 *
 * Workers cannot reach a private network, but they can reach other services on
 * the platform, and a hostname is free to resolve wherever it likes — so the
 * obvious shapes are refused here rather than assumed impossible.
 */
function targetOf(request) {
  const raw = new URL(request.url).searchParams.get('url');
  if (!raw) return { error: 'no url parameter' };
  let target;
  try {
    target = new URL(raw);
  } catch {
    return { error: 'unparseable url' };
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return { error: 'only http(s)' };
  if (/^(localhost|\[?::1\]?|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(target.hostname)) {
    return { error: 'not a public address' };
  }
  return { target };
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = list(env.ALLOWED_ORIGINS);
  return {
    // Echoing the caller's origin rather than `*` once an allow-list exists
    // keeps the answer specific to the page that asked for it.
    'Access-Control-Allow-Origin': allowed.length === 0 ? '*' : origin || 'null',
    // Range and Content-Range are the ones that matter: without them the
    // browser cannot read the byte offsets a partial download depends on.
    'Access-Control-Expose-Headers': '*',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function originAllowed(request, env) {
  const allowed = list(env.ALLOWED_ORIGINS);
  if (allowed.length === 0) return true; // unset means "anyone", which is why the README says to set it
  const origin = (request.headers.get('Origin') || '').toLowerCase();
  return allowed.includes(origin);
}

const deny = (reason, request, env, status = 403) =>
  new Response(JSON.stringify({ error: reason }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request, env) },
  });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(request, env),
          'Access-Control-Allow-Methods': 'GET,POST,HEAD,OPTIONS',
          // Reflect rather than list: youtubei.js sends a moving set of
          // x-goog-* and x-youtube-* headers, and guessing them would break
          // every time it adds one.
          'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || '*',
        },
      });
    }

    if (!originAllowed(request, env)) return deny('origin not allowed', request, env);

    const { target, error } = targetOf(request);
    if (error) return deny(error, request, env, 400);

    const allowedHosts = list(env.ALLOWED_HOSTS, DEFAULT_HOSTS);
    if (!hostAllowed(target.hostname, allowedHosts)) return deny('host not allowed', request, env);

    const headers = new Headers();
    for (const [key, value] of request.headers) {
      const name = key.toLowerCase();
      if (HOP_BY_HOP.has(name) || NEVER_FORWARD.has(name)) continue;
      if (name.startsWith('cf-') || name.startsWith('sec-') || name.startsWith('access-control-')) continue;
      headers.set(key, value);
    }
    // YouTube's own pages send these, and some of its clients check them.
    headers.set('Origin', 'https://www.youtube.com');
    headers.set('Referer', 'https://www.youtube.com/');

    let upstream;
    try {
      upstream = await fetch(target.toString(), {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'follow',
      });
    } catch (failure) {
      return deny(`upstream: ${failure?.message || failure}`, request, env, 502);
    }

    const out = new Headers();
    for (const [key, value] of upstream.headers) {
      const name = key.toLowerCase();
      if (HOP_BY_HOP.has(name) || name === 'set-cookie') continue;
      if (name.startsWith('access-control-')) continue; // ours are the ones that count
      out.set(key, value);
    }
    for (const [key, value] of Object.entries(corsHeaders(request, env))) out.set(key, value);

    // The body is passed straight through rather than buffered: a two-hour
    // video must not have to fit in the worker before it reaches the browser.
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  },
};
