import { classifyRun, isProtectedSubtree, HEADINGS } from './classifier.js';
import { isAdSubtree } from './ads.js';
import { buildRuns, isInlineChild } from './inline.js';
import { selectContent } from './region.js';

// TreeWalker constants (numeric so the module does not depend on a global NodeFilter).
const SHOW_ELEMENT = 1;
const FILTER_ACCEPT = 1;
const FILTER_REJECT = 2;

function makeContext(opts) {
  const ctx = {
    kinds: new WeakMap(),
    isAd: isAdSubtree,
    isProtected: (el) => isProtectedSubtree(el, opts),
  };
  return ctx;
}

/** True if any ancestor of `el` is protected or an ad (needed when scanning an inserted subtree). */
function ancestorBlocked(el, ctx) {
  for (let a = el.parentElement; a; a = a.parentElement) {
    if (ctx.isAd(a) || ctx.isProtected(a)) return true;
  }
  return false;
}

/**
 * Walks `root`, pruning protected and advertisement subtrees, and returns one item per text run:
 * { run, verdict } where verdict is the text-level classification (see classifyRun).
 * `hooks.isOwn(node)` excludes runs we already converted.
 */
export function scan(root, opts, hooks = {}) {
  const isOwn = hooks.isOwn || (() => false);
  const ctx = makeContext(opts);
  const items = [];
  const stats = { prunedAds: 0, prunedProtected: 0, handled: 0 };
  if (ctx.isAd(root) || ctx.isProtected(root) || ancestorBlocked(root, ctx)) return { items, stats, ctx };

  let heading = '';
  const collect = (host) => {
    for (const run of buildRuns(host, ctx)) {
      if (isOwn(run.nodes[0])) {
        // Already converted: kept as an item so region maths stays identical across rescans.
        stats.handled++;
        items.push({ run, verdict: { eligible: true, reason: 'handled' }, handled: true });
        continue;
      }
      run.heading = heading;
      items.push({ run, verdict: classifyRun(run, opts) });
    }
  };

  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, SHOW_ELEMENT, {
    acceptNode: (el) => {
      if (ctx.isAd(el)) { stats.prunedAds++; return FILTER_REJECT; }
      if (isProtectedSubtree(el, opts)) {
        if (el.matches(HEADINGS)) heading = el.textContent.replace(/\s+/g, ' ').trim().slice(0, 120);
        stats.prunedProtected++;
        return FILTER_REJECT;
      }
      return isInlineChild(el, ctx) ? FILTER_REJECT : FILTER_ACCEPT;
    },
  });

  collect(root);
  for (let el = walker.nextNode(); el; el = walker.nextNode()) collect(el);
  return { items, stats, ctx };
}

/** Full pipeline: scan, then decide which eligible runs are main content. */
export function findContent(root, opts, hooks = {}) {
  const { items, stats } = scan(root, opts, hooks);
  const { regions } = selectContent(items, root, hooks);
  return { items, regions, stats };
}
