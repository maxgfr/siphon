/**
 * One address, and what it turns out to be — with the network stubbed.
 *
 * Each kind of helper answers one small request in a way nothing else does;
 * these pin that the right request is made and the right answer read, and
 * that "nothing here" is an answer rather than an error where it should be.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { detectEndpoint, privacyNote, describeEndpoint, ytdlpAge, STALE_AFTER_DAYS, withScheme } from '../web/endpoint.js';

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
  assert.equal(helper.ytDlpVersion, '2026.09.01');
  // One request was enough, and the trailing slash did not double up.
  assert.deepEqual(asked, ['https://ytdl.example/api/health']);
});

test('a server that wants a key says so rather than looking like something else', async () => {
  const { fetchImpl } = stub({ '/api/health': { status: 401, body: { detail: 'key' } } });
  await assert.rejects(() => detectEndpoint('https://ytdl.example', '', fetchImpl), /access key/i);
});

test('a server that wants a key is asked with it, and a wrong one is found out before saving', async () => {
  const health = { body: { service: 'siphon', ytDlpVersion: '2026.09.01', ffmpeg: true, requiresKey: true } };
  // The right key: a gated endpoint answers 404 for a job that does not exist, and the key is taken.
  const right = stub({ '/api/health': health, '/api/jobs/': { status: 404, body: { detail: 'No such download.' } } });
  const helper = await detectEndpoint('https://ytdl.example', 'k3y', right.fetchImpl);
  assert.equal(helper.kind, 'siphon');
  assert.equal(helper.requiresKey, true);
  assert.equal(helper.keyAccepted, true);
  assert.deepEqual(right.asked, ['https://ytdl.example/api/health', 'https://ytdl.example/api/jobs/key-check']);
  // A wrong key: health still answers everyone, so without this the sheet
  // would say "your server" and the first download would say 401. Still a
  // siphon server, though — a first visit at a keyed one adopts it and asks
  // for the key later, so this is reported rather than thrown.
  const wrong = stub({ '/api/health': health, '/api/jobs/': { status: 401, body: { detail: 'This server needs an access key.' } } });
  const refused = await detectEndpoint('https://ytdl.example', 'nope', wrong.fetchImpl);
  assert.equal(refused.kind, 'siphon');
  assert.equal(refused.keyAccepted, false);
  assert.equal((await detectEndpoint('https://ytdl.example', '', wrong.fetchImpl)).keyAccepted, false);
});

test('a server that wants no key is not asked twice', async () => {
  const { fetchImpl, asked } = stub({ '/api/health': { body: { service: 'siphon', ytDlpVersion: '2026.09.01', ffmpeg: true, requiresKey: false } } });
  await detectEndpoint('https://ytdl.example', '', fetchImpl);
  assert.deepEqual(asked, ['https://ytdl.example/api/health']);
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

test('a relay given as a template is probed through the template, and is a relay', async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    return new Response(/youtube\.com%2Frobots\.txt$/.test(url) ? 'User-agent: *\n' : 'nope', { status: 200 });
  };
  const helper = await detectEndpoint('https://corsproxy.io/?url={url}', '', fetchImpl);
  assert.equal(helper.kind, 'relay');
  assert.deepEqual(asked, ['https://corsproxy.io/?url=https%3A%2F%2Fwww.youtube.com%2Frobots.txt'], 'one request, through the template');
});

test('a template that does not fetch for the page is refused with its status', async () => {
  const fetchImpl = async () => new Response('forbidden', { status: 403 });
  await assert.rejects(() => detectEndpoint('https://proxy.example/?url={url}', '', fetchImpl), /answered 403/);
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

/** A fetch that answers like `stub`, and records the headers each request carried. */
function recording(table) {
  const seen = [];
  const { fetchImpl: answer } = stub(table);
  const fetchImpl = async (url, init = {}) => {
    seen.push({ url, authorization: new Headers(init.headers || {}).get('authorization') });
    return answer(url, init);
  };
  return { fetchImpl, seen };
}

