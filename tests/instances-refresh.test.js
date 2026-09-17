/**
 * The bundled-list refresh, with the network stubbed.
 *
 * The daily workflow runs scripts/instances.mjs against the Invidious
 * project's own list. These pin how that list is read — from the API's JSON
 * and, when the API is down, from the docs page's markup — and that the
 * script says which one answered rather than silently writing an empty list.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { answersPage, fromDirectory, fromDocsPage, fromPipedDirectory, measure, onTheInternet, reachable, refresh, refreshPiped, API_URL, DOCS_URL, ORIGIN, PIPED_SEED, PIPED_URL, SAMPLE_ID, SEED } from '../scripts/instances.mjs';

/** A resolver that puts every name on the internet, for the tests about lists rather than DNS. */
const anywhere = { resolve4: async () => ['203.0.113.1'], resolve6: async () => [] };

/** The shape of https://docs.invidious.io/instances/ — headings per address type, links under each. */
const DOCS_HTML = `<!doctype html><html><body>
<h1 id="invidious-instances">Invidious Instances</h1>
<p>See <a href="https://github.com/iv-org/documentation">the docs</a> and <a href="https://uptime.invidious.io/">uptime</a>.</p>
<h2 id="list-of-public-invidious-instances">List of public Invidious Instances (sorted from oldest to newest):</h2>
<h3 id="https">https://</h3>
<ul>
<li><a href="https://yewtu.be">yewtu.be</a> 🇳🇱 - <a href="https://yewtu.be/privacy">privacy</a></li>
<li><a href="https://inv.nadeko.net/">inv.nadeko.net</a> 🇨🇱 (✅ API)</li>
<li><a href="https://invidious.nerdvpn.de">invidious.nerdvpn.de</a> 🇺🇦</li>
<li><a href="https://yewtu.be">yewtu.be again</a></li>
</ul>
<h3 id="onion">onion</h3>
<ul><li><a href="http://something.onion">something.onion</a></li></ul>
<h3 id="i2p">i2p</h3>
<ul><li><a href="http://something.i2p">something.i2p</a></li></ul>
</body></html>`;

test('the API answer is read as [name, details] pairs, clearnet and API-on only', () => {
  const list = fromDirectory([
    ['yewtu.be', { type: 'https', uri: 'https://yewtu.be/', api: true, cors: true }],
    ['dark', { type: 'onion', uri: 'http://dark.onion', api: true }],
    ['noapi', { type: 'https', uri: 'https://noapi.example', api: false }],
    ['nocors', { type: 'https', uri: 'https://nocors.example', api: true, cors: false }],
    ['inv.nadeko.net', { type: 'https', uri: 'https://inv.nadeko.net', api: true }],
    ['yewtu.be', { type: 'https', uri: 'https://yewtu.be', api: true }],
    'not a pair',
  ]);
  assert.deepEqual(list, ['https://yewtu.be', 'https://inv.nadeko.net']);
});

test('overlay-network addresses listed as https are still left out — a browser cannot resolve them', () => {
  // What the API answered on 2026-09-16: three entries, one of them .ygg.
  const list = fromDirectory([
    ['invidious.f5.si', { type: 'https', uri: 'https://invidious.f5.si', api: true, cors: true }],
    ['inv-ygg.nadeko.net', { type: 'https', uri: 'https://inv-ygg.nadeko.net', api: true, cors: true }],
    ['inv.nadeko.ygg', { type: 'https', uri: 'https://inv.nadeko.ygg', api: true, cors: true }],
  ]);
  assert.deepEqual(list, ['https://invidious.f5.si', 'https://inv-ygg.nadeko.net']);
  for (const bad of ['https://x.onion', 'https://x.i2p', 'https://x.ygg', 'https://localhost', 'http://plain.example', 'nonsense']) {
    assert.equal(reachable(bad), false, bad);
  }
  assert.equal(reachable('https://inv.nadeko.net/'), true);
});

test('the docs page yields the links under its https heading, and nothing from the others', () => {
  const list = fromDocsPage(DOCS_HTML);
  assert.deepEqual(list, ['https://yewtu.be', 'https://inv.nadeko.net', 'https://invidious.nerdvpn.de']);
});

