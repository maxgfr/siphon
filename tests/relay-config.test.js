/**
 * Finding a relay that works, with the network stubbed.
 *
 * The three checks the script runs are what a page needs, in order: the
 * relay fetches for a page at all, an instance answers the video endpoint
 * through it, and the media comes through it. These pin that each door is
 * tried and named when shut, that the owner's relay wins when it passes,
 * and that nothing passing yields no relay rather than a dead one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { through, evaluate, choose, candidates, cobaltCandidates, evaluateCobalt, chooseCobalt, fromSource, sourceEntries, PUBLIC_RELAYS, COBALT_DIRECTORY, COBALT_DIRECTORIES, COBALT_SOURCE, USER_AGENT, ROBOTS, VIDEO_ID, WATCH } from '../scripts/relay-config.mjs';

const STREAMS = { formatStreams: [{ url: '/videoplayback?itag=18', type: 'video/mp4' }] };

/**
 * A fetch that answers by the target URL a relay was asked for, whatever
 * the relay's own shape. `refuse` lists relays that answer nothing.
 */
function world({ robotsCors = '*', instances = {}, media = 'video/mp4', refuse = [] } = {}) {
  const asked = [];
  const fetchImpl = async (url, init = {}) => {
    asked.push(url);
    if (refuse.some((relay) => url.startsWith(relay.split('{')[0]))) throw new TypeError('fetch failed');
    // The target, whatever the relay's shape put around it.
    const target = decodeURIComponent((url.match(/[?&](?:url|quest)=(.*)$/) || url.match(/\/(?:fetch\/|\?)?(https?:\/\/.*)$/) || [, ''])[1]);
    const headers = new Headers(robotsCors ? { 'access-control-allow-origin': robotsCors } : {});
    if (target.startsWith(ROBOTS)) return new Response('User-agent: *\nDisallow: /x\n', { status: 200, headers });
    const inst = Object.keys(instances).find((host) => target.includes(host));
    if (inst && target.includes(`/api/v1/videos/${VIDEO_ID}`)) {
      const answer = instances[inst];
      return typeof answer === 'number' ? new Response('', { status: answer, headers }) : new Response(JSON.stringify(answer), { status: 200, headers });
    }
    if (inst && target.includes('/videoplayback')) {
      if (!media) return new Response('nope', { status: 403, headers });
      return new Response(new Uint8Array(1024), { status: 206, headers: { 'content-type': media, 'access-control-allow-origin': '*' } });
    }
    return new Response('not found', { status: 404, headers });
  };
  return { asked, fetchImpl };
}

test('every relay shape puts the target where it belongs', () => {
  assert.equal(through('https://p.example/?url={url}', 'https://a.b/c?d=1'), 'https://p.example/?url=https%3A%2F%2Fa.b%2Fc%3Fd%3D1');
  assert.equal(through('https://p.example/{raw}', 'https://a.b/c'), 'https://p.example/https://a.b/c');
  assert.equal(through('https://mine.workers.dev/', 'https://a.b/c'), 'https://mine.workers.dev/?url=https%3A%2F%2Fa.b%2Fc');
  for (const relay of PUBLIC_RELAYS) assert.ok(through(relay, ROBOTS).includes('youtube.com'), relay);
});

test('a relay passes only when robots, an instance and the media all come through', async () => {
  const { fetchImpl } = world({ instances: { 'inv.example': STREAMS } });
  const report = await evaluate('https://p.example/?url={url}', { fetchImpl, instances: ['https://inv.example'] });
  assert.equal(report.ok, true);
  assert.equal(report.instance, 'https://inv.example');
  assert.match(report.robots, /ok \(cors=\*\)/);
  assert.match(report.media, /206 video\/mp4/);
});

test('robots without a CORS header is a shut door, and named', async () => {
  const { fetchImpl } = world({ robotsCors: '', instances: { 'inv.example': STREAMS } });
  const report = await evaluate('https://p.example/?url={url}', { fetchImpl, instances: ['https://inv.example'] });
  assert.equal(report.ok, false);
  assert.match(report.robots, /no Access-Control-Allow-Origin/);
});

test('an instance that refuses through the relay is skipped for the next, with the status kept', async () => {
  const { fetchImpl } = world({ instances: { 'shut.example': 403, 'open.example': STREAMS } });
  const report = await evaluate('https://p.example/?url={url}', { fetchImpl, instances: ['https://shut.example', 'https://open.example'] });
  assert.equal(report.ok, true);
  assert.equal(report.instance, 'https://open.example');
});