test('an access key is shown only to the server that asked for it, never to the probes', async () => {
  // The key in the sheet may be the one saved for another address. A cobalt
  // instance answering the probes must not receive it on the way to being
  // recognised.
  const cobalt = recording({
    '/api/health': { status: 404, body: '' },
    '/': { body: { cobalt: { version: '11.0' }, git: {} } },
  });
  assert.equal((await detectEndpoint('https://api.example', 'MY-AUTH-TOKEN', cobalt.fetchImpl)).kind, 'cobalt');
  assert.deepEqual(cobalt.seen.filter((ask) => ask.authorization), [], 'no probe carried the key');

  // Nothing recognised at all: five probes, and still no key on any of them.
  const nobody = recording({ '/': { body: '<html>hello</html>' } });
  await assert.rejects(() => detectEndpoint('https://blog.example', 'MY-AUTH-TOKEN', nobody.fetchImpl));
  assert.ok(nobody.seen.length >= 5);
  assert.deepEqual(nobody.seen.filter((ask) => ask.authorization), []);

  // A siphon server that wants a key: only the gated check is asked with it.
  const own = recording({
    '/api/health': { body: { service: 'siphon', ytDlpVersion: '2026.09.01', ffmpeg: true, requiresKey: true } },
    '/api/jobs/': { status: 404, body: { detail: 'No such download.' } },
  });
  assert.equal((await detectEndpoint('https://ytdl.example', 'MY-AUTH-TOKEN', own.fetchImpl)).keyAccepted, true);
  assert.deepEqual(own.seen, [
    { url: 'https://ytdl.example/api/health', authorization: null },
    { url: 'https://ytdl.example/api/jobs/key-check', authorization: 'Bearer MY-AUTH-TOKEN' },
  ]);
});

test('an address typed without its scheme gets the one it most likely has', () => {
  assert.equal(withScheme('inv.nadeko.net'), 'https://inv.nadeko.net');
  assert.equal(withScheme('  pipedapi.example/api  '), 'https://pipedapi.example/api');
  assert.equal(withScheme('example.com:8443'), 'https://example.com:8443', 'a public host with a port is still https');
  // Addresses on this machine or this network are plain http: that is how a
  // server started with one docker run answers.
  assert.equal(withScheme('192.168.1.42:8000'), 'http://192.168.1.42:8000');
  assert.equal(withScheme('10.0.0.2:8000'), 'http://10.0.0.2:8000');
  assert.equal(withScheme('172.20.1.5'), 'http://172.20.1.5');
  assert.equal(withScheme('127.0.0.1:8000'), 'http://127.0.0.1:8000');
  assert.equal(withScheme('localhost:8000'), 'http://localhost:8000');
  assert.equal(withScheme('nas.local:8000'), 'http://nas.local:8000');
  assert.equal(withScheme('raspberrypi:8000'), 'http://raspberrypi:8000');
  assert.equal(withScheme('100.101.102.103:8000'), 'http://100.101.102.103:8000', 'a Tailscale address');
  assert.equal(withScheme('[::1]:8000'), 'http://[::1]:8000');
  assert.equal(withScheme('172.32.0.1'), 'https://172.32.0.1', 'just outside 172.16/12 is public');
  // Anything that already says how to be reached is left as it is.
  assert.equal(withScheme('http://inv.example'), 'http://inv.example');
  assert.equal(withScheme('https://corsproxy.io/?url={url}'), 'https://corsproxy.io/?url={url}');
  assert.equal(withScheme(''), '');
  assert.equal(withScheme('/relay'), '/relay', 'a path on this page\'s own host');
});

test('an address with no scheme is never probed against this page\'s own host', async () => {
  // fetch() reads "inv.nadeko.net/api/health" as a path under the page, and
  // the page's own host answering 404 there read as "not recognised".
  const { fetchImpl, asked } = stub({});
  await assert.rejects(() => detectEndpoint('inv.nadeko.net', '', fetchImpl), /https:\/\//);
  assert.deepEqual(asked, [], 'nothing was asked');
});

/** Run with the page at `origin`, as the browser would have it. */
async function onPage(origin, run) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: new URL(`${origin}/siphon/`), configurable: true });
  try {
    return await run();
  } finally {
    if (had) Object.defineProperty(globalThis, 'location', had);
    else delete globalThis.location;
  }
}

test('a server on this computer that does not answer is not blamed on mixed content', async () => {
  // http://127.0.0.1 is a secure context: the HTTPS page may call it, and
  // "browsers refuse mixed content" would send the person away from a route
  // that works once the server is up and names this page.
  const { fetchImpl } = stub({});
  await onPage('https://maxgfr.github.io', async () => {
    for (const address of ['http://127.0.0.1:8000', 'http://localhost:8000', 'http://[::1]:8000']) {
      const error = await detectEndpoint(address, '', fetchImpl).catch((e) => e);
      assert.doesNotMatch(error.message, /mixed content/i, address);
      assert.match(error.message, /running/, address);
      assert.match(error.message, /ALLOWED_ORIGINS/, address);
      assert.match(error.message, /https:\/\/maxgfr\.github\.io/, `${address}: names the origin to allow`);
    }
    // A plain-HTTP address on the network is mixed content, and is still called that.
    await assert.rejects(() => detectEndpoint('http://192.168.1.5:8000', '', fetchImpl), /mixed content/i);
  });
});

