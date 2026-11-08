// Persistent translation cache (storage-agnostic: IndexedDB in the extension, memory in tests/fallback).
//
// What is stored: a SHA-256 key and the validated Hinglish template. The English source text is NEVER stored
// (the key is a one-way hash), so the cache holds only output we produced, not a copy of what you read.
//
// Key = hash of [schema, promptVersion, model, pageTitle, role, heading, sourceTemplate]: everything that is sent
// to the model and can change its answer. Prompt version and model are in the key, so hinglish-v1 and
// hinglish-v2 (or two models) can never serve each other's translations. The page title and heading are the
// disambiguating context the model receives ("bank" on a river page vs a finance page), so a sentence is only
// reused where it was translated with the same context. The price is less reuse of the same sentence across
// different pages, which is the correct trade: a wrong-sense translation is worse than one extra request.
// When "send page title" is off, nothing is sent, so the title/heading parts are empty in the key as well.
//
// Failure policy: the cache is an optimisation. Any storage error, corrupt entry or quota problem results in a
// cache miss, never in a failed translation.

import { parseConverted, sourceFromTemplate } from '../shared/tokens.js';

export const CACHE_SCHEMA = 2; // 2: page title joined the key (v1 entries simply age out)
export const CACHE_LIMITS = Object.freeze({
  maxEntries: 5000, // ~2-3 MB at typical sizes
  maxBytes: 5 * 1024 * 1024, // approximate (UTF-16) size of stored translations
  ttlMs: 90 * 24 * 3600 * 1000, // unused for 90 days -> expired
  evictTo: 0.8, // when over a limit, evict least-recently-used entries down to 80% of it
  touchAfterMs: 3600 * 1000, // refresh lastUsedAt at most hourly to limit writes
  cooldownMs: 60 * 1000, // after a storage failure, skip the cache for a minute
});

/** The backend truncates titles to 200 characters, so the key must too (same context = same key). */
export const normaliseTitle = (title) => (typeof title === 'string' ? title.trim().slice(0, 200) : '');

const toHex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function cacheKey({ promptVersion, model, title, text, role, heading, lang = 'hinglish' }) {
  // Target language AND the prompt version of that language are both part of the key: Hinglish and Tanglish can never collide.
  const canonical = JSON.stringify([CACHE_SCHEMA, lang, promptVersion || '', model || '', normaliseTitle(title), role || 'paragraph', heading || '', text]);
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
}

const sizeOf = (hinglish) => hinglish.length * 2 + 120;

const isIndexable = (v) => (typeof v === 'number' && !Number.isNaN(v)) || typeof v === 'string';
const indexOrder = (a, b) => (typeof a === typeof b ? (a < b ? -1 : a > b ? 1 : 0) : typeof a === 'number' ? -1 : 1);

/** In-memory storage: used by tests and as the fallback when IndexedDB is unavailable. Same contract as idb-storage.js. */
export function createMemoryStorage() {
  const map = new Map();
  return {
    _map: map,
    async getMany(keys) { return new Map(keys.filter((k) => map.has(k)).map((k) => [k, map.get(k)])); },
    async putMany(records) { for (const r of records) map.set(r.key, r); },
    async deleteMany(keys) { for (const k of keys) map.delete(k); },
    async count() { return map.size; },
    // Like the IndexedDB index on lastUsedAt: only valid index keys (finite numbers, strings) are listed, numbers first.
    async indexedCount() { return [...map.values()].filter((r) => isIndexable(r && r.lastUsedAt)).length; },
    async sumBytes() { let n = 0; for (const r of map.values()) n += Number.isFinite(r && r.size) ? r.size : 0; return n; },
    async oldest(n) {
      return [...map.values()].filter((r) => isIndexable(r && r.lastUsedAt))
        .sort((a, b) => indexOrder(a.lastUsedAt, b.lastUsedAt))
        .slice(0, n).map((r) => ({ key: r.key, size: Number.isFinite(r.size) ? r.size : 0, lastUsedAt: Number.isFinite(r.lastUsedAt) ? r.lastUsedAt : Infinity }));
    },
    // Records whose lastUsedAt is not a finite number can never be aged out by recency: report them for removal.
    async orphans(n) { return [...map.entries()].filter(([, r]) => !(r && Number.isFinite(r.lastUsedAt))).map(([k]) => k).slice(0, n); },
    async clear() { map.clear(); },
  };
}

