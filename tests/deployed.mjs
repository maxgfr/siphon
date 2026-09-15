/**
 * The app as it is actually deployed, which is not how the other tests run it.
 *
 * Two things only happen on a real static host, and neither was covered until
 * a deployed site turned out to look broken on arrival:
 *
 *   - **HTTPS.** app.js registers the service worker only on https:, so every
 *     plain-HTTP test runs with no worker at all. The worker is what a
 *     returning visitor is actually served by.
 *   - **No API behind the page.** GitHub Pages answers 404 for /api/health.
 *     A first visit has to cope with that, not present a dead end.
 *
 * So this serves web/ over HTTPS under a /siphon/ subpath — a project page,
 * not a user page — and drives Chromium through both.
 *
 *   npm run test:deployed
 *
 * Needs playwright and openssl (for a throwaway certificate).
 */
import { chromium } from 'playwright';
import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', 'web');
const WORK = join(HERE, '.deployed');
const PORT = 8443;
const BASE = `https://127.0.0.1:${PORT}`;
const APP = `${BASE}/siphon/`;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(WORK, 'key.pem'), '-out', join(WORK, 'cert.pem'),
    '-days', '1', '-subj', '/CN=localhost',
  ], { stdio: 'pipe' });
} catch {
  console.log('skipped: openssl is needed for a throwaway certificate');
  process.exit(0);
}

/**
 * A stand-in for whatever was deployed last time.
 *
 * Synthesised rather than taken from git history, so the test says something
 * about the takeover mechanics rather than about one particular old commit.
 */
const PREVIOUS = join(WORK, 'previous');
mkdirSync(PREVIOUS, { recursive: true });
writeFileSync(join(PREVIOUS, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><title>siphon</title></head>
<body><p id="old-build">the previous deploy</p><script type="module" src="./app.js"></script></body></html>`);
writeFileSync(join(PREVIOUS, 'app.js'),
  `if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js');\n`);
writeFileSync(join(PREVIOUS, 'sw.js'), `const CACHE = 'siphon-v1';
self.addEventListener('install', (e) => e.waitUntil(
  caches.open(CACHE).then((c) => c.addAll(['./', './index.html', './app.js'])).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request).then((h) => h || caches.match('./index.html'))));
});`);

/* ---------------------------------------------------------------------- host */

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

let root = WEB;
let hasApi = false;

const server = createServer(
  { key: readFileSync(join(WORK, 'key.pem')), cert: readFileSync(join(WORK, 'cert.pem')) },
  (request, response) => {
    const url = new URL(request.url, 'https://x');
    let path = decodeURIComponent(url.pathname);

    // Control channels, so one browser can be walked through a deploy.
    if (path === '/__serve') {
      root = url.searchParams.get('build') === 'previous' ? PREVIOUS : WEB;
      return response.writeHead(200).end(root);
    }
    if (path === '/__api') {
      hasApi = url.searchParams.get('on') === '1';
      return response.writeHead(200).end(String(hasApi));
    }

    // The one endpoint that tells a container apart from a static host.
    if (path === '/api/health') {
      if (!hasApi) return response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return response.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ ytDlpVersion: '2026.08.19', ffmpeg: true, presets: [] }));
    }

    if (!path.startsWith('/siphon/')) return response.writeHead(404).end('not found');
    path = path.slice('/siphon'.length);
    if (path.endsWith('/')) path += 'index.html';

    const file = join(root, path);
    if (!file.startsWith(root)) return response.writeHead(403).end();
    try {
      const stats = statSync(file);
      if (stats.isDirectory()) throw new Error('directory');
      response.writeHead(200, {
        'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
        'Content-Length': stats.size,
        'Cache-Control': 'no-cache',
      });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  },
);
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const serve = (build) => fetch(`${BASE}/__serve?build=${build}`).then((r) => r.text());
const setApi = (on) => fetch(`${BASE}/__api?on=${on ? 1 : 0}`).then((r) => r.text());

/* -------------------------------------------------------------------- checks */

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || undefined,
  args: ['--ignore-certificate-errors'],
});

async function fresh() {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 412, height: 915 } });
  const page = await context.newPage();
  page.on('pageerror', (error) => context.__errors.push(error.message));
  context.__errors = [];
  return { context, page };
}

/* 1. A first visit to a static host must land somewhere that works. */
{
  await serve('current');
  const { context, page } = await fresh();
  await setApi(false);
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('siphon:settings') || '{}'));
  const label = (await page.textContent('#backendLabel')) || '';
  const notice = (await page.textContent('#feedback')) || '';

  check('a static host puts a new visitor in browser mode', saved.mode === 'browser', saved.mode);
  check('the header says it is ready, not broken', /in this browser/i.test(label), label);
  check('no "no server set up yet" dead end', !/no server set up/i.test(notice), notice.replace(/\s+/g, ' ').trim().slice(0, 60) || '(empty)');
  check('no uncaught errors on a first visit', context.__errors.length === 0, context.__errors.join(' ; '));
  await context.close();
}

/* 2. The container serving both halves must keep working with no configuration. */
{
  const { context, page } = await fresh();
  await setApi(true);
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('siphon:settings') || '{}'));
  const label = (await page.textContent('#backendLabel')) || '';
  check('a host that answers /api/health keeps server mode', saved.mode === 'server', saved.mode);
  check('and reports the server it found', /yt-dlp/i.test(label), label);
  await context.close();
}

/* 3. A choice already made is never overridden. */
for (const [mode, api] of [['public', false], ['browser', true], ['server', false]]) {
  const { context, page } = await fresh();
  await setApi(api);
  await page.addInitScript(
    (value) => localStorage.setItem('siphon:settings', value),
    JSON.stringify({ mode, preset: 'video_best', subs: 'off' }),
  );
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('siphon:settings') || '{}'));
  check(`a saved "${mode}" choice is left alone`, saved.mode === mode, saved.mode);
  await context.close();
}

/* 4. A deploy landing under a returning visitor, worker and all. */
{
  const { context, page } = await fresh();
  await setApi(false);

  await serve('previous');
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const before = await page.evaluate(() => caches.keys());
  check('the previous deploy left a worker and its cache', before.includes('siphon-v1'), before.join(','));

  await serve('current');
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3500);

  const after = await page.evaluate(async () => ({
    caches: await caches.keys(),
    controlled: Boolean(navigator.serviceWorker.controller),
  }));
  check('the new worker takes over', after.caches.includes('siphon-v2'), after.caches.join(','));
  check('the previous cache is swept, not left to rot', !after.caches.includes('siphon-v1'), after.caches.join(','));
  check('the new app is rendered, not the cached old one',
    (await page.locator('#modeBrowser').count()) === 1 && (await page.locator('#old-build').count()) === 0);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  check('and still on the visit after that', (await page.locator('#modeBrowser').count()) === 1);

  /* 5. Offline, which is the only reason the worker exists at all. */
  await context.setOffline(true);
  let broke = null;
  try {
    await page.goto(APP, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (error) {
    broke = error.message;
  }
  await page.waitForTimeout(1200);
  check('the shell still opens with no network',
    broke === null && (await page.locator('#url').count()) === 1, broke || '');
  await context.setOffline(false);
  await context.close();
}

await browser.close();
server.close();

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
