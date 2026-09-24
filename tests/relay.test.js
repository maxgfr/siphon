/**
 * The relay, run for real — just not on Cloudflare.
 *
 * `relay/worker.js` is a standard module with a `fetch(request, env)` export
 * and nothing Workers-specific in it, so Node can call it directly with the
 * same Request and Response classes the platform would. What that cannot test
 * is how YouTube answers; what it can test is everything the relay decides on
 * its own, which is the half with the security properties in it.
 *
 * Upstream is stubbed rather than reached, which is deliberate: it makes the
 * headers the relay chooses to forward directly observable, where a live
 * request would only show the end result.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import zlib from 'node:zlib';

import worker from '../relay/worker.js';

const ORIGIN = 'https://maxgfr.github.io';
const realFetch = globalThis.fetch;

/** Stand in for the network, and record exactly what the relay asked it for. */
function stubUpstream(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, headers: new Headers(init?.headers || {}) });
    return handler ? handler(url, init) : new Response('upstream body', { status: 200 });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = real;
    },
  };
}

const call = (url, { method = 'GET', headers = {}, body, env = {} } = {}) =>
  worker.fetch(new Request(url, { method, headers, body, duplex: body ? 'half' : undefined }), env);

const relayUrl = (target) => `https://relay.example.workers.dev/?url=${encodeURIComponent(target)}`;
const YT = 'https://www.youtube.com/youtubei/v1/player';

/* ------------------------------------------------------------------ preflight */

test('a preflight is answered without touching the network', async () => {
  const upstream = stubUpstream();
  try {
    const response = await call(relayUrl(YT), {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Headers': 'content-type,x-goog-visitor-id' },
    });
    assert.equal(response.status, 204);
    assert.equal(upstream.calls.length, 0);
    assert.match(response.headers.get('access-control-allow-methods'), /POST/);
    // Reflected rather than listed: youtubei.js sends a moving set of
    // x-goog-* headers and an allow-list would break each time it adds one.
    assert.equal(response.headers.get('access-control-allow-headers'), 'content-type,x-goog-visitor-id');
  } finally {
    upstream.restore();
  }
});

/* ----------------------------------------------------------------- the guards */

test('a host outside the allow-list is refused, and never fetched', async () => {
  const upstream = stubUpstream();
  try {
    const response = await call(relayUrl('https://evil.example/secret'));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'host not allowed');
    assert.equal(upstream.calls.length, 0);
  } finally {
    upstream.restore();
  }
});

test('a lookalike hostname does not pass the suffix match', async () => {
  const upstream = stubUpstream();
  try {
    for (const host of ['https://youtube.com.evil.example/x', 'https://notyoutube.com/x', 'https://evilyoutube.com/x']) {
      const response = await call(relayUrl(host));
      assert.equal(response.status, 403, host);
    }
    assert.equal(upstream.calls.length, 0);
  } finally {
    upstream.restore();
  }
});

test('a subdomain of an allowed host is allowed, because that is the point', async () => {
  const upstream = stubUpstream();
  try {
    const response = await call(relayUrl('https://rr3---sn-4g5e6nez.googlevideo.com/videoplayback?x=1'));
    assert.equal(response.status, 200);
    assert.equal(upstream.calls.length, 1);
  } finally {
    upstream.restore();
  }
});

