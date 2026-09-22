/**
 * Working out what a link is, in the page.
 *
 * This is the half of yt-dlp that siphon can genuinely move into the browser:
 * turn a URL into a title and a list of downloadable formats. It is nothing
 * like as broad — yt-dlp carries well over a thousand site extractors and this
 * carries four — but the four cover the shapes the web actually serves media
 * in, rather than one site at a time:
 *
 *   direct    a URL that is already the file
 *   hls       an .m3u8 ladder, which is how most players are fed
 *   page      an HTML page with the media in its markup (og:video, <video>, …)
 *   youtube   InnerTube, via youtubei.js, loaded on demand
 *
 * The first three need nothing but the browser when the host allows
 * cross-origin reads, which is common for anything designed to be embedded.
 * YouTube is the exception and says so plainly rather than failing vaguely.
 *
 * Formats come out in a single shape so the download planner below never has
 * to care which extractor produced them.
 */
import { BackendError } from './errors.js';
import { isMaster, parseMaster } from './m3u8.js';

/** The youtubei.js browser bundle, pinned. It is only fetched for YouTube links. */
const YOUTUBEI = 'https://cdn.jsdelivr.net/npm/youtubei.js@18.0.0/bundle/browser.js';

/**
 * YouTube clients to try in order, mirroring the server's ladder.
 *
 * `undefined` means the library's own default, which tracks upstream better
 * than anything pinned here. The rest are rungs for when that is turned away:
 * which clients pass without a proof-of-origin token changes every few months.
 */
const YT_CLIENTS = [undefined, 'TV_EMBEDDED', 'IOS', 'ANDROID_VR', 'MWEB'];

const CONTAINERS = {
  mp4: { container: 'mp4', kind: 'muxed' },
  m4v: { container: 'mp4', kind: 'muxed' },
  mov: { container: 'mov', kind: 'muxed' },
  webm: { container: 'webm', kind: 'muxed' },
  mkv: { container: 'mkv', kind: 'muxed' },
  ogv: { container: 'ogg', kind: 'muxed' },
  m4a: { container: 'm4a', kind: 'audio' },
  mp3: { container: 'mp3', kind: 'audio' },
  aac: { container: 'aac', kind: 'audio' },
  opus: { container: 'opus', kind: 'audio' },
  oga: { container: 'ogg', kind: 'audio' },
  ogg: { container: 'ogg', kind: 'audio' },
  flac: { container: 'flac', kind: 'audio' },
  wav: { container: 'wav', kind: 'audio' },
};

/** Container to the content type a browser should be handed it as. */
export const MIME_FOR = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogg: 'video/ogg',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  opus: 'audio/opus',
  flac: 'audio/flac',
  wav: 'audio/wav',
};

/**
 * Content type to container.
 *
 * Derived from the table below rather than written out again, because two
 * hand-maintained tables facing opposite ways drift. Only the types that are
 * not simply the inverse are listed.
 */
const MIME_CONTAINERS = {
  ...Object.fromEntries(Object.entries(MIME_FOR).map(([container, mime]) => [mime, container])),
  'audio/ogg': 'ogg',
  'audio/x-wav': 'wav',
};

const HLS_MIMES = new Set(['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl']);

/** The extension on a URL's path, ignoring the query string. */
export function extensionOf(url) {
  try {
    const path = new URL(url, 'https://x.invalid').pathname;
    const dot = path.lastIndexOf('.');
    return dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
  } catch {
    return '';
  }
}

/** What a URL claims to be, from its extension alone. Cheap, and often right. */
export function sniffUrl(url) {
  const extension = extensionOf(url);
  if (extension === 'm3u8' || extension === 'm3u') return { protocol: 'hls', container: 'mp4', kind: 'muxed' };
  const known = CONTAINERS[extension];
  return known ? { protocol: 'progressive', ...known } : null;
}

/** What a response says it is, which beats the extension when they disagree. */
export function sniffType(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (HLS_MIMES.has(type)) return { protocol: 'hls', container: 'mp4', kind: 'muxed' };
  const container = MIME_CONTAINERS[type];
  if (container) return { protocol: 'progressive', container, kind: type.startsWith('audio/') ? 'audio' : 'muxed' };
  return null;
}

/** A readable name for the finished file, from the URL when nothing better exists. */
export function titleFromUrl(url) {
  try {
    const path = decodeURIComponent(new URL(url).pathname);
    const last = path.split('/').filter(Boolean).pop() || '';
    const name = last.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_+]+/g, ' ').trim();
    return name || new URL(url).hostname;
  } catch {
    return 'download';
  }
}

/** Strip the characters a file system will not take, and keep it a sane length. */
export function safeFilename(name, extension) {
  const base = String(name || 'download')
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'download';
  return extension ? `${base}.${extension}` : base;
}

/* ------------------------------------------------------------------ scraping */

// The extension has to end the path — followed by a query, a quote or the
// end — or `…/mp4:clip.mp4/playlist.m3u8`, how Wowza names its streams, is cut
// off at the first `.mp4` into an address that is not a file.
const MEDIA_IN_TEXT = /https?:\/\/[^\s"'<>\\)]+?\.(?:m3u8|mp4|webm|m4a|mp3)(?=[?#&"'\s<>\\),;]|$)(?:\?[^\s"'<>\\)]*)?/gi;