test('the heading is found through a site generator\'s permalink and without an id', () => {
  const permalink = DOCS_HTML.replace('<h3 id="https">https://</h3>', '<h3 id="https">https://<a class="headerlink" href="#https" title="Permanent link">¶</a></h3>');
  assert.equal(fromDocsPage(permalink).length, 3);
  const noId = DOCS_HTML.replace('<h3 id="https">https://</h3>', '<h3>https</h3>').replace('<h3 id="onion">', '<h3>');
  assert.equal(fromDocsPage(noId).length, 3);
});

test('a page with no https section yields nothing rather than every link on it', () => {
  assert.deepEqual(fromDocsPage('<html><h1>Moved</h1><a href="https://elsewhere.example">here</a></html>'), []);
  assert.deepEqual(fromDocsPage(''), []);
});

test('the API is asked first and named as the source', async () => {
  const asked = [];
  const found = await refresh({
    resolve: anywhere,
    fetchImpl: async (url) => {
      asked.push(url);
      if (url === API_URL) return JSON.stringify([['a', { type: 'https', uri: 'https://a.example', api: true }]]);
      throw new Error('should not be asked');
    },
  });
  assert.equal(found.source, 'api.invidious.io + seed');
  assert.deepEqual(found.invidious, ['https://a.example', ...SEED], 'the official list first, the seed behind it');
  assert.deepEqual(asked, [API_URL]);
});

test('an official entry that is also in the seed is listed once, where the official list put it', async () => {
  const found = await refresh({
    resolve: anywhere,
    fetchImpl: async () => JSON.stringify([[SEED[1].replace('https://', ''), { type: 'https', uri: `${SEED[1]}/`, api: true }]]),
  });
  assert.equal(found.invidious.filter((url) => url === SEED[1]).length, 1);
  assert.equal(found.invidious[0], SEED[1]);
});

test('when the API is down the docs page is read instead, and said so', async () => {
  const found = await refresh({
    resolve: anywhere,
    fetchImpl: async (url) => {
      if (url === API_URL) throw new Error('api.invidious.io answered 503');
      if (url === DOCS_URL) return DOCS_HTML;
      throw new Error('unexpected');
    },
  });
  assert.equal(found.source, 'docs.invidious.io + seed');
  assert.equal(found.invidious.length, 3 + SEED.filter((url) => !['https://yewtu.be', 'https://inv.nadeko.net', 'https://invidious.nerdvpn.de'].includes(url)).length);
});

test('an API that answers an empty list is not trusted over the page', async () => {
  const found = await refresh({
    resolve: anywhere,
    fetchImpl: async (url) => (url === API_URL ? '[]' : DOCS_HTML),
  });
  assert.equal(found.source, 'docs.invidious.io + seed');
});

test('a name whose only address is Yggdrasil is not on the internet, and is left out', async () => {
  const notFound = Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  const table = {
    'inv-ygg.nadeko.net': { v4: [], v6: ['202:415c:2061:a9c0:9dbc:b95d:66ec:1347'] },
    'inv.nadeko.net': { v4: ['203.0.113.7'], v6: ['2a01:4f8::1'] },
    'v6only.example': { v4: [], v6: ['2606:4700::1'] },
    'gone.example': null,
  };
  const resolve = {
    resolve4: async (host) => { if (!table[host]) throw notFound; return table[host].v4; },
    resolve6: async (host) => { if (!table[host]) throw notFound; return table[host].v6; },
  };
  assert.equal(await onTheInternet('https://inv-ygg.nadeko.net', resolve), false);
  assert.equal(await onTheInternet('https://inv.nadeko.net', resolve), true);
  assert.equal(await onTheInternet('https://v6only.example', resolve), true, 'a real IPv6 address counts');
  assert.equal(await onTheInternet('https://gone.example', resolve), false);
  // A resolver that is itself broken must not empty the list.
  const broken = { resolve4: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }); }, resolve6: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }); } };
  assert.equal(await onTheInternet('https://inv.nadeko.net', broken), true);

  const found = await refresh({
    resolve,
    fetchImpl: async () => JSON.stringify([
      ['inv-ygg.nadeko.net', { type: 'https', uri: 'https://inv-ygg.nadeko.net', api: true }],
      ['inv.nadeko.net', { type: 'https', uri: 'https://inv.nadeko.net', api: true }],
    ]),
  });
  assert.ok(!found.invidious.includes('https://inv-ygg.nadeko.net'));
  assert.ok(found.invidious.includes('https://inv.nadeko.net'));
});

