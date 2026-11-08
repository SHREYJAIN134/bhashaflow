import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createController, priorityOf } from '../../extension/src/content/controller.js';
import { MOCK_PREFIX } from '../../extension/src/content/converter.js';
import { BATCH_LIMITS, packBatches, takeBatch } from '../../extension/src/content/batching.js';
import { DEFAULT_SETTINGS } from '../../extension/src/shared/settings.js';

const O = '⟦';
const C = '⟧';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const N = 30;
const para = (i) => `<p data-i="${i}">Paragraph ${i} explains how this particular part of the system works and why it is useful in practice.</p>`;
const pageOf = (n, extra = '') => `<body><main>${Array.from({ length: n }, (_, i) => para(i)).join('')}${extra}</main></body>`;
const indexOf = (text) => { const m = /Paragraph (\d+)/.exec(text); return m ? Number(m[1]) : -1; };
const opts = (over = {}) => ({ ...DEFAULT_SETTINGS, ...over });

/** Layout stub: paragraph i sits at y = 100*i, 80px tall, 600px wide; viewport and scroll are adjustable. */
function stubLayout({ vh = 400, scrollY = 0 } = {}) {
  const state = { vh, scrollY };
  return {
    state,
    viewport: () => ({ height: state.vh, scrollY: state.scrollY }),
    rectOf: (el) => {
      const top = Number(el.dataset.i) * 100 - state.scrollY;
      return { top, bottom: top + 80, width: 600, height: 80 };
    },
  };
}

/** A converter that records every request and lets a test control timing. */
function recorder({ maxItems = 3, latency = 0, onCall, reply } = {}) {
  const rec = {
    limits: { maxItems, maxChars: 1800, maxItemChars: 3900 },
    batches: [], calls: 0, inflight: 0, maxInflight: 0, sentTexts: [],
    async convert(items, options) {
      rec.calls++;
      rec.batches.push(items.map((i) => indexOf(i.text)));
      rec.sentTexts.push(...items.map((i) => i.text));
      rec.inflight++;
      rec.maxInflight = Math.max(rec.maxInflight, rec.inflight);
      try {
        if (onCall) await onCall(rec.calls, items, options);
        if (latency) await sleep(typeof latency === 'function' ? latency(rec.calls) : latency);
        if (reply) return reply(items, rec.calls);
        return items.map((i) => ({ id: i.id, hinglish: MOCK_PREFIX + i.text }));
      } finally {
        rec.inflight--;
      }
    },
  };
  return rec;
}
const dom = (html) => new JSDOM(html);
const controllerFor = (d, conv, layout) => createController({ root: d.window.document.body, converter: conv, layout });
const converted = (d) => [...d.window.document.querySelectorAll('p')].filter((p) => p.textContent.includes(MOCK_PREFIX)).length;

// ================================================================ viewport-first priority

test('priority ranks: on screen, just below, far below, above (nearest first)', () => {
  const vh = 400;
  const at = (top) => ({ top, bottom: top + 80, width: 600, height: 80 });
  assert.deepEqual(priorityOf(at(100), vh), [0, 100]);
  assert.deepEqual(priorityOf(at(-40), vh), [0, 0], 'partly scrolled off the top still counts as visible');
  assert.deepEqual(priorityOf(at(401), vh), [1, 401]);
  assert.deepEqual(priorityOf(at(1000), vh), [1, 1000], 'within 1.5 screens below');
  assert.deepEqual(priorityOf(at(1001), vh), [2, 1001]);
  assert.deepEqual(priorityOf(at(-500), vh), [3, -(-500 + 80)]);
  assert.deepEqual(priorityOf({ top: 0, bottom: 0, width: 0, height: 0 }, vh), [0, 0], 'no layout: ties keep document order');
  assert.deepEqual(priorityOf(at(10), 0), [0, 0], 'no viewport: ties keep document order');
});

