import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createController } from '../../extension/src/content/controller.js';
import { MOCK_PREFIX } from '../../extension/src/content/converter.js';
import { createRemoteConverter } from '../../extension/src/content/converter-remote.js';
import { sentencesOf, splitIntoGroups } from '../../extension/src/content/sentence-groups.js';
import { createBackendHints } from '../../extension/src/background/backend-client.js';
import { createTranslationCache, createMemoryStorage } from '../../extension/src/background/translation-cache.js';
import { createTranslationService } from '../../extension/src/background/translation-service.js';
import { sourceFromTemplate } from '../../extension/src/shared/tokens.js';
import { DEFAULT_SETTINGS } from '../../extension/src/shared/settings.js';
import { workerSend } from '../helpers/worker-send.js';

const O = '⟦';
const C = '⟧';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const opts = (over = {}) => ({ ...DEFAULT_SETTINGS, ...over });
const para = (i) => `<p data-i="${i}">Paragraph ${i} explains how this particular part of the system works and why it is useful in practice.</p>`;
const pageOf = (n) => `<body><main>${Array.from({ length: n }, (_, i) => para(i)).join('')}</main></body>`;
const indexOf = (text) => { const m = /Paragraph (\d+)/.exec(text); return m ? Number(m[1]) : -1; };
const convertedCount = (d) => [...d.window.document.querySelectorAll('p')].filter((p) => p.textContent.includes(MOCK_PREFIX)).length;
const controllerFor = (d, converter, layout) => createController({ root: d.window.document.body, converter, layout });

/** Paragraph i sits at y = 100*i (80px tall); scrolling fires the registered scroll listeners, like a browser. */
function scrollableLayout({ vh = 400, scrollY = 0 } = {}) {
  const state = { vh, scrollY };
  const listeners = new Set();
  return {
    state,
    listeners,
    viewport: () => ({ height: state.vh, scrollY: state.scrollY }),
    rectOf: (el) => { const top = Number(el.dataset.i) * 100 - state.scrollY; return { top, bottom: top + 80, width: 600, height: 80 }; },
    onScroll: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    scrollTo(y) { state.scrollY = y; for (const cb of [...listeners]) cb(); },
  };
}

function recorder({ maxItems = 3, latency = 0, onCall, reply, hints, limits } = {}) {
  const rec = {
    limits: limits || { maxItems, maxChars: 1800, maxItemChars: 3900 },
    batches: [], sent: [], calls: 0, inflight: 0, maxInflight: 0,
    async convert(items) {
      const n = ++rec.calls;
      rec.batches.push(items.map((i) => indexOf(i.text)));
      rec.sent.push(...items.map((i) => i.text));
      rec.inflight++;
      rec.maxInflight = Math.max(rec.maxInflight, rec.inflight);
      try {
        if (onCall) await onCall(n, items);
        if (latency) await sleep(typeof latency === 'function' ? latency(n) : latency);
        if (reply) return reply(items, n);
        return items.map((i) => ({ id: i.id, hinglish: MOCK_PREFIX + i.text }));
      } finally { rec.inflight--; }
    },
  };
  if (hints) rec.hints = async () => hints;
  return rec;
}

// ================================================================ visible first, background after

test('visible blocks are requested first, then the rest in the background, and the status says which phase it is in', async () => {
  const d = new JSDOM(pageOf(20));
  const layout = scrollableLayout({ vh: 400, scrollY: 1000 }); // blocks 10..14 on screen (14's top edge touches the fold)
  const phases = [];
  const conv = recorder({ maxItems: 2, latency: 60 });
  const ctl = controllerFor(d, conv, layout);
  const run = ctl.translate(opts({ maxParallelRequests: 1 }));
  await sleep(20);
  phases.push(ctl.getStatus()); // first request (blocks 10, 11) still in flight
  const timer = setInterval(() => phases.push(ctl.getStatus()), 20);
  const final = await run;
  clearInterval(timer);

  assert.deepEqual(conv.batches[0], [10, 11], 'the first request carries the on-screen blocks');
  assert.deepEqual(conv.batches[1], [12, 13]);
  assert.deepEqual(conv.batches[2].slice(0, 1), [14], 'the last on-screen block, then the content below before anything above');
  assert.ok(conv.batches[2].slice(1).every((i) => i > 14));
  assert.equal(phases[0].phase, 'visible');
  assert.equal(phases[0].pendingVisible, 5);
  assert.equal(phases[0].pendingBackground, 15);
  const background = phases.find((s) => s.phase === 'background');
  assert.ok(background, 'a background phase is reported once the visible blocks are done');
  assert.equal(background.pendingVisible, 0);
  assert.ok(background.pendingBackground > 0);
  assert.equal(final.phase, 'idle');
  assert.equal(final.pending, 0);
  assert.equal(final.converted, 20);
});

