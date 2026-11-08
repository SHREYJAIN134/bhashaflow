import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createController } from '../../extension/src/content/controller.js';
import { MOCK_PREFIX } from '../../extension/src/content/converter.js';
import { createRemoteConverter } from '../../extension/src/content/converter-remote.js';
import { createTranslationCache, createMemoryStorage } from '../../extension/src/background/translation-cache.js';
import { createTranslationService } from '../../extension/src/background/translation-service.js';
import { DEFAULT_SETTINGS } from '../../extension/src/shared/settings.js';

const O = '⟦';
const C = '⟧';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opts = (over = {}) => ({ ...DEFAULT_SETTINGS, ...over });
const para = (i) => `<p data-i="${i}">Paragraph ${i} explains how this particular part of the system works and why it is useful in practice.</p>`;
const pageOf = (idx) => `<body><main>${idx.map(para).join('')}</main></body>`;
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
const indexOf = (text) => { const m = /Paragraph (\d+)/.exec(text); return m ? Number(m[1]) : -1; };
const hinglishCount = (d) => [...d.window.document.querySelectorAll('p')].filter((p) => p.textContent.startsWith('Hinglish ')).length;

/** The real worker service (cache, dedupe) behind the real remote converter, with a counted fake backend. */
function stack({ backendLatency = 0, hints = {}, gate = null } = {}) {
  const info = { promptVersion: 'hinglish-v2', model: 'qwen3:4b' };
  const backendCalls = [];
  const messages = [];
  const svc = createTranslationService({
    cache: createTranslationCache({ storage: createMemoryStorage() }),
    getInfo: async () => info,
    backend: async (payload) => {
      backendCalls.push(payload.items.map((i) => i.text));
      if (backendLatency) await sleep(backendLatency);
      if (gate) await gate.promise; // a test holds the model here
      return { ok: true, data: { results: payload.items.map((i) => ({ id: i.id, hinglish: `Hinglish ${i.text}` })), meta: info } };
    },
  });
  const send = async (m) => {
    messages.push(m);
    if (m.type === 'bf:hints') return { ok: true, hints };
    if (m.type === 'bf:lookup') return svc.lookup(m.payload, { useCache: m.useCache });
    return svc.convert(m.payload, { useCache: m.useCache });
  };
  const controller = (d, layout) => createController({ root: d.window.document.body, converter: createRemoteConverter({ send }), layout });
  return { svc, backendCalls, messages, controller };
}

// ================================================================ the worker's cache-only lookup

test('lookup answers only what is cached, never calls the backend, and tolerates garbage', async () => {
  const s = stack();
  await s.svc.convert({ v: 1, page: { title: 'T' }, items: [{ id: 0, text: 'Cached sentence number one is here.', role: 'paragraph' }] });
  assert.equal(s.backendCalls.length, 1);

  const res = await s.svc.lookup({
    v: 1, page: { title: 'T' },
    items: [{ id: 7, text: 'Cached sentence number one is here.', role: 'paragraph' }, { id: 8, text: 'Never translated before.', role: 'paragraph' }, null, { id: 9, text: '   ' }, { id: 10, text: 42 }],
  });
  assert.deepEqual(res, { ok: true, data: { results: [{ id: 7, hinglish: 'Hinglish Cached sentence number one is here.', cached: true }] } });
  assert.equal(s.backendCalls.length, 1, 'lookup made no backend request');
  assert.deepEqual((await s.svc.lookup({ v: 1, items: [{ id: 1, text: 'Cached sentence number one is here.', role: 'paragraph' }] }, { useCache: false })).data.results, []);
  assert.deepEqual((await s.svc.lookup({ v: 1, page: { title: 'Other page' }, items: [{ id: 1, text: 'Cached sentence number one is here.', role: 'paragraph' }] })).data.results, [], 'a different page title is a different key');
  assert.deepEqual((await s.svc.lookup(null)).data.results, []);
  assert.deepEqual((await s.svc.lookup({ items: 'nope' })).data.results, []);
});

