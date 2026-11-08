import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createApp } from '../../backend/src/server.js';
import { loadConfig } from '../../backend/src/config.js';
import { createMockProvider } from '../../backend/src/providers/mock.js';
import { createOpenAICompatProvider } from '../../backend/src/providers/openai-compat.js';
import { ProviderError } from '../../backend/src/providers/errors.js';
import { createTranslationCache, createMemoryStorage, cacheKey, CACHE_LIMITS } from '../../extension/src/background/translation-cache.js';
import { createIdbStorage } from '../../extension/src/background/idb-storage.js';
import { createTranslationService } from '../../extension/src/background/translation-service.js';
import { callBackend, createBackendInfo } from '../../extension/src/background/backend-client.js';
import { createController } from '../../extension/src/content/controller.js';
import { createRemoteConverter } from '../../extension/src/content/converter-remote.js';
import { BATCH_LIMITS, packBatches, estimateRequestSeconds } from '../../extension/src/content/batching.js';
import { DEFAULT_SETTINGS } from '../../extension/src/shared/settings.js';
import { workerSend } from '../helpers/worker-send.js';

const O = '⟦';
const C = '⟧';
const T = {
  a: 'Machine learning is a branch of artificial intelligence that learns from data and improves with experience.',
  b: 'The REST API returns 200 results in JSON format when the request is valid and complete.',
  c: 'A typical machine learning project begins with collecting data, which is then cleaned to remove errors.',
  d: `Use the ${O}1${C}map()${O}/1${C} function to apply ${O}2=code${C} to every element of the list in your program.`,
};
const item = (id, text, extra = {}) => ({ id, text, role: 'paragraph', ...extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A real backend stack (handler + engine + mock provider), observable from the outside. */
function makeBackend({ promptVersion = 'hinglish-v2', latencyMs = 0, failures, corrupt, providerOverride } = {}) {
  const provider = providerOverride || createMockProvider({ latencyMs, failures, corrupt });
  const config = { ...loadConfig({ PROMPT_VERSION: promptVersion }), retries: 0, requestTimeoutMs: 2000, retryBaseMs: 1 };
  const app = createApp(config, { provider });
  const requests = [];
  const backend = async (payload) => {
    requests.push(payload);
    const res = await app.handle({ method: 'POST', path: '/v1/rewrite', headers: {}, ip: '9.9.9.9', body: payload });
    return res.status === 200 ? { ok: true, data: res.body } : { ok: false, error: res.body.error };
  };
  return { backend, requests, provider, info: { promptVersion, model: provider.model }, itemsSent: () => requests.reduce((n, r) => n + r.items.length, 0) };
}

function makeService({ storage = createMemoryStorage(), be = makeBackend(), now = Date.now, limits, info = be.info, backend = be.backend } = {}) {
  const cache = createTranslationCache({ storage, now, ...(limits ? { limits } : {}) });
  const svc = createTranslationService({ cache, backend, getInfo: async () => info, now });
  return { svc, cache, storage, be };
}
const payloadOf = (...items) => ({ v: 1, page: {}, items });
const texts = (res) => res.data.results.map((r) => r.hinglish);

// ================================================================ cache hit / miss / persistence

test('cache: first request misses and calls the backend, an identical one hits and does not', async () => {
  const { svc, be } = makeService();
  const first = await svc.convert(payloadOf(item(0, T.a), item(1, T.b)));
  assert.equal(first.ok, true);
  assert.equal(be.requests.length, 1);
  assert.ok(first.data.results.every((r) => r.hinglish && !r.cached));

  const second = await svc.convert(payloadOf(item(0, T.a), item(1, T.b)));
  assert.equal(be.requests.length, 1, 'no new backend request');
  assert.ok(second.data.results.every((r) => r.cached === true));
  assert.deepEqual(texts(second), texts(first), 'cached text is exactly what was translated');
  assert.equal(second.data.meta.cache.hits, 2);

  // a mix: one hit, one miss -> only the miss is requested
  const third = await svc.convert(payloadOf(item(0, T.a), item(1, T.c)));
  assert.equal(be.requests.length, 2);
  assert.deepEqual(be.requests[1].items.map((i) => i.text), [T.c]);
  assert.equal(third.data.results[0].cached, true);
  assert.equal(third.data.results[1].cached, undefined);
});

test('cache: persists across sessions (new service, empty memory, same IndexedDB-style storage)', async () => {
  const storage = createMemoryStorage();
  const sessionOne = makeService({ storage });
  const one = await sessionOne.svc.convert(payloadOf(item(0, T.a), item(1, T.d)));
  assert.equal(sessionOne.be.requests.length, 1);

  // "browser restart": every in-memory object is gone, only the storage survives
  const sessionTwo = makeService({ storage });
  const two = await sessionTwo.svc.convert(payloadOf(item(0, T.a), item(1, T.d)));
  assert.equal(sessionTwo.be.requests.length, 0, 'served entirely from the persisted cache');
  assert.deepEqual(texts(two), texts(one));
  assert.ok(two.data.results.every((r) => r.cached));
});

test('cache: keeps working when the backend is unreachable, using the last known version info', async () => {
  const storage = createMemoryStorage();
  await makeService({ storage }).svc.convert(payloadOf(item(0, T.a)));
  const down = async () => ({ ok: false, error: { code: 'unreachable', message: 'down' } });
  const { svc } = makeService({ storage, backend: down });
  const hit = await svc.convert(payloadOf(item(0, T.a)));
  assert.equal(hit.ok, true);
  assert.equal(hit.data.results[0].cached, true);
  const miss = await svc.convert(payloadOf(item(0, T.c)));
  assert.equal(miss.ok, false);
  assert.equal(miss.error.code, 'unreachable');
});

test('cache: useCache=false bypasses reads and writes but still collapses duplicates', async () => {
  const { svc, be, storage } = makeService();
  const r = await svc.convert(payloadOf(item(0, T.a), item(1, T.a), item(2, T.b)), { useCache: false });
  assert.equal(be.itemsSent(), 2, 'duplicate collapsed');
  assert.equal(storage._map.size, 0, 'nothing written');
  await svc.convert(payloadOf(item(0, T.a)), { useCache: false });
  assert.equal(be.requests.length, 2, 'not read either');
  assert.ok(r.data.results.every((x) => x.hinglish));
});

// ================================================================ isolation by prompt version, model, context

test('cache never serves one prompt version\'s translation to another', async () => {
  const storage = createMemoryStorage();
  const v2 = makeService({ storage, be: makeBackend({ promptVersion: 'hinglish-v2' }) });
  const v1 = makeService({ storage, be: makeBackend({ promptVersion: 'hinglish-v1' }) });

  await v2.svc.convert(payloadOf(item(0, T.a)));
  assert.equal(v2.be.requests.length, 1);

  const asV1 = await v1.svc.convert(payloadOf(item(0, T.a)));
  assert.equal(v1.be.requests.length, 1, 'v1 had to request its own translation');
  assert.equal(asV1.data.results[0].cached, undefined);
  assert.equal(storage._map.size, 2, 'two separate entries for the same source text');

  // each version still hits its own entry
  assert.equal((await v1.svc.convert(payloadOf(item(0, T.a)))).data.results[0].cached, true);
  assert.equal((await v2.svc.convert(payloadOf(item(0, T.a)))).data.results[0].cached, true);
  assert.equal(v1.be.requests.length + v2.be.requests.length, 2);
});

test('cache key separates model, role and heading, and is stable for identical input', async () => {
  const base = { promptVersion: 'hinglish-v2', model: 'm1', text: T.a, role: 'paragraph', heading: 'Intro' };
  const k = await cacheKey(base);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(await cacheKey({ ...base }), k, 'stable');
  for (const change of [{ promptVersion: 'hinglish-v1' }, { model: 'm2' }, { role: 'definition' }, { heading: 'Other' }, { text: `${T.a}.` }]) {
    assert.notEqual(await cacheKey({ ...base, ...change }), k, JSON.stringify(change));
  }
  assert.equal(await cacheKey({ ...base, heading: undefined }), await cacheKey({ ...base, heading: '' }), 'no heading == empty heading');
});

test('different model or heading is a miss; the same context is a hit', async () => {
  const storage = createMemoryStorage();
  const a = makeService({ storage });
  await a.svc.convert(payloadOf(item(0, T.a, { heading: 'Intro' })));
  const sameCtx = await a.svc.convert(payloadOf(item(0, T.a, { heading: 'Intro' })));
  assert.equal(sameCtx.data.results[0].cached, true);
  const otherHeading = await a.svc.convert(payloadOf(item(0, T.a, { heading: 'Other section' })));
  assert.equal(otherHeading.data.results[0].cached, undefined);

  const otherModel = makeService({ storage, info: { promptVersion: 'hinglish-v2', model: 'another-model' }, be: a.be });
  const m = await otherModel.svc.convert(payloadOf(item(0, T.a, { heading: 'Intro' })));
  assert.equal(m.data.results[0].cached, undefined, 'a different model never reuses the old model\'s output');
});

test('a translation is not cached when the backend that answered is not the one the key was built for', async () => {
  const be = makeBackend({ promptVersion: 'hinglish-v1' });
  const { svc, storage } = makeService({ be, info: { promptVersion: 'hinglish-v2', model: be.provider.model } }); // stale info
  const r = await svc.convert(payloadOf(item(0, T.a)));
  assert.equal(r.ok, true);
  assert.equal(storage._map.size, 0);
});

test('backend info: read from /health, remembered, persisted, falls back when unreachable', async () => {
  let clock = 0;
  let health = { ok: true, status: 200, json: async () => ({ ok: true, promptVersion: 'hinglish-v2', model: 'gemini-3.6-flash' }) };
  let fetches = 0;
  let saved = null;
  const getInfo = createBackendInfo({
    baseUrl: 'http://b/', now: () => clock, ttlMs: 1000,
    fetchImpl: async (url) => { fetches++; assert.equal(url, 'http://b/health'); if (health instanceof Error) throw health; return health; },
    load: async () => saved, save: async (i) => { saved = i; },
  });
  assert.deepEqual(await getInfo(), { promptVersion: 'hinglish-v2', model: 'gemini-3.6-flash' });
  await getInfo();
  assert.equal(fetches, 1, 'memoised within ttl');
  clock = 5000;
  health = new TypeError('fetch failed');
  assert.deepEqual(await getInfo(), { promptVersion: 'hinglish-v2', model: 'gemini-3.6-flash' }, 'last known value when unreachable');
  assert.deepEqual(saved, { promptVersion: 'hinglish-v2', model: 'gemini-3.6-flash' });

  const fresh = createBackendInfo({ baseUrl: 'http://b', fetchImpl: async () => { throw new TypeError('x'); }, load: async () => saved });
  assert.equal((await fresh()).promptVersion, 'hinglish-v2', 'persisted value survives a worker restart');
  const old = createBackendInfo({ baseUrl: 'http://b', fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true }) }) });
  assert.equal(await old(), null, 'a backend without promptVersion disables caching rather than guessing');
});

