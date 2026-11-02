/**
 * The access key of your own server, never in clear text in storage.
 *
 * GitHub Pages serves every project of an account from one origin, so this
 * page's localStorage is shared with dozens of other sites, and anything any
 * of them writes or reads there sits beside our settings. The settings stay in
 * localStorage; the key does not. llm-connect's sealedStore keeps it: AES-GCM
 * under a non-extractable CryptoKey in an IndexedDB database of our own, a
 * fresh IV on every save and the name bound to the record, so a dump of the
 * origin's storage yields opaque bytes and no token.
 *
 * Without IndexedDB or WebCrypto (some private modes) the key lasts for the
 * page, and every call says so by returning false rather than throwing.
 */
import { sealedStore } from './vendor/llm-connect-sealed-store.js';

const ACCESS_KEY = 'access-key';
const sealed = sealedStore({ dbName: 'siphon-sealed' });

/**
 * Where earlier versions sealed the key themselves ({ iv, data } under the
 * CryptoKey beside it). Read once to move the key into the sealed store, then
 * deleted: the name is siphon's own.
 */
const LEGACY_DB = 'siphon-secret';

function idb(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readLegacy() {
  if (!sealed.available) return '';
  try {
    // An upgrade means there was no such database: aborted, so none is created.
    const open = indexedDB.open(LEGACY_DB);
    open.onupgradeneeded = () => open.transaction?.abort();
    const db = await idb(open);
    try {
      if (!db.objectStoreNames.contains('kv')) return '';
      const store = () => db.transaction('kv', 'readonly').objectStore('kv');
      const key = await idb(store().get('crypto-key'));
      const secret = await idb(store().get(ACCESS_KEY));
      if (!key || !secret?.iv || !secret?.data) return '';
      return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: secret.iv }, key, secret.data));
    } finally {
      db.close();
    }
  } catch {
    return '';
  }
}

function dropLegacy() {
  try {
    indexedDB.deleteDatabase(LEGACY_DB);
  } catch {
    // Nothing to clean up
  }
}

/** @returns {Promise<string>} the saved key, or '' when there is none or it cannot be read */
export async function readSecret() {
  const value = await sealed.get(ACCESS_KEY);
  if (value !== null) return value;
  // A key kept by an earlier version: moved over, and its old copy dropped
  // only once the new one is stored, so it is never lost.
  const legacy = await readLegacy();
  if (legacy && (await sealed.set(ACCESS_KEY, legacy))) dropLegacy();
  return legacy;
}

/**
 * Keep the key, or forget it when it is empty.
 *
 * @returns {Promise<boolean>} whether it will survive a reload (no key to keep counts as kept)
 */
export async function writeSecret(value) {
  if (!value) {
    await sealed.delete(ACCESS_KEY);
    if (sealed.available) dropLegacy();
    return true;
  }
  if (!(await sealed.set(ACCESS_KEY, value))) return false;
  dropLegacy();
  return true;
}
