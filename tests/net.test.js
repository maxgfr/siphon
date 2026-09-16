/**
 * Fetching, when the network misbehaves.
 *
 * A download that dies at 80% and starts again from zero is the difference,
 * on a phone changing cells, between a file that arrives and one that never
 * does. These pin the resume: what is asked for on the second attempt, what
 * happens when the host ignores it, and which failures are worth repeating at
 * all.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { Fetcher } from '../web/net.js';

const bytes = (from, to) => new Uint8Array(Array.from({ length: to - from }, (_, i) => (from + i) % 251));
const WHOLE = bytes(0, 300);

/** A body that hands over `slice`, then either ends or breaks. */
function body(slice, { breakAfter = null } = {}) {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= slice.length) return controller.close();
      if (breakAfter !== null && sent >= breakAfter) {
        return controller.error(new TypeError('network error'));
      }
      const end = Math.min(sent + 64, breakAfter ?? slice.length, slice.length);
      controller.enqueue(slice.slice(sent, end));
      sent = end;
    },
  });
}

/** Stand in for the network, recording every request and its Range header. */
function stubFetch(plan) {
  const asked = [];
  const real = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (url, init = {}) => {
    const range = new Headers(init.headers || {}).get('range');
    asked.push({ url: String(url), range });
    const answer = plan[Math.min(call, plan.length - 1)];
    call += 1;
    return answer(range);
  };
  return { asked, restore: () => { globalThis.fetch = real; } };
}

const ok = (slice, { status = 200, total = WHOLE.length, breakAfter = null, from = 0 } = {}) =>
  new Response(body(slice, { breakAfter }), {
    status,
    headers:
      status === 206
        ? { 'Content-Length': String(slice.length), 'Content-Range': `bytes ${from}-${from + slice.length - 1}/${total}` }
        : { 'Content-Length': String(total) },
  });

test('a stream cut halfway is picked up from where it stopped', async () => {
  const stub = stubFetch([
    // Dies after 128 of 300 bytes, having promised all 300.
    () => ok(WHOLE, { breakAfter: 128 }),
    (range) => {
      assert.equal(range, 'bytes=128-', 'the second attempt asks for the rest, not the whole file');
      return ok(WHOLE.slice(128), { status: 206, from: 128 });
    },
  ]);
  try {
    const out = await new Fetcher().bytes('https://cdn.example/clip.mp4', { attempts: 3 });
    assert.deepEqual(out, WHOLE);
    assert.equal(stub.asked.length, 2);
  } finally {
    stub.restore();
  }
});

test('progress carries on across the break rather than restarting the bar', async () => {
  const seen = [];
  const stub = stubFetch([
    () => ok(WHOLE, { breakAfter: 128 }),
    () => ok(WHOLE.slice(128), { status: 206, from: 128 }),
  ]);
  try {
    await new Fetcher().bytes('https://cdn.example/clip.mp4', {
      attempts: 3,
      onProgress: (received, total) => seen.push([received, total]),
    });
    const received = seen.map(([r]) => r);
    assert.deepEqual(received, [...received].sort((a, b) => a - b), 'never goes backwards');
    assert.equal(received.at(-1), WHOLE.length);
    assert.ok(seen.every(([, total]) => total === WHOLE.length), 'the total is remembered across attempts');
  } finally {
    stub.restore();
  }
});

test('a host that ignores the range makes it start over, not double up', async () => {
  const stub = stubFetch([
    () => ok(WHOLE, { breakAfter: 128 }),
    // 200, not 206: this host does not do ranges and is sending it all again.
    () => ok(WHOLE),
  ]);
  try {
    const out = await new Fetcher().bytes('https://cdn.example/clip.mp4', { attempts: 3 });
    assert.deepEqual(out, WHOLE, 'the kept prefix was dropped rather than prepended twice');
  } finally {
    stub.restore();
  }
});