test('lookup is empty when the backend identity is unknown (no safe cache key)', async () => {
  const svc = createTranslationService({ cache: createTranslationCache({ storage: createMemoryStorage() }), getInfo: async () => null, backend: async () => ({ ok: false, error: { code: 'x', message: 'x' } }) });
  assert.deepEqual((await svc.lookup({ v: 1, items: [{ id: 0, text: 'Some text here.', role: 'paragraph' }] })).data.results, []);
});

// ================================================================ cache first, then the model

test('saved translations are painted before the model answers; only the misses are requested', async () => {
  const s = stack({ backendLatency: 300 });
  await s.controller(new JSDOM(pageOf(range(0, 5)))).translate(opts()); // first visit fills the cache
  s.backendCalls.length = 0;

  const d = new JSDOM(pageOf(range(0, 8))); // 5 saved paragraphs + 3 new ones
  const ctl = s.controller(d);
  const run = ctl.translate(opts());
  for (let i = 0; i < 40 && hinglishCount(d) < 5; i++) await sleep(5); // saved text must show up while the 300 ms model answer is still pending
  assert.equal(hinglishCount(d), 5, 'the 5 saved paragraphs are already Hinglish while the model is still working');
  assert.equal(ctl.getStatus().state, 'translating');
  const st = await run;

  assert.equal(hinglishCount(d), 8);
  assert.deepEqual(s.backendCalls.flat().map(indexOf).sort(), [5, 6, 7], 'the model only saw the three unsaved paragraphs');
  assert.equal(st.cached, 5);
  const p = st.perf;
  assert.ok(p.firstCachedBlockMs < p.firstFreshBlockMs - 150, `cached paint (${p.firstCachedBlockMs} ms) comes well before the model answer (${p.firstFreshBlockMs} ms)`);
  assert.ok(p.firstFreshBlockMs >= 280, 'fresh paragraphs wait for the model');
  assert.equal(p.firstBlockMs, p.firstCachedBlockMs, 'the first thing the reader sees is the saved text');
  assert.equal(p.cacheHitRate, 0.625);
  assert.equal(p.requests, 1);
  assert.equal(p.blocksRequested, 3);
  assert.ok(p.cacheLookups >= 1 && p.cacheLookupMs >= 0);
});

test('a fully saved page needs zero model requests and paints in milliseconds', async () => {
  const s = stack({ backendLatency: 50 });
  const html = pageOf(range(0, 12));
  await s.controller(new JSDOM(html)).translate(opts());
  const calls = s.backendCalls.length;

  const d = new JSDOM(html);
  const st = await s.controller(d).translate(opts());
  assert.equal(s.backendCalls.length, calls, 'no new backend request');
  assert.equal(st.perf.requests, 0);
  assert.equal(st.perf.cacheHitRate, 1);
  assert.equal(hinglishCount(d), 12);
  assert.ok(st.perf.firstBlockMs < 250, `first block after ${st.perf.firstBlockMs} ms`);
  assert.equal(st.pending, 0);
  assert.equal(st.phase, 'idle');
});

test('a large saved page is looked up in chunks, highest priority first, with no model request', async () => {
  const s = stack();
  const html = pageOf(range(0, 150));
  await s.controller(new JSDOM(html)).translate(opts());
  const calls = s.backendCalls.length;
  s.messages.length = 0;

  const d = new JSDOM(html);
  const st = await s.controller(d).translate(opts());
  const lookups = s.messages.filter((m) => m.type === 'bf:lookup');
  assert.equal(lookups.length, 3, '150 blocks = 64 + 64 + 22');
  assert.ok(lookups.every((m) => m.payload.items.length <= 64));
  assert.equal(s.backendCalls.length, calls);
  assert.equal(hinglishCount(d), 150);
  assert.equal(st.perf.cacheLookups, 3);
  assert.equal(s.messages.filter((m) => m.type === 'bf:convert').length, 0, 'no convert message at all');
});

