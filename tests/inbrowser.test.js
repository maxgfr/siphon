/**
 * The job runner in the tab, as the queue sees it while a download runs.
 *
 * A row shows a percentage, a time left and a warning only when the job says
 * how big the download is, so these read the job's own reports mid-download,
 * from a real (local) host. Nothing here reaches the converter: every job is
 * cancelled while it is still downloading.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { BrowserBackend } from '../web/inbrowser.js';

/** A host serving `routes` by path; a segment is anything else, `segmentBytes` long, after `delay` ms. */
async function host(routes, { segmentBytes, delay }) {
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://x').pathname;
    if (routes[path]) return response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end(routes[path]);
    const timer = setTimeout(() => response.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': segmentBytes }).end(Buffer.alloc(segmentBytes)), delay);
    response.on('close', () => clearTimeout(timer));
    return undefined;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const playlist = (count, seconds) =>
  `#EXTM3U\n#EXT-X-TARGETDURATION:${seconds}\n#EXT-X-PLAYLIST-TYPE:VOD\n${Array.from({ length: count }, (_, i) => `#EXTINF:${seconds},\ns${i}.ts\n`).join('')}#EXT-X-ENDLIST\n`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a stream is sized from its playlist before a segment arrives, and a long one is warned about', async () => {
  // Two hours at 6 Mbit/s: about 5.4 GB, all of it held in memory for the
  // remux. No playlist states a size, so the job used to report none — an
  // indeterminate bar, no time left, and no "Large file" note for exactly the
  // download that most needs one.
  const server = await host({
    '/show/master.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080\nv/index.m3u8\n',
    '/show/v/index.m3u8': playlist(1200, 6),
  }, { segmentBytes: 1000, delay: 5000 });
  const backend = new BrowserBackend();
  const { id } = await backend.start(`${server.base}/show/master.m3u8`, 'video_best');
  try {
    await sleep(500);
    const early = await backend.poll(id);
    assert.equal(early.stage, 'downloading');
    assert.ok(Math.abs(early.totalBytes - 5.4e9) < 1e8, `estimated from the playlist before a segment arrives: ${early.totalBytes}`);
    assert.match(String(early.note), /Large file/);
  } finally {
    await backend.cancel(id);
    server.close();
  }
});

test('a stream with no stated bitrate is sized from its segments as they arrive', async () => {
  const server = await host({ '/show/index.m3u8': playlist(20, 6) }, { segmentBytes: 100_000, delay: 100 });
  const backend = new BrowserBackend();
  const { id } = await backend.start(`${server.base}/show/index.m3u8`, 'video_best');
  try {
    await sleep(1200);
    const state = await backend.poll(id);
    assert.equal(state.stage, 'downloading');
    assert.ok(state.progress > 0 && state.progress < 1, `progress ${state.progress}`);
    assert.equal(state.totalBytes, 2_000_000, 'twenty segments the size of the ones in so far');
    assert.ok(state.eta > 0, `a time left: ${state.eta}`);
    assert.equal(state.note, null, 'two megabytes is not worth a warning');
  } finally {
    await backend.cancel(id);
    server.close();
  }
});

test('a backend built over another keeps its jobs: saving settings does not orphan a download', async () => {
  // Saving settings builds the backend again. A fresh job table would not
  // know a download still running, whose next poll would call it gone while
  // it carried on unseen.
  const { makeBackend } = await import('../web/api.js');
  const server = await host({ '/show/index.m3u8': playlist(20, 6) }, { segmentBytes: 1000, delay: 5000 });
  const first = makeBackend({ endpoint: '', key: '', helper: { kind: 'none', label: 'this device only' } });
  const { id } = await first.start(`${server.base}/show/index.m3u8`, 'video_best');
  const second = makeBackend({ endpoint: 'https://relay.example', key: '', helper: { kind: 'relay', label: 'relay' } }, first);
  try {
    await sleep(300);
    const state = await second.poll(id);
    assert.equal(state.state, 'running', 'the running job is still known');
    assert.equal(state.stage, 'downloading');
    assert.equal(second.device.net.escape?.name, 'relay', 'and what starts next goes the new way');
  } finally {
    await second.cancel(id);
    server.close();
  }
  assert.equal(first.device.jobs.has(id), false, 'a cancel through the new backend stops it');
});

test('a list queued on this device without a probe says it is a list, not that it offered nothing', async () => {
  // Your server's yt-dlp answers a playlist or a channel with the list and no
  // formats. With a probe in hand the queue takes it one row each; queued
  // without one — two lists pasted at once, a share — it reached the planner,
  // which read the empty formats as a link with nothing to download.
  const list = {
    name: 'server',
    generic: true,
    resolve: async () => ({
      title: 'A list',
      extractor: 'youtube:tab',
      formats: [],
      playlist: { count: 2, limit: 2, entries: [{ url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa', title: 'One' }, { url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb', title: 'Two' }] },
    }),
  };
  const backend = new BrowserBackend({ resolvers: [list] });
  const { id } = await backend.start('https://www.youtube.com/playlist?list=PLxxxxxxxxxxxxxxxx', 'video_best');
  let state = await backend.poll(id);
  for (let tries = 0; state.state === 'running' && tries < 50; tries += 1) {
    await sleep(20);
    state = await backend.poll(id);
  }
  assert.equal(state.state, 'error');
  assert.match(String(state.error), /is a list/);
  assert.doesNotMatch(String(state.error), /no downloadable formats/);
});
