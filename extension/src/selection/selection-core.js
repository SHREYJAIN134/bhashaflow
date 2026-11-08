// Selected-text translation: reading a selection safely, planning requests, and running them. No UI here.
// The page is only ever READ (a cloned copy of the selected range); nothing in it is changed.

import { takeBatch, BATCH_LIMITS } from '../content/batching.js';
import { splitIntoGroups } from '../content/sentence-groups.js';

export const MAX_SELECTION_CHARS = 2000;

// Selections that start/end in, or are made entirely inside, these are never translated: form controls and rich-text
// editors (what the user is typing), password fields, code editors and preformatted code blocks.
const PROTECTED = [
  'input', 'textarea', 'select', '[contenteditable]:not([contenteditable="false"])', '[role="textbox"]', '[role="searchbox"]',
  '[role="combobox"]', '.CodeMirror', '.cm-editor', '.monaco-editor', '.ace_editor', '.ProseMirror', '.ql-editor', '.tox-edit-area',
  '[data-lexer]', 'pre', '[data-bf-ignore]',
].join(',');
const INLINE_CODE = 'code, kbd, samp'; // only protected when the WHOLE selection sits inside one
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe']);
const BLOCK_TAGS = new Set(['p', 'div', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'tr', 'table', 'blockquote', 'section', 'article', 'header',
  'footer', 'aside', 'main', 'figure', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr', 'details', 'summary']);

const elementOf = (node) => (!node ? null : node.nodeType === 1 ? node : node.parentElement);
const within = (node, selector) => { const el = elementOf(node); return Boolean(el && el.closest(selector)); };

/** Text of a cloned range, with a newline at every block boundary and protected descendants left out. */
export function extractText(fragment) {
  const out = [];
  const walk = (node) => {
    if (node.nodeType === 3) { out.push(node.data); return; }
    if (node.nodeType === 1) {
      const name = node.localName;
      if (SKIP_TAGS.has(name) || node.hasAttribute('hidden')) return;
      if (node.matches(PROTECTED)) { out.push('\n'); return; }
      const block = BLOCK_TAGS.has(name);
      if (block) out.push('\n');
      for (const child of node.childNodes) walk(child);
      if (block) out.push('\n');
      return;
    }
    for (const child of node.childNodes) walk(child); // document fragment
  };
  walk(fragment);
  return out.join('');
}

function rectOf(range) {
  try {
    const list = range.getClientRects ? [...range.getClientRects()] : [];
    const r = list.length ? list[list.length - 1] : range.getBoundingClientRect && range.getBoundingClientRect();
    if (r && Number.isFinite(r.bottom)) return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  } catch { /* no layout (tests) */ }
  return null;
}

/**
 * The current selection as { text, rect, range }, or { reason }: 'empty' | 'protected' | 'own-ui'.
 * `ownHosts` are our own UI elements; a selection made inside them is ignored.
 */
export function readSelection(win, ownHosts = []) {
  const doc = win.document;
  const sel = win.getSelection && win.getSelection();
  if (!sel || sel.rangeCount === 0) return { reason: 'empty' };
  for (const host of ownHosts) if (host && (host === sel.anchorNode || host.contains(sel.anchorNode) || host.contains(sel.focusNode))) return { reason: 'own-ui' };
  const active = doc.activeElement;
  if (active && active !== doc.body && !ownHosts.includes(active) && active.matches && active.matches(PROTECTED)) return { reason: 'protected' };
  if (sel.isCollapsed) return { reason: 'empty' };
  const range = sel.getRangeAt(0);
  if (within(sel.anchorNode, PROTECTED) || within(sel.focusNode, PROTECTED) || within(range.commonAncestorContainer, PROTECTED)) return { reason: 'protected' };
  if (within(range.commonAncestorContainer, INLINE_CODE)) return { reason: 'protected' };
  const text = extractText(range.cloneContents());
  if (!/[\p{L}\p{N}]/u.test(text)) return { reason: 'empty' };
  return { text, rect: rectOf(range), range };
}

// ---------------------------------------------------------------------------------------------- planning

const err = (code, message) => ({ error: { code, message } });
export class SelectionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * Raw selected text -> blocks (one per line / paragraph) and the unique pieces that must be translated.
 * Blocks without Latin letters (numbers, symbols, existing Hindi) pass through untouched. A block longer than the
 * request limit is cut into groups of whole sentences. Returns { blocks, units } or { error }.
 */
export function planSelection(raw, limits = BATCH_LIMITS) {
  const cleaned = String(raw || '').replace(/[⟦⟧]/g, ' ').replace(/\r/g, '');
  const lines = cleaned.split('\n').map((l) => l.replace(/[ \t\f\v ]+/g, ' ').trim()).filter(Boolean);
  if (!lines.length) return err('empty', 'Select some text first.');
  const total = lines.reduce((n, l) => n + l.length, 0);
  if (total > MAX_SELECTION_CHARS) return err('too-long', `That selection is ${total.toLocaleString('en')} characters. Select up to ${MAX_SELECTION_CHARS.toLocaleString('en')} at a time.`);

  const blocks = [];
  for (const text of lines) {
    if (!/[A-Za-z]/.test(text)) { blocks.push({ text, passthrough: true, parts: [] }); continue; }
    let parts = [text];
    if (text.length > limits.maxItemChars) {
      parts = splitIntoGroups(text, limits.maxItemChars);
      if (!parts || parts.some((p) => p.length > limits.maxItemChars)) return err('too-long', 'This passage is too long to translate in one piece. Select a shorter part.');
    }
    blocks.push({ text, passthrough: false, parts });
  }
  const units = [...new Set(blocks.flatMap((b) => b.parts))];
  if (!units.length) return err('nothing-to-translate', 'There is no English text in this selection.');
  return { blocks, units };
}

/** The finished text, or (partial) the text of the leading blocks whose pieces are all done. */
export function assemble(plan, results, partial = false) {
  const lines = [];
  for (const b of plan.blocks) {
    if (b.passthrough) { lines.push(b.text); continue; }
    const done = b.parts.map((p) => results.get(p));
    if (done.some((d) => d === undefined)) { if (partial) break; continue; }
    lines.push(done.join(' '));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------------------------- errors

/** User-facing text for an error code from the worker/backend ("provider-" prefix ignored). */
export function friendlyError(code, message) {
  const c = String(code || '').replace(/^provider-/, '');
  switch (c) {
    case 'ollama-not-running':
    case 'ollama-model-missing':
    case 'quota-exhausted':
      return message || 'The AI model is not available.';
    case 'unreachable':
      return 'The BhashaFlow backend is not running. Start it with "npm run backend", then try again.';
    case 'timeout':
      return 'The model took too long to answer. Try again, or select less text.';
    case 'bad-json': case 'invalid-output': case 'truncated': case 'empty-response': case 'bad-response': case 'missing-result': case 'placeholder-mismatch':
      return 'The model gave an unusable answer. Try again.';
    case 'rate-limit': case 'rate-limited':
      return 'The AI provider is busy. Wait a moment and try again.';
    default:
      return message && c !== 'internal' ? message : 'Translation failed. Try again.';
  }
}

// ---------------------------------------------------------------------------------------------- running

const CONTEXT = { pageTitle: '', heading: '', tag: 'p', role: 'selection' }; // selections send no page title, heading or URL; the role picks the compact prompt and keeps their cache entries apart

/** Caps from the backend's hints: a local model gets small requests. They can only lower the defaults. */
export function limitsFromHints(hints = {}) {
  const b = (hints && hints.batch) || {};
  return {
    maxItems: Math.min(BATCH_LIMITS.maxItems, b.maxItems || Infinity),
    maxChars: Math.min(BATCH_LIMITS.maxChars, b.maxChars || Infinity),
    maxItemChars: Math.min(BATCH_LIMITS.maxItemChars, b.maxItemChars || Infinity),
  };
}

/**
 * Saved translations first (one cache-only lookup, no model request), then the rest in small requests, up to `concurrency`
 * at a time (1 for a local model; a hosted model answers several at once, which is what keeps a long selection fast).
 * onProgress(partialText) after each step. isCancelled() lets a newer selection or Close abandon the work.
 * Resolves { text, fromCache, requests } or throws SelectionError.
 */
export async function translatePlan(plan, { converter, limits = BATCH_LIMITS, concurrency = 1, lang, onProgress = () => {}, isCancelled = () => false }) {
  const results = new Map();
  const asItems = (texts) => texts.map((text, id) => ({ id, text, context: CONTEXT }));

  if (typeof converter.lookup === 'function') {
    let hits = [];
    try { hits = await converter.lookup(asItems(plan.units), { sendContext: false, lang }); } catch { hits = []; }
    for (const h of Array.isArray(hits) ? hits : []) {
      const text = h && Number.isInteger(h.id) ? plan.units[h.id] : undefined;
      if (text !== undefined && typeof h.hinglish === 'string' && h.hinglish.trim()) results.set(text, h.hinglish);
    }
    if (results.size) onProgress(assemble(plan, results, true));
  }

  const queue = plan.units.filter((u) => !results.has(u));
  let requests = 0;
  let failure = null; // the first failure; requests already in flight finish, nothing new starts
  const worker = async () => {
    while (queue.length && !failure) {
      if (isCancelled()) return;
      const batch = takeBatch(queue, limits, (t) => t.length);
      let reply;
      requests++;
      try {
        reply = await converter.convert(asItems(batch), { sendContext: false, useCache: true, lang });
      } catch (e) {
        failure = failure || new SelectionError(e && e.code, e && e.message);
        return;
      }
      if (isCancelled()) return;
      const seen = new Set();
      for (const r of Array.isArray(reply) ? reply : []) {
        if (!r || !Number.isInteger(r.id) || r.id < 0 || r.id >= batch.length || seen.has(r.id)) continue;
        seen.add(r.id);
        if (r.error) { failure = failure || new SelectionError(r.error.code, r.error.message); return; }
        if (typeof r.hinglish !== 'string' || !r.hinglish.trim()) { failure = failure || new SelectionError('bad-response'); return; }
        results.set(batch[r.id], r.hinglish);
      }
      if (seen.size < batch.length) { failure = failure || new SelectionError('missing-result'); return; }
      onProgress(assemble(plan, results, true));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, Math.ceil(queue.length / 1))) }, worker));
  if (isCancelled()) return null;
  if (failure) throw failure;
  return { text: assemble(plan, results), fromCache: requests === 0, requests };
}
