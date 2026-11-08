// Placeholder-token protocol shared by the extension (builds/applies templates) and the backend
// (validates what the model returns). Pure functions: no DOM, no Chrome APIs.
//
//   wrapper  ⟦1⟧...⟦/1⟧   inline element whose text is rewritten (link, bold...)
//   atomic   ⟦2=code⟧       inline element that must come back untouched; only its KIND is sent
//
// Atomic payloads are limited to ATOM_KINDS so protected content (code, Hindi spans, UI text) never
// has to leave the browser.

export const T_OPEN = '⟦';
export const T_CLOSE = '⟧';
export const ATOM_KINDS = new Set(['code', 'img', 'br', 'ui', 'hi', 'x']);
const TOKEN_SOURCE = '\\u27E6(\\/?)(\\d+)(?:=([^\\u27E7]*))?\\u27E7';
const BRACKET = /[⟦⟧]/;

/**
 * Builds the id -> { kind, parent } map from a template string. Returns null if the template is
 * malformed (unbalanced, duplicate ids, unknown atom kind).
 */
export function sourceFromTemplate(template) {
  const re = new RegExp(TOKEN_SOURCE, 'g');
  const source = new Map();
  const stack = [0];
  let m;
  while ((m = re.exec(template))) {
    const id = Number(m[2]);
    if (m[1] === '/') {
      if (stack[stack.length - 1] !== id || stack.length === 1) return null;
      stack.pop();
      continue;
    }
    if (source.has(id)) return null;
    const parent = stack[stack.length - 1];
    if (m[3] !== undefined) {
      if (!ATOM_KINDS.has(m[3])) return null;
      source.set(id, { kind: 'atomic', parent });
    } else {
      source.set(id, { kind: 'wrap', parent });
      stack.push(id);
    }
  }
  return stack.length === 1 ? source : null;
}

/** Text with every token removed (what a reader sees, minus protected inline elements). */
export function visibleText(template) {
  return template.replace(new RegExp(TOKEN_SOURCE, 'g'), '').replace(/\s+/g, ' ').trim();
}

/**
 * Parses a converted template. Returns a tree or null when it is not a faithful rearrangement of
 * the source: unknown/duplicate/missing ids, bad nesting, or an element moved to a different parent.
 * Sibling order may change (Hinglish word order differs from English).
 */
export function parseConverted(str, source) {
  const re = new RegExp(TOKEN_SOURCE, 'g');
  const root = { id: 0, children: [] };
  const stack = [root];
  const seen = new Set();
  let last = 0;

  const pushText = (text) => {
    if (!text) return true;
    if (BRACKET.test(text)) return false;
    stack[stack.length - 1].children.push({ text });
    return true;
  };

  let m;
  while ((m = re.exec(str))) {
    if (!pushText(str.slice(last, m.index))) return null;
    last = re.lastIndex;
    const closing = m[1] === '/';
    const id = Number(m[2]);
    const src = source.get(id);
    if (!src) return null;
    const top = stack[stack.length - 1];
    if (closing) {
      if (top.id !== id) return null;
      stack.pop();
      continue;
    }
    if (seen.has(id) || src.parent !== top.id) return null;
    seen.add(id);
    if (m[3] !== undefined) {
      if (src.kind !== 'atomic') return null;
      top.children.push({ id, atomic: true });
    } else {
      if (src.kind !== 'wrap') return null;
      const node = { id, children: [] };
      top.children.push(node);
      stack.push(node);
    }
  }
  if (!pushText(str.slice(last))) return null;
  if (stack.length !== 1 || seen.size !== source.size) return null;
  if (!root.children.some((c) => c.text && c.text.trim()) && !root.children.some((c) => c.children)) return null;
  return root;
}
