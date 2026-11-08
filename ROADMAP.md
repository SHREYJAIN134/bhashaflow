# Roadmap

BhashaFlow is a finished **personal-use** extension. This file records what was built, the decisions behind it, and what is deliberately left out.

## Decisions
- Zero cost: free Gemini key only; no billing, no paid SDKs, **no runtime dependencies** (esbuild and jsdom are dev-only).
- Manual opt-in: nothing runs on a page until you click Translate; only permissions `activeTab`, `scripting`, `storage` and the local backend origin.
- Model `gemini-3.6-flash` with `REASONING_EFFORT=none`, prompt `hinglish-v2` by default; `hinglish-v1` preserved byte-for-byte (SHA-256 asserted in tests) behind `PROMPT_VERSION`.
- The API key lives only in the git-ignored `.env`, used by the local Node backend.

## Done

| Area | Delivered |
|---|---|
| Page engine | Main-content detection (text/link density, semantic hints), ad / sponsored / third-party exclusion, protected headings, nav, code, forms and existing Hindi, per-block reason codes (`__bhashaflow.explain()`), inline links/bold/code via placeholder tokens with element reuse, run splitting around nested blocks, dictionary entries, exact restore, opt-in dynamic content |
| AI engine | Provider adapters (`openai-compat`, `anthropic`, `mock`), prompts v1/v2, backend with validation, bounded retries, one repair pass, typed errors, server- and client-side placeholder validation, protected content reduced to a kind before sending |
| Free-tier efficiency | Persistent IndexedDB cache (key = text + role + heading + page title + prompt version + model; 5,000 entries / ~5 MB / 90 days, LRU, malformed-record sweep, corruption and unavailability tolerated), in-page and concurrent de-duplication, size-based packing (12 blocks / 1,800 chars), daily-quota circuit-breaker **persisted per model across service-worker restarts**, daily quota never retried |
| Performance | Viewport-first priority (on screen, then up to 1.5 screens below, then the rest, then above), re-prioritised when you scroll, bounded parallel requests (default 2, max 4), scan-then-request without waiting for the whole page, cancellable |
| Experience | Popup with Translate, Pause/Resume, Stop, Restore, cache toggle and Clear, accurate progress / error / quota / cache statistics, per-site dynamic opt-in, icons |
| Quality evidence | 25-case benchmark with structural (hard) and linguistic (heuristic) scoring, v1 vs v2 comparison, saved results and free offline re-scoring |
| Verification | 200+ offline tests, mutation checks of the critical logic, real-Chrome checks of the engine, scheduler, cache and IndexedDB (see docs/VERIFICATION.md) |

## Known limitations (also in README)
- **Quality:** good, not perfect; about 20/25 benchmark outputs clean, definitions weakest; meaning beyond placeholders/numbers/acronyms/terms is only heuristically checked. One benchmark run per prompt on a free key; no human Hindi review yet.
- **Free tier:** the key tested allowed 20 requests/day on `gemini-3.6-flash`: about 1-2 new long articles a day; revisits are free. Other models' free limits were not checked.
- **Not verified in a real extension install:** loading the packed extension from `chrome://extensions` cannot be automated here, so the popup, the manifest load and the real service-worker lifecycle were verified by simulation, not by Chrome. See docs/VERIFICATION.md for exactly what was and was not run in a real browser.
- **Page coverage:** no shadow DOM or iframes; an unmarked ad inside the article body can pass as prose; blocks over 3,900 characters are skipped; 3,000 blocks per run; text appended into an already-translated block is not re-translated.
- **Scanning is synchronous** (about 190 ms on a 1 MB page measured earlier); the first request leaves right after it, but the scan itself is not time-sliced.
- **Quota breaker keeps the provider's reset time** (up to 24 h); if you change the free-tier key without changing `MODEL` the old block still applies until it expires (clear it by changing `MODEL` or waiting).

## Deliberately not built
Accounts, cloud sync, a hosted backend (`api/rewrite.js` is a Vercel-style entry that was never deployed), automatic translation of every page, a floating on-page indicator, prompt caching on the provider side, a per-site allow/deny list beyond the dynamic opt-in.
