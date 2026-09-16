/**
 * Finding a public instance, with the network stubbed.
 *
 * The rule under test is the one that makes this safe to do automatically:
 * a directory listing is a hint, and nothing is used until it has answered a
 * probe for itself. So every case here checks what was *probed* and what was
 * chosen, never what a JSON file claimed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { findInstance, looksUnreachable, DIRECTORIES, SEED } from '../web/instances.js';

/** A fetch that answers the directories from a table, and records the asks. */
function directories(table) {
  const asked = [];
  return {
    asked,
    fetchImpl: async (url) => {
      asked.push(url);
      if (!(url in table)) throw new TypeError('Failed to fetch');
      const answer = table[url];
      return new Response(JSON.stringify(answer.body ?? answer), { status: answer.status ?? 200 });
    },
  };
}

/** A probe that answers from a table of address → helper, and records the asks. */
function prober(table) {
  const probed = [];
  return {
    probed,
    detect: async (address) => {
      probed.push(address);
      const answer = table[address];
      if (!answer) throw new Error('Could not reach that address.');
      return answer;
    },
  };
}

const COBALT_LIST = DIRECTORIES[0].url;
const PIPED_LIST = DIRECTORIES[1].url;
const INVIDIOUS_LIST = DIRECTORIES[2].url;

test('a listed instance is only used once it has answered for itself', async () => {
  const { fetchImpl } = directories({
    [COBALT_LIST]: [{ api: 'dead.example', online: true }, { api: 'alive.example', online: true }],
    [PIPED_LIST]: [],
  });
  const { detect, probed } = prober({
    'https://alive.example': { kind: 'cobalt', label: 'cobalt 11' },
  });

  const found = await findInstance({ fetchImpl, detect });
  assert.deepEqual(found, { endpoint: 'https://alive.example', helper: { kind: 'cobalt', label: 'cobalt 11' } });
  // The dead one was tried, not assumed dead and not assumed alive.
  assert.ok(probed.includes('https://dead.example'));
});

test('cobalt is preferred over Piped, because it reaches more than one site', async () => {
  const { fetchImpl } = directories({
    [COBALT_LIST]: [{ api: 'c.example' }],
    [PIPED_LIST]: [{ api_url: 'https://p.example' }],
  });
  const { detect } = prober({
    'https://c.example': { kind: 'cobalt', label: 'cobalt' },
    'https://p.example': { kind: 'piped', label: 'Piped instance' },
  });

  assert.equal((await findInstance({ fetchImpl, detect })).helper.kind, 'cobalt');
});

test('Piped is taken when no cobalt instance answers', async () => {
  const { fetchImpl } = directories({
    [COBALT_LIST]: [{ api: 'c.example' }],
    [PIPED_LIST]: [{ api_url: 'https://p.example' }],
  });
  const { detect } = prober({ 'https://p.example': { kind: 'piped', label: 'Piped instance' } });

  assert.equal((await findInstance({ fetchImpl, detect })).endpoint, 'https://p.example');
});

test('the Invidious directory is read in its own pair shape, and the unreachable are left out', async () => {
  // api.invidious.io answers [name, details] pairs: onion and i2p entries a
  // browser cannot reach, instances with the API off, and clearnet ones.
  const { fetchImpl } = directories({
    [COBALT_LIST]: [],
    [PIPED_LIST]: [],
    [INVIDIOUS_LIST]: [
      ['inv.example', { type: 'https', uri: 'https://inv.example', api: true, cors: true }],
      ['dark.onion', { type: 'onion', uri: 'http://dark.onion', api: true }],
      ['noapi.example', { type: 'https', uri: 'https://noapi.example', api: false }],
      ['nocors.example', { type: 'https', uri: 'https://nocors.example', api: true, cors: false }],
      'not a pair at all',
    ],
  });
  const { detect, probed } = prober({ 'https://inv.example': { kind: 'invidious', label: 'Invidious instance' } });

  const found = await findInstance({ fetchImpl, detect, candidates: 1 });
  assert.equal(found.endpoint, 'https://inv.example');
  assert.deepEqual(probed, ['https://inv.example'], 'the first candidate was the one clearnet entry with an API');
});

test('Invidious is preferred over Piped, both reaching only YouTube', async () => {
  const { fetchImpl } = directories({
    [COBALT_LIST]: [],
    [PIPED_LIST]: [{ api_url: 'https://p.example' }],
    [INVIDIOUS_LIST]: [['inv.example', { type: 'https', uri: 'https://inv.example', api: true }]],
  });
  const { detect } = prober({
    'https://p.example': { kind: 'piped', label: 'Piped instance' },
    'https://inv.example': { kind: 'invidious', label: 'Invidious instance' },
  });

  assert.equal((await findInstance({ fetchImpl, detect })).helper.kind, 'invidious');
});

test('a directory that is down falls back to the seed rather than failing', async () => {
  const { fetchImpl, asked } = directories({});
  const { detect, probed } = prober({ [SEED[1]]: { kind: 'piped', label: 'Piped instance' } });

  const found = await findInstance({ fetchImpl, detect });
  assert.equal(found.endpoint, SEED[1]);
  assert.equal(asked.length, DIRECTORIES.length, 'both directories were asked');
  assert.ok(probed.length > 1, 'the seed was walked, not just its first entry');
});

