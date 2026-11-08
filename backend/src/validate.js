import { parseConverted, visibleText } from '../../extension/src/shared/tokens.js';

// Server-side checks on a model answer, run BEFORE anything is returned to the extension. The
// extension validates the placeholders again before touching the DOM (defence in depth).

const DEVANAGARI = /[ऀ-ॿ]/;
const TAMIL_SCRIPT = /[஀-௿]/; // U+0B80-0BFF
const NUMBER = /\d+(?:[.,]\d+)*/g;
const ACRONYM = /\b[A-Z][A-Z0-9]+\b/g;
const URL_OR_EMAIL = /(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;
const CHATTER = /^\s*(sure|here(?:'s| is| are)|certainly|translation:|hinglish:|tanglish:)/i;
const LENGTH_RATIO = [0.45, 2.6];
const TANGLISH_RATIO = [0.45, 3.4];
const SHORT_RATIO = [0.3, 4.5]; // a word or a short phrase legitimately changes length a lot ("Yes" -> "Haan, bilkul")
const SHORT_CHARS = 25;

const countOf = (list) => list.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());

function missing(inputList, outputText) {
  const need = countOf(inputList);
  const have = countOf(outputText.match(NUMBER) || []);
  return [...need].some(([k, n]) => (have.get(k) || 0) < n);
}

/**
 * item: { id, text (template), source (Map from sourceFromTemplate) }; output: model string.
 * Returns { ok: true } or { ok: false, issue } where issue is a short machine-readable reason that is
 * also sent back to the model on the repair pass.
 */
export function validateItem(item, output, lang = 'hinglish') {
  if (typeof output !== 'string' || !output.trim()) return { ok: false, issue: 'empty output' };
  // Both targets are Roman script only: neither Devanagari nor Tamil script may appear in either mode.
  if (DEVANAGARI.test(output)) return { ok: false, issue: 'contains Devanagari script; use Roman script only' };
  if (TAMIL_SCRIPT.test(output)) return { ok: false, issue: 'contains Tamil script; use Roman (English) letters only' };
  // "Sure" / "Here is" at the start is commentary, unless the source itself starts that way ("Sure thing", "Here is the list").
  const chatter = CHATTER.exec(output);
  if (chatter && !visibleText(item.text).toLowerCase().startsWith(chatter[1].toLowerCase())) return { ok: false, issue: 'contains commentary; output only the rewritten text' };
  if (!parseConverted(output, item.source)) {
    return { ok: false, issue: 'placeholder tokens do not match the input: keep every token exactly once, paired tokens paired, and nested tokens nested' };
  }

  const before = visibleText(item.text);
  const after = visibleText(output);
  const ratio = after.length / Math.max(before.length, 1);
  // Romanised Tamil is agglutinative and spelled out in full ("pannikkum", "irundhu"), so it runs longer than Hinglish.
  const [lo, hi] = before.length < SHORT_CHARS ? SHORT_RATIO : lang === 'tanglish' ? TANGLISH_RATIO : LENGTH_RATIO;
  if (ratio < lo || ratio > hi) return { ok: false, issue: 'length is implausible: do not summarise or add content' };

  if (missing(before.match(NUMBER) || [], after)) return { ok: false, issue: 'numbers must be kept exactly as in the input' };
  const acronyms = before.match(ACRONYM) || [];
  if (acronyms.some((a) => !after.includes(a))) return { ok: false, issue: 'acronyms must be kept exactly as in the input' };
  const urls = before.match(URL_OR_EMAIL) || [];
  if (urls.some((u) => !after.includes(u))) return { ok: false, issue: 'URLs and emails must be kept exactly' };

  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  if (before.split(' ').length >= 8 && norm(before) === norm(after)) return { ok: false, issue: 'text was returned unchanged; rewrite it in Hinglish' };
  return { ok: true };
}