test('streams that name media the relay cannot carry do not pass', async () => {
  const { fetchImpl } = world({ instances: { 'inv.example': STREAMS }, media: '' });
  const report = await evaluate('https://p.example/?url={url}', { fetchImpl, instances: ['https://inv.example'] });
  assert.equal(report.ok, false);
  assert.match(report.media, /HTTP 403/);
});

test("the owner's relay is tried first and wins when it passes", async () => {
  const { fetchImpl, asked } = world({ instances: { 'inv.example': STREAMS } });
  const found = await choose({ own: 'https://mine.workers.dev', fetchImpl, instances: ['https://inv.example'] });
  assert.equal(found.relay, 'https://mine.workers.dev');
  assert.equal(found.relayKind, 'own');
  assert.ok(asked[0].startsWith('https://mine.workers.dev/?url='));
  assert.deepEqual(candidates('https://mine.workers.dev')[0], 'https://mine.workers.dev');
});

test("when the owner's relay is down, the first public one that passes is taken, as public", async () => {
  const { fetchImpl } = world({ instances: { 'inv.example': STREAMS }, refuse: ['https://mine.workers.dev', PUBLIC_RELAYS[0]] });
  const found = await choose({ own: 'https://mine.workers.dev', fetchImpl, instances: ['https://inv.example'] });
  assert.equal(found.relay, PUBLIC_RELAYS[1]);
  assert.equal(found.relayKind, 'public');
});

test('nothing passing is no relay, never a dead one', async () => {
  const { fetchImpl } = world({ robotsCors: '' });
  const found = await choose({ fetchImpl, instances: ['https://inv.example'] });
  assert.deepEqual(found, { relay: '', relayKind: '', instance: '' });
});

/* ------------------------------------------------------------------ cobalt */

const DIRECTORY = [
  { api: 'keyed.example', protocol: 'https', online: true, api_online: true, score: 100, services: { youtube: true } },
  { api: 'open.example', protocol: 'https', online: true, api_online: true, score: 90, services: { youtube: true } },
  { api: 'noyt.example', protocol: 'https', online: true, api_online: true, score: 80, services: { youtube: false } },
  { api: 'down.example', protocol: 'https', online: false, api_online: false, score: 70 },
  { api: 'plain.example', protocol: 'http', online: true, api_online: true, score: 60 },
  { api: 'open.example/', protocol: 'https', online: true, api_online: true, score: 50 },
];

/** A cobalt world: every instance answers the sample link its own way; the tunnel streams bytes. */
function cobaltWorld({ answers, media = 'video/mp4', directory = DIRECTORY } = {}) {
  const asked = [];
  const fetchImpl = async (url, init = {}) => {
    asked.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null, headers: init.headers || {} });
    if (COBALT_DIRECTORIES.includes(url)) {
      if (directory instanceof Error) throw directory;
      return typeof directory === 'string' ? new Response(directory, { status: 200, headers: { 'content-type': 'text/html' } }) : new Response(JSON.stringify(directory), { status: 200 });
    }
    if (url.endsWith('/tunnel')) {
      if (!media) return new Response('<html>nope</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response(new Uint8Array(2048), { status: 200, headers: { 'content-type': media } });
    }
    const host = new URL(url).host;
    const answer = answers[host];
    if (!answer) return new Response(JSON.stringify({ status: 'error', error: { code: 'error.api.auth.key.missing' } }), { status: 401 });
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  return { asked, fetchImpl };
}

test('the directory is read for online, https, YouTube-capable instances, best score first, deduplicated', () => {
  assert.deepEqual(cobaltCandidates(DIRECTORY), ['https://keyed.example', 'https://open.example']);
  assert.deepEqual(cobaltCandidates('nonsense'), []);
});

test("cobalt.directory's own shape is read: a data envelope, a per-service map, entries as strings or objects", () => {
  const wrapped = {
    lastUpdatedUTC: '2026-09-16 21:00',
    data: {
      youtube: ['one.example', { api: 'two.example/', score: 9, tests: { youtube: { status: 'success' } } }, { url: 'https://three.example', services: { YouTube: 'fail' } }],
      tiktok: ['tik.example'],
    },
  };
  assert.deepEqual(cobaltCandidates(wrapped), ['https://two.example', 'https://one.example']);
  assert.deepEqual(cobaltCandidates({ data: { 'host.example': { online: true, services: { youtube: true } }, 'down.example': { status: 'offline' } } }), ['https://host.example']);
  assert.deepEqual(cobaltCandidates({ data: ['http://plain.example'] }), [], 'a page on https cannot call an http instance');
});

