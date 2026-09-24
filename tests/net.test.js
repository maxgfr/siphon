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
import { readFileSync } from 'node:fs';

import { Fetcher, relayEscape, relayTarget, isRelayTemplate } from '../web/net.js';

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

test('a reconnect that fails outright is the network, not a refusal, and is tried again', async () => {
  // A phone between cells: the stream breaks, and the first attempt to pick
  // it up cannot connect at all. The browser reports that with the same
  // TypeError it uses for a CORS refusal — but this host has just answered
  // the page, so it is not refusing it, and the resume must go on.
  const stub = stubFetch([
    () => ok(WHOLE, { breakAfter: 128 }),
    () => {
      throw new TypeError('Failed to fetch');
    },
    () => ok(WHOLE.slice(128), { status: 206, from: 128 }),
  ]);
  try {
    const out = await new Fetcher().bytes('https://cdn.example/clip.mp4', { attempts: 4 });
    assert.deepEqual(out, WHOLE);
    assert.equal(stub.asked.length, 3);
    assert.equal(stub.asked[2].range, 'bytes=128-', 'and it still resumed from where it stopped');
  } finally {
    stub.restore();
  }
});

test('a host never heard from that the browser refuses is a refusal, said once', async () => {
  const stub = stubFetch([
    () => {
      throw new TypeError('Failed to fetch');
    },
  ]);
  try {
    await assert.rejects(
      () => new Fetcher().bytes('https://cdn.example/clip.mp4', { attempts: 3 }),
      (error) => /does not let a web page/.test(error.message) && error.retryable === false,
    );
    assert.equal(stub.asked.length, 1);
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

/** A response as fetch hands it back after following a redirect. */
const redirected = (text, to) => {
  const response = new Response(text);
  Object.defineProperty(response, 'redirected', { value: true });
  Object.defineProperty(response, 'url', { value: to });
  return response;
};

test('a document that was redirected is relative to where it landed', async () => {
  const stub = stubFetch([() => redirected('#EXTM3U', 'https://cdn.example/path/master.m3u8')]);
  try {
    const doc = await new Fetcher().document('https://short.example/master.m3u8');
    assert.equal(doc.text, '#EXTM3U');
    assert.equal(doc.url, 'https://cdn.example/path/master.m3u8');
  } finally {
    stub.restore();
  }
});

test('through a relay, the address reported is the relay\'s, so the one asked for is kept', async () => {
  const stub = stubFetch([
    () => {
      throw new TypeError('Failed to fetch');
    },
    () => redirected('#EXTM3U', 'https://relay.example/?url=elsewhere'),
  ]);
  try {
    const doc = await new Fetcher({ escape: relayEscape('https://relay.example') }).document('https://short.example/master.m3u8');
    assert.equal(doc.url, 'https://short.example/master.m3u8');
  } finally {
    stub.restore();
  }
});

test('through a relay that says where the request landed, that is where the links are relative to', async () => {
  // The relay follows redirects itself, so only it knows the final address:
  // a short link to a playlist on a CDN names its variants relative to the
  // CDN, and resolved against the short link they are all 404s.
  const stub = stubFetch([
    () => {
      throw new TypeError('Failed to fetch');
    },
    () => new Response('#EXTM3U', { headers: { 'X-Siphon-Final-URL': 'https://cdn.example/hls/42/master.m3u8' } }),
  ]);
  try {
    const doc = await new Fetcher({ escape: relayEscape('https://relay.example') }).document('https://short.example/v/42.m3u8');
    assert.equal(doc.url, 'https://cdn.example/hls/42/master.m3u8');
  } finally {
    stub.restore();
  }
});

test('the first bytes of a file are read without the rest, even from a host that ignores the range', async () => {
  // Telling an unnamed application/octet-stream file apart takes a few bytes.
  // A host that answers the range with the whole file must not have all of
  // it pulled through: this body never ends, so draining it would hang.
  let pulled = 0;
  const endless = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(64).fill(7));
    },
  });
  const stub = stubFetch([() => new Response(endless, { status: 200 })]);
  try {
    const head = await new Fetcher().prefix('https://files.example/d/1', { length: 100 });
    assert.equal(head.length, 100);
    assert.equal(stub.asked[0].range, 'bytes=0-99');
    assert.ok(pulled < 10, `read ${pulled} chunks`);
  } finally {
    stub.restore();
  }
});

