/**
 * Browser mode, end to end, in a real browser.
 *
 * The claim this file exists to check is the one the README leads with: that a
 * page with no server behind it can take a link and produce a playable file.
 * Unit tests cover the decisions; only this covers the actual bytes.
 *
 * It builds its own fixtures with ffmpeg, serves the app on one origin and the
 * media on another — so the CORS path under test is the real one — drives
 * Chromium through the UI, and reads the downloaded files back with ffmpeg to
 * check they are what they claim to be.
 *
 *   npm run test:e2e
 *
 * Needs `playwright` and `ffmpeg` available, and network access to wherever
 * ffmpeg.wasm is fetched from. Point SIPHON_CORE_URL at a local copy to run it
 * offline; FFMPEG overrides the ffmpeg binary.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'web');
const WORK = join(HERE, '.e2e');
const MEDIA_DIR = join(WORK, 'media');
const DOWNLOADS = join(WORK, 'downloads');

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const APP_PORT = 8787;
// The converter as deployed: beside the app, on the app's own origin. When
// scripts/vendor_ffmpeg.py has run, the suite loads it from there — which is
// what a visitor gets — and asserts so. SIPHON_CORE_URL still overrides.
const VENDORED = existsSync(join(WEB, 'vendor', 'ffmpeg', 'ffmpeg-core.js'));
const CORE_URL = process.env.SIPHON_CORE_URL || (VENDORED
  ? `http://127.0.0.1:${APP_PORT}/app/vendor/ffmpeg/ffmpeg-core.js`
  : 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js');
const MEDIA_PORT = 8788;
const INV_PORT = 8789;
const PIPED_PORT = 8792;
const COBALT_PORT = 8793;
const OWN_PORT = 8794;
const MEDIA = `http://127.0.0.1:${MEDIA_PORT}`;
const OWN = `http://127.0.0.1:${OWN_PORT}`;
const INV = `http://127.0.0.1:${INV_PORT}`;
const PIPED = `http://127.0.0.1:${PIPED_PORT}`;
const COBALT = `http://127.0.0.1:${COBALT_PORT}`;

/* -------------------------------------------------------------------- fixtures */

function ffmpeg(args) {
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
}

/** ffmpeg reports a file's streams on stderr and exits non-zero with no output. */
function inspect(file) {
  try {
    execFileSync(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['pipe', 'pipe', 'pipe'] });
    return '';
  } catch (error) {
    return String(error.stderr || '');
  }
}

function buildFixtures() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(MEDIA_DIR, { recursive: true });
  mkdirSync(DOWNLOADS, { recursive: true });
  const at = (name) => join(MEDIA_DIR, name);

  // Keyframes every second, so the HLS renditions split into several segments
  // rather than one — which is the case worth testing.
  ffmpeg([
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-keyint_min', '25', '-sc_threshold', '0',
    '-c:a', 'aac', '-shortest', at('clip.mp4'),
  ]);
  ffmpeg(['-i', at('clip.mp4'), '-vframes', '1', '-vf', 'scale=320:180', at('cover.jpg')]);
  // A song as a site would link it: the file is the link, whatever preset is set.
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=330:duration=3', '-c:a', 'libmp3lame', at('song.mp3')]);
  // Half an hour of sound, for a conversion long enough to be cancelled
  // part-way. One minute encoded and looped by copying: encoding thirty
  // would cost this suite more time than the check does.
  ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=60', '-c:a', 'aac', '-b:a', '32k', at('minute.m4a')]);
  ffmpeg(['-stream_loop', '29', '-i', at('minute.m4a'), '-c', 'copy', at('long.m4a')]);

  const rendition = (name, scale, prefix) =>
    ffmpeg([
      '-i', at('clip.mp4'),
      ...(scale ? ['-vf', `scale=${scale}`, '-c:v', 'libx264', '-g', '25', '-keyint_min', '25', '-sc_threshold', '0', '-c:a', 'aac'] : ['-c', 'copy']),
      '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', at(`${prefix}%d.ts`), at(name),
    ]);

  rendition('index.m3u8', null, 'seg');
  rendition('low.m3u8', '320:180', 'low');
  rendition('hi.m3u8', '1280:720', 'hi');
  // The audio-only rung Apple's authoring spec asks every ladder to carry.
  ffmpeg([
    '-i', at('clip.mp4'), '-vn', '-c:a', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', at('aud%d.ts'), at('aud.m3u8'),
  ]);

  writeFileSync(
    at('master.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180,CODECS="avc1.42c01e,mp4a.40.2"',
      'low.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"',
      'index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
      'hi.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=70000,CODECS="mp4a.40.2"',
      'aud.m3u8',
      '',
    ].join('\n'),
  );

  // An AES-128 rendition, so the WebCrypto decryption path is exercised too.
  writeFileSync(at('enc.key'), Buffer.from(crypto.getRandomValues(new Uint8Array(16))));
  writeFileSync(at('keyinfo'), `${MEDIA}/media/enc.key\n${at('enc.key')}\n`);
  ffmpeg([
    '-i', at('clip.mp4'), '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
    '-hls_key_info_file', at('keyinfo'), '-hls_segment_filename', at('encseg%d.ts'), at('enc.m3u8'),
  ]);

  writeFileSync(
    at('page.html'),
    `<!doctype html><html><head>
<meta property="og:title" content="A page that declares its video" />
<meta property="og:video:secure_url" content="${MEDIA}/media/clip.mp4" />
<meta property="og:image" content="${MEDIA}/media/cover.jpg" />
</head><body><p>hello</p></body></html>`,
  );
}

/* ---------------------------------------------------------------------- serving */

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.ts': 'video/mp2t', '.m3u8': 'application/vnd.apple.mpegurl',
  '.wasm': 'application/wasm', '.key': 'application/octet-stream', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
};

/** A static server that allows cross-origin reads, which is what the media host must do. */
/** How many times the flaky route has been asked for, and with what. */
const flaky = { asks: [], cut: false, downUntil: 0, refused: 0 };
/** How many times the slow route has been asked for its bytes. */
const slow = { gets: 0 };