test('the visible block of a mixed page is the first one dispatched; saved blocks never share its batch', async () => {
  const s = stack({ backendLatency: 40 });
  await s.controller(new JSDOM(pageOf([0, 1, 2, 3]))).translate(opts());
  s.backendCalls.length = 0;
  const layout = {
    viewport: () => ({ height: 400, scrollY: 0 }),
    rectOf: (el) => { const top = Number(el.dataset.i) * 100; return { top, bottom: top + 80, width: 600, height: 80 }; },
  };
  const d = new JSDOM(pageOf([0, 1, 10, 2, 11, 3, 12]));
  await s.controller(d, layout).translate(opts({ maxParallelRequests: 1 }));
  const sent = s.backendCalls.flat().map(indexOf);
  assert.deepEqual(sent.sort((a, b) => a - b), [10, 11, 12], 'saved blocks 0..3 were never sent');
  assert.equal(hinglishCount(d), 7);
});

// ================================================================ failures and corruption never block the page

test('a broken or lying lookup falls back to the model and the page still completes', async () => {
  for (const lookup of [
    async () => { throw new Error('worker asleep'); },
    async () => 'not an array',
    async () => [{ id: 99, hinglish: 'wrong id', cached: true }, { id: 'x', hinglish: 'bad id' }, null, { id: 0 }, { id: 1, hinglish: 42 }],
  ]) {
    const d = new JSDOM(pageOf(range(0, 6)));
    const calls = [];
    const conv = {
      limits: { maxItems: 3, maxChars: 1800, maxItemChars: 3900 },
      lookup,
      convert: async (items) => { calls.push(items.length); return items.map((i) => ({ id: i.id, hinglish: MOCK_PREFIX + i.text })); },
    };
    const st = await createController({ root: d.window.document.body, converter: conv }).translate(opts());
    assert.equal(st.converted, 6);
    assert.deepEqual(st.failed, {});
    assert.equal(calls.reduce((a, b) => a + b, 0), 6, 'every block went to the model');
  }
});

test('a saved answer that no longer fits the block markup is ignored and the model is asked instead', async () => {
  const html = `<body><main><p id="t">Read the ${'<a href="/guide" id="g">full guide</a>'} before you continue with the setup.</p></main></body>`;
  const d = new JSDOM(html);
  const a = d.window.document.getElementById('g');
  const asked = [];
  const conv = {
    limits: { maxItems: 3, maxChars: 1800, maxItemChars: 3900 },
    lookup: async (items) => items.map((i) => ({ id: i.id, hinglish: 'Saved answer that dropped every link token.', cached: true })),
    convert: async (items) => { asked.push(items.length); return items.map((i) => ({ id: i.id, hinglish: i.text.replace('Read', 'Padho') })); },
  };
  const st = await createController({ root: d.window.document.body, converter: conv }).translate(opts());
  assert.equal(asked.length, 1, 'fell back to the model');
  assert.equal(st.converted, 1);
  assert.equal(d.window.document.getElementById('g'), a, 'the original link element survived');
  assert.ok(d.window.document.getElementById('t').textContent.startsWith('Padho'));
});

test('a failed fresh paragraph does not stop saved or later ones', async () => {
  const s = stack();
  await s.controller(new JSDOM(pageOf([0, 1]))).translate(opts());
  const svcConvert = s.svc.convert;
  const send = async (m) => {
    if (m.type === 'bf:hints') return { ok: true, hints: {} };
    if (m.type === 'bf:lookup') return s.svc.lookup(m.payload, { useCache: m.useCache });
    const reply = await svcConvert(m.payload, { useCache: m.useCache });
    reply.data.results = reply.data.results.map((r) => (r.hinglish && r.hinglish.includes('Paragraph 3 ') ? { id: r.id, error: { code: 'invalid-output', message: 'x' } } : r));
    return reply;
  };
  const d = new JSDOM(pageOf(range(0, 6)));
  const st = await createController({ root: d.window.document.body, converter: createRemoteConverter({ send }) }).translate(opts());
  assert.equal(st.converted, 5);
  assert.deepEqual(st.failed, { 'invalid-output': 1 });
  assert.equal(hinglishCount(d), 5);
});