test('a directory that changed shape is ignored, not thrown on', async () => {
  const { fetchImpl } = directories({
    [COBALT_LIST]: { body: { instances: 'this is not the old shape' } },
    [PIPED_LIST]: { body: { message: 'moved' } },
  });
  const { detect } = prober({ [SEED[0]]: { kind: 'piped', label: 'Piped instance' } });

  assert.equal((await findInstance({ fetchImpl, detect })).endpoint, SEED[0]);
});

test('an instance listed as offline is never even probed', async () => {
  const { fetchImpl } = directories({
    [COBALT_LIST]: [{ api: 'off.example', online: false }, { api: 'on.example', online: true }],
    [PIPED_LIST]: [],
  });
  const { detect, probed } = prober({ 'https://on.example': { kind: 'cobalt', label: 'cobalt' } });

  await findInstance({ fetchImpl, detect });
  assert.ok(!probed.includes('https://off.example'));
});

test('nothing answering is null, not a guess', async () => {
  const { fetchImpl } = directories({ [COBALT_LIST]: [], [PIPED_LIST]: [] });
  const { detect } = prober({});
  assert.equal(await findInstance({ fetchImpl, detect }), null);
});

test('a siphon server or a relay in a public list is not a public instance', async () => {
  // Some lists carry mirrors and proxies. Only the kinds that answer for a
  // video are what this search is for.
  const { fetchImpl } = directories({
    [COBALT_LIST]: [{ api: 'mirror.example' }, { api: 'relay.example' }],
    [PIPED_LIST]: [],
  });
  const { detect } = prober({
    'https://mirror.example': { kind: 'siphon', label: 'yt-dlp' },
    'https://relay.example': { kind: 'relay', label: 'relay' },
  });

  assert.equal(await findInstance({ fetchImpl, detect }), null);
});

test('the number of strangers contacted on a first visit is capped', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ api: `x${i}.example` }));
  const { fetchImpl } = directories({ [COBALT_LIST]: many, [PIPED_LIST]: [] });
  const { detect, probed } = prober({});

  await findInstance({ fetchImpl, detect, candidates: 6 });
  assert.equal(probed.length, 6);
});

test('the cap is spread across the directories, not spent on the first list', async () => {
  // cobalt publishes a long list. If it were walked first, the budget would
  // be gone before a single YouTube-only instance was tried.
  const many = Array.from({ length: 20 }, (_, i) => ({ api: `c${i}.example` }));
  const { fetchImpl } = directories({
    [COBALT_LIST]: many,
    [PIPED_LIST]: [{ api_url: 'https://p.example' }],
    [INVIDIOUS_LIST]: [['inv.example', { type: 'https', uri: 'https://inv.example', api: true }]],
  });
  const { detect, probed } = prober({});

  await findInstance({ fetchImpl, detect, candidates: 4 });
  assert.equal(probed.length, 4);
  assert.ok(probed.includes('https://p.example'), 'Piped was within the budget');
  assert.ok(probed.includes('https://inv.example'), 'and so was Invidious');
});

test('http-only instances are addressed as http, and duplicates are dropped', async () => {
  const { fetchImpl } = directories({
    [COBALT_LIST]: [{ api: 'plain.example', protocol: 'http' }, { api: 'plain.example', protocol: 'http' }],
    [PIPED_LIST]: [],
  });
  const { detect, probed } = prober({ 'http://plain.example': { kind: 'cobalt', label: 'cobalt' } });

  const found = await findInstance({ fetchImpl, detect });
  assert.equal(found.endpoint, 'http://plain.example');
  assert.equal(probed.filter((address) => address === 'http://plain.example').length, 1);
});

/* ---------------------------------------------- falling back to another one */

test('an address already known not to work is not offered again', async () => {
  const { fetchImpl } = directories({
    [COBALT_LIST]: [{ api: 'dead.example' }, { api: 'alive.example' }],
    [PIPED_LIST]: [],
  });
  const { detect, probed } = prober({
    'https://dead.example': { kind: 'cobalt', label: 'cobalt' },
    'https://alive.example': { kind: 'cobalt', label: 'cobalt' },
  });

  // Both answer a probe; one is excluded because it failed a real download.
  const found = await findInstance({ fetchImpl, detect, exclude: ['https://dead.example/'] });
  assert.equal(found.endpoint, 'https://alive.example');
  assert.ok(!probed.includes('https://dead.example'), 'and it was not even contacted again');
});

test('a failure about the helper is worth another instance', () => {
  for (const message of [
    'Could not reach the server.',
    'The Piped instance did not answer for that video.',
    'The Invidious instance did not answer for that video.',
    'pipedapi.example does not let a web page read its files.',
    'api.example answered 502.',
    'This instance is rate-limiting you. Wait a bit.',
    'The download from cdn.example kept breaking after 40%.',
    'That instance answered 403.',
  ]) {
    assert.equal(looksUnreachable(message), true, message);
  }
});

test('a failure about the video is not', () => {
  // Switching would waste the person's time and someone else's bandwidth to
  // arrive at exactly the same answer.
  for (const message of [
    'That video is private.',
    'That video is unavailable.',
    'That video is members-only.',
    'That video is age-restricted.',
    'yt-dlp does not recognise that link.',
    'That link offered no formats.',
  ]) {
    assert.equal(looksUnreachable(message), false, message);
  }
});