test('blocks are applied the moment their request returns, not when the page is finished', async () => {
  const d = new JSDOM(pageOf(9));
  const conv = recorder({ maxItems: 3, latency: (n) => (n === 1 ? 20 : 400) });
  const ctl = controllerFor(d, conv, scrollableLayout({ vh: 400 }));
  const run = ctl.translate(opts({ maxParallelRequests: 1 }));
  await sleep(150); // request 1 is done, request 2 is still running
  assert.equal(convertedCount(d), 3, 'the first three blocks are already Hinglish');
  const mid = ctl.getStatus();
  assert.equal(mid.converted, 3);
  assert.equal(mid.state, 'translating');
  assert.equal(mid.pending, 6);
  assert.equal(mid.inflight, 1);
  await run;
  assert.equal(convertedCount(d), 9);
});

// ================================================================ scroll re-prioritisation

test('a scroll event moves the blocks now on screen ahead of distant pending ones, even while a request is in flight', async () => {
  const d = new JSDOM(pageOf(30));
  const layout = scrollableLayout({ vh: 400, scrollY: 0 });
  const conv = recorder({ maxItems: 3, latency: 150 });
  const ctl = controllerFor(d, conv, layout);
  const run = ctl.translate(opts({ maxParallelRequests: 1 }));
  await sleep(30);
  assert.deepEqual(conv.batches[0], [0, 1, 2]);
  assert.equal(ctl.getStatus().pendingVisible, 5, 'blocks 0..4 are on screen at the top');

  layout.scrollTo(2500); // the user jumps far down: blocks 25..29 are on screen
  await sleep(90); // debounce + margin; the first request is STILL in flight
  assert.equal(conv.calls, 1);
  const mid = ctl.getStatus();
  assert.equal(mid.pendingVisible, 5, 'status already reflects the new viewport');
  assert.equal(mid.phase, 'visible');

  await run;
  assert.deepEqual(conv.batches[1], [25, 26, 27], 'the next request is for the new viewport, not block 3');
  assert.ok(conv.batches[1].every((i) => i > 3));
  assert.equal(convertedCount(d), 30, 'everything is still translated eventually');
});

test('scroll listening ends with Restore and starts fresh with each run', async () => {
  const d = new JSDOM(pageOf(6));
  const layout = scrollableLayout();
  const ctl = controllerFor(d, recorder({ latency: 20 }), layout);
  const run = ctl.translate(opts());
  await sleep(5);
  assert.equal(layout.listeners.size, 1);
  await run;
  ctl.restore();
  assert.equal(layout.listeners.size, 0, 'no listener is left behind');
  await ctl.translate(opts());
  assert.equal(layout.listeners.size, 1, 'one listener, not two');
  ctl.restore();
  assert.equal(layout.listeners.size, 0);
});

// ================================================================ backend hints (local model: one request, small batches)

test('hints cap concurrency and request size; they can never raise them', async () => {
  const d = new JSDOM(pageOf(12));
  const capped = recorder({ maxItems: 5, latency: 20, hints: { maxConcurrency: 1, batch: { maxItems: 2 } } });
  await controllerFor(d, capped, scrollableLayout()).translate(opts({ maxParallelRequests: 4 }));
  assert.equal(capped.maxInflight, 1, 'a setting of 4 is held to the backend hint of 1');
  assert.ok(capped.batches.every((b) => b.length <= 2));

  const d2 = new JSDOM(pageOf(12));
  const raised = recorder({ maxItems: 3, latency: 20, hints: { maxConcurrency: 4, batch: { maxItems: 50, maxChars: 99999 } } });
  const st = await controllerFor(d2, raised, scrollableLayout()).translate(opts({ maxParallelRequests: 2 }));
  assert.ok(raised.batches.every((b) => b.length <= 3), 'the converter limit still applies');
  assert.equal(st.concurrency, 2, 'the user setting still applies');
});

test('a converter without hints, or whose hints fail, runs with its own defaults', async () => {
  const d = new JSDOM(pageOf(6));
  const conv = recorder({ maxItems: 3 });
  conv.hints = async () => { throw new Error('worker asleep'); };
  const st = await controllerFor(d, conv, scrollableLayout()).translate(opts({ maxParallelRequests: 2 }));
  assert.equal(st.converted, 6);
  assert.equal(st.concurrency, 2);
});