test('nothing from either is an error, never an empty file', async () => {
  await assert.rejects(
    () => refresh({ resolve: anywhere, fetchImpl: async () => '<html></html>' }),
    /not.*a single instance|neither/i,
  );
});

/* ------------------------------------------------------------ measuring */

/**
 * A fake internet of instances: each host answers the video endpoint and its
 * media the way the table says — with or without the header a page needs.
 */
function instances(table) {
  const asked = [];
  const fetchImpl = async (url, init = {}) => {
    asked.push({ url, headers: init.headers || {} });
    const { host, pathname } = new URL(url);
    const spec = table[host];
    if (!spec) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const cors = (on) => (on ? { 'access-control-allow-origin': '*' } : {});
    if (pathname.startsWith('/api/v1/videos/') || pathname.startsWith('/streams/')) {
      if (spec.videos === 403) return new Response('Endpoint disabled', { status: 403 });
      if (spec.videos === 'html') return new Response('<html>nope</html>', { status: 200, headers: cors(true) });
      const body = pathname.startsWith('/streams/')
        ? { videoStreams: [{ url: `https://${host}/proxy/clip.mp4`, quality: '360p' }], audioStreams: [] }
        : { formatStreams: [{ url: '/videoplayback?itag=18', type: 'video/mp4' }], adaptiveFormats: [] };
      return new Response(JSON.stringify(spec.videos === 'empty' ? { formatStreams: [], adaptiveFormats: [] } : body), { status: 200, headers: cors(spec.videosCors !== false) });
    }
    if (pathname === '/videoplayback' || pathname === '/proxy/clip.mp4') {
      if (spec.media === 403) return new Response('forbidden', { status: 403, headers: cors(true) });
      return new Response(new Uint8Array(4096), { status: 206, headers: { ...cors(spec.mediaCors !== false), 'content-type': 'video/mp4' } });
    }
    if (pathname === '/' && init.method === 'POST') {
      return spec.cobalt === 'keyed'
        ? new Response(JSON.stringify({ status: 'error', error: { code: 'error.api.auth.key.missing' } }), { status: 401 })
        : new Response(JSON.stringify({ status: 'tunnel', url: `https://${host}/tunnel?id=1` }), { status: 200 });
    }
    if (pathname === '/tunnel') return new Response(new Uint8Array(2048), { status: 200, headers: { 'content-type': 'video/mp4' } });
    return new Response('not found', { status: 404 });
  };
  return { asked, fetchImpl };
}

test('an Invidious instance is open when its video endpoint and its media both answer a page', async () => {
  const { asked, fetchImpl } = instances({ 'open.example': {} });
  const verdict = await answersPage('https://open.example/', 'invidious', { fetchImpl });
  assert.equal(verdict.ok, true);
  assert.match(verdict.verdict, /ok in \d+ms — videos and 4096 media bytes/);
  assert.equal(asked[0].url, `https://open.example/api/v1/videos/${SAMPLE_ID}?local=true`, 'asked with local=true, the only form a page can fetch');
  assert.equal(asked[0].headers.Origin, ORIGIN, 'as a page sends it');
  assert.equal(asked[1].url, 'https://open.example/videoplayback?itag=18', 'the relative media path resolved against the instance');
  assert.equal(asked[1].headers.Range, 'bytes=0-65535');
});

