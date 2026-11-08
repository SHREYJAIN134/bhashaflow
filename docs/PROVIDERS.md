# LLM provider evaluation (Phase 3)

**Status: prompt v2 vs v1 comparison done ([BENCHMARK-hinglish-v2-comparison.md](BENCHMARK-hinglish-v2-comparison.md)); note the Gemini key used was free-tier (20 requests/day per model), which cannot run the product.** Gemini 3.6 Flash has been measured once (25-case run, see [BENCHMARK-gemini-3.6-flash.md](BENCHMARK-gemini-3.6-flash.md)); no other provider has.** The sections below that say "not measured" still apply to every provider except that run. No API keys were available while building Phase 3, so quality, latency and reliability below are *not* measurements. What exists is the full evaluation harness (`npm run bench`), the provider adapters, and published pricing. The recommendation is therefore a shortlist plus a decision rule, not a verdict. (Disclosure: the assistant that wrote this is an Anthropic model, so treat any preference it voices accordingly; the benchmark is the tie-breaker.)

## Candidates

All are reachable with the two adapters that exist: `anthropic` (native Messages API) and `openai-compat` (any `/chat/completions` endpoint: OpenAI, Groq, Gemini's OpenAI-compatible endpoint, Together, OpenRouter, local servers). Adding another provider is one file in `backend/src/providers/`.

| Candidate | Adapter | Published price, USD per 1M tokens (in / out) | Notes |
|---|---|---|---|
| Claude Haiku 5.5 (`claude-haiku-5-5`) | anthropic | not found; Haiku 4.5 lists $1 / $5 | Native adapter. Verify the price on Anthropic's pricing page. |
| Gemini Flash family (2.5 / 3.6) | openai-compat | 2.5 Flash $0.30 / $2.50; 3.6 Flash $0.75 / $3.75 | Via `https://generativelanguage.googleapis.com/v1beta/openai`. |
| GPT-5.4 nano / mini | openai-compat | nano $0.20 / $1.25; mini $0.75 / $4.50 | May need `MAX_TOKENS_PARAM=max_completion_tokens`. |
| Open model on Groq (Llama 3.1 8B / 3.3 70B) | openai-compat | 8B $0.05 / $0.08; 70B $0.59 / $0.79 | One source says these moved to enterprise pricing; confirm availability. Very fast decode, lower expected Hinglish quality. |

Prices come from third-party aggregators (retrieved 2026-11-04), several dated or conflicting. Confirm on each vendor's own pricing page before budgeting.

## Claude Haiku 5.5 (Anthropic API, default from 2026-11-06)

`PROVIDER=anthropic`, `MODEL=claude-haiku-5-5`, `ANTHROPIC_API_KEY`. List price $0.10 / $0.50 per million input / output tokens (prompts up to 100K tokens). **Not measured by this project yet**: the only evidence so far is offline tests with a mocked API. `npm run test:claude-live -- --confirm-live` makes the one-time real request and reports latency, tokens and cost; record its output here before trusting any number.

## Ollama (local, 2026-11-05)

`PROVIDER=ollama`, `MODEL=qwen3:4b` via the native `/api/chat` endpoint (adapter `providers/ollama.js`; setup in the README). Free, no key, offline. Smoke-tested once against a real Ollama 0.40.14 on a CPU-only Windows machine: 2 short blocks gave valid Hinglish in about 17 s (about 1,300 prompt tokens, 86 output tokens), the hinglish-v2 validator accepted both, and no reasoning text appeared. This is one observation, **not a quality benchmark**: `npm run bench` has not been run against Ollama. Plain `format:"json"` was tried first and the 4B model echoed the request back, which is why the adapter sends a JSON schema.

### Ollama performance measurements (2026-11-05, CPU-only, 12 logical cores, qwen3:4b Q4_K_M, `npm run perf`)

Real controller + worker service + backend engine + local Ollama in one process (jsdom stands in for Chrome; the cache is in memory, not IndexedDB). 7 medium paragraphs (about 150 characters each), 3 on screen. **Single runs: fresh inference is stochastic, treat the numbers as indicative, not as a benchmark.**

| Setting | First block painted | All 7 | Requests (blocks each) | Per-request avg / p95 | Per-block avg / p95 |
|---|---|---|---|---|---|
| **default: 1 at a time, first request 1 block, then up to 3** | 12.4 s | **73.6 s** | 3 (1, 3, 3) | 24.5 s / 31.4 s | 10.9 s / 12.2 s |
| 1 at a time, 1 block per request | 10.8 s | 107.2 s | 7 | 15.3 s / 36.7 s | 15.3 s / 36.7 s |
| 2 at a time, 1 block per request | 10.9 s | 81.7 s | 7 | 21.6 s / 24.5 s | 21.6 s / 24.5 s |

- A saved page (second visit, same 7 paragraphs): **first block painted 28-34 ms after the click, all 7 in 29-34 ms, 0 requests, cache lookup 1.5-1.8 ms** (memory storage; IndexedDB latency in Chrome was not measured).
- Where a request's time goes (Ollama's own counters, one paragraph): about 3-8 s evaluating the ~1,300-token Hinglish-v2 system prompt (shorter when its prefix is already cached) plus about 12 s generating ~70 tokens at ~5.5-7.8 tokens/s. Generation is the bottleneck, so fresh paragraphs cost roughly 10 s each on this machine.
- Concurrency 2 did not beat concurrency 1 with batching: the model already uses about 5.9 of 12 cores, each request simply runs about twice as slowly, and the first block is no earlier. Default stays 1. On a GPU, or with `OLLAMA_NUM_PARALLEL` raised, re-run `npm run perf -- --concurrency 2` with `MAX_CONCURRENCY=2`.
- Observed failure: one request fell into a repetition loop ("bhi bhi bhi...") and, with the earlier generous token cap, held the model for 164 s. The Ollama output budget and one retry now bound this (see ARCHITECTURE).
- Resources while translating: Ollama's runner about 3.0 GB resident and about 5.9 cores busy; the Node side (controller, service, backend) changed by less than 50 MB.