test('createBackendHints keeps only sane positive integers, caches, and falls back to {} when the backend is down', async () => {
  let calls = 0;
  let body = { ok: true, maxConcurrency: 1, batch: { maxItems: 6, maxChars: 500, maxItemChars: 600, other: 9 } };
  const fetchImpl = async () => { calls++; if (!body) throw new Error('down'); return { ok: true, json: async () => body }; };
  let t = 0;
  const get = createBackendHints({ baseUrl: 'http://x/', fetchImpl, now: () => t });
  assert.deepEqual(await get(), { maxConcurrency: 1, batch: { maxItems: 6, maxChars: 500, maxItemChars: 600 } });
  await get();
  assert.equal(calls, 1, 'cached');
  t += 10 * 60 * 1000;
  body = { maxConcurrency: -3, batch: { maxItems: 'many', maxChars: 0 } };
  assert.deepEqual(await get(), {}, 'junk is ignored');
  t += 10 * 60 * 1000;
  body = null;
  assert.deepEqual(await get(), {}, 'last known value when unreachable');
  const never = createBackendHints({ baseUrl: 'http://x', fetchImpl: async () => { throw new Error('down'); } });
  assert.deepEqual(await never(), {});
});

test('the remote converter fetches hints through the service worker message and tolerates silence', async () => {
  const seen = [];
  const ok = createRemoteConverter({ send: async (m) => { seen.push(m.type); return { ok: true, hints: { maxConcurrency: 1 } }; } });
  assert.deepEqual(await ok.hints(), { maxConcurrency: 1 });
  assert.deepEqual(seen, ['bf:hints']);
  assert.deepEqual(await createRemoteConverter({ send: async () => { throw new Error('no worker'); } }).hints(), {});
  assert.deepEqual(await createRemoteConverter({ send: async () => undefined }).hints(), {});
});

// ================================================================ failures stay local

test('a failed block does not stop the page: the others convert, the error is counted', async () => {
  const d = new JSDOM(pageOf(12));
  const conv = recorder({
    maxItems: 3,
    reply: (items) => items.map((i) => (indexOf(i.text) === 4
      ? { id: i.id, error: { code: 'invalid-output', message: 'bad' } }
      : { id: i.id, hinglish: MOCK_PREFIX + i.text })),
  });
  const st = await controllerFor(d, conv, scrollableLayout()).translate(opts({ maxParallelRequests: 1 }));
  assert.equal(st.converted, 11);
  assert.deepEqual(st.failed, { 'invalid-output': 1 });
  assert.equal(conv.calls, 4, 'every batch was still requested');
  assert.equal(d.window.document.querySelector('[data-i="4"]').textContent.includes(MOCK_PREFIX), false, 'the failed block stays English');
  assert.equal(st.error, undefined, 'no page-level error');
});

test('a whole batch of failed blocks (model trouble) does not stop later batches', async () => {
  const d = new JSDOM(pageOf(9));
  const conv = recorder({
    maxItems: 3,
    reply: (items, n) => items.map((i) => (n === 2 ? { id: i.id, error: { code: 'timeout', message: 'slow' } } : { id: i.id, hinglish: MOCK_PREFIX + i.text })),
  });
  const st = await controllerFor(d, conv, scrollableLayout()).translate(opts({ maxParallelRequests: 1 }));
  assert.equal(st.converted, 6);
  assert.deepEqual(st.failed, { timeout: 3 });
  assert.equal(conv.calls, 3);
  assert.equal(st.pending, 0);
});

// ================================================================ sentence groups for very long blocks

