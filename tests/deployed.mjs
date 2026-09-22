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
// The cache the shipped worker names, read off the source so a bump there is not a test to edit.
const CURRENT_CACHE = /const CACHE = '([^']+)'/.exec(readFileSync(join(WEB, 'sw.js'), 'utf8'))[1];
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
/** Files answered with test content instead of what is on disk, by path. */
const overrides = new Map();
/** Every job body the page posted to the stub server. */
const posted = [];

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

    // A test's own answer for a file — through the service worker too, which
    // is what page.route cannot reach.
    if (overrides.has(path)) {
      return response.writeHead(200, { 'Content-Type': 'application/json' }).end(overrides.get(path));
    }

    // A cobalt instance, as far as detection can tell: its root is JSON
    // with a `cobalt` object.
    if (path === '/cobalt' || path === '/cobalt/') {
      return response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }).end('{"cobalt":{"version":"11.0"},"git":{}}');
    }

    // An Invidious instance as most public ones are today: the stats endpoint
    // names the software to anyone, the video endpoint refuses a page.
    if (path === '/inv-closed/api/v1/stats') {
      return response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        .end('{"version":"2.0","software":{"name":"invidious","version":"2026.09.01","branch":"master"}}');
    }
    if (path.startsWith('/inv-closed/api/v1/videos/')) {
      return response.writeHead(403, { 'Content-Type': 'text/plain' }).end('Endpoint disabled');
    }

    // A relay, as far as detection can tell one apart: it fetches what it is
    // asked for. Only robots.txt is ever asked, and only its shape matters.
    if (path === '/relay' || path.startsWith('/relay/')) {
      if (!url.searchParams.get('url')) return response.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"no url parameter"}');
      return response.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }).end('User-agent: *\nDisallow: /comment\n');
    }

    // A job, as the page posts one: the body is kept for the checks, and the
    // job then fails at once — there is no yt-dlp here, only the wiring.
    if (path === '/api/jobs' && request.method === 'POST') {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        try { posted.push(JSON.parse(raw)); } catch { posted.push({ raw }); }
        response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"id":"stub1","state":"queued","stage":"starting","progress":0}');
      });
      return undefined;
    }
    if (path === '/api/jobs/stub1') {
      return response.writeHead(200, { 'Content-Type': 'application/json' })
        .end('{"id":"stub1","state":"error","stage":"failed","progress":0,"error":"a stub server, with no yt-dlp behind it"}');
    }

    // The one endpoint that tells a container apart from a static host.
    if (path === '/api/health') {
      if (!hasApi) return response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return response.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({
          service: 'siphon', ytDlpVersion: '2026.08.19', ffmpeg: true,
          capabilities: ['jobs', 'resolve', 'tunnel'], presets: [], hasCookies: false, lanUrls: [],
        }));
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
  // A first visit with nothing behind the page contacts nobody: no public
  // instance is adopted by default, and `__offsite` is what proves it.
  context.__offsite = [];
  page.on('request', (request) => {
    const host = new URL(request.url()).host;
    if (!host.startsWith('127.0.0.1')) context.__offsite.push(host);
  });
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

  check('a static host leaves a new visitor with no helper', saved.helper?.kind === 'none', JSON.stringify(saved.helper));
  check('the header says it is ready, not broken', /in this browser/i.test(label), label);
  check('no dead end telling them to go and set something up', !/open settings/i.test(notice),
    notice.replace(/\s+/g, ' ').trim().slice(0, 60) || '(empty)');
  check('no uncaught errors on a first visit', context.__errors.length === 0, context.__errors.join(' ; '));
  // The search for a public instance is the one thing here that would reach
  // off this machine. Having been offered once, it must stay quiet.
  check('and nothing is contacted off this machine once the offer is spent',
    context.__offsite.length === 0, context.__offsite.slice(0, 3).join(', '));
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
  check('a host that answers /api/health is recognised as your own server', saved.helper?.kind === 'siphon',
    JSON.stringify(saved.helper));
  check('and reports the server it found', /yt-dlp/i.test(label), label);
  await context.close();
}

