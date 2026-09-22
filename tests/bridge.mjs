/**
 * The bridge, against a host that refuses the page.
 *
 * The media server here sends no CORS headers on purpose, so a plain fetch from
 * the app's origin fails exactly as it does against YouTube. What makes the
 * download succeed is the bridge: bridge/siphon-bridge.user.js, whose
 * GM_xmlhttpRequest is played here by a Node fetch exposed into the page —
 * Node has no same-origin policy, which is precisely what a userscript
 * manager's privileged request has not. The userscript's own code is
 * injected verbatim, so the protocol under test is the shipped one.
 *
 *   npm run test:bridge
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
const USERSCRIPT = readFileSync(join(HERE, '..', 'bridge', 'siphon-bridge.user.js'), 'utf8');
const WORK = join(HERE, '.bridge');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const APP_PORT = 8795;
const MEDIA_PORT = 8796;
// The media host has a public-looking name, not 127.0.0.1: the bridge will
// not fetch from this machine or this network, so a loopback address here
// would be refused for the right reason and prove nothing. Chromium is told
// the name is 127.0.0.1, and so is the stand-in for GM_xmlhttpRequest.
const MEDIA_HOST = 'media.bridge.test';

rmSync(WORK, { recursive: true, force: true });
mkdirSync(join(WORK, 'media'), { recursive: true });
mkdirSync(join(WORK, 'downloads'), { recursive: true });

const ffmpeg = (args) => execFileSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: 'pipe' });
const at = (name) => join(WORK, 'media', name);
ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-shortest', at('clip.mp4')]);
ffmpeg(['-i', at('clip.mp4'), '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', at('seg%d.ts'), at('index.m3u8')]);
writeFileSync(at('page.html'), `<!doctype html><html><head><meta property="og:title" content="Refusing host page" />
<meta property="og:video" content="http://${MEDIA_HOST}:${MEDIA_PORT}/media/clip.mp4" /></head><body>video</body></html>`);

/* ------------------------------------------------------------------ servers */

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.mp4': 'video/mp4', '.ts': 'video/mp2t', '.m3u8': 'application/vnd.apple.mpegurl' };

function serve(root, port, { cors }) {
  return new Promise((resolve) => {
    createServer((request, response) => {
      let path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
      if (path === '/') path = '/index.html';
      // Answers with no body at all, which a Response refuses to carry one for.
      const status = /\/status\/(\d{3})$/.exec(path);
      if (status) return response.writeHead(Number(status[1])).end();
      const file = join(root, path);
      try {
        const stats = statSync(file);
        const headers = { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Length': stats.size };
        // The whole point: this host does NOT say the page may read it.
        if (cors) headers['Access-Control-Allow-Origin'] = '*';
        response.writeHead(200, headers);
        createReadStream(file).pipe(response);
      } catch {
        response.writeHead(404).end();
      }
    }).listen(port, '127.0.0.1', resolve);
  });
}
await serve(WEB, APP_PORT, { cors: true });
await serve(WORK, MEDIA_PORT, { cors: false });

/* ------------------------------------------------------------------- driver */

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const inspect = (file) => {
  try { execFileSync(FFMPEG, ['-hide_banner', '-i', file], { stdio: 'pipe' }); return ''; } catch (e) { return String(e.stderr || ''); }
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: [`--host-resolver-rules=MAP ${MEDIA_HOST} 127.0.0.1`],
});

/** Every URL the stand-in for GM_xmlhttpRequest was actually asked to fetch. */
const gmAsked = [];