// ================================================================ de-duplication

test('duplicate text inside one request is sent once and fanned out to every id', async () => {
  const { svc, be } = makeService();
  const r = await svc.convert(payloadOf(item(0, T.a), item(1, T.b), item(2, T.a), item(3, T.a)));
  assert.equal(be.itemsSent(), 2);
  assert.deepEqual(r.data.results.map((x) => x.id), [0, 1, 2, 3]);
  assert.equal(r.data.results[0].hinglish, r.data.results[2].hinglish);
  assert.equal(r.data.results[0].hinglish, r.data.results[3].hinglish);
});

test('without cache info (older backend) duplicates are still collapsed', async () => {
  const be = makeBackend();
  const { svc } = makeService({ be, info: null });
  const r = await svc.convert(payloadOf(item(0, T.a), item(1, T.a)));
  assert.equal(be.itemsSent(), 1);
  assert.equal(r.data.results.length, 2);
});

test('page level: identical paragraphs are requested once, all copies convert, restore is exact, rerun is free', async () => {
  const html = `<body><main>${[T.a, T.b, T.a, T.c, T.a].map((t) => `<p>${t}</p>`).join('')}</main></body>`;
  const dom = new JSDOM(html);
  const { svc, be } = makeService();
  const send = workerSend(svc);
  const ctl = createController({ root: dom.window.document.body, converter: createRemoteConverter({ send }) });

  const st = await ctl.translate(DEFAULT_SETTINGS);
  assert.equal(st.converted, 5);
  assert.equal(st.deduped, 2);
  assert.equal(be.itemsSent(), 3, '3 unique blocks requested, not 5');
  assert.deepEqual(st.failed, {});

  ctl.restore();
  assert.equal(dom.serialize(), new JSDOM(html).serialize());

  const again = await ctl.translate(DEFAULT_SETTINGS);
  assert.equal(again.converted, 5);
  assert.equal(be.requests.length, 1, 'second translation made no backend request');
  assert.equal(again.cached, 3);
});

