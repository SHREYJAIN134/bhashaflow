// IndexedDB storage for the translation cache (same contract as createMemoryStorage in translation-cache.js).
// Runs in the extension's service worker, so the database belongs to the extension's own origin: websites
// cannot read it, and it is separate from any site's storage. One object store, indexed by lastUsedAt for LRU.

const STORE = 'entries';

export function createIdbStorage({ name = 'bhashaflow-cache', idb = globalThis.indexedDB } = {}) {
  let opening = null;

  function open() {
    if (opening) return opening;
    opening = new Promise((resolve, reject) => {
      if (!idb) { reject(new Error('IndexedDB is unavailable')); return; }
      const request = idb.open(name, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('lastUsedAt', 'lastUsedAt');
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = null; };
        db.onclose = () => { opening = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error || new Error('Could not open the cache database'));
      request.onblocked = () => reject(new Error('Cache database is blocked by another connection'));
    }).catch((err) => { opening = null; throw err; });
    return opening;
  }

  /** setup(store) issues requests and returns a function producing the result once the transaction commits. */
  async function withStore(mode, setup) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let finish = () => undefined;
      tx.oncomplete = () => resolve(finish());
      tx.onerror = () => reject(tx.error || new Error('Cache transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('Cache transaction aborted'));
      try {
        finish = setup(tx.objectStore(STORE)) || finish;
      } catch (err) {
        reject(err);
        try { tx.abort(); } catch { /* already finished */ }
      }
    });
  }

  return {
    getMany(keys) {
      return withStore('readonly', (store) => {
        const found = new Map();
        for (const key of keys) {
          store.get(key).onsuccess = (e) => { if (e.target.result !== undefined) found.set(key, e.target.result); };
        }
        return () => found;
      });
    },
    putMany(records) {
      return withStore('readwrite', (store) => { for (const r of records) store.put(r); });
    },
    deleteMany(keys) {
      return withStore('readwrite', (store) => { for (const k of keys) store.delete(k); });
    },
    count() {
      return withStore('readonly', (store) => {
        let n = 0;
        store.count().onsuccess = (e) => { n = e.target.result; };
        return () => n;
      });
    },
    indexedCount() { // records present in the lastUsedAt index (valid keys only)
      return withStore('readonly', (store) => {
        let n = 0;
        store.index('lastUsedAt').count().onsuccess = (e) => { n = e.target.result; };
        return () => n;
      });
    },
    orphans(limit) { // records whose lastUsedAt is not a finite number: they can never be aged out by recency
      return withStore('readonly', (store) => {
        const keys = [];
        store.openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor || keys.length >= limit) return;
          const v = cursor.value;
          if (!(v && Number.isFinite(v.lastUsedAt))) keys.push(cursor.primaryKey);
          cursor.continue();
        };
        return () => keys;
      });
    },
    sumBytes() {
      return withStore('readonly', (store) => {
        let total = 0;
        store.openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor) return;
          const size = cursor.value && cursor.value.size;
          total += Number.isFinite(size) ? size : 0;
          cursor.continue();
        };
        return () => total;
      });
    },
    oldest(n) {
      return withStore('readonly', (store) => {
        const out = [];
        store.index('lastUsedAt').openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (!cursor || out.length >= n) return;
          const v = cursor.value || {};
          out.push({ key: cursor.primaryKey, size: Number.isFinite(v.size) ? v.size : 0, lastUsedAt: Number.isFinite(v.lastUsedAt) ? v.lastUsedAt : Infinity });
          cursor.continue();
        };
        return () => out;
      });
    },
    clear() {
      return withStore('readwrite', (store) => { store.clear(); });
    },
  };
}
