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

import { findInstance, invidiousInstances, looksUnreachable, DIRECTORIES, SEED } from '../web/instances.js';

/** A fetch that answers the directories from a table, and records the asks. */
function directories(table) {
  const asked = [];
  return {
    asked,
    fetchImpl: async (url) => {
      asked.push(url);
      if (isBundled(url)) {
        if (!('bundled' in table)) throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify({ invidious: table.bundled }), { status: 200 });
      }
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

/**
 * The bundled list's URL is derived from the module's own, so under Node it
 * is a file: URL — which is what tells it apart from the directories, two of
 * which are also called instances.json.
 */
const isBundled = (url) => /^file:.*\/web\/instances\.json$/.test(String(url));

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
      ['ygg', { type: 'https', uri: 'https://inv.nadeko.ygg', api: true, cors: true }],
      'not a pair at all',
    ],
  });
  const { detect, probed } = prober({ 'https://inv.example': { kind: 'invidious', label: 'Invidious instance' } });

  const found = await findInstance({ fetchImpl, detect, candidates: 1 });
  assert.equal(found.endpoint, 'https://inv.example');
  assert.deepEqual(probed, ['https://inv.example'], 'the first candidate was the one clearnet entry with an API');
});

test('Invidious is preferred over cobalt: it is the plan for YouTube, and it answers a page', async () => {
  const { fetchImpl } = directories({
    [COBALT_LIST]: [{ api: 'c.example' }],
    [PIPED_LIST]: [],
    [INVIDIOUS_LIST]: [['inv.example', { type: 'https', uri: 'https://inv.example', api: true }]],
  });
  const { detect } = prober({
    'https://c.example': { kind: 'cobalt', label: 'cobalt' },
    'https://inv.example': { kind: 'invidious', label: 'Invidious instance' },
  });

  assert.equal((await findInstance({ fetchImpl, detect })).helper.kind, 'invidious');
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

/* ------------------------------------------------- the list beside the app */

test('the bundled list is tried first, and alone when one of it answers', async () => {
  // web/instances.json is same-origin and the plan; the directories are
  // strangers and the fallback. When the bundled list delivers, no directory
  // is contacted at all.
  const { fetchImpl, asked } = directories({
    bundled: ['https://one.example', 'https://two.example'],
    [COBALT_LIST]: [{ api: 'c.example' }],
    [PIPED_LIST]: [],
    [INVIDIOUS_LIST]: [],
  });
  const { detect, probed } = prober({ 'https://two.example': { kind: 'invidious', label: 'Invidious instance' } });

  const found = await findInstance({ fetchImpl, detect });
  assert.equal(found.endpoint, 'https://two.example');
  assert.deepEqual(probed.sort(), ['https://one.example', 'https://two.example']);
  assert.ok(!asked.includes(COBALT_LIST), 'no directory was asked');
});

test('when nothing on the bundled list answers, the directories are asked', async () => {
  const { fetchImpl, asked } = directories({
    bundled: ['https://dead.example'],
    [COBALT_LIST]: [{ api: 'c.example' }],
    [PIPED_LIST]: [],
    [INVIDIOUS_LIST]: [],
  });
  const { detect, probed } = prober({ 'https://c.example': { kind: 'cobalt', label: 'cobalt' } });

  const found = await findInstance({ fetchImpl, detect });
  assert.equal(found.endpoint, 'https://c.example');
  assert.ok(probed.includes('https://dead.example'), 'the bundled one was tried first');
  assert.ok(asked.includes(COBALT_LIST));
});

test('an excluded address on the bundled list is skipped, so a dead one is not offered again', async () => {
  const { fetchImpl } = directories({
    bundled: ['https://dead.example', 'https://alive.example'],
    [COBALT_LIST]: [],
    [PIPED_LIST]: [],
    [INVIDIOUS_LIST]: [],
  });
  const { detect, probed } = prober({
    'https://dead.example': { kind: 'invidious', label: 'Invidious instance' },
    'https://alive.example': { kind: 'invidious', label: 'Invidious instance' },
  });

  const found = await findInstance({ fetchImpl, detect, exclude: ['https://dead.example/'] });
  assert.equal(found.endpoint, 'https://alive.example');
  assert.ok(!probed.includes('https://dead.example'));
});

test('the bundled list is read once and shared', async () => {
  let reads = 0;
  const fetchImpl = async (url) => {
    if (isBundled(url)) {
      reads += 1;
      return new Response(JSON.stringify({ invidious: ['https://x.example'] }));
    }
    throw new TypeError('Failed to fetch');
  };
  const first = await invidiousInstances({ fetchImpl, fresh: true });
  const second = await invidiousInstances({ fetchImpl });
  assert.deepEqual(first, ['https://x.example']);
  assert.deepEqual(second, first);
  assert.equal(reads, 1);
});

test('a directory that is down falls back to the seed rather than failing', async () => {
  const { fetchImpl, asked } = directories({});
  const { detect, probed } = prober({ [SEED[1]]: { kind: 'piped', label: 'Piped instance' } });

  const found = await findInstance({ fetchImpl, detect });
  assert.equal(found.endpoint, SEED[1]);
  assert.equal(asked.filter((url) => !isBundled(url)).length, DIRECTORIES.length, 'every directory was asked');
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
    "The Invidious instance says: Sign in to confirm you're not a bot",
    'The Invidious instance returned no streams for that video.',
    'Every Invidious instance tried refused that video (4 of them).',
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
    'The Invidious instance says: This video is private.',
    'That YouTube link has no video in it.',
  ]) {
    assert.equal(looksUnreachable(message), false, message);
  }
});