test('concurrent identical requests share one backend call', async () => {
  const be = makeBackend({ latencyMs: 60 });
  const { svc } = makeService({ be });
  const p = payloadOf(item(0, T.a), item(1, T.b));
  const [one, two, three] = await Promise.all([svc.convert(p), svc.convert(p), svc.convert(p)]);
  assert.equal(be.requests.length, 1, 'exactly one request for three identical concurrent calls');
  assert.equal(be.itemsSent(), 2);
  for (const r of [one, two, three]) assert.deepEqual(texts(r), texts(one));
  assert.ok(two.data.results.every((x) => x.shared) && three.data.results.every((x) => x.shared));
  assert.equal(one.data.results[0].shared, undefined);
});

test('concurrent overlapping requests fetch each unique block exactly once', async () => {
  const be = makeBackend({ latencyMs: 60 });
  const { svc } = makeService({ be });
  const [x, y] = await Promise.all([svc.convert(payloadOf(item(0, T.a), item(1, T.b))), svc.convert(payloadOf(item(0, T.b), item(1, T.c)))]);
  const sent = be.requests.flatMap((r) => r.items.map((i) => i.text)).sort();
  assert.deepEqual(sent, [T.a, T.b, T.c].sort());
  assert.equal(x.data.results[1].hinglish, y.data.results[0].hinglish);
  assert.ok(x.ok && y.ok);
});

