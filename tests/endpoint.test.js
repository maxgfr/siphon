/**
 * One address, and what it turns out to be — with the network stubbed.
 *
 * Each kind of helper answers one small request in a way nothing else does;
 * these pin that the right request is made and the right answer read, and
 * that "nothing here" is an answer rather than an error where it should be.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { detectEndpoint, privacyNote, describeEndpoint } from '../web/endpoint.js';

/** A fetch that answers from a table of path → response, and records what was asked. */
function stub(table) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const hit = Object.entries(table).find(([prefix]) => path.startsWith(prefix));
    if (!hit) throw new TypeError('Failed to fetch');
    const [, answer] = hit;
    const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    return new Response(body, { status: answer.status ?? 200 });
  };
  return { fetchImpl, asked };
}

test('a siphon server is known by its health, ffmpeg and all', async () => {
  const { fetchImpl, asked } = stub({
    '/api/health': { body: { service: 'siphon', ytDlpVersion: '2026.09.01', ffmpeg: false, capabilities: ['jobs', 'resolve', 'tunnel'], lanUrls: ['http://10.0.0.2:8000'], hasCookies: true } },
  });
  const helper = await detectEndpoint('https://ytdl.example/', 'k3y', fetchImpl);
  assert.equal(helper.kind, 'siphon');
  assert.equal(helper.ffmpeg, false);
  assert.deepEqual(helper.capabilities, ['jobs', 'resolve', 'tunnel']);
  assert.deepEqual(helper.lanUrls, ['http://10.0.0.2:8000']);
  assert.equal(helper.hasCookies, true);
  assert.match(helper.label, /2026\.09\.01/);
  // One request was enough, and the trailing slash did not double up.
  assert.deepEqual(asked, ['https://ytdl.example/api/health']);
});

test('a server that wants a key says so rather than looking like something else', async () => {
  const { fetchImpl } = stub({ '/api/health': { status: 401, body: { detail: 'key' } } });
  await assert.rejects(() => detectEndpoint('https://ytdl.example', '', fetchImpl), /access key/i);
});

test('nothing at this page\'s own origin is an answer, not an error', async () => {
  const { fetchImpl } = stub({ '/api/health': { status: 404, body: '<html>not found</html>' } });
  const helper = await detectEndpoint('', '', fetchImpl);
  assert.equal(helper.kind, 'none');
});

test('a cobalt instance is known by its root', async () => {
  const { fetchImpl } = stub({
    '/api/health': { status: 404, body: '' },
    '/': { body: { cobalt: { version: '11.0', url: 'https://api.example' }, git: {} } },
  });
  const helper = await detectEndpoint('https://api.example', '', fetchImpl);
  assert.equal(helper.kind, 'cobalt');
  assert.equal(helper.label, 'cobalt 11.0');
});

test('a Piped instance is known by its config', async () => {
  const { fetchImpl } = stub({
    '/api/health': { status: 404, body: '' },
    '/config': { body: { imageProxyUrl: 'https://proxy.example', donationUrl: null } },
    '/': { status: 404, body: { message: 'Not Found' } },
  });
  const helper = await detectEndpoint('https://pipedapi.example', '', fetchImpl);
  assert.equal(helper.kind, 'piped');
});

test('an Invidious instance is known by its stats', async () => {
  const { fetchImpl } = stub({
    '/api/health': { status: 404, body: '' },
    '/api/v1/stats': { body: { version: '2.20260901.0', software: { name: 'invidious', version: '2.20260901.0', branch: 'master' } } },
    '/config': { status: 404, body: '' },
    '/': { status: 404, body: '<html>Invidious</html>' },
  });
  const helper = await detectEndpoint('https://inv.example', '', fetchImpl);
  assert.equal(helper.kind, 'invidious');
});

test('an Invidious instance with stats switched off is still known, by the sentence it refuses with', async () => {
  // `statistics_enabled: false` is the default in an instance's config, and
  // then the endpoint answers 400 — with a body nothing else on the web says.
  const { fetchImpl } = stub({
    '/api/health': { status: 404, body: '' },
    '/api/v1/stats': { status: 400, body: { error: 'Statistics are not enabled.' } },
    '/config': { status: 404, body: '' },
    '/': { status: 404, body: '' },
  });
  const helper = await detectEndpoint('https://inv.example', '', fetchImpl);
  assert.equal(helper.kind, 'invidious');
});

test('a relay is known by fetching something through it', async () => {
  const { fetchImpl, asked } = stub({
    '/api/health': { status: 404, body: '' },
    '/api/v1/stats': { status: 400, body: { error: 'no url parameter' } },
    '/config': { status: 404, body: '' },
    '/?url=': { body: 'User-agent: *\nDisallow: /comment\n' },
    '/': { status: 400, body: { error: 'no url parameter' } },
  });
  const helper = await detectEndpoint('https://relay.example', '', fetchImpl);
  assert.equal(helper.kind, 'relay');
  assert.ok(asked.some((url) => url.includes('/?url=https%3A%2F%2Fwww.youtube.com%2Frobots.txt')));
});

test('a relay that refuses this origin says what to change', async () => {
  const { fetchImpl } = stub({
    '/api/health': { status: 404, body: '' },
    '/config': { status: 404, body: '' },
    '/?url=': { status: 403, body: { error: 'origin not allowed' } },
    '/': { status: 400, body: {} },
  });
  await assert.rejects(() => detectEndpoint('https://relay.example', '', fetchImpl), /ALLOWED_ORIGINS/);
});

test('an address that answers as none of them is refused with the list', async () => {
  const { fetchImpl } = stub({ '/': { body: '<html>hello</html>' } });
  await assert.rejects(() => detectEndpoint('https://blog.example', '', fetchImpl), /siphon server, a cobalt, Piped or Invidious instance, or a relay/);
});

test('an address nothing answers at is "could not reach", not a guess', async () => {
  const { fetchImpl } = stub({});
  await assert.rejects(() => detectEndpoint('https://down.example', '', fetchImpl), /could not reach/i);
});

test('the sentences follow from the kind', () => {
  assert.match(privacyNote({ kind: 'none' }), /this device/i);
  assert.match(privacyNote({ kind: 'siphon', ffmpeg: true }), /your server/i);
  assert.match(privacyNote({ kind: 'siphon', ffmpeg: false }), /resolves/i);
  assert.match(describeEndpoint({ kind: 'siphon', ffmpeg: false, label: 'yt-dlp 1' }), /no ffmpeg/i);
  assert.match(describeEndpoint({ kind: 'relay' }), /relay/i);
  assert.match(privacyNote({ kind: 'invidious' }), /Invidious instance/);
  assert.match(describeEndpoint({ kind: 'invidious' }), /An Invidious instance/);
  assert.match(describeEndpoint(null), /helper/i);
});