async function session({ bridge }) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 412, height: 915 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.addInitScript((coreUrl) => {
    localStorage.setItem('siphon:settings', JSON.stringify({ endpoint: '', key: '', helper: { kind: 'none', label: 'this device only' }, preset: 'video_best', subs: 'off', coreUrl }));
    localStorage.setItem('siphon:install-dismissed', '1');
  }, process.env.SIPHON_CORE_URL || '');

  if (bridge) {
    // GM_xmlhttpRequest, played by Node: no same-origin policy, like the real thing.
    await page.exposeFunction('__gmFetch', async (method, url, headers, body) => {
      gmAsked.push(url);
      const target = url.replace(`//${MEDIA_HOST}:`, '//127.0.0.1:');
      const response = await fetch(target, { method, headers, body: body ? Buffer.from(body, 'base64') : undefined });
      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        status: response.status,
        statusText: response.statusText,
        responseHeaders: [...response.headers].map(([k, v]) => `${k}: ${v}`).join('\r\n'),
        body: buffer.toString('base64'),
      };
    });
    await page.addInitScript(() => {
      // The shape GM_xmlhttpRequest has; the userscript below sees only this.
      window.GM_xmlhttpRequest = (options) => {
        // Some managers report a failed request as a load with status 0.
        if (/\/status\/0$/.test(options.url)) {
          return options.onload?.({ status: 0, statusText: '', responseHeaders: '', response: new ArrayBuffer(0) });
        }
        const body = options.data ? btoa(String.fromCharCode(...new Uint8Array(options.data))) : null;
        window.__gmFetch(options.method || 'GET', options.url, options.headers || {}, body)
          .then((r) => {
            const bin = atob(r.body);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
            options.onload?.({ status: r.status, statusText: r.statusText, responseHeaders: r.responseHeaders, response: bytes.buffer });
          })
          .catch((error) => options.onerror?.({ error: String(error?.message || error) }));
      };
    });
    await page.addInitScript(USERSCRIPT);
  }
  return { context, page, errors };
}

