// Context-preserving sentence groups for blocks too long to send as one unit. Pure: no DOM.
//
// A block is the translation unit; this is only used when a block is longer than the request size limit.
// The block is cut ONLY at sentence ends that sit outside every ⟦n⟧…⟦/n⟧ pair, so each group is a complete,
// valid template on its own (links and bold spans never straddle a cut) and consecutive sentences stay
// together in one group. The caller translates the groups and joins the answers in order.

const TOKEN = /⟦(\/?)(\d+)(?:=[^⟧]*)?⟧/g;
const SENTENCE_END = /([.!?]["'”’)\]]*)(\s+)(?=\S)/g;
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'dr', 'mr', 'mrs', 'ms', 'prof', 'fig', 'no', 'approx', 'inc', 'ltd']);
const SENTENCE_START = /[A-Z0-9"'“(⟦]/;

/** Index -> wrapper depth, for the positions where a cut could happen. */
function depthTable(template) {
  const events = [];
  for (const m of template.matchAll(TOKEN)) {
    const isAtomic = m[0].includes('=');
    if (isAtomic) continue;
    events.push([m.index, m[1] === '/' ? -1 : 1]);
  }
  return (index) => events.reduce((d, [at, delta]) => (at < index ? d + delta : d), 0);
}

/** Sentences of a template, each a valid template; null when there is nothing safe to cut at. */
export function sentencesOf(template) {
  const depthAt = depthTable(template);
  const cuts = [];
  for (const m of template.matchAll(SENTENCE_END)) {
    const end = m.index + m[1].length; // right after the sentence's punctuation
    const next = template.slice(end + m[2].length);
    if (!SENTENCE_START.test(next[0])) continue; // "e.g. the" / "3.5 mm": not a sentence start
    const word = template.slice(0, m.index + 1).match(/([A-Za-z.]+)$/)?.[1].replace(/\.$/, '').toLowerCase() ?? '';
    if (ABBREVIATIONS.has(word) || /^[a-z]$/i.test(word)) continue; // abbreviations and initials
    if (depthAt(end) !== 0) continue; // inside a link / bold span: cutting would split a token pair
    cuts.push([end, end + m[2].length]);
  }
  if (!cuts.length) return null;
  const out = [];
  let from = 0;
  for (const [end, next] of cuts) { out.push(template.slice(from, end)); from = next; }
  out.push(template.slice(from));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Groups consecutive sentences into parts of at most `maxChars` characters (a single longer sentence stays
 * whole). Returns null when the block cannot be split or would not need to be.
 */
export function splitIntoGroups(template, maxChars) {
  if (template.length <= maxChars) return null;
  const sentences = sentencesOf(template);
  if (!sentences || sentences.length < 2) return null;
  const parts = [];
  let current = '';
  for (const s of sentences) {
    if (current && current.length + 1 + s.length > maxChars) { parts.push(current); current = s; } else current = current ? `${current} ${s}` : s;
  }
  if (current) parts.push(current);
  return parts.length > 1 ? parts : null;
}
