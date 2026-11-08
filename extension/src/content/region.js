// Main-content detection.
//
// Page text is measured once (total / link / prose characters per container). Prose that sits in
// advertisements or peripheral furniture is discounted. Then:
//
//   1. pick the container with the most clean prose, weighted by prose density and link density;
//   2. "tighten": descend to the smallest container that still holds >= 65% of that prose, so a
//      wrapper that also contains promo boxes or footer text does not drag them in;
//   3. add further well-scored, non-overlapping containers (multi-column pages, several articles).
//
// Semantic tags (main/article) and content-ish names are only a mild boost, never a requirement.
// Dictionary entries are found structurally (a part-of-speech label next to a definition) because
// they hold too little text to win on density.

import { peripheralKind, attrTokens } from './ads.js';

const SHOW_ELEMENT = 1;
const SHOW_TEXT = 4;
const ACCEPT = 1;
const REJECT = 2;
const SKIP_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template']);
const SEMANTIC = 'main,article,[role="main"],[itemprop="articleBody"]';
const CONTENT_TOKENS = new Set(['content', 'article', 'post', 'entry', 'story', 'markdown', 'prose']);
const MIN_REGION_PROSE = 120;
const MAX_REGIONS = 8;
const TIGHTEN_RETAIN = 0.65;
const SECONDARY_REGION_RATIO = 0.4;
const SECONDARY_PROSE_RATIO = 0.5; // a second region must hold at least half as much prose as the main one
const PERIPHERAL_LINK_DENSITY = 0.35;
const WRAPPER_SHARE = 0.5;

/** Per-element text metrics for every element under root (characters). */
export function measure(root) {
  const metrics = new Map();
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, SHOW_ELEMENT | SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === 1 && SKIP_TEXT_TAGS.has(n.localName) ? REJECT : ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType !== 3) continue;
    const len = n.data.trim().length;
    if (!len) continue;
    let inLink = false;
    for (let el = n.parentElement; el; el = el.parentElement) {
      if (el.localName === 'a') inLink = true;
      let m = metrics.get(el);
      if (!m) metrics.set(el, (m = { total: 0, link: 0, prose: 0, clean: 0, runs: 0 }));
      m.total += len;
      if (inLink) m.link += len;
      if (el === root) break;
    }
  }
  return metrics;
}

function boost(el) {
  if (el.matches(SEMANTIC)) return 1.3;
  for (const t of attrTokens(el)) if (CONTENT_TOKENS.has(t)) return 1.15;
  return 1;
}

/**
 * Decides, for every locally-eligible item, whether it is main content. Mutates item.verdict.
 * hooks.knownRegions: regions from an earlier full scan (dynamic content).
 * Returns { regions: [{ el, kind: 'main' | 'dictionary' }] }.
 */
