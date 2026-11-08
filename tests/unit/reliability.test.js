import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../backend/src/server.js';
import { loadConfig } from '../../backend/src/config.js';
import { createMockProvider, mockTransform } from '../../backend/src/providers/mock.js';
import { createOpenAICompatProvider } from '../../backend/src/providers/openai-compat.js';
import { createTranslationCache, createMemoryStorage, cacheKey, normaliseTitle, CACHE_LIMITS } from '../../extension/src/background/translation-cache.js';
import { createTranslationService } from '../../extension/src/background/translation-service.js';
import { BATCH_LIMITS } from '../../extension/src/content/batching.js';

const T = {
  a: 'Machine learning is a branch of artificial intelligence that learns from data and improves with experience.',
  b: 'The REST API returns 200 results in JSON format when the request is valid and complete.',
  c: 'A typical machine learning project begins with collecting data, which is then cleaned to remove errors.',
  bank: 'The bank was crowded and everyone had to wait for a long time before they could get any help at all.',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const item = (id, text, extra = {}) => ({ id, text, role: 'paragraph', ...extra });
const payloadOf = (items, title) => ({ v: 1, page: title === undefined ? {} : { title }, items });

function makeBackend({ latencyMs = 0, providerOverride, promptVersion = 'hinglish-v2' } = {}) {
  const provider = providerOverride || createMockProvider({ latencyMs });
  const config = { ...loadConfig({ PROMPT_VERSION: promptVersion }), retries: 0, requestTimeoutMs: 3000, retryBaseMs: 1 };
  const app = createApp(config, { provider });
  const requests = [];
  const backend = async (payload) => {
    requests.push(payload);
    const res = await app.handle({ method: 'POST', path: '/v1/rewrite', headers: {}, ip: '9.9.9.9', body: payload });
    return res.status === 200 ? { ok: true, data: res.body } : { ok: false, error: res.body.error };
  };
  return { backend, requests, provider, info: { promptVersion, model: provider.model }, itemsSent: () => requests.reduce((n, r) => n + r.items.length, 0) };
}

const quotaProvider = (calls, retryDelay = '3600s') => createOpenAICompatProvider({
  apiKey: 'dummy-key', model: 'q-model', baseUrl: 'http://x',
  fetchImpl: async () => {
    calls.n++;
    return { ok: false, status: 429, headers: { get: () => null }, json: async () => [{ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', details: [
      { violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { retryDelay }] } }] };
  },
});

/** chrome.storage.local stand-in for the breaker: survives "service worker restarts" because the test owns it. */
function breakerStore(initial = null, { failLoad = false, failSave = false } = {}) {
  const box = { data: initial, saves: 0 };
  return {
    box,
    load: async () => { if (failLoad) throw new Error('storage unreadable'); return box.data === null ? null : structuredClone(box.data); },
    save: async (d) => { if (failSave) throw new Error('storage full'); box.saves++; box.data = structuredClone(d); },
  };
}

function worker({ storage = createMemoryStorage(), be = makeBackend(), now = Date.now, store = breakerStore(), info = be.info, backend = be.backend, cacheLimits } = {}) {
  const cache = createTranslationCache({ storage, now, ...(cacheLimits ? { limits: { ...CACHE_LIMITS, ...cacheLimits } } : {}) });
  const svc = createTranslationService({ cache, backend, getInfo: async () => info, now, breakerStore: store });
  return { svc, cache, storage, be, store };
}

// ================================================================ quota circuit-breaker persistence

test('quota block is saved per model and survives a service-worker restart without a single request', async () => {
  const calls = { n: 0 };
  const clock = { t: 5_000_000 };
  const store = breakerStore();
  const storage = createMemoryStorage();
  const be1 = makeBackend({ providerOverride: quotaProvider(calls) });
  const first = worker({ be: be1, store, storage, now: () => clock.t });
  const r1 = await first.svc.convert(payloadOf([item(0, T.a)]));
  assert.equal(r1.ok, false);
  assert.equal(r1.error.code, 'provider-quota-exhausted');
  assert.equal(calls.n, 1);

  const saved = store.box.data['q-model'] ?? store.box.data[be1.info.model];
  assert.ok(saved, 'block stored under the model name');
  assert.equal(saved.until, clock.t + 3600 * 1000);
  assert.match(saved.error.message, /daily quota is used up/);

  // "restart": every in-memory object is new; only chrome.storage (store) and IndexedDB (storage) remain
  const calls2 = { n: 0 };
  const be2 = makeBackend({ providerOverride: quotaProvider(calls2) });
  const second = worker({ be: be2, store, storage, now: () => clock.t, info: be1.info });
  const r2 = await second.svc.convert(payloadOf([item(0, T.b)]));
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, 'provider-quota-exhausted', 'still blocked after the restart');
  assert.equal(calls2.n, 0, 'no provider request after the restart');
  assert.equal(be2.requests.length, 0, 'no backend request either');
  const stats = await second.svc.stats();
  assert.equal(stats.quota.until, saved.until, 'the popup can show when it resets');
});

