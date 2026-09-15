/**
 * The Node bridge around the relay, as a running process.
 *
 * relay.test.js covers what the worker decides; this covers that those
 * decisions survive the trip through Node's http server — status, headers and
 * body — which is what CI and a local user actually talk to. Nothing here
 * needs the network: every case is answered by the worker before any upstream
 * fetch would happen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const PORT = 18787;
const BASE = `http://127.0.0.1:${PORT}`;
let relay;

test.before(async () => {
  relay = spawn(process.execPath, ['relay/serve.mjs'], {
    env: { ...process.env, PORT: String(PORT), ALLOWED_ORIGINS: 'https://maxgfr.github.io' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  // It announces itself once it is listening; that line is the ready signal.
  for await (const chunk of relay.stdout) {
    if (String(chunk).includes('relay listening')) break;
  }
});

test.after(() => {
  relay.kill();
  return once(relay, 'exit');
});

test('a preflight comes back through Node with the reflected headers', async () => {
  const response = await fetch(`${BASE}/?url=${encodeURIComponent('https://www.youtube.com/x')}`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://maxgfr.github.io', 'Access-Control-Request-Headers': 'x-goog-visitor-id' },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-headers'), 'x-goog-visitor-id');
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://maxgfr.github.io');
});

test('the origin allow-list is read from the environment', async () => {
  const response = await fetch(`${BASE}/?url=${encodeURIComponent('https://www.youtube.com/x')}`, {
    headers: { Origin: 'https://someone-else.example' },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'origin not allowed');
});

test('a refused host is a JSON 403, body intact', async () => {
  const response = await fetch(`${BASE}/?url=${encodeURIComponent('https://evil.example/x')}`, {
    headers: { Origin: 'https://maxgfr.github.io' },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'host not allowed');
});

test('a missing target is a 400', async () => {
  const response = await fetch(`${BASE}/`, { headers: { Origin: 'https://maxgfr.github.io' } });
  assert.equal(response.status, 400);
});

test('a POST body is accepted by the bridge rather than rejected for lack of duplex', async () => {
  // Refused by the host allow-list, which is fine: the point is that Node
  // built a Request with a streaming body and the worker read it far enough
  // to answer, instead of throwing on construction.
  const response = await fetch(`${BASE}/?url=${encodeURIComponent('https://evil.example/x')}`, {
    method: 'POST',
    headers: { Origin: 'https://maxgfr.github.io', 'Content-Type': 'application/json' },
    body: '{"a":1}',
  });
  assert.equal(response.status, 403);
});
