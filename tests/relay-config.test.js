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

import { through, evaluate, choose, candidates, PUBLIC_RELAYS, ROBOTS, VIDEO_ID } from '../scripts/relay-config.mjs';

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
