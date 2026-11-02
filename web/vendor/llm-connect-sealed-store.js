// Vendored from llm-connect@2.7.0, build/sealed-store.js (MIT). Do not edit: the app has no build
// step, so the package's file is copied here as is, and tests/vendor.test.js fails if it drifts.

/**
 * Secrets sealed at rest with AES-GCM 256 under a non-extractable CryptoKey
 * kept in IndexedDB, with a fresh IV on every write and the secret's name
 * bound as additional data, so a record copied under another name does not
 * open. `secureStorage` keeps its API key here; an app keeps any other secret
 * (a sync token, a TURN password, a server key) the same way, without writing
 * its own crypto.
 *
 * A dump of the browser's storage only yields opaque bytes. Script running on
 * the same origin can still have the browser decrypt: on an origin shared by
 * several sites (the project pages of a user.github.io) that includes every
 * one of them. Only a passphrase (see `createKeyVault`) protects against that.
 */
const STORE = "kv";
const CRYPTO_KEY_ID = "crypto-key";
function hasCrypto() {
    try {
        return !!globalThis.indexedDB && !!globalThis.crypto?.subtle;
    }
    catch {
        return false;
    }
}
/** Raised by `seal` when there is no WebCrypto or IndexedDB to seal with. */
export class SealedStoreUnavailable extends Error {
    constructor() {
        super("No IndexedDB or WebCrypto to seal secrets with");
        this.name = "SealedStoreUnavailable";
    }
}
export function sealedStore({ dbName }) {
    const available = hasCrypto();
    const encoder = new TextEncoder();
    function openDb() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(dbName, 1);
            request.onupgradeneeded = () => request.result.createObjectStore(STORE);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    async function withStore(mode, run) {
        const db = await openDb();
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, mode);
                const request = run(tx.objectStore(STORE));
                // Resolved on commit only: a full quota aborts the transaction after the request succeeded
                tx.oncomplete = () => resolve(request.result);
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error ?? new DOMException("Aborted", "AbortError"));
            });
        }
        finally {
            db.close();
        }
    }
    const idbGet = (id) => withStore("readonly", (s) => s.get(id));
    async function readOrCreateKey(create) {
        const existing = await idbGet(CRYPTO_KEY_ID);
        if (existing || !create)
            return existing;
        const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
            "encrypt",
            "decrypt",
        ]);
        try {
            // add, not put: another tab creating its key at the same moment must not replace ours
            await withStore("readwrite", (s) => s.add(key, CRYPTO_KEY_ID));
            return key;
        }
        catch (error) {
            const winner = await idbGet(CRYPTO_KEY_ID).catch(() => undefined);
            if (winner)
                return winner;
            throw error;
        }
    }
    // Read on each use, not cached: another tab may have destroyed it meanwhile
    const cryptoKey = readOrCreateKey;
    async function seal(name, value) {
        if (!available)
            throw new SealedStoreUnavailable();
        const key = await cryptoKey(true);
        if (!key)
            throw new SealedStoreUnavailable();
        const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
        const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(name) }, key, encoder.encode(value));
        return { v: 2, iv, ciphertext };
    }
    async function unseal(name, record) {
        if (!available || !record?.iv || !record.ciphertext)
            return null;
        try {
            const key = await cryptoKey(false);
            if (!key)
                return null;
            const params = { name: "AES-GCM", iv: record.iv };
            if (record.v === 2)
                params.additionalData = encoder.encode(name);
            const plain = await crypto.subtle.decrypt(params, key, record.ciphertext);
            return new TextDecoder().decode(plain);
        }
        catch {
            // Tampered, copied under another name, or the CryptoKey was cleared
            return null;
        }
    }
    return {
        available,
        seal,
        unseal,
        async get(name) {
            if (!available)
                return null;
            try {
                return await unseal(name, await idbGet(name));
            }
            catch {
                return null;
            }
        },
        async set(name, value) {
            if (!available)
                return false;
            try {
                const record = await seal(name, value);
                await withStore("readwrite", (s) => s.put(record, name));
                return true;
            }
            catch {
                return false;
            }
        },
        async delete(name) {
            if (!available)
                return;
            try {
                await withStore("readwrite", (s) => s.delete(name));
            }
            catch {
                // Nothing to clean up
            }
        },
        async destroy() {
            if (!available)
                return;
            try {
                await withStore("readwrite", (s) => s.clear());
            }
            catch {
                // Nothing to clean up
            }
        },
    };
}