/* 3. A choice already made is never overridden. */
for (const [label, helper, api] of [
  ['none', { kind: 'none', label: 'this device only' }, true],
  ['relay', { kind: 'relay', label: 'relay' }, false],
  ['siphon', { kind: 'siphon', label: 'yt-dlp 1', ffmpeg: true }, false],
]) {
  const { context, page } = await fresh();
  await setApi(api);
  await page.addInitScript(
    (value) => localStorage.setItem('siphon:settings', value),
    JSON.stringify({ endpoint: helper.kind === 'none' ? '' : 'https://helper.example', key: '', helper, preset: 'video_best', subs: 'off' }),
  );
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('siphon:settings') || '{}'));
  check(`a saved "${label}" helper is left alone`, saved.helper?.kind === helper.kind, JSON.stringify(saved.helper));
  await context.close();
}

/* 3b. Settings written by the version with three modes still work. */
for (const [old, expected] of [
  [{ mode: 'server', serverUrl: 'https://mine.example', serverKey: 'k' }, { kind: 'siphon', endpoint: 'https://mine.example', key: 'k' }],
  [{ mode: 'public', publicUrl: 'https://cobalt.example' }, { kind: 'cobalt', endpoint: 'https://cobalt.example' }],
  [{ mode: 'browser', pipedUrl: 'https://pipedapi.example', relayUrl: 'https://relay.example' }, { kind: 'piped', endpoint: 'https://pipedapi.example' }],
  [{ mode: 'browser', relayUrl: 'https://relay.example' }, { kind: 'relay', endpoint: 'https://relay.example' }],
  [{ mode: 'browser' }, { kind: 'none', endpoint: '' }],
]) {
  const { context, page } = await fresh();
  await setApi(false);
  await page.addInitScript(
    (value) => localStorage.setItem('siphon:settings', value),
    JSON.stringify({ ...old, preset: 'audio_mp3', subs: 'off' }),
  );
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('siphon:settings') || '{}'));
  check(`an old "${old.mode}" setup becomes a ${expected.kind} helper`,
    saved.helper?.kind === expected.kind && saved.endpoint === expected.endpoint && (expected.key ? saved.key === expected.key : true),
    JSON.stringify({ helper: saved.helper?.kind, endpoint: saved.endpoint, key: saved.key }));
  check('and the unrelated preferences survive the move', saved.preset === 'audio_mp3', saved.preset);
  await context.close();
}

