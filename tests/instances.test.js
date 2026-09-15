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

import { findInstance, DIRECTORIES, SEED } from '../web/instances.js';

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
