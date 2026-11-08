import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SYSTEM_PROMPT_V1 } from '../../backend/src/prompts/v1.js';
import { SYSTEM_PROMPT_V2 } from '../../backend/src/prompts/v2.js';
import { getPrompt, PROMPT_VERSIONS, DEFAULT_PROMPT_VERSION } from '../../backend/src/prompts/index.js';
import { loadConfig } from '../../backend/src/config.js';
import { createEngine } from '../../backend/src/engine.js';
import { createMockProvider } from '../../backend/src/providers/mock.js';
import { sourceFromTemplate } from '../../extension/src/shared/tokens.js';
import { validateItem } from '../../backend/src/validate.js';
import { scoreCase, summarize, LINTS } from '../../benchmark/score.js';

const O = '⟦';
const C = '⟧';
const cases = JSON.parse(readFileSync('benchmark/cases.json', 'utf8'));
const byId = (id) => cases.find((c) => c.id === id);
const sha = (s) => createHash('sha256').update(s).digest('hex');
// SHA-256 of the v1 prompt exactly as it shipped in Phase 3. If this fails, v1 was edited: add a new version instead.
const V1_SHA256 = 'f813f0deca26a5926a7b10b1e1de6d532ae85cf42cca1dd481129e99c70ab3e7';

// ---------------------------------------------------------------- versioned prompts

test('v1 is preserved byte-for-byte; v2 is a separate, registered version', () => {
  assert.equal(sha(SYSTEM_PROMPT_V1), V1_SHA256);
  assert.deepEqual(PROMPT_VERSIONS, ['hinglish-v1', 'hinglish-v2']);
  assert.equal(DEFAULT_PROMPT_VERSION, 'hinglish-v2');
  assert.equal(getPrompt('hinglish-v1').system, SYSTEM_PROMPT_V1);
  assert.equal(getPrompt().system, SYSTEM_PROMPT_V2);
  assert.notEqual(SYSTEM_PROMPT_V1, SYSTEM_PROMPT_V2);
  assert.throws(() => getPrompt('hinglish-v9'), /Unknown PROMPT_VERSION/);
});

test('PROMPT_VERSION selects the prompt end to end: config, engine, request, meta', async () => {
  assert.equal(loadConfig({}).promptVersion, 'hinglish-v2');
  assert.equal(loadConfig({ PROMPT_VERSION: 'hinglish-v1' }).promptVersion, 'hinglish-v1');
  assert.throws(() => loadConfig({ PROMPT_VERSION: 'nope' }), /Unknown PROMPT_VERSION/);

  const item = { id: 0, text: 'The REST API returns 200 results in JSON format when the request is valid and complete.' };
  for (const [version, expected] of [['hinglish-v1', SYSTEM_PROMPT_V1], ['hinglish-v2', SYSTEM_PROMPT_V2]]) {
    const provider = createMockProvider();
    const out = await createEngine({ provider, config: { requestTimeoutMs: 500, retries: 0, maxItemsPerCall: 12, maxCharsPerCall: 8000, promptVersion: version } })
      .rewrite({ page: {}, items: [item] });
    assert.equal(provider.calls[0].system, expected);
    assert.equal(out.meta.promptVersion, version);
  }
});

test('v2 keeps every v1 constraint and adds the requested rules', () => {
  const must = [
    'Roman script only', 'Never output Devanagari', 'technical terms', 'acronyms', 'numbers', 'proper nouns',
    'exactly once', 'Never invent tokens', 'single JSON object', 'Iska matlab hai',
    // new in v2
    'Add nothing and drop nothing', 'karo, dekho, samjho, padh lo', 'karein', 'gender', 'aisa process, aisi memory',
    'Prefer active sentences', 'Never repeat a word or phrase', 'sound like nonsense', 'intended sense',
  ];
  for (const m of must) assert.ok(SYSTEM_PROMPT_V2.includes(m), `v2 is missing: ${m}`);
  assert.ok(SYSTEM_PROMPT_V2.includes('Ye word court of law ke context mein use hota hai'), 'spec example kept');
});