## Gemini configuration findings (2026-11-04, configuration check only, not a quality run)

- Endpoint `https://generativelanguage.googleapis.com/v1beta/openai` is correct; the adapter appends `/chat/completions`.
- `gemini-2.5-flash` appears in `/models` but chat calls fail with 404 "no longer available to new users". A model listed by the API is not necessarily usable: check with a real call.
- `gemini-3.6-flash` answers, but with default reasoning it spent the whole `max_tokens` on hidden reasoning and returned an empty reply with `finish_reason=length`. With `reasoning_effort` set to `none` (or `low`) it answered normally. The adapter now supports `REASONING_EFFORT` and fails explicitly on empty or truncated replies.
- `gemini-3.7-flash`, `gemini-3.8-flash` and `gemini-flash-latest` returned 503 "high demand" during the check (transient, retryable).
- `gemini-3.5-flash-lite` and `gemini-flash-lite-latest` worked with default settings.

## Criteria and what is known

| Criterion | How it is evaluated | Status |
|---|---|---|
| Natural Roman Hinglish | `--judge` score (naturalness 1-5) plus human review of the saved before/after rows | not measured |
| Technical term preservation | automatic: `mustKeep` terms per case (acronyms/mixed-case matched exactly) | harness ready, not run on any model |
| Contextual accuracy | automatic: ambiguous cases with `senseAny` / `forbidAny` (bank, Python) plus judge | harness ready, not run |
| Formatting integrity | automatic: placeholder tokens, numbers, acronyms, URLs, no Devanagari, length ratio | harness ready, not run |
| Latency | p50/p95 per request from `npm run bench` | not measured |
| Cost | tokens from provider usage x price (`PRICE_IN_PER_M`, `PRICE_OUT_PER_M`) | estimate below, not measured |
| Reliability / structured output | retry and repair counts in `meta`; JSON mode where the endpoint supports it | adapters tested against stubbed HTTP only |

## Decision rule (apply once keys exist)

Run `npm run bench -- --provider <p> --judge` for each candidate, then pick the **cheapest** model that meets all of:
1. Validity >= 95% on every category (after the built-in single repair pass the target is >= 98%).
2. Term preservation >= 95%, ambiguous-sense cases pass.
3. Judge mean >= 4.0 for meaning, fluency and naturalness, spot-checked by a Hindi reader.
4. p95 latency of a 5-item call within what Phase 4 parallelism can hide (see estimates).

Do not use the same model as writer and judge for the final decision; use a second model or human review.

```
cp .env.example .env     # set PROVIDER, MODEL, LLM_API_KEY (and BASE_URL for openai-compat)
npm run bench -- --provider anthropic --judge
PRICE_IN_PER_M=1 PRICE_OUT_PER_M=5 npm run bench -- --provider openai-compat
```