test('concurrent requests cannot deadlock on each other\'s keys', async () => {
  const be = makeBackend({ latencyMs: 40 });
  const { svc } = makeService({ be });
  const both = Promise.all([
    svc.convert(payloadOf(item(0, T.a), item(1, T.b))),
    svc.convert(payloadOf(item(0, T.b), item(1, T.a))),
  ]);
  const settled = await Promise.race([both, sleep(2000).then(() => 'timeout')]);
  assert.notEqual(settled, 'timeout');
  assert.equal(be.itemsSent(), 2);
});

test('a failed in-flight request is propagated to waiters, and the key is released for a retry', async () => {
  let n = 0;
  const be = makeBackend({ latencyMs: 40 });
  const flaky = async (payload) => (++n === 1 ? (await sleep(40), { ok: false, error: { code: 'unreachable', message: 'down' } }) : be.backend(payload));
  const { svc } = makeService({ be, backend: flaky });
  const [owner, waiter] = await Promise.all([svc.convert(payloadOf(item(0, T.a))), svc.convert(payloadOf(item(0, T.a), item(1, T.b)))]);
  assert.equal(owner.ok, false);
  assert.equal(waiter.data.results[0].error.code, 'unreachable', 'waiter sees the owner\'s failure');
  assert.ok(waiter.data.results[1].hinglish, 'its own block still succeeded');
  const retry = await svc.convert(payloadOf(item(0, T.a)));
  assert.equal(retry.ok, true, 'key was released after the failure');
});

// ================================================================ eviction, expiry, size

const entry = (i, size = 10) => ({ key: `k${i}`, text: `Block number ${i} explains how this works in practice today.`, hinglish: `Block number ${i} `.padEnd(size, 'x') + ' hai.' });
const mkCache = (limits, clock) => createTranslationCache({ storage: createMemoryStorage(), limits: { ...CACHE_LIMITS, ...limits }, now: () => clock.t });

test('eviction: over the entry limit the least recently used entries go, newest survive', async () => {
  const clock = { t: 1_000_000 };
  const cache = mkCache({ maxEntries: 5 }, clock);
  for (let i = 0; i < 8; i++) { clock.t += 1000; await cache.putMany([entry(i)]); }
  const s = await cache.stats();
  assert.ok(s.entries <= 5, `kept ${s.entries}`);
  const present = await cache.getMany([0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ key: `k${i}`, text: entry(i).text })));
  assert.ok(present.has('k7') && present.has('k6') && present.has('k5'), 'newest kept');
  assert.ok(!present.has('k0') && !present.has('k1'), 'oldest evicted');
});

test('eviction is LRU: a recently used old entry outlives newer unused ones', async () => {
  const clock = { t: 1_000_000 };
  const cache = mkCache({ maxEntries: 6, touchAfterMs: 0 }, clock);
  for (let i = 0; i < 6; i++) { clock.t += 1000; await cache.putMany([entry(i)]); }
  clock.t += 1000;
  assert.ok((await cache.getMany([{ key: 'k0', text: entry(0).text }])).has('k0'), 'k0 used just now');
  for (let i = 6; i < 9; i++) { clock.t += 1000; await cache.putMany([entry(i)]); }
  const present = await cache.getMany([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ key: `k${i}`, text: entry(i).text })));
  assert.ok(present.has('k0'), 'recently used entry survived');
  assert.ok(!present.has('k1'), 'least recently used entry was evicted');
});

