/**
 * The converter's plumbing: what is held while ffmpeg runs, and what a cancel
 * actually stops.
 *
 * ffmpeg.wasm itself is not here — it is 32 MB, fetched at deploy time, and
 * the end-to-end suites run the real one. These drive the two files around it
 * with a stand-in core and a stand-in Worker, which is enough to pin the
 * decisions: how many copies of a video exist at once, and whether a
 * cancelled conversion keeps the next one waiting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* ------------------------------------------------------------ the worker */

/** ffmpeg-worker.js in a sandbox of its own, with a core that records what it was handed. */
function loadWorker() {
  const calls = { writeFile: [], readFile: [], unlink: [] };
  const replies = [];
  const files = new Map();
  const core = {
    ret: 0,
    FS: {
      writeFile: (name, data, opts) => {
        calls.writeFile.push({ name, data, opts });
        files.set(name, data);
      },
      readFile: (name) => {
        calls.readFile.push(name);
        return new Uint8Array(files.get(name));
      },
      unlink: (name) => {
        calls.unlink.push(name);
        files.delete(name);
      },
    },
    setTimeout() {},
    setLogger() {},
    setProgress() {},
    exec: () => files.set('out.mp4', new Uint8Array(8)),
  };
  const self = {
    postMessage: (message) => replies.push(message),
    createFFmpegCore: async () => core,
  };
  const context = vm.createContext({ self, btoa, importScripts: () => {} });
  vm.runInContext(readFileSync(new URL('../web/ffmpeg-worker.js', import.meta.url), 'utf8'), context);
  return { self, calls, replies };
}

test('the worker hands each input to the core to own, not to copy', async () => {
  // The inputs were transferred to the worker so that no copy is made. The
  // core copies whatever it is not told it may own, and a payload that keeps
  // pointing at the buffer keeps it alive through the run: the input then
  // exists twice, beside the output, and a 300 MB video costs 900.
  const { self, calls, replies } = loadWorker();
  await self.onmessage({ data: { id: 1, type: 'load', payload: { coreURL: 'core.js', wasmURL: 'core.wasm', workerURL: 'core.worker.js' } } });
  const payload = { inputs: [{ name: 'video.mp4', data: new Uint8Array(16) }, { name: 'audio.m4a', data: new Uint8Array(8) }], args: ['-i', 'video.mp4'], output: 'out.mp4' };
  await self.onmessage({ data: { id: 2, type: 'run', payload } });

  assert.equal(replies.at(-1).type, 'result', JSON.stringify(replies.at(-1)));
  assert.deepEqual(calls.writeFile.map((call) => call.opts?.canOwn), [true, true]);
  assert.ok(payload.inputs.every((input) => input.data === null), 'the message no longer holds the inputs');
  assert.deepEqual(calls.unlink.slice(0, 2), ['video.mp4', 'audio.m4a'], 'and the inputs are gone before the output is read');
  assert.ok(calls.unlink.indexOf('audio.m4a') < calls.unlink.indexOf('out.mp4'));
});

/* ------------------------------------------------------------- cancelling */

/**
 * A Worker that behaves as ffmpeg-worker.js does where it matters: it loads
 * at once, and a run occupies it until the run is over. A run titled `long`
 * never finishes on its own — only terminate() ends it.
 */
const workers = [];
globalThis.Worker = class {
  constructor() {
    this.runs = [];
    this.terminated = false;
    this.busy = false;
    this.queue = [];
    workers.push(this);
  }

  postMessage(message) {
    this.queue.push(message);
    this.next();
  }

  next() {
    if (this.busy || this.terminated || this.queue.length === 0) return;
    const { id, type, payload } = this.queue.shift();
    if (type === 'load') {
      setTimeout(() => !this.terminated && this.onmessage({ data: { id, type: 'loaded' } }), 0);
      return this.next();
    }
    const title = payload.args.find((arg) => String(arg).startsWith('title=')) || '';
    this.runs.push(title);
    this.args = payload.args;
    this.busy = true;
    if (title === 'title=long') return undefined;
    setTimeout(() => {
      this.busy = false;
      if (this.terminated) return;
      this.onmessage({ data: { id, type: 'result', data: new Uint8Array(4) } });
      this.next();
    }, 5);
    return undefined;
  }

  terminate() {
    this.terminated = true;
  }
};

const { toAudio } = await import('../web/media.js');

const convert = (title, signal) =>
  toAudio({ source: { ext: 'm4a', data: new Uint8Array(4) }, ext: 'mp3', tags: { title }, signal });

/** Settles within `ms`, or says it did not. */
const within = (promise, ms) =>
  Promise.race([
    promise.then(() => 'done', (error) => error?.name || String(error)),
    new Promise((resolve) => setTimeout(() => resolve('still waiting'), ms)),
  ]);

const until = async (condition) => {
  for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

test('cancelling a conversion stops ffmpeg, and the next one does not wait for it', async () => {
  // exec is synchronous inside the worker, so a run already in there cannot
  // be told to stop: the worker reads no message until it is done. A
  // cancelled hour-long MP3 used to keep the CPU and the memory until the
  // end, and every job after it waited in line behind it.
  const controller = new AbortController();
  const long = convert('long', controller.signal);
  await until(() => workers.at(-1)?.runs.includes('title=long'));
  const running = workers.at(-1);
  controller.abort();
  assert.equal(await within(long, 200), 'AbortError');
  assert.equal(running.terminated, true, 'the worker running it was stopped');

  assert.equal(await within(convert('short'), 1000), 'done', 'a new conversion runs on a fresh core');
  assert.notEqual(workers.at(-1), running);
});

test('a conversion cancelled while it waits its turn never reaches ffmpeg, and costs no one else theirs', async () => {
  const first = new AbortController();
  const long = convert('long', first.signal);
  await until(() => workers.at(-1)?.runs.includes('title=long'));
  const running = workers.at(-1);

  const second = new AbortController();
  const waiting = convert('waiting', second.signal);
  const after = convert('after');
  second.abort();
  assert.equal(await within(waiting, 200), 'AbortError');
  assert.equal(running.terminated, false, 'leaving the line stops nothing else');
  assert.equal(running.runs.at(-1), 'title=long', 'nothing was handed to the worker behind the running one');

  // The one behind it still waits for the conversion actually running.
  assert.equal(await within(after, 100), 'still waiting');
  first.abort();
  await long.catch(() => {});
  assert.equal(await within(after, 1000), 'done');
  assert.ok(!workers.some((worker) => worker.runs.includes('title=waiting')));
});

/* ------------------------------------------------------------------ covers */

test('a cover that is already a JPEG goes in as it is, and only another kind is encoded', async () => {
  // ffmpeg.wasm never returned from re-encoding YouTube's own thumbnail as
  // MJPEG: every MP3 and M4A of a YouTube video made on the device sat at
  // "Converting…" for good. Native ffmpeg does it in no time; copying the
  // JPEG that is already there does too, and loses nothing.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const codec = async (cover, ext) => {
    await toAudio({ source: { ext: 'm4a', data: new Uint8Array(4) }, ext, cover, tags: { title: `cover-${ext}` } });
    const args = workers.at(-1).args;
    return args[args.indexOf('-c:v') + 1];
  };
  assert.equal(await codec(jpeg, 'm4a'), 'copy');
  assert.equal(await codec(jpeg, 'mp3'), 'copy');
  assert.equal(await codec(png, 'm4a'), 'mjpeg');
});