/**
 * Pull media URLs out of a page's markup.
 *
 * Ordered by how much the page is asserting: an `og:video` tag is the site
 * telling other sites what the media is, a `<video src>` is the player, and a
 * URL found loose in inline JSON is a guess. Taking them in that order means
 * the guess is only used when nothing better was declared.
 *
 * Exported and pure so the ordering can be tested without a browser.
 */
export function scrapePage(html, baseUrl) {
  const found = [];
  const seen = new Set();
  const add = (url, source) => {
    if (!url) return;
    let absolute;
    try {
      absolute = new URL(url, baseUrl).href;
    } catch {
      return;
    }
    if (!/^https?:/.test(absolute) || seen.has(absolute)) return;
    seen.add(absolute);
    found.push({ url: absolute, source });
  };

  const attribute = (tag, name) => {
    const match = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tag);
    return match ? match[1] : null;
  };

  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const property = (attribute(tag, 'property') || attribute(tag, 'name') || '').toLowerCase();
    if (property === 'og:video:secure_url' || property === 'og:video:url' || property === 'og:video' || property === 'twitter:player:stream') {
      add(attribute(tag, 'content'), 'og');
    }
  }

  for (const tag of html.match(/<(?:video|audio|source)\b[^>]*>/gi) || []) {
    add(attribute(tag, 'src'), 'element');
  }

  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const type = (attribute(tag, 'type') || '').toLowerCase();
    if (HLS_MIMES.has(type) || type.startsWith('video/') || type.startsWith('audio/')) add(attribute(tag, 'href'), 'link');
  }

  for (const block of html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || []) {
    const body = block.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '');
    try {
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach(walk);
        if (typeof node.contentUrl === 'string') add(node.contentUrl, 'jsonld');
        if (typeof node.embedUrl === 'string' && sniffUrl(node.embedUrl)) add(node.embedUrl, 'jsonld');
        Object.values(node).forEach(walk);
      };
      walk(JSON.parse(body));
    } catch {
      /* a page with malformed JSON-LD still has the other routes */
    }
  }

  // Last resort: a media URL sitting in inline script JSON. Escaped slashes are
  // the common form there, so undo them before matching.
  for (const match of html.replace(/\\\//g, '/').match(MEDIA_IN_TEXT) || []) add(match, 'inline');

  return found;
}

/* ---------------------------------------------------------------- extractors */

const YOUTUBE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtu.be', 'www.youtu.be', 'youtube-nocookie.com', 'www.youtube-nocookie.com',
]);

/** The video id in any of YouTube's URL shapes, or null if this is not one. */
export function youtubeId(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) return null;

  if (parsed.hostname.toLowerCase().endsWith('youtu.be')) {
    const id = parsed.pathname.slice(1).split('/')[0];
    return /^[\w-]{11}$/.test(id) ? id : null;
  }
  const query = parsed.searchParams.get('v');
  if (query && /^[\w-]{11}$/.test(query)) return query;

  const path = /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(parsed.pathname);
  return path ? path[1] : null;
}

