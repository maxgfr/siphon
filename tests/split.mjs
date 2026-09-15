/**
 * The split: a server that only knows *where* the file is, a device that fetches it.
 *
 * This is the shape cobalt found and the one this app now takes whenever the
 * server cannot do the whole job itself — no ffmpeg installed, or nothing but
 * `/api/resolve` and `/api/tunnel` exposed. The server runs yt-dlp and hands
 * back formats; the browser downloads them, merges them and converts them, and
 * for hosts that refuse a web page the bytes come back through the server's
 * tunnel rather than a whole download sitting on its disk.
 *
 * The server here is a stand-in for server/app.py — same endpoints, same
 * shapes, same auth — because what is under test is the *client* half: that
 * the page falls back to resolving, reads the formats, plans a download from
 * them, and pulls every byte through the tunnel. The Python half is covered by
 * server/tests/test_app.py.
 *
 * The media host sends no CORS headers, exactly like a real CDN, so nothing
 * here can succeed by accident.
 *
 *   npm run test:split
 *
 * Needs playwright and ffmpeg.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'web');
const WORK = join(HERE, '.split');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

const APP_PORT = 8801;
const SERVER_PORT = 8802;
const MEDIA_PORT = 8803;
const KEY = 's3cret';
const MEDIA = `http://127.0.0.1:${MEDIA_PORT}/media`;
const SERVER = `http://127.0.0.1:${SERVER_PORT}`;

rmSync(WORK, { recursive: true, force: true });
mkdirSync(join(WORK, 'media'), { recursive: true });
mkdirSync(join(WORK, 'downloads'), { recursive: true });

/* ---------------------------------------------------------------- fixtures */

const ffmpeg = (args) => execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: 'pipe' });
const at = (name) => join(WORK, 'media', name);

ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-shortest', at('muxed.mp4')]);
// A video-only and an audio-only file, which is what every adaptive site
// actually serves and what forces a merge in the page.
ffmpeg(['-i', at('muxed.mp4'), '-an', '-c:v', 'copy', at('video.mp4')]);
ffmpeg(['-i', at('muxed.mp4'), '-vn', '-c:a', 'copy', at('audio.m4a')]);
ffmpeg(['-i', at('muxed.mp4'), '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
  '-hls_segment_filename', at('seg%d.ts'), at('index.m3u8')]);
writeFileSync(at('cover.jpg'), execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', at('muxed.mp4'), '-frames:v', '1', '-f', 'mjpeg', '-'], { maxBuffer: 1 << 24 }));

/* ----------------------------------------------------------------- servers */

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.m4a': 'audio/mp4',
  '.ts': 'video/mp2t', '.m3u8': 'application/vnd.apple.mpegurl',
};

/** Every request the media host answered, and whether it came from a browser. */
const mediaHits = [];