test('visible blocks are requested first, then below the fold, then the rest, then above (nearest first)', async () => {
  const d = dom(pageOf(N));
  const layout = stubLayout({ vh: 400, scrollY: 1500 }); // blocks 15..19 on screen
  const conv = recorder({ maxItems: 3 });
  const st = await controllerFor(d, conv, layout).translate(opts({ maxParallelRequests: 1 }));
  assert.equal(st.converted, N);
  assert.deepEqual(conv.batches[0], [15, 16, 17], 'the first request is the top of the viewport');
  const expected = [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0];
  assert.deepEqual(conv.batches.flat(), expected);
});

test('with parallel requests the priority order is still the dispatch order', async () => {
  const d = dom(pageOf(N));
  const conv = recorder({ maxItems: 3, latency: 5 });
  await controllerFor(d, conv, stubLayout({ vh: 400, scrollY: 1500 })).translate(opts({ maxParallelRequests: 3 }));
  assert.deepEqual(conv.batches.flat(), [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
});

test('scrolling while it works re-prioritises what is left around the new viewport', async () => {
  const d = dom(pageOf(N));
  const layout = stubLayout({ vh: 400, scrollY: 1500 });
  const conv = recorder({ maxItems: 3, onCall: (n) => { if (n === 1) layout.state.scrollY = 0; } }); // user scrolls to the top
  await controllerFor(d, conv, layout).translate(opts({ maxParallelRequests: 1 }));
  assert.deepEqual(conv.batches[0], [15, 16, 17]);
  assert.deepEqual(conv.batches[1], [0, 1, 2], 'next request follows the user to the top of the page');
  assert.equal(conv.batches.flat().length, N);
  assert.equal(new Set(conv.batches.flat()).size, N, 'nothing requested twice');
});

test('without layout information the page is processed in document order', async () => {
  const d = dom(pageOf(12));
  const conv = recorder({ maxItems: 4 });
  const st = await createController({ root: d.window.document.body, converter: conv }).translate(opts({ maxParallelRequests: 1 }));
  assert.deepEqual(conv.batches.flat(), [...Array(12).keys()]);
  assert.equal(st.converted, 12);
});

test('the first request leaves immediately after the scan, before anything is awaited', async () => {
  const d = dom(pageOf(N));
  let release;
  const gate = new Promise((r) => { release = r; });
  const conv = recorder({ maxItems: 3, onCall: () => gate });
  const ctl = controllerFor(d, conv, stubLayout({ vh: 400, scrollY: 0 }));
  const run = ctl.translate(opts({ maxParallelRequests: 2 }));
  assert.equal(conv.calls, 2, 'two requests already in flight, synchronously');
  assert.deepEqual(conv.batches, [[0, 1, 2], [3, 4, 5]]);
  const mid = ctl.getStatus();
  assert.equal(mid.state, 'translating');
  assert.equal(mid.inflight, 2);
  assert.equal(mid.pending, N, 'nothing finished yet');
  release();
  const st = await run;
  assert.equal(st.pending, 0);
  assert.equal(st.converted, N);
});

test('batch taking uses the same rules as packing', () => {
  const lens = [100, 400, 700, 50, 900, 1700, 2500, 80, 80, 80, 1750, 20];
  const entries = lens.map((n, i) => ({ i, n }));
  const packed = packBatches(entries, (e) => e.n).batches.map((b) => b.map((e) => e.i));
  const queue = [...entries];
  const taken = [];
  for (let b = takeBatch(queue, BATCH_LIMITS, (e) => e.n); b.length; b = takeBatch(queue, BATCH_LIMITS, (e) => e.n)) taken.push(b.map((e) => e.i));
  assert.deepEqual(taken, packed);
});

// ================================================================ parallel requests

test('concurrency is bounded by the setting and clamped to 1-4', async () => {
  for (const [setting, expected] of [[1, 1], [2, 2], [3, 3], [4, 4], [9, 4], [0, 2], ['abc', 2], [undefined, 2], [-3, 1]]) {
    const d = dom(pageOf(N));
    const conv = recorder({ maxItems: 1, latency: 4 });
    const st = await controllerFor(d, conv, stubLayout()).translate(opts({ maxParallelRequests: setting }));
    assert.equal(st.converted, N, `setting ${setting}`);
    assert.equal(conv.maxInflight, expected, `setting ${setting}`);
  }
});

test('answers arriving out of order are applied correctly, once each', async () => {
  const d = dom(pageOf(12));
  const original = dom(pageOf(12)).serialize();
  const conv = recorder({ maxItems: 3, latency: (call) => (call === 1 ? 80 : 5) }); // first request is the slowest
  const ctl = controllerFor(d, conv, stubLayout());
  const st = await ctl.translate(opts({ maxParallelRequests: 4 }));
  assert.equal(st.converted, 12);
  assert.equal(converted(d), 12);
  assert.ok(![...d.window.document.querySelectorAll('p')].some((p) => p.textContent.includes(MOCK_PREFIX + MOCK_PREFIX)));
  ctl.restore();
  assert.equal(d.serialize(), original);
});

test('status reports honest progress while requests are running', async () => {
  const d = dom(pageOf(12));
  const seen = [];
  let ctl;
  const conv = recorder({ maxItems: 3, latency: 10, onCall: () => { seen.push(ctl.getStatus()); } });
  ctl = controllerFor(d, conv, stubLayout());
  const st = await ctl.translate(opts({ maxParallelRequests: 2 }));
  assert.ok(seen.every((s) => s.state === 'translating' && s.eligible === 12));
  assert.ok(seen.some((s) => s.inflight === 2), 'two requests shown running');
  assert.ok(seen.every((s) => s.pending > 0 && s.pending <= 12));
  assert.ok(seen[seen.length - 1].converted > 0, 'progress advances between requests');
  assert.equal(st.pending, 0);
  assert.equal(st.inflight, 0);
});

// ================================================================ quota and failures stop scheduling

test('a quota error stops new requests immediately; at most the requests already in flight were sent', async () => {
  const d = dom(pageOf(N));
  const original = dom(pageOf(N)).serialize();
  const conv = recorder({ maxItems: 3, latency: 5, reply: (items) => items.map((i) => ({ id: i.id, error: { code: 'quota-exhausted', message: 'daily quota is used up' } })) });
  const st = await controllerFor(d, conv, stubLayout()).translate(opts({ maxParallelRequests: 2 }));
  assert.ok(conv.calls <= 2, `${conv.calls} requests sent for a 10-request page`);
  assert.match(st.error, /daily quota/);
  assert.equal(st.state, 'translated');
  assert.equal(st.converted, 0);
  assert.ok(st.notProcessed >= N - 6, `${st.notProcessed} blocks were never sent`);
  assert.equal(st.pending, 0);
  assert.equal(d.serialize(), original);
});

test('a backend failure (thrown) also stops scheduling, and answers still in flight are applied', async () => {
  const d = dom(pageOf(N));
  let calls = 0;
  const conv = recorder({ maxItems: 3, latency: 15 });
  const original = conv.convert;
  conv.convert = async (items, o) => {
    calls++;
    if (calls === 1) { await sleep(5); throw Object.assign(new Error('Could not reach the BhashaFlow backend. Is it running?'), { code: 'unreachable' }); }
    return original(items, o);
  };
  const st = await controllerFor(d, conv, stubLayout()).translate(opts({ maxParallelRequests: 2 }));
  assert.equal(calls, 2, 'no third request after the failure');
  assert.match(st.error, /Could not reach/);
  assert.equal(st.converted, 3, 'the request that was already in flight still landed');
  assert.equal(st.pending, 0);
});

// ================================================================ pause / resume / stop / restore

test('pause stops new requests; in-flight ones finish; resume continues to the end', async () => {
  const d = dom(pageOf(N));
  const conv = recorder({ maxItems: 3, latency: 25 });
  const ctl = controllerFor(d, conv, stubLayout());
  let settled = false;
  const run = ctl.translate(opts({ maxParallelRequests: 2 })).then((s) => { settled = true; return s; });
  await sleep(5);
  assert.equal(ctl.pause().state, 'paused');
  const callsAtPause = conv.calls;
  await sleep(120);
  assert.equal(conv.calls, callsAtPause, 'nothing new was sent while paused');
  assert.equal(settled, false, 'the run is still open');
  const mid = ctl.getStatus();
  assert.equal(mid.state, 'paused');
  assert.equal(mid.inflight, 0);
  assert.equal(mid.converted, callsAtPause * 3, 'in-flight requests completed and were applied');
  assert.ok(mid.pending > 0);

  assert.equal(ctl.resume().state, 'translating');
  const st = await run;
  assert.equal(st.state, 'translated');
  assert.equal(st.converted, N);
  assert.equal(conv.calls, N / 3);
});

test('pause and resume are harmless when nothing is running', () => {
  const ctl = controllerFor(dom(pageOf(3)), recorder(), stubLayout());
  assert.equal(ctl.pause().state, 'idle');
  assert.equal(ctl.resume().state, 'idle');
  assert.equal(ctl.stop().state, 'idle');
});

test('stop keeps finished work, drops the queue, and a later Translate finishes only the rest', async () => {
  const d = dom(pageOf(N));
  const original = dom(pageOf(N)).serialize();
  const conv = recorder({ maxItems: 3, latency: 20 });
  const ctl = controllerFor(d, conv, stubLayout());
  const run = ctl.translate(opts({ maxParallelRequests: 1 }));
  while (ctl.getStatus().converted === 0) await sleep(5);
  const stopped = ctl.stop();
  assert.equal(stopped.state, 'stopped');
  const st = await run;
  assert.equal(st.state, 'stopped');
  assert.ok(st.converted >= 3 && st.converted < N);
  assert.ok(st.notProcessed > 0);
  assert.equal(st.pending, 0);
  const sentBefore = [...conv.sentTexts];

  const again = await ctl.translate(opts({ maxParallelRequests: 1 }));
  assert.equal(again.converted, N - st.converted, 'only the blocks that were never done');
  assert.equal(converted(d), N);
  const sentAfter = conv.sentTexts.slice(sentBefore.length);
  assert.ok(sentAfter.every((t) => !sentBefore.includes(t)), 'nothing was requested twice');

  ctl.restore();
  assert.equal(d.serialize(), original);
});

test('restore during in-flight requests discards the late answers and leaves the page untouched', async () => {
  const d = dom(pageOf(N));
  const original = dom(pageOf(N)).serialize();
  const conv = recorder({ maxItems: 3, latency: 40 });
  const ctl = controllerFor(d, conv, stubLayout());
  const run = ctl.translate(opts({ maxParallelRequests: 3 }));
  await sleep(10);
  const status = ctl.restore();
  assert.equal(status.state, 'restored');
  const st = await run;
  assert.equal(st.state, 'restored');
  await sleep(120); // late answers arrive here
  assert.equal(d.serialize(), original, 'nothing was applied after restore');
  assert.ok(conv.calls <= 3, 'no new requests after restore');
  assert.equal(ctl.getStatus().pending, 0);
});

test('a second Translate click while running is ignored (no duplicate run)', async () => {
  const d = dom(pageOf(12));
  const conv = recorder({ maxItems: 3, latency: 20 });
  const ctl = controllerFor(d, conv, stubLayout());
  const first = ctl.translate(opts({ maxParallelRequests: 1 }));
  const second = await ctl.translate(opts({ maxParallelRequests: 1 }));
  assert.equal(second.state, 'translating');
  await first;
  assert.equal(conv.sentTexts.length, 12, 'each block requested exactly once');
});

// ================================================================ duplicates, dynamic content

test('identical blocks are requested once and every copy is converted', async () => {
  const same = 'Identical paragraph number 7 explains how this particular part of the system works in practice.';
  const html = `<body><main>${[0, 1, 2, 3, 4, 5].map(() => `<p>${same}</p>`).join('')}${para(100)}</main></body>`;
  const d = dom(html);
  const conv = recorder({ maxItems: 12, reply: (items) => items.map((i) => ({ id: i.id, hinglish: MOCK_PREFIX + i.text })) });
  conv.batches = [];
  const orig = conv.convert;
  conv.convert = async (items, o) => { conv.sentTexts.push(...items.map((i) => i.text)); return items.map((i) => ({ id: i.id, hinglish: MOCK_PREFIX + i.text })); };
  const ctl = controllerFor(d, conv, stubLayout());
  const st = await ctl.translate(opts());
  assert.equal(conv.sentTexts.filter((t) => t === same).length, 1);
  assert.equal(st.deduped, 5);
  assert.equal(st.converted, 7);
  assert.equal(converted(d), 7);
  assert.ok(orig);
});

test('dynamic content joins the same queue: new text is requested once, repeats are free', async () => {
  const d = dom(pageOf(6));
  const document = d.window.document;
  const conv = recorder({ maxItems: 12, latency: 60 });
  const ctl = controllerFor(d, conv, stubLayout());
  await ctl.translate(opts({ observe: true }));
  const before = conv.sentTexts.length;
  assert.equal(ctl.getStatus().observing, true);

  const add = (i) => { const p = document.createElement('p'); p.dataset.i = String(i); p.textContent = `Paragraph ${i} explains how this particular part of the system works and why it is useful in practice.`; document.querySelector('main').append(p); return p; };
  const fresh1 = add(50);
  await sleep(380); // observer debounce, then the request is in flight for ~60ms
  const fresh2 = add(50); // identical text arrives while/after the first is processed
  const repeat = add(2); // identical to a block translated in the original run
  await sleep(700);

  assert.ok(fresh1.textContent.startsWith(MOCK_PREFIX));
  assert.ok(fresh2.textContent.startsWith(MOCK_PREFIX));
  assert.ok(repeat.textContent.startsWith(MOCK_PREFIX));
  const newSent = conv.sentTexts.slice(before);
  assert.equal(newSent.filter((t) => indexOf(t) === 50).length, 1, 'duplicate dynamic text requested once');
  assert.equal(newSent.filter((t) => indexOf(t) === 2).length, 0, 'text already translated in this run is not requested again');
  ctl.restore();
  assert.ok(!document.body.textContent.includes(MOCK_PREFIX));
});

test('dynamic content respects the quota halt: nothing is sent after it', async () => {
  const d = dom(pageOf(6));
  const document = d.window.document;
  let calls = 0;
  const conv = recorder({ maxItems: 12, reply: (items) => (++calls === 1 ? items.map((i) => ({ id: i.id, hinglish: MOCK_PREFIX + i.text })) : items.map((i) => ({ id: i.id, error: { code: 'quota-exhausted', message: 'daily quota is used up' } }))) });
  const ctl = controllerFor(d, conv, stubLayout());
  await ctl.translate(opts({ observe: true }));
  const p = document.createElement('p');
  p.textContent = 'Paragraph 77 explains how this particular part of the system works and why it is useful in practice.';
  document.querySelector('main').append(p);
  await sleep(450);
  const q = document.createElement('p');
  q.textContent = 'Paragraph 78 explains how this particular part of the system works and why it is useful in practice.';
  document.querySelector('main').append(q);
  await sleep(450);
  assert.equal(calls, 2, 'one request for 77 (refused), none for 78');
  assert.match(ctl.getStatus().error, /daily quota/);
  assert.ok(!q.textContent.startsWith(MOCK_PREFIX));
  ctl.restore();
});

// ================================================================ malformed answers and oversized blocks

test('malformed converter answers never hang or break the run', async () => {
  for (const bad of [undefined, null, 'oops', {}, { results: [] }, [null, 5, 'x', { id: 'a' }, { id: 99, hinglish: 'nobody asked' }]]) {
    const d = dom(pageOf(6));
    const original = dom(pageOf(6)).serialize();
    const conv = recorder({ maxItems: 3, reply: () => bad });
    const st = await Promise.race([controllerFor(d, conv, stubLayout()).translate(opts()), sleep(2000).then(() => 'hang')]);
    assert.notEqual(st, 'hang', JSON.stringify(bad));
    assert.equal(st.converted, 0);
    assert.equal(st.failed['missing-result'], 6);
    assert.equal(st.pending, 0);
    assert.equal(d.serialize(), original);
  }
});

test('a short reply fails only the missing blocks; a corrupted reply never reaches the page', async () => {
  const d = dom(pageOf(3));
  const conv = recorder({ maxItems: 3, reply: (items) => [{ id: items[0].id, hinglish: MOCK_PREFIX + items[0].text }] });
  const st = await controllerFor(d, conv, stubLayout()).translate(opts());
  assert.equal(st.converted, 1);
  assert.equal(st.failed['missing-result'], 2);

  const linked = dom('<body><main><p>Machine learning is a <a href="/x">branch</a> of artificial intelligence that learns from data.</p></main></body>');
  const original = linked.serialize();
  const bad = recorder({ reply: (items) => items.map((i) => ({ id: i.id, hinglish: `Machine learning ek ${O}1${C}branch hai ${O}9${C}.` })) });
  const s2 = await createController({ root: linked.window.document.body, converter: bad }).translate(opts());
  assert.equal(s2.converted, 0);
  assert.equal(s2.failed['placeholder-mismatch'], 1);
  assert.equal(linked.serialize(), original, 'corrupted markup was never displayed');
});

test('an oversized block is reported and never sent; the rest of the page converts', async () => {
  const huge = `Paragraph 900 ${'with a very long sentence that keeps going and going. '.repeat(90)}`;
  assert.ok(huge.length > BATCH_LIMITS.maxItemChars);
  const d = dom(pageOf(4, `<p>${huge}</p>`));
  const conv = recorder({ maxItems: 12 });
  const st = await controllerFor(d, conv, stubLayout()).translate(opts());
  assert.equal(st.converted, 4);
  assert.equal(st.failed['too-long'], 1);
  assert.ok(conv.sentTexts.every((t) => t.length <= BATCH_LIMITS.maxItemChars));
});

test('event handlers and links survive parallel conversion and restore', async () => {
  const html = `<body><main>${Array.from({ length: 8 }, (_, i) => `<p data-i="${i}">Paragraph ${i} explains how this <a id="a${i}" href="/p${i}">particular</a> part of the system works and why it is useful in practice.</p>`).join('')}</main></body>`;
  const d = dom(html);
  const original = dom(html).serialize();
  const clicks = [];
  const links = [...d.window.document.querySelectorAll('a')];
  links.forEach((a) => a.addEventListener('click', () => clicks.push(a.id)));
  const conv = recorder({ maxItems: 2, latency: 3 });
  const ctl = controllerFor(d, conv, stubLayout());
  await ctl.translate(opts({ maxParallelRequests: 4 }));
  for (const a of links) { assert.equal(a.isConnected, true); a.dispatchEvent(new d.window.Event('click')); }
  assert.deepEqual(clicks, links.map((a) => a.id));
  ctl.restore();
  assert.equal(d.serialize(), original);
  for (const a of links) a.dispatchEvent(new d.window.Event('click'));
  assert.equal(clicks.length, links.length * 2, 'the same listeners still fire after restore');
});