export function isYouTube(url) {
  try {
    return YOUTUBE_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- the entry */

/**
 * @typedef {object} Resolver
 * Something that can turn a link into formats when this page cannot: a siphon
 * server running yt-dlp, an Invidious or Piped instance. Tried in order.
 * @property {string} name
 * @property {boolean} generic  true if it knows every site, not just YouTube
 * @property {(url: string, context: object) => Promise<object>} resolve
 */

/**
 * Identify a link.
 *
 * The device goes first for everything it can read itself: direct files, HLS,
 * pages with a video in them. YouTube is the exception — it checks who is
 * asking, and a page is the wrong answer — so there the resolvers go first,
 * and InnerTube from this page is the last resort. Any other link the device
 * cannot make sense of is offered to a generic resolver, which is how the
 * thousand sites yt-dlp knows become reachable from a page that knows four.
 *
 * @param {string} url
 * @param {{ net: import('./net.js').Fetcher, signal?: AbortSignal, resolvers?: Resolver[] }} context
 */
export async function extract(url, context) {
  const resolvers = context.resolvers || [];
  if (isYouTube(url)) return extractYouTube(url, { ...context, resolvers });

  try {
    return await extractNative(url, context);
  } catch (error) {
    const generic = resolvers.filter((resolver) => resolver.generic);
    if (generic.length === 0) throw error;
    let last = error;
    for (const resolver of generic) {
      try {
        return await resolver.resolve(url, context);
      } catch (failure) {
        last = failure;
      }
    }
    throw last;
  }
}

/** What this page can read on its own. */
async function extractNative(url, context) {
  const hint = sniffUrl(url);
  if (hint?.protocol === 'hls') return extractHls(url, context, {});
  if (hint) return extractDirect(url, context, hint);

  // Nothing in the URL says what it is, so ask the server for its headers
  // before downloading a whole HTML page that might be a 300 MB video.
  const head = await context.net.peek(url, { signal: context.signal });
  const typed = sniffType(head.type);
  if (typed?.protocol === 'hls') return extractHls(url, context, {});
  if (typed) return extractDirect(url, context, typed, head);
  return extractPage(url, context);
}

async function extractDirect(url, context, shape, head = null) {
  // A host that is merely slow to say what the file is still gets its
  // download. One that refuses — no cross-origin headers, a 404 — does not:
  // that is an answer, and it has to reach extract() while there is still a
  // resolver or an instance that could take the link instead.
  const headers = head || (await context.net.peek(url, { signal: context.signal }).catch((error) => {
    if (error instanceof BackendError && error.retryable === false) throw error;
    return null;
  }));
  const typed = headers ? sniffType(headers.type) : null;
  const container = typed?.container || shape.container;
  const kind = typed?.kind || shape.kind;

  return {
    id: url,
    url,
    title: headers?.filename ? headers.filename.replace(/\.[a-z0-9]{1,5}$/i, '') : titleFromUrl(url),
    uploader: hostOf(url),
    duration: null,
    thumbnail: null,
    extractor: 'direct',
    isLive: false,
    playlist: null,
    subtitles: [],
    formats: [
      {
        id: 'source',
        url,
        protocol: 'progressive',
        kind,
        container,
        height: null,
        width: null,
        bitrate: null,
        filesize: headers?.length || null,
        codecs: '',
        label: 'Source',
      },
    ],
  };
}

async function extractHls(url, context, meta) {
  // Relative to where the playlist landed, which a redirect moves.
  const { text, url: base } = await context.net.document(url, { signal: context.signal });
  const formats = [];

  if (isMaster(text)) {
    const { variants, audio } = parseMaster(text, base);
    // The audio a player takes for a variant is its group's DEFAULT rendition
    // (or the first). When that rendition has a URI, the variant carries no
    // sound of its own and the two are muxed here. When it has none, the
    // soundtrack is inside the variant, and a sibling with a URI is only an
    // alternative — a dub — which taking would put in place of the original.
    const audioFor = (variant) => {
      const group = audio.filter((track) => variant.audioGroup && track.group === variant.audioGroup);
      const chosen = group.find((track) => track.default) || group[0] || null;
      return chosen?.url ? chosen : null;
    };
    // Best variant first, so the audio listed first is the one that goes with it.
    const tracks = [];
    for (const [index, variant] of variants.entries()) {
      const track = audioFor(variant);
      if (track && !tracks.includes(track)) tracks.push(track);
      formats.push({
        id: `hls-${index}`,
        url: variant.url,
        protocol: 'hls',
        kind: track ? 'video' : 'muxed',
        container: 'mp4',
        height: variant.height,
        width: variant.width,
        bitrate: variant.bandwidth,
        filesize: null,
        codecs: variant.codecs,
        label: variant.height ? `${variant.height}p` : 'stream',
      });
    }
    for (const [index, track] of tracks.entries()) {
      formats.push({
        id: index === 0 ? 'hls-audio' : `hls-audio-${index}`,
        url: track.url,
        protocol: 'hls',
        kind: 'audio',
        container: 'm4a',
        height: null,
        width: null,
        bitrate: null,
        filesize: null,
        codecs: '',
        label: track.name || 'audio',
      });
    }
  }

  if (formats.length === 0) {
    // A media playlist with no master above it: one rendition, take it.
    formats.push({
      id: 'hls-0',
      url,
      protocol: 'hls',
      kind: 'muxed',
      container: 'mp4',
      height: null,
      width: null,
      bitrate: null,
      filesize: null,
      codecs: '',
      label: 'stream',
    });
  }

  return {
    id: url,
    url,
    title: meta.title || titleFromUrl(url),
    uploader: meta.uploader || hostOf(url),
    duration: meta.duration ?? null,
    thumbnail: meta.thumbnail || null,
    extractor: meta.extractor || 'hls',
    isLive: false, // decided from the media playlist at download time
    playlist: null,
    formats,
  };
}

async function extractPage(url, context) {
  // Relative to where the page landed: `/watch/1` redirected to
  // `/watch/1-some-slug/` names `media/clip.mp4` from there.
  const { text: html, url: base } = await context.net.document(url, { signal: context.signal });
  const candidates = scrapePage(html, base);

  if (candidates.length === 0) {
    throw new BackendError('No media found on that page.', {
      hint:
        'The in-browser extractor reads a page\'s own markup. Sites that build their player ' +
        'in JavaScript hide the file from it — those need your own server.',
      retryable: false,
    });
  }

  const title = pageTitle(html) || titleFromUrl(url);
  const thumbnail = metaContent(html, 'og:image');

  // Try each candidate in order rather than trusting the first: an og:video
  // pointing at a dead CDN should not sink a page that also has a <video src>.
  // That only works if a candidate is asked what it is before it is taken —
  // a dead one answers 404, and an og:video is as often the site's player
  // page as its file, which answers text/html. Taking either unasked would
  // end the search with a download that fails, or one that is a web page.
  let failure = null;
  for (const candidate of candidates.slice(0, 6)) {
    try {
      const meta = { title, thumbnail, uploader: hostOf(url), extractor: 'page' };
      const shape = sniffUrl(candidate.url);
      if (shape?.protocol === 'hls') return await extractHls(candidate.url, context, meta);
      const head = await context.net.peek(candidate.url, { signal: context.signal });
      const typed = sniffType(head.type);
      if (typed?.protocol === 'hls') return await extractHls(candidate.url, context, meta);
      if (!typed && /^(text\/html|application\/xhtml\+xml)$/.test(head.type)) {
        throw new BackendError('That page points at a player, not at a file.', {
          hint: 'The file is inside the player\'s own page, built by its JavaScript — that needs your own server.',
          retryable: false,
        });
      }
      const found = await extractDirect(candidate.url, context, shape || { container: 'mp4', kind: 'muxed' }, head);
      return { ...found, title, thumbnail, uploader: hostOf(url), extractor: 'page', url };
    } catch (error) {
      if (context.signal?.aborted) throw error;
      failure = error;
    }
  }
  throw failure || new BackendError('Nothing on that page could be downloaded.', { retryable: false });
}

const pageTitle = (html) =>
  metaContent(html, 'og:title') ||
  (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').replace(/\s+/g, ' ').trim() ||
  null;

function metaContent(html, property) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const name = (/(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] || '').toLowerCase();
    if (name !== property) continue;
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (content) return decodeEntities(content);
  }
  return null;
}

const decodeEntities = (text) =>
  String(text).replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, name) =>
    ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" })[name]);

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/* ----------------------------------------------------------------- youtube */