test('eviction by size: stays under the byte budget', async () => {
  const clock = { t: 1_000_000 };
  const cache = mkCache({ maxEntries: 1000, maxBytes: 4000 }, clock);
  for (let i = 0; i < 30; i++) { clock.t += 1000; await cache.putMany([entry(i, 100)]); } // ~ (100+...)*2+120 each
  const s = await cache.stats();
  assert.ok(s.bytes <= 4000, `holds ${s.bytes} bytes`);
  assert.ok(s.entries > 0 && s.entries < 30);
});

test('a single large batch is limited too, and never loops forever', async () => {
  const clock = { t: 5_000_000 };
  const cache = mkCache({ maxEntries: 5 }, clock);
  await cache.putMany(Array.from({ length: 20 }, (_, i) => entry(i)));
  assert.ok((await cache.stats()).entries <= 5);
});

test('expired entries are misses and are removed', async () => {
  const clock = { t: 1_000_000 };
  const cache = mkCache({ ttlMs: 10_000 }, clock);
  await cache.putMany([entry(1)]);
  clock.t += 5_000;
  assert.ok((await cache.getMany([{ key: 'k1', text: entry(1).text }])).has('k1'));
  clock.t += 20_000;
  assert.equal((await cache.getMany([{ key: 'k1', text: entry(1).text }])).size, 0);
  assert.equal((await cache.stats()).entries, 0, 'removed on read');
  await cache.putMany([entry(2)]);
  clock.t += 50_000;
  await cache.prune();
  assert.equal((await cache.stats()).entries, 0, 'prune removes expired entries');
});

test('clear removes everything and reports how many', async () => {
  const { svc, storage } = makeService();
  await svc.convert(payloadOf(item(0, T.a), item(1, T.b)));
  assert.equal(await svc.clearCache(), 2);
  assert.equal(storage._map.size, 0);
  assert.equal((await svc.convert(payloadOf(item(0, T.a)))).data.results[0].cached, undefined);
});

// ================================================================ corruption and unavailable storage

test('corrupt cache entries are treated as misses, deleted, and translation still succeeds', async () => {
  const { svc, storage, be } = makeService();
  await svc.convert(payloadOf(item(0, T.a)));
  const [key] = [...storage._map.keys()];
  const good = storage._map.get(key);
  const variants = [
    'not even an object', null, {}, { ...good, hinglish: 12345 }, { ...good, hinglish: '' }, { ...good, v: 99 }, { ...good, key: 'other' },
    { ...good, lastUsedAt: 'yesterday' }, { ...good, hinglish: `Broken ${O}1${C}token markup` }, { ...good, hinglish: `${good.hinglish} ${O}7${C}` },
  ];
  for (const bad of variants) {
    storage._map.set(key, bad);
    const before = be.requests.length;
    const r = await svc.convert(payloadOf(item(0, T.a)));
    assert.equal(r.ok, true, JSON.stringify(bad));
    assert.ok(r.data.results[0].hinglish);
    assert.equal(r.data.results[0].cached, undefined, 'never served from a corrupt entry');
    assert.equal(be.requests.length, before + 1, 're-fetched once');
    assert.equal(storage._map.get(key).hinglish, good.hinglish, 'and re-cached cleanly');
  }
});

test('unavailable storage never breaks translation; it is skipped during a cooldown and retried after', async () => {
  const clock = { t: 1_000_000 };
  const inner = createMemoryStorage();
  let broken = true;
  let touches = 0;
  const flaky = new Proxy(inner, { get: (t, p) => (typeof t[p] === 'function' && p !== 'then' ? async (...a) => { touches++; if (broken) throw new Error('IDB exploded'); return t[p](...a); } : t[p]) });
  const errors = [];
  const cache = createTranslationCache({ storage: flaky, now: () => clock.t, onError: (e) => errors.push(e.message) });
  const be = makeBackend();
  const svc = createTranslationService({ cache, backend: be.backend, getInfo: async () => be.info, now: () => clock.t });

  const r1 = await svc.convert(payloadOf(item(0, T.a)));
  assert.equal(r1.ok, true);
  assert.ok(r1.data.results[0].hinglish);
  assert.ok(errors.length >= 1);

  const touchesAfterFailure = touches;
  await svc.convert(payloadOf(item(0, T.b)));
  assert.equal(touches, touchesAfterFailure, 'cache skipped during the cooldown');

  broken = false;
  clock.t += CACHE_LIMITS.cooldownMs + 1;
  await svc.convert(payloadOf(item(0, T.c)));
  assert.equal(inner._map.size, 1, 'cache recovered and stored again');
});