test('a peek at a host that refuses HEAD and ignores the range does not pull the file through', async () => {
  // `/download.php?id=7`: 405 to HEAD, and the whole file to a one-byte GET.
  // Identifying the link needs its headers, not a copy of it in the tab.
  const CHUNK = 64 * 1024;
  const SIZE = 32 * 1024 * 1024;
  let pulled = 0;
  const whole = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(CHUNK));
      if (pulled * CHUNK >= SIZE) controller.close();
    },
  });
  const stub = stubFetch([
    () => new Response(null, { status: 405 }),
    () => new Response(whole, { status: 200, headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(SIZE) } }),
  ]);
  try {
    const head = await new Fetcher().peek('https://files.example/download.php?id=7');
    assert.equal(head.type, 'video/mp4');
    assert.equal(head.length, SIZE);
    assert.equal(stub.asked[1].range, 'bytes=0-0');
    assert.ok(pulled < 10, `read ${pulled} chunks of the body`);
  } finally {
    stub.restore();
  }
});

/* ------------------------------------------------------------ relay shapes */

test('a relay address is a base of ours or a template of anyone\'s', () => {
  assert.equal(isRelayTemplate('https://mine.workers.dev'), false);
  assert.equal(isRelayTemplate('https://corsproxy.io/?url={url}'), true);
  assert.equal(relayTarget('https://mine.workers.dev/', 'https://a.b/c?d=1'), 'https://mine.workers.dev/?url=https%3A%2F%2Fa.b%2Fc%3Fd%3D1');
  assert.equal(relayTarget('https://corsproxy.io/?url={url}', 'https://a.b/c?d=1'), 'https://corsproxy.io/?url=https%3A%2F%2Fa.b%2Fc%3Fd%3D1');
  assert.equal(relayTarget('https://cors.eu.org/{raw}', 'https://a.b/c'), 'https://cors.eu.org/https://a.b/c');
  assert.equal(relayEscape('https://cors.eu.org/{raw}').via('https://a.b/c'), 'https://cors.eu.org/https://a.b/c');
  assert.equal(relayEscape(''), null);
});

/* ------------------------------------------------------------ the escapes */

test('a relay and the bridge reach any host; a tunnel reaches only what its server resolved', () => {
  assert.equal(new Fetcher().hasOpenEscape, false, 'nothing set');
  assert.equal(new Fetcher({ escape: relayEscape('https://relay.example') }).hasOpenEscape, true);
  const tunnel = new Fetcher({ escape: { name: 'tunnel', via: (url) => `https://ytdl.example/api/tunnel?url=${encodeURIComponent(url)}` } });
  assert.equal(tunnel.hasEscape, true, 'a tunnel is an escape for the hosts it was told about');
  assert.equal(tunnel.hasOpenEscape, false, 'but not for YouTube\'s own API, which no resolve names');
});

/** A host that refuses the page, then whatever the escape answers. */
const throughEscape = (answer) => stubFetch([
  () => {
    throw new TypeError('Failed to fetch');
  },
  answer,
]);
const TUNNEL = { name: 'tunnel', via: (url) => `https://ytdl.example/api/tunnel?url=${encodeURIComponent(url)}` };