let innertubeModule = null;

/**
 * Load youtubei.js on demand.
 *
 * It is 1.5 MB, so it is not part of the app shell — a user downloading an
 * .mp4 from a CDN should never pay for it. Pinned to an exact version because
 * a floating tag would mean the app silently changes under the user.
 */
async function loadInnertube() {
  if (!innertubeModule) {
    innertubeModule = import(/* @vite-ignore */ YOUTUBEI).catch((error) => {
      innertubeModule = null;
      throw new BackendError('Could not load the YouTube extractor.', {
        hint: `It is fetched from jsDelivr on first use — check the connection. (${error?.message || error})`,
      });
    });
  }
  return innertubeModule;
}

/**
 * Route youtubei.js's own requests through our fetcher.
 *
 * The library hands us either a URL or a Request; normalising to a Request
 * first means the body and headers come along without special-casing. Headers
 * the browser forbids a page to set (User-Agent, Cookie, …) are already gone
 * by the time they reach here — the Headers constructor drops them — which is
 * one of the reasons this path needs a relay at all.
 */
export function innertubeFetch(net) {
  return async (input, init) => {
    // The library calls this with a Request *and* an init: the Request is
    // the bare payload, and the init carries what the library added to it —
    // the session context in the body, the visitor and client headers. Taking
    // the Request alone sends a player call with no `context` at all, which
    // YouTube answers with 400 "Precondition check failed" on every client.
    // `new Request(input, init)` lets the init win, as the library intends.
    const request = new Request(input, init);
    const headers = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
    return net.request(request.url, { method: request.method, headers, body, prefer: 'relay' });
  };
}

/**
 * One session per fetcher, not one for the page.
 *
 * The session keeps the fetch it was created with, and the fetch is what
 * decides the route — the bridge, this relay, that relay. Settings can
 * change under a running page, and each change builds a new Fetcher; a
 * session cached on the module would go on using the old one, sending
 * YouTube's calls to a relay the person has just cleared.
 */
const sessions = new WeakMap();

async function youtubeSession(net) {
  if (!sessions.has(net)) {
    const created = (async () => {
      const { Innertube } = await loadInnertube();
      return Innertube.create({ fetch: innertubeFetch(net), retrieve_player: true, generate_session_locally: true });
    })().catch((error) => {
      sessions.delete(net);
      throw error;
    });
    sessions.set(net, created);
  }
  return sessions.get(net);
}

/** Bot walls are worth another client; a private video is not. */
const isBotWall = (reason) => /sign in|not a bot|confirm you|age|inappropriate/i.test(String(reason || ''));

async function extractYouTube(url, context) {
  const id = youtubeId(url);
  if (!id) {
    throw new BackendError('That YouTube link has no video in it.', {
      hint: 'Channel and playlist pages need your own server.',
      retryable: false,
    });
  }
  // Whatever can answer for YouTube without this page pretending to be a
  // browser on youtube.com goes first: a server with yt-dlp and cookies, an
  // instance. InnerTube from here, through an escape, is the last resort —
  // it works from a home connection and is bot-walled from a datacentre.
  //
  // "An escape" here means one that can carry YouTube's own API: the bridge
  // or a relay. A server's tunnel carries only the hosts that server
  // resolved, so through it InnerTube is refused before the first byte —
  // and the answer the person would read is the tunnel's refusal rather
  // than what the server actually said about the video.
  const canReachYouTube = Boolean(context.net.hasOpenEscape);
  let instanceFailure = null;
  for (const resolver of context.resolvers || []) {
    try {
      return await resolver.resolve(url, context);
    } catch (error) {
      if (error instanceof BackendError && error.retryable === false && !canReachYouTube) throw error;
      instanceFailure = error;
    }
  }

  if (!canReachYouTube) {
    if (instanceFailure) throw instanceFailure;
    throw new BackendError('YouTube will not talk to a web page directly.', {
      hint:
        'Its API sends no cross-origin headers, so the browser refuses before the request leaves. ' +
        'Give this app a helper in settings — your own server, a cobalt, Invidious or Piped instance, or a relay — ' +
        'or install the bridge.',
      retryable: false,
    });
  }

  const youtube = await youtubeSession(context.net);
  let lastReason = '';

  for (const client of YT_CLIENTS) {
    let info;
    try {
      info = await youtube.getBasicInfo(id, client ? { client } : undefined);
    } catch (error) {
      lastReason = error?.message || String(error);
      continue;
    }

    const status = info?.playability_status;
    if (status && status.status !== 'OK') {
      lastReason = status.reason || status.status;
      if (!isBotWall(lastReason)) {
        throw new BackendError(`YouTube says: ${lastReason}`, { retryable: false });
      }
      continue;
    }

    const streaming = info.streaming_data;
    const raw = [...(streaming?.formats || []), ...(streaming?.adaptive_formats || [])];
    if (raw.length === 0) {
      lastReason = lastReason || 'no formats were offered';
      continue;
    }

    const basic = info.basic_info || {};
    return {
      id,
      url,
      title: basic.title || `YouTube ${id}`,
      uploader: basic.author || basic.channel?.name || null,
      duration: basic.duration || null,
      thumbnail: basic.thumbnail?.[0]?.url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      extractor: `youtube (${client || 'default'})`,
      isLive: Boolean(basic.is_live),
      playlist: null,
      formats: raw.map((format, index) => toFormat(format, index)),
      // The signed URL is only worked out for the format actually chosen:
      // deciphering every one of thirty costs time nobody asked for.
      resolve: async (chosen) => {
        const source = raw[chosen.index];
        const signed = await source.decipher(youtube.session.player);
        if (!signed) throw new BackendError('YouTube returned a format with no usable URL.');
        return signed;
      },
    };
  }

  // Both routes were tried; naming only the second would hide the first.
  const instance = instanceFailure ? ` Tried first: ${instanceFailure.message}` : '';
  throw new BackendError('YouTube turned every client away.', {
    hint: (lastReason
      ? `Last answer: ${lastReason}. A relay runs on a datacentre IP, which YouTube treats with more suspicion than a home connection — your own server is the cure.`
      : 'Try your own server, which can carry your cookies.') + instance,
  });
}

