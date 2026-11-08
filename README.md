# BhashaFlow

A personal-use Chrome extension that rewrites the explanatory English on a web page into natural, conversational **Hinglish** (Hindi in Roman script mixed with English), without changing the page's layout, links or behaviour. By default you **select text and click Translate Selection** (a small panel shows the Hinglish, your page is not changed); translating the **whole page** is an optional action in the popup. Nothing is translated until you click, translates with **Claude (Anthropic API, low-cost Haiku model)** by default, or optionally a **local Ollama model** (no key) or a **Gemini API key**, and can undo everything with one click.

## What you need

- **Node.js 22 or newer** (developed on 24) and npm.
- **Google Chrome 110 or newer**.
- An **Anthropic API key** (default engine; paid per token, see "Claude" below), **or** a local Ollama model (free), **or** a Gemini API key from Google AI Studio (free tier).

## Set up (once)

(The steps below show the Gemini variant; for Claude or Ollama see the next two sections, which replace the `.env` block.)

```
npm install
```

Create your private settings file and add your key. It is read only by the local backend and is git-ignored:

```
copy .env.example .env          (Windows)   |   cp .env.example .env   (macOS/Linux)
```

Edit `.env`:

```
PROVIDER=openai-compat
MODEL=gemini-3.6-flash
LLM_API_KEY=<paste your Gemini API key here>
BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
REASONING_EFFORT=none
```

`REASONING_EFFORT=none` matters for `gemini-3.6-flash`: otherwise the model spends its answer budget on hidden reasoning and can return nothing. The key lives **only** in this file. The extension never sees it.

## Claude (default provider)

BhashaFlow's default engine is Anthropic's **Claude Haiku 5.5** (`claude-haiku-5-5`, list price $0.10 / $0.50 per million input / output tokens, so a few paragraphs cost a fraction of a cent). It is a paid API: you need your own key from https://console.anthropic.com with credit on the account. Nothing is deployed and there is **no automatic fallback** to another provider.

In the root `.env` (git-ignored; the key is read only by the local backend, never bundled into the extension, never logged):

```
PROVIDER=anthropic
MODEL=claude-haiku-5-5
ANTHROPIC_API_KEY=<your key>
```

The key is taken **only** from `ANTHROPIC_API_KEY`; a Gemini key left in `LLM_API_KEY` is never sent to Anthropic. Claude 5 models think by default and reject a custom temperature, so the backend sends thinking off, low effort and no temperature (`ANTHROPIC_THINKING` / `ANTHROPIC_EFFORT` override). Selected text uses a compact variant of the Hinglish-v2 prompt (same rules, same output contract, about half the length); whole pages use the full Hinglish-v2 prompt. Saved translations, deduplication, progressive rendering and Restore are unchanged.

**One-time live check** (the only command that makes a real paid request; it is not part of `npm test`): `npm run test:claude-live -- --confirm-live` sends ONE request with five passages, no retries and no repair pass, and prints each translation, the latency, the token counts and the estimated cost. Without `--confirm-live` or without `ANTHROPIC_API_KEY` it refuses; `--dry-run` shows what it would send without any network use.

Errors you may see in the popup panel: wrong key ("check ANTHROPIC_API_KEY"), no credit ("add credit in the Anthropic console"), unknown model id ("check MODEL"), rate limit or overload (retried a couple of times, then reported).

## Use a local model instead (Ollama: no API key, no quota, nothing leaves your computer)