/* 4. The settings sheet, driven the way a person drives it. */
{
  const { context, page } = await fresh();
  await setApi(true);
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  // Start from nothing, whatever the first-visit probe found.
  await page.evaluate(() => localStorage.setItem('siphon:settings', JSON.stringify({ endpoint: '', key: '', helper: { kind: 'none', label: 'this device only' }, preset: 'video_best', subs: 'off' })));
  // The bundled list names real hosts, and this suite contacts nothing off
  // this machine — so the list is answered with addresses on this host before
  // the sheet opens and turns it into chips. Set at the server, because the
  // page's fetch goes through the service worker, where page.route cannot see it.
  const listed = ['https://127.0.0.1:1/one', `${BASE}/two`, 'https://127.0.0.1:3/three', 'https://127.0.0.1:4/four'];
  // Chips come from `open` — what the daily measurement saw answer a page —
  // never from the full list.
  overrides.set('/siphon/instances.json', JSON.stringify({ invidious: listed, open: listed.map((url) => ({ url, kind: 'invidious' })), measured: '2026-09-17' }));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.click('#openSettings');
  await page.waitForTimeout(300);

  const fields = await page.evaluate(() => ({
    address: Boolean(document.getElementById('endpoint')),
    modes: document.querySelectorAll('input[name="mode"]').length,
    cookies: document.getElementById('cookiesBlock').hidden,
  }));
  check('the sheet asks for one address, not a mode', fields.address && fields.modes === 0, JSON.stringify(fields));

  // The bundled list, served beside the app under the subpath, becomes chips:
  // an instance to tap, not a search to run.
  await page.waitForSelector('#suggested button', { timeout: 5_000 }).catch(() => {});
  const chips = await page.$$eval('#suggested button', (nodes) => nodes.map((node) => node.textContent.trim()));
  check('the first three of the measured list are offered as chips', chips.length === 3 && chips.every((host, i) => host.startsWith(new URL(listed[i]).host)), chips.join(', '));
  check('with the date they were measured, and Find offered', /Measured 2026-09-17/.test((await page.textContent('#openNote')) || '') && !(await page.evaluate(() => document.getElementById('findInstance').hidden)),
    ((await page.textContent('#openNote')) || '').slice(0, 60));
  await page.click('#suggested button:nth-child(2)');
  await page.waitForFunction(() => !/checking/i.test(document.getElementById('statusText').textContent || ''), null, { timeout: 15_000 });
  const tapped = { address: await page.inputValue('#endpoint'), status: (await page.textContent('#statusText')) || '' };
  check('tapping one fills the address in and tests it', tapped.address === `${BASE}/two` && !/not checked|checking/i.test(tapped.status),
    `${tapped.address} — ${tapped.status.slice(0, 60)}`);
  // A day none answered: no chips, the field, and a sentence that says so —
  // offering an instance that will refuse would look like a broken app. Find
  // stays, because it asks the live directory rather than the day's file.
  overrides.set('/siphon/instances.json', JSON.stringify({ invidious: listed, open: [], measured: '2026-09-17' }));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.click('#openSettings');
  await page.waitForTimeout(400);
  const none = await page.evaluate(() => ({
    chips: document.querySelectorAll('#suggested button').length,
    find: document.getElementById('findInstance').hidden,
    note: document.getElementById('openNote').textContent,
    field: Boolean(document.getElementById('endpoint')),
  }));
  check('when none answered a page, no chip is offered, and Find still is', none.chips === 0 && none.find === false, JSON.stringify({ chips: none.chips, find: none.find }));
  check('the field, and a sentence saying so with the date and where Find looks', none.field && /Measured 2026-09-17: no public instance answered/.test(none.note) && /Invidious directory/.test(none.note), none.note.slice(0, 80));
  overrides.delete('/siphon/instances.json');
  // Back to an empty box for what follows, which is written for one.
  await page.fill('#endpoint', '');
  check('the cookie jar is hidden until the address proves to be a server', fields.cookies === true);

  // Nothing filled in, and nothing behind the page: the status line must
  // describe the device honestly rather than show a green light for nobody.
  await setApi(false);
  await page.click('#testConnection');
  await page.waitForTimeout(800);
  check('with no address and nothing behind the page, it says this device only',
    /this device only|nothing set/i.test((await page.textContent('#statusText')) || ''),
    (await page.textContent('#statusText')) || '');
  await setApi(true);

  // An address that answers nothing must say so rather than be saved.
  await page.fill('#endpoint', 'https://127.0.0.1:9/nothing');
  await page.click('#saveSettings');
  await page.waitForTimeout(1500);
  check('an unreachable address is refused, and the sheet stays open',
    await page.evaluate(() => document.getElementById('settings').open));
  check('and the reason is on screen', /could not reach|not a siphon/i.test((await page.textContent('#statusText')) || ''),
    (await page.textContent('#statusText')) || '');

  // An instance that answers to its name but keeps its video endpoint shut —
  // most public ones today — is recognised, and then said to be shut, before
  // anyone saves it and finds out on a real link.
  await page.fill('#endpoint', `${BASE}/inv-closed`);
  await page.click('#testConnection');
  // "Checking that it answers this page…" matches too, and is not the verdict:
  // on a slow run it is what would be read.
  await page.waitForFunction(() => {
    const text = document.getElementById('statusText').textContent || '';
    return /answers this page|does not answer this page|could not/i.test(text) && !/Checking/.test(text);
  }, null, { timeout: 15_000 });
  const closed = (await page.textContent('#statusText')) || '';
  check('an Invidious instance is recognised, and its shut video endpoint named before saving',
    /An Invidious instance/.test(closed) && /does not answer this page for a video/.test(closed), closed.slice(0, 120));
  check('naming the instance, so two of them never read the same', closed.startsWith('127.0.0.1:8443 — '), closed.slice(0, 40));
  check('with an amber light, not a green one', (await page.evaluate(() => document.getElementById('statusDot').className)) === 'dot warn');

  // The real one: this very host answers /api/health, so it is a siphon server.
  await page.fill('#endpoint', BASE);
  await page.click('#testConnection');
  await page.waitForTimeout(1200);
  check('a siphon server is recognised from its address alone',
    /your server/i.test((await page.textContent('#statusText')) || ''), (await page.textContent('#statusText')) || '');
  check('and the cookie jar appears with it', (await page.evaluate(() => document.getElementById('cookiesBlock').hidden)) === false);

  await page.click('#saveSettings');
  await page.waitForTimeout(1200);
  check('the privacy note names where links go', /your server/i.test((await page.textContent('#privacyNote')) || ''),
    (await page.textContent('#privacyNote')) || '');

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.click('#openSettings');
  await page.waitForTimeout(300);
  const kept = await page.evaluate(() => ({
    endpoint: document.getElementById('endpoint').value,
    helper: JSON.parse(localStorage.getItem('siphon:settings') || '{}').helper?.kind,
  }));
  check('the address and what it is survive a reload', kept.endpoint === BASE && kept.helper === 'siphon', JSON.stringify(kept));
  check('the status names the address it describes', ((await page.textContent('#statusText')) || '').startsWith('127.0.0.1:8443 — '), (await page.textContent('#statusText')) || '');

  // The Advanced section: yt-dlp's options, applied by your own server. With
  // one set they are live; what is typed rides with every job the page posts.
  await page.click('#advanced summary');
  await page.waitForTimeout(200);
  check('there is no converter field to configure: the converter ships beside the app', (await page.locator('#coreUrl').count()) === 0);
  check('with your own server set, the yt-dlp options are live', !(await page.evaluate(() => document.getElementById('ytdlpBlock').classList.contains('off'))) && /Applied by your server/.test((await page.textContent('#ytdlpScope')) || ''),
    ((await page.textContent('#ytdlpScope')) || '').slice(0, 60));
  await page.check('#optSponsor');
  await page.fill('#optClipStart', '0:10');
  await page.fill('#optClipEnd', '1:00');
  await page.fill('#optRate', '2M');
  await page.selectOption('#optClient', 'tv');
  await page.click('#saveSettings');
  await page.waitForFunction(() => !document.getElementById('settings').open, null, { timeout: 15_000 });
  posted.length = 0;
  await page.fill('#url', 'https://example.com/a-video');
  await page.click('#go');
  await page.waitForFunction(() => document.querySelector('#queueList li'), null, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  const body = posted[0] || {};
  check('the options ride with every job, in the server\'s vocabulary',
    body.sponsorblock === true && body.clip_start === '0:10' && body.clip_end === '1:00' && body.rate_limit === '2M' && body.yt_client === 'tv' && body.url === 'https://example.com/a-video',
    JSON.stringify(body).slice(0, 160));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.click('#openSettings');
  await page.waitForTimeout(300);
  const back = await page.evaluate(() => ({
    sponsor: document.getElementById('optSponsor').checked,
    clip: `${document.getElementById('optClipStart').value}-${document.getElementById('optClipEnd').value}`,
    rate: document.getElementById('optRate').value,
    client: document.getElementById('optClient').value,
  }));
  check('and survive a reload', back.sponsor && back.clip === '0:10-1:00' && back.rate === '2M' && back.client === 'tv', JSON.stringify(back));

  // With no helper the options wait, greyed but kept, and say for whom.
  await page.fill('#endpoint', '');
  await setApi(false);
  await page.click('#testConnection');
  await page.waitForTimeout(800);
  check('with no server set they are greyed, and say what they wait for', (await page.evaluate(() => document.getElementById('ytdlpBlock').classList.contains('off'))) && /your own siphon server/.test((await page.textContent('#ytdlpScope')) || ''),
    ((await page.textContent('#ytdlpScope')) || '').slice(0, 70));
  check('but not lost', (await page.inputValue('#optRate')) === '2M');
  await setApi(true);
  await page.fill('#endpoint', BASE);
  await page.click('#testConnection');
  await page.waitForTimeout(1200);

  // Phone width is what this app is for; the sheet must not scroll sideways.
  const overflow = await page.evaluate(() => {
    const sheet = document.querySelector('.sheet-inner');
    return Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      sheet ? sheet.scrollWidth - sheet.clientWidth : 0,
    );
  });
  check('the settings sheet does not scroll sideways at phone width', overflow <= 0, `${overflow}px over`);

  // The converter's default location is the app's own origin — under the
  // subpath, as deployed — so a static host serves it with nothing configured.
  const core = await page.evaluate(async () => (await import('./media.js')).DEFAULT_CORE_URL);
  check('the converter defaults to the app\'s own origin', core.startsWith(`${BASE}/siphon/vendor/ffmpeg/`), core);
  await context.close();
}