## Cost and latency estimates (assumptions, not measurements)

Assumptions: an article page with 60 eligible blocks averaging 350 characters, batches of 5 (12 calls), 4 characters per English token, romanised Hinglish tokenising at 1.4x English, system prompt 861 tokens (measured from `prompt.js`, resent on every call), 25 tokens of JSON wrapper per item. That gives about 17,000 input and 8,250 output tokens per page.

| Model (published price, unverified) | Cost per page | Per 1,000 pages |
|---|---|---|
| Claude Haiku 4.5 prices as stand-in for Haiku 5.5 | $0.058 | $58 |
| Gemini 2.5 Flash | $0.026 | $26 |
| Gemini 3.6 Flash | $0.044 | $44 |
| GPT-5.4 nano | $0.014 | $14 |
| GPT-5.4 mini | $0.050 | $50 |
| Llama 3.1 8B (Groq) | $0.0015 | $1.5 |

About 60% of input tokens are the repeated system prompt, so provider prompt caching (Phase 4) is the largest cost lever.

Latency per 5-item call is roughly time-to-first-token + output tokens / decode speed, with about 690 output tokens per call:

| Decode speed (assumed) | Per call | Whole page, sequential (today) | Whole page, 4 in parallel (Phase 4) |
|---|---|---|---|
| 50 tok/s | 14 s | 172 s | 43 s |
| 100 tok/s | 7 s | 89 s | 22 s |
| 200 tok/s | 4 s | 45 s | 11 s |
| 600 tok/s | 1.3 s | 16 s | 4 s |

**Consequence (addressed):** the 500-1500 ms target is only realistic per *small* batch on a fast model, so a whole page cannot appear that fast. The shipped extension therefore sends the on-screen blocks first, then the rest, with two parallel requests by default, and reuses saved translations on revisits (see ARCHITECTURE.md). Measured in a real browser with a 250 ms mock provider, 120 blocks took about 2 s over 13 requests; with a real model the time is dominated by the model's speed.

## Before / after examples

These are **hand-written reference renderings** (the target style from the spec), not model output. They are what the benchmark's formatting checks are validated against. Real model output has not been produced yet.

| Case | English | Reference Hinglish |
|---|---|---|
| Educational | Inflation is the rate at which the general level of prices for goods and services rises, which reduces the purchasing power of money over time. | Inflation wo rate hai jisse goods aur services ke prices ka general level badhta hai, aur isse time ke saath paise ki purchasing power kam ho jaati hai. |
| Dictionary (spec example) | (used about a court of law, especially in the US and some other countries) to officially accuse a public official of committing a serious crime while they are still in office | Ye word court of law ke context mein use hota hai, especially US aur kuch doosre countries mein. Iska matlab hai kisi government official par officially serious crime karne ka allegation lagana, jab woh abhi bhi apne office mein position hold kar raha ho. |
| Mixed inline | Use the `⟦1⟧map()⟦/1⟧` function to apply `⟦2=code⟧` to every element of the `⟦3⟧list⟦/3⟧`. | `⟦3⟧list⟦/3⟧` ke har element par `⟦2=code⟧` apply karne ke liye `⟦1⟧map()⟦/1⟧` function ka use karo. |
| Ambiguous (river) | *(heading: Rivers and landforms)* The bank of the river was covered with tall grass, and children often played near it. | Nadi ka kinara lambi ghaas se dhaka hua tha, aur bachche aksar uske paas khelte the. |
| Ambiguous (finance) | *(heading: Personal finance)* The bank approved her loan after reviewing her income and credit history. | Bank ne uski income aur credit history review karne ke baad uska loan approve kar diya. |

In the mixed-inline row the paired tokens become the original `<a>`/`<b>` elements and the single token the original `<code>`; sibling order may change, parents may not.

## What the harness does and does not prove

- **Does:** checks that outputs keep every token, number, acronym and URL, contain no Devanagari, have a plausible length, keep required terms and pick the right sense in the ambiguous cases; reports latency, tokens and cost; saves every input/output row to `benchmark/results/`.
- **Does not:** judge meaning or fluency without `--judge` or a human; the 25 cases are a starting set, not a statistically meaningful sample. The `mock` and `reference` providers exist to test plumbing and the benchmark itself and must never be quoted as model results.