function toFormat(format, index) {
  const mime = String(format.mime_type || '');
  const container = /mp4|m4a/.test(mime) ? (format.has_video ? 'mp4' : 'm4a') : /webm/.test(mime) ? 'webm' : 'mp4';
  return {
    id: `itag-${format.itag}`,
    index,
    url: format.url || '',
    protocol: 'progressive',
    kind: format.has_video && format.has_audio ? 'muxed' : format.has_video ? 'video' : 'audio',
    container,
    height: format.height || null,
    width: format.width || null,
    bitrate: format.bitrate || null,
    filesize: Number(format.content_length) || null,
    codecs: (/codecs="([^"]+)"/.exec(mime) || [])[1] || '',
    label: format.quality_label || format.audio_quality?.replace('AUDIO_QUALITY_', '').toLowerCase() || 'audio',
  };
}

/* ---------------------------------------------------------------- instances */

/**
 * How long an instance gets to answer an API call.
 *
 * An instance that is down usually refuses, which is instant. One that
 * drops the connection — a firewall that swallows datacentre traffic, an
 * overloaded box — hangs, and without a bound the walk to the next replica
 * waits on it forever. Fifteen seconds is generous for a JSON answer and
 * short enough that three dead replicas cost under a minute, not ten.
 */
export const INSTANCE_TIMEOUT_MS = 15_000;

/**
 * The caller's signal, if any, plus the bound — whichever fires first.
 *
 * A plain timer rather than `AbortSignal.timeout`, for two reasons: the
 * caller's signal has to be folded in without `AbortSignal.any`, which is
 * newer than some phones' browsers, and a timeout signal's timer is unref'd
 * under Node, which lets a test's event loop drain mid-request. `release`
 * clears the timer once the answer is in, so a fast reply costs no wait.
 */
function bounded(signal, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException(`no answer within ${ms} ms`, 'TimeoutError')), ms);
  const forward = () => controller.abort(signal.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener('abort', forward, { once: true });
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    },
  };
}

/* -------------------------------------------------------------------- piped */

/**
 * Piped's stream list, in our Format shape.
 *
 * A Piped instance answers `/streams/{id}` with CORS headers and rewrites
 * every media URL through its own proxy, which sends them too — its frontend
 * is a separate origin, so the design requires it. That is what makes it a
 * source the browser mode can use without a relay: the formats come out here
 * exactly as they would from InnerTube, and everything downstream — the
 * planner, ffmpeg.wasm, OPFS — is unchanged.
 *
 * Exported and pure so the mapping can be tested without an instance.
 */
export function pipedFormats(body) {
  const height = (stream) => stream.height || parseInt(String(stream.quality || ''), 10) || null;
  const container = (mime, video) => (/webm/.test(mime) ? 'webm' : video ? 'mp4' : 'm4a');

  const video = (body.videoStreams || []).map((stream, index) => ({
    id: `piped-v${index}`,
    url: stream.url,
    protocol: 'progressive',
    kind: stream.videoOnly ? 'video' : 'muxed',
    container: container(String(stream.mimeType || ''), true),
    height: height(stream),
    width: stream.width || null,
    bitrate: stream.bitrate || null,
    filesize: Number(stream.contentLength) || null,
    codecs: stream.codec || '',
    label: stream.quality || 'video',
  }));

  const audio = (body.audioStreams || []).map((stream, index) => ({
    id: `piped-a${index}`,
    url: stream.url,
    protocol: 'progressive',
    kind: 'audio',
    container: container(String(stream.mimeType || ''), false),
    height: null,
    width: null,
    bitrate: stream.bitrate || null,
    filesize: Number(stream.contentLength) || null,
    codecs: stream.codec || '',
    label: stream.quality || 'audio',
  }));

  return [...video, ...audio].filter((format) => format.url);
}

/** The subtitle tracks a Piped instance lists, in the shape the job runner embeds. */
export function pipedSubtitles(body) {
  return (body.subtitles || [])
    .filter((track) => track && track.url)
    .map((track) => ({
      lang: track.code || track.name || '',
      ext: 'vtt',
      url: track.url,
      auto: Boolean(track.autoGenerated),
    }));
}