test('the second directory is asked when the first is unreachable, and each is named with what it said', async () => {
  const first = COBALT_DIRECTORIES[0];
  const answer = { status: 'tunnel', url: 'https://open.example/tunnel' };
  const asked = [];
  const fetchImpl = async (url, init = {}) => {
    asked.push({ url, headers: init.headers || {} });
    if (url === first) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    if (COBALT_DIRECTORIES.includes(url)) return new Response(JSON.stringify({ data: { youtube: ['open.example'] } }), { status: 200 });
    if (url.endsWith('/tunnel')) return new Response(new Uint8Array(64), { status: 200, headers: { 'content-type': 'video/mp4' } });
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  const lines = [];
  assert.equal(await chooseCobalt({ fetchImpl, say: (l) => lines.push(l) }), 'https://open.example');
  assert.equal(lines[0], `no   directory ${first}: ENOTFOUND`, 'the cause, not a bare "fetch failed"');
  assert.match(lines[1], /^ {5}directory .*api\/tests: 1 instance\(s\) to ask$/);
  assert.equal(asked[0].headers['User-Agent'], USER_AGENT, 'the directory is told who asks');
});

test('a directory answering a web page is named with its first bytes, so the reader can be taught', async () => {
  const { fetchImpl } = cobaltWorld({ answers: {}, directory: '<html><body>moved</body></html>' });
  const lines = [];
  assert.equal(await chooseCobalt({ fetchImpl, say: (l) => lines.push(l) }), '');
  assert.equal(lines.length, COBALT_DIRECTORIES.length + 1, 'each directory, then the source behind them');
  assert.match(lines[0], /nothing listed as up for YouTube — <html><body>moved/);
  assert.match(lines.at(-1), /^no {3}source .*codeberg/);
});

test('an instance passes when it answers a tunnel for the sample link and the tunnel streams bytes', async () => {
  const { asked, fetchImpl } = cobaltWorld({ answers: { 'open.example': { status: 'tunnel', url: 'https://open.example/tunnel', filename: 'x.mp4' } } });
  const report = await evaluateCobalt('https://open.example', { fetchImpl });
  assert.equal(report.ok, true);
  assert.equal(report.answer, 'tunnel');
  assert.match(report.media, /200 video\/mp4 2048 bytes/);
  const post = asked.find((a) => a.method === 'POST');
  assert.equal(post.body.url, WATCH, 'the same link the app would send');
  assert.equal(post.body.downloadMode, 'auto');
});

test('a keyed instance is a no, with its error code kept', async () => {
  const { fetchImpl } = cobaltWorld({ answers: {} });
  const report = await evaluateCobalt('https://keyed.example', { fetchImpl });
  assert.equal(report.ok, false);
  assert.match(report.answer, /error\.api\.auth\.key\.missing/);
});

test('a tunnel that streams a web page rather than a file is a no', async () => {
  const { fetchImpl } = cobaltWorld({ answers: { 'open.example': { status: 'tunnel', url: 'https://open.example/tunnel' } }, media: '' });
  const report = await evaluateCobalt('https://open.example', { fetchImpl });
  assert.equal(report.ok, false);
  assert.match(report.media, /text\/html/);
});

test('the walk skips the keyed instance and takes the first that delivers', async () => {
  const { fetchImpl } = cobaltWorld({ answers: { 'open.example': { status: 'redirect', url: 'https://open.example/tunnel' } } });
  const lines = [];
  assert.equal(await chooseCobalt({ fetchImpl, say: (l) => lines.push(l) }), 'https://open.example');
  assert.ok(lines[0].startsWith(`     directory ${COBALT_DIRECTORY}: 2 instance(s)`), lines[0]);
  assert.ok(lines[1].startsWith('no   https://keyed.example'));
  assert.ok(lines[2].startsWith('ok   https://open.example'));
});

test('a file of the source is read as JSON, or line by line when it is not', () => {
  assert.deepEqual(sourceEntries('{"api":"one.example","frontend":"one.example"}').map((e) => e.api), ['https://one.example']);
  assert.deepEqual(sourceEntries('[{"api":"a.example"},{"api":"b.example","online":false}]').map((e) => e.api), ['https://a.example']);
  assert.deepEqual(sourceEntries('# two\napi = "https://two.example"\nfrontend = "two.example"\n').map((e) => e.api), ['https://two.example']);
  assert.deepEqual(sourceEntries('api: api.three.example:9000\n').map((e) => e.api), ['https://api.three.example:9000']);
  // The plain list: one instance per line, comments dropped, http left out.
  assert.deepEqual(
    sourceEntries('# instances that asked to be listed\napi.four.example\nhttps://five.example/ # keyed\nhttp://plain.example\n\n// six\nsix.example:8080\n').map((e) => e.api),
    ['https://api.four.example', 'https://five.example', 'https://six.example:8080'],
  );
  assert.deepEqual(sourceEntries('nothing of the kind'), []);
  assert.deepEqual(sourceEntries(''), []);
});

test('the source measured to be one file — an object with its content — is read without a second request', async () => {
  const list = '# opt-in\napi.one.example\napi.two.example\n';
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url === COBALT_SOURCE) {
      return new Response(JSON.stringify({ name: 'instances', path: 'backend/instances', type: 'file', encoding: 'base64', content: Buffer.from(list).toString('base64'), download_url: 'https://raw.example/instances' }), { status: 200 });
    }
    return new Response('', { status: 404 });
  };
  const lines = [];
  assert.deepEqual(await fromSource({ fetchImpl, say: (l) => lines.push(l) }), ['https://api.one.example', 'https://api.two.example']);
  assert.equal(lines[0], `     source ${COBALT_SOURCE}: 1 file(s), 2 instance(s) to ask`);
  assert.deepEqual(asked, [COBALT_SOURCE], 'the content came with the answer');
});

