/**
 * The access key of your own server, never in clear text in storage.
 *
 * GitHub Pages serves every project of an account from one origin, so this
 * page's localStorage is shared with dozens of other sites, and anything any
 * of them writes or reads there sits beside our settings. The settings stay in
 * localStorage; the key does not. It is encrypted with AES-GCM under a
 * non-extractable CryptoKey kept in an IndexedDB database of our own, with a
 * fresh IV on every save, so a dump of the origin's storage yields opaque
 * bytes and no token.
 *
 * Without IndexedDB or WebCrypto (some private modes) the key lasts for the
 * page, and every call says so by returning false rather than throwing.
 */

const DB = 'siphon-secret';
const STORE = 'kv';
const CRYPTO_KEY = 'crypto-key';
const ACCESS_KEY = 'access-key';

function available() {
  try {
    return !!globalThis.indexedDB && !!globalThis.crypto?.subtle;
  } catch {
    return false;
  }
}

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('blocked'));
  });
}

async function run(mode, action) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = action(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const get = (id) => run('readonly', (store) => store.get(id));
const put = (id, value) => run('readwrite', (store) => store.put(value, id));
const remove = (id) => run('readwrite', (store) => store.delete(id));

/** @returns {Promise<string>} the saved key, or '' when there is none or it cannot be read */
export async function readSecret() {
  if (!available()) return '';
  try {
    const [key, secret] = [await get(CRYPTO_KEY), await get(ACCESS_KEY)];
    if (!key || !secret?.iv || !secret?.data) return '';
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: secret.iv }, key, secret.data);
    return new TextDecoder().decode(plain);
  } catch {
    return '';
  }
}

/**
 * Keep the key, or forget it when it is empty.
 *
 * @returns {Promise<boolean>} whether it will survive a reload (no key to keep counts as kept)
 */
export async function writeSecret(value) {
  if (!available()) return !value;
  try {
    if (!value) {
      await remove(ACCESS_KEY);
      return true;
    }
    let key = await get(CRYPTO_KEY);
    if (!key) {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await put(CRYPTO_KEY, key);
    }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
    await put(ACCESS_KEY, { iv, data });
    return true;
  } catch {
    return false;
  }
}