test('the doors that are shut are named: a refused endpoint, a missing header, a proxy that will not stream', async () => {
  const { fetchImpl } = instances({
    'refuses.example': { videos: 403 },
    'nocors.example': { videosCors: false },
    'proxyshut.example': { media: 403 },
    'mediacors.example': { mediaCors: false },
    'empty.example': { videos: 'empty' },
    'html.example': { videos: 'html' },
  });
  assert.match((await answersPage('https://refuses.example', 'invidious', { fetchImpl })).verdict, /videos HTTP 403, cors=NONE — Endpoint disabled/);
  assert.match((await answersPage('https://nocors.example', 'invidious', { fetchImpl })).verdict, /videos HTTP 200, cors=NONE/);
  assert.match((await answersPage('https://proxyshut.example', 'invidious', { fetchImpl })).verdict, /videos ok, media HTTP 403/);
  assert.match((await answersPage('https://mediacors.example', 'invidious', { fetchImpl })).verdict, /videos ok, media HTTP 206, cors=NONE/);
  assert.match((await answersPage('https://empty.example', 'invidious', { fetchImpl })).verdict, /but no streams/);
  assert.match((await answersPage('https://html.example', 'invidious', { fetchImpl })).verdict, /not JSON/);
  assert.match((await answersPage('https://down.example', 'invidious', { fetchImpl })).verdict, /videos ECONNREFUSED/);
  for (const host of ['refuses', 'nocors', 'proxyshut', 'mediacors', 'empty', 'html', 'down']) {
    assert.equal((await answersPage(`https://${host}.example`, 'invidious', { fetchImpl })).ok, false, host);
  }
});

test('a Piped instance is asked its own way, and cobalt for a tunnel', async () => {
  const { asked, fetchImpl } = instances({ 'piped.example': {}, 'cobalt.example': {}, 'keyed.example': { cobalt: 'keyed' } });
  assert.equal((await answersPage('https://piped.example', 'piped', { fetchImpl })).ok, true);
  assert.equal(asked[0].url, `https://piped.example/streams/${SAMPLE_ID}`);
  assert.equal((await answersPage('https://cobalt.example', 'cobalt', { fetchImpl })).ok, true);
  assert.match((await answersPage('https://cobalt.example', 'cobalt', { fetchImpl })).verdict, /tunnel 200 video\/mp4 2048 bytes/);
  const keyed = await answersPage('https://keyed.example', 'cobalt', { fetchImpl });
  assert.equal(keyed.ok, false);
  assert.match(keyed.verdict, /error\.api\.auth\.key\.missing/);
});

test('the measurement walks every list, says each verdict, and keeps only the open ones with their kind', async () => {
  const { fetchImpl } = instances({ 'a.example': { videos: 403 }, 'b.example': {}, 'p.example': {}, 'c.example': { cobalt: 'keyed' } });
  const lines = [];
  const open = await measure(
    { invidious: ['https://a.example', 'https://b.example/'], piped: ['https://p.example'], cobalt: ['https://c.example'] },
    { fetchImpl, say: (line) => lines.push(line) },
  );
  assert.deepEqual(open, [{ url: 'https://b.example', kind: 'invidious' }, { url: 'https://p.example', kind: 'piped' }]);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^shut {2}invidious a\.example/);
  assert.match(lines[1], /^open {2}invidious b\.example/);
  assert.match(lines[3], /^shut {2}cobalt {4}c\.example/);
  assert.deepEqual(await measure({}, { fetchImpl }), [], 'nothing listed is nothing open, not a crash');
});

test("Piped's directory is read as api_url entries, the seed behind it, and the seed alone when it is down", async () => {
  assert.deepEqual(fromPipedDirectory([{ name: 'kavin', api_url: 'https://pipedapi.kavin.rocks/' }, { api_url: 'http://plain.example' }, { name: 'no api' }, 'junk']), ['https://pipedapi.kavin.rocks']);
  const listed = await refreshPiped({ resolve: anywhere, fetchImpl: async (url) => (url === PIPED_URL ? JSON.stringify([{ api_url: 'https://new.example' }]) : '') });
  assert.deepEqual(listed, ['https://new.example', ...PIPED_SEED]);
  const down = await refreshPiped({ resolve: anywhere, fetchImpl: async () => { throw new Error('down'); } });
  assert.deepEqual(down, [...PIPED_SEED]);
});
