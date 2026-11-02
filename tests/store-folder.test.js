/**
 * The folder a device download waits in is ours, on an origin that is not.
 *
 * maxgfr.github.io serves every project site of the account from one origin,
 * and the origin private file system belongs to the origin. A folder named
 * "downloads" was anybody's: the sweep would have deleted their files. Ours is
 * named after the app, and what an earlier version left in the old one is
 * brought over — only what is recognisably ours.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

function folder(initial = {}) {
  const files = new Map(Object.entries(initial).map(([name, text]) => [name, Buffer.from(text)]));
  return {
    files,
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) throw new DOMException('not found', 'NotFoundError');
        files.set(name, Buffer.alloc(0));
      }
      return {
        kind: 'file',
        async createWritable() {
          const parts = [];
          return {
            async write(chunk) {
              parts.push(Buffer.from(chunk instanceof Blob ? await chunk.arrayBuffer() : chunk));
            },
            async close() {
              files.set(name, Buffer.concat(parts));
            },
            async abort() {},
          };
        },
        async getFile() {
          return new File([files.get(name)], name, { lastModified: Date.now() });
        },
      };
    },
    async removeEntry(name) {
      files.delete(name);
    },
    async *entries() {
      for (const name of [...files.keys()]) yield [name, await this.getFileHandle(name)];
    },
  };
}

const dirs = new Map([['downloads', folder({ 'b-lq2x3c4-ab12cd': 'ours', 'holiday.jpg': 'theirs' })]]);
const root = {
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!dirs.has(name)) {
      if (!create) throw new DOMException('not found', 'NotFoundError');
      dirs.set(name, folder());
    }
    return dirs.get(name);
  },
};

Object.defineProperty(globalThis, 'navigator', {
  value: { storage: { getDirectory: async () => root } },
  configurable: true,
});
const store = await import('../web/store.js');

test('a finished download from the old folder is still there, in ours', async () => {
  const file = await store.get('b-lq2x3c4-ab12cd');
  assert.equal(await file.text(), 'ours');
  assert.ok(dirs.get('siphon-downloads').files.has('b-lq2x3c4-ab12cd'));
  assert.ok(!dirs.get('downloads').files.has('b-lq2x3c4-ab12cd'));
});

test("and what another site keeps in a folder of the same name is left alone, sweep included", async () => {
  await store.sweep(-1);
  assert.equal(dirs.get('downloads').files.get('holiday.jpg').toString(), 'theirs');
  assert.ok(dirs.has('downloads'));
});

test('new files go to the folder named after the app', async () => {
  await store.put('b-new-xyz', new Blob(['fresh']));
  assert.ok(dirs.get('siphon-downloads').files.has('b-new-xyz'));
  assert.ok(!dirs.get('downloads').files.has('b-new-xyz'));
});
