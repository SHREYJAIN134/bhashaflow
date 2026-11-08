# What was verified, and how

This file separates **simulation** from **real browser** evidence, and lists what could not be verified.

## 1. Automated offline suite (`npm test`)
Runs with no network, no API key and no quota. It covers the page engine, classification, placeholders, validation, restoration and event-handler preservation; the backend (providers via stubbed HTTP, retries, quota vs rate-limit classification, repair, validation, rate limit, limits); the cache (hit/miss, persistence across simulated sessions, prompt/model/title isolation, eviction by count and size, TTL, corruption, malformed `lastUsedAt`, unavailable storage, disk full); de-duplication and concurrent in-flight sharing (including a 40-request stress test and failure propagation); the scheduler (viewport order with a stubbed layout, scroll re-prioritisation, concurrency bounds, out-of-order answers, pause/resume/stop/restore races, dynamic content, malformed replies); the persisted quota breaker across simulated worker restarts; the popup, content script and service worker wired through a fake `chrome` bus to a real HTTP backend; manifest and build-output validation; icon PNG validity; secret and permission scans; logging hygiene; timer/leak checks; documentation sanity.

**Simulation boundary.** `tests/helpers/fake-chrome.js` reproduces the parts of `chrome.*` we use (JSON-cloned messages, async reply protocol, storage). It runs *our* popup, content and worker modules for real, but it is not Chrome: it does not prove manifest loading, extension worker lifetime or the real IndexedDB.

**Mutation checks.** Critical behaviours were broken on purpose and the suite had to fail: version/model/title in the cache key, in-flight sharing, read-side validation, quota breaker (and its persistence), eviction, duplicate collapsing, viewport priority, concurrency bound, pause, quota halt, discarding late answers after Restore, completing short replies, orphan sweep. Each mutant was caught (one gap found this way, over-limit sweeping of indexable malformed records, was fixed and tested).

## 2. Real Chrome (what actually ran in a real browser)
A local test server served a 120-paragraph article (nav, code sample, ad slot, widget, footer, links, bold text) plus a bundle of the **real** content engine, scheduler, translation service, cache and IndexedDB adapter, talking over real HTTP to the real backend with the **offline mock provider** (no Gemini calls). Only the `chrome.runtime` hop was replaced by a direct call.

| Check | Result in Chrome |
|---|---|
| Viewport-first | Scrolled to paragraph 60 (viewport showed 60-69): the first request began with 60, and the first converted blocks in the DOM were 60-67 |
| Parallelism | 13 requests for 120 blocks; maximum simultaneous requests 2 |
| Protected content | nav, code sample, ad slot, widget, footer, h1, h2: 7/7 unchanged |
| Link handlers | 40/40 fired after conversion; original elements still connected |
| Restore | `document.body.innerHTML` byte-identical, also after Stop and after dynamic content |
| Persistence | Fresh page load, same IndexedDB: 120 entries (~54 KB), 120 blocks converted from cache with **0 backend requests** in 56 ms |
| Cache off / different page title | Both went back to the backend (13 requests): not reused |
| Pause | 2 requests at pause, still 2 after 1.5 s; in-flight work landed; Resume finished all 120 |
| Stop | 4 requests at Stop, still 4 later; 39 blocks kept; re-Translate converted exactly the other 81 |
| Dynamic content | Duplicate new text sent once; later duplicate reused; late block converted |
| Malformed records in real IndexedDB | Chrome indexed 2 of 5 malformed records; `orphans()` found all 5; all swept when the limit was hit while 6 healthy entries were kept |
| Errors | `window` `error` and `unhandledrejection` listeners: empty throughout; no console errors on the final tab. (Console tracking starts at first use, so those page listeners are the stronger evidence for earlier activity.) |
Throwaway IndexedDB databases and the test tab/server were removed afterwards.

## 3. Not verified (be aware)
- **Loading the built extension through `chrome://extensions` and using the real popup.** Chrome rejects the command-line load flag for branded builds and Load unpacked needs a native file dialog, so it could not be automated. The manifest, the build output, the popup logic (against a simulated `chrome`) and every referenced file were validated, but a first manual load is still the real test. Expect to check: the icon appears, the popup opens, Translate works on an http(s) page with the backend running.
- **Real Gemini output with the current code.** No live API calls were made in this phase (free quota). The last live benchmark (v2, 25 cases) is in `docs/BENCHMARK-hinglish-v2-comparison.md`.
- **Real service-worker restarts** (the breaker's persistence is tested against `chrome.storage` semantics in simulation).
- **Other browsers** (Edge, Brave, Firefox) and very large or unusual pages beyond Wikipedia and GeeksforGeeks spot checks from Phase 2.
