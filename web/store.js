/**
 * Where a finished file lives until you save it.
 *
 * The server mode keeps finished downloads on disk until a TTL sweeps them,
 * which is what lets a row survive a reload. Browser mode gets the same
 * behaviour from the origin private file system: files written there are on
 * the device's disk, not in the tab's heap, so a 400 MB video does not have to
 * be held in memory while it waits to be saved, and it is still there after a
 * refresh.
 *
 * OPFS is not everywhere, and `createWritable` in particular arrived late on
 * Safari, so every call degrades to an in-memory blob rather than failing.
 * That loses the survive-a-reload property and nothing else.
 */

const FOLDER = 'downloads';
const memory = new Map();
let directoryPromise = null;

async function directory() {
  if (!navigator.storage?.getDirectory) return null;
  if (!directoryPromise) {
    directoryPromise = navigator.storage
      .getDirectory()
      .then((root) => root.getDirectoryHandle(FOLDER, { create: true }))
      .catch(() => null);
  }
  return directoryPromise;
}

/** Keys come from queue entries, which are ours, but a path separator would still escape. */
const safeKey = (key) => String(key).replace(/[^\w.-]/g, '_');

/**
 * Keep a finished file.
 *
 * @returns {Promise<boolean>} whether it went to disk (and so survives a reload)
 */
export async function put(key, blob) {
  const folder = await directory();
  if (folder) {
    try {
      const handle = await folder.getFileHandle(safeKey(key), { create: true });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return true;
    } catch {
      /* quota, or a browser without createWritable — fall through */
    }
  }
  memory.set(key, blob);
  return false;
}

/**
 * Keep a file that is still arriving, without ever holding it whole.
 *
 * `put` takes a Blob, which means the caller already has the entire video in
 * the tab's heap — fine for a four-minute song, not for a two-hour film on a
 * phone. A writer takes it chunk by chunk straight to disk instead, so the
 * heap never holds more than whatever just came off the socket.
 *
 * `reset` exists because a download can be told to start over mid-flight (a
 * host that ignores a resume and sends the file again); the bytes written so
 * far then have to go, or the file would be its own prefix plus itself.
 *
 * Degrades to memory exactly as `put` does, so a browser without
 * `createWritable` still works — it just loses the not-in-the-heap property
 * that is the whole point.
 *
 * @returns {Promise<{onDisk: boolean, write: (chunk: Uint8Array) => Promise<void>,
 *   reset: () => Promise<void>, done: (mime?: string) => Promise<Blob>, abort: () => Promise<void>}>}
 */
export async function writer(key) {
  const folder = await directory();
  if (folder) {
    try {
      const handle = await folder.getFileHandle(safeKey(key), { create: true });
      let writable = await handle.createWritable();
      return {
        onDisk: true,
        async write(chunk) {
          await writable.write(chunk);
        },
        async reset() {
          await writable.close().catch(() => {});
          writable = await handle.createWritable();
        },
        async done(mime = '') {
          await writable.close();
          const file = await handle.getFile();
          // `slice` with a type is a view, not a copy: the bytes stay on disk
          // and the tab gets something it can name and hand over.
          return mime ? file.slice(0, file.size, mime) : file;
        },
        async abort() {
          await writable.abort?.().catch(() => {});
          await folder.removeEntry(safeKey(key)).catch(() => {});
        },
      };
    } catch {
      /* quota, or a browser without createWritable — fall through to memory */
    }
  }

  let parts = [];
  return {
    onDisk: false,
    async write(chunk) {
      parts.push(chunk);
    },
    async reset() {
      parts = [];
    },
    async done(mime = '') {
      const blob = new Blob(parts, mime ? { type: mime } : undefined);
      parts = [];
      memory.set(key, blob);
      return blob;
    },
    async abort() {
      parts = [];
      memory.delete(key);
    },
  };
}

/** @returns {Promise<Blob|null>} */
export async function get(key) {
  if (memory.has(key)) return memory.get(key);
  const folder = await directory();
  if (!folder) return null;
  try {
    const handle = await folder.getFileHandle(safeKey(key));
    return await handle.getFile();
  } catch {
    return null;
  }
}

export async function drop(key) {
  memory.delete(key);
  const folder = await directory();
  if (!folder) return;
  await folder.removeEntry(safeKey(key)).catch(() => {});
}

/**
 * Delete anything older than the TTL.
 *
 * Without this the origin accumulates every video ever downloaded until the
 * browser evicts the whole origin's storage — which on iOS takes the settings
 * and the queue with it.
 */
export async function sweep(ttlMs) {
  const folder = await directory();
  if (!folder?.entries) return;
  const cutoff = Date.now() - ttlMs;
  try {
    for await (const [name, handle] of folder.entries()) {
      if (handle.kind !== 'file') continue;
      const file = await handle.getFile().catch(() => null);
      if (!file || file.lastModified > cutoff) continue;
      await folder.removeEntry(name).catch(() => {});
    }
  } catch {
    /* iterating is best-effort; a failure just means a later sweep tries again */
  }
}