test('a 403 the host sent through the relay is the host\'s answer, not the relay refusing', async () => {
  // googlevideo refusing a link bound to another IP, carried as it came. The
  // relay went there as asked; ALLOWED_HOSTS has nothing to do with it.
  for (const escape of [relayEscape('https://relay.example'), TUNNEL]) {
    const stub = throughEscape(() => new Response('denied', { status: 403 }));
    try {
      const error = await new Fetcher({ escape }).text('https://cdn.example/clip.mp4').catch((e) => e);
      assert.equal(error.message, 'cdn.example answered 403.', escape.name);
      assert.doesNotMatch(`${error.message} ${error.hint}`, /refused|ALLOWED_HOSTS|resolved itself/, escape.name);
      assert.equal(stub.asked.length, 2);
    } finally {
      stub.restore();
    }
  }
});

test('the relay\'s own refusal, which it marks as its own, says what to change', async () => {
  const marked = (reason) => () =>
    new Response(JSON.stringify({ error: reason }), { status: 403, headers: { 'X-Relay-Error': reason } });
  let stub = throughEscape(marked('host not allowed'));
  try {
    const error = await new Fetcher({ escape: relayEscape('https://relay.example') }).text('https://cdn.example/clip.mp4').catch((e) => e);
    assert.equal(error.message, 'The relay refused to fetch that address.');
    assert.match(error.hint, /ALLOWED_HOSTS/);
    assert.equal(error.retryable, false);
  } finally {
    stub.restore();
  }
  // A relay that no longer takes this page is fixed in another list.
  stub = throughEscape(marked('origin not allowed'));
  try {
    const error = await new Fetcher({ escape: relayEscape('https://relay.example') }).text('https://cdn.example/clip.mp4').catch((e) => e);
    assert.equal(error.message, 'The relay refused to fetch that address.');
    assert.match(error.hint, /ALLOWED_ORIGINS/);
    assert.doesNotMatch(error.hint, /ALLOWED_HOSTS/);
  } finally {
    stub.restore();
  }
  stub = throughEscape(marked('not a host this server resolved'));
  try {
    const error = await new Fetcher({ escape: TUNNEL }).text('https://cdn.example/clip.mp4').catch((e) => e);
    assert.equal(error.message, 'The server refused to fetch that address.');
    assert.match(error.hint, /hosts it resolved itself/);
    assert.equal(error.retryable, false);
  } finally {
    stub.restore();
  }
});

test('a 502 the relay marks as its own is the host out of its reach, and worth another try', async () => {
  const unreachable = () => new Response('{"error":"upstream: connect ECONNREFUSED"}', { status: 502, headers: { 'X-Relay-Error': 'upstream: connect ECONNREFUSED' } });
  let stub = throughEscape(unreachable);
  try {
    const error = await new Fetcher({ escape: relayEscape('https://relay.example') }).text('https://cdn.example/clip.mp4').catch((e) => e);
    assert.equal(error.message, 'The relay could not reach cdn.example.');
    assert.doesNotMatch(error.message, /answered 502/);
    assert.equal(error.retryable, true);
  } finally {
    stub.restore();
  }
  // And a download through it is tried again rather than given up.
  stub = stubFetch([
    () => {
      throw new TypeError('Failed to fetch');
    },
    unreachable,
    () => ok(WHOLE),
  ]);
  try {
    const out = await new Fetcher({ escape: relayEscape('https://relay.example') }).bytes('https://cdn.example/clip.mp4', { attempts: 3 });
    assert.deepEqual(out, WHOLE);
    assert.equal(stub.asked.length, 3);
  } finally {
    stub.restore();
  }
});