export function selectContent(items, root, hooks = {}) {
  const metrics = measure(root);
  const dynamic = Boolean(hooks.knownRegions);
  const metric = (el) => metrics.get(el);
  const climb = (host, fn) => {
    for (let el = host; el; el = el.parentElement) {
      const m = metric(el);
      if (m) fn(m);
      if (el === root) break;
    }
  };

  // 1. Ad containers inferred from "Advertisement"-style labels (needs total length only).
  const adContainers = [];
  for (const { run, verdict } of items) {
    if (verdict.reason !== 'ad-label') continue;
    let best = null;
    // The label's host is often the ad block itself (label is an inline child), so start there.
    let c = run.host;
    for (let i = 0; i < 3 && c && c !== root; i++, c = c.parentElement) {
      const m = metric(c);
      if (m && m.total <= 600) best = c;
    }
    if (best) adContainers.push(best);
  }
  const inAdContainer = (el) => adContainers.some((c) => c.contains(el));

  // 2. Prose volume (pass A, everything prose-like) -> used to recognise wrapper elements.
  let totalProse = 0;
  for (const { run, verdict } of items) {
    if (!verdict.eligible) continue;
    totalProse += run.plain.length;
    climb(run.host, (m) => { m.prose += run.plain.length; });
  }

  const kindMemo = new WeakMap();
  const effectiveKind = (el) => {
    let v = kindMemo.get(el);
    if (v === undefined) {
      v = peripheralKind(el);
      if (v && !dynamic && totalProse > 0 && ((metric(el) || {}).prose || 0) / totalProse >= WRAPPER_SHARE) v = null;
      kindMemo.set(el, v);
    }
    return v;
  };
  /** Nearest ancestor-or-self that is peripheral furniture, with its kind; null if none. */
  const weakRoot = (el) => {
    for (let a = el; a; a = a.parentElement) {
      const kind = effectiveKind(a);
      if (kind) return { el: a, kind };
    }
    return null;
  };

  // 3. Clean prose (pass B): discount ads and furniture so they cannot attract the region.
  for (const { run, verdict } of items) {
    if (!verdict.eligible || inAdContainer(run.host) || weakRoot(run.host)) continue;
    climb(run.host, (m) => { m.clean += run.plain.length; m.runs++; });
  }

  // 4. Choose regions.
  let regions = [];
  const known = dynamic ? hooks.knownRegions.find((r) => r.contains(root)) : null;
  if (known) {
    regions = [{ el: known, kind: 'main' }];
  } else {
    const candidates = [];
    for (const [el, m] of metrics) {
      if (m.clean < MIN_REGION_PROSE || inAdContainer(el)) continue;
      if (weakRoot(el) && !el.closest(SEMANTIC)) continue;
      const total = Math.max(m.total, 1);
      const density = m.clean / total;
      const linkDensity = Math.min(1, m.link / total);
      let score = m.clean * density * (1 - linkDensity) ** 2 * boost(el);
      if (peripheralKind(el)) score *= 0.5;
      candidates.push({ el, m, density, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    if (candidates.length) {
      let primary = candidates[0];
      for (;;) { // tighten
        const inner = candidates.filter((c) => c !== primary && primary.el.contains(c.el) &&
          c.m.clean >= TIGHTEN_RETAIN * primary.m.clean && (c.m.runs >= 2 || primary.m.runs < 2) &&
          c.density >= primary.density * 0.7);
        if (!inner.length) break;
        inner.sort((a, b) => b.density - a.density || a.m.total - b.m.total);
        primary = inner[0];
      }
      regions.push({ el: primary.el, kind: 'main' });
      // Largest prose first, so a container is taken before the paragraphs inside it.
      for (const c of [...candidates].sort((a, b) => b.m.clean - a.m.clean)) {
        if (regions.length >= MAX_REGIONS) break;
        if (c.score < primary.score * SECONDARY_REGION_RATIO || c.m.clean < primary.m.clean * SECONDARY_PROSE_RATIO) continue;
        if (regions.some((r) => r.el.contains(c.el) || c.el.contains(r.el))) continue;
        regions.push({ el: c.el, kind: 'main' });
      }
    }
    // Dictionary entries: nearest ancestor of a part-of-speech label that holds prose.
    for (const { run, verdict } of items) {
      if (verdict.reason !== 'dictionary-label') continue;
      let c = run.host.parentElement;
      while (c && !((metric(c) || {}).prose > 0)) { if (c === root) { c = null; break; } c = c.parentElement; }
      if (c && !inAdContainer(c) && !regions.some((r) => r.kind === 'dictionary' && r.el === c)) {
        regions.push({ el: c, kind: 'dictionary' });
      }
    }
  }

  // 5. Final per-item decision.
  const regionOf = (el) => regions.find((r) => r.kind === 'dictionary' && r.el.contains(el))
    || regions.find((r) => r.el.contains(el));
  const cardLike = (host, region) => {
    if (host.closest('figure')) return false; // image captions are content, not teaser cards
    for (let c = host, d = 0; c && d < 4 && c !== root && (!region || c !== region.el); c = c.parentElement, d++) {
      const m = metric(c);
      if (m && m.total <= 350 && m.link / m.total >= 0.2 && c.querySelector('a[href]') &&
        c.querySelector('img,picture,video')) return true;
    }
    return false;
  };

  for (const item of items) {
    const { run, verdict } = item;
    if (!verdict.eligible || item.handled) continue;
    const host = run.host;
    const reject = (reason) => { item.verdict = { eligible: false, reason }; };

    if (inAdContainer(host)) { reject('ad-container'); continue; }
    const weak = weakRoot(host);
    const region = regionOf(host);

    if (regions.length === 0) {
      if (dynamic) reject('outside-main'); // small insert outside any known content region
      else if (weak) reject('peripheral');
      else if (cardLike(host, null)) reject('card');
      else item.verdict = { ...verdict, reason: 'prose-no-region' };
      continue;
    }
    if (!region) { reject('outside-main'); continue; }
    if (weak && weak.el !== region.el && region.el.contains(weak.el)) {
      const m = metric(weak.el);
      const linky = !m || m.link / Math.max(m.total, 1) >= PERIPHERAL_LINK_DENSITY;
      if (weak.kind === 'ui' || linky) { reject('peripheral'); continue; }
    }
    if (cardLike(host, region)) { reject('card'); continue; }
    item.verdict = { ...verdict, reason: region.kind === 'dictionary' ? 'dictionary' : 'main-content' };
  }

  return { regions };
}
