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

import { fromDirectory, fromDocsPage, onTheInternet, reachable, refresh, API_URL, DOCS_URL, SEED } from '../scripts/instances.mjs';

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