test('a refusal from a relay or a server from before the mark is still named as theirs', async () => {
  // A relay deployed last month, or a server image from before its answers
  // were marked, refuses with its own body and no header. Taken for the
  // host's, "host not allowed" read as the site itself turning the page away.
  const unmarked = (answer) => () =>
    new Response(JSON.stringify(answer), { status: 403, headers: { 'Content-Type': 'application/json' } });
  let stub = throughEscape(unmarked({ error: 'host not allowed' }));
  try {
    const error = await new Fetcher({ escape: relayEscape('https://relay.example') }).text('https://cdn.example/clip.mp4').catch((e) => e);
    assert.equal(error.message, 'The relay refused to fetch that address.');
    assert.match(error.hint, /ALLOWED_HOSTS/);
    assert.equal(error.retryable, false);
  } finally {
    stub.restore();
  }
  stub = throughEscape(unmarked({ error: 'origin not allowed' }));
  try {
    const error = await new Fetcher({ escape: relayEscape('https://relay.example') }).text('https://cdn.example/clip.mp4').catch((e) => e);
    assert.equal(error.message, 'The relay refused to fetch that address.');
    assert.match(error.hint, /ALLOWED_ORIGINS/);
  } finally {
    stub.restore();
  }
  stub = throughEscape(unmarked({ detail: 'Not a host this server resolved. Resolve the link first.' }));
  try {
    const error = await new Fetcher({ escape: TUNNEL }).text('https://rr1---sn-abc.googlevideo.com/videoplayback').catch((e) => e);
    assert.equal(error.message, 'The server refused to fetch that address.');
    assert.match(error.hint, /hosts it resolved itself/);
  } finally {
    stub.restore();
  }
  // Anything else unmarked is still the host's own answer.
  for (const answer of [() => new Response('denied', { status: 403 }), unmarked({ error: 'Forbidden' })]) {
    stub = throughEscape(answer);
    try {
      const error = await new Fetcher({ escape: relayEscape('https://relay.example') }).text('https://cdn.example/clip.mp4').catch((e) => e);
      assert.equal(error.message, 'cdn.example answered 403.');
    } finally {
      stub.restore();
    }
  }
});

test('once its retries are spent, a download does not promise that Try again resumes it', async () => {
  // Try again is a new download, from the first byte: only the retries
  // inside one pick up where the last broke off.
  const promise = /resumes rather than starting over/;
  let stub = stubFetch([() => ok(WHOLE, { breakAfter: 150 })]);
  try {
    const error = await new Fetcher().bytes('https://cdn.example/clip.mp4', { attempts: 2 }).catch((e) => e);
    assert.match(error.message, /kept breaking/);
    assert.doesNotMatch(error.hint, promise);
  } finally {
    stub.restore();
  }
  stub = stubFetch([() => {
    throw new TypeError('Failed to fetch');
  }]);
  try {
    const net = new Fetcher();
    net.verdicts.set('https://cdn.example', 'direct');
    const error = await net.request('https://cdn.example/clip.mp4').catch((e) => e);
    assert.match(error.message, /Lost the connection/);
    assert.doesNotMatch(error.hint, promise);
  } finally {
    stub.restore();
  }
  stub = throughEscape(() => new Response('{}', { status: 502, headers: { 'X-Relay-Error': 'upstream: connect ECONNREFUSED' } }));
  try {
    const error = await new Fetcher({ escape: relayEscape('https://relay.example') }).text('https://cdn.example/clip.mp4').catch((e) => e);
    assert.match(error.message, /could not reach/);
    assert.doesNotMatch(error.hint, promise);
  } finally {
    stub.restore();
  }
});

/* ------------------------------------------------------------- the bridge */

const USERSCRIPT = readFileSync(new URL('../bridge/siphon-bridge.user.js', import.meta.url), 'utf8');

/**
 * The page and the userscript, with nothing between them but a window.
 *
 * The userscript is the shipped file, run as a manager runs it: handed a
 * GM_xmlhttpRequest. That one is played here by a host serving `file`, which
 * answers as a userscript manager does — once, whole, when the last byte is
 * in — and honours a Range header unless told not to. Every request it was
 * asked for is recorded, with whether it was called off.
 */