test('with both directories behind a challenge page, the source repository is read, file by file, and walked', async () => {
  const challenge = '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head></html>';
  const files = [
    { type: 'file', name: 'one.json', download_url: 'https://raw.example/one.json' },
    { type: 'dir', name: 'ignored' },
    { type: 'file', name: 'two.toml', download_url: 'https://raw.example/two.toml' },
    { type: 'file', name: 'down.json', download_url: 'https://raw.example/down.json' },
  ];
  const asked = [];
  const fetchImpl = async (url, init = {}) => {
    asked.push(url);
    if (COBALT_DIRECTORIES.includes(url)) return new Response(challenge, { status: 403, headers: { 'content-type': 'text/html' } });
    if (url === COBALT_SOURCE) return new Response(JSON.stringify(files), { status: 200 });
    if (url === 'https://raw.example/one.json') return new Response('{"api":"one.example","score":1}', { status: 200 });
    if (url === 'https://raw.example/two.toml') return new Response('api = "two.example"\n', { status: 200 });
    if (url === 'https://raw.example/down.json') return new Response('{"api":"down.example","online":false}', { status: 200 });
    if (url.endsWith('/tunnel')) return new Response(new Uint8Array(64), { status: 200, headers: { 'content-type': 'video/mp4' } });
    if (url === 'https://one.example/') return new Response(JSON.stringify({ status: 'error', error: { code: 'error.api.auth.key.missing' } }), { status: 401 });
    if (url === 'https://two.example/') return new Response(JSON.stringify({ status: 'tunnel', url: 'https://two.example/tunnel' }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const lines = [];
  assert.equal(await chooseCobalt({ fetchImpl, say: (l) => lines.push(l) }), 'https://two.example');
  assert.match(lines[0], /^no {3}directory .*: HTTP 403 — <!DOCTYPE html>.*Just a moment/);
  assert.match(lines[1], /^no {3}directory .*api\/tests: HTTP 403/);
  assert.equal(lines[2], `     source ${COBALT_SOURCE}: 3 file(s), 2 instance(s) to ask`);
  assert.ok(lines[3].startsWith('no   https://one.example'));
  assert.ok(lines[4].startsWith('ok   https://two.example'));
  assert.ok(!asked.includes('https://down.example/'), 'an instance that says it is down is not asked');
});

test('a source that lists files nothing reads is named with the first file, and is no instance', async () => {
  const fetchImpl = async (url) => {
    if (url === COBALT_SOURCE) return new Response(JSON.stringify([{ type: 'file', name: 'x.yml', download_url: 'https://raw.example/x.yml' }]), { status: 200 });
    if (url === 'https://raw.example/x.yml') return new Response('frontend: only.example\n', { status: 200 });
    return new Response('', { status: 404 });
  };
  const lines = [];
  assert.deepEqual(await fromSource({ fetchImpl, say: (l) => lines.push(l) }), []);
  assert.equal(lines[0], `     source ${COBALT_SOURCE}: 1 file(s), 0 instance(s) to ask — frontend: only.example`);
  const folder = [];
  assert.deepEqual(await fromSource({ fetchImpl: async () => new Response('{"name":"x","type":"dir"}', { status: 200 }), say: (l) => folder.push(l) }), []);
  assert.match(folder[0], /^no {3}source .*: no file there — \{"name":"x"/);
  const unreachable = [];
  assert.deepEqual(await fromSource({ fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); }, say: (l) => unreachable.push(l) }), []);
  assert.equal(unreachable[0], `no   source ${COBALT_SOURCE}: ECONNRESET`);
});

test('a directory that cannot be read is no instance, not a crash', async () => {
  assert.equal(await chooseCobalt({ fetchImpl: async () => { throw new TypeError('fetch failed'); } }), '');
});