/* 5. The guide, and the site's own relay. */
{
  // A first visit on a site whose owner set a relay: the visitor gets it with
  // nothing to do, is told whose it is, and the guide says YouTube is ready.
  overrides.set('/siphon/config.json', JSON.stringify({ relay: `${BASE}/relay`, relayKind: 'own', instance: '' }));
  const { context, page } = await fresh();
  await setApi(false);
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('siphon:settings') || '{}'));
  check("the site's relay is taken as the helper on a first visit", saved.helper?.kind === 'relay' && saved.endpoint === `${BASE}/relay`,
    JSON.stringify({ helper: saved.helper?.kind, endpoint: saved.endpoint }));
  const notice = (await page.textContent('#feedback')) || '';
  check('and the visitor is told whose relay it is', /This site has a relay/.test(notice) && notice.includes('127.0.0.1:8443') && /which this site runs/.test(notice), notice.replace(/\s+/g, ' ').slice(0, 80));
  check('the header says so', /relay for YouTube/.test((await page.textContent('#backendLabel')) || ''), await page.textContent('#backendLabel'));

  // The guide is on the first screen, and its YouTube part reflects what is set.
  check('the guide is shown on a first visit', await page.isVisible('#tour'));
  const youtube = (await page.textContent('#tourYoutube')) || '';
  check('and it says YouTube is ready, naming the relay', /Ready/.test(youtube) && youtube.includes('127.0.0.1:8443'), youtube.slice(0, 80));
  check('with nothing left to set up', await page.isHidden('#tourOptions'));

  // Dismissed, it stays dismissed; the ? brings it back.
  await page.click('#tourDismiss');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  check('closed once, the guide stays closed', await page.isHidden('#tour'));
  await page.click('#openTour');
  await page.waitForTimeout(300);
  check('and the ? in the header brings it back', await page.isVisible('#tour'));

  // A visitor who clears the helper is not handed the relay again.
  await page.evaluate(() => localStorage.setItem('siphon:settings', JSON.stringify({ endpoint: '', key: '', helper: { kind: 'none', label: 'this device only' }, preset: 'video_best', subs: 'off', autoInstance: false })));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const again = await page.evaluate(() => JSON.parse(localStorage.getItem('siphon:settings') || '{}'));
  check('a helper the visitor cleared is not put back', again.helper?.kind === 'none' && !again.endpoint, JSON.stringify(again.helper));
  check('nothing was contacted off this machine', context.__offsite.length === 0, context.__offsite.slice(0, 3).join(', '));
  await context.close();
  overrides.delete('/siphon/config.json');
}