test('a stream that ends early is a cut, not a short file', async () => {
  // The body simply ends after 100 bytes while content-length promised 300.
  // Nothing throws, so without a length check this would be handed over as if
  // it were the whole file.
  const stub = stubFetch([
    () => new Response(body(WHOLE.slice(0, 100)), { headers: { 'Content-Length': '300' } }),
    () => ok(WHOLE.slice(100), { status: 206, from: 100 }),
  ]);
  try {
    const out = await new Fetcher().bytes('https://cdn.example/clip.mp4', { attempts: 3 });
    assert.equal(out.length, 300);
    assert.deepEqual(out, WHOLE);
  } finally {
    stub.restore();
  }
});

test('a refusal is not repeated', async () => {
  const stub = stubFetch([() => new Response('gone', { status: 404 })]);
  try {
    await assert.rejects(() => new Fetcher().bytes('https://cdn.example/clip.mp4', { attempts: 3 }), /404/);
    assert.equal(stub.asked.length, 1, 'a 404 is an answer, not a hiccup');
  } finally {
    stub.restore();
  }
});

test('a server error is repeated', async () => {
  let calls = 0;
  const stub = stubFetch([
    () => {
      calls += 1;
      return calls === 1 ? new Response('later', { status: 503 }) : ok(WHOLE);
    },
  ]);
  try {
    const out = await new Fetcher().bytes('https://cdn.example/clip.mp4', { attempts: 3 });
    assert.deepEqual(out, WHOLE);
    assert.equal(stub.asked.length, 2);
  } finally {
    stub.restore();
  }
});

test('when the retries are spent the error says how far it got', async () => {
  const stub = stubFetch([() => ok(WHOLE, { breakAfter: 150 })]);
  try {
    await assert.rejects(
      () => new Fetcher().bytes('https://cdn.example/clip.mp4', { attempts: 2 }),
      /kept breaking after \d+%/,
    );
  } finally {
    stub.restore();
  }
});

test('a ranged read asks for its own span and is not confused by the file total', async () => {
  // HLS byte-range segments: the span is what must be reported as the total,
  // not the size of the file the span lives in.
  const stub = stubFetch([
    (range) => {
      assert.equal(range, 'bytes=100-149');
      return ok(WHOLE.slice(100, 150), { status: 206, from: 100, total: 10_000 });
    },
  ]);
  const seen = [];
  try {
    const out = await new Fetcher().bytes('https://cdn.example/clip.mp4', {
      range: { offset: 100, length: 50 },
      onProgress: (received, total) => seen.push([received, total]),
    });
    assert.deepEqual(out, WHOLE.slice(100, 150));
    assert.ok(seen.every(([, total]) => total === 50), `the span is the total, saw ${JSON.stringify(seen)}`);
  } finally {
    stub.restore();
  }
});

test('stream hands chunks over without ever holding the file', async () => {
  const stub = stubFetch([() => ok(WHOLE)]);
  try {
    let count = 0;
    let held = 0;
    const total = await new Fetcher().stream('https://cdn.example/clip.mp4', {
      onChunk: (chunk) => {
        count += 1;
        // A writer to disk keeps nothing; this stands in for one.
        held = Math.max(held, chunk.length);
      },
    });
    assert.equal(total, WHOLE.length);
    assert.ok(count > 1, 'arrived in pieces');
    assert.ok(held < WHOLE.length, 'no single piece was the whole file');
  } finally {
    stub.restore();
  }
});

test('a reset tells the writer to throw away what it has', async () => {
  const stub = stubFetch([
    () => ok(WHOLE, { breakAfter: 128 }),
    () => ok(WHOLE),
  ]);
  try {
    let written = 0;
    let resets = 0;
    await new Fetcher().stream('https://cdn.example/clip.mp4', {
      attempts: 3,
      onChunk: (chunk) => {
        written += chunk.length;
      },
      onReset: () => {
        resets += 1;
        written = 0;
      },
    });
    assert.equal(resets, 1);
    assert.equal(written, WHOLE.length, 'the file on disk is the file, not the file plus a prefix');
  } finally {
    stub.restore();
  }
});