/**
 * Ask a user-configured Piped instance for a video's streams.
 *
 * This is the same trust model as the public-instance (cobalt) mode that
 * already exists: nothing is contacted unless the user pasted an address,
 * and the privacy line on the main screen says the instance sees the link.
 */
/** A Piped instance as a resolver: YouTube only, nothing of ours in front. */
export function pipedResolver(base) {
  const root = String(base || '').trim().replace(/\/+$/, '');
  if (!root) return null;
  return {
    name: 'piped',
    generic: false,
    resolve: (url, context) => {
      const id = youtubeId(url);
      if (!id) throw new BackendError('That YouTube link has no video in it.', { retryable: false });
      return extractPiped(id, url, { ...context, piped: root });
    },
  };
}

async function extractPiped(id, url, context) {
  const base = String(context.piped || '').replace(/\/+$/, '');
  let body;
  const bound = bounded(context.signal, context.instanceTimeout ?? INSTANCE_TIMEOUT_MS);
  try {
    body = await context.net.json(`${base}/streams/${encodeURIComponent(id)}`, { signal: bound.signal });
  } catch (error) {
    bound.release();
    if (context.signal?.aborted) throw error;
    throw new BackendError('The Piped instance did not answer for that video.', {
      hint: `${error instanceof BackendError ? error.message : 'It may be down, rate-limited, or blocked by YouTube.'} Instances come and go; try another, a relay, or your own server.`,
    });
  }
  bound.release();
  if (body?.error) {
    throw new BackendError(`The Piped instance says: ${String(body.error).slice(0, 160)}`, {
      hint: 'That is YouTube refusing the instance, not this app. Try another instance, a relay, or your own server.',
    });
  }
  const formats = pipedFormats(body);
  if (formats.length === 0) throw new BackendError('The Piped instance returned no streams for that video.');

  return {
    id,
    url,
    title: body.title || `YouTube ${id}`,
    uploader: body.uploader || null,
    duration: body.duration || null,
    thumbnail: body.thumbnailUrl || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    extractor: 'youtube (piped)',
    isLive: Boolean(body.livestream),
    playlist: null,
    formats,
    subtitles: pipedSubtitles(body),
  };
}

/* ---------------------------------------------------------------- invidious */

/**
 * Invidious's video answer, in our Format shape.
 *
 * `/api/v1/videos/{id}` lists `formatStreams` (muxed, progressive) and
 * `adaptiveFormats` (video-only and audio-only), the same split InnerTube
 * makes. Asked with `local=true` the instance rewrites every media URL
 * through its own `/videoplayback`, as a path relative to itself — and that
 * is the only form a page can fetch, since the googlevideo original refuses
 * a foreign origin. So `base` is what those paths are resolved against; an
 * absolute URL is left alone.
 *
 * Numbers arrive as strings (`bitrate`, `clen`) and the size as "640x360";
 * both are normalised here so nothing downstream has to know where a format
 * came from. Exported and pure so the mapping can be tested without an
 * instance.
 */
export function invidiousFormats(body, base = '') {
  const root = String(base || '').replace(/\/+$/, '');
  const absolute = (url) => (url && url.startsWith('/') ? `${root}${url}` : url || '');
  const container = (type, video) => (/webm/.test(type) ? 'webm' : video ? 'mp4' : 'm4a');
  const codecs = (type) => (/codecs="([^"]+)"/.exec(type) || [])[1] || '';
  const dimensions = (fmt) => {
    const size = /^(\d+)x(\d+)$/.exec(String(fmt.size || ''));
    return {
      width: size ? Number(size[1]) : null,
      height: size ? Number(size[2]) : parseInt(String(fmt.qualityLabel || fmt.resolution || ''), 10) || null,
    };
  };
  const one = (fmt, index, kind) => {
    const type = String(fmt.type || '');
    const video = kind !== 'audio';
    return {
      id: `invidious-${kind[0]}${index}`,
      url: absolute(fmt.url),
      protocol: 'progressive',
      kind,
      container: container(type, video),
      ...(video ? dimensions(fmt) : { width: null, height: null }),
      bitrate: Number(fmt.bitrate) || null,
      filesize: Number(fmt.clen) || null,
      codecs: codecs(type),
      label: video
        ? fmt.qualityLabel || fmt.resolution || 'video'
        : String(fmt.audioQuality || 'audio').replace('AUDIO_QUALITY_', '').toLowerCase(),
    };
  };

  const muxed = (body.formatStreams || []).map((fmt, index) => one(fmt, index, 'muxed'));
  const adaptive = (body.adaptiveFormats || []).map((fmt, index) =>
    one(fmt, index, String(fmt.type || '').startsWith('video/') ? 'video' : 'audio'),
  );
  return [...muxed, ...adaptive].filter((format) => format.url);
}

/**
 * The captions an Invidious instance offers, in the shape the job runner embeds.
 *
 * Caption URLs are relative to the instance in every mode, and the instance
 * serves them as WebVTT. A machine track is only told apart by its label.
 */
export function invidiousSubtitles(body, base = '') {
  const root = String(base || '').replace(/\/+$/, '');
  return (body.captions || [])
    .filter((caption) => caption && caption.url)
    .map((caption) => ({
      lang: caption.language_code || caption.label || '',
      ext: 'vtt',
      url: caption.url.startsWith('/') ? `${root}${caption.url}` : caption.url,
      auto: /auto-generated/i.test(String(caption.label || '')),
    }));
}