function serve(root, port, prefix) {
  const server = createServer((request, response) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': '*',
      'Accept-Ranges': 'bytes',
    };
    if (request.method === 'OPTIONS') return response.writeHead(204, cors).end();

    let path = decodeURIComponent(new URL(request.url, 'http://x').pathname).replace(prefix, '');

    // A host that drops the connection halfway through, once, then serves
    // ranges properly — which is what a phone changing cells looks like.
    if (path.endsWith('/flaky.mp4')) {
      const source = join(root, '/media/clip.mp4');
      const size = statSync(source).size;
      const range = /^bytes=(\d+)-/.exec(request.headers.range || '');
      const from = range ? Number(range[1]) : 0;

      // The app probes with HEAD before downloading. Answering that with a cut
      // would spend the one break on the probe, and the download that follows
      // would sail through — proving nothing.
      if (request.method === 'HEAD') {
        return response.writeHead(200, { ...cors, 'Content-Type': 'video/mp4', 'Content-Length': size }).end();
      }
      flaky.asks.push({ range: request.headers.range || null });

      if (!flaky.cut) {
        // First time: promise the whole file, send a third of it, hang up.
        // The pause matters — destroying the socket in the same tick as the
        // write throws the bytes away with it, and then the client has nothing
        // to resume *from*, which is a different test entirely.
        flaky.cut = true;
        response.writeHead(200, { ...cors, 'Content-Type': 'video/mp4', 'Content-Length': size });
        const third = Math.floor(size / 3);
        response.write(readFileSync(source).subarray(0, third), () => {
          setTimeout(() => {
            response.destroy();
            flaky.downUntil = Date.now() + 800;
          }, 200);
        });
        return undefined;
      }
      // Then, for a moment, the network is still gone: every connection is
      // dropped before a byte of answer, which a browser reports with the
      // same TypeError as a CORS refusal. A moment rather than one request,
      // because Chromium quietly retries a request whose reused socket died.
      // This host has already answered the page, so it is the network, and
      // the resume has to carry on through it.
      if (Date.now() < flaky.downUntil) {
        flaky.refused += 1;
        request.socket.destroy();
        return undefined;
      }
      if (from > 0) {
        response.writeHead(206, {
          ...cors,
          'Content-Type': 'video/mp4',
          'Content-Length': size - from,
          'Content-Range': `bytes ${from}-${size - 1}/${size}`,
        });
      } else {
        response.writeHead(200, { ...cors, 'Content-Type': 'video/mp4', 'Content-Length': size });
      }
      return createReadStream(source, { start: from }).pipe(response);
    }

    // A download slow enough to be interrupted: 64 KB every 200 ms, 4 MB
    // unless `kb` says otherwise.
    if (path.endsWith('/slow.mp4')) {
      const size = (Number(new URL(request.url, 'http://x').searchParams.get('kb')) || 4096) * 1024;
      response.writeHead(200, { ...cors, 'Content-Type': 'video/mp4', 'Content-Length': size });
      if (request.method === 'HEAD') return response.end();
      slow.gets += 1;
      let sent = 0;
      const timer = setInterval(() => {
        if (response.destroyed || sent >= size) return clearInterval(timer);
        const next = Math.min(65536, size - sent);
        response.write(Buffer.alloc(next, 7));
        sent += next;
        if (sent >= size) response.end();
      }, 200);
      response.on('close', () => clearInterval(timer));
      return undefined;
    }

    const file = join(root, path);
    if (!file.startsWith(root)) return response.writeHead(403, cors).end();
    let stats;
    try {
      stats = statSync(file);
    } catch {
      return response.writeHead(404, cors).end();
    }
    if (stats.isDirectory()) return response.writeHead(404, cors).end();

    response.writeHead(200, {
      ...cors,
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Content-Length': stats.size,
    });
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/* ------------------------------------------------------------- a fake Invidious */

/** What the fake instance was asked, so a check can say what the app did. */
const invidious = { videos: [], playback: 0, captions: 0 };

/**
 * An Invidious instance, as far as this app can tell one apart: the stats
 * endpoint that names the software, the video endpoint that rewrites media
 * URLs through its own /videoplayback only when asked with `local=true`, the
 * captions endpoint serving WebVTT. The shapes are the real API's, down to
 * numbers as strings and paths relative to the instance; only the video is
 * ours. Without `local=true` a real instance answers googlevideo's own URLs,
 * which refuse a page — and so does this one.
 */
function serveInvidious(port) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': '*' };
  const json = (response, status, body) =>
    response.writeHead(status, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    if (request.method === 'OPTIONS') return response.writeHead(204, cors).end();

    if (url.pathname === '/api/v1/stats') {
      return json(response, 200, { version: '2.20260901.0', software: { name: 'invidious', version: '2.20260901.0', branch: 'master' } });
    }
    const video = /^\/api\/v1\/videos\/([\w-]+)$/.exec(url.pathname);
    if (video) {
      const local = url.searchParams.get('local') === 'true';
      invidious.videos.push({ id: video[1], local });
      // How videos.cr refuses: a status, and the reason as JSON beside it.
      if (video[1] === 'PRIVATEvid0') return json(response, 500, { error: 'This video is private' });
      const media = local ? '/videoplayback?expire=1&itag=18' : 'https://rr1---sn-example.googlevideo.com/videoplayback?itag=18';
      return json(response, 200, {
        title: 'A clip through Invidious', videoId: video[1], author: 'the fixture', lengthSeconds: 6, liveNow: false,
        videoThumbnails: [{ quality: 'medium', url: `/vi/${video[1]}/mqdefault.jpg`, width: 320, height: 180 }],
        formatStreams: [{ url: media, itag: '18', type: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', quality: 'medium', bitrate: '600000', container: 'mp4', encoding: 'h264', qualityLabel: '360p', resolution: '360p', size: '640x360', fps: 25 }],
        adaptiveFormats: [],
        captions: [{ label: 'English', language_code: 'en', url: `/api/v1/captions/${video[1]}?label=English` }],
      });
    }
    if (url.pathname.startsWith('/api/v1/captions/')) {
      invidious.captions += 1;
      return response.writeHead(200, { ...cors, 'Content-Type': 'text/vtt' })
        .end('WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nhello from invidious\n');
    }
    if (url.pathname.startsWith('/vi/')) {
      const cover = readFileSync(join(MEDIA_DIR, 'cover.jpg'));
      return response.writeHead(200, { ...cors, 'Content-Type': 'image/jpeg', 'Content-Length': cover.length }).end(cover);
    }
    if (url.pathname === '/videoplayback') {
      const source = join(MEDIA_DIR, 'clip.mp4');
      const size = statSync(source).size;
      const head = { ...cors, 'Content-Type': 'video/mp4', 'Content-Length': size, 'Accept-Ranges': 'bytes' };
      if (request.method === 'HEAD') return response.writeHead(200, head).end();
      invidious.playback += 1;
      response.writeHead(200, head);
      return createReadStream(source).pipe(response);
    }
    return json(response, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/* ----------------------------------------------------------------- a fake Piped */

/** What the fake Piped instance was asked. */
const piped = { streams: [], proxied: 0, captions: [] };

/**
 * A Piped instance, as far as this app can tell one apart: `/config` naming
 * an image proxy, `/streams/{id}` listing videoStreams and audioStreams with
 * every media URL rewritten through the instance's own proxy, which sends
 * CORS because Piped's own frontend is a separate origin. Shapes are the real
 * API's; only the video is ours.
 */
function servePiped(port) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': '*' };
  const json = (response, status, body) =>
    response.writeHead(status, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    if (request.method === 'OPTIONS') return response.writeHead(204, cors).end();
    if (url.pathname === '/config') {
      return json(response, 200, { imageProxyUrl: `${PIPED}/proxy`, donationUrl: null, statusPageUrl: null });
    }
    const streams = /^\/streams\/([\w-]+)$/.exec(url.pathname);
    if (streams) {
      piped.streams.push(streams[1]);
      const size = statSync(join(MEDIA_DIR, 'clip.mp4')).size;
      return json(response, 200, {
        title: 'A clip through Piped', uploader: 'the fixture', duration: 6, livestream: false,
        thumbnailUrl: `${PIPED}/proxy/cover.jpg?host=i.ytimg.com`,
        videoStreams: [{ url: `${PIPED}/proxy/clip.mp4?host=rr1---sn-example.googlevideo.com`, format: 'MPEG_4', quality: '360p', mimeType: 'video/mp4', codec: 'avc1.42001E', videoOnly: false, bitrate: 600000, contentLength: size, width: 640, height: 360, fps: 25 }],
        audioStreams: [],
        // As a real instance lists them: NewPipe's default format, TTML, on
        // YouTube's timedtext URL, proxied with the format in `fmt`.
        subtitles: [{
          url: `${PIPED}/api/timedtext?v=${streams[1]}&lang=en&fmt=ttml&host=www.youtube.com`,
          mimeType: 'application/ttml+xml', name: 'English', code: 'en', autoGenerated: false,
        }],
      });
    }
    if (url.pathname === '/api/timedtext') {
      // YouTube's timedtext answers in whichever format it is asked for.
      const format = url.searchParams.get('fmt');
      piped.captions.push(format);
      if (format === 'vtt') {
        return response.writeHead(200, { ...cors, 'Content-Type': 'text/vtt' })
          .end('WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nhello from piped\n');
      }
      return response.writeHead(200, { ...cors, 'Content-Type': 'application/ttml+xml' })
        .end('<?xml version="1.0" encoding="utf-8" ?><tt xml:lang="en" xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0s" end="3s">hello from piped</p></div></body></tt>');
    }
    if (url.pathname === '/proxy/cover.jpg') {
      const cover = readFileSync(join(MEDIA_DIR, 'cover.jpg'));
      return response.writeHead(200, { ...cors, 'Content-Type': 'image/jpeg', 'Content-Length': cover.length }).end(cover);
    }
    if (url.pathname === '/proxy/clip.mp4') {
      const source = join(MEDIA_DIR, 'clip.mp4');
      const size = statSync(source).size;
      const head = { ...cors, 'Content-Type': 'video/mp4', 'Content-Length': size, 'Accept-Ranges': 'bytes' };
      if (request.method === 'HEAD') return response.writeHead(200, head).end();
      piped.proxied += 1;
      response.writeHead(200, head);
      return createReadStream(source).pipe(response);
    }
    return json(response, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/* ---------------------------------------------------------------- a fake cobalt */

/**
 * What the fake cobalt instance was asked: every POST body, the tunnel reads,
 * and every request that carried a key or asked leave to send one.
 */
const cobalt = { asks: [], tunnel: 0, keyed: [] };

/**
 * A cobalt instance, as far as this app can tell one apart: its root is JSON
 * with a `cobalt` object, a POST of a link to that root answers a tunnel, and
 * the tunnel streams the finished file as an attachment — the shape of the
 * real API (v10), with our clip as the file.
 */
function serveCobalt(port) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
  const json = (response, status, body) =>
    response.writeHead(status, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    if (request.headers.authorization || /authorization/i.test(request.headers['access-control-request-headers'] || '')) {
      cobalt.keyed.push(`${request.method} ${url.pathname} ${request.headers.authorization || '(preflight)'}`);
    }
    if (request.method === 'OPTIONS') return response.writeHead(204, cors).end();
    if (url.pathname === '/' && request.method === 'GET') {
      return json(response, 200, { cobalt: { version: '11.0', url: COBALT, startTime: '1', durationLimit: 10800, services: ['youtube'] }, git: { commit: 'abc', branch: 'main' } });
    }
    if (url.pathname === '/' && request.method === 'POST') {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* not JSON */ }
        cobalt.asks.push(body);
        // cobalt's schema is strict: one value it does not list, and the
        // whole request is refused.
        const allowed = { downloadMode: ['auto', 'audio', 'mute'], audioFormat: ['best', 'mp3', 'ogg', 'wav', 'opus'], videoQuality: ['max', '4320', '2160', '1440', '1080', '720', '480', '360', '240', '144'] };
        if (Object.entries(body).some(([field, value]) => field !== 'url' && !allowed[field]?.includes(value))) {
          return json(response, 400, { status: 'error', error: { code: 'error.api.invalid_body' } });
        }
        if (String(body.url || '').includes('scriptURL01')) {
          return json(response, 200, { status: 'tunnel', url: 'javascript:window.__fromInstance=1;void 0', filename: 'x.mp4' });
        }
        json(response, 200, { status: 'tunnel', url: `${COBALT}/tunnel?id=1`, filename: 'A clip through cobalt.mp4' });
      });
      return undefined;
    }
    if (url.pathname === '/tunnel') {
      const source = join(MEDIA_DIR, 'clip.mp4');
      const size = statSync(source).size;
      cobalt.tunnel += 1;
      response.writeHead(200, { ...cors, 'Content-Type': 'video/mp4', 'Content-Length': size, 'Content-Disposition': 'attachment; filename="A clip through cobalt.mp4"' });
      return createReadStream(source).pipe(response);
    }
    return json(response, 404, { status: 'error', error: { code: 'error.api.generic' } });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/* ------------------------------------------------------- a fake siphon server */

const OWN_KEY = 'MY-AUTH-TOKEN';

/**
 * Your own server, started with AUTH_TOKEN, as far as the settings sheet can
 * tell: health answers everyone and says a key is wanted, and the gated
 * check takes only the right one. Nothing is downloaded through it here.
 */
function serveSiphon(port) {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' };
  const json = (response, status, body) =>
    response.writeHead(status, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    if (request.method === 'OPTIONS') return response.writeHead(204, cors).end();
    if (url.pathname === '/api/health') {
      return json(response, 200, { service: 'siphon', ytDlpVersion: '2026.09.01', ffmpeg: true, requiresKey: true, capabilities: ['jobs', 'resolve', 'tunnel'], lanUrls: [] });
    }
    if (request.headers.authorization !== `Bearer ${OWN_KEY}`) return json(response, 401, { detail: 'This server needs an access key.' });
    return json(response, 404, { detail: 'No such download.' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

/* ---------------------------------------------------------------------- checking */

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

/** The first subtitle track of a file, as SRT text: empty when it has no cues. */
function subtitleText(file) {
  try {
    return String(execFileSync(FFMPEG, ['-v', 'error', '-i', file, '-map', '0:s:0', '-f', 'srt', '-'], { stdio: ['pipe', 'pipe', 'pipe'] }));
  } catch {
    return '';
  }
}

const resolutionIn = (report) => (/\b(\d{3,4}x\d{3,4})\b/.exec(report) || [])[1] || '?';

/* ------------------------------------------------------------------------- run */

buildFixtures();
const servers = [await serve(WEB, APP_PORT, '/app'), await serve(WORK, MEDIA_PORT, ''), await serveInvidious(INV_PORT), await servePiped(PIPED_PORT), await serveCobalt(COBALT_PORT), await serveSiphon(OWN_PORT)];
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  // The cut-connection case deliberately breaks one response, and the browser
  // says so. That one resource is excused by URL; every other console error,
  // including any other failed load, still counts.
  const at = message.location()?.url || '';
  if (at.includes('/flaky.mp4') || at.includes('/slow.mp4')) return;
  // Working out what an address is means asking it things it is not: an
  // Invidious instance answers 404 to /api/health, / and /config before its
  // stats endpoint says what it is, and Chrome reports each miss here. Those
  // three, on that one origin, are the probe doing its job.
  if (/^http:\/\/127\.0\.0\.1:(8789|8792|8793)\/(api\/health|config)?$/.test(at) && /status of 404/.test(message.text())) return;
  // Your own server takes a key by answering its gated check "no such job".
  if (at === `${OWN}/api/jobs/key-check` && /status of 404/.test(message.text())) return;
  // Saving an empty helper asks this page's own origin whether a server
  // answers there, as a first visit does; a static host says no.
  if (at === `http://127.0.0.1:${APP_PORT}/api/health` && /status of 404/.test(message.text())) return;
  // The private video is refused with a 500 on purpose, as a real instance does.
  if (at.includes('/api/v1/videos/PRIVATEvid0') && /status of 500/.test(message.text())) return;
  consoleErrors.push(`${message.text()} <${at}>`);
});
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

// Whether the 32 MB converter was fetched is what the "costs nothing extra"
// claim rests on, so watch the wire rather than trusting the plan.
let coreRequests = 0;
page.on('request', (request) => request.url().startsWith(CORE_URL) && (coreRequests += 1));

// Everything the page asks for off this machine, other than the converter.
// A YouTube link carried by an instance must never make the page touch
// googlevideo or youtube.com itself — the whole point is that it cannot.
const CORE_DIR = CORE_URL.replace(/[^/]*$/, '');
const strangers = [];
page.on('request', (request) => {
  const url = request.url();
  if (/^(http:\/\/127\.0\.0\.1|blob:|data:)/.test(url) || url.startsWith(CORE_DIR)) return;
  strangers.push(url);
});

await page.addInitScript(
  (coreUrl) => {
    // With the vendored copy in place, coreUrl stays blank — the app's own
    // default is what is under test, not an override that happens to match.
    localStorage.setItem(
      'siphon:settings',
      JSON.stringify({ endpoint: '', key: '', helper: { kind: 'none', label: 'this device only' }, preset: 'video_best', subs: 'off', coreUrl }),
    );
    localStorage.setItem('siphon:install-dismissed', '1');
  },
  VENDORED && !process.env.SIPHON_CORE_URL ? '' : CORE_URL,
);

async function download(url, preset) {
  await page.goto(`http://127.0.0.1:${APP_PORT}/app/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('siphon:queue'));
  await page.reload({ waitUntil: 'networkidle' });

  // Pick the quality the way a user does, so the radio wiring is under test too.
  await page.check(`input[name="quality"][value="${preset}"]`);
  await page.fill('#url', url);
  const waiting = page.waitForEvent('download', { timeout: 180_000 });
  await page.click('#go');

  try {
    const event = await waiting;
    const saved = join(DOWNLOADS, event.suggestedFilename());
    await event.saveAs(saved);
    return saved;
  } catch (error) {
    const message = await page.textContent('.q-msg').catch(() => '');
    throw new Error(`no download for ${url}: ${message || error.message}`);
  }
}

const source = readFileSync(join(MEDIA_DIR, 'clip.mp4'));

/* Several links at once: a pasted list becomes one row each, in order, and
   every one of them lands. The text is the shape a share or a chat gives —
   words around the links, punctuation stuck to them. */
{
  await page.goto(`http://127.0.0.1:${APP_PORT}/app/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('siphon:queue'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.check('input[name="quality"][value="video_best"]');
  const landed = [];
  const collect = (event) => landed.push(event);
  page.on('download', collect);
  await page.evaluate(({ a, b }) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', `Two clips: ${a}, and ${b}.`);
    document.getElementById('url').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { a: `${MEDIA}/media/clip.mp4`, b: `${MEDIA}/media/page.html` });
  check('a pasted list says how many it queued', /2 links queued/.test((await page.textContent('#feedback')) || ''));
  check('and leaves the field empty for the next', (await page.inputValue('#url')) === '');
  await page.waitForFunction(() => document.querySelectorAll('#queueList li').length === 2, null, { timeout: 30_000 }).catch(() => {});
  const rows = await page.$$eval('#queueList li', (items) => items.length);
  check('two links, two rows', rows === 2, `${rows} rows`);
  const deadline = Date.now() + 180_000;
  while (landed.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  page.off('download', collect);
  check('and both files land', landed.length === 2, `${landed.length} downloads`);
  for (const [index, event] of landed.entries()) {
    const saved = join(DOWNLOADS, `many-${index}-${event.suggestedFilename()}`);
    await event.saveAs(saved);
    check(`file ${index + 1} of the list is byte-identical to the source`, Buffer.compare(source, readFileSync(saved)) === 0, event.suggestedFilename());
  }
}

/* More links than the queue keeps rows for: none of the downloads is cancelled
   to make room. Each link on its own host, so the browser's six connections
   per host do not hold the later ones back, and slow enough that the first
   are still running when the last is queued. */
{
  await page.goto(`http://127.0.0.1:${APP_PORT}/app/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('siphon:queue'));
  await page.reload({ waitUntil: 'networkidle' });
  const cut = [];
  const hosts = await Promise.all(Array.from({ length: 25 }, () => new Promise((resolve) => {
    const server = createServer((request, response) => {
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Expose-Headers': '*' };
      if (request.method === 'OPTIONS') return response.writeHead(204, cors).end();
      const size = 24 * 16384;
      response.writeHead(200, { ...cors, 'Content-Type': 'video/mp4', 'Content-Length': size });
      if (request.method === 'HEAD') return response.end();
      let sent = 0;
      const timer = setInterval(() => {
        response.write(Buffer.alloc(16384, 7));
        sent += 16384;
        if (sent >= size) {
          clearInterval(timer);
          response.end();
        }
      }, 250);
      response.on('close', () => {
        clearInterval(timer);
        if (!response.writableEnded) cut.push(request.url);
      });
      return undefined;
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  })));
  const links = hosts.map((server, i) => `http://127.0.0.1:${server.address().port}/file${String(i + 1).padStart(2, '0')}.mp4`);
  const landed = [];
  const collect = (event) => landed.push(event.suggestedFilename());
  page.on('download', collect);
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    document.getElementById('url').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, links.join('\n'));
  await page.waitForFunction(() => !document.querySelector('#queueList li .q-msg')?.textContent.includes('Starting'), null, { timeout: 30_000 }).catch(() => {});
  const rows = await page.$$eval('#queueList li .q-title', (titles) => titles.map((title) => title.textContent));
  check('25 links pasted are 25 rows, none dropped to keep the list short', rows.length === 25 && links.every((link) => rows.some((row) => link.endsWith(`${row}.mp4`) || row === link)),
    `${rows.length} rows, oldest ${rows.at(-1)}`);
  await page.waitForFunction(() => document.querySelectorAll('#queueList li a.q-act').length >= 25, null, { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(1000);
  page.off('download', collect);
  const finished = await page.locator('#queueList li a.q-act').count();
  check('and every one of them finishes, none cancelled to make room', finished === 25 && cut.length === 0,
    `${finished} finished, ${landed.length} handed over; cut off: ${cut.join(' ') || 'none'}`);
  for (const server of hosts) server.close();
}

/* The queue while settings change: a download on this device keeps going
   through a Save that changes nothing, and through a change of helper — the
   job it is has nothing to do with what the next one will use. */
{
  await page.goto(`http://127.0.0.1:${APP_PORT}/app/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('siphon:queue'));
  await page.reload({ waitUntil: 'networkidle' });
  slow.gets = 0;
  await page.fill('#url', `${MEDIA}/media/slow.mp4?kb=2048`);
  const waiting = page.waitForEvent('download', { timeout: 60_000 });
  await page.click('#go');
  await page.waitForFunction(() => /\d+%/.test(document.querySelector('#queueList li')?.textContent || ''), null, { timeout: 20_000 });

  await page.click('#openSettings');
  await page.click('#saveSettings');
  await page.waitForFunction(() => !document.getElementById('settings').open, null, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  const after = (await page.textContent('#queueList li')) || '';
  check('a Save that changes nothing leaves a running download running', /\d+%/.test(after) && !/interrupted/i.test(after), after.replace(/\s+/g, ' ').slice(0, 70));

  await page.click('#openSettings');
  await page.fill('#endpoint', COBALT);
  await page.click('#saveSettings');
  await page.waitForFunction(() => !document.getElementById('settings').open, null, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  const switched = (await page.textContent('#queueList li')) || '';
  check('and so does a change of helper', !/interrupted/i.test(switched), switched.replace(/\s+/g, ' ').slice(0, 70));
  const event = await waiting.catch(() => null);
  const saved = event ? join(DOWNLOADS, `kept-${event.suggestedFilename()}`) : '';
  if (event) await event.saveAs(saved);
  check('it finishes, and its file is whole', saved && statSync(saved).size === 2048 * 1024, saved ? `${statSync(saved).size} bytes` : 'no download');
  check('from the one request it started with', slow.gets === 1, `${slow.gets} requests for the file`);
}

/* A probe for a link already queued lands on nothing: the box stays empty,
   and the next link is not given its title. */
{
  await page.goto(`http://127.0.0.1:${APP_PORT}/app/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('siphon:queue'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.fill('#url', `${MEDIA}/media/page.html`);
  await page.click('#go');
  await page.waitForTimeout(1200);
  check('a link queued at once leaves no preview behind it', await page.evaluate(() => document.getElementById('preview').hidden),
    ((await page.textContent('#preview')) || '').replace(/\s+/g, ' ').slice(0, 60));
  const next = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  await page.fill('#url', next);
  await page.click('#go');
  await page.waitForSelector('.q-error', { timeout: 20_000 });
  const title = (await page.textContent('.q-error .q-title')) || '';
  check('and the next link keeps its own name, not the last one\'s title', title === next, title);
  // The first one's file, landed, so no later check takes it for its own.
  await page.waitForSelector('#queueList li a.q-act', { timeout: 20_000 });
  await page.waitForTimeout(500);
}

/* A progressive MP4 that already meets the preset: no conversion at all. */
{
  coreRequests = 0;
  const file = await download(`${MEDIA}/media/clip.mp4`, 'video_best');
  check('direct mp4 arrives byte-identical', Buffer.compare(source, readFileSync(file)) === 0, `${source.length} bytes`);
  check('direct mp4 keeps its name', file.endsWith('.mp4'));
  check('direct mp4 never loads the converter', coreRequests === 0, `${coreRequests} core requests`);
}

/* A direct audio file with the default video preset: the file is the link. */
{
  coreRequests = 0;
  const file = await download(`${MEDIA}/media/song.mp3`, 'video_best');
  const song = readFileSync(join(MEDIA_DIR, 'song.mp3'));
  check('a direct mp3 under "Best" arrives byte-identical, as an mp3', file.endsWith('.mp3') && Buffer.compare(song, readFileSync(file)) === 0, file.split('/').pop());
  check('and never loads the converter to rewrap it', coreRequests === 0, `${coreRequests} core requests`);
}

/* The same .mp3 with MP3 asked for: it already is one, so it is not encoded again. */
{
  coreRequests = 0;
  const file = await download(`${MEDIA}/media/song.mp3`, 'audio_mp3');
  const song = readFileSync(join(MEDIA_DIR, 'song.mp3'));
  check('a direct mp3 asked for as mp3 arrives byte-identical, not re-encoded', file.endsWith('.mp3') && Buffer.compare(song, readFileSync(file)) === 0, file.split('/').pop());
  check('and never loads the converter', coreRequests === 0, `${coreRequests} core requests`);
}

/* A connection that dies mid-download is resumed, not restarted. */
{
  const file = await download(`${MEDIA}/media/flaky.mp4`, 'video_best');
  check('a cut connection still produces the whole file', Buffer.compare(source, readFileSync(file)) === 0,
    `${readFileSync(file).length} of ${source.length} bytes`);
  const resumed = flaky.asks.filter((ask) => /^bytes=\d+-/.test(ask.range || ''));
  check('and it asked for the rest rather than starting over',
    resumed.length > 0 && resumed[0].range !== 'bytes=0-', JSON.stringify(flaky.asks.map((a) => a.range)));
  check('a reconnect that could not connect at all was tried again, not taken for a refusal', flaky.refused > 0 && resumed.length >= 2,
    JSON.stringify(flaky.asks.map((a) => a.range)));
}

/* An HLS ladder: pick a rendition, fetch its segments, remux to MP4. */
{
  const report = inspect(await download(`${MEDIA}/media/master.m3u8`, 'video_best'));
  check('hls remuxes to a playable mp4', /Video: h264/.test(report) && /Audio: aac/.test(report));
  check(VENDORED ? 'the converter came from the app\'s own origin, with nothing configured' : 'the converter came from where it was pointed',
    coreRequests > 0, `${coreRequests} request(s) to ${CORE_URL.replace(/^https?:\/\/[^/]+/, '')}`);
  check('hls output is an mp4 container', /Input #0, mov,mp4/.test(report));
  check('"Best" picks the top rendition', resolutionIn(report) === '1280x720', resolutionIn(report));
}

/* A preset is a ceiling: with 180/360/720 on offer, 480p means 360. */
{
  const report = inspect(await download(`${MEDIA}/media/master.m3u8`, 'video_480'));
  check('a capped preset takes the best rendition under it', resolutionIn(report) === '640x360', resolutionIn(report));
}

/* MP3 from a ladder: its audio-only rung, not the top video rung for its sound. */
{
  const segments = [];
  const record = (request) => /\.ts$/.test(request.url()) && segments.push(request.url().split('/').pop());
  page.on('request', record);
  const report = inspect(await download(`${MEDIA}/media/master.m3u8`, 'audio_mp3'));
  page.off('request', record);
  check('mp3 from an hls ladder is really mp3', /Audio: mp3/.test(report) && !/Video: h264/.test(report));
  check('and only the audio-only rendition was fetched for it',
    segments.length > 0 && segments.every((name) => /^aud\d+\.ts$/.test(name)), [...new Set(segments.map((name) => name.replace(/\d+\.ts$/, '')))].join(', '));
}

/* AES-128 encrypted HLS, decrypted in the page with WebCrypto. */
{
  const report = inspect(await download(`${MEDIA}/media/enc.m3u8`, 'video_best'));
  check('AES-128 hls is decrypted and remuxed', /Video: h264/.test(report));
}

/* Audio presets. */
{
  const report = inspect(await download(`${MEDIA}/media/clip.mp4`, 'audio_mp3'));
  check('mp3 is really mp3', /Audio: mp3/.test(report));
  check('mp3 has no video stream left', !/Video: h264/.test(report));
  check('mp3 carries a title tag', /title\s*:/.test(report));
}
{
  const report = inspect(await download(`${MEDIA}/media/clip.mp4`, 'audio_m4a'));
  check('m4a is aac in an mp4 container', /Audio: aac/.test(report) && /Input #0, mov,mp4/.test(report));
  check('m4a has no video stream left', !/Video: h264/.test(report));
}

/* Cancelling a conversion stops it: the next one does not wait for it to finish. */
{
  await page.goto(`http://127.0.0.1:${APP_PORT}/app/index.html`, { waitUntil: 'networkidle' });
  const timings = await page.evaluate(async ({ media, coreUrl }) => {
    const { BrowserBackend } = await import('./inbrowser.js');
    const converter = await import('./media.js');
    const backend = new BrowserBackend({ coreUrl });
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const finish = async (id) => {
      const started = performance.now();
      for (;;) {
        const state = await backend.poll(id);
        if (state.state !== 'running') return { state: state.state, error: state.error, ms: Math.round(performance.now() - started) };
        await sleep(25);
      }
    };
    await converter.ensureFfmpeg();
    const alone = await finish((await backend.start(`${media}/media/clip.mp4`, 'audio_mp3')).id);
    const long = await backend.start(`${media}/media/long.m4a`, 'audio_mp3');
    while ((await backend.poll(long.id)).stage !== 'processing') await sleep(25);
    await sleep(300);
    await backend.cancel(long.id);
    const stopped = !converter.isLoaded();
    const after = await finish((await backend.start(`${media}/media/clip.mp4`, 'audio_mp3')).id);
    return { alone, after, stopped };
  }, { media: MEDIA, coreUrl: VENDORED && !process.env.SIPHON_CORE_URL ? '' : CORE_URL });
  // The half hour left to encode takes several seconds even natively; the
  // short job alone takes a fraction of one. A fresh core costs a moment.
  const bound = 2 * timings.alone.ms + 3000;
  check('a conversion cancelled part-way does not hold up the next one',
    timings.after.state === 'done' && timings.after.ms < bound,
    `${timings.alone.ms} ms alone, ${timings.after.ms} ms after the cancel (under ${bound}); converter stopped: ${timings.stopped}`);
}

/* A plain HTML page whose markup declares its video — and its artwork. */
{
  const file = await download(`${MEDIA}/media/page.html`, 'video_best');
  check('a page\'s declared video is found and fetched', Buffer.compare(source, readFileSync(file)) === 0);
  check('the file is named after the page', /page|declares/i.test(file.split('/').pop()), file.split('/').pop());
}
{
  const report = inspect(await download(`${MEDIA}/media/page.html`, 'audio_mp3'));
  check('cover art is attached, not discarded', /Video: mjpeg/.test(report) && /attached pic/i.test(report));
  check('the page title becomes the tag', /title\s*:\s*A page/.test(report));
}

/* A host that refuses cross-origin reads fails with a sentence, not a stack trace. */
{
  await page.goto(`http://127.0.0.1:${APP_PORT}/app/index.html`, { waitUntil: 'networkidle' });
  await page.fill('#url', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await page.click('#go');
  await page.waitForSelector('.q-error', { timeout: 20_000 });
  const message = (await page.textContent('.q-error .q-msg')) || '';
  check('YouTube without a relay says why', /relay|cross-origin|web page/i.test(message), message.slice(0, 80));
  check('the failure is a sentence, not a stack trace', !/\bat \w+\./.test(message));
}

/* A finished row survives a reload, because the file is in OPFS. */
{
  await download(`${MEDIA}/media/clip.mp4`, 'video_best');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#queueList li', { timeout: 15_000 });
  await page.waitForTimeout(1500);
  const label = (await page.textContent('#queueList li .q-msg')) || '';
  const save = await page.locator('#queueList li a.q-act').count();
  check('a finished row comes back after a reload', save > 0 && !/no longer/i.test(label), label.slice(0, 60));
}

/* The Save button names the file — on a blob URL nothing else will. */
{
  await download(`${MEDIA}/media/clip.mp4`, 'video_best');
  const tapped = page.waitForEvent('download', { timeout: 15_000 });
  await page.click('#queueList li a.q-act');
  const first = (await tapped).suggestedFilename();
  check('tapping Save hands over the file under its name, not a UUID', first === 'clip.mp4', first);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#queueList li a.q-act', { timeout: 15_000 });
  const again = page.waitForEvent('download', { timeout: 15_000 });
  await page.click('#queueList li a.q-act');
  const second = (await again).suggestedFilename();
  check('and after a reload too, not a UUID ending in .txt', second === 'clip.mp4', second);

  const stored = () => page.evaluate(async () => {
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('downloads', { create: true });
    const names = [];
    for await (const [name] of folder.entries()) names.push(name);
    return names;
  });
  // The rows' own files, by job id: earlier checks' files are still there,
  // waiting for the sweep, because their rows were wiped by hand.
  const ids = await page.evaluate(() => JSON.parse(localStorage.getItem('siphon:queue') || '[]').map((entry) => entry.id).filter(Boolean));
  const before = (await stored()).filter((name) => ids.includes(name));
  await page.click('#queueClear');
  await page.waitForTimeout(500);
  const after = (await stored()).filter((name) => ids.includes(name));
  check('"Clear finished" lets go of the files, not just the rows', before.length > 0 && after.length === 0, `${before.length} → ${after.length} of the cleared rows' files in OPFS`);
}

/* A download cut off by a reload is not "Ready". */
{
  await page.goto(`http://127.0.0.1:${APP_PORT}/app/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('siphon:queue'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.fill('#url', `${MEDIA}/media/slow.mp4`);
  await page.click('#go');
  await page.waitForFunction(() => /\d+%/.test(document.querySelector('#queueList li')?.textContent || ''), null, { timeout: 20_000 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#queueList li', { timeout: 15_000 });
  await page.waitForTimeout(1500);
  const label = (await page.textContent('#queueList li .q-msg')) || '';
  const save = await page.locator('#queueList li a.q-act').count();
  const retry = await page.locator('#queueList li [data-retry]').count();
  check('a download interrupted by a reload does not come back as a finished file', save === 0 && !/ready/i.test(label), label.slice(0, 60));
  check('it says it was interrupted, and offers to try again', /interrupted/i.test(label) && retry === 1, label.slice(0, 60));
}

/* A row is changed in place as its download moves, never drawn again: a
   keyboard on Cancel is still there after a poll, a press held across one is
   still a press, and how a download ended is said to a screen reader. */
{
  await page.goto(`http://127.0.0.1:${APP_PORT}/app/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('siphon:queue'));
  await page.reload({ waitUntil: 'networkidle' });
  await page.fill('#url', `${MEDIA}/media/slow.mp4`);
  await page.click('#go');
  await page.waitForFunction(() => /\d+%/.test(document.querySelector('#queueList li')?.textContent || ''), null, { timeout: 20_000 });
  await page.evaluate(() => {
    window.__row = document.querySelector('#queueList li');
    window.__dropped = 0;
    new MutationObserver((records) => { window.__dropped += records.reduce((n, record) => n + record.removedNodes.length, 0); })
      .observe(document.getElementById('queueList'), { childList: true });
  });
  await page.focus('#queueList [data-cancel]');
  const before = (await page.textContent('#queueList li .q-pct')) || '';
  await page.waitForTimeout(2000);
  const held = await page.evaluate(() => ({
    focus: document.activeElement?.hasAttribute('data-cancel') ? 'Cancel' : document.activeElement?.tagName,
    same: document.querySelector('#queueList li') === window.__row,
    dropped: window.__dropped,
    pct: document.querySelector('#queueList li .q-pct')?.textContent || '',
  }));
  check('a keyboard on Cancel is still on it after a few polls', held.focus === 'Cancel', `focus on ${held.focus}`);
  check('the row moved on in place, not drawn again', held.same && held.dropped === 0 && held.pct !== before, `${before} → ${held.pct}, ${held.dropped} rows dropped`);

  // A deliberate tap, or a slow click: down and up either side of a poll.
  const box = await page.locator('#queueList [data-cancel]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.mouse.up();
  await page.waitForTimeout(400);
  const left = await page.locator('#queueList li').count();
  check('a press held across a poll still cancels', left === 0, `${left} rows left`);

  await download(`${MEDIA}/media/clip.mp4`, 'video_best');
  await page.waitForTimeout(500);
  // Read without waiting for it, so a page with no such region is a failed
  // check rather than a suite stuck on a selector.
  const said = () => page.evaluate(() => {
    const region = document.getElementById('queueStatus');
    return { text: region?.textContent || '', role: region?.getAttribute('role') || 'none' };
  });
  const ready = await said();
  check('a finished download is said, by name, to a screen reader', /^Ready: clip\.mp4/.test(ready.text) && ready.role === 'status', `${ready.role}: ${ready.text}`);
  await page.fill('#url', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await page.click('#go');
  await page.waitForSelector('.q-error', { timeout: 20_000 });
  await page.waitForTimeout(300);
  const failed = (await said()).text;
  check('and so is a failed one, with the reason', /^Failed: /.test(failed) && /relay|web page/i.test(failed), failed.slice(0, 90));
  check('and the settings sheet\'s verdict is announced too', (await page.getAttribute('#statusText', 'role')) === 'status');
}

/* An Invidious instance, given as the one address, carries YouTube for the device. */
{
  await page.goto(`http://127.0.0.1:${APP_PORT}/app/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('siphon:queue'));
  await page.reload({ waitUntil: 'networkidle' });
  strangers.length = 0;

  // Through the settings sheet, the way a person does it: type the address,
  // watch it be recognised, save. No reload afterwards — the init script
  // above would put the no-helper settings back.
  // Typed as a phone keyboard leaves it, with no scheme: probed at that
  // address, not as a path under this page.
  await page.click('#openSettings');
  const underPage = [];
  const watch = (request) => request.url().startsWith(`http://127.0.0.1:${APP_PORT}/app/127.0.0.1`) && underPage.push(request.url());
  page.on('request', watch);
  await page.fill('#endpoint', `127.0.0.1:${INV_PORT}`);
  await page.click('#testConnection');
  await page.waitForFunction(
    () => !/checking|not checked/i.test(document.getElementById('statusText').textContent || ''), null, { timeout: 15_000 });
  page.off('request', watch);
  const verdict = (await page.textContent('#statusText')) || '';
  check('an Invidious instance is recognised from its address alone', /An Invidious instance/.test(verdict), verdict.slice(0, 70));
  check('an address typed without http:// is given it, and never asked of this page\'s own host',
    (await page.inputValue('#endpoint')) === INV && underPage.length === 0, `${await page.inputValue('#endpoint')}; ${underPage.length} requests under the page`);
  await page.click('#saveSettings');
  await page.waitForFunction(() => !document.getElementById('settings').open, null, { timeout: 15_000 });
  const header = (await page.textContent('#backendLabel')) || '';
  check('and the header says so', /Invidious for YouTube/.test(header), header);
  const privacy = (await page.textContent('#privacyNote')) || '';
  check('and the privacy line names it', /Invidious instance/.test(privacy), privacy.slice(0, 80));

  const source = readFileSync(join(MEDIA_DIR, 'clip.mp4'));
  const take = async (url) => {
    await page.fill('#url', url);
    const waiting = page.waitForEvent('download', { timeout: 180_000 });
    await page.click('#go');
    const event = await waiting;
    const saved = join(DOWNLOADS, `invidious-${event.suggestedFilename()}`);
    await event.saveAs(saved);
    return { saved, name: event.suggestedFilename() };
  };

  // A YouTube link now. The device cannot read YouTube; the instance can.
  await page.check('input[name="quality"][value="video_best"]');
  const raw = await take('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  check('a YouTube link is resolved by the instance', invidious.videos.length >= 1, `${invidious.videos.length} asks`);
  check('and asked for local URLs, the only kind a page can fetch',
    invidious.videos.length > 0 && invidious.videos.every((ask) => ask.local), JSON.stringify(invidious.videos[0]));
  check("the file arrives through the instance's own proxy, byte-identical",
    invidious.playback >= 1 && Buffer.compare(source, readFileSync(raw.saved)) === 0, `${invidious.playback} playback asks, ${source.length} bytes`);
  check('named after the video, not the link', /clip through Invidious/i.test(raw.name), raw.name);

  // Once more with subtitles in the video: the instance's caption is fetched
  // and muxed in, so the raw hand-over becomes a copy through ffmpeg.
  await page.check('input[name="subs"][value="embed"]');
  const subbed = await take('https://youtu.be/jNQXAC9IVRw');
  const report = inspect(subbed.saved);
  check("the instance's caption track is fetched", invidious.captions === 1, `${invidious.captions} asks`);
  check('and embedded in the video, which keeps its picture and sound',
    /Subtitle: mov_text/.test(report) && /Video: h264/.test(report) && /Audio: aac/.test(report),
    (report.match(/Stream #0:\d[^\n]*/g) || []).map((line) => line.replace(/\s+/g, ' ').slice(0, 50)).join(' | '));
  check('the page itself never touched googlevideo or youtube.com', strangers.length === 0, strangers.slice(0, 2).join(' ; '));

  // A private video: the row has to say so in the instance's words, and no
  // other instance is asked, since none would answer differently.
  const asked = invidious.videos.length;
  await page.fill('#url', 'https://www.youtube.com/watch?v=PRIVATEvid0');
  await page.click('#go');
  await page.waitForSelector('.q-error', { timeout: 60_000 });
  const refusal = (await page.textContent('.q-error .q-msg')) || '';
  check('a private video is reported as private, not as instances that did not answer', /private/i.test(refusal), refusal.slice(0, 90));
  check('and it is asked of the instance once', invidious.videos.length - asked === 1, `${invidious.videos.length - asked} asks`);
}

/* A Piped instance, the same way: recognised from its address, YouTube through its proxy. */
{
  await page.goto(`http://127.0.0.1:${APP_PORT}/app/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('siphon:queue'));
  await page.reload({ waitUntil: 'networkidle' });
  strangers.length = 0;

  await page.click('#openSettings');
  await page.fill('#endpoint', PIPED);
  await page.click('#testConnection');
  await page.waitForFunction(
    () => /answers this page|does not answer|could not|not a siphon/i.test(document.getElementById('statusText').textContent || ''), null, { timeout: 15_000 });
  const verdict = (await page.textContent('#statusText')) || '';
  check('a Piped instance is recognised from its address alone', /A Piped instance/.test(verdict), verdict.slice(0, 70));
  check('and said to answer this page for a video, since this one does', /It answers this page for a video/.test(verdict), verdict.slice(0, 120));
  await page.click('#saveSettings');
  await page.waitForFunction(() => !document.getElementById('settings').open, null, { timeout: 15_000 });
  check('and the header says so', /Piped for YouTube/.test((await page.textContent('#backendLabel')) || ''), await page.textContent('#backendLabel'));

  await page.check('input[name="quality"][value="video_best"]');
  await page.fill('#url', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  const waiting = page.waitForEvent('download', { timeout: 180_000 });
  await page.click('#go');
  const event = await waiting;
  const saved = join(DOWNLOADS, `piped-${event.suggestedFilename()}`);
  await event.saveAs(saved);
  check('a YouTube link is resolved by the Piped instance', piped.streams.includes('dQw4w9WgXcQ'), piped.streams.join(','));
  check("the file arrives through the instance's proxy, byte-identical", piped.proxied >= 1 && Buffer.compare(source, readFileSync(saved)) === 0, `${piped.proxied} proxy reads`);
  check('named after the video', /clip through Piped/i.test(event.suggestedFilename()), event.suggestedFilename());

  // With subtitles in the video: Piped lists its captions as TTML, which
  // ffmpeg would take for an empty WebVTT file — a subtitle track that never
  // shows a word. They have to be asked for as WebVTT, and have their cue.
  await page.check('input[name="subs"][value="embed"]');
  await page.fill('#url', 'https://youtu.be/jNQXAC9IVRw');
  const subbedEvent = await Promise.all([page.waitForEvent('download', { timeout: 180_000 }), page.click('#go')]).then(([e]) => e);
  const subbed = join(DOWNLOADS, `piped-subs-${subbedEvent.suggestedFilename()}`);
  await subbedEvent.saveAs(subbed);
  check("Piped's TTML caption is asked for as WebVTT", piped.captions.includes('vtt') && !piped.captions.includes('ttml'), JSON.stringify(piped.captions));
  check('and the embedded track carries its words, not nothing', /hello from piped/.test(subtitleText(subbed)), subtitleText(subbed).replace(/\s+/g, ' ').slice(0, 60) || 'empty');
  check('the page itself never touched googlevideo or youtube.com', strangers.length === 0, strangers.slice(0, 2).join(' ; '));
}

/* A cobalt instance: asked for the finished file, which arrives as its own download. */
{
  await page.goto(`http://127.0.0.1:${APP_PORT}/app/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.removeItem('siphon:queue'));
  await page.reload({ waitUntil: 'networkidle' });
  strangers.length = 0;

  // Your own server first, saved with its key. The key field is a password
  // field, so a key left in it is invisible — and the instance typed in next
  // is someone else's.
  await page.click('#openSettings');
  await page.fill('#endpoint', OWN);
  await page.fill('#endpointKey', OWN_KEY);
  await page.click('#saveSettings');
  await page.waitForFunction(() => !document.getElementById('settings').open, null, { timeout: 15_000 });
  check('your own server is saved with its access key', /your server/.test((await page.textContent('#backendLabel')) || ''), await page.textContent('#backendLabel'));
  await page.click('#openSettings');
  const kept = await page.inputValue('#endpointKey');
  await page.fill('#endpoint', COBALT);
  check("typing another address lets go of the last server's key", kept === OWN_KEY && (await page.inputValue('#endpointKey')) === '', `${kept ? 'key shown on reopening' : 'no key on reopening'}, then ${JSON.stringify(await page.inputValue('#endpointKey'))}`);
  await page.fill('#endpoint', `${OWN}/`);
  const back = await page.inputValue('#endpointKey');
  await page.fill('#endpoint', COBALT);
  check('and typing your server back brings it back, for that server only', back === OWN_KEY && (await page.inputValue('#endpointKey')) === '', `${back ? 'back' : 'not back'}, then ${JSON.stringify(await page.inputValue('#endpointKey'))}`);

  await page.click('#testConnection');
  await page.waitForFunction(() => !/checking|not checked/i.test(document.getElementById('statusText').textContent || ''), null, { timeout: 15_000 });
  const verdict = (await page.textContent('#statusText')) || '';
  check('a cobalt instance is recognised from its address alone', /cobalt 11\.0 instance/.test(verdict), verdict.slice(0, 70));
  await page.click('#saveSettings');
  await page.waitForFunction(() => !document.getElementById('settings').open, null, { timeout: 15_000 });
  check('and the header names it', /cobalt 11\.0 for the rest/.test((await page.textContent('#backendLabel')) || ''), await page.textContent('#backendLabel'));

  // No navigation from here on: the init script above would put the
  // no-helper settings back on the next load.
  const take = async (url, preset) => {
    await page.check(`input[name="quality"][value="${preset}"]`);
    await page.fill('#url', url);
    const waiting = page.waitForEvent('download', { timeout: 60_000 });
    await page.click('#go');
    const event = await waiting;
    const saved = join(DOWNLOADS, `cobalt-${event.suggestedFilename()}`);
    await event.saveAs(saved);
    return { saved, name: event.suggestedFilename() };
  };

  // A direct file still stays on this device: the instance is only for what
  // the device cannot read itself.
  cobalt.asks.length = 0;
  const own = await take(`${MEDIA}/media/clip.mp4`, 'video_best');
  check('a direct file still downloads on this device, not through the instance', cobalt.asks.length === 0 && Buffer.compare(source, readFileSync(own.saved)) === 0, `${cobalt.asks.length} asks`);

  const got = await take('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'video_480');
  const saved = got.saved;
  const event = { suggestedFilename: () => got.name };
  const ask = cobalt.asks[0] || {};
  check('a YouTube link is sent to the instance with the quality asked for', ask.url === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' && ask.videoQuality === '480', JSON.stringify(ask));
  check("the finished file arrives from the instance's tunnel, byte-identical", cobalt.tunnel >= 1 && Buffer.compare(source, readFileSync(saved)) === 0, `${cobalt.tunnel} tunnel reads`);
  check('under the name the instance gave it', /clip through cobalt/i.test(event.suggestedFilename()), event.suggestedFilename());

  // Every quality the page offers has to be a request cobalt takes. It has
  // no "m4a": the M4A preset is its "best" audio, which for YouTube is AAC.
  cobalt.asks.length = 0;
  const m4a = await take('https://youtu.be/jNQXAC9IVRw', 'audio_m4a').catch((error) => ({ error }));
  check('M4A through the instance is a request it accepts', !m4a.error && cobalt.asks[0]?.audioFormat === 'best', JSON.stringify(cobalt.asks[0]));

  // An instance is someone else's server. What it hands back goes into a
  // link this page clicks by itself, so a script URL from it would run as
  // this page, settings, keys and all.
  await page.check('input[name="quality"][value="video_best"]');
  await page.fill('#url', 'https://www.youtube.com/watch?v=scriptURL01');
  await page.click('#go');
  // Settled either way — refused, or taken as a finished file — so the
  // check below reports what happened instead of timing out.
  await page.waitForFunction(() => [...document.querySelectorAll('#queueList li')].some((li) =>
    /scriptURL01/.test(li.textContent) && (li.classList.contains('q-error') || li.querySelector('a.q-act'))), null, { timeout: 20_000 });
  await page.waitForTimeout(300);
  const refused = (await page.textContent('#queueList li:first-child .q-msg')) || '';
  check("a cobalt answer that is not a download link is refused, not clicked", /not a download link/i.test(refused), refused.slice(0, 70));
  check('and nothing it sent ran in this page', (await page.evaluate(() => window.__fromInstance)) === undefined);
  check('the page itself never touched googlevideo or youtube.com', strangers.length === 0, strangers.slice(0, 2).join(' ; '));
  check('the instance never saw your server\'s key, not in a probe and not with a download', cobalt.keyed.length === 0, cobalt.keyed.slice(0, 3).join(' ; '));
}

check('no uncaught errors in the page', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' ; '));

await browser.close();
for (const server of servers) server.close();

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
