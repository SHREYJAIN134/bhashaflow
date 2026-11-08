import { sourceFromTemplate } from '../extension/src/shared/tokens.js';
import { validateItem } from '../backend/src/validate.js';

// Two kinds of checks, kept apart on purpose:
//
//  STRUCTURAL  (hard pass/fail) - exactly the production validator: placeholder tokens, numbers,
//              acronyms, URLs, no Devanagari, plausible length, not returned unchanged. These guard the
//              page and are never loosened to improve a score.
//  LINGUISTIC  (automatic, partial) - required terms, word-sense, and "lint" detectors for known
//              defect classes. They measure part of quality; meaning, fluency and naturalness still
//              need a human or judge.

const lower = (s) => s.toLowerCase();
// Acronyms and mixed-case names (REST API, PostgreSQL) must match exactly; plain terms ignore case.
const exactCase = (term) => (term === term.toUpperCase() && /[A-Z]/.test(term)) || /[a-z][A-Z]/.test(term);

/** "Newton's second law" is also satisfied by "Newton ka/ke/ki second law" or "Newton second law". */
function variants(term) {
  const m = term.match(/^(.*?)([\w-]+)'s\s+(.*)$/);
  if (!m) return [term];
  const [, pre, owner, rest] = m;
  return [term, ...['ka', 'ke', 'ki', 'ko'].map((p) => `${pre}${owner} ${p} ${rest}`), `${pre}${owner} ${rest}`];
}
const has = (output, term) => variants(term).some((v) => (exactCase(v) ? output.includes(v) : lower(output).includes(lower(v))));

// Heuristic detectors for defect classes seen in real model output. A hit is a flag for review,
// not proof of an error, and a clean result is not proof of good Hinglish.
export const LINTS = [
  { id: 'formal-imperative', re: /\b(karein|kijiye|kijiyega|dekhein|dekhiye|padhein|padhiye|samjhein|samjhiye|likhein|likhiye|chalayein|chaliye|banayein|banaiye|lagayein|rakhein|chunein|jodein|hatayein)\b/gi },
  { id: 'literal-passive', re: /\b(ki|kiya|kiye)\s+(ja\s+rah[aie]|jaa?t[aie]|jaa?yega|ja\s+sakt[aie])\b/gi },
  { id: 'repeated-phrase', re: /\b(\w{2,})\s+(?:ka|ki|ke|ko)\s+\1\b|\b(\w{3,})\s+\2\b/gi },
  { id: 'gender-mismatch', re: /\baisi\s+(?:model|event|events|process|program|server|algorithm|network|dataset|result|results)\b|\baisa\s+(?:memory|information|accuracy|file|performance|events|results)\b/gi },
  { id: 'malformed-postposition', re: /\bjispar\b/gi },
];

function lint(output) {
  const hits = [];
  for (const { id, re } of LINTS) {
    for (const m of output.matchAll(re)) hits.push({ id, text: m[0] });
  }
  return hits;
}

export function scoreCase(testCase, output) {
  const source = sourceFromTemplate(testCase.text);
  const verdict = typeof output === 'string'
    ? validateItem({ id: 0, text: testCase.text, source }, output)
    : { ok: false, issue: 'no output' };
  const raw = typeof output === 'string' ? output : '';
  const text = lower(raw);

  const missingTerms = (testCase.mustKeep || []).filter((t) => !has(raw, t));
  const senseHit = testCase.senseAny ? testCase.senseAny.some((s) => text.includes(s)) : true;
  const forbidHit = (testCase.forbidAny || []).filter((s) => text.includes(s));
  const lints = raw ? lint(raw) : [];

  const structural = { ok: verdict.ok, issue: verdict.ok ? null : verdict.issue };
  const linguistic = {
    termsKept: missingTerms.length === 0, missingTerms,
    senseOk: senseHit && forbidHit.length === 0, forbidHit,
    lints,
  };
  // Flat aliases keep older callers working.
  return { structural, linguistic, valid: structural.ok, issue: structural.issue,
    termsKept: linguistic.termsKept, missingTerms, senseOk: linguistic.senseOk, forbidHit, lints };
}

const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);

export function summarize(rows) {
  const cats = {};
  const lintCounts = {};
  let valid = 0; let terms = 0; let sense = 0; let flaggedRows = 0;
  for (const r of rows) {
    const c = (cats[r.category] ||= { n: 0, valid: 0, terms: 0, sense: 0 });
    c.n++;
    c.valid += r.score.structural.ok ? 1 : 0;
    c.terms += r.score.linguistic.termsKept ? 1 : 0;
    c.sense += r.score.linguistic.senseOk ? 1 : 0;
    valid += r.score.structural.ok ? 1 : 0;
    terms += r.score.linguistic.termsKept ? 1 : 0;
    sense += r.score.linguistic.senseOk ? 1 : 0;
    if (r.score.linguistic.lints.length) flaggedRows++;
    for (const l of r.score.linguistic.lints) lintCounts[l.id] = (lintCounts[l.id] || 0) + 1;
  }
  const n = rows.length;
  return {
    structural: { validPct: pct(valid, n), byCategory: Object.fromEntries(Object.entries(cats).map(([k, c]) => [k, pct(c.valid, c.n)])) },
    linguistic: {
      termsPct: pct(terms, n), sensePct: pct(sense, n), lintFlaggedCases: flaggedRows, lintCounts,
      byCategory: Object.fromEntries(Object.entries(cats).map(([k, c]) => [k, { termsPct: pct(c.terms, c.n), sensePct: pct(c.sense, c.n) }])),
    },
  };
}
