import { ProviderError } from './errors.js';

export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
export const OLLAMA_DEFAULT_MODEL = 'qwen3:4b';

// Structured output: Ollama constrains decoding to this schema. Plain format:"json" let a 4B model echo the
// request JSON back instead of answering. The shape is the one hinglish-v2 already asks for.
export const RESULT_SCHEMA = {
  type: 'object',
  properties: { results: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, hinglish: { type: 'string' } }, required: ['id', 'hinglish'] } } },
  required: ['results'],
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Normalises OLLAMA_BASE_URL. Page text must stay on this machine, so a non-loopback host needs an explicit opt-in. */
export function resolveOllamaUrl(baseUrl, allowRemote = false) {
  let url;
  try { url = new URL(baseUrl || OLLAMA_DEFAULT_BASE_URL); } catch { throw new Error(`OLLAMA_BASE_URL is not a valid URL (got "${baseUrl}")`); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('OLLAMA_BASE_URL must start with http:// or https://');
  if (!allowRemote && !LOOPBACK.has(url.hostname)) {
    throw new Error(`OLLAMA_BASE_URL points at "${url.hostname}", which is not this machine. Page text would leave it. Use http://127.0.0.1:11434, or set OLLAMA_ALLOW_REMOTE=true if you really run Ollama elsewhere.`);
  }
  return url.origin;
}

// Qwen3 can emit its reasoning inline as <think>...</think> (older Ollama, or a model that ignores think:false).
// It must never reach a translation.
const stripThinking = (text) => text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim();

async function readErrorText(res) {
  try { const body = await res.json(); return String(body?.error || '').slice(0, 200); } catch { return ''; }
}

/**
 * Local Ollama server (https://github.com/ollama/ollama), native /api/chat. No API key, and the only host this
 * adapter ever contacts is `baseUrl`: nothing here (or in the engine) falls back to another provider.
 */
export function createOllamaProvider({
  model = OLLAMA_DEFAULT_MODEL, ollamaBaseUrl, ollamaAllowRemote = false, temperature, ollamaNumCtx = 8192, ollamaKeepAlive = '', fetchImpl = fetch,
}) {
  const root = resolveOllamaUrl(ollamaBaseUrl, ollamaAllowRemote);
  const modelName = model || OLLAMA_DEFAULT_MODEL;

  async function post(body, signal) {
    try {
      return await fetchImpl(`${root}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new ProviderError('ollama-not-running',
        `Could not reach Ollama at ${root}. Start it (run "ollama serve", or open the Ollama app) and try again.`, { retryable: false });
    }
  }

  return {
    name: 'ollama',
    model: modelName,
    async complete({ system, user, maxTokens, signal }) {
      const body = {
        model: modelName,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        stream: false,
        think: false, // Qwen3: no reasoning phase (latency, and no reasoning text in translations)
        format: RESULT_SCHEMA,
        options: { num_ctx: ollamaNumCtx, num_predict: maxTokens, ...(Number.isFinite(temperature) ? { temperature } : {}) },
        ...(ollamaKeepAlive ? { keep_alive: ollamaKeepAlive } : {}),
      };
      let res = await post(body, signal);
      let detail = res.ok ? '' : await readErrorText(res);
      if (res.status === 400 && /think/i.test(detail)) {
        // A model without a thinking mode can reject the field; it has nothing to disable, so ask again without it.
        delete body.think;
        res = await post(body, signal);
        detail = res.ok ? '' : await readErrorText(res);
      }
      if (!res.ok) {
        if (res.status === 404 && /model|not found/i.test(detail)) {
          throw new ProviderError('ollama-model-missing', `Ollama does not have the model "${modelName}". Install it with: ollama pull ${modelName}`, { status: 404 });
        }
        if (res.status === 408 || res.status === 429 || res.status >= 500) {
          throw new ProviderError('unavailable', `Ollama is busy or failed (${res.status})`, { status: res.status, retryable: true });
        }
        throw new ProviderError('bad-request', `Ollama rejected the request (${res.status}) ${detail}`.trim(), { status: res.status });
      }

      let data;
      try { data = await res.json(); } catch { throw new ProviderError('bad-json', 'Ollama sent a reply that is not JSON', { retryable: true }); }
      if (typeof data?.message?.content !== 'string') {
        throw new ProviderError('bad-json', 'Ollama sent a reply in an unexpected shape', { retryable: true });
      }
      const text = stripThinking(data.message.content);
      // Small local models sometimes fall into a repetition loop that only the token budget stops. That is random, so unlike a
      // hosted model's deterministic truncation a second attempt usually succeeds: retryable.
      if (data.done_reason === 'length') throw new ProviderError('truncated', 'Model output was cut off at the token limit', { retryable: true });
      if (!text) throw new ProviderError('empty-response', 'Model returned an empty response', { retryable: true });
      return { text, usage: { inputTokens: data.prompt_eval_count ?? 0, outputTokens: data.eval_count ?? 0 } };
    },
  };
}
