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
  // Public Invidious instances. They close their video endpoint to web
  // pages but not to a plain client, and this relay is a plain client — so
  // through it the page can read what the instance answers, and the media
  // the instance proxies. The list is the app's bundled one.
  'invidious.f5.si',
  'nadeko.net',
  'yewtu.be',
  'invidious.nerdvpn.de',
  'yt.chocolatemoo53.com',
  'invidious.tiekoetter.com',
  'inv.thepixora.com',
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
 * Loopback, private, link-local, CGNAT (100.64/10) and "this host" (0.x), by
 * name or number, plus every IPv6 literal: no media host is addressed by one,
 * and each of them can spell a private address.
 */
const PRIVATE_HOST =
  /^(localhost|.+\.localhost|.+\.local|0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[)/i;

/**
 * Why a URL must not be fetched, or nothing.
 *
 * Workers cannot reach a private network, but they can reach other services on
 * the platform, and the Node bridge runs on someone's own machine, where the
 * LAN is right there — so the obvious shapes are refused rather than assumed
 * impossible. Asked of the first URL and of every redirect after it.
 */
function refusal(target, allowedHosts) {
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return 'only http(s)';
  if (PRIVATE_HOST.test(target.hostname)) return 'not a public address';
  if (!hostAllowed(target.hostname, allowedHosts)) return 'host not allowed';
  return null;
}

function targetOf(request) {
  const raw = new URL(request.url).searchParams.get('url');
  if (!raw) return { error: 'no url parameter' };
  try {
    return { target: new URL(raw) };
  } catch {
    return { error: 'unparseable url' };
  }
}

/** Enough for a CDN hand-off or two; a loop is refused rather than followed. */
const MAX_REDIRECTS = 5;

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
    const refused = refusal(target, allowedHosts);
    if (refused) return deny(refused, request, env, refused === 'host not allowed' ? 403 : 400);

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

    // The body is read whole rather than streamed. Streamed, it goes out as
    // transfer-encoding: chunked with no content-length — and that was the
    // one difference between a browser's own POST and ours when YouTube's
    // API answered every InnerTube call through the Node relay with a 400.
    // Nothing is lost: only API calls are POSTed through here, a few
    // kilobytes each; the media that must not be buffered is always a GET.
    //
    // Redirects are followed by hand. Followed by fetch, they went wherever
    // the first answer pointed — past both the allow-list and the private
    // address check, which only ever saw the first URL.
    let method = request.method;
    let body = method !== 'GET' && method !== 'HEAD' ? await request.arrayBuffer() : undefined;
    let url = target;
    let upstream;
    for (let hop = 0; ; hop += 1) {
      try {
        upstream = await fetch(url.toString(), { method, headers, body, redirect: 'manual' });
      } catch (failure) {
        return deny(`upstream: ${failure?.message || failure}`, request, env, 502);
      }
      const location = upstream.status >= 300 && upstream.status < 400 ? upstream.headers.get('location') : null;
      if (!location) break;
      await upstream.body?.cancel();
      if (hop === MAX_REDIRECTS) return deny('too many redirects', request, env, 502);
      let next;
      try {
        next = new URL(location, url);
      } catch {
        return deny('unparseable redirect', request, env, 502);
      }
      const why = refusal(next, allowedHosts);
      if (why) return deny(`redirect refused: ${why}`, request, env, 403);
      // As a browser does: a 303, or a 301/302 answering a POST, becomes a GET.
      if (upstream.status === 303 || ((upstream.status === 301 || upstream.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
      }
      url = next;
    }

    // The runtime's fetch has already decoded the body, so the upstream's
    // content-encoding describes bytes that are no longer there. Workers
    // would quietly re-encode to match; Node forwards the header over
    // plaintext, and a client told "gzip" then waits for a gzip header that
    // never comes — which is how the first real YouTube run hung on the very
    // first request. content-length is the truth only when nothing was
    // encoded, and then it is worth keeping: it is what a progress bar needs.
    const encoded = upstream.headers.has('content-encoding');
    const out = new Headers();
    for (const [key, value] of upstream.headers) {
      const name = key.toLowerCase();
      if (name === 'content-encoding' || name === 'set-cookie') continue;
      if (name === 'content-length' ? encoded : HOP_BY_HOP.has(name)) continue;
      if (name.startsWith('access-control-')) continue; // ours are the ones that count
      out.set(key, value);
    }
    for (const [key, value] of Object.entries(corsHeaders(request, env))) out.set(key, value);

    // The body is passed straight through rather than buffered: a two-hour
    // video must not have to fit in the worker before it reaches the browser.
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
  },
};