test('IndexedDB missing entirely: the adapter rejects cleanly and translation carries on', async () => {
  const storage = createIdbStorage({ idb: undefined });
  await assert.rejects(storage.count(), /IndexedDB is unavailable/);
  const errors = [];
  const cache = createTranslationCache({ storage, onError: (e) => errors.push(e.message) });
  const be = makeBackend();
  const svc = createTranslationService({ cache, backend: be.backend, getInfo: async () => be.info });
  const r = await svc.convert(payloadOf(item(0, T.a), item(1, T.a)));
  assert.equal(r.ok, true);
  assert.equal(r.data.results.length, 2);
  assert.ok(errors.length >= 1);
});

test('disk full (QuotaExceededError) frees space and retries once', async () => {
  const inner = createMemoryStorage();
  for (let i = 0; i < 10; i++) await inner.putMany([{ v: 1, key: `old${i}`, hinglish: 'x', size: 1000, createdAt: i, lastUsedAt: i }]);
  let first = true;
  const full = { ...inner, async putMany(records) { if (first && records.some((r) => r.key === 'new')) { first = false; const e = new Error('full'); e.name = 'QuotaExceededError'; throw e; } return inner.putMany(records); } };
  const cache = createTranslationCache({ storage: full, limits: { ...CACHE_LIMITS, maxEntries: 20 } });
  const stored = await cache.putMany([{ key: 'new', text: entry(1).text, hinglish: entry(1).hinglish }]);
  assert.equal(stored, 1);
  assert.ok(inner._map.has('new'));
  assert.ok(inner._map.size < 11, 'older entries were evicted to make room');
});

test('only validated translations are cached: forged markup from the backend is rejected, not stored', async () => {
  const be = makeBackend();
  const forged = async (payload) => {
    const real = await be.backend(payload);
    return { ok: true, data: { ...real.data, results: real.data.results.map((r) => ({ ...r, hinglish: `${O}1${C} broken ${O}9${C}` })) } };
  };
  const { svc, storage } = makeService({ be, backend: forged });
  const r = await svc.convert(payloadOf(item(0, T.d)));
  assert.equal(r.ok, true, 'the backend call itself succeeded; the block is reported as failed');
  assert.equal(r.data.results[0].error.code, 'placeholder-mismatch');
  assert.equal(storage._map.size, 0);
});

test('privacy: the cache stores only a hash key and our own output, never the source text', async () => {
  const { svc, storage } = makeService();
  await svc.convert(payloadOf(item(0, T.a, { heading: 'Secret heading' })));
  const dump = JSON.stringify([...storage._map.values()]);
  assert.ok(!dump.includes('Machine learning is a branch'), 'source text absent');
  assert.ok(!dump.includes('Secret heading'), 'heading absent');
  const [rec] = [...storage._map.values()];
  assert.match(rec.key, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(rec).sort(), ['createdAt', 'hinglish', 'key', 'lastUsedAt', 'size', 'v']);
});

// ================================================================ quota is never bypassed

const quotaProvider = (calls) => createOpenAICompatProvider({
  apiKey: 'dummy-key', model: 'm', baseUrl: 'http://x',
  fetchImpl: async () => {
    calls.n++;
    return { ok: false, status: 429, headers: { get: () => null }, json: async () => [{ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', details: [
      { violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { retryDelay: '3600s' }] } }] };
  },
});

test('quota exhaustion: one provider request, never retried, and later misses are refused locally', async () => {
  const calls = { n: 0 };
  const be = makeBackend({ providerOverride: quotaProvider(calls) });
  const clock = { t: 1_000_000 };
  const { svc } = makeService({ be, now: () => clock.t });

  const first = await svc.convert(payloadOf(item(0, T.a)));
  assert.equal(first.ok, false);
  assert.equal(first.error.code, 'provider-quota-exhausted');
  assert.equal(calls.n, 1, 'exactly one request reached the provider, despite retry settings');

  const second = await svc.convert(payloadOf(item(0, T.b)));
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'provider-quota-exhausted');
  assert.equal(calls.n, 1, 'circuit breaker: no further provider request');
  assert.equal(be.requests.length, 1, 'not even a backend request');

  clock.t += 3600 * 1000 + 1;
  await svc.convert(payloadOf(item(0, T.c)));
  assert.equal(calls.n, 2, 'after the reset time it tries again');
});

