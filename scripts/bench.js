// Runs benchmark/cases.json through the real engine with a chosen provider and prompt version.
//   npm run bench -- --provider openai-compat                    (PROVIDER/MODEL/LLM_API_KEY from .env)
//   npm run bench -- --provider openai-compat --prompt hinglish-v1
//   npm run bench -- --provider reference                        (sanity check of the benchmark itself)
//   npm run bench -- --provider openai-compat --judge
// Optional: PRICE_IN_PER_M / PRICE_OUT_PER_M (USD per million tokens) for a cost estimate.
// Structural results (hard validator) and linguistic results (terms, sense, lints) are reported separately.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadConfig } from '../backend/src/config.js';
import { getPrompt } from '../backend/src/prompts/index.js';
import { createProvider } from '../backend/src/providers/index.js';
import { createEngine } from '../backend/src/engine.js';
import { createReferenceProvider } from '../benchmark/reference-provider.js';
import { scoreCase, summarize } from '../benchmark/score.js';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i === -1 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const BATCH = 5; // same as the extension's batch size

const cases = JSON.parse(await readFile(new URL('../benchmark/cases.json', import.meta.url), 'utf8'));
const config = {
  ...loadConfig(),
  ...(flag('provider') && flag('provider') !== 'reference' ? { provider: flag('provider') } : {}),
  ...(typeof flag('prompt') === 'string' ? { promptVersion: getPrompt(flag('prompt')).version } : {}),
};
const provider = flag('provider') === 'reference' ? createReferenceProvider(cases) : createProvider(config);

// Every validator verdict is recorded with the benchmark case, attempt number and reason.
let current = null;
const attempts = [];
const engine = createEngine({
  provider, config,
  onAttempt: ({ id, attempt, ok, issue, output }) => {
    if (current && (!ok || attempt > 1)) attempts.push({ case: current[id].id, attempt, accepted: ok, reason: issue, output });
  },
});

const rows = [];
const latencies = [];
const wallStart = Date.now();
const totals = { calls: 0, retries: 0, repaired: 0 };
let inTok = 0;
let outTok = 0;
for (let i = 0; i < cases.length; i += BATCH) {
  const batch = cases.slice(i, i + BATCH);
  current = batch;
  const out = await engine.rewrite({ page: {}, items: batch.map((c, j) => ({ id: j, text: c.text, role: c.role, heading: c.heading })) });
  latencies.push(out.meta.latencyMs);
  totals.calls += out.meta.calls;
  totals.retries += out.meta.retries;
  totals.repaired += out.meta.repaired;
  inTok += out.meta.inputTokens;
  outTok += out.meta.outputTokens;
  batch.forEach((c, j) => {
    const r = out.results[j];
    const hinglish = r && r.hinglish;
    rows.push({ id: c.id, category: c.category, input: c.text, output: hinglish ?? null, error: r && r.error, reference: c.reference, score: scoreCase(c, hinglish) });
  });
}
current = null;

if (flag('judge')) { // LLM-as-judge for meaning/fluency; biased if the judge is the same model as the writer
  for (const row of rows.filter((r) => r.output)) {
    const { text } = await provider.complete({
      system: 'You grade Hinglish rewrites of English text. Reply with JSON only: {"meaning":1-5,"fluency":1-5,"naturalness":1-5}. meaning = same facts and ideas; fluency = grammatical Roman Hinglish; naturalness = how a fluent Indian speaker would really say it (not literal, not shuddh Hindi).',
      user: JSON.stringify({ english: row.input.replace(/⟦[^⟧]*⟧/g, ''), hinglish: row.output.replace(/⟦[^⟧]*⟧/g, '') }),
      maxTokens: 100,
    });
    try { row.judge = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { row.judge = null; }
  }
}

const sorted = [...latencies].sort((a, b) => a - b);
const pick = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const summary = summarize(rows);
const judged = rows.filter((r) => r.judge);
const avg = (k) => (judged.length ? (judged.reduce((s, r) => s + r.judge[k], 0) / judged.length).toFixed(2) : null);
const sameRun = provider.name === 'reference' || provider.name === 'mock';
const report = {
  provider: provider.name, model: provider.model,
  promptVersion: sameRun ? null : getPrompt(config.promptVersion).version,
  settings: sameRun ? null : {
    temperature: config.temperature, reasoningEffort: config.reasoningEffort || null, maxTokensParam: config.maxTokensParam,
    batchSize: BATCH, retries: config.retries, requestTimeoutMs: config.requestTimeoutMs, baseUrl: config.baseUrl || null,
  },
  cases: rows.length, requests: latencies.length,
  durationMs: Date.now() - wallStart, latencyMs: { p50: pick(0.5), p95: pick(0.95), perRequest: latencies },
  modelCalls: totals, failedCases: rows.filter((r) => r.error).map((r) => ({ id: r.id, code: r.error.code })),
  // Every rejected or repaired answer: which case, which attempt, why (output kept for diagnosis).
  repairLog: attempts,
  tokens: { input: inTok, output: outTok },
  ...(process.env.PRICE_IN_PER_M ? { costUsd: +((inTok * +process.env.PRICE_IN_PER_M + outTok * +(process.env.PRICE_OUT_PER_M || 0)) / 1e6).toFixed(5) } : {}),
  structural: summary.structural,
  linguistic: summary.linguistic,
  ...(judged.length ? { judge: { meaning: avg('meaning'), fluency: avg('fluency'), naturalness: avg('naturalness'), n: judged.length } } : {}),
  note: sameRun
    ? 'NOT a real-model result: plumbing/benchmark sanity check only.'
    : 'Structural = production validator (hard). Linguistic = terms, sense and lint heuristics (partial). Meaning/fluency/naturalness need --judge or human review.',
};

console.log(JSON.stringify(report, null, 2));
await mkdir(new URL('../benchmark/results/', import.meta.url), { recursive: true });
const tag = report.promptVersion ? `-${report.promptVersion}` : '';
const file = new URL(`../benchmark/results/${provider.name}${tag}-${Date.now()}.json`, import.meta.url);
await writeFile(file, JSON.stringify({ report, rows }, null, 2));
console.log(`\nSaved ${file.pathname}`);
