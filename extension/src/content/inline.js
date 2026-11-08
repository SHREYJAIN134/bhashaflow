// Inline-markup handling.
//
// A "run" is a maximal sequence of sibling nodes (text + inline elements) inside a host element,
// e.g. the whole sentence of <p>Machine learning is a <a>branch</a> of <b>AI</b>.</p>.
// It is sent to the converter as ONE template string where inline elements become tokens:
//
//   wrapper  <a>..</a>   ->  ⟦1⟧..⟦/1⟧     (children are converted, element itself is reused)
//   atomic   <code>x</code> / <img> / <br>  ->  ⟦2=x⟧  (must come back untouched)
//
// The converted string is validated against the source map before ANY DOM change is made.
// Original elements are reused (never cloned), so links, listeners and attributes survive.

import { T_OPEN, T_CLOSE, parseConverted } from '../shared/tokens.js';

export { parseConverted };

const INLINE_TAGS = new Set([
  'a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'cite', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins',
  'mark', 'nobr', 'q', 's', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'u',
]);
const ATOMIC_TAGS = new Set([
  'code', 'kbd', 'samp', 'var', 'tt', 'img', 'br', 'wbr', 'svg', 'math', 'input', 'button', 'select', 'textarea',
  'label', 'picture', 'video', 'audio', 'canvas', 'iframe', 'object', 'embed',
]);

/** kind: 'inline' (wrapper with convertible text) | 'atomic' (kept verbatim) | 'boundary' (ends a run). */
export function classifyChild(el, ctx) {
  let kind = ctx.kinds.get(el);
  if (kind) return kind;
  const tag = el.localName;
  if (ctx.isAd(el)) kind = 'boundary';
  else if (ATOMIC_TAGS.has(tag)) kind = 'atomic';
  else if (INLINE_TAGS.has(tag)) {
    if (ctx.isProtected(el)) kind = 'atomic';
    else if (!el.textContent.trim()) kind = 'atomic'; // icon-only anchors, empty spans
    else kind = descendantsAreInline(el, ctx) ? 'inline' : 'boundary';
  } else kind = 'boundary';
  ctx.kinds.set(el, kind);
  return kind;
}

function descendantsAreInline(el, ctx) {
  for (const child of el.childNodes) {
    if (child.nodeType === 3) continue;
    if (child.nodeType !== 1) return false; // comments/PIs inside would be lost
    if (classifyChild(child, ctx) === 'boundary') return false;
  }
  return true;
}

const CODE_TAGS = new Set(['code', 'kbd', 'samp', 'var', 'tt']);
const MEDIA_TAGS = new Set(['img', 'picture', 'svg', 'math', 'video', 'audio', 'canvas', 'iframe', 'object', 'embed']);
const UI_TAGS = new Set(['input', 'button', 'select', 'textarea', 'label']);

/** Only the KIND of a protected inline element is ever sent to the converter, never its content. */
function atomKind(el) {
  const tag = el.localName;
  if (CODE_TAGS.has(tag)) return 'code';
  if (MEDIA_TAGS.has(tag)) return 'img';
  if (tag === 'br' || tag === 'wbr') return 'br';
  if (UI_TAGS.has(tag)) return 'ui';
  if (el.matches('[lang|="hi"]') || /[ऀ-ॿ]/.test(el.textContent)) return 'hi';
  return 'x';
}

function makeRun(host, nodes, ctx) {
  const source = new Map(); // id -> { el, kind: 'wrap' | 'atomic', parent }
  let nextId = 0;
  let plain = '';
  let linkLen = 0;
  let collision = false;

  const walk = (list, parentId, inLink) => {
    let out = '';
    for (const node of list) {
      if (node.nodeType === 3) {
        if (/[⟦⟧]/.test(node.data)) collision = true;
        const text = node.data.replace(/\s+/g, ' ');
        out += text;
        plain += text;
        if (inLink) linkLen += text.trim().length;
        continue;
      }
      const id = ++nextId;
      if (classifyChild(node, ctx) === 'atomic') {
        source.set(id, { el: node, kind: 'atomic', parent: parentId });
        out += `${T_OPEN}${id}=${atomKind(node)}${T_CLOSE}`;
      } else {
        source.set(id, { el: node, kind: 'wrap', parent: parentId });
        out += `${T_OPEN}${id}${T_CLOSE}${walk(node.childNodes, id, inLink || node.localName === 'a')}${T_OPEN}/${id}${T_CLOSE}`;
      }
    }
    return out;
  };

  const template = walk(nodes, 0, false).replace(/\s+/g, ' ').trim();
  plain = plain.replace(/\s+/g, ' ').trim();
  if (!plain) return null;
  return { host, nodes, template, plain, linkLen, source, collision, heading: '' };
}

/** Splits a host's children into runs, ending a run at every block-level child or comment. */
export function buildRuns(host, ctx) {
  const runs = [];
  let current = [];
  const flush = () => {
    if (current.length) {
      const run = makeRun(host, current, ctx);
      if (run) runs.push(run);
      current = [];
    }
  };
  for (const node of host.childNodes) {
    if (node.nodeType === 3) current.push(node);
    else if (node.nodeType === 1 && classifyChild(node, ctx) !== 'boundary') current.push(node);
    else flush();
  }
  flush();
  return runs;
}

/** True when `el` is rendered inside its parent's run, so it must not be scanned as a host itself. */
export function isInlineChild(el, ctx) {
  return classifyChild(el, ctx) !== 'boundary';
}