test('quota breaker still serves cache hits and is lifted by switching model', async () => {
  const storage = createMemoryStorage();
  const ok = makeService({ storage });
  await ok.svc.convert(payloadOf(item(0, T.a)));

  const calls = { n: 0 };
  const be = makeBackend({ providerOverride: quotaProvider(calls) });
  const { svc } = makeService({ storage, be, info: ok.be.info, backend: be.backend });
  await svc.convert(payloadOf(item(0, T.b))); // arms the breaker
  const mixed = await svc.convert(payloadOf(item(0, T.a), item(1, T.c)));
  assert.equal(mixed.ok, true);
  assert.equal(mixed.data.results[0].cached, true, 'cached block still served');
  assert.equal(mixed.data.results[1].error.code, 'quota-exhausted');
  assert.equal(calls.n, 1);

  // one service, its model changes underneath it (the backend's MODEL was edited): the old breaker no longer applies
  let model = ok.be.info.model;
  const keyed = createTranslationService({ cache: createTranslationCache({ storage: createMemoryStorage() }), backend: be.backend, getInfo: async () => ({ promptVersion: 'hinglish-v2', model }) });
  await keyed.convert(payloadOf(item(0, T.a)));
  const n1 = calls.n;
  await keyed.convert(payloadOf(item(0, T.b)));
  assert.equal(calls.n, n1, 'blocked for the same model');
  model = 'another-model';
  await keyed.convert(payloadOf(item(0, T.c)));
  assert.equal(calls.n, n1 + 1, 'a different model is allowed through');
});

test('callBackend does not retry a quota response (only network failures are retried)', async () => {
  let fetches = 0;
  const res = await callBackend({ baseUrl: 'http://b', payload: {}, installId: 'i', fetchImpl: async () => { fetches++; return { ok: false, status: 503, json: async () => ({ error: { code: 'provider-quota-exhausted', message: 'daily quota is used up', retryAfterSec: 72714 } }) }; } });
  assert.equal(fetches, 1);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'provider-quota-exhausted');
  assert.equal(res.error.retryAfterSec, 72714, 'the reset time reaches the circuit breaker');
});

test('end to end: after a quota error the extension sends no more requests for the rest of the page', async () => {
  const html = `<body><main>${Array.from({ length: 30 }, (_, i) => `<p>Paragraph ${i} explains how this particular part of the system works and why it is useful in practice.</p>`).join('')}</main></body>`;
  const calls = { n: 0 };
  const be = makeBackend({ providerOverride: quotaProvider(calls) });
  const { svc } = makeService({ be });
  const dom = new JSDOM(html);
  const ctl = createController({ root: dom.window.document.body, converter: createRemoteConverter({ send: workerSend(svc) }) });
  const st = await ctl.translate(DEFAULT_SETTINGS);
  assert.equal(calls.n, 1, 'one provider request for a 30-block page');
  assert.match(st.error, /daily quota is used up/);
  assert.equal(dom.serialize(), new JSDOM(html).serialize());
});

// ================================================================ batching

test('batch packing: respects every limit, keeps order, never splits a block', () => {
  const lens = [100, 400, 700, 50, 900, 1700, 2500, 80, 80, 80];
  const entries = lens.map((n, i) => ({ i, n }));
  const { batches, oversized } = packBatches(entries, (e) => e.n);
  assert.deepEqual(oversized, []);
  assert.deepEqual(batches.flat().map((e) => e.i), entries.map((e) => e.i), 'document order preserved, nothing lost');
  for (const b of batches) {
    assert.ok(b.length <= BATCH_LIMITS.maxItems);
    const chars = b.reduce((n, e) => n + e.n, 0);
    assert.ok(chars <= BATCH_LIMITS.maxChars || b.length === 1, `batch of ${chars} chars`);
  }
  assert.deepEqual(batches.find((b) => b.some((e) => e.n === 2500)).map((e) => e.n), [2500], 'a long paragraph travels alone');
});

test('batch packing: blocks too long for the backend are set aside, not allowed to break a request', () => {
  const entries = [{ n: 200 }, { n: BATCH_LIMITS.maxItemChars + 1 }, { n: 300 }];
  const { batches, oversized } = packBatches(entries, (e) => e.n);
  assert.equal(oversized.length, 1);
  assert.deepEqual(batches.flat().map((e) => e.n), [200, 300]);
});