function staticServer(root, port, { cors }) {
  return new Promise((resolve) => {
    createServer((request, response) => {
      let path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
      if (path === '/') path = '/index.html';
      if (root === WORK) mediaHits.push({ path, origin: request.headers.origin || null });
      const file = join(root, path);
      try {
        const stats = statSync(file);
        const headers = { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' };
        // The media host does NOT tell a page it may read this. That is the point.
        if (cors) headers['Access-Control-Allow-Origin'] = '*';

        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range || '');
        if (range) {
          const start = Number(range[1] || 0);
          const end = range[2] ? Number(range[2]) : stats.size - 1;
          response.writeHead(206, {
            ...headers,
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${stats.size}`,
            'Accept-Ranges': 'bytes',
          });
          return createReadStream(file, { start, end }).pipe(response);
        }
        response.writeHead(200, { ...headers, 'Content-Length': stats.size, 'Accept-Ranges': 'bytes' });
        createReadStream(file).pipe(response);
      } catch {
        response.writeHead(404, cors ? { 'Access-Control-Allow-Origin': '*' } : {}).end();
      }
    }).listen(port, '127.0.0.1', resolve);
  });
}

/**
 * server/app.py, in miniature: health, resolve, tunnel — and the same access
 * key on all three. No ffmpeg, so the page is told to do the work itself.
 */
const resolved = {
  '/watch/muxed': {
    title: 'One file, already merged',
    formats: [{ id: 'm', url: `${MEDIA}/muxed.mp4`, protocol: 'progressive', kind: 'muxed', container: 'mp4', height: 360, bitrate: 500000, label: '360p' }],
  },
  '/watch/split': {
    title: 'Two tracks, to be merged here',
    formats: [
      { id: 'v', url: `${MEDIA}/video.mp4`, protocol: 'progressive', kind: 'video', container: 'mp4', height: 360, bitrate: 400000, label: '360p' },
      { id: 'a', url: `${MEDIA}/audio.m4a`, protocol: 'progressive', kind: 'audio', container: 'm4a', bitrate: 128000, label: 'audio' },
    ],
  },
  '/watch/hls': {
    title: 'A ladder the server found',
    formats: [{ id: 'h', url: `${MEDIA}/index.m3u8`, protocol: 'hls', kind: 'muxed', container: 'ts', height: 360, label: '360p' }],
  },
};

const serverHits = { resolve: 0, tunnel: 0, jobs: 0 };

function api() {
  return new Promise((resolve) => {
    createServer(async (request, response) => {
      const url = new URL(request.url, 'http://x');
      const cors = {
        'Access-Control-Allow-Origin': request.headers.origin || '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        // Without this the page is handed the bytes and told nothing about them.
        'Access-Control-Expose-Headers': '*',
        Vary: 'Origin',
      };
      if (request.method === 'OPTIONS') return response.writeHead(204, cors).end();

      const bearer = request.headers.authorization === `Bearer ${KEY}` || url.searchParams.get('key') === KEY;
      const deny = (status, detail) => response.writeHead(status, { ...cors, 'Content-Type': 'application/json' })
        .end(JSON.stringify({ detail }));

      if (url.pathname === '/api/health') {
        if (!bearer) return deny(401, 'This server needs an access key.');
        return response.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({
          service: 'siphon', ytDlpVersion: '2026.09.01', ffmpeg: false,
          capabilities: ['resolve', 'tunnel'], requiresKey: true, hasCookies: false, lanUrls: [], presets: [],
        }));
      }

      if (url.pathname === '/api/resolve' && request.method === 'POST') {
        if (!bearer) return deny(401, 'This server needs an access key.');
        serverHits.resolve += 1;
        const body = JSON.parse(await new Promise((done) => {
          let text = '';
          request.on('data', (chunk) => { text += chunk; });
          request.on('end', () => done(text || '{}'));
        }));
        // The link is served from the media host's own tree, so match on the
        // tail rather than the whole path.
        const path = new URL(body.url, 'http://x').pathname;
        const found = resolved[Object.keys(resolved).find((key) => path.endsWith(key))];
        if (!found) return deny(400, 'yt-dlp does not recognise that link.');
        return response.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({
          id: path, url: body.url, title: found.title, uploader: 'The server', duration: 4,
          thumbnail: `${MEDIA}/cover.jpg`, extractor: 'Fake (server, default)', isLive: false, formats: found.formats,
        }));
      }

      if (url.pathname === '/api/tunnel') {
        if (!bearer) return deny(401, 'This server needs an access key.');
        const target = url.searchParams.get('url') || '';
        // The real one only carries hosts a resolve just named.
        if (!target.startsWith(MEDIA)) return deny(403, 'Not a host this server resolved.');
        serverHits.tunnel += 1;
        const upstream = await fetch(target, {
          headers: request.headers.range ? { Range: request.headers.range } : {},
        });
        const headers = { ...cors };
        for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
          const value = upstream.headers.get(name);
          if (value) headers[name] = value;
        }
        response.writeHead(upstream.status, headers);
        response.end(Buffer.from(await upstream.arrayBuffer()));
        return undefined;
      }

      if (url.pathname.startsWith('/api/jobs')) {
        serverHits.jobs += 1;
        return deny(404, 'This server does not run jobs.');
      }
      return response.writeHead(404, cors).end();
    }).listen(SERVER_PORT, '127.0.0.1', resolve);
  });
}

await staticServer(WEB, APP_PORT, { cors: true });
await staticServer(WORK, MEDIA_PORT, { cors: false });
await api();

/* ------------------------------------------------------------------ driver */

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const inspect = (file) => {
  try {
    execFileSync(FFMPEG, ['-hide_banner', '-i', file], { stdio: 'pipe' });
    return '';
  } catch (error) {
    return String(error.stderr || '');
  }
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 412, height: 915 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

await page.addInitScript(
  ([endpoint, key, coreUrl]) => {
    localStorage.setItem('siphon:settings', JSON.stringify({
      endpoint, key,
      helper: { kind: 'siphon', label: 'yt-dlp 2026.09.01', ffmpeg: false, capabilities: ['resolve', 'tunnel'] },
      preset: 'video_best', subs: 'off', coreUrl,
    }));
    localStorage.setItem('siphon:install-dismissed', '1');
  },
  [SERVER, KEY, process.env.SIPHON_CORE_URL || ''],
);

async function download(url, preset) {
  await page.goto(`http://127.0.0.1:${APP_PORT}/`, { waitUntil: 'networkidle' });
  await page.check(`input[name="quality"][value="${preset}"]`);
  await page.fill('#url', url);
  const waiting = page.waitForEvent('download', { timeout: 120_000 });
  await page.click('#go');
  try {
    const event = await waiting;
    const saved = join(WORK, 'downloads', event.suggestedFilename());
    await event.saveAs(saved);
    return { saved };
  } catch {
    return { error: ((await page.textContent('.q-msg').catch(() => '')) || '').trim() };
  }
}

/* --------------------------------------------------------------- the checks */

/* The header must say what this arrangement is, not pretend to be a full server. */
{
  await page.goto(`http://127.0.0.1:${APP_PORT}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const label = (await page.textContent('#backendLabel')) || '';
  check('the header says the server resolves and the device works', /your server resolves/i.test(label), label);
  const note = (await page.textContent('#privacyNote')) || '';
  check('and the privacy line says so too', /resolves/i.test(note), note.slice(0, 80));
}

/* A link the page cannot read at all: the server names the formats. */
{
  const before = { ...serverHits };
  await page.goto(`http://127.0.0.1:${APP_PORT}/`, { waitUntil: 'networkidle' });
  await page.fill('#url', `${MEDIA}/watch/muxed`);
  await page.waitForSelector('.preview-meta:not(.skeleton)', { timeout: 30_000 }).catch(() => {});
  const title = (await page.textContent('.preview-title').catch(() => '')) || '';
  const meta = (await page.textContent('.preview-meta').catch(() => '')) || '';
  check('a link this page cannot read is resolved by the server', /already merged/i.test(title), title.slice(0, 50));
  check('and the preview names who answered', /server/i.test(meta), meta.slice(0, 60));
  check('the resolve actually went to the server', serverHits.resolve > before.resolve, `${serverHits.resolve} resolves`);
}

/* The bytes come back through the tunnel, and arrive intact. */
{
  const before = { ...serverHits };
  const r = await download(`${MEDIA}/watch/muxed`, 'video_best');
  const same = Boolean(r.saved) && Buffer.compare(readFileSync(r.saved), readFileSync(at('muxed.mp4'))) === 0;
  check('an already-merged file arrives byte-identical through the tunnel', same, r.error || r.saved?.split('/').pop());
  check('and every byte went through the tunnel', serverHits.tunnel > before.tunnel, `${serverHits.tunnel - before.tunnel} tunnelled`);
  check('the server was never asked to run the download itself', serverHits.jobs === 0, `${serverHits.jobs} job requests`);
}

/* Two tracks: fetched separately, merged here, by ffmpeg.wasm. */
{
  const r = await download(`${MEDIA}/watch/split`, 'video_best');
  const report = r.saved ? inspect(r.saved) : '';
  check('a video-only and an audio-only track are merged on this device',
    /Video: h264/.test(report) && /Audio: aac/.test(report), r.error || (/\d{3,4}x\d{3,4}/.exec(report) || [])[0]);
}

/* An HLS ladder the server found, fetched segment by segment through the tunnel. */
{
  const r = await download(`${MEDIA}/watch/hls`, 'video_best');
  const report = r.saved ? inspect(r.saved) : '';
  check('an HLS ladder is fetched segment by segment and remuxed',
    /Video: h264/.test(report) && /Audio: aac/.test(report), r.error || (/\d{3,4}x\d{3,4}/.exec(report) || [])[0]);
}

/* Converting is the device's job too, cover art and all. */
{
  const r = await download(`${MEDIA}/watch/muxed`, 'audio_mp3');
  const report = r.saved ? inspect(r.saved) : '';
  check('audio is extracted and converted on this device', /Audio: mp3/.test(report), r.error || r.saved?.split('/').pop());
  check('with the title the server reported', /One file, already merged/.test(report), (/title\s*:\s*(.+)/i.exec(report) || [])[1] || '');
}

/* No media byte was ever handed to the page directly. */
{
  // The device tries the link itself first — that is the design, and those
  // attempts are refused by the browser. What must never happen is a *media
  // file* being served to the page's own origin: that is the tunnel's job.
  const isMedia = (path) => /\.(mp4|m4a|ts|m3u8|jpg)$/.test(path);
  const direct = mediaHits.filter((hit) => hit.origin && hit.origin.includes(String(APP_PORT)) && isMedia(hit.path));
  const tunnelled = mediaHits.filter((hit) => !hit.origin && isMedia(hit.path));
  check('no media file was served to the page itself', direct.length === 0, `${direct.length} direct`);
  check('every one of them came through the tunnel', tunnelled.length > 0, `${tunnelled.length} files`);
}

/* The key is not optional. The page carrying it is what made everything above work. */
{
  const refused = await fetch(`${SERVER}/api/tunnel?url=${encodeURIComponent(`${MEDIA}/muxed.mp4`)}`);
  check('the tunnel refuses a request with no key', refused.status === 401, String(refused.status));
  const wrongHost = await fetch(`${SERVER}/api/tunnel?url=${encodeURIComponent('http://evil.example/x')}&key=${KEY}`);
  check('and refuses a host it never resolved', wrongHost.status === 403, String(wrongHost.status));
}

check('no uncaught errors in the page', errors.length === 0, errors.slice(0, 2).join(' ; '));

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
