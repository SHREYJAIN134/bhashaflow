# Benchmark report: prompt v1 vs v2 (Gemini 3.6 Flash)

Run date 2026-11-04. Model `gemini-3.6-flash`, OpenAI-compatible endpoint, `REASONING_EFFORT=none`, temperature 0.3, batches of 5, retries 2, timeout 30 s, same 25 cases. Only the prompt differs. The original report ([BENCHMARK-gemini-3.6-flash.md](BENCHMARK-gemini-3.6-flash.md)) and all raw results are preserved unchanged in `benchmark/results/` (git-ignored, local).

## Recommendation

**Adopt `hinglish-v2` as the default and keep Gemini 3.6 Flash, but only on a billing-enabled (paid) key, and treat the quality verdict as provisional until repeated.**

- v2 is at least as good as v1 on every measured metric and is **reproducibly** better in two ways: it stopped the stiff "-ein" register in 4 of 4 cases that had it in *both* v1 samples, and it reduced literal passives. It cost about 7% more per run.
- The grammar fixes I expected (gender agreement, garbled phrasing) **cannot be credited to v2**. The v1 repeat did not show those defects either, so they were intermittent, not systematic. The model produces about 1-4 moderate slips per 25 short cases regardless of prompt.
- v2 introduced one new slip and did not remove one old one (below). Prompt edits alone will not make output reliably clean; plan for human review and a stronger check on additions.
- **Blocker found:** the key is on Google's free tier, which allows **20 requests per day per model**. That quota is now exhausted (resets in about 20 h) and it ended this comparison early. One article page needs about 12 requests, so the free tier cannot run the product. Enable billing before any real use.

## What was run (and what was not)

| Run | Prompt | Cases completed | Notes |
|---|---|---|---|
| A | v1 (original report) | 25 / 25 | Complete. Re-scored here with the new scorer, no new calls. |
| B | v2 | 25 / 25 | Complete. 1 transient retry, 0 repairs. |
| C | v1 repeat | **20 / 25** | Last 5 cases (hi-2, hi-3, amb-1..3) hit the daily quota. Used as a noise sample on the 20 completed cases. |
| D | v1 repeat #2 | 5 / 25 | Almost entirely rate-limited; **excluded** from every comparison. |

Total spend about 2 US cents (about 28 requests including retries and one quota probe). I stopped when the quota ran out; no further calls will work today. Because v1 was only repeated once (partially) and v2 only once, every conclusion below is a small-sample result.

## Structural validity and linguistic checks (kept separate)

Structural = the production validator, unchanged and not loosened. Linguistic = required terms, word-sense and lint heuristics. The term scorer now accepts valid possessive forms ("Newton ka second law"), which fixes the earlier false alarm; acronym and mixed-case terms (REST API, PostgreSQL) are still matched exactly.

| Metric | v1 original (25) | v1 repeat (20 done) | v2 (25) |
|---|---|---|---|
| **Structural validity** | 25/25 | 20/20 | 25/25 |
| Failures / truncations | 0 / 0 | 5 quota failures / 0 | 0 / 0 |
| Retries / repair passes | 0 / 1 | (quota retries) / 0 | 1 transient / 0 |
| **Term preservation** | 25/25 | 20/20 | 25/25 |
| **Sense checks** (bank, Python) | 3/3 | n/a (not reached) | 3/3 |
| Lint-flagged cases | 12 / 25 | 6 / 20 | 1 / 25 |
| Formal "-ein" imperatives | 4 | 4 (same 4 cases) | **0** |
| Literal passives | 5 | 3 | 2 (long-1 only) |
| Gender mismatch / malformed / repeated phrase | 2 / 1 / 1 | 0 / 0 / 0 | 0 / 0 / 0 |

Repair records (case, attempt, rejection reason) are now captured by the harness: **no answer was rejected in the v2 run**. The one repair in the original v1 run happened before recording existed, so its case is unknown.

Lints are heuristics tuned to defect classes already seen; a clean lint result is not proof of good Hinglish. Notice that the lints are what flagged v1's gender and garble defects in run A and also showed they vanished in the repeat.

## Cost and latency (same settings)