const SENTENCES = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} describes one more detail of how the system behaves in practice.`);

test('sentence groups: cut only at sentence ends outside links, abbreviations and decimals are not sentence ends', () => {
  const linked = `First idea is simple. ${O}1${C}Second idea. Still inside the link.${O}/1${C} Third idea closes it.`;
  assert.deepEqual(sentencesOf(linked), ['First idea is simple.', `${O}1${C}Second idea. Still inside the link.${O}/1${C} Third idea closes it.`]);
  assert.deepEqual(sentencesOf('Use e.g. a map. The value is 3.5 mm. Dr. Rao agrees. Done.'), ['Use e.g. a map.', 'The value is 3.5 mm.', 'Dr. Rao agrees.', 'Done.']);
  assert.equal(sentencesOf('One long unbroken thought with no end'), null);
  assert.equal(splitIntoGroups('Short text. Two sentences.', 100), null, 'a block that fits is never split');
  assert.equal(splitIntoGroups(`${'word '.repeat(200)}`, 100), null, 'no safe cut: not split');

  const parts = splitIntoGroups(SENTENCES.join(' '), 300);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 300), 'every group fits');
  assert.equal(parts.join(' '), SENTENCES.join(' '), 'groups are consecutive sentences: nothing lost, nothing reordered');
  for (const p of splitIntoGroups(`${O}1${C}Linked start.${O}/1${C} ${SENTENCES.join(' ')}`, 300)) assert.ok(sourceFromTemplate(p), 'every group is a valid template');
});

test('a block longer than the request limit is translated as sentence groups and applied as ONE block', async () => {
  const text = SENTENCES.join(' ');
  const html = `<body><main><p>${text}</p><p data-i="1">${SENTENCES[0].replace('Sentence number 0', 'Another paragraph')}</p></main></body>`;
  const d = new JSDOM(html);
  const conv = recorder({ limits: { maxItems: 3, maxChars: 300, maxItemChars: 300 } });
  const st = await controllerFor(d, conv).translate(opts({ maxParallelRequests: 1 }));
  assert.equal(st.failed['too-long'], undefined);
  assert.equal(st.converted, 2);
  assert.ok(conv.sent.every((t) => t.length <= 300), 'nothing larger than the limit was sent');
  assert.ok(conv.sent.length >= 3, 'the long block went out in several groups');
  const p = d.window.document.querySelector('p');
  assert.equal(p.textContent, SENTENCES.map(() => '').join('') + conv.sent.filter((t) => text.includes(t.slice(0, 40))).map((t) => MOCK_PREFIX + t).join(' '));
  assert.equal(st.pending, 0);
});

test('long block with a link: groups never split the link, the link element survives, Restore is exact', async () => {
  const linkSentence = `Read <a href="/more" id="more">the full guide. It has details.</a> before you continue.`;
  const html = `<body><main><p id="long">${SENTENCES.slice(0, 5).join(' ')} ${linkSentence} ${SENTENCES.slice(5, 9).join(' ')}</p></main></body>`;
  const d = new JSDOM(html);
  const a = d.window.document.getElementById('more');
  let clicks = 0;
  a.addEventListener('click', () => { clicks++; });
  const conv = recorder({ limits: { maxItems: 4, maxChars: 260, maxItemChars: 260 } });
  const st = await controllerFor(d, conv).translate(opts({ maxParallelRequests: 1 }));
  assert.equal(st.converted, 1);
  for (const sent of conv.sent) assert.equal((sent.match(/⟦\d+⟧/g) || []).length, (sent.match(/⟦\/\d+⟧/g) || []).length, 'every group has balanced tokens');
  assert.equal(d.window.document.getElementById('more'), a, 'same element object');
  a.dispatchEvent(new d.window.Event('click'));
  assert.equal(clicks, 1, 'listener intact');

  const ctl = controllerFor(new JSDOM(html), recorder());
  ctl.restore();
  const d2 = new JSDOM(html);
  const c2 = controllerFor(d2, recorder({ limits: { maxItems: 4, maxChars: 260, maxItemChars: 260 } }));
  await c2.translate(opts({ maxParallelRequests: 1 }));
  c2.restore();
  assert.equal(d2.serialize(), new JSDOM(html).serialize(), 'exact restoration');
});

test('a failed sentence group fails only its block, and its unsent siblings are cancelled', async () => {
  const text = SENTENCES.join(' ');
  const html = `<body><main><p>${text}</p><p>${SENTENCES[0].replace('Sentence number 0', 'Independent paragraph')}</p></main></body>`;
  const d = new JSDOM(html);
  const conv = recorder({
    limits: { maxItems: 1, maxChars: 300, maxItemChars: 300 },
    reply: (items, n) => items.map((i) => (n === 1 ? { id: i.id, error: { code: 'invalid-output', message: 'x' } } : { id: i.id, hinglish: MOCK_PREFIX + i.text })),
  });
  const st = await controllerFor(d, conv).translate(opts({ maxParallelRequests: 1 }));
  assert.equal(st.converted, 1, 'the other paragraph converted');
  assert.deepEqual(st.failed, { 'invalid-output': 1 });
  assert.equal(d.window.document.querySelector('p').textContent, text, 'the long block stays whole English, never half translated');
  assert.ok(conv.calls < 1 + Math.ceil(text.length / 250) + 1, 'sibling groups were not all sent after the block had already failed');
  assert.equal(st.pending, 0);
});

test('Stop during a sentence-group block leaves it in English and counted as not processed; a later Translate finishes it', async () => {
  const text = SENTENCES.join(' ');
  const d = new JSDOM(`<body><main><p>${text}</p></main></body>`);
  const conv = recorder({ limits: { maxItems: 1, maxChars: 300, maxItemChars: 300 }, latency: 60 });
  const ctl = controllerFor(d, conv);
  const run = ctl.translate(opts({ maxParallelRequests: 1 }));
  await sleep(20);
  ctl.stop();
  const st = await run;
  assert.equal(st.state, 'stopped');
  assert.equal(st.notProcessed, 1);
  assert.equal(d.window.document.querySelector('p').textContent, text);
  await sleep(100);
  assert.equal(d.window.document.querySelector('p').textContent, text, 'a late group answer never produces a half-translated block');
  const again = await ctl.translate(opts({ maxParallelRequests: 1 }));
  assert.equal(again.converted, 1);
});

test('identical long blocks share their sentence groups: each group is requested once', async () => {
  const text = SENTENCES.join(' ');
  const d = new JSDOM(`<body><main><p>${text}</p><p>${text}</p></main></body>`);
  const conv = recorder({ limits: { maxItems: 2, maxChars: 300, maxItemChars: 300 } });
  const st = await controllerFor(d, conv).translate(opts({ maxParallelRequests: 2 }));
  assert.equal(st.converted, 2);
  assert.equal(new Set(conv.sent).size, conv.sent.length, 'no group was sent twice');
});

// ================================================================ cache reuse, through the real worker service

function realStack() {
  const calls = [];
  const info = { promptVersion: 'hinglish-v2', model: 'qwen3:4b' };
  const svc = createTranslationService({
    cache: createTranslationCache({ storage: createMemoryStorage() }),
    getInfo: async () => info,
    backend: async (payload) => {
      calls.push(payload);
      return { ok: true, data: { results: payload.items.map((i) => ({ id: i.id, hinglish: `Hinglish ${i.text}` })), meta: info } };
    },
  });
  const converter = () => ({
    ...createRemoteConverter({ send: workerSend(svc, { maxConcurrency: 1, batch: { maxItems: 4, maxChars: 400, maxItemChars: 300 } }) }),
  });
  return { calls, converter };
}

test('a second visit is served from the cache with zero backend requests, including sentence-group blocks', async () => {
  const html = `<body><main>${Array.from({ length: 6 }, (_, i) => para(i)).join('')}<p data-i="9">${SENTENCES.join(' ')}</p></main></body>`;
  const { calls, converter } = realStack();

  const first = await createController({ root: new JSDOM(html).window.document.body, converter: converter() }).translate(opts());
  assert.equal(first.converted, 7);
  const firstCalls = calls.length;
  assert.ok(firstCalls >= 2);
  assert.ok(calls.every((c) => c.items.every((i) => i.text.length <= 300)));

  const d2 = new JSDOM(html);
  const second = await createController({ root: d2.window.document.body, converter: converter() }).translate(opts());
  assert.equal(calls.length, firstCalls, 'no new backend request');
  assert.equal(second.converted, 7);
  assert.ok(second.cached >= 7 - 1, 'blocks reported as reused from the cache');
  assert.ok(d2.window.document.body.textContent.includes('Hinglish'));
});

// ================================================================ exact restore after a progressive run

test('Restore after a progressive run (partly visible-first, partly background) is exact', async () => {
  const html = pageOf(15).replace('<p data-i="3">', '<p data-i="3"><a href="/x" id="lnk">link</a> ');
  const d = new JSDOM(html);
  const lnk = d.window.document.getElementById('lnk');
  const layout = scrollableLayout({ vh: 400, scrollY: 800 });
  const ctl = controllerFor(d, recorder({ maxItems: 2, latency: 20 }), layout);
  const run = ctl.translate(opts({ maxParallelRequests: 1 }));
  await sleep(50);
  layout.scrollTo(0);
  await run;
  assert.equal(convertedCount(d), 15);
  const out = ctl.restore();
  assert.equal(out.restored, 15);
  assert.equal(d.serialize(), new JSDOM(html).serialize());
  assert.equal(d.window.document.getElementById('lnk'), lnk, 'original element objects are back');
});