// ================================================================ scheduling still follows the reader

function scrollable({ vh = 400, scrollY = 0 } = {}) {
  const state = { scrollY };
  const listeners = new Set();
  return {
    listeners,
    viewport: () => ({ height: vh, scrollY: state.scrollY }),
    rectOf: (el) => { const top = Number(el.dataset.i) * 100 - state.scrollY; return { top, bottom: top + 80, width: 600, height: 80 }; },
    onScroll: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    scrollTo(y) { state.scrollY = y; for (const cb of [...listeners]) cb(); },
  };
}

test('with cache-first on, scrolling still moves the new viewport ahead of distant pending blocks', async () => {
  const s = stack({ backendLatency: 400 });
  await s.controller(new JSDOM(pageOf([0, 1, 2]))).translate(opts()); // 0..2 are saved
  s.backendCalls.length = 0;
  const layout = scrollable();
  const d = new JSDOM(pageOf(range(0, 30)));
  const run = s.controller(d, layout).translate(opts({ maxParallelRequests: 1 }));
  for (let i = 0; i < 40 && hinglishCount(d) < 3; i++) await sleep(5);
  assert.equal(hinglishCount(d), 3, 'saved blocks painted before the first model answer');
  layout.scrollTo(2500);
  await sleep(100);
  await run;
  const batches = s.backendCalls.map((b) => b.map(indexOf));
  assert.ok(batches[0].includes(3) && batches[0].every((i) => i >= 3 && i < 25), 'the first request was for the top of the page (saved 0..2 never sent)');
  assert.ok(batches[1].some((i) => i >= 25 && i <= 29), 'the next request is for the new viewport, ahead of the blocks still pending in between');
  assert.equal(hinglishCount(d), 30);
});

test('the first request can be capped so the top visible block does not wait for its neighbours', async () => {
  const s = stack({ backendLatency: 20, hints: { firstBatchItems: 1 } });
  const d = new JSDOM(pageOf(range(0, 8)));
  await s.controller(d, scrollable()).translate(opts({ maxParallelRequests: 1 }));
  const sizes = s.backendCalls.map((b) => b.length);
  assert.equal(sizes[0], 1, 'first request carries a single block');
  assert.ok(sizes.slice(1).some((n) => n > 1), 'later requests batch normally');
  assert.equal(hinglishCount(d), 8);
});

// ================================================================ control + restore + dynamic content

test('Pause, Resume and Restore still work while cache lookups and requests are running', async () => {
  let open;
  const gate = { promise: new Promise((r) => { open = r; }) };
  const gated = stack({ hints: { batch: { maxItems: 3 } }, gate });
  const html = pageOf(range(0, 14));
  const d = new JSDOM(html);
  const ctl = gated.controller(d);
  const run = ctl.translate(opts({ maxParallelRequests: 1 }));
  for (let i = 0; i < 200 && gated.backendCalls.length < 1; i++) await sleep(5); // request 1 is now held in the model
  ctl.pause();
  assert.equal(ctl.getStatus().state, 'paused');
  open(); // the model answers request 1
  await sleep(150);
  assert.equal(gated.backendCalls.length, 1, 'nothing new leaves while paused, though request 1 finished');
  assert.equal(hinglishCount(d), 3, 'the in-flight answer was still applied');
  ctl.resume();
  await run;
  assert.equal(gated.backendCalls.length, 5, '14 blocks in requests of 3');
  assert.equal(hinglishCount(d), 14);

  const out = ctl.restore();
  assert.equal(out.restored, 14);
  assert.equal(d.serialize(), new JSDOM(html).serialize(), 'exact original markup');
});