test('the same goes for a download that cannot reach the server', async () => {
  const { ServerBackend } = await import('../web/api.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  try {
    await onPage('https://maxgfr.github.io', async () => {
      const local = await new ServerBackend({ base: 'http://127.0.0.1:8000' }).health().catch((e) => e);
      assert.doesNotMatch(`${local.message} ${local.hint}`, /mixed content|plain HTTP/i);
      assert.match(local.hint, /ALLOWED_ORIGINS/);
      assert.match(local.hint, /this device/, 'and names the browser\'s permission prompt');
      const lan = await new ServerBackend({ base: 'http://192.168.1.5:8000' }).health().catch((e) => e);
      assert.match(`${lan.message} ${lan.hint}`, /mixed content/i);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the sentences follow from the kind', () => {
  assert.match(privacyNote({ kind: 'none' }), /this device/i);
  assert.match(privacyNote({ kind: 'siphon', ffmpeg: true }), /your server/i);
  assert.match(privacyNote({ kind: 'siphon', ffmpeg: false }), /resolves/i);
  assert.match(describeEndpoint({ kind: 'siphon', ffmpeg: false, label: 'yt-dlp 1' }), /no ffmpeg/i);
  assert.match(describeEndpoint({ kind: 'siphon', ffmpeg: true, jsRuntime: false, label: 'yt-dlp 1' }), /no JavaScript runtime.*Deno/i);
  assert.doesNotMatch(describeEndpoint({ kind: 'siphon', ffmpeg: true, label: 'yt-dlp 1' }), /JavaScript runtime/, 'an older server that says nothing is not warned about');
  assert.match(describeEndpoint({ kind: 'relay' }), /relay/i);
  assert.match(privacyNote({ kind: 'invidious' }), /Invidious instance/);
  assert.match(describeEndpoint({ kind: 'invidious' }), /An Invidious instance/);
  assert.match(describeEndpoint(null), /helper/i);
});

test('the age of a yt-dlp is read off its calendar version', () => {
  const today = new Date('2026-09-17T12:00:00Z');
  assert.equal(ytdlpAge('2026.08.19', today), 29);
  assert.equal(ytdlpAge('2026.09.17', today), 0);
  assert.equal(ytdlpAge('2026.09.17.232839', today), 0, 'a nightly carries a suffix');
  assert.equal(ytdlpAge('', today), null);
  assert.equal(ytdlpAge(undefined, today), null);
  assert.equal(ytdlpAge('nightly', today), null);
});

test('a server with a months-old yt-dlp is told to pull the image; a current one is not', () => {
  const today = new Date('2026-09-17T12:00:00Z');
  const stale = describeEndpoint({ kind: 'siphon', ffmpeg: true, label: 'yt-dlp 2026.05.01', ytDlpVersion: '2026.05.01' }, today);
  assert.match(stale, /139 days old/);
  // The headline install is one `docker run`, with no compose file to pull
  // with: both ways of starting it are told how to take the new image, and
  // a pull alone replaces no running container.
  assert.match(stale, /docker compose pull && docker compose up -d/);
  assert.match(stale, /docker pull ghcr\.io\/maxgfr\/siphon/);
  assert.match(stale, /docker rm -f siphon/);
  assert.match(stale, /^Your server — yt-dlp 2026\.05\.01, with ffmpeg\./, 'the rest of the sentence is unchanged');
  const fresh = describeEndpoint({ kind: 'siphon', ffmpeg: true, label: 'yt-dlp 2026.09.01', ytDlpVersion: '2026.09.01' }, today);
  assert.doesNotMatch(fresh, /days old/);
  const edge = describeEndpoint({ kind: 'siphon', ffmpeg: true, label: 'yt-dlp x', ytDlpVersion: '2026.08.03' }, today);
  assert.equal(ytdlpAge('2026.08.03', today), STALE_AFTER_DAYS);
  assert.doesNotMatch(edge, /days old/, 'exactly the threshold is not yet stale');
  const unknown = describeEndpoint({ kind: 'siphon', ffmpeg: true, label: 'yt-dlp ?' }, today);
  assert.doesNotMatch(unknown, /days old/, 'an older server that names no version is not warned about');
});