export function createTranslationCache({ storage, limits = CACHE_LIMITS, now = Date.now, onError = () => {} }) {
  let unhealthyUntil = 0;
  let bytes = null; // running estimate of stored bytes; null = unknown, recomputed lazily

  /** Runs a storage operation; any failure disables the cache briefly and returns the fallback. */
  async function guard(fn, fallback) {
    if (now() < unhealthyUntil) return fallback;
    try {
      return await fn();
    } catch (err) {
      unhealthyUntil = now() + limits.cooldownMs;
      bytes = null;
      onError(err);
      return fallback;
    }
  }

  function isValid(entry, request) {
    if (!entry || typeof entry !== 'object' || entry.key !== request.key || entry.v !== CACHE_SCHEMA) return false;
    if (typeof entry.hinglish !== 'string' || !entry.hinglish.trim()) return false;
    if (!Number.isFinite(entry.lastUsedAt) || !Number.isFinite(entry.createdAt)) return false;
    const source = sourceFromTemplate(request.text);
    return Boolean(source && parseConverted(entry.hinglish, source)); // re-validate placeholders on every read
  }

  /** requests: [{ key, text }] -> Map(key -> hinglish) for valid, unexpired hits. */
  async function getMany(requests) {
    const out = new Map();
    if (!requests.length) return out;
    const found = await guard(() => storage.getMany(requests.map((r) => r.key)), new Map());
    const bad = [];
    const touched = [];
    const t = now();
    for (const request of requests) {
      if (!found.has(request.key)) continue;
      const entry = found.get(request.key);
      if (!isValid(entry, request) || t - entry.lastUsedAt > limits.ttlMs) { bad.push(request.key); continue; }
      out.set(request.key, entry.hinglish);
      if (t - entry.lastUsedAt > limits.touchAfterMs) touched.push({ ...entry, lastUsedAt: t });
    }
    if (bad.length) { // corrupt or expired: remove so it is not re-read, and treat as a miss
      bytes = null;
      await guard(() => storage.deleteMany(bad));
    }
    if (touched.length) await guard(() => storage.putMany(touched));
    return out;
  }

  /** entries: [{ key, text, hinglish }]. Only translations whose placeholders validate are stored. */
  async function putMany(entries) {
    const t = now();
    const records = [];
    for (const e of entries) {
      const source = sourceFromTemplate(e.text);
      if (!source || typeof e.hinglish !== 'string' || !parseConverted(e.hinglish, source)) continue;
      records.push({ v: CACHE_SCHEMA, key: e.key, hinglish: e.hinglish, size: sizeOf(e.hinglish), createdAt: t, lastUsedAt: t });
    }
    if (!records.length) return 0;
    const stored = await guard(async () => {
      try {
        await storage.putMany(records);
      } catch (err) {
        if (!err || err.name !== 'QuotaExceededError') throw err;
        await evict(0.5); // disk full: free half of what we hold and try once more
        await storage.putMany(records);
      }
      if (bytes !== null) bytes += records.reduce((n, r) => n + r.size, 0);
      return records.length;
    }, 0);
    if (stored) await prune();
    return stored;
  }

  /** Evict least-recently-used entries until at most `fraction` of each limit remains. */
  async function evict(fraction) {
    let count = await storage.count();
    if (bytes === null) bytes = await storage.sumBytes();
    const targetCount = Math.floor(limits.maxEntries * fraction);
    const targetBytes = limits.maxBytes * fraction;
    let evicted = 0;
    while (count > targetCount || bytes > targetBytes) {
      const oldest = await storage.oldest(100);
      if (!oldest.length) break;
      const drop = [];
      for (const e of oldest) {
        if (count <= targetCount && bytes <= targetBytes) break;
        drop.push(e.key);
        count--;
        bytes -= e.size;
      }
      if (!drop.length) break;
      await storage.deleteMany(drop);
      evicted += drop.length;
    }
    bytes = Math.max(0, bytes);
    return evicted;
  }

  /** Drops expired entries, then enforces the entry and size limits (LRU). Safe to call at any time. */
  let prunes = 0;
  async function prune() {
    return guard(async () => {
      const t = now();
      // Records with a missing or non-numeric lastUsedAt (corruption) sort last or not at all in the recency index,
      // so LRU eviction would never reach them and would evict healthy entries instead. Sweep them first: on the
      // first prune of a worker, whenever the index is smaller than the store, whenever a limit is exceeded (before
      // any eviction), and every 20th prune as a cheap safety net.
      const total = await storage.count();
      if (bytes === null) bytes = await storage.sumBytes();
      const overLimit = total > limits.maxEntries || bytes > limits.maxBytes;
      if (prunes++ % 20 === 0 || overLimit || total !== (await storage.indexedCount())) {
        for (let i = 0; i < 10; i++) {
          const orphans = await storage.orphans(200);
          if (!orphans.length) break;
          await storage.deleteMany(orphans);
          bytes = null;
        }
      }
      for (;;) { // expired entries are the least recently used, so they come first
        const oldest = await storage.oldest(100);
        const expired = oldest.filter((e) => t - e.lastUsedAt > limits.ttlMs).map((e) => e.key);
        if (!expired.length) break;
        await storage.deleteMany(expired);
        bytes = null;
        if (expired.length < oldest.length) break;
      }
      const count = await storage.count();
      if (bytes === null) bytes = await storage.sumBytes();
      if (count > limits.maxEntries || bytes > limits.maxBytes) return evict(limits.evictTo);
      return 0;
    }, 0);
  }

  async function clear() {
    return guard(async () => {
      const removed = await storage.count();
      await storage.clear();
      bytes = 0;
      return removed;
    }, 0);
  }

  async function stats() {
    return guard(async () => ({ entries: await storage.count(), bytes: await storage.sumBytes(), healthy: true }), { entries: 0, bytes: 0, healthy: false });
  }

  return { getMany, putMany, prune, clear, stats };
}