test('v2 has two dictionary examples with different grammatical structure', () => {
  const defs = [...SYSTEM_PROMPT_V2.matchAll(/Input \(role "definition"\): "([^"]*)"/g)].map((m) => m[1]);
  assert.equal(defs.length, 2);
  assert.ok(defs[0].startsWith('(') && /\bto officially accuse\b/.test(defs[0]), 'usage note + verb phrase');
  assert.ok(/^a small piece of land/.test(defs[1]) && !defs[1].startsWith('('), 'plain noun-phrase definition');
});

test('every few-shot example in v2 passes the production validator', () => {
  const pairs = [...SYSTEM_PROMPT_V2.matchAll(/Input(?: text| \(role "definition"\))?: "([^"]*)"\nOutput hinglish: "([^"]*)"/g)];
  assert.ok(pairs.length >= 5, `found ${pairs.length} example pairs`);
  for (const [, input, output] of pairs) {
    const result = validateItem({ id: 0, text: input, source: sourceFromTemplate(input) }, output);
    assert.equal(result.ok, true, `${input.slice(0, 50)}: ${result.issue}`);
  }
});

test('contamination guard: no benchmark case or reference appears in either prompt (spec example exempt)', () => {
  for (const prompt of [SYSTEM_PROMPT_V1, SYSTEM_PROMPT_V2]) {
    for (const c of cases) {
      if (c.id === 'dict-1') continue; // the spec's own example, used since v1
      assert.ok(!prompt.includes(c.text), `${c.id} source is in the prompt`);
      assert.ok(!prompt.includes(c.reference), `${c.id} reference is in the prompt`);
    }
  }
  // Specific defect strings from the first run must not be quoted as "fixes" either.
  for (const leaked of ['aisi model', 'kaam ka kaam', 'jispar', 'nadi ka kinara', 'River ka bank']) {
    assert.ok(!SYSTEM_PROMPT_V2.includes(leaked), `v2 quotes benchmark-derived string "${leaked}"`);
  }
});

// ---------------------------------------------------------------- scorer

test('term scorer accepts valid Hinglish possessives but stays strict about acronyms and missing terms', () => {
  const law = { ...byId('edu-3') };
  const base = 'kisi object par lagne wala force uske mass aur acceleration ke product ke barabar hota hai.';
  for (const phrase of ["Newton's second law", 'Newton ka second law', 'Newton ke second law', 'Newton ki second law', 'Newton second law']) {
    assert.equal(scoreCase(law, `${phrase} ke mutabiq ${base}`).termsKept, true, phrase);
  }
  assert.equal(scoreCase(law, `Newton ka dusra niyam kehta hai ki ${base}`).termsKept, false, 'translated term is a real miss');
  assert.equal(scoreCase(law, `Newton ka second law ke mutabiq ${base.replace('force', 'bal')}`).termsKept, false);
  const api = byId('tech-4');
  assert.equal(scoreCase(api, api.reference.replace('REST API', 'rest api')).termsKept, false);
  assert.equal(scoreCase(byId('mixed-3'), byId('mixed-3').reference).termsKept, true);
});

test('structural and linguistic results are independent, and structure is never loosened', () => {
  const c = byId('tech-4');
  const good = scoreCase(c, c.reference);
  assert.deepEqual(good.structural, { ok: true, issue: null });
  assert.equal(good.linguistic.termsKept, true);

  // linguistically fine (terms present) but structurally broken
  const noDigits = scoreCase(byId('mixed-4'), byId('mixed-4').reference.replace('100', '90'));
  assert.equal(noDigits.structural.ok, false);
  assert.match(noDigits.structural.issue, /numbers/);

  const stripped = scoreCase(byId('mixed-1'), byId('mixed-1').reference.replace(`${O}1${C}`, ''));
  assert.equal(stripped.structural.ok, false);
  assert.equal(stripped.valid, false, 'flat alias agrees');

  const devanagari = scoreCase(c, `${c.reference} हिंदी`);
  assert.equal(devanagari.structural.ok, false);
  assert.equal(devanagari.linguistic.termsKept, true, 'terms are judged separately');

  assert.equal(scoreCase(c, undefined).structural.ok, false);
  // structure verdict is exactly the production validator's
  const direct = validateItem({ id: 0, text: c.text, source: sourceFromTemplate(c.text) }, c.reference);
  assert.equal(direct.ok, good.structural.ok);
});

