import { findContent } from './scanner.js';
import { ReplacementStore } from './replacer.js';
import { parseConverted } from './inline.js';
import { sourceFromTemplate } from '../shared/tokens.js';
import { normalizeLanguage } from '../shared/languages.js';
import { createObserver } from './observer.js';
import { mockConverter } from './converter.js';
import { takeBatch } from './batching.js';
import { splitIntoGroups } from './sentence-groups.js';

const ROLE_BY_TAG = { li: 'list-item', dd: 'definition', figcaption: 'caption', td: 'table-cell', th: 'table-cell' };
const roleOf = (item) => (item.verdict.reason === 'dictionary' ? 'definition' : ROLE_BY_TAG[item.run.host.localName] || 'paragraph');

const FIXED_BATCH = 25; // blocks per request for converters that declare no size limits (the offline mock)
const MAX_ELIGIBLE = 3000; // per run; the rest is reported as truncated
const EXPLAIN_LIMIT = 2000;
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 4;
const LOOKAHEAD_VIEWPORTS = 1.5; // "immediately below the fold" = within this many screens
const SCROLL_DEBOUNCE_MS = 50;
const LOOKUP_CHUNK = 64; // blocks per cache lookup message; the first chunk is the highest-priority blocks
const yieldToMain = () => new Promise((resolve) => setTimeout(resolve, 0));
const now = () => (globalThis.performance ? performance.now() : Date.now());
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function emptyStats() {
  return { total: 0, eligible: 0, converted: 0, skipped: {}, failed: {}, regions: 0, scanMs: 0, truncated: 0, cached: 0, deduped: 0, notProcessed: 0 };
}

function deferred() {
  const d = { done: false };
  d.promise = new Promise((resolve) => { d.resolve = () => { d.done = true; resolve(); }; });
  return d;
}

/** Real-browser layout access. Replaceable in tests (jsdom has no layout). */
function browserLayout(doc) {
  const win = doc.defaultView;
  return {
    viewport: () => ({ height: (win && win.innerHeight) || doc.documentElement.clientHeight || 0, scrollY: (win && win.scrollY) || 0 }),
    rectOf: (el) => el.getBoundingClientRect(),
    /** cb runs on scroll; returns an unsubscribe function. */
    onScroll: (cb) => {
      if (!win) return () => {};
      win.addEventListener('scroll', cb, { passive: true });
      return () => win.removeEventListener('scroll', cb);
    },
  };
}

/**
 * Reading order priority for the scheduler: [rank, distance].
 *  rank 0 = on screen (top first), 1 = within 1.5 screens below, 2 = further below, 3 = above (nearest first).
 * Without layout (zero-sized rects or no viewport) everything ties, which keeps document order.
 */
export function priorityOf(rect, viewportHeight) {
  if (!viewportHeight || (!rect.width && !rect.height && !rect.top && !rect.bottom)) return [0, 0];
  if (rect.bottom >= 0 && rect.top <= viewportHeight) return [0, Math.max(rect.top, 0)];
  if (rect.top > viewportHeight) return [rect.top - viewportHeight <= viewportHeight * LOOKAHEAD_VIEWPORTS ? 1 : 2, rect.top];
  return [3, -rect.bottom];
}

/**
 * Orchestrates scan -> classify -> prioritise -> convert (bounded parallel requests) -> replace, plus
 * pause / resume / stop, restore, and (opt-in) dynamic content. One run at a time per page.
 */