/** Sentences from an instance that are about the video, and so the same everywhere. */
const ABOUT_THE_VIDEO = /\bprivate\b|\bunavailable\b|\bmembers|\bage[- ]?restrict|\bremoved\b|\bnot exist|\binvalid\b|\bpremiere|\blive ?stream/i;

/**
 * An Invidious instance as a resolver: YouTube only, nothing of ours in front.
 *
 * One instance is not the plan; the network is. Public instances get
 * rate-limited and bot-walled by YouTube in waves, so when the configured
 * one refuses in a way that is about *it* rather than the video, the next
 * few from the bundled list are asked in turn, inside the same job — the
 * person sees one download that works, not a failed row and a settings
 * chore. A refusal about the video (private, gone) is final everywhere and
 * is not repeated.
 *
 * @param {string} base  the configured instance
 * @param {{ others?: () => Promise<string[]>, spare?: number }} [options]
 *   `others` yields the bundled list; `spare` caps how many more are asked
 */
export function invidiousResolver(base, { others = async () => [], spare = 3, timeout = INSTANCE_TIMEOUT_MS } = {}) {
  const root = String(base || '').trim().replace(/\/+$/, '');
  if (!root) return null;
  return {
    name: 'invidious',
    generic: false,
    resolve: async (url, context) => {
      const id = youtubeId(url);
      if (!id) throw new BackendError('That YouTube link has no video in it.', { retryable: false });
      let failure;
      try {
        return await extractInvidious(id, url, { ...context, invidious: root, instanceTimeout: timeout });
      } catch (error) {
        if (error instanceof BackendError && error.retryable === false) throw error;
        failure = error;
      }
      const replicas = (await others().catch(() => []))
        .map((address) => String(address || '').replace(/\/+$/, ''))
        .filter((address) => address && address !== root)
        .slice(0, spare);
      for (const replica of replicas) {
        if (context.signal?.aborted) throw failure;
        try {
          return await extractInvidious(id, url, { ...context, invidious: replica, instanceTimeout: timeout });
        } catch (error) {
          if (error instanceof BackendError && error.retryable === false) throw error;
          failure = error;
        }
      }
      if (replicas.length > 0) {
        throw new BackendError(`Every Invidious instance tried refused that video (${replicas.length + 1} of them).`, {
          hint: `Last answer: ${failure.message} Most public instances now keep their video API closed to other apps; a relay or your own server is not refused.`,
        });
      }
      throw failure;
    },
  };
}

/**
 * The bundled list as one resolver, for when no instance is configured but
 * a relay is. The first instance is the base and the rest are the replicas;
 * every answer a page cannot read goes through the relay by the Fetcher's
 * usual route discovery, which is what makes instances that close their
 * video endpoint to pages — but not to a plain client — usable again.
 */
export function invidiousWalk({ others = async () => [], spare = 3, timeout = INSTANCE_TIMEOUT_MS } = {}) {
  return {
    name: 'invidious-walk',
    generic: false,
    resolve: async (url, context) => {
      const list = (await others().catch(() => [])).filter(Boolean);
      if (list.length === 0) throw new BackendError('No public Invidious instance to try.', { hint: 'The bundled list is empty.' });
      return invidiousResolver(list[0], { others: async () => list, spare, timeout }).resolve(url, context);
    },
  };
}

