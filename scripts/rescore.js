// Re-scores a saved benchmark results file with the CURRENT scorer (no API calls, no cost).
//   node scripts/rescore.js benchmark/results/<file>.json
// Used to compare an old run to a new one under identical scoring rules.
import { readFile } from 'node:fs/promises';
import { scoreCase, summarize } from '../benchmark/score.js';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/rescore.js <results.json>'); process.exit(1); }
const cases = JSON.parse(await readFile(new URL('../benchmark/cases.json', import.meta.url), 'utf8'));
const saved = JSON.parse(await readFile(file, 'utf8'));
const rows = saved.rows.map((r) => ({ ...r, score: scoreCase(cases.find((c) => c.id === r.id), r.output ?? undefined) }));
console.log(JSON.stringify({
  source: file, originalPromptVersion: saved.report.promptVersion ?? 'hinglish-v1 (run predates version tagging)',
  ...summarize(rows),
  flagged: rows.filter((r) => r.score.linguistic.lints.length || !r.score.linguistic.termsKept || !r.score.linguistic.senseOk)
    .map((r) => ({ id: r.id, lints: r.score.linguistic.lints, missingTerms: r.score.linguistic.missingTerms })),
}, null, 2));
