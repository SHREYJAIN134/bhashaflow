// All configuration comes from environment variables. Secrets never leave this process.
// See .env.example. Node loads .env with --env-file (see `npm run backend`).

const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const optInt = (value, fallback) => { const n = Number.parseInt(value, 10); return Number.isFinite(n) && n > 0 ? n : fallback; };
// Like int(), but 0 is a valid choice (for example RETRIES=0 disables retries).
const nonNegInt = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

import { getPrompt } from './prompts/index.js';
import { OLLAMA_DEFAULT_BASE_URL, OLLAMA_DEFAULT_MODEL, resolveOllamaUrl } from './providers/ollama.js';

const DEFAULT_TEMPERATURE = 0.3;

function temperature(value) {
  if (value === undefined || String(value).trim() === '') return DEFAULT_TEMPERATURE;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new Error(`TEMPERATURE must be a number between 0 and 2 (got "${value}")`);
  return n;
}

const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'];

function reasoningEffort(value) {
  const v = (value || '').trim().toLowerCase();
  if (v && !REASONING_EFFORTS.includes(v)) throw new Error(`REASONING_EFFORT must be one of ${REASONING_EFFORTS.join(', ')} (got "${v}")`);
  return v;
}

export function loadConfig(env = process.env) {
  const provider = (env.PROVIDER || 'mock').toLowerCase();
  const ollama = provider === 'ollama';
  const anthropic = provider === 'anthropic';
  // Local models are slower than hosted ones, so Ollama gets a longer default timeout (still under the
  // extension's 45 s limit, so the backend can report a clear timeout first) and one retry (for a repetition loop that hit the
  // token budget; timeouts are not retried).
  const ollamaAllowRemote = /^(1|true|yes)$/i.test(env.OLLAMA_ALLOW_REMOTE || '');
  return {
    port: int(env.PORT, 8787),
    provider, // ollama | openai-compat | anthropic | mock
    model: env.MODEL || (ollama ? OLLAMA_DEFAULT_MODEL : anthropic ? 'claude-haiku-5-5' : ''),
    // Ollama needs no key; none is loaded, so a cloud key in .env can never travel with local requests.
    // Claude uses ONLY ANTHROPIC_API_KEY: LLM_API_KEY may hold another provider's key (Gemini), which must never be sent to Anthropic.
    anthropicThinking: (env.ANTHROPIC_THINKING || 'disabled').trim().toLowerCase(), // disabled | adaptive (Claude 5 models)
    anthropicEffort: (env.ANTHROPIC_EFFORT || 'low').trim().toLowerCase(), // low | medium | high
    apiKey: ollama ? '' : anthropic ? (env.ANTHROPIC_API_KEY || '') : env.LLM_API_KEY || env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || env.GROQ_API_KEY || env.GEMINI_API_KEY || '',
    ollamaBaseUrl: ollama ? resolveOllamaUrl(env.OLLAMA_BASE_URL || OLLAMA_DEFAULT_BASE_URL, ollamaAllowRemote) : '',
    ollamaAllowRemote,
    ollamaNumCtx: int(env.OLLAMA_NUM_CTX, 8192), // context window; Ollama's own default (4096) can silently cut the prompt
    ollamaKeepAlive: env.OLLAMA_KEEP_ALIVE || '', // e.g. 30m; empty = Ollama default
    baseUrl: ollama ? '' : env.BASE_URL || '', // openai-compat endpoint root, e.g. https://api.groq.com/openai/v1
    maxTokensParam: env.MAX_TOKENS_PARAM || 'max_tokens', // some OpenAI models need max_completion_tokens
    promptVersion: getPrompt(env.PROMPT_VERSION || undefined).version, // hinglish-v1 | hinglish-v2 (default)
    reasoningEffort: reasoningEffort(env.REASONING_EFFORT), // '' = do not send; none for reasoning models
    temperature: temperature(env.TEMPERATURE), // default 0.3; 0-2
    requestTimeoutMs: int(env.REQUEST_TIMEOUT_MS, ollama ? 40000 : 30000),
    retries: nonNegInt(env.RETRIES, ollama ? 1 : 2), // extra attempts for TRANSIENT errors only; quota exhaustion is never retried
    retryBaseMs: int(env.RETRY_BASE_MS, 300), // backoff = base * 2^attempt (+ small jitter)
    maxRetryWaitMs: int(env.MAX_RETRY_WAIT_MS, 10000), // if the provider asks for a longer wait, fail instead of retrying
    // Scheduling hints the extension reads from /health. Unset = the extension keeps its own defaults.
    // Local models decode slowly, so Ollama gets one request at a time and small batches: the first
    // visible blocks appear after one short request instead of after a page-sized one.
    hints: {
      maxConcurrency: optInt(env.MAX_CONCURRENCY, ollama ? 1 : undefined),
      firstBatchItems: optInt(env.FIRST_BATCH_ITEMS, ollama ? 1 : undefined), // first request only: the top visible block does not wait for neighbours
      batch: {
        maxItems: optInt(env.BATCH_MAX_ITEMS, ollama ? 6 : undefined),
        maxChars: optInt(env.BATCH_MAX_CHARS, ollama ? 500 : undefined),
        maxItemChars: optInt(env.BATCH_MAX_ITEM_CHARS, ollama ? 600 : undefined), // longer blocks are sent as sentence groups
      },
    },
    tokenBudget: ollama ? { base: 40, perItem: 25, perChar: 0.9 } : { base: 400, perItem: 0, perChar: 1.1 },
    retryTimeouts: !ollama,
    maxItemsPerCall: int(env.MAX_ITEMS_PER_CALL, 12),
    maxCharsPerCall: int(env.MAX_CHARS_PER_CALL, 8000),
    rateLimitPerMin: int(env.RATE_LIMIT_PER_MIN, 60),
    accessToken: env.ACCESS_TOKEN || '', // optional shared secret for private deployments
    allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    limits: { maxItems: 40, maxItemChars: 4000, maxTotalChars: 40000, maxBodyBytes: 256 * 1024 },
  };
}
