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
  // It announces itself once it is listening. Match on the accumulated
  // output: a pipe delivers text in arbitrary pieces, and a marker that
  // straddles two chunks is never seen by a per-chunk check — which is a
  // hang, not a failure, and the worse of the two.
  await new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => reject(new Error('relay did not report listening within 10s')), 10_000);
    relay.stdout.on('data', (chunk) => {
      seen += String(chunk);
      if (seen.includes('relay listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    relay.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`relay exited with ${code} before listening`));
    });
  });
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

test('an upstream that drops mid-body does not take the relay down with it', async () => {
  // fetch is replaced before the relay loads: this one answers 64 KB and then
  // breaks the stream, as a CDN connection reset does. With .pipe() that
  // error had no handler and the whole process exited.
  const stub = `data:text/javascript,${encodeURIComponent(`
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(65536));
        setTimeout(() => controller.error(new TypeError('terminated')), 50);
      },
    }), { status: 200 });
  `)}`;
  const port = PORT + 1;
  const dropping = spawn(process.execPath, ['--import', stub, 'relay/serve.mjs'], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    await new Promise((resolve, reject) => {
      let seen = '';
      dropping.stdout.on('data', (chunk) => {
        seen += String(chunk);
        if (seen.includes('relay listening')) resolve();
      });
      dropping.on('exit', (code) => reject(new Error(`relay exited with ${code}`)));
    });
    const target = encodeURIComponent('https://rr1---sn-x.googlevideo.com/videoplayback');
    const response = await fetch(`http://127.0.0.1:${port}/?url=${target}`);
    assert.equal(response.status, 200);
    await assert.rejects(response.arrayBuffer());
    await new Promise((r) => setTimeout(r, 200));
    const after = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(after.status, 400, 'still answering');
    assert.equal(dropping.exitCode, null);
  } finally {
    dropping.kill();
  }
});