test('cached translations are served during a (restored) quota block', async () => {
  const storage = createMemoryStorage();
  const healthy = worker({ storage });
  await healthy.svc.convert(payloadOf([item(0, T.a)]));

  const calls = { n: 0 };
  const be = makeBackend({ providerOverride: quotaProvider(calls) });
  const store = breakerStore({ [healthy.be.info.model]: { until: Date.now() + 3600_000, error: { code: 'provider-quota-exhausted', message: 'The AI provider\'s daily quota is used up.' } } });
  const blocked = worker({ storage, be, store, info: healthy.be.info });
  const r = await blocked.svc.convert(payloadOf([item(0, T.a), item(1, T.c)]));
  assert.equal(r.ok, true);
  assert.equal(r.data.results[0].cached, true, 'cache hit not blocked');
  assert.equal(r.data.results[1].error.code, 'quota-exhausted', 'the miss is refused locally');
  assert.equal(calls.n, 0);
});

test('an expired block is cleared (and removed from storage) and requests resume', async () => {
  const clock = { t: 10_000_000 };
  const be = makeBackend();
  const model = be.info.model;
  const store = breakerStore({ [model]: { until: clock.t + 1000, error: { code: 'provider-quota-exhausted', message: 'daily quota is used up' } } });
  const w = worker({ be, store, now: () => clock.t });
  assert.equal((await w.svc.convert(payloadOf([item(0, T.a)]))).ok, false, 'blocked before the reset time');
  assert.equal(be.requests.length, 0);

  clock.t += 1001;
  const r = await w.svc.convert(payloadOf([item(0, T.a)]));
  assert.equal(r.ok, true, 'works after the reset time');
  assert.equal(be.requests.length, 1);
  assert.equal(store.box.data[model], undefined, 'the stale block was deleted from storage');
});

test('blocks that are already expired when the worker starts are dropped on load', async () => {
  const be = makeBackend();
  const store = breakerStore({ [be.info.model]: { until: Date.now() - 1, error: { code: 'x', message: 'old' } }, other: { until: Date.now() + 99_999, error: { code: 'x', message: 'other model' } } });
  const w = worker({ be, store });
  assert.equal((await w.svc.convert(payloadOf([item(0, T.a)]))).ok, true);
  assert.deepEqual(Object.keys(store.box.data), ['other'], 'expired removed, unrelated model kept');
});

test('the block belongs to one model: another model is unaffected, and so is a changed MODEL', async () => {
  const be = makeBackend();
  const store = breakerStore({ 'some-other-model': { until: Date.now() + 3600_000, error: { code: 'provider-quota-exhausted', message: 'daily quota is used up' } } });
  const w = worker({ be, store });
  assert.equal((await w.svc.convert(payloadOf([item(0, T.a)]))).ok, true, 'a block for a different model does not apply');
  const blockedModel = worker({ be: makeBackend(), store: breakerStore({ [be.info.model]: { until: Date.now() + 3600_000, error: { code: 'provider-quota-exhausted', message: 'daily quota is used up' } } }) });
  assert.equal((await blockedModel.svc.convert(payloadOf([item(0, T.a)]))).ok, false);
  const switched = worker({ be, info: { promptVersion: be.info.promptVersion, model: 'brand-new-model' }, store: breakerStore({ [be.info.model]: { until: Date.now() + 3600_000, error: { code: 'provider-quota-exhausted', message: 'x'.repeat(5) } } }) });
  assert.equal((await switched.svc.convert(payloadOf([item(0, T.a)]))).ok, true, 'switching MODEL lifts the block');
});

