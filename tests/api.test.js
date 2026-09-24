/**
 * The one backend, as the header and the queue see it.
 *
 * What the header says is in use, and what happens to a link when the helper
 * that should take it is not there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.location ??= new URL('https://maxgfr.github.io/siphon/');
const { Siphon } = await import('../web/api.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A network where your server at home.example is `server`, and every other host serves `file` to a page. */
async function withNetwork({ server, file }, run) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith('https://home.example')) return server(String(url), init);
    const headers = { 'Content-Type': 'video/mp4', 'Content-Length': String(file.length) };
    return new Response(init.method === 'HEAD' ? null : file, { status: 200, headers });
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
}

const FULL = { kind: 'siphon', label: 'yt-dlp 2026.09.01', ffmpeg: true };
const unreachable = () => {
  throw new TypeError('Failed to fetch');
};

test('with your server out of reach, a file this device can read is downloaded here, and the row says so', async () => {
  // Away from home, or with the tunnel down, every link failed with "Could
  // not reach the server" — a plain file the page could fetch by itself too.
  const file = new Uint8Array(1000).fill(7);
  await withNetwork({ server: unreachable, file }, async () => {
    const siphon = new Siphon({ endpoint: 'https://home.example', helper: FULL });
    const probe = await siphon.probe('https://cdn.example/clip.mp4');
    assert.equal(probe.title, 'clip');
    const started = await siphon.start('https://cdn.example/clip.mp4', 'video_best');
    assert.match(started.id, /^b-/);
    let job;
    for (let i = 0; i < 100; i += 1) {
      job = await siphon.poll(started.id);
      if (job.state !== 'running') break;
      await sleep(20);
    }
    assert.equal(job.state, 'done', job.error);
    assert.match(job.note, /on this device: your server could not be reached/);
  });
});

test('but a server that answers is never passed over, and neither is what it said', async () => {
  const file = new Uint8Array(1000).fill(7);
  const refusing = () => new Response(JSON.stringify({ detail: 'This server needs an access key.' }), { status: 401 });
  await withNetwork({ server: refusing, file }, async () => {
    const siphon = new Siphon({ endpoint: 'https://home.example', helper: FULL });
    await assert.rejects(() => siphon.start('https://cdn.example/clip.mp4', 'video_best'), /needs an access key/);
  });
  // Out of reach, and a link the device cannot read either: the server's
  // absence is the reason, not what the device made of the link.
  await withNetwork({ server: unreachable, file }, async () => {
    const siphon = new Siphon({ endpoint: 'https://home.example', helper: FULL });
    siphon.device.identify = async () => {
      throw new Error('YouTube will not talk to a web page directly.');
    };
    await assert.rejects(() => siphon.start('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'video_best'), /Could not reach the server/);
  });
});

test('a server saved without the key it wants says so in the header', async () => {
  // Adopted on a first visit at a server started with AUTH_TOKEN: the header
  // said "your server", as if it worked, until the first link failed.
  const health = () => new Response(JSON.stringify({ service: 'siphon', ytDlpVersion: '2026.09.01', ffmpeg: true, requiresKey: true }), { status: 200 });
  await withNetwork({ server: health, file: new Uint8Array(1) }, async () => {
    const keyed = await new Siphon({ endpoint: 'https://home.example', helper: { ...FULL, keyAccepted: false } }).health();
    assert.match(keyed.label, /your server/);
    assert.match(keyed.label, /access key/);
    const fine = await new Siphon({ endpoint: 'https://home.example', helper: { ...FULL, keyAccepted: true } }).health();
    assert.doesNotMatch(fine.label, /access key/);
  });
});

test('the header names the bridge when it is installed, and asks for an older one to be updated', async () => {
  // Used ahead of any helper, and never named: "no helper" read exactly like
  // a bridge that was not running.
  const siphon = new Siphon({});
  assert.match((await siphon.health()).label, /no helper/);
  siphon.device.net.bridge = { ready: true, version: '1.2.0', request: null };
  const label = (await siphon.health()).label;
  assert.match(label, /bridge 1\.2\.0/);
  assert.doesNotMatch(label, /no helper|update/);
  siphon.device.net.bridge = { ready: true, version: '1.1.0', request: null };
  assert.match((await siphon.health()).label, /bridge 1\.1\.0, update it/);
  assert.equal(siphon.hasBridge, true);
});
