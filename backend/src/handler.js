import { ATOM_KINDS } from '../../extension/src/shared/tokens.js';
import { createRateLimiter } from './limits.js';
import { DEFAULT_LANGUAGE, isLanguage } from '../../extension/src/shared/languages.js';

const ROLES = new Set(['paragraph', 'list-item', 'definition', 'caption', 'table-cell', 'selection']);
const INSTALL_ID = /^[A-Za-z0-9-]{16,64}$/;
const ATOM_TOKEN = /⟦\d+=([^⟧]*)⟧/g;

const fail = (status, code, message, extra = {}, detail = {}) => ({ status, body: { error: { code, message, ...detail } }, ...extra });

// What the extension shows when every model call failed. Messages are ours, never the provider's text.
const FATAL = {
  auth: [502, 'The AI provider rejected the API key. Check the key for your provider in the backend .env (ANTHROPIC_API_KEY for Claude).'],
  refused: [502, 'The AI model declined to translate this text.'],
  'rate-limit': [503, 'The AI provider is rate limiting requests. Wait a minute and try again.'],
  timeout: [504, 'The AI provider took too long to answer. Try again.'],
  'bad-json': [502, 'The AI model returned a malformed answer. Try again, or use a larger model.'],
};
// Local-model failures: the message is written by our adapter (no remote text) and names the fix.
const LOCAL_FATAL = new Set(['ollama-not-running', 'ollama-model-missing', 'no-credit', 'model-not-found', 'invalid-settings']);
/** Only the hints that are set, so a backend without any looks exactly as before. */
function healthHints(hints) {
  if (!hints) return {};
  const batch = Object.fromEntries(Object.entries(hints.batch || {}).filter(([, v]) => v !== undefined));
  return {
    ...(hints.maxConcurrency !== undefined ? { maxConcurrency: hints.maxConcurrency } : {}),
    ...(hints.firstBatchItems !== undefined ? { firstBatchItems: hints.firstBatchItems } : {}),
    ...(Object.keys(batch).length ? { batch } : {}),
  };
}
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);

/**
 * Validates and normalises a request body. Anything unexpected is rejected, not repaired.
 * Enforces the privacy rule server-side too: atomic placeholders may only carry a KIND, never content.
 */
export function validateRequest(body, limits) {
  if (!body || typeof body !== 'object' || body.v !== 1) return { error: 'body must be an object with v: 1' };
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > limits.maxItems) {
    return { error: `items must contain 1-${limits.maxItems} entries` };
  }
  const ids = new Set();
  let total = 0;
  const items = [];
  for (const it of body.items) {
    if (!it || !Number.isInteger(it.id) || it.id < 0 || it.id > 100000 || ids.has(it.id)) return { error: 'each item needs a unique integer id' };
    if (typeof it.text !== 'string' || !it.text.trim() || it.text.length > limits.maxItemChars) {
      return { error: `item text must be a non-empty string up to ${limits.maxItemChars} characters` };
    }
    for (const m of it.text.matchAll(ATOM_TOKEN)) {
      if (!ATOM_KINDS.has(m[1])) return { error: 'atomic placeholders may carry only a kind (code, img, br, ui, hi, x)' };
    }
    if (it.role !== undefined && !ROLES.has(it.role)) return { error: 'unknown role' };
    ids.add(it.id);
    total += it.text.length;
    items.push({ id: it.id, text: it.text, role: it.role, heading: str(it.heading, 200) });
  }
  if (total > limits.maxTotalChars) return { error: `total text exceeds ${limits.maxTotalChars} characters` };
  if (body.lang !== undefined && !isLanguage(body.lang)) return { error: 'lang must be "hinglish" or "tanglish"' };
  const page = body.page && typeof body.page === 'object' ? { title: str(body.page.title, 200) } : {};
  return { value: { page, items, lang: body.lang || DEFAULT_LANGUAGE } };
}

/**
 * Transport-independent request handler (used by the local server and the Vercel function).
 * req: { method, path, headers (lower-case), body (parsed JSON or undefined), ip }
 */
export function createHandler({ engine, config, log = () => {}, now = Date.now }) {
  const limiter = createRateLimiter({ limit: config.rateLimitPerMin, now });

  return async function handle(req) {
    if (req.method === 'GET' && req.path === '/health') {
      // promptVersion + model let the extension key its cache so translations from different prompts/models never mix.
      return { status: 200, body: { ok: true, provider: config.provider, model: (engine.provider && engine.provider.model) || config.model || undefined, promptVersion: config.promptVersion, ...healthHints(config.hints) } };
    }
    if (req.path !== '/v1/rewrite') return fail(404, 'not-found', 'Unknown endpoint');
    if (req.method !== 'POST') return fail(405, 'method-not-allowed', 'Use POST');

    if (config.accessToken && req.headers['x-bf-token'] !== config.accessToken) return fail(401, 'unauthorized', 'Missing or invalid access token');

    const install = req.headers['x-bf-install'];
    const key = install && INSTALL_ID.test(install) ? `i:${install}` : `ip:${req.ip || 'unknown'}`;
    const rate = limiter.check(key);
    if (!rate.ok) return fail(429, 'rate-limited', 'Too many requests', { headers: { 'retry-after': String(rate.retryAfterSec) } });

    const parsed = validateRequest(req.body, config.limits);
    if (parsed.error) return fail(400, 'invalid-request', parsed.error);

    const t0 = Date.now();
    const out = await engine.rewrite(parsed.value);
    const failed = out.results.filter((r) => r.error).length;
    // Metadata only: no page text, titles or URLs are ever logged.
    log({ items: parsed.value.items.length, failed, ms: Date.now() - t0, calls: out.meta.calls, retries: out.meta.retries,
      inputTokens: out.meta.inputTokens, outputTokens: out.meta.outputTokens });

    if (out.fatal) {
      if (out.fatal === 'quota-exhausted') {
        const retryAfterSec = out.fatalDetail && out.fatalDetail.retryAfterSec;
        return fail(503, 'provider-quota-exhausted', out.fatalDetail.message, {}, retryAfterSec !== undefined ? { retryAfterSec } : {});
      }
      if (LOCAL_FATAL.has(out.fatal)) return fail(503, `provider-${out.fatal}`, out.fatalDetail.message);
      const [status, message] = FATAL[out.fatal] || [502, 'The AI provider could not complete the request'];
      return fail(status, `provider-${out.fatal}`, message);
    }
    return { status: 200, body: { results: out.results, meta: out.meta } };
  };
}