test('malformed or unreadable stored blocks are ignored and never break translation', async () => {
  const garbage = [null, 'string', 42, [], { a: null }, { a: { until: 'soon' } }, { a: { until: Date.now() + 99999 } }, { a: { until: Date.now() + 99999, error: 'nope' } }, { a: { until: NaN, error: { message: 'x' } } }];
  for (const data of garbage) {
    const be = makeBackend();
    const w = worker({ be, store: breakerStore(data) });
    assert.equal((await w.svc.convert(payloadOf([item(0, T.a)]))).ok, true, JSON.stringify(data));
  }
  const unreadable = worker({ store: breakerStore(null, { failLoad: true }) });
  assert.equal((await unreadable.svc.convert(payloadOf([item(0, T.a)]))).ok, true);

  // saving can fail too: the in-memory block still protects the quota for this worker's lifetime
  const calls = { n: 0 };
  const be = makeBackend({ providerOverride: quotaProvider(calls) });
  const w = worker({ be, store: breakerStore(null, { failSave: true }) });
  await w.svc.convert(payloadOf([item(0, T.a)]));
  await w.svc.convert(payloadOf([item(0, T.b)]));
  assert.equal(calls.n, 1);
});

test('a transient rate limit does not arm a block; only daily quota does, and it is never retried', async () => {
  const calls = { n: 0 };
  const perMinute = createOpenAICompatProvider({ apiKey: 'k', model: 'm-rate', baseUrl: 'http://x', fetchImpl: async () => { calls.n++; return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({ error: { message: 'slow down' } }) }; } });
  const store = breakerStore();
  const w = worker({ be: makeBackend({ providerOverride: perMinute }), store });
  const r = await w.svc.convert(payloadOf([item(0, T.a)]));
  assert.equal(r.ok, false);
  assert.equal(store.box.saves, 0, 'rate limit did not create a quota block');
  const again = await w.svc.convert(payloadOf([item(0, T.a)]));
  assert.equal(again.ok, false);
  assert.ok(calls.n >= 2, 'a transient limit may be tried again later');
});

// ================================================================ cache correctness: context

test('the page title is part of the key: same sentence under different titles is never shared', async () => {
  const base = { promptVersion: 'hinglish-v2', model: 'm', text: T.bank, role: 'paragraph', heading: '' };
  const river = await cacheKey({ ...base, title: 'River ecology - field notes' });
  const money = await cacheKey({ ...base, title: 'Personal finance basics' });
  assert.notEqual(river, money);
  assert.equal(await cacheKey({ ...base, title: 'Personal finance basics' }), money, 'same context -> same key');
  assert.equal(await cacheKey({ ...base, title: '  Personal finance basics  ' }), money, 'surrounding spaces do not matter');
  assert.equal(await cacheKey({ ...base }), await cacheKey({ ...base, title: '' }), 'no title == empty title');
  const long = 'x'.repeat(300);
  assert.equal(await cacheKey({ ...base, title: long }), await cacheKey({ ...base, title: long.slice(0, 200) }), 'truncated like the backend does');
  assert.equal(normaliseTitle(undefined), '');
  assert.equal(normaliseTitle(42), '');
});

test('end to end: an ambiguous sentence is re-translated for a different page context, reused for the same one', async () => {
  const w = worker();
  const first = await w.svc.convert(payloadOf([item(0, T.bank)], 'River ecology - field notes'));
  const reused = await w.svc.convert(payloadOf([item(0, T.bank)], 'River ecology - field notes'));
  assert.equal(reused.data.results[0].cached, true);
  const other = await w.svc.convert(payloadOf([item(0, T.bank)], 'Personal finance basics'));
  assert.equal(other.data.results[0].cached, undefined, 'different title -> different context -> fresh translation');
  assert.equal(w.be.requests.length, 2);
  assert.ok(first.ok && other.ok);
  // with page context switched off nothing identifying is sent, and the key matches that
  const noCtx = await w.svc.convert(payloadOf([item(0, T.bank)]));
  assert.equal(noCtx.data.results[0].cached, undefined);
  assert.equal((await w.svc.convert(payloadOf([item(0, T.bank)]))).data.results[0].cached, true);
});