export function createController({ root, converter = mockConverter, layout }) {
  const store = new ReplacementStore();
  const doc = root.ownerDocument;
  const lay = layout || browserLayout(doc);
  let state = 'idle'; // idle | translating | paused | stopped | translated | restored
  let runId = 0;
  let stats = emptyStats();
  let explainLog = [];
  let regions = [];
  let lastOpts = null;
  let observer = null;
  let run = null;
  let lastLanguage = null; // the language the page was last translated into (a different choice re-translates from the original)
  let unsubscribeScroll = null;
  let scrollTimer = null;
  let queued = new WeakSet(); // first node of every run that is waiting for / in a request: never queue twice

  const bump = (bucket, key, n = 1) => { stats[bucket][key] = (stats[bucket][key] || 0) + n; };

  function record(items) {
    for (const { run: r, verdict, handled } of items) {
      stats.total++;
      if (handled) bump('skipped', 'already-converted');
      else if (!verdict.eligible) bump('skipped', verdict.reason);
      if (explainLog.length < EXPLAIN_LIMIT) {
        explainLog.push({ eligible: verdict.eligible, reason: verdict.reason, text: r.plain.slice(0, 80) });
      }
    }
  }

  // ------------------------------------------------------------------ run state

  function newRun(opts) {
    const conv = opts.useMock ? mockConverter : converter;
    const base = conv.limits || { maxItems: conv.batchSize || FIXED_BATCH, maxChars: Infinity, maxItemChars: Infinity };
    return {
      id: runId, opts, conv, base, limits: base, lang: normalizeLanguage(opts.targetLanguage),
      sendContext: opts.sendPageContext !== false,
      useCache: opts.cacheEnabled !== false,
      concurrency: clamp(Number.parseInt(opts.maxParallelRequests, 10) || DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY),
      firstBatchItems: Infinity, dispatched: 0, lookups: 0,
      perf: { t0: now(), lookupMs: 0, lookupCalls: 0, firstApplyMs: null, firstCachedMs: null, firstFreshMs: null, requests: [] },
      queue: [], groups: new Map(), active: 0, accepted: 0, seq: 0, scrollAt: 0,
      paused: false, stopped: false, userStopped: false, fatal: null,
      idle: deferred(),
    };
  }

  /** Backend hints can only make requests smaller / fewer at once, never larger. */
  function applyHints(r, hints) {
    const hb = hints.batch || {};
    r.limits = {
      maxItems: Math.min(r.base.maxItems, hb.maxItems || Infinity),
      maxChars: Math.min(r.base.maxChars, hb.maxChars || Infinity),
      maxItemChars: Math.min(r.base.maxItemChars, hb.maxItemChars || Infinity),
    };
    r.concurrency = Math.min(r.concurrency, hints.maxConcurrency || MAX_CONCURRENCY);
    r.firstBatchItems = hints.firstBatchItems || Infinity;
  }

  function pendingBlocks() {
    if (!run) return 0;
    let n = 0;
    for (const g of run.groups.values()) if (g.state !== 'done') n += g.members.length;
    return n;
  }

  /** Pending blocks split into "on screen now" (rank 0) and "everything else, in the background". */
  function pendingSplit() {
    const out = { visible: 0, background: 0 };
    if (!run) return out;
    for (const g of run.groups.values()) {
      if (g.state === 'done' || !g.members.length) continue;
      let rank = g.rank;
      if (g.partGroups) rank = Math.min(3, ...g.partGroups.filter((p) => p.state !== 'done').map((p) => p.rank));
      out[rank === 0 ? 'visible' : 'background'] += g.members.length;
    }
    return out;
  }

  // ------------------------------------------------------------------ queueing

  function rankGroups(r, groups) {
    const { height, scrollY } = lay.viewport();
    for (const g of groups) {
      let rect;
      try { rect = lay.rectOf(g.rep.run.host); } catch { rect = { top: 0, bottom: 0, width: 0, height: 0 }; }
      [g.rank, g.dist] = priorityOf(rect, height);
    }
    r.scrollAt = scrollY;
  }
  /** Re-ranks everything still waiting or in flight against the current viewport (used on scroll). */
  function refreshRanks(r) {
    const live = [];
    for (const g of r.groups.values()) if (g.state !== 'done' && !g.partGroups) live.push(g);
    if (live.length) rankGroups(r, live);
    sortQueue(r);
  }
  const sortQueue = (r) => r.queue.sort((a, b) => a.rank - b.rank || a.dist - b.dist || a.seq - b.seq);

  function resolveMembers(g, members) {
    const res = g.result;
    for (const item of members) {
      queued.delete(item.run.nodes[0]);
      if (res.error) { bump('failed', res.error.code || 'error'); continue; }
      const tree = parseConverted(res.hinglish, item.run.source);
      if (!tree) { bump('failed', 'placeholder-mismatch'); continue; }
      if (store.apply(item.run, tree)) { stats.converted++; noteApplied(res.cached); }
      else bump('failed', 'apply');
    }
  }

  /** A finished group answers its own members and every sentence-group parent that is waiting for it. */
  function completeGroup(g) {
    resolveMembers(g, g.members);
    for (const { parent, index } of g.joins || []) {
      if (parent.state === 'done') continue; // already failed or dropped: nothing left to assemble
      if (g.result.error) {
        parent.result = { error: g.result.error };
        parent.state = 'done';
        cancelOrphans(parent);
        resolveMembers(parent, parent.members);
        continue;
      }
      parent.texts[index] = g.result.hinglish;
      if (--parent.remaining === 0) {
        parent.result = { hinglish: parent.texts.join(' ') };
        parent.state = 'done';
        resolveMembers(parent, parent.members);
      }
    }
  }

  /** A parent that failed has no use for sentence groups nobody else wants and that have not left yet. */
  function cancelOrphans(parent) {
    const r = run;
    for (const pg of parent.partGroups) {
      if (pg.state !== 'queued' || !pg.joins.every((j) => j.parent.state === 'done')) continue;
      const at = r.queue.indexOf(pg);
      if (at !== -1) r.queue.splice(at, 1);
      pg.state = 'done';
      pg.result = { error: { code: 'not-processed' } };
    }
  }

  /** Splits an over-long block into sentence groups; each group is a normal scheduler group. */
  function enqueueSplit(r, parent, partTexts, fresh) {
    parent.texts = new Array(partTexts.length);
    parent.remaining = partTexts.length;
    parent.partGroups = [];
    partTexts.forEach((text, index) => {
      const key = JSON.stringify([text, parent.rep.role, r.sendContext ? parent.rep.run.heading : '']);
      let pg = r.groups.get(key);
      if (pg) {
        pg.joins.push({ parent, index });
        parent.partGroups.push(pg);
        if (pg.state === 'done') completeGroup(pg); // an identical sentence group is already translated
        return;
      }
      pg = { key, text, rep: parent.rep, members: [], joins: [{ parent, index }], state: 'queued', seq: r.seq++, rank: 0, dist: 0, result: null };
      r.groups.set(key, pg);
      parent.partGroups.push(pg);
      fresh.push(pg);
    });
  }

  /** Timestamps (ms since the Translate click) of the first block painted, from the cache and from the model. */
  function noteApplied(cached) {
    const p = run && run.perf;
    if (!p) return;
    const t = Math.round((now() - p.t0) * 10) / 10;
    if (p.firstApplyMs === null) p.firstApplyMs = t;
    if (cached && p.firstCachedMs === null) p.firstCachedMs = t;
    if (!cached && p.firstFreshMs === null) p.firstFreshMs = t;
  }

  /** One cache-only lookup for these groups. Hits are applied now and leave the queue; misses stay queued. */
  async function lookupChunk(r, groups) {
    const live = groups.filter((g) => g.state === 'queued');
    if (!live.length) return;
    const request = live.map((g, j) => ({
      id: j, text: g.text,
      context: { pageTitle: doc.title, heading: g.rep.run.heading, tag: g.rep.run.host.localName, role: g.rep.role },
    }));
    const t = now();
    let results = [];
    try { results = await r.conv.lookup(request, { sendContext: r.sendContext, lang: r.lang }); } catch { results = []; }
    for (const g of live) g.awaitLookup = false;
    r.perf.lookupMs += now() - t;
    r.perf.lookupCalls++;
    if (run !== r || r.stopped) return;
    for (const res of Array.isArray(results) ? results : []) {
      const g = res && Number.isInteger(res.id) ? live[res.id] : undefined;
      if (!g || g.state !== 'queued' || typeof res.hinglish !== 'string') continue; // not ours, or already on its way to the model
      const source = sourceFromTemplate(g.text);
      if (!source || !parseConverted(res.hinglish, source)) continue; // a saved answer that no longer fits the block: ask the model instead
      const at = r.queue.indexOf(g);
      if (at === -1) continue;
      r.queue.splice(at, 1);
      g.state = 'done';
      g.result = { hinglish: res.hinglish, cached: true };
      stats.cached++;
      completeGroup(g);
    }
  }

  /**
   * Paints saved translations BEFORE any model request: the highest-priority chunk is looked up first (awaited, a few
   * ms), the rest in the background while the first request is already running. Blocks found in the cache never
   * enter a batch, so a cache hit cannot wait for a slow neighbour.
   */
  function primeFromCache(r, groups) {
    // Returns undefined (no await, so the first request still leaves synchronously after the scan) when there is no cache to ask.
    if (typeof r.conv.lookup !== 'function' || !r.useCache || !groups.length) return undefined;
    const ordered = groups.slice().sort((a, b) => a.rank - b.rank || a.dist - b.dist || a.seq - b.seq);
    for (const g of ordered.slice(LOOKUP_CHUNK)) g.awaitLookup = true; // not sent to the model until their lookup has answered
    return primeChunks(r, ordered);
  }

  async function primeChunks(r, ordered) {
    await lookupChunk(r, ordered.slice(0, LOOKUP_CHUNK));
    if (ordered.length <= LOOKUP_CHUNK || run !== r) return;
    r.lookups++;
    (async () => {
      try {
        for (let i = LOOKUP_CHUNK; i < ordered.length && run === r && !r.stopped; i += LOOKUP_CHUNK) {
          await lookupChunk(r, ordered.slice(i, i + LOOKUP_CHUNK));
          pump();
        }
      } finally {
        r.lookups--;
        if (run === r) { pump(); checkIdle(r); }
      }
    })();
  }

  function failMembers(members, code) {
    for (const item of members) { queued.delete(item.run.nodes[0]); bump('failed', code); }
  }

  /** Adds scanned blocks to the run: identical blocks share one group (one request, many applications). */
  function enqueue(items) {
    const r = run;
    if (r.idle.done) r.idle = deferred();
    const eligible = items.filter((i) => i.verdict.eligible && !i.handled);
    stats.eligible += eligible.length;
    const room = Math.max(0, MAX_ELIGIBLE - r.accepted);
    if (eligible.length > room) stats.truncated += eligible.length - room;
    const work = eligible.slice(0, room);
    r.accepted += work.length;

    const fresh = [];
    for (const item of work) {
      item.role = roleOf(item);
      const key = JSON.stringify([item.verdict.text, item.role, r.sendContext ? item.run.heading : '']);
      queued.add(item.run.nodes[0]);
      const existing = r.groups.get(key);
      if (existing) { // same text, role and context: no second request
        existing.members.push(item);
        stats.deduped++;
        if (existing.state === 'done') resolveMembers(existing, [item]);
        continue;
      }
      const text = item.verdict.text;
      if (text.length > r.limits.maxItemChars) {
        // Too long to send as one block: translate consecutive sentence groups instead (cut only where no link or
        // bold span is open). A block with no safe cut can never be sent.
        const parts = splitIntoGroups(text, r.limits.maxItemChars);
        if (!parts || parts.some((p) => p.length > r.limits.maxItemChars)) { failMembers([item], 'too-long'); continue; }
        const parent = { key, text, rep: item, members: [item], state: 'split', seq: r.seq++, rank: 0, dist: 0, result: null };
        r.groups.set(key, parent);
        enqueueSplit(r, parent, parts, fresh);
        continue;
      }
      const g = { key, text, rep: item, members: [item], state: 'queued', seq: r.seq++, rank: 0, dist: 0, result: null };
      r.groups.set(key, g);
      fresh.push(g);
    }
    if (fresh.length) {
      rankGroups(r, fresh);
      r.queue.push(...fresh);
      sortQueue(r);
    }
    return fresh;
  }

  function dropQueue(r) {
    for (const g of r.queue) {
      for (const item of g.members) queued.delete(item.run.nodes[0]);
      stats.notProcessed += g.members.length;
      g.state = 'done';
      g.result = { error: { code: 'not-processed' } };
    }
    r.queue.length = 0;
    for (const g of r.groups.values()) { // a block waiting for sentence groups that will never be sent
      if (g.state !== 'split') continue;
      for (const item of g.members) queued.delete(item.run.nodes[0]);
      stats.notProcessed += g.members.length;
      g.state = 'done';
      g.result = { error: { code: 'not-processed' } };
    }
  }

  // ------------------------------------------------------------------ scheduling

  function reprioritiseIfScrolled(r) {
    if (r.queue.length < 2) return;
    const { height, scrollY } = lay.viewport();
    if (height && Math.abs(scrollY - r.scrollAt) > height / 2) { rankGroups(r, r.queue); sortQueue(r); }
  }

  function checkIdle(r) {
    if (r.active === 0 && r.lookups === 0 && (r.queue.length === 0 || r.stopped)) r.idle.resolve();
  }

  /** Starts requests until the concurrency limit is reached. Never starts one while paused or stopped. */
  function pump() {
    const r = run;
    if (!r) return;
    while (!r.paused && !r.stopped && r.active < r.concurrency && r.queue.length) {
      reprioritiseIfScrolled(r);
      // The very first request is kept small so the top visible block does not wait for neighbours it was batched with.
      const limits = r.dispatched === 0 && r.firstBatchItems < r.limits.maxItems ? { ...r.limits, maxItems: r.firstBatchItems } : r.limits;
      const pool = r.lookups > 0 ? r.queue.filter((g) => !g.awaitLookup) : r.queue; // a group whose cache lookup is pending must not go to the model yet
      const batch = takeBatch(pool, limits, (g) => g.text.length);
      if (!batch.length) break;
      if (pool !== r.queue) for (const g of batch) r.queue.splice(r.queue.indexOf(g), 1);
      r.dispatched++;
      dispatch(r, batch);
    }
    checkIdle(r);
  }

  /** Stops scheduling for good (quota, backend down): in-flight requests finish, nothing new is sent. */
  function haltRun(r, error) {
    if (!r.fatal) {
      r.fatal = error;
      stats.error = String(error && error.message ? error.message : error);
    }
    r.stopped = true;
    dropQueue(r);
  }

  async function dispatch(r, batch) {
    r.active++;
    for (const g of batch) g.state = 'inflight';
    const request = batch.map((g, j) => ({
      id: j,
      text: g.text,
      context: { pageTitle: doc.title, heading: g.rep.run.heading, tag: g.rep.run.host.localName, role: g.rep.role },
    }));
    let results;
    let failure = null;
    const sentAt = now();
    try {
      results = await r.conv.convert(request, { sendContext: r.sendContext, useCache: r.useCache, lang: r.lang });
    } catch (err) {
      failure = err;
    }
    if (!failure) r.perf.requests.push({ ms: Math.round((now() - sentAt) * 10) / 10, blocks: batch.length, chars: batch.reduce((n, g) => n + g.text.length, 0) });
    r.active--;
    if (run !== r) return; // restore() cancelled this run while the request was in flight: drop the answer

    if (failure) {
      for (const g of batch) { g.state = 'done'; g.result = { error: { code: 'request-failed' } }; for (const item of g.members) queued.delete(item.run.nodes[0]); }
      haltRun(r, failure);
    } else {
      settle(r, batch, results);
    }
    if (observer) observer.discard();
    await yieldToMain();
    if (run === r) pump();
  }

  /** Applies one request's answers. Whatever the converter returned, every group in the batch is finished. */
  function settle(r, batch, results) {
    const seen = new Set();
    let quotaError = null;
    for (const res of Array.isArray(results) ? results : []) {
      const g = res && Number.isInteger(res.id) ? batch[res.id] : undefined;
      if (!g || seen.has(res.id)) continue;
      seen.add(res.id);
      if (res.error) {
        g.result = { error: res.error };
        if (res.error.code === 'quota-exhausted' && !quotaError) quotaError = res.error;
      } else if (typeof res.hinglish !== 'string') {
        g.result = { error: { code: 'bad-response' } };
      } else {
        g.result = { hinglish: res.hinglish };
        if (res.cached) stats.cached++;
      }
      g.state = 'done';
      completeGroup(g);
    }
    batch.forEach((g, j) => { // a malformed or short reply must not leave blocks pending forever
      if (seen.has(j)) return;
      g.result = { error: { code: 'missing-result' } };
      g.state = 'done';
      completeGroup(g);
    });
    if (quotaError) haltRun(r, Object.assign(new Error(quotaError.message || 'AI provider quota exhausted'), { code: quotaError.code }));
  }

  // ------------------------------------------------------------------ public actions

  async function translate(opts) {
    if (state === 'translating' || state === 'paused') return getStatus();
    const wanted = normalizeLanguage(opts.targetLanguage);
    // Already translated into the OTHER language: put the original back first, so the new language is translated from
    // English (not from the previous translation) and Restore still returns the exact original.
    if ((state === 'translated' || state === 'stopped') && lastLanguage && lastLanguage !== wanted) restore();
    lastLanguage = wanted;
    const myRunId = ++runId;
    state = 'translating';
    stats = emptyStats();
    explainLog = [];
    lastOpts = opts;
    queued = new WeakSet();
    stopScrollWatch();
    run = newRun(opts); // created now, so Pause / Stop / Restore work from the first instant
    const r = run;
    startScrollWatch(r);
    // The backend may advertise how many requests to run at once and how big they should be (local models: 1, small).
    if (typeof converter.hints === 'function' && !opts.useMock) {
      let hints = {};
      try { hints = (await converter.hints()) || {}; } catch { hints = {}; }
      if (myRunId !== runId || run !== r) return getStatus(); // restored while waiting
      applyHints(r, hints);
      if (r.userStopped) { state = 'stopped'; return getStatus(); } // Stop was clicked before the scan began
    }

    let fresh = [];
    try {
      const t0 = now();
      const found = findContent(root, opts, { isOwn: (n) => store.isOwn(n) || queued.has(n) });
      stats.scanMs = Math.round(now() - t0);
      regions = found.regions.map((x) => x.el);
      stats.regions = regions.length;
      record(found.items);
      fresh = enqueue(found.items);
    } catch (err) {
      state = 'translated';
      stats.error = String(err && err.message ? err.message : err);
      return getStatus();
    }

    const priming = primeFromCache(r, fresh); // saved translations are painted first; only the misses go to the model
    if (priming) {
      await priming;
      if (myRunId !== runId || run !== r) return getStatus(); // restored meanwhile
    }
    pump(); // the first (on-screen) request leaves right after the scan
    await r.idle.promise;
    if (myRunId !== runId || run !== r) return getStatus(); // restored meanwhile

    if (r.userStopped) {
      state = 'stopped';
    } else {
      state = 'translated'; // blocks already converted stay restorable, also after an error
      if (!r.fatal) setObserve(Boolean(opts.observe));
    }
    return getStatus();
  }

  /** Scrolling re-ranks what is left, so the blocks now on screen jump ahead of distant pending ones. */
  function startScrollWatch(r) {
    if (typeof lay.onScroll !== 'function') return;
    unsubscribeScroll = lay.onScroll(() => {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        if (run === r && !r.stopped) refreshRanks(r);
      }, SCROLL_DEBOUNCE_MS);
    });
  }

  function stopScrollWatch() {
    if (unsubscribeScroll) { unsubscribeScroll(); unsubscribeScroll = null; }
    if (scrollTimer) { clearTimeout(scrollTimer); scrollTimer = null; }
  }

  /** Dynamic content joins the same queue, so nothing is queued or translated twice. */
  async function handleDynamic(nodes) {
    for (const node of nodes) {
      const r = run;
      if (state !== 'translated' || !r || r.fatal || !node.isConnected) return;
      const found = findContent(node, lastOpts, { isOwn: (n) => store.isOwn(n) || queued.has(n), knownRegions: regions });
      for (const reg of found.regions) if (!regions.includes(reg.el)) regions.push(reg.el);
      record(found.items);
      const priming = primeFromCache(r, enqueue(found.items));
      if (priming) { await priming; if (run !== r) return; }
      pump();
      await r.idle.promise;
      if (r.fatal) return;
    }
  }

  function setObserve(on) {
    if (on && state === 'translated') {
      if (!observer) observer = createObserver({ root, onNodes: handleDynamic });
      observer.start();
    } else if (observer) {
      observer.stop();
      observer = null;
    }
    return { observing: Boolean(observer && observer.active) };
  }

  /** Stop sending new requests; requests already in flight finish and are applied. */
  function pause() {
    if (state !== 'translating' || !run) return getStatus();
    run.paused = true;
    state = 'paused';
    return getStatus();
  }

  function resume() {
    if (state !== 'paused' || !run) return getStatus();
    run.paused = false;
    state = 'translating';
    pump();
    return getStatus();
  }

  /** Cancel processing but KEEP what is already translated (Restore undoes it). */
  function stop() {
    if ((state !== 'translating' && state !== 'paused') || !run) return getStatus();
    run.userStopped = true;
    run.stopped = true;
    run.paused = false;
    dropQueue(run);
    state = 'stopped';
    checkIdle(run);
    return getStatus();
  }

  function restore() {
    runId++; // cancel any in-flight translate/dynamic work: late answers are discarded
    lastLanguage = null;
    stopScrollWatch();
    if (observer) { observer.stop(); observer = null; }
    if (run) {
      run.stopped = true;
      run.queue.length = 0;
      run.idle.resolve();
      run = null;
    }
    queued = new WeakSet();
    const restored = store.restoreAll();
    state = 'restored';
    stats = emptyStats();
    explainLog = [];
    regions = [];
    return { ...getStatus(), restored };
  }

  function getStatus() {
    return {
      state,
      observing: Boolean(observer && observer.active),
      pending: pendingBlocks(),
      ...(() => {
        const { visible, background } = pendingSplit();
        // phase: what the scheduler is working on right now. visible = on-screen blocks first; background = the rest.
        return { pendingVisible: visible, pendingBackground: background, phase: visible ? 'visible' : background ? 'background' : 'idle' };
      })(),
      inflight: run ? run.active : 0,
      concurrency: run ? run.concurrency : 0,
      perf: perfSummary(),
      ...stats,
    };
  }

  const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : null);

  /** Timings for the current run (ms since the Translate click unless noted). Honest zeros/nulls until something happens. */
  function perfSummary() {
    if (!run) return null;
    const p = run.perf;
    const ms = p.requests.map((x) => x.ms).sort((a, b) => a - b);
    const perBlock = p.requests.map((x) => x.ms / Math.max(x.blocks, 1)).sort((a, b) => a - b);
    const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
    const requested = p.requests.reduce((n, x) => n + x.blocks, 0);
    return {
      cacheLookupMs: Math.round(p.lookupMs * 10) / 10, cacheLookups: p.lookupCalls,
      firstBlockMs: p.firstApplyMs, firstCachedBlockMs: p.firstCachedMs, firstFreshBlockMs: p.firstFreshMs,
      requests: p.requests.length, requestMsAvg: avg(ms), requestMsP95: pct(ms, 0.95),
      blockMsAvg: avg(perBlock), blockMsP95: pct(perBlock, 0.95), // request time divided by the unique blocks in it
      blocksRequested: requested,
      cacheHitRate: stats.cached + requested ? Math.round((stats.cached / (stats.cached + requested)) * 1000) / 1000 : null,
    };
  }

  /** Debug aid: why each text run was converted or skipped in the last scan(s). */
  function explain() {
    return explainLog.slice();
  }

  return { translate, restore, pause, resume, stop, getStatus, setObserve, explain };
}