test('Stop during cache lookups and requests keeps what is painted, and Restore is exact', async () => {
  let open;
  const gate = { promise: new Promise((r) => { open = r; }) };
  const s = stack({ hints: { batch: { maxItems: 3 } }, gate });
  const html = pageOf(range(0, 9));
  const d = new JSDOM(html);
  const ctl = s.controller(d);
  const run = ctl.translate(opts({ maxParallelRequests: 1 }));
  for (let i = 0; i < 200 && s.backendCalls.length < 1; i++) await sleep(5);
  ctl.stop();
  open();
  const st = await run;
  assert.equal(st.state, 'stopped');
  await sleep(100);
  assert.equal(s.backendCalls.length, 1, 'no request after Stop');
  assert.equal(hinglishCount(d), 3, 'the answer already in flight was kept');
  ctl.restore();
  assert.equal(d.serialize(), new JSDOM(html).serialize());
});

test('Restore after a cache-first paint is exact, keeps links and listeners, and a late answer cannot repaint', async () => {
  const s = stack({ backendLatency: 200 });
  const html = `<body><main>${para(0)}<p data-i="1">See <a href="/x" id="x">the guide</a> for details about how the cache and the scheduler cooperate here.</p>${para(2)}</main></body>`;
  await s.controller(new JSDOM(html)).translate(opts()); // saved
  const d = new JSDOM(html.replace('Paragraph 2 explains', 'Paragraph 2 now explains'));
  const x = d.window.document.getElementById('x');
  let clicks = 0;
  x.addEventListener('click', () => { clicks++; });
  const ctl = s.controller(d);
  const run = ctl.translate(opts());
  await sleep(60);
  assert.equal(x.isConnected, true);
  ctl.restore(); // while the one unsaved paragraph is still with the model
  await run;
  await sleep(300);
  assert.equal(d.window.document.body.textContent.includes('Hinglish'), false, 'late answer discarded');
  assert.equal(d.window.document.getElementById('x'), x);
  x.dispatchEvent(new d.window.Event('click'));
  assert.equal(clicks, 1);
  assert.equal(d.serialize(), new JSDOM(html.replace('Paragraph 2 explains', 'Paragraph 2 now explains')).serialize());
});

test('dynamic content that is already saved is painted without a request; new text is requested once', async () => {
  const s = stack({ backendLatency: 40 });
  await s.controller(new JSDOM(pageOf([5]))).translate(opts()); // block 5 is saved
  const d = new JSDOM(pageOf([0, 1]));
  const ctl = s.controller(d);
  await ctl.translate(opts({ observe: true }));
  s.backendCalls.length = 0;
  const main = d.window.document.querySelector('main');
  const add = (i) => { const p = d.window.document.createElement('p'); p.dataset.i = String(i); p.textContent = `Paragraph ${i} explains how this particular part of the system works and why it is useful in practice.`; main.append(p); return p; };
  const saved = add(5);
  const brandNew = add(40);
  await sleep(900);
  assert.ok(saved.textContent.startsWith('Hinglish '));
  assert.ok(brandNew.textContent.startsWith('Hinglish '));
  assert.deepEqual(s.backendCalls.flat().map(indexOf), [40], 'only the unseen block reached the model');
  ctl.restore();
});

test('status perf is null before a run and reports honest empties for an empty page', async () => {
  const s = stack();
  const d = new JSDOM('<body><main></main></body>');
  const ctl = s.controller(d);
  assert.equal(ctl.getStatus().perf, null);
  const st = await ctl.translate(opts());
  assert.equal(st.perf.requests, 0);
  assert.equal(st.perf.firstBlockMs, null);
  assert.equal(st.perf.cacheHitRate, null);
  assert.equal(st.perf.blockMsP95, null);
});