test('prompt version and model isolation still hold with the new key', async () => {
  const storage = createMemoryStorage();
  const v2 = worker({ storage, be: makeBackend({ promptVersion: 'hinglish-v2' }) });
  const v1 = worker({ storage, be: makeBackend({ promptVersion: 'hinglish-v1' }) });
  await v2.svc.convert(payloadOf([item(0, T.a)], 'Title'));
  assert.equal((await v1.svc.convert(payloadOf([item(0, T.a)], 'Title'))).data.results[0].cached, undefined);
  assert.equal((await v2.svc.convert(payloadOf([item(0, T.a)], 'Title'))).data.results[0].cached, true);
  const otherModel = worker({ storage, be: v2.be, info: { promptVersion: 'hinglish-v2', model: 'other-model' } });
  assert.equal((await otherModel.svc.convert(payloadOf([item(0, T.a)], 'Title'))).data.results[0].cached, undefined);
});

// ================================================================ cache correctness: malformed lastUsedAt cannot escape eviction

const entry = (i) => ({ key: `k${i}`, text: `Block number ${i} explains how this works in practice today.`, hinglish: `Block number ${i} kaam karta hai.` });
const mkRecord = (i, over = {}) => ({ v: 2, key: `k${i}`, hinglish: entry(i).hinglish, size: 100, createdAt: 1, lastUsedAt: 1000 + i, ...over });

test('records with a missing, textual, NaN or infinite lastUsedAt are swept and cannot escape eviction', async () => {
  const storage = createMemoryStorage();
  storage._map.set('o1', mkRecord(101, { key: 'o1', lastUsedAt: undefined }));
  storage._map.set('o2', mkRecord(102, { key: 'o2', lastUsedAt: 'yesterday' }));
  storage._map.set('o3', mkRecord(103, { key: 'o3', lastUsedAt: NaN }));
  storage._map.set('o4', mkRecord(104, { key: 'o4', lastUsedAt: Infinity }));
  storage._map.set('o5', { key: 'o5', hinglish: 'no timestamp at all' });
  for (let i = 0; i < 3; i++) storage._map.set(`k${i}`, mkRecord(i));
  const clock = { t: 1_000_000 };
  const cache = createTranslationCache({ storage, now: () => clock.t });
  assert.equal(await storage.count(), 8);
  assert.ok((await storage.indexedCount()) < 8, 'some records are not even in the recency index');

  await cache.prune();
  assert.deepEqual([...storage._map.keys()].sort(), ['k0', 'k1', 'k2'], 'all malformed records removed, valid ones kept');
});

test('eviction still reaches the limit when malformed records are present', async () => {
  const storage = createMemoryStorage();
  for (let i = 0; i < 4; i++) storage._map.set(`bad${i}`, mkRecord(900 + i, { key: `bad${i}`, lastUsedAt: i % 2 ? 'x' : undefined }));
  const clock = { t: 1_000_000 };
  const cache = createTranslationCache({ storage, now: () => clock.t, limits: { ...CACHE_LIMITS, maxEntries: 5 } });
  for (let i = 0; i < 10; i++) { clock.t += 1000; await cache.putMany([entry(i)]); }
  assert.ok((await cache.stats()).entries <= 5);
  assert.ok(![...storage._map.keys()].some((k) => k.startsWith('bad')), 'malformed records are gone');
  const present = await cache.getMany([8, 9].map((i) => ({ key: `k${i}`, text: entry(i).text })));
  assert.equal(present.size, 2, 'newest valid entries survived');
});

test('malformed but indexable timestamps (text, Infinity) are swept before healthy entries are evicted', async () => {
  const storage = createMemoryStorage();
  const clock = { t: 1_000_000 };
  const cache = createTranslationCache({ storage, now: () => clock.t, limits: { ...CACHE_LIMITS, maxEntries: 6 } });
  await cache.prune(); // the worker's first prune happens while the cache is still healthy
  storage._map.set('bad1', mkRecord(901, { key: 'bad1', lastUsedAt: 'a long time ago' }));
  storage._map.set('bad2', mkRecord(902, { key: 'bad2', lastUsedAt: Infinity }));
  assert.equal(await storage.count(), await storage.indexedCount(), 'both are valid index keys: the cheap count check cannot see them');
  for (let i = 0; i < 6; i++) { clock.t += 1000; await cache.putMany([entry(i)]); }
  assert.ok(![...storage._map.keys()].some((k) => k.startsWith('bad')), 'malformed records removed when the limit was hit');
  const healthy = [...storage._map.keys()].filter((k) => k.startsWith('k')).length;
  assert.ok(healthy >= 5, `healthy entries were evicted instead (kept ${healthy})`);
});

