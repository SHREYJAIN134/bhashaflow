import { sourceFromTemplate } from '../../extension/src/shared/tokens.js';
import { buildUserMessage, getPrompt } from './prompt.js';
import { getSelectionPrompt, getPromptForLanguage } from './prompts/index.js';
import { DEFAULT_LANGUAGE } from '../../extension/src/shared/languages.js';
import { validateItem } from './validate.js';
import { ProviderError } from './providers/errors.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunkItems(items, maxItems, maxChars) {
  const chunks = [];
  let current = [];
  let chars = 0;
  for (const it of items) {
    if (current.length && (current.length >= maxItems || chars + it.text.length > maxChars)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(it);
    chars += it.text.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** Extracts {"results":[...]} from a model reply, tolerating code fences and stray prose. */
export function parseModelReply(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new ProviderError('bad-json', 'Model reply was not JSON', { retryable: true });
  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new ProviderError('bad-json', 'Model reply was not valid JSON', { retryable: true });
  }
  if (!data || !Array.isArray(data.results)) throw new ProviderError('bad-json', 'Model reply had no results array', { retryable: true });
  const answers = new Map();
  for (const r of data.results) if (r && Number.isInteger(r.id) && typeof r.hinglish === 'string') answers.set(r.id, r.hinglish);
  return answers;
}

/**
 * The translation engine: provider-independent. Takes validated request items, returns one result per
 * item: { id, hinglish } or { id, error: { code, message } }. Nothing invalid is ever returned as a result.
 */
export function createEngine({ provider, config, log = () => {}, onAttempt = () => {} }) {
  const prompt = getPrompt(config.promptVersion);
  const selectionPrompt = getSelectionPrompt(config.promptVersion);
  // Output budget. Hosted models: generous (400 + 1.1 x source chars). A local model decodes ~5 tokens/s, so a generous cap
  // lets one repetition loop ("bhi bhi bhi ...") hold the only inference slot for minutes; Ollama gets a tight budget
  // (about 2x what a normal Hinglish answer needs) that bounds that damage.
  const budget = config.tokenBudget || { base: 400, perItem: 0, perChar: 1.1 };
  const maxTokensFor = (items) => Math.min(8000, Math.ceil(budget.base + budget.perItem * items.length + budget.perChar * items.reduce((n, i) => n + i.text.length, 0)));

  async function callOnce(system, user, maxTokens) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      return await provider.complete({ system, user, maxTokens, signal: controller.signal });
    } catch (err) {
      // A local model that timed out is usually still busy; retrying only queues more work behind it (config.retryTimeouts=false).
      if (err.name === 'AbortError') throw new ProviderError('timeout', 'Provider timed out', { retryable: config.retryTimeouts !== false });
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** One model call with retries on transient failures. Returns { answers, usage }. */
  async function callModel(page, items, fixes, stats, lang) {
    const user = buildUserMessage({ page, items, fixes });
    for (let attempt = 0; ; attempt++) {
      try {
        stats.calls++;
        // Selected text (role "selection") gets the compact prompt; everything else the full hinglish-v2 prompt.
        const system = getPromptForLanguage(lang, { version: config.promptVersion, selection: items.every((i) => i.role === 'selection') }).system;
        const { text, usage } = await callOnce(system, user, maxTokensFor(items));
        stats.inputTokens += usage?.inputTokens || 0;
        stats.outputTokens += usage?.outputTokens || 0;
        return parseModelReply(text);
      } catch (err) {
        // Only transient failures are retried, and only a bounded number of times. Quota exhaustion
        // (retryable=false) and provider waits longer than we are willing to sit through are not.
        if (!err.retryable || attempt >= config.retries) throw err;
        const maxWaitMs = config.maxRetryWaitMs ?? 10000;
        if (err.retryAfterSec !== undefined && err.retryAfterSec * 1000 > maxWaitMs) throw err;
        const baseMs = config.retryBaseMs ?? 300;
        stats.retries++;
        await sleep(Math.max(baseMs * 2 ** attempt + Math.random() * baseMs * 0.5, (err.retryAfterSec || 0) * 1000));
      }
    }
  }

  async function rewrite({ page, items, lang = DEFAULT_LANGUAGE }) {
    const t0 = Date.now();
    const stats = { calls: 0, retries: 0, repaired: 0, inputTokens: 0, outputTokens: 0 };
    const rejections = []; // { id, attempt, issue }: ids and reasons only, never text
    const results = new Map();
    const ready = [];
    for (const it of items) {
      const source = sourceFromTemplate(it.text);
      if (source) ready.push({ ...it, source });
      else results.set(it.id, { id: it.id, error: { code: 'bad-template', message: 'Malformed placeholder template' } });
    }

    const providerErrors = [];
    let fatalDetail = null; // first provider error, for an actionable message
    const chunks = chunkItems(ready, config.maxItemsPerCall, config.maxCharsPerCall);
    await Promise.all(chunks.map(async (chunk) => {
      try {
        const answers = await callModel(page, chunk, {}, stats, lang);
        const failed = [];
        for (const it of chunk) {
          const v = validateItem(it, answers.get(it.id), lang);
          onAttempt({ id: it.id, attempt: 1, ok: v.ok, issue: v.ok ? null : v.issue, output: answers.get(it.id) });
          if (v.ok) results.set(it.id, { id: it.id, hinglish: answers.get(it.id) });
          else { rejections.push({ id: it.id, attempt: 1, issue: v.issue }); failed.push({ it, issue: v.issue }); }
        }
        if (failed.length) { // one repair pass, only for the rejected items
          stats.repaired += failed.length;
          const fixes = Object.fromEntries(failed.map(({ it, issue }) => [it.id, issue]));
          const retryAnswers = await callModel(page, failed.map((f) => f.it), fixes, stats, lang);
          for (const { it } of failed) {
            const v = validateItem(it, retryAnswers.get(it.id), lang);
            onAttempt({ id: it.id, attempt: 2, ok: v.ok, issue: v.ok ? null : v.issue, output: retryAnswers.get(it.id) });
            if (!v.ok) rejections.push({ id: it.id, attempt: 2, issue: v.issue });
            results.set(it.id, v.ok
              ? { id: it.id, hinglish: retryAnswers.get(it.id) }
              : { id: it.id, error: { code: 'invalid-output', message: v.issue } });
          }
        }
      } catch (err) {
        const code = err instanceof ProviderError ? err.code : 'internal';
        providerErrors.push(code);
        if (err instanceof ProviderError && !fatalDetail) fatalDetail = { message: err.message, retryAfterSec: err.retryAfterSec };
        for (const it of chunk) {
          if (!results.has(it.id)) results.set(it.id, { id: it.id, error: { code, message: err instanceof ProviderError ? err.message : 'Internal error' } });
        }
      }
    }));

    const ordered = items.map((it) => results.get(it.id));
    const allProviderFailed = chunks.length > 0 && providerErrors.length === chunks.length;
    return {
      results: ordered,
      fatal: allProviderFailed ? providerErrors[0] : null,
      fatalDetail: allProviderFailed ? fatalDetail : null,
      meta: {
        provider: provider.name, model: provider.model, promptVersion: getPromptForLanguage(lang, { version: config.promptVersion }).version, lang,
        latencyMs: Date.now() - t0, ...stats, rejections,
      },
    };
  }

  return { rewrite, provider: { name: provider.name, model: provider.model } };
}