test('an unset origin allow-list answers anyone, and a set one answers only those', async () => {
  const upstream = stubUpstream();
  try {
    const open = await call(relayUrl(YT), { headers: { Origin: 'https://anyone.example' } });
    assert.equal(open.status, 200);
    assert.equal(open.headers.get('access-control-allow-origin'), '*');

    const env = { ALLOWED_ORIGINS: ORIGIN };
    const refused = await call(relayUrl(YT), { headers: { Origin: 'https://someone-else.example' }, env });
    assert.equal(refused.status, 403);
    assert.equal((await refused.json()).error, 'origin not allowed');

    const allowed = await call(relayUrl(YT), { headers: { Origin: ORIGIN }, env });
    assert.equal(allowed.status, 200);
    // Echoed, not `*`: the answer is specific to the page that asked.
    assert.equal(allowed.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(allowed.headers.get('vary'), 'Origin');
  } finally {
    upstream.restore();
  }
});

test("the page's address in ALLOWED_ORIGINS admits the page, since a browser sends only its origin", async () => {
  // https://you.github.io/siphon/, copied from the address bar as the READMEs
  // said, was compared as written with an Origin that never has a path, and
  // locked the page out of its own relay.
  const upstream = stubUpstream();
  try {
    for (const setting of ['https://maxgfr.github.io/siphon/', 'https://maxgfr.github.io/', 'HTTPS://MAXGFR.GITHUB.IO', 'https://maxgfr.github.io:443']) {
      const env = { ALLOWED_ORIGINS: setting };
      const allowed = await call(relayUrl(YT), { headers: { Origin: ORIGIN }, env });
      assert.equal(allowed.status, 200, setting);
      assert.equal(allowed.headers.get('access-control-allow-origin'), ORIGIN, setting);
      const refused = await call(relayUrl(YT), { headers: { Origin: 'https://evil.example' }, env });
      assert.equal(refused.status, 403, setting);
    }
  } finally {
    upstream.restore();
  }
});

test('ALLOWED_ORIGINS=* answers anyone, as it does on the server', async () => {
  const upstream = stubUpstream();
  try {
    const response = await call(relayUrl(YT), { headers: { Origin: 'https://anyone.example' }, env: { ALLOWED_ORIGINS: '*' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  } finally {
    upstream.restore();
  }
});

test("the relay's own refusals are marked, so a page can tell them from a host's 403", async () => {
  // googlevideo answers 403 for a link bound to another IP; the allow-list
  // answers 403 for a host it does not carry. Only the second is fixed by
  // editing ALLOWED_HOSTS, and the status alone cannot say which it was.
  const upstream = stubUpstream((url) =>
    String(url).includes('googlevideo')
      ? new Response('forbidden by google', { status: 403, headers: { 'X-Relay-Error': 'spoofed' } })
      : new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/x' } }),
  );
  try {
    const env = { ALLOWED_ORIGINS: ORIGIN };
    for (const [target, headers, reason] of [
      [YT, { Origin: 'https://someone-else.example' }, 'origin not allowed'],
      ['https://evil.example/x', { Origin: ORIGIN }, 'host not allowed'],
      ['http://10.0.0.1/x', { Origin: ORIGIN }, 'not a public address'],
      [YT, { Origin: ORIGIN }, 'redirect refused: host not allowed'],
    ]) {
      const response = await call(relayUrl(target), { headers, env });
      assert.equal(response.headers.get('x-relay-error'), reason, target);
    }

    const carried = await call(relayUrl('https://rr3---sn-4g5e6nez.googlevideo.com/videoplayback'), { headers: { Origin: ORIGIN }, env });
    assert.equal(carried.status, 403);
    assert.equal(await carried.text(), 'forbidden by google');
    // Only the relay may say it refused: an upstream's header of that name is dropped.
    assert.equal(carried.headers.get('x-relay-error'), null);
  } finally {
    upstream.restore();
  }
});

test("an upstream that cannot be reached is the relay's own 502, and marked as one", async () => {
  const upstream = stubUpstream(() => {
    throw new Error('connect ECONNREFUSED\nsecond line «here»');
  });
  try {
    const response = await call(relayUrl(YT));
    assert.equal(response.status, 502);
    // One line of plain text, whatever the runtime's message held: a header
    // that is not is a TypeError, and the relay answers nothing.
    assert.match(response.headers.get('x-relay-error'), /^upstream: connect ECONNREFUSED [\x20-\x7e]*$/);
  } finally {
    upstream.restore();
  }
});

test('a request with no target, or a target that is not http, is a 400', async () => {
  const upstream = stubUpstream();
  try {
    assert.equal((await call('https://relay.example.workers.dev/')).status, 400);
    assert.equal((await call(relayUrl('file:///etc/passwd'))).status, 400);
    assert.equal((await call('https://relay.example.workers.dev/?url=not%20a%20url')).status, 400);
    assert.equal(upstream.calls.length, 0);
  } finally {
    upstream.restore();
  }
});

test('private and link-local addresses are refused before the allow-list even matters', async () => {
  const upstream = stubUpstream();
  try {
    for (const target of [
      'http://127.0.0.1:8000/api/jobs',
      'http://localhost/admin',
      'http://10.1.2.3/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://169.254.169.254/latest/meta-data/', // the cloud metadata endpoint
    ]) {
      const response = await call(relayUrl(target));
      assert.equal(response.status, 400, target);
      assert.equal((await response.json()).error, 'not a public address', target);
    }
    assert.equal(upstream.calls.length, 0);
  } finally {
    upstream.restore();
  }
});

/* -------------------------------------------------------------- what it carries */

test('credentials are never carried in either direction', async () => {
  const upstream = stubUpstream(() =>
    new Response('ok', {
      status: 200,
      headers: { 'Set-Cookie': 'session=leaked; HttpOnly', 'Content-Type': 'text/plain' },
    }),
  );
  try {
    const response = await call(relayUrl(YT), {
      headers: { Origin: ORIGIN, Cookie: 'SID=secret', Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
    });

    const sent = upstream.calls[0].headers;
    assert.equal(sent.get('cookie'), null);
    assert.equal(sent.get('authorization'), null);
    // The caller's own Origin is replaced, not passed through.
    assert.equal(sent.get('origin'), 'https://www.youtube.com');
    assert.equal(sent.get('content-type'), 'application/json');

    assert.equal(response.headers.get('set-cookie'), null);
  } finally {
    upstream.restore();
  }
});

test('a Range request is forwarded and its 206 answer survives intact', async () => {
  const upstream = stubUpstream(() =>
    new Response('partial', {
      status: 206,
      headers: { 'Content-Range': 'bytes 0-6/1000', 'Accept-Ranges': 'bytes' },
    }),
  );
  try {
    const response = await call(relayUrl('https://rr1.googlevideo.com/videoplayback'), {
      headers: { Range: 'bytes=0-6' },
    });
    assert.equal(upstream.calls[0].headers.get('range'), 'bytes=0-6');
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 0-6/1000');
    // Without this the browser cannot read the offsets a partial download needs.
    assert.equal(response.headers.get('access-control-expose-headers'), '*');
  } finally {
    upstream.restore();
  }
});

test('a POST body reaches upstream, which is how InnerTube is called at all', async () => {
  const upstream = stubUpstream(async (_url, init) => new Response(await new Response(init.body).text()));
  try {
    const response = await call(relayUrl(YT), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: 'dQw4w9WgXcQ' }),
    });
    assert.equal(upstream.calls[0].init.method, 'POST');
    // Whole, not streamed: a stream goes out chunked with no content-length,
    // which YouTube's API refuses.
    assert.ok(upstream.calls[0].init.body instanceof ArrayBuffer, 'body is sent as bytes, not a stream');
    assert.equal(await response.text(), '{"videoId":"dQw4w9WgXcQ"}');
  } finally {
    upstream.restore();
  }
});

test('the upstream status and body are passed through unchanged', async () => {
  const upstream = stubUpstream(() => new Response('not found here', { status: 404 }));
  try {
    const response = await call(relayUrl(YT));
    assert.equal(response.status, 404);
    assert.equal(await response.text(), 'not found here');
  } finally {
    upstream.restore();
  }
});

test('an upstream encoding is not forwarded, because the body arrives decoded', async () => {
  // fetch hands the worker plaintext; the header would describe bytes that
  // are gone, and a client that believes it waits forever for a gzip stream.
  const upstream = stubUpstream(() =>
    new Response('plain text', { headers: { 'Content-Encoding': 'gzip', 'Content-Length': '20', 'Content-Type': 'text/plain' } }),
  );
  try {
    const response = await call(relayUrl(YT));
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(response.headers.get('content-type'), 'text/plain');
    assert.equal(await response.text(), 'plain text');
  } finally {
    upstream.restore();
  }
});

test("the browser's zstd is not asked for, because the runtime's fetch could not undo it", async () => {
  // Chrome and Firefox offer zstd; Node 22's fetch decodes gzip, deflate and
  // br only. A host that took the offer reached the page as compressed bytes
  // with the encoding header dropped as decoded. The runtime's own fetch
  // runs here against a local host — the stub only points the name at it.
  const body = JSON.stringify({ title: 'hello', formatStreams: [] });
  const seen = [];
  const host = createServer((req, res) => {
    const offered = req.headers['accept-encoding'] || '';
    seen.push(offered);
    if (/zstd/.test(offered)) {
      // Real zstd where this Node can make it; its magic number and the
      // bytes otherwise, which no fetch decodes either way.
      const packed = zlib.zstdCompressSync ? zlib.zstdCompressSync(body) : Buffer.concat([Buffer.from('28b52ffd', 'hex'), Buffer.from(body)]);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'zstd' }).end(packed);
    } else if (/gzip/.test(offered)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }).end(zlib.gzipSync(body));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
    }
  });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${host.address().port}`;
  const upstream = stubUpstream((url, init) => realFetch(String(url).replace('https://inv.example.net', local), init));
  try {
    const env = { ALLOWED_HOSTS: 'example.net' };
    const response = await call(relayUrl('https://inv.example.net/api/v1/videos/x'), { headers: { 'Accept-Encoding': 'gzip, deflate, br, zstd' }, env });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(await response.text()), JSON.parse(body));
    assert.doesNotMatch(seen[0], /zstd/);

    // A range is offsets into the bytes as sent, which decoding would move.
    // Given no list of its own, fetch asks for those bytes unencoded.
    await (await call(relayUrl('https://inv.example.net/videoplayback'), { headers: { 'Accept-Encoding': 'gzip, deflate, br, zstd', Range: 'bytes=0-9' }, env })).arrayBuffer();
    assert.equal(seen[1], 'identity');
  } finally {
    upstream.restore();
    host.close();
  }
});

test('content-length survives when nothing was encoded, since a progress bar needs it', async () => {
  const upstream = stubUpstream(() => new Response('12345', { headers: { 'Content-Length': '5' } }));
  try {
    const response = await call(relayUrl('https://rr1.googlevideo.com/videoplayback'));
    assert.equal(response.headers.get('content-length'), '5');
    assert.equal(await response.text(), '12345');
  } finally {
    upstream.restore();
  }
});

test('an upstream that will not answer becomes a 502, not a crash', async () => {
  const upstream = stubUpstream(() => {
    throw new Error('connection reset');
  });
  try {
    const response = await call(relayUrl(YT));
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /connection reset/);
  } finally {
    upstream.restore();
  }
});

test('ALLOWED_HOSTS replaces the defaults rather than adding to them', async () => {
  const upstream = stubUpstream();
  try {
    const env = { ALLOWED_HOSTS: 'cdn.example.com' };
    assert.equal((await call(relayUrl('https://cdn.example.com/a.mp4'), { env })).status, 200);
    assert.equal((await call(relayUrl(YT), { env })).status, 403);
  } finally {
    upstream.restore();
  }
});

/* ------------------------------------------------------------------ redirects */

test('a redirect to a private address is refused, not followed', async () => {
  // fetch used to follow redirects on its own, and the checks only ever saw
  // the first URL: an allowed host answering 302 → 127.0.0.1 got the relay
  // to fetch the LAN of whoever runs it.
  const upstream = stubUpstream(() => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1:9102/secret' } }));
  try {
    const response = await call(relayUrl(YT), { headers: { Origin: ORIGIN } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'redirect refused: not a public address');
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].init.redirect, 'manual');
  } finally {
    upstream.restore();
  }
});

test('a redirect off the allow-list is refused', async () => {
  const upstream = stubUpstream(() => new Response(null, { status: 301, headers: { Location: 'https://elsewhere.example/x' } }));
  try {
    const response = await call(relayUrl(YT), { headers: { Origin: ORIGIN } });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'redirect refused: host not allowed');
  } finally {
    upstream.restore();
  }
});

test('a redirect between allowed hosts is followed, relative locations included', async () => {
  let n = 0;
  const upstream = stubUpstream((url) => {
    n += 1;
    if (n === 1) return new Response(null, { status: 302, headers: { Location: 'https://rr3---sn-abc.googlevideo.com/videoplayback?x=1' } });
    if (n === 2) return new Response(null, { status: 307, headers: { Location: '/videoplayback?x=2' } });
    return new Response(`final ${new URL(url).search}`, { status: 200 });
  });
  try {
    const response = await call(relayUrl('https://www.youtube.com/watch?v=x'), { headers: { Origin: ORIGIN } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'final ?x=2');
    assert.deepEqual(upstream.calls.map((c) => new URL(c.url).host), ['www.youtube.com', 'rr3---sn-abc.googlevideo.com', 'rr3---sn-abc.googlevideo.com']);
  } finally {
    upstream.restore();
  }
});

test('a redirect loop ends with a 502', async () => {
  const upstream = stubUpstream(() => new Response(null, { status: 302, headers: { Location: YT } }));
  try {
    const response = await call(relayUrl(YT), { headers: { Origin: ORIGIN } });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error, 'too many redirects');
  } finally {
    upstream.restore();
  }
});

test('the shapes of a private address the first check missed are refused too', async () => {
  const upstream = stubUpstream();
  try {
    for (const target of ['http://0.0.0.0:9102/x', 'http://100.100.100.100/', 'http://[::ffff:127.0.0.1]/', 'http://printer.local/', 'http://app.localhost/']) {
      const response = await call(relayUrl(target), { env: { ALLOWED_HOSTS: '0.0.0.0,100.100.100.100,printer.local,app.localhost,[::ffff:7f00:1]' } });
      assert.equal(response.status, 400, target);
      assert.equal((await response.json()).error, 'not a public address', target);
    }
    assert.equal(upstream.calls.length, 0);
  } finally {
    upstream.restore();
  }
});

test('a public host that merely contains "local" is fetched when it is allowed', async () => {
  // The check was anchored only at the start, so www.local.ch and
  // localtv.com were "not a public address" before the allow-list was asked.
  const upstream = stubUpstream((url) =>
    String(url).includes('hop.local10.com') ? new Response(null, { status: 302, headers: { Location: 'https://www.local.ch/y.mp4' } }) : new Response('ok'),
  );
  try {
    const env = { ALLOWED_HOSTS: 'local10.com,local.ch,localtv.com,localhostr.com' };
    for (const target of ['https://www.local10.com/x.mp4', 'https://www.local.ch/x.mp4', 'https://media.localtv.com/x.mp4', 'https://localhostr.com/x.mp4', 'https://hop.local10.com/x.mp4']) {
      const response = await call(relayUrl(target), { env });
      assert.equal(response.status, 200, target);
    }
  } finally {
    upstream.restore();
  }
});

test('private names and numbers are still refused, first asked or reached by redirect', async () => {
  const privates = ['http://printer.local/', 'http://printer.local./', 'http://a.localhost/', 'http://localhost/', 'http://localhost./', 'http://127.0.0.1/', 'http://10.0.0.1/', 'http://172.16.0.1/', 'http://[::1]/'];
  const upstream = stubUpstream((url) => new Response(null, { status: 302, headers: { Location: new URL(url).searchParams.get('to') } }));
  try {
    const env = { ALLOWED_HOSTS: 'printer.local,a.localhost,localhost,127.0.0.1,10.0.0.1,172.16.0.1,[::1],googlevideo.com' };
    for (const target of privates) {
      const first = await call(relayUrl(target), { env });
      assert.equal(first.status, 400, target);
      assert.equal((await first.json()).error, 'not a public address', target);
    }
    assert.equal(upstream.calls.length, 0);
    for (const target of privates) {
      const hop = await call(relayUrl(`https://rr1.googlevideo.com/r?to=${encodeURIComponent(target)}`), { env });
      assert.equal(hop.status, 403, target);
      assert.equal((await hop.json()).error, 'redirect refused: not a public address', target);
    }
  } finally {
    upstream.restore();
  }
});
