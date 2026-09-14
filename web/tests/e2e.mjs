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
import { createReadStream, readFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..');
const WORK = join(HERE, '.e2e');
const MEDIA_DIR = join(WORK, 'media');
const DOWNLOADS = join(WORK, 'downloads');

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const CORE_URL = process.env.SIPHON_CORE_URL || 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/ffmpeg-core.js';
const APP_PORT = 8787;
const MEDIA_PORT = 8788;
const MEDIA = `http://127.0.0.1:${MEDIA_PORT}`;

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
  '.wasm': 'application/wasm', '.key': 'application/octet-stream',
};

/** A static server that allows cross-origin reads, which is what the media host must do. */
function serve(root, port, prefix) {
  const server = createServer((request, response) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': '*',
      'Accept-Ranges': 'bytes',
    };
    if (request.method === 'OPTIONS') return response.writeHead(204, cors).end();

    const path = decodeURIComponent(new URL(request.url, 'http://x').pathname).replace(prefix, '');
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

/* ---------------------------------------------------------------------- checking */

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const resolutionIn = (report) => (/\b(\d{3,4}x\d{3,4})\b/.exec(report) || [])[1] || '?';

/* ------------------------------------------------------------------------- run */

buildFixtures();
const servers = [await serve(WEB, APP_PORT, '/app'), await serve(WORK, MEDIA_PORT, '')];
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));

// Whether the 32 MB converter was fetched is what the "costs nothing extra"
// claim rests on, so watch the wire rather than trusting the plan.
let coreRequests = 0;
page.on('request', (request) => request.url().startsWith(CORE_URL) && (coreRequests += 1));

await page.addInitScript(
  (coreUrl) => {
    localStorage.setItem(
      'siphon:settings',
      JSON.stringify({ mode: 'browser', preset: 'video_best', subs: 'off', relayUrl: '', coreUrl }),
    );
    localStorage.setItem('siphon:install-dismissed', '1');
  },
  CORE_URL,
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

/* A progressive MP4 that already meets the preset: no conversion at all. */
{
  coreRequests = 0;
  const file = await download(`${MEDIA}/media/clip.mp4`, 'video_best');
  check('direct mp4 arrives byte-identical', Buffer.compare(source, readFileSync(file)) === 0, `${source.length} bytes`);
  check('direct mp4 keeps its name', file.endsWith('.mp4'));
  check('direct mp4 never loads the converter', coreRequests === 0, `${coreRequests} core requests`);
}

/* An HLS ladder: pick a rendition, fetch its segments, remux to MP4. */
{
  const report = inspect(await download(`${MEDIA}/media/master.m3u8`, 'video_best'));
  check('hls remuxes to a playable mp4', /Video: h264/.test(report) && /Audio: aac/.test(report));
  check('hls output is an mp4 container', /Input #0, mov,mp4/.test(report));
  check('"Best" picks the top rendition', resolutionIn(report) === '1280x720', resolutionIn(report));
}

/* A preset is a ceiling: with 180/360/720 on offer, 480p means 360. */
{
  const report = inspect(await download(`${MEDIA}/media/master.m3u8`, 'video_480'));
  check('a capped preset takes the best rendition under it', resolutionIn(report) === '640x360', resolutionIn(report));
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

check('no uncaught errors in the page', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' ; '));

await browser.close();
for (const server of servers) server.close();

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