/* 5b. No relay, but a cobalt instance in config.json: not adopted — no public instance is, by default. */
{
  overrides.set('/siphon/config.json', JSON.stringify({ relay: '', relayKind: '', instance: '', cobalt: `${BASE}/cobalt` }));
  const { context, page } = await fresh();
  await setApi(false);
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('siphon:settings') || '{}'));
  check('a cobalt instance in config.json is not adopted: a first visit is this device only', saved.helper?.kind === 'none' && !saved.endpoint,
    JSON.stringify({ helper: saved.helper?.kind, endpoint: saved.endpoint }));
  const notice = (await page.textContent('#feedback')) || '';
  check('and no notice names an instance', !/public cobalt instance|Using a public instance/.test(notice), notice.replace(/\s+/g, ' ').slice(0, 90));
  check('the instance in config.json was never contacted', !context.__offsite.length && !(await page.evaluate(() => performance.getEntriesByType('resource').some((e) => e.name.includes('/cobalt')))));
  await context.close();
  overrides.delete('/siphon/config.json');
}

/* 6. With no relay configured, the guide says what would make YouTube work. */
{
  const { context, page } = await fresh();
  await setApi(false);
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const youtube = (await page.textContent('#tourYoutube')) || '';
  check('the guide says YouTube needs one thing that is yours', /needs one thing that is yours/.test(youtube), youtube.slice(0, 80));
  const options = await page.$$eval('#tourOptions a', (links) => links.map((a) => a.href));
  check('and offers the relay deploy and the bridge, with links', options.some((h) => h.includes('deploy.workers.cloudflare.com')) && options.some((h) => h.includes('/bridge')), options.join(' '));
  check('and the docker command to copy', /docker run .*ghcr\.io\/maxgfr\/siphon/.test((await page.textContent('#dockerCmd')) || ''));
  await context.close();
}