1. Install Ollama (https://ollama.com), then download the model once: `ollama pull qwen3:4b`.
2. Make sure Ollama is running (the desktop app, or `ollama serve`).
3. In `.env` set (leave any Gemini key where it is; it is ignored while `PROVIDER=ollama`):
   ```
   PROVIDER=ollama
   MODEL=qwen3:4b
   OLLAMA_BASE_URL=http://127.0.0.1:11434
   ```
4. Restart `npm run backend`. It should print `provider=ollama, model=qwen3:4b`.

**Switching back to Gemini** is the same file: set `PROVIDER=openai-compat`, `MODEL=gemini-3.6-flash` and keep your `LLM_API_KEY`, `BASE_URL` and `REASONING_EFFORT=none`, then restart the backend. To try Ollama once without editing `.env`, set the variables for one run (real environment variables win over `.env`): PowerShell `$env:PROVIDER="ollama"; $env:MODEL="qwen3:4b"; npm run backend`.

**How progressive translation behaves:** the text on screen is translated first and each block turns into Hinglish as soon as its request finishes; the rest of the page continues in the background (the popup says which). If you scroll, the blocks you scrolled to move to the front of the queue. A block that fails stays English and the page carries on. With Ollama the backend asks the extension to send one request at a time with small batches (6 blocks / 500 characters) so the first visible blocks appear quickly; a paragraph longer than 600 characters is translated as groups of whole sentences and shown as one block. To tune this, set `MAX_CONCURRENCY`, `BATCH_MAX_ITEMS`, `BATCH_MAX_CHARS`, `BATCH_MAX_ITEM_CHARS` in `.env` (the extension's own `maxParallelRequests` can only lower the concurrency further).

**Speed you can expect** (CPU-only machine, `npm run perf`, details in [PROVIDERS](docs/PROVIDERS.md)): pages you translated before appear in about **30 ms** with no model request. New text is real model inference, about **10 s per paragraph** here: the first visible paragraph in about 12 s, seven medium paragraphs in about 74 s, and everything after the visible ones continues in the background. Saved translations are painted before any request is sent, and they never wait behind new text. `npm run perf` measures this on your machine.

Ollama notes: the prompt, validation, caching, batching and viewport-first order are the same as with Gemini; thinking is switched off for Qwen3 and output is schema-constrained JSON. Translations are cached per model, so Ollama and Gemini results never mix. If the backend cannot reach Ollama or the model is missing, the popup says so and names the fix. **Speed depends on your hardware**: on a CPU-only machine expect several seconds per small batch, so the backend already limits Ollama to one request at a time (a second one just queues behind the first), and consider `OLLAMA_KEEP_ALIVE=30m`. Timeouts: backend `REQUEST_TIMEOUT_MS` (40 s for Ollama) must stay under the extension's 45 s.

## Run it

1. **Start the backend** (keep this window open while you use the extension):
   ```
   npm run backend
   ```
   You should see `BhashaFlow backend on http://127.0.0.1:8787 (provider=openai-compat, model=gemini-3.6-flash)`. If it says `provider=mock`, your `.env` was not found or not filled in; mock output is not real Hinglish.
2. **Build the extension**:
   ```
   npm run build
   ```
3. **Load it in Chrome**: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the folder
   ```
   <this project>\extension\dist
   ```
   (after any rebuild, click the reload icon on the BhashaFlow card). Pin the extension to the toolbar if you like.

## Using it

### Language: Hinglish or Tanglish

BhashaFlow writes in one of two languages, both in **Roman script only** (never Devanagari, never Tamil script):

- **Hinglish** (default): conversational Hindi in English letters.
- **Tanglish**: conversational everyday Tamil in English letters, with English technical terms, numbers and acronyms kept as they are.

Choose it with **Translate into** in the popup, or with the language drop-down in the selection panel (changing it re-translates the same selection at once). The choice is remembered. Both languages use the same Claude backend and key; Tanglish has its own prompt (`tanglish-v1`) and Hinglish-v2 is unchanged. Saved translations are kept per language and prompt version, so switching never shows the wrong language. If you switch language on a page you already translated, the next whole-page translate first restores the original English and then translates it into the new language. Output in the wrong script is rejected by the same validation that protects Hinglish.

### Selection mode (default)

1. Open any http(s) page and **select some text** (a sentence, a paragraph, several lines, even across links and bold text).
2. A small **Translate Selection** button appears next to the selection. Selecting alone sends nothing anywhere. (Keyboard: press **Alt+Shift+T** with text selected.)
3. Click it. A compact panel shows the **original**, a loading indicator, then the **Hinglish**. **Copy translation** copies it, **Close** (or **Escape**) dismisses it. If it fails you get a plain message (Ollama not running, model missing, timeout…) and **Try again**.
4. The page itself is never edited: no text is replaced, no elements added inside the page body. Selections you translated before come back instantly from the saved translations, with no model request.

Not offered for: text fields, password fields, editable areas, code editors and code blocks. Selections are limited to 2,000 characters (it takes about 10 s per paragraph on a CPU-only machine; the panel shows the first finished lines while it works). Turn the mode off with **Translate selected text** in the popup. Only the top frame of a page is covered (not embedded iframes).

### Whole page (optional)

Open any normal web page (http or https), click the BhashaFlow icon and use **Translate whole page (optional)**:

| Control | What it does |
|---|---|
| **Translate this page** | Finds the main explanatory text (not ads, menus, buttons, code, headings, existing Hindi) and converts it. What you can see is translated first, then the content just below, then the rest. |
| **Pause / Resume** | Pause stops *new* requests; ones already running finish. Resume continues. |
| **Stop** | Stops processing and keeps what is already translated. Translate again later to finish only the rest. |
| **Restore original English** | Puts the page back exactly as it was (same elements, links and click handlers). |
| **Remember translations on this device** | Reuses earlier translations (below). On by default. |
| **Clear saved translations** | Erases the saved translations. The line under it shows how many are stored and how big they are. |
| **Convert new content on this site** | Per-site opt-in: after you translate, content that loads later (infinite scroll) is converted too. Off by default. |
| Preserve headings / technical terms / existing Hindi, Send page title as AI context | Preferences. Page title and nearest heading are sent only as context to pick the right word sense; turn it off to send neither. |

The status line shows progress (`Translating… 42 of 120 blocks`), how many blocks were reused without a request, and clear errors.

## Free-tier limits, caching and quota

The scarce free resource is **requests per day**, not words. On the key tested, `gemini-3.6-flash` allowed **20 requests per day** (Google may change this; see https://ai.dev/rate-limit). BhashaFlow spends them carefully:

- **Saved translations (IndexedDB, in the extension's own storage).** Every validated translation is saved, so a page you already translated costs **zero requests**, also after restarting the browser. Entries are keyed by the text, its role and nearest heading, the page title, the **prompt version and the model**, so a different prompt, model or page context never reuses an old answer. Only a hash and our Hinglish output are stored, never the English source. Limits: 5,000 entries / about 5 MB / 90 days unused; least-recently-used entries go first.
- **No duplicate requests.** Identical blocks are sent once; identical blocks requested at the same time share one request.
- **Packing.** Up to 12 blocks (1,800 characters) per request. Short blocks (lists, dictionaries, docs) need 2-3x fewer requests than long prose. A typical long article is about 12 requests, so expect **roughly one or two new long articles per day** on the free tier, and revisits are free.
- **Two requests at a time** by default (`maxParallelRequests`, 1-4, in the extension's storage); more parallelism spends the daily quota faster and may trigger per-minute limits.
- **When the daily quota runs out:** the extension stops sending requests, tells you ("The AI provider's daily quota is used up … (about N hours from now)"), shows when it resets under the cache line, and keeps serving everything already saved. The block is remembered per model, also after Chrome restarts the extension's worker, and clears itself at the reset time. Switching `MODEL` in `.env` lifts it. Brief per-minute limits are retried a few times with backoff; daily quota is never retried.

## Privacy and security

- **With Ollama selected, nothing leaves your computer.** The backend talks only to `OLLAMA_BASE_URL` (loopback unless you opt in with `OLLAMA_ALLOW_REMOTE=true`), never loads a cloud key, and has no fallback to another provider. The next bullets describe the Gemini setup.
- **What leaves your browser:** the prose of the main-content blocks you chose to translate (inline code, images and existing Hindi are replaced by a kind label such as `code`), each block's role and nearest heading, and the page title (switch off with *Send page title as AI context*). It goes to your local backend and from there to Google's API.
- **What never leaves:** page URLs, ads, navigation, sidebars, code, form fields, buttons, headings (when preserved), existing Hindi, anything you did not translate.
- **Your key** exists only in `.env` (git-ignored). It is not in the extension, not in the build, not in logs, and never returned to the page. The backend logs only counts and timings.
- **Permissions:** `activeTab`, `scripting`, `storage`, `http://localhost:8787/*` (your own backend), and one content script (`selection.js`) on http(s) pages so the Translate Selection button can appear. Chrome therefore shows "read and change your data on all websites" when you install. That script is inert: it only watches for a selection, reads **only the text you selected and then click Translate on**, makes no network request itself (it can only message the extension's worker) and changes nothing in the page. The whole-page translator is still injected only when you click it. No `<all_urls>`, no background reading.

## Developing

```
npm test            # all offline tests (no network, no API key, no quota)
npm run build       # extension -> extension/dist  (BHASHAFLOW_BACKEND_URL to change the backend origin; https or localhost only)
npm run backend     # local backend
npm run perf        # perceived-speed measurements with the configured provider (local with Ollama)
npm run bench -- --provider openai-compat --prompt hinglish-v2   # live benchmark: USES API QUOTA
node scripts/rescore.js benchmark/results/<file>.json            # free re-scoring of a saved run
```

`__bhashaflow.explain()` in the page's DevTools console lists why each text block was converted or skipped. `PROMPT_VERSION=hinglish-v1` switches back to the original prompt (kept unchanged for comparison). More: [ARCHITECTURE](docs/ARCHITECTURE.md), [VERIFICATION](docs/VERIFICATION.md), [PROVIDERS](docs/PROVIDERS.md), [benchmark reports](docs/BENCHMARK-hinglish-v2-comparison.md), [ROADMAP](ROADMAP.md).

## Known limitations

- **Hinglish quality is good, not perfect.** On the 25-case benchmark about 20 of 25 outputs were clean and 2 had moderate slips (a wrong verb form, a stray added word). Definitions are the weakest. It never changes numbers, acronyms, code or markup (that is enforced), but meaning checks beyond that are heuristic. Skim important text.
- **Free-tier ceiling** (above): about 1-2 new long articles a day on the key tested. Pages you have seen are free.
- **Speed:** a long article takes tens of seconds with two parallel requests (it is limited by the model's speed); what is on screen appears first.
- **Page coverage:** it does not look inside shadow DOM or iframes, and an ad with no ad-like markup placed inside the article body can be mistaken for prose. Blocks over 3,900 characters are skipped ("too long"). Text appended into an already-translated block is not re-translated. Very long pages are capped at 3,000 blocks per run.
- **The backend must be running** on your machine (`npm run backend`); the extension says so if it is not.
- **Saved translations are per browser profile** and are not shared across devices.
- **Verification boundary:** the extension was tested with offline simulations of Chrome's APIs and in a real Chrome tab for the page engine, scheduler, cache and IndexedDB. Loading the packed extension through `chrome://extensions` could not be automated here: see [docs/VERIFICATION.md](docs/VERIFICATION.md).