test('reading a record whose lastUsedAt is malformed deletes it and counts as a miss', async () => {
  const storage = createMemoryStorage();
  const cache = createTranslationCache({ storage });
  storage._map.set('k1', mkRecord(1, { lastUsedAt: 'yesterday' }));
  assert.equal((await cache.getMany([{ key: 'k1', text: entry(1).text }])).size, 0);
  assert.equal(storage._map.size, 0);
});

test('the sweep runs on the first prune of a worker and is cheap when nothing is wrong', async () => {
  let scans = 0;
  const inner = createMemoryStorage();
  const counting = { ...inner, async orphans(n) { scans++; return inner.orphans(n); } };
  const cache = createTranslationCache({ storage: counting });
  for (let i = 0; i < 5; i++) await cache.putMany([entry(i)]);
  assert.ok(scans >= 1, 'swept at least once at startup');
  assert.ok(scans <= 2, `then only occasionally (${scans} scans for 5 writes)`);
});

// ================================================================ requests: failures release keys, garbage cannot break a page

const garbageReplies = [undefined, null, 'oops', 42, {}, { ok: true }, { ok: true, data: null }, { ok: true, data: {} }, { ok: true, data: { results: 'x' } },
  { ok: true, data: { results: [null, 5, 'x', {}, { id: 'a' }] } }, { ok: true, data: { results: [{ id: 0 }] } }, { ok: true, data: { results: [{ id: 0, hinglish: 12 }] } },
  { ok: false }, { ok: false, error: null }, { ok: false, error: 'string' }];

test('convert never throws, whatever the backend returns, and always releases its keys', async () => {
  for (const reply of garbageReplies) {
    const w = worker({ backend: async () => reply });
    const r = await w.svc.convert(payloadOf([item(0, T.a), item(1, T.b)]));
    assert.ok(r && typeof r.ok === 'boolean', JSON.stringify(reply));
    if (r.ok) assert.ok(r.data.results.every((x) => x.hinglish === undefined || typeof x.hinglish === 'string'));
    assert.equal(w.svc.inflightSize, 0, `keys leaked after ${JSON.stringify(reply)}`);
    const again = await w.svc.convert(payloadOf([item(0, T.a)]));
    assert.ok(again, 'the same text can be requested again');
  }
});

test('convert survives a throwing backend, a throwing info lookup and a throwing cache', async () => {
  const boom = worker({ backend: async () => { throw new Error('backend exploded'); } });
  const r1 = await boom.svc.convert(payloadOf([item(0, T.a)]));
  assert.equal(r1.ok, false);
  assert.equal(r1.error.code, 'internal');
  assert.equal(boom.svc.inflightSize, 0);

  const cache = { getMany: async () => { throw new Error('cache exploded'); }, putMany: async () => 0, clear: async () => 0, stats: async () => ({}) };
  const be = makeBackend();
  const svc = createTranslationService({ cache, backend: be.backend, getInfo: async () => be.info });
  const r2 = await svc.convert(payloadOf([item(0, T.a)]));
  assert.equal(r2.ok, false);
  assert.equal(svc.inflightSize, 0);
  assert.equal((await svc.convert(payloadOf([item(0, T.a)]))).ok, false, 'and keeps answering');

  const noInfo = createTranslationService({ cache: null, backend: be.backend, getInfo: async () => { throw new Error('health exploded'); } });
  assert.equal((await noInfo.convert(payloadOf([item(0, T.a)]))).ok, false);
});

test('malformed requests are answered, not thrown, and bad items do not harm good ones', async () => {
  const w = worker();
  for (const bad of [null, undefined, {}, { items: 'x' }, { items: {} }, 5]) {
    const r = await w.svc.convert(bad);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'invalid-request');
  }
  const r = await w.svc.convert(payloadOf([item(0, T.a), null, { id: 2 }, { id: 3, text: '   ' }, { id: 4, text: 42 }, item(5, T.b)]));
  assert.equal(r.ok, true);
  const byId = Object.fromEntries(r.data.results.filter((x) => x.id !== undefined).map((x) => [x.id, x]));
  assert.ok(byId[0].hinglish && byId[5].hinglish);
  for (const id of [2, 3, 4]) assert.equal(byId[id].error.code, 'invalid-item');
  assert.deepEqual(w.be.requests.flatMap((q) => q.items.map((i) => i.text)).sort(), [T.a, T.b].sort(), 'only valid blocks were sent');
});