function bridged(file, { ignoreRange = false, failOn = null, finalUrl = null, perRequestMs = 0, encoding = null } = {}) {
  const win = new EventTarget();
  win.postMessage = (data, _origin, transfer = []) => {
    const copy = structuredClone(data, { transfer });
    setTimeout(() => {
      const event = new Event('message');
      Object.defineProperties(event, { data: { value: copy }, source: { value: win } });
      win.dispatchEvent(event);
    }, 0);
  };
  const asked = [];
  const gm = (options) => {
    const request = { url: options.url, range: options.headers?.Range || options.headers?.range || null, aborted: false };
    asked.push(request);
    // A file and a delay for each host, when they are given as functions of the URL.
    const source = typeof file === 'function' ? file(options.url) : file;
    const timer = setTimeout(() => {
      if (failOn?.(asked.length, request)) return options.onerror?.({ error: 'connection reset' });
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.range || '');
      let status = 200;
      let body = source;
      const headers = [`content-type: video/mp4`];
      if (match && !ignoreRange) {
        const from = Number(match[1]);
        const to = Math.min(match[2] ? Number(match[2]) : source.length - 1, source.length - 1);
        status = 206;
        body = source.subarray(from, to + 1);
        headers.push(`content-range: bytes ${from}-${to}/${source.length}`);
      }
      if (encoding) headers.push(`content-encoding: ${encoding}`);
      headers.push(`content-length: ${body.length}`);
      const response = body.slice().buffer;
      options.onload?.({ status, statusText: '', responseHeaders: headers.join('\r\n'), response, finalUrl: finalUrl || options.url });
    }, typeof perRequestMs === 'function' ? perRequestMs(options.url) : perRequestMs);
    return {
      abort: () => {
        request.aborted = true;
        clearTimeout(timer);
      },
    };
  };
  globalThis.window = win;
  new Function('window', 'GM_xmlhttpRequest', USERSCRIPT)(win, gm);
  return { asked, done: () => delete globalThis.window };
}

