// Cache + de-duplication in front of the backend. Runs in the service worker.
//
// For each request from a page:
//   1. every item gets a stable key (prompt version, model, page title, role, heading, source template);
//   2. identical items inside the request collapse to one;
//   3. items another in-flight request is already fetching are awaited, not re-sent (concurrent duplicates);
//   4. the rest are looked up in the persistent cache;
//   5. only true misses go to the backend, in ONE request; validated results are cached, then shared.
// The claim in step 3 happens synchronously (no await between "is it in flight?" and "mark it in flight"),
// which is what makes concurrent duplicates safe on a single-threaded worker. Keys are always released
// (finally), so a failed request can never leave a key claimed or a waiter hanging.
//
// Quota circuit-breaker: once the backend reports exhausted daily quota, further cache misses are answered
// locally with the same error until the provider's reset time, so no request is wasted trying. The block is
// stored per model in `breakerStore` (chrome.storage.local in the extension), so it survives service-worker
// restarts; expired blocks are dropped when read. Cache hits keep working throughout. Switching MODEL lifts it.
//
// convert() never throws: whatever goes wrong it answers { ok:false, error } or per-item errors, so a page
// is never left waiting on a message that will not come.

import { parseConverted, sourceFromTemplate } from '../shared/tokens.js';
import { BATCH_LIMITS } from '../content/batching.js';
import { cacheKey, normaliseTitle } from './translation-cache.js';
import { normalizeLanguage, TANGLISH_PROMPT_VERSION } from '../shared/languages.js';

// The prompt version that produced answers for a language: Hinglish uses what the backend reports (/health), Tanglish its own.
const versionFor = (info, lang) => (lang === 'tanglish' ? TANGLISH_PROMPT_VERSION : info.promptVersion);

const MAX_BREAKER_MS = 24 * 3600 * 1000;

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const isObject = (v) => v !== null && typeof v === 'object';