test('all 25 hand-written references still score clean structurally and on terms', () => {
  for (const c of cases) {
    const s = scoreCase(c, c.reference);
    assert.equal(s.structural.ok, true, `${c.id}: ${s.structural.issue}`);
    assert.equal(s.linguistic.termsKept, true, `${c.id}: ${s.linguistic.missingTerms}`);
    assert.equal(s.linguistic.senseOk, true, c.id);
  }
});

test('lint detectors flag the defect classes seen in v1 and stay quiet on clean Hinglish', () => {
  const ids = (text) => scoreCase({ text: 'x y z', mustKeep: [] }, text).lints.map((l) => l.id);
  assert.ok(ids('Koi kaam ka kaam karne ke bajaye time waste karna.').includes('repeated-phrase'));
  assert.ok(ids('Ek aisi model ko train karti hai.').includes('gender-mismatch'));
  assert.ok(ids('Is memory mein aisa information store hota hai.').includes('gender-mismatch'));
  assert.ok(ids('Server par CORS header set karein.').includes('formal-imperative'));
  assert.ok(ids('Inflation wo rate hai jispar prices badhte hain.').includes('malformed-postposition'));
  assert.ok(ids('Reference nahi ki ja rahi ho.').includes('literal-passive'));
  assert.deepEqual(ids('Server par CORS header set karo, warna browser requests ko block kar dega.'), []);
  assert.deepEqual(ids('Ek aisa model jo naye inputs ke outcomes predict kar sakta hai.'), []);
  assert.ok(LINTS.length >= 5);
  const s = summarize([{ category: 'a', score: scoreCase({ text: 'x y z', mustKeep: [] }, 'Ek aisi model hai.') }]);
  assert.equal(s.linguistic.lintCounts['gender-mismatch'], 1);
  assert.ok('structural' in s && 'linguistic' in s);
});

// ---------------------------------------------------------------- repair records

test('engine records every rejection with case id, attempt number and reason, without page text', async () => {
  const events = [];
  const provider = createMockProvider({ corrupt: (item, out, call) => (call === 1 && item.id === 1 ? out.replace('200', '300') : out) });
  const config = { requestTimeoutMs: 500, retries: 0, maxItemsPerCall: 12, maxCharsPerCall: 8000 };
  const items = [
    { id: 0, text: 'Machine learning is a branch of artificial intelligence that learns from data and improves with experience.' },
    { id: 1, text: 'The REST API returns 200 results in JSON format when the request is valid and complete.' },
  ];
  const out = await createEngine({ provider, config, onAttempt: (e) => events.push(e) }).rewrite({ page: {}, items });

  assert.deepEqual(out.meta.rejections, [{ id: 1, attempt: 1, issue: out.meta.rejections[0].issue }]);
  assert.match(out.meta.rejections[0].issue, /numbers/);
  assert.ok(!JSON.stringify(out.meta.rejections).includes('REST'), 'no page text in response metadata');
  const rejected = events.filter((e) => !e.ok);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].attempt, 1);
  assert.ok(typeof rejected[0].output === 'string', 'hook (benchmark only) sees the rejected output');
  const repaired = events.find((e) => e.id === 1 && e.attempt === 2);
  assert.equal(repaired.ok, true);
  assert.equal(out.meta.repaired, 1);
});

test('rescore script re-scores a saved results file offline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bf-rescore-'));
  try {
    const rows = cases.slice(0, 6).map((c) => ({ id: c.id, category: c.category, input: c.text, output: c.reference }));
    const file = join(dir, 'run.json');
    writeFileSync(file, JSON.stringify({ report: { promptVersion: 'hinglish-v1' }, rows }));
    const out = JSON.parse(execFileSync(process.execPath, ['scripts/rescore.js', file], { encoding: 'utf8' }));
    assert.equal(out.structural.validPct, 100);
    assert.equal(out.originalPromptVersion, 'hinglish-v1');
    assert.deepEqual(out.flagged, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