/** A Fetcher whose bridge has announced itself, and which knows the host refuses the page. */
async function bridgeFetcher(url) {
  const net = new Fetcher();
  for (let i = 0; i < 50 && !net.hasBridge; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(net.hasBridge, 'the bridge announced itself');
  net.verdicts.set(new URL(url).origin, 'bridge');
  return net;
}

const MB = 1024 * 1024;
const FILE = new Uint8Array(24 * MB).map((_, i) => i % 253);

test('a file through the bridge arrives a window at a time, not whole at the end', async () => {
  // A userscript manager answers a request only once it has all of it. Asked
  // for in one request, a 1 GB video showed 0% until the end, sat whole in the
  // manager and then in the page, and could not be resumed part-way.
  const bridge = bridged(FILE);
  try {
    const net = await bridgeFetcher('https://media.example/clip.mp4');
    const progress = [];
    let largest = 0;
    const parts = [];
    await net.stream('https://media.example/clip.mp4', {
      onChunk: (chunk) => {
        largest = Math.max(largest, chunk.length);
        parts.push(chunk);
      },
      onProgress: (received, total) => progress.push([received, total]),
    });
    assert.deepEqual(Buffer.concat(parts), Buffer.from(FILE));
    assert.ok(progress.length > 2, `progress moved ${progress.length} times`);
    assert.ok(progress.every(([, total]) => total === FILE.length), 'and knew the total from the first window');
    assert.ok(largest <= 8 * MB, `no piece larger than a window: the largest was ${largest} bytes`);
    assert.ok(bridge.asked.every((request) => /^bytes=\d+-\d+$/.test(request.range || '')), JSON.stringify(bridge.asked.map((r) => r.range)));
  } finally {
    bridge.done();
  }
});

test('cancelling a download through the bridge stops the request in the manager', async () => {
  const bridge = bridged(FILE, { perRequestMs: 20 });
  try {
    const net = await bridgeFetcher('https://media.example/clip.mp4');
    const controller = new AbortController();
    // Cancelled while the second window is on its way, 5 ms into its 20.
    const download = net.stream('https://media.example/clip.mp4', {
      signal: controller.signal,
      onChunk: () => {},
      onProgress: () => setTimeout(() => controller.abort(), 5),
    });
    await assert.rejects(download, { name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(bridge.asked.some((request) => request.aborted), 'the request in flight was called off');
    const asked = bridge.asked.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(bridge.asked.length, asked, 'and nothing more was asked for');
  } finally {
    bridge.done();
  }
});

test('a download through the bridge cut part-way resumes from the last window, not from zero', async () => {
  // The fourth request fails, as a connection dropping near the end does.
  const bridge = bridged(FILE, { failOn: (count) => count === 4 });
  try {
    const net = await bridgeFetcher('https://media.example/clip.mp4');
    const out = await net.bytes('https://media.example/clip.mp4', { attempts: 3 });
    assert.deepEqual(Buffer.from(out), Buffer.from(FILE));
    const broke = Number(/^bytes=(\d+)-/.exec(bridge.asked[3].range)[1]);
    const next = bridge.asked[4]?.range || '';
    assert.ok(broke > 0 && next.startsWith(`bytes=${broke}-`), `it asked again from the window that broke (${broke}), not from zero: ${next}`);
  } finally {
    bridge.done();
  }
});

test('a host that ignores the range through the bridge is taken whole, once', async () => {
  const small = FILE.subarray(0, 3 * MB);
  const bridge = bridged(small, { ignoreRange: true });
  try {
    const net = await bridgeFetcher('https://media.example/clip.mp4');
    const out = await net.bytes('https://media.example/clip.mp4');
    assert.deepEqual(Buffer.from(out), Buffer.from(small));
    assert.equal(bridge.asked.length, 1);
  } finally {
    bridge.done();
  }
});

test('a compressed file through the bridge is not pieced together from compressed ranges', async () => {
  // The manager decodes what it is sent, so a window of a gzip body is not a
  // window of the file. That answer means one request for the whole, as ever.
  const bridge = bridged(FILE, { encoding: 'gzip' });
  try {
    const net = await bridgeFetcher('https://media.example/data.json');
    const out = await net.bytes('https://media.example/data.json');
    assert.deepEqual(Buffer.from(out), Buffer.from(FILE));
    assert.equal(bridge.asked.length, 2);
    assert.match(bridge.asked[0].range, /^bytes=0-\d+$/);
    assert.equal(bridge.asked[1].range, null, 'the second time, whole');
  } finally {
    bridge.done();
  }
});

test('a playlist through the bridge is relative to where its redirect landed', async () => {
  const playlist = new TextEncoder().encode('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv360/index.m3u8\n');
  const bridge = bridged(playlist, { finalUrl: 'https://cdn.example/hls/42/master.m3u8' });
  try {
    const net = await bridgeFetcher('https://short.example/v/42.m3u8');
    const doc = await net.document('https://short.example/v/42.m3u8');
    assert.equal(doc.url, 'https://cdn.example/hls/42/master.m3u8');
    assert.equal(new URL('v360/index.m3u8', doc.url).href, 'https://cdn.example/hls/42/v360/index.m3u8');
  } finally {
    bridge.done();
  }
});

test('two Fetchers on one page, as a settings save leaves them, each get their own answers', async () => {
  // A running download keeps the Fetcher it started with and the next one
  // gets a new one. Each counted its requests from 1 on the same window, so
  // the first answer for a number settled both: a download was handed
  // another's bytes, and saved as Ready.
  const A = new Uint8Array(1000).fill(0xaa);
  const B = new Uint8Array(1000).fill(0xbb);
  const bridge = bridged((url) => (url.includes('a.example') ? A : B), { perRequestMs: (url) => (url.includes('a.example') ? 5 : 80) });
  try {
    const running = await bridgeFetcher('https://a.example/a.bin');
    const next = await bridgeFetcher('https://a.example/a.bin');
    running.verdicts.set('https://b.example', 'bridge');
    await running.bytes('https://a.example/a.bin');
    const slow = running.bytes('https://b.example/b.bin');
    await next.bytes('https://a.example/a.bin');
    const fast = next.bytes('https://a.example/a.bin');
    const [got, other] = await Promise.all([slow, fast]);
    assert.deepEqual([got[0], got.length], [0xbb, 1000], 'the running download got its own file');
    assert.deepEqual([other[0], other.length], [0xaa, 1000]);
  } finally {
    bridge.done();
  }
});