export function createTranslationService({ cache, backend, getInfo, now = Date.now, breakerStore = null }) {
  const inflight = new Map(); // key -> Promise<outcome>
  let breakers = null; // Map<model, { until, error }>, loaded lazily from breakerStore

  const modelKey = (info) => (info ? info.model || '' : '');

  async function persistBreakers() {
    if (!breakerStore) return;
    try { await breakerStore.save(Object.fromEntries(breakers)); } catch { /* storage unavailable: in-memory block still applies */ }
  }

  async function loadBreakers() {
    if (breakers) return;
    breakers = new Map();
    if (!breakerStore) return;
    let dropped = false;
    try {
      const saved = await breakerStore.load();
      for (const [model, b] of Object.entries(isObject(saved) ? saved : {})) {
        const valid = isObject(b) && Number.isFinite(b.until) && isObject(b.error) && typeof b.error.message === 'string';
        if (valid && b.until > now()) breakers.set(model, { until: b.until, error: b.error });
        else dropped = true; // expired or malformed: forget it
      }
    } catch { /* unreadable store: start with no blocks */ }
    if (dropped) await persistBreakers();
  }

  async function activeBreaker(info) {
    await loadBreakers();
    const key = modelKey(info);
    const b = breakers.get(key);
    if (!b) return null;
    if (now() >= b.until) { breakers.delete(key); await persistBreakers(); return null; }
    return b;
  }

  async function armBreaker(info, error) {
    await loadBreakers();
    const waitMs = Math.min((error.retryAfterSec || 0) * 1000 || MAX_BREAKER_MS, MAX_BREAKER_MS);
    breakers.set(modelKey(info), { until: now() + waitMs, error: { code: 'provider-quota-exhausted', message: error.message, ...(error.retryAfterSec !== undefined ? { retryAfterSec: error.retryAfterSec } : {}) } });
    await persistBreakers();
  }

  async function convertInner(payload, useCache) {
    const items = Array.isArray(payload && payload.items) ? payload.items : null;
    if (!items) return { ok: false, error: { code: 'invalid-request', message: 'Malformed translation request' } };

    const info = await getInfo(); // { promptVersion, model } | null (null: backend unknown -> no cache, still dedupes)
    const cacheOk = Boolean(info) && useCache && Boolean(cache);
    const title = normaliseTitle(payload.page && payload.page.title);
    const lang = normalizeLanguage(payload.lang);

    // 1-2. keys, and collapse duplicates inside this request. Oversized items can never be sent (the backend would
    //      reject the whole request), so they are answered locally and cannot take their neighbours down.
    const groups = new Map(); // key -> { text, role, heading, ids: [] }
    const early = []; // results decided without any request
    for (const item of items) {
      if (!isObject(item) || typeof item.text !== 'string' || !item.text.trim()) { early.push({ id: item && item.id, error: { code: 'invalid-item', message: 'Empty or malformed block' } }); continue; }
      if (item.text.length > BATCH_LIMITS.maxItemChars) { early.push({ id: item.id, error: { code: 'too-long', message: 'This block is too long to send' } }); continue; }
      const fields = { text: item.text, role: item.role, heading: item.heading };
      const key = info
        ? await cacheKey({ promptVersion: versionFor(info, lang), model: info.model, title, lang, ...fields })
        : `raw:${JSON.stringify([lang, title, fields.text, fields.role || '', fields.heading || ''])}`;
      if (!groups.has(key)) groups.set(key, { ...fields, ids: [] });
      groups.get(key).ids.push(item.id);
    }

    // 3. claim keys synchronously: anything already in flight is awaited instead of requested again
    const claimed = [];
    const waiting = [];
    for (const [key, group] of groups) {
      if (inflight.has(key)) { waiting.push([key, inflight.get(key)]); continue; }
      const d = deferred();
      inflight.set(key, d.promise);
      claimed.push({ key, group, d, done: false });
    }

    const outcomes = new Map(); // key -> { hinglish, cached? } | { error }
    const settle = (c, outcome) => { if (!c.done) { c.done = true; outcomes.set(c.key, outcome); c.d.resolve(outcome); } };
    let failure = null; // backend-level failure (whole request)
    let cacheHits = 0;

    try {
      // 4. persistent cache (never blocked by a quota block: hits cost nothing)
      let misses = claimed;
      if (cacheOk && claimed.length) {
        const hits = await cache.getMany(claimed.map((c) => ({ key: c.key, text: c.group.text })));
        misses = [];
        for (const c of claimed) {
          if (hits.has(c.key)) { cacheHits++; settle(c, { hinglish: hits.get(c.key), cached: true }); } else misses.push(c);
        }
      }

      // quota breaker: do not spend a request we know will be refused
      const block = misses.length ? await activeBreaker(info) : null;
      if (block) {
        failure = block.error;
        for (const c of misses) settle(c, { error: { code: 'quota-exhausted', message: block.error.message } });
        misses = [];
      }

      // 5. backend, one request for all misses
      if (misses.length) {
        const reply = await backend({
          v: 1,
          page: payload.page || {},
          lang,
          items: misses.map((c, i) => ({ id: i, text: c.group.text, ...(c.group.role ? { role: c.group.role } : {}), ...(c.group.heading ? { heading: c.group.heading } : {}) })),
        });
        if (!isObject(reply) || (reply.ok && !Array.isArray(reply.data && reply.data.results))) {
          // a reply we cannot interpret: fail these blocks, never throw
          failure = { code: 'bad-response', message: 'The backend sent a reply that could not be understood' };
          for (const c of misses) settle(c, { error: { code: 'bad-response', message: failure.message } });
        } else if (!reply.ok) {
          failure = isObject(reply.error) ? reply.error : { code: 'error', message: 'The backend request failed' };
          const code = String(failure.code || 'error').replace(/^provider-/, '');
          if (code === 'quota-exhausted') await armBreaker(info, failure);
          for (const c of misses) settle(c, { error: { code, message: failure.message } });
        } else {
          const meta = isObject(reply.data.meta) ? reply.data.meta : {};
          // Only cache when the backend that answered is the one we keyed for (it could have been reconfigured).
          const consistent = Boolean(info) && meta.promptVersion === versionFor(info, lang) && meta.model === info.model;
          const byId = new Map();
          for (const r of reply.data.results) if (isObject(r) && Number.isInteger(r.id)) byId.set(r.id, r);
          const toStore = [];
          const verdicts = [];
          misses.forEach((c, i) => {
            const r = byId.get(i);
            if (!r) { verdicts.push([c, { error: { code: 'missing-result', message: 'The backend returned no result for this block' } }]); return; }
            if (r.error) { verdicts.push([c, { error: isObject(r.error) ? r.error : { code: 'error', message: 'Conversion failed' } }]); return; }
            const source = sourceFromTemplate(c.group.text);
            if (typeof r.hinglish !== 'string' || !source || !parseConverted(r.hinglish, source)) {
              verdicts.push([c, { error: { code: 'placeholder-mismatch', message: 'The translation did not keep the page markup intact' } }]);
              return;
            }
            verdicts.push([c, { hinglish: r.hinglish }]);
            if (cacheOk && consistent) toStore.push({ key: c.key, text: c.group.text, hinglish: r.hinglish });
          });
          if (toStore.length) await cache.putMany(toStore); // stored before waiters/next requests can look again
          for (const [c, outcome] of verdicts) settle(c, outcome);
        }
      }
    } finally {
      // never leave a key claimed or a waiter hanging, whatever went wrong
      for (const c of claimed) {
        settle(c, { error: { code: 'internal', message: 'Translation was interrupted' } });
        inflight.delete(c.key);
      }
    }

    // keys fetched by other in-flight requests (their work does not depend on ours, so no deadlock)
    let sharedOk = 0;
    for (const [key, promise] of waiting) {
      const outcome = await promise;
      outcomes.set(key, outcome.hinglish !== undefined ? { ...outcome, shared: true } : outcome);
      if (outcome.hinglish !== undefined) sharedOk++;
    }

    const results = [...early];
    let successes = 0;
    for (const [key, group] of groups) {
      const outcome = outcomes.get(key);
      for (const id of group.ids) {
        if (outcome.hinglish !== undefined) {
          successes++;
          results.push({ id, hinglish: outcome.hinglish, ...(outcome.cached ? { cached: true } : {}), ...(outcome.shared ? { shared: true } : {}) });
        } else results.push({ id, error: outcome.error });
      }
    }
    results.sort((a, b) => a.id - b.id);

    // Nothing succeeded and the backend itself failed: surface it as a request failure (the page stops cleanly).
    if (failure && successes === 0) return { ok: false, error: failure };
    return { ok: true, data: { results, meta: { cache: { hits: cacheHits, shared: sharedOk, unique: groups.size, requested: items.length } } } };
  }

  async function convert(payload, { useCache = true } = {}) {
    try {
      return await convertInner(payload, useCache);
    } catch (err) {
      return { ok: false, error: { code: 'internal', message: 'Translation failed unexpectedly' } };
    }
  }

  /**
   * Cache-only lookup: answers the items that are already saved and silently omits the rest. Never calls the backend,
   * never claims an in-flight key, never throws. The page uses it to paint saved translations before any request is sent.
   */
  async function lookup(payload, { useCache = true } = {}) {
    const none = { ok: true, data: { results: [] } };
    try {
      const items = Array.isArray(payload && payload.items) ? payload.items : [];
      if (!useCache || !cache || !items.length) return none;
      const info = await getInfo();
      if (!info) return none;
      const title = normaliseTitle(payload.page && payload.page.title);
      const lang = normalizeLanguage(payload.lang);
      const keyed = [];
      for (const item of items) {
        if (!isObject(item) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > BATCH_LIMITS.maxItemChars) continue;
        const key = await cacheKey({ promptVersion: versionFor(info, lang), model: info.model, title, lang, text: item.text, role: item.role, heading: item.heading });
        keyed.push({ id: item.id, key, text: item.text });
      }
      const hits = await cache.getMany(keyed.map(({ key, text }) => ({ key, text })));
      return { ok: true, data: { results: keyed.filter((k) => hits.has(k.key)).map((k) => ({ id: k.id, hinglish: hits.get(k.key), cached: true })) } };
    } catch {
      return none;
    }
  }

  async function clearCache() {
    return cache ? cache.clear() : 0;
  }

  /** Cache size plus any active quota block for the current model (shown in the popup). */
  async function stats() {
    const base = cache ? await cache.stats() : { entries: 0, bytes: 0, healthy: false };
    let quota = null;
    try {
      const info = await getInfo();
      const b = await activeBreaker(info);
      if (b) quota = { until: b.until, message: b.error.message };
    } catch { /* stats are best effort */ }
    return { ...base, quota };
  }

  return { convert, lookup, clearCache, stats, get inflightSize() { return inflight.size; } };
}