test('oversized blocks are refused locally and never take their neighbours down', async () => {
  const w = worker();
  const huge = 'This sentence goes on. '.repeat(250);
  assert.ok(huge.length > BATCH_LIMITS.maxItemChars);
  const r = await w.svc.convert(payloadOf([item(0, T.a), item(1, huge), item(2, T.b)]));
  assert.equal(r.ok, true);
  assert.equal(r.data.results[1].error.code, 'too-long');
  assert.ok(r.data.results[0].hinglish && r.data.results[2].hinglish);
  assert.ok(w.be.requests.every((q) => q.items.every((i) => i.text.length <= BATCH_LIMITS.maxItemChars)));
  const onlyHuge = await w.svc.convert(payloadOf([item(0, huge)]));
  assert.equal(w.be.requests.length, 1, 'a request containing only oversized blocks sends nothing');
  assert.equal(onlyHuge.data.results[0].error.code, 'too-long');
});

test('a backend answering for only some blocks fails the rest, not the page', async () => {
  const be = makeBackend();
  const partial = async (payload) => {
    const real = await be.backend(payload);
    return { ok: true, data: { ...real.data, results: real.data.results.slice(0, 1) } };
  };
  const w = worker({ be, backend: partial });
  const r = await w.svc.convert(payloadOf([item(0, T.a), item(1, T.b), item(2, T.c)]));
  assert.ok(r.data.results[0].hinglish);
  assert.equal(r.data.results[1].error.code, 'missing-result');
  assert.equal(r.data.results[2].error.code, 'missing-result');
  assert.equal(w.svc.inflightSize, 0);
});

// ================================================================ concurrency stress

test('stress: 40 overlapping concurrent requests fetch each unique block once, finish, and leak nothing', async () => {
  const texts = Array.from({ length: 12 }, (_, i) => `Concurrent block number ${i} explains how this particular part of the system behaves in practice today.`);
  const be = makeBackend({ latencyMs: 15 });
  const w = worker({ be });
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const jobs = Array.from({ length: 40 }, () => {
    const pick = texts.filter(() => rnd() < 0.4);
    if (!pick.length) pick.push(texts[0]);
    return pick;
  });
  const run = Promise.all(jobs.map((pick, n) => sleep(rnd() * 30).then(() => w.svc.convert(payloadOf(pick.map((t, i) => item(i, t)))))));
  const done = await Promise.race([run, sleep(5000).then(() => 'deadlock')]);
  assert.notEqual(done, 'deadlock');

  const sent = be.requests.flatMap((q) => q.items.map((i) => i.text));
  const used = new Set(jobs.flat());
  assert.equal(sent.length, used.size, 'every distinct block was requested exactly once');
  assert.equal(new Set(sent).size, sent.length);
  done.forEach((r, n) => {
    assert.equal(r.ok, true);
    r.data.results.forEach((res, i) => assert.equal(res.hinglish, mockTransform(jobs[n][i]), 'right answer for the right block'));
  });
  assert.equal(w.svc.inflightSize, 0);
});

test('stress: a failure in the middle of overlapping requests releases everything and later requests work', async () => {
  const be = makeBackend({ latencyMs: 10 });
  let n = 0;
  const flaky = async (payload) => { n++; if (n % 3 === 0) { await sleep(10); return { ok: false, error: { code: 'unreachable', message: 'down' } }; } return be.backend(payload); };
  const w = worker({ be, backend: flaky });
  const texts = Array.from({ length: 9 }, (_, i) => `Flaky block ${i} explains how this particular part of the system behaves in practice today.`);
  const settled = await Promise.race([
    Promise.all(texts.map((t, i) => w.svc.convert(payloadOf([item(0, t), item(1, texts[(i + 1) % 9])])))),
    sleep(5000).then(() => 'deadlock'),
  ]);
  assert.notEqual(settled, 'deadlock');
  assert.equal(w.svc.inflightSize, 0);
  const healthy = worker({ be, storage: w.storage });
  const retry = await healthy.svc.convert(payloadOf(texts.map((t, i) => item(i, t))));
  assert.equal(retry.ok, true);
  assert.ok(retry.data.results.every((r) => r.hinglish));
});