test('batch limits stay inside backend limits, one-model-call chunks, and the timeout budget', () => {
  const limits = loadConfig({}).limits;
  const cfg = loadConfig({});
  assert.ok(BATCH_LIMITS.maxItems <= limits.maxItems);
  assert.ok(BATCH_LIMITS.maxItems <= cfg.maxItemsPerCall, 'one request = one model call');
  assert.ok(BATCH_LIMITS.maxChars <= cfg.maxCharsPerCall && BATCH_LIMITS.maxChars <= limits.maxTotalChars);
  assert.ok(BATCH_LIMITS.maxItemChars <= limits.maxItemChars);
  // timeout budget: the largest packable request must finish with >= 1.5x headroom under the request timeout
  const worst = estimateRequestSeconds(BATCH_LIMITS.maxChars);
  assert.ok(worst * 1.5 <= cfg.requestTimeoutMs / 1000, `est ${worst.toFixed(1)}s vs ${cfg.requestTimeoutMs / 1000}s timeout`);
});

test('packing needs fewer requests than fixed batches of 5 when blocks are short, and never more than needed', () => {
  const short = Array.from({ length: 60 }, () => ({ n: 110 }));
  const fixed5 = Math.ceil(short.length / 5);
  const packed = packBatches(short, (e) => e.n).batches.length;
  assert.ok(packed < fixed5, `${packed} vs ${fixed5}`);
  assert.equal(packed, 5, '60 x 110 chars -> 12 per request');
  const long = Array.from({ length: 60 }, () => ({ n: 350 }));
  assert.ok(packBatches(long, (e) => e.n).batches.length <= Math.ceil(long.length / 5), 'long blocks: no worse than before');
});

test('end to end: an oversized block is reported as too-long while the others convert', async () => {
  const huge = `${T.a.replace(/[.!?]/g, '')} ${'this run-on text never ends a sentence so it cannot be cut safely '.repeat(70)}`; // no sentence end: cannot be split
  assert.ok(huge.length > BATCH_LIMITS.maxItemChars);
  const html = `<body><main><p>${T.a.replace('Machine', 'Deep')}</p><p>${huge}</p><p>${T.b}</p></main></body>`;
  const { svc, be } = makeService();
  const dom = new JSDOM(html);
  const ctl = createController({ root: dom.window.document.body, converter: createRemoteConverter({ send: workerSend(svc) }) });
  const st = await ctl.translate(DEFAULT_SETTINGS);
  assert.equal(st.converted, 2);
  assert.equal(st.failed['too-long'], 1);
  assert.ok(be.requests.every((r) => r.items.every((i) => i.text.length <= BATCH_LIMITS.maxItemChars)), 'nothing oversized reached the backend');
  ctl.restore();
  assert.equal(dom.serialize(), new JSDOM(html).serialize());
});

test('end to end: a long page is sent in few, valid requests that all pass backend validation', async () => {
  const html = `<body><main>${Array.from({ length: 80 }, (_, i) => `<li>Item ${i} explains one small idea that is short enough to share a request.</li>`).map((x) => x).join('')}</main></body>`.replace(/<li>/g, '<p>').replace(/<\/li>/g, '</p>');
  const { svc, be } = makeService();
  const dom = new JSDOM(html);
  const ctl = createController({ root: dom.window.document.body, converter: createRemoteConverter({ send: workerSend(svc) }) });
  const st = await ctl.translate(DEFAULT_SETTINGS);
  assert.equal(st.converted, 80);
  assert.deepEqual(st.failed, {});
  assert.ok(be.requests.length <= Math.ceil(80 / 5) / 2, `${be.requests.length} requests instead of 16`);
  for (const r of be.requests) {
    assert.ok(r.items.length <= BATCH_LIMITS.maxItems);
    assert.ok(r.items.reduce((n, i) => n + i.text.length, 0) <= BATCH_LIMITS.maxChars);
  }
});

test('/health reports prompt version and model so the extension can version its cache', async () => {
  const app = createApp({ ...loadConfig({ PROMPT_VERSION: 'hinglish-v1' }) }, { provider: createMockProvider() });
  const res = await app.handle({ method: 'GET', path: '/health', headers: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.promptVersion, 'hinglish-v1');
  assert.equal(res.body.model, 'mock-1');
});

test('a ProviderError class used by the cache tests is the real one', () => {
  assert.ok(new ProviderError('x', 'y') instanceof Error);
});
