/**
 * Where a device download's bytes wait on disk.
 *
 * Against a stand-in for the origin private file system that commits the way
 * the real one does: what a writable was given reaches the file on close(),
 * and never on abort().
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const files = new Map();

class Writable {
  constructor(name) {
    this.name = name;
    this.swap = [];
  }

  async write(chunk) {
    this.swap.push(Buffer.from(chunk));
  }

  async close() {
    files.set(this.name, Buffer.concat(this.swap));
    this.swap = [];
  }

  async abort() {
    this.swap = [];
  }
}

const folder = {
  async getFileHandle(name, { create = false } = {}) {
    if (!files.has(name)) {
      if (!create) throw new DOMException('A requested file or directory could not be found.', 'NotFoundError');
      files.set(name, Buffer.alloc(0));
    }
    return {
      async createWritable() {
        return new Writable(name);
      },
      async getFile() {
        return new File([files.get(name)], name);
      },
    };
  },
  async removeEntry(name) {
    files.delete(name);
  },
};

Object.defineProperty(globalThis, 'navigator', {
  value: { storage: { getDirectory: async () => ({ getDirectoryHandle: async () => folder }) } },
  configurable: true,
});
const store = await import('../web/store.js');

test('a download told to start over leaves nothing behind that passes for a finished file', async () => {
  // A host that ignores a resume sends the file again, and the bytes so far
  // are let go. Committed instead, a reload during the second attempt
  // brought the first attempt's bytes back as "Ready".
  const sink = await store.writer('restarted');
  assert.equal(sink.onDisk, true);
  await sink.write(new Uint8Array(1000).fill(1));
  await sink.reset();
  await sink.write(new Uint8Array(10).fill(2));
  // The tab is reloaded here: this attempt never reaches done().
  assert.equal(await store.get('restarted'), null);
});

test('and when it finishes, the file is the second attempt alone', async () => {
  const sink = await store.writer('finished');
  await sink.write(new Uint8Array(1000).fill(1));
  await sink.reset();
  await sink.write(new Uint8Array(10).fill(2));
  const file = await sink.done('video/mp4');
  assert.equal(file.size, 10);
  assert.equal(file.type, 'video/mp4');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], Array(10).fill(2));
});