| | v1 original | v2 |
|---|---|---|
| Input / output tokens | 6,124 / 1,301 | 7,324 / 1,238 |
| Cost (at $0.75 in / $3.75 out per 1M, Google's rate through 31 Dec 2026) | $0.00947 | $0.01014 (+7%) |
| Total duration, 5 requests | 30.4 s | 16.3 s |
| Per-request p50 / p95 | 5.7 s / 13.5 s | 2.4 s / 6.4 s |

v2's prompt is about 200 tokens longer per call (about +$0.002 per article page at 12 calls) and its output is about 5% shorter. The latency difference is **not** a v2 effect: v1 itself ranged from 12.6 s (repeat) to 30.4 s (original, including a 13.5 s request with a repair call). Treat latency as unchanged. From 1 Jan 2027 Google's prices double.

## Quality: representative before / after

My own reading (not a native-speaker panel) with a three-level rubric: **clean**, **minor** (stiff or literal but correct), **moderate** (grammatical error, invented or lost meaning). Please have a Hindi reader confirm.

| Count of 25 | clean | minor | moderate |
|---|---|---|---|
| v1 original | 13 | 8 | 4 |
| v2 | 20 | 3 | 2 |
| v1 repeat (20 cases) | 13 | 6 | 1 |

On the repeat sample v1 had only 1 moderate slip in 20 cases, so the original's 4 was partly bad luck and the true gap in moderate slips between v1 and v2 is small. The reliable gain is in the minor category (register, passives).

### Improved, reproducibly
| Case | v1 (both samples) | v2 |
|---|---|---|
| tech-2 | Server par CORS header set **karein**, nahi toh browser ... | Server par CORS header set **karo**, nahi toh browser ... |
| mixed-3 | ... documentation⟦/1⟧ ko **padhein**. | ... documentation⟦/1⟧ **padh lo**. |
| tech-3 | ... ⟦1=code⟧ run **karein**. | ... ⟦1=code⟧ **chalao**. |
| hi-2 | ... general strike ko describe karne ke liye **kiya jata hai**. | 'Bandh' word Hindi mein ... describe karne ke liye **use hota hai**. |
| mixed-4 | ... higher altitudes par ye ⟦1⟧lower⟦/1⟧ temperature ... | ... **zyada altitude** par ye ⟦1⟧**kam**⟦/1⟧ temperature ... |

### Improved, but one sample only (cannot attribute to the prompt)
| Case | v1 original | v1 repeat | v2 |
|---|---|---|---|
| edu-4 (gender) | ... **aisi model** ko train karti hai jo ... | ... ek model ko train karti hai jo ... | ... ek **aise** model ko train karti hai jo ... kar sakta hai |
| dict-3 (garble) | ... koi **kaam ka kaam** karne ke bajaye faaltu ... | ... koi useful kaam karne ki bajaye faltu ... | ... koi zaroori kaam karne ki jagah bekaar ... |
| edu-2 | ... wo rate hai **jispar** ... | ... jis par ... | ... jis par ... |
| amb-1 | **River ka bank** lambi grass ... | (not reached) | **Nadi ka kinara** lambi ghaas ... |

amb-1 is the one result that plausibly reflects the new "use the clear Hindi word for the intended sense" rule; it is a single sample. The v2 prompt deliberately does **not** quote the benchmark's "bank" or "aisi model" examples (a test asserts no case text appears in the prompt), so this improvement is a generalisation, not memorisation.

### Still wrong, or newly wrong in v2
| Case | v2 output | Problem |
|---|---|---|
| dict-2 | ... kisi cheez ya event ka **achanak** aur chance se **acche** ya beneficial tareeqe se ho jaana. | Still adds a word that is not in the source ("achanak"; v1 added "unexpected") and loses "happy". The no-additions rule did not hold for definitions. |
| amb-1 | ... bachhe aksar uske paas **khele karte the**. | **New** ungrammatical verb ("khelte the"). |
| dict-3 | ... koi **zaroori** kaam ... **bekaar** ki cheezon ... | Slight sense drift (useful -> necessary, unimportant -> useless). The v1 repeat ("useful kaam") was closer. |
| long-1 | ... errors aur missing values hatane ke liye clean **kiya jaata hai** ... | Passive remains for long sentences; mild. |

## Meaning preservation and terminology
No fact, number, condition or technical term was lost or changed in either prompt; all acronyms, `free()`, `map()`, placeholders and the inline links/code survived (structural 100% in both). The only meaning problems were the small additions/drift in definitions listed above.

## What I recommend next

1. **Enable billing** on the Google project (or use another provider): without it nothing can be re-tested or used. This is also why the comparison is thinner than I intended.
2. **Repeat each prompt about 3 times** once quota allows (about 36 requests, roughly 4 cents) to separate prompt effect from sampling noise, especially for gender and additions.
3. **Human Hindi review** of the 25 v2 outputs, with special attention to definitions.
4. **Lower the temperature to 0.1-0.2** as a cheap way to reduce run-to-run slips, then re-measure.
5. For **definitions**, add an automatic check for words absent from the source (for example a list of "intensifier/adverb" additions) and let the repair pass reject it; today nothing validates additions.
6. Make quota-exhausted 429s **non-retryable** (Google returns `retryDelay` of tens of thousands of seconds); the engine currently retries them like short rate limits.
7. Keep the lint heuristics in the benchmark only; do not use them to block output in production.

## Reproducing

```
npm run bench -- --provider openai-compat --prompt hinglish-v2     # needs quota; wait ~1 min between runs on free tiers
node scripts/rescore.js benchmark/results/<file>.json              # free re-scoring of a saved run
```
Raw files: v1 original `openai-compat-1793792137763.json`, v1 partial repeat `openai-compat-hinglish-v1-1793792728979.json`, v2 `openai-compat-hinglish-v2-1793792715162.json`, v1 failed repeat `openai-compat-hinglish-v1-1793792845788.json` (kept for the record, excluded from analysis).