/* 6b. A computer's habits: the bookmarklet, a dropped link, Ctrl+V with nothing focused. */
{
  const { context, page } = await fresh();
  await setApi(false);
  await page.goto(APP, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  const href = (await page.getAttribute('#bookmarklet', 'href')) || '';
  check('the guide offers a bookmarklet that opens this deploy, subpath and all',
    href.startsWith('javascript:') && href.includes(`"${APP}"`) && href.includes("?url='+encodeURIComponent(location.href)"), href.slice(0, 120));
  await page.click('#bookmarklet');
  check('tapping it here says to drag it instead, and goes nowhere', /Drag/.test((await page.textContent('#feedback')) || '') && page.url().startsWith(APP), page.url());

  const dropped = `${BASE}/dropped/clip.mp4`;
  await page.evaluate((link) => {
    const dt = new DataTransfer();
    dt.setData('text/uri-list', `# A bookmark\r\n${link}\r\n`);
    document.body.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, dropped);
  check('a link dropped anywhere on the page fills the field', (await page.inputValue('#url')) === dropped, await page.inputValue('#url'));

  const pasted = `${BASE}/pasted/clip.mp4`;
  await page.evaluate((link) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', `Watch this ${link}!`);
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, pasted);
  check('Ctrl+V with nothing focused takes the link out of the text', (await page.inputValue('#url')) === pasted, await page.inputValue('#url'));

  // A share arrives as ?text=, and the text is a sentence: its full stop is
  // not part of the link, and a YouTube id with a dot on the end is no id.
  await page.goto(`${APP}?text=${encodeURIComponent('Watch this https://youtu.be/jNQXAC9IVRw.')}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const shared = await page.inputValue('#url');
  check('a shared sentence gives the link without its punctuation', shared === 'https://youtu.be/jNQXAC9IVRw', shared);
  check('and the shared text is kept out of the address bar', page.url() === APP, page.url());
  check('and nothing was contacted off this machine for any of it', context.__offsite.length === 0, context.__offsite.join(','));
  await context.close();
}

/* 7. A deploy landing under a returning visitor, worker and all. */
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
  check('the new worker takes over', after.caches.includes(CURRENT_CACHE), after.caches.join(','));
  check('the previous cache is swept, not left to rot', !after.caches.includes('siphon-v1'), after.caches.join(','));
  check('the new app is rendered, not the cached old one',
    (await page.locator('#endpoint').count()) === 1 && (await page.locator('#old-build').count()) === 0);

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  check('and still on the visit after that', (await page.locator('#endpoint').count()) === 1);

  /* 6. Offline, which is the only reason the worker exists at all. */
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