async function download(page, url, preset) {
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

const MEDIA = `http://${MEDIA_HOST}:${MEDIA_PORT}/media`;

/* Without the bridge, the refusing host is exactly that. */
{
  const { context, page } = await session({ bridge: false });
  const r = await download(page, `${MEDIA}/clip.mp4`, 'video_best');
  check('without the bridge, a host with no CORS headers refuses the page', Boolean(r.error) && /does not let a web page|relay/i.test(r.error), r.error?.slice(0, 90));
  const status = await page.evaluate(async () => {
    const { BrowserBackend } = await import('./api.js');
    const backend = new BrowserBackend({});
    await new Promise((r) => setTimeout(r, 200));
    return backend.health();
  });
  check('and no bridge announced itself', status.bridge === false, JSON.stringify({ bridge: status.bridge }));
  await context.close();
}

/* With it, every existing extractor works on that same host. */
{
  const { context, page, errors } = await session({ bridge: true });

  await page.goto(`http://127.0.0.1:${APP_PORT}/`, { waitUntil: 'networkidle' });
  const status = await page.evaluate(async () => {
    const { BrowserBackend } = await import('./api.js');
    const backend = new BrowserBackend({});
    await new Promise((r) => setTimeout(r, 200));
    return backend.health();
  });
  check('the page detects the bridge through the handshake', status.bridge === true, JSON.stringify({ bridge: status.bridge, relay: status.relay }));

  const direct = await download(page, `${MEDIA}/clip.mp4`, 'video_best');
  check('a direct file on a refusing host arrives through the bridge, byte-identical',
    Boolean(direct.saved) && Buffer.compare(readFileSync(direct.saved), readFileSync(at('clip.mp4'))) === 0, direct.error || direct.saved?.split('/').pop());

  const hls = await download(page, `${MEDIA}/index.m3u8`, 'video_best');
  const report = hls.saved ? inspect(hls.saved) : '';
  check('an HLS ladder on a refusing host is fetched segment by segment and remuxed', /Video: h264/.test(report) && /Audio: aac/.test(report), hls.error || (/\d{3,4}x\d{3,4}/.exec(report) || [])[0]);

  const page_ = await download(page, `${MEDIA}/page.html`, 'audio_mp3');
  const audio = page_.saved ? inspect(page_.saved) : '';
  check('a page on a refusing host is scraped and its video converted to mp3', /Audio: mp3/.test(audio), page_.error || page_.saved?.split('/').pop());

  const routes = await page.evaluate(async (media) => {
    const { BrowserBackend } = await import('./api.js');
    const backend = new BrowserBackend({});
    await new Promise((r) => setTimeout(r, 200));
    try { await backend.net.bytes(`${media}/clip.mp4`); } catch {}
    return Object.fromEntries(backend.net.verdicts);
  }, MEDIA);
  check('the route is remembered per origin, so the refusal is discovered once', Object.values(routes).includes('bridge'), JSON.stringify(routes));

  // @match cannot tell siphon from whatever else runs on localhost:8000, so
  // what the bridge will fetch is narrowed instead: public http(s) hosts, and
  // GET, HEAD or POST. Each of these is asked for as any script on the page
  // could, and must come back refused without the manager being asked at all.
  const refusals = [
    ['http://127.0.0.1:8796/media/clip.mp4'], ['http://localhost:8796/'], ['http://2130706433:8796/'],
    ['http://169.254.169.254/latest/meta-data/'], ['http://10.0.0.1/'], ['http://172.16.0.1/'], ['http://192.168.1.1/'],
    ['http://100.64.0.1/'], ['http://[::1]:8796/'], ['http://[fe80::1]/'], ['http://[fd00::1]/'], ['http://[::ffff:127.0.0.1]/'],
    ['http://router/'], ['http://nas.local/'], ['http://dev.localhost/'], ['file:///etc/passwd'], ['data:text/plain,hi'],
    [`${MEDIA}/clip.mp4`, 'PUT'], [`${MEDIA}/clip.mp4`, 'DELETE'],
  ];
  const asked = gmAsked.length;
  const answers = await page.evaluate(async ({ refusals, allowed }) => {
    const ask = (url, method = 'GET') => new Promise((resolve) => {
      const id = `guard-${Math.random()}`;
      const listen = (event) => {
        if (event.source !== window || event.data?.id !== id || !['response', 'error'].includes(event.data.siphon)) return;
        window.removeEventListener('message', listen);
        resolve(event.data.siphon === 'response' ? `answered ${event.data.status}` : 'refused');
      };
      window.addEventListener('message', listen);
      window.postMessage({ siphon: 'fetch', id, url, method }, '*');
      setTimeout(() => resolve('silent'), 5000);
    });
    return {
      refused: await Promise.all(refusals.map(([url, method]) => ask(url, method).then((answer) => `${method || 'GET'} ${url}: ${answer}`))),
      allowed: await ask(allowed, 'HEAD'),
    };
  }, { refusals, allowed: `${MEDIA}/clip.mp4` });
  const through = answers.refused.filter((line) => !line.endsWith(': refused'));
  check('the bridge refuses this machine, the local network, other schemes and other methods', through.length === 0, through.slice(0, 3).join(' ; ') || `${refusals.length} refused`);
  check('without the userscript manager ever being asked for them', gmAsked.length - asked === 1, gmAsked.slice(asked).join(', '));
  check('and still fetches a public host', answers.allowed === 'answered 200', answers.allowed);

  // A response with no body by definition — 204, 304 — or a status a
  // Response will not hold at all used to throw inside the page's listener,
  // leaving the request waiting forever.
  const settled = await page.evaluate(async (media) => {
    const { BrowserBackend } = await import('./api.js');
    const backend = new BrowserBackend({});
    await new Promise((r) => setTimeout(r, 200));
    const within = (promise) => Promise.race([
      promise.then((response) => `status ${response.status}`, (error) => `refused: ${error.message}`),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 5000)),
    ]);
    return Promise.all(['204', '304', '0'].map((code) => within(backend.net.bridge.request(`${media}/status/${code}`))));
  }, MEDIA);
  check('a 204 or a 304 through the bridge is an answer, not a hang', settled[0] === 'status 204' && settled[1] === 'status 304', settled.slice(0, 2).join(' ; '));
  check('and a status no Response can hold is a failure the caller hears about', /^refused: .*status 0/.test(settled[2]), settled[2]);

  check('no uncaught errors in the page', errors.length === 0, errors.slice(0, 2).join(' ; '));
  await context.close();
}

await browser.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