async function extractInvidious(id, url, context) {
  const base = String(context.invidious || '').replace(/\/+$/, '');
  let body;
  const bound = bounded(context.signal, context.instanceTimeout ?? INSTANCE_TIMEOUT_MS);
  try {
    // `local=true` is the whole point: without it the URLs are googlevideo's
    // own, and those refuse a page before the first byte.
    body = await context.net.json(`${base}/api/v1/videos/${encodeURIComponent(id)}?local=true`, { signal: bound.signal });
  } catch (error) {
    bound.release();
    // The person cancelling is not the instance failing.
    if (context.signal?.aborted) throw error;
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new BackendError(
      timedOut ? `${new URL(base).host} did not answer within ${Math.round((context.instanceTimeout ?? INSTANCE_TIMEOUT_MS) / 1000)}s.` : 'The Invidious instance did not answer for that video.',
      {
        hint: `${error instanceof BackendError ? error.message : 'It may be down, rate-limited, or blocked by YouTube.'} Instances come and go; try another, a relay, or your own server.`,
      },
    );
  }
  bound.release();
  if (body?.error) {
    // "This video is private" is the same on every instance; "sign in to
    // confirm you're not a bot" is YouTube talking to *this* instance, and
    // the next one may not be hearing it.
    const reason = String(body.error).slice(0, 160);
    throw new BackendError(`The Invidious instance says: ${reason}`, {
      hint: ABOUT_THE_VIDEO.test(reason)
        ? 'That is about the video, and no instance will answer differently.'
        : 'That is the instance being refused or refusing, not this app. Another instance, a relay, or your own server may not be.',
      retryable: !ABOUT_THE_VIDEO.test(reason),
    });
  }
  const formats = invidiousFormats(body, base);
  if (formats.length === 0) throw new BackendError('The Invidious instance returned no streams for that video.');

  // Thumbnails are relative in local mode too; the medium one is plenty for
  // cover art and a fraction of the size.
  const thumbnails = body.videoThumbnails || [];
  const thumb = thumbnails.find((t) => t?.quality === 'medium') || thumbnails.find((t) => t?.url) || null;
  const thumbnail = thumb?.url ? (thumb.url.startsWith('/') ? `${base}${thumb.url}` : thumb.url) : `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;

  return {
    id,
    url,
    title: body.title || `YouTube ${id}`,
    uploader: body.author || null,
    duration: body.lengthSeconds || null,
    thumbnail,
    extractor: `youtube (invidious: ${new URL(base).host})`,
    isLive: Boolean(body.liveNow),
    playlist: null,
    formats,
    subtitles: invidiousSubtitles(body, base),
  };
}

/* ------------------------------------------------------------------ planning */

/** The ceiling each video preset asks for; null means "whatever is best". */
const PRESET_HEIGHT = { video_best: null, video_1080: 1080, video_720: 720, video_480: 480 };

const better = (a, b) =>
  (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0) || (b.filesize || 0) - (a.filesize || 0);

const betterAudio = (a, b) => (b.bitrate || 0) - (a.bitrate || 0) || (b.filesize || 0) - (a.filesize || 0);

/**
 * Decide what to download and what has to be done to it.
 *
 * The order of preference is not about quality alone: a single progressive
 * file needs no ffmpeg, and ffmpeg.wasm is a 30 MB download and a slow pass
 * over the whole file. So when a muxed format already satisfies the preset it
 * wins over a marginally sharper pair that would have to be merged.
 *
 * Pure, so the whole decision table is testable.
 *
 * @returns {{ video: object|null, audio: object|null, ext: string, mime: string,
 *             op: 'raw'|'copy'|'audio-copy'|'audio-encode' }}
 */
export function planDownload(extraction, preset) {
  const formats = extraction.formats || [];
  if (formats.length === 0) throw new BackendError('That link offered no downloadable formats.', { retryable: false });

  const audioOnly = formats.filter((format) => format.kind === 'audio').sort(betterAudio);
  const muxed = formats.filter((format) => format.kind === 'muxed').sort(better);
  const videoOnly = formats.filter((format) => format.kind === 'video').sort(better);

  if (preset === 'audio_mp3' || preset === 'audio_m4a') {
    const source = audioOnly[0] || muxed[0] || videoOnly[0];
    if (!source) throw new BackendError('That link has no audio to take.', { retryable: false });
    const wantM4a = preset === 'audio_m4a';
    // Re-encoding audio that is already AAC loses quality for nothing, so an
    // m4a request for an AAC source is a container change, not a conversion —
    // including when the AAC is sitting inside a muxed file, where dropping the
    // video is all that is actually being asked for. A source whose codec is
    // unknown is re-encoded, because guessing wrong produces an unplayable file.
    const isAac =
      /mp4a|aac/i.test(source.codecs || '') ||
      (source.kind === 'audio' && (source.container === 'm4a' || source.container === 'aac'));
    const canCopy = wantM4a && source.protocol === 'progressive' && isAac;
    return {
      video: null,
      audio: source,
      ext: wantM4a ? 'm4a' : 'mp3',
      mime: wantM4a ? 'audio/mp4' : 'audio/mpeg',
      op: canCopy ? 'audio-copy' : 'audio-encode',
    };
  }

  const ceiling = PRESET_HEIGHT[preset] ?? null;
  // "1080p" names the short side. A Short or a Reel is 1080x1920 and labelled
  // 1080p, and measuring its height against the ceiling would hand a 1080p
  // request the 480p rendition.
  const side = (format) => (format.width && format.height ? Math.min(format.width, format.height) : format.height);
  const fits = (format) => ceiling === null || !side(format) || side(format) <= ceiling;

  const readyMade = muxed.filter(fits)[0] || null;
  const bestVideo = videoOnly.filter(fits)[0] || videoOnly[videoOnly.length - 1] || null;
  const bestAudio = audioOnly[0] || null;

  // A muxed file is preferred when it is not obviously worse than the pair —
  // "obviously" being a whole quality step, not a few hundred kbit.
  const pairIsBetter = bestVideo && bestAudio && (!readyMade || (bestVideo.height || 0) > (readyMade.height || 0));

  if (pairIsBetter) {
    return { video: bestVideo, audio: bestAudio, ext: 'mp4', mime: 'video/mp4', op: 'copy' };
  }
  if (!readyMade) {
    if (bestVideo) return { video: bestVideo, audio: null, ext: 'mp4', mime: 'video/mp4', op: 'copy' };
    const fallback = audioOnly[0];
    // A link to an .mp3 or a .flac with a video preset still selected: the
    // file is the link, and it is handed over as it is. Rewrapping it as M4A
    // would load the converter for nothing, and fail outright for everything
    // but AAC — MP3, FLAC, Opus, Vorbis and PCM have no place in an .m4a.
    if (fallback?.protocol === 'progressive') {
      return { video: null, audio: fallback, ext: fallback.container, mime: MIME_FOR[fallback.container] || 'application/octet-stream', op: 'raw' };
    }
    if (fallback) return { video: null, audio: fallback, ext: 'm4a', mime: 'audio/mp4', op: 'audio-copy' };
    throw new BackendError('That link offered no video to download.', { retryable: false });
  }

  // A progressive muxed file in a container the browser can hand straight to
  // the user needs no processing at all — bytes in, file out.
  if (readyMade.protocol === 'progressive') {
    return {
      video: readyMade,
      audio: null,
      ext: readyMade.container,
      mime: MIME_FOR[readyMade.container] || 'application/octet-stream',
      op: 'raw',
    };
  }
  return { video: readyMade, audio: null, ext: 'mp4', mime: 'video/mp4', op: 'copy' };
}
