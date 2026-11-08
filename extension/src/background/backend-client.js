// Talks to the BhashaFlow backend. Runs in the service worker (not the page), so page CSP/CORS never
// applies and no credential or backend URL is exposed to websites. The backend holds the LLM key;
// this client only sends an anonymous per-install id (for rate limiting) and an optional access token.

export async function callBackend({ baseUrl, payload, installId, token, fetchImpl = fetch, timeoutMs = 45000, retryNetwork = true }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/v1/rewrite`;
  const headers = { 'content-type': 'application/json', 'x-bf-install': installId };
  if (token) headers['x-bf-token'] = token;

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
      let body = null;
      try { body = await res.json(); } catch { /* non-JSON error page */ }
      if (res.ok && body && Array.isArray(body.results)) return { ok: true, data: body };
      const err = (body && body.error) || {};
      return { ok: false, error: { code: err.code || `http-${res.status}`, message: err.message || `Backend returned ${res.status}`, ...(err.retryAfterSec !== undefined ? { retryAfterSec: err.retryAfterSec } : {}) } };
    } catch (e) {
      if (e.name === 'AbortError') return { ok: false, error: { code: 'timeout', message: 'The backend took too long to answer' } };
      if (retryNetwork && attempt === 0) continue; // one retry for a transient network failure
      return { ok: false, error: { code: 'unreachable', message: 'Could not reach the BhashaFlow backend. Is it running?' } };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Scheduling hints from GET /health (see backend config `hints`): how many requests may run at once and how big a
 * request should be. Only sane positive integers are passed on; anything else is ignored, and an unreachable
 * backend gives {} (the extension's own defaults). Cached for `ttlMs`.
 */
export function createBackendHints({ baseUrl, fetchImpl = fetch, now = Date.now, ttlMs = 5 * 60 * 1000, timeoutMs = 4000 }) {
  let memo = null;
  const posInt = (v) => (Number.isInteger(v) && v > 0 && v <= 1e6 ? v : undefined);
  return async function getHints() {
    if (memo && now() - memo.at < ttlMs) return memo.hints;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/health`, { signal: controller.signal });
      const body = res.ok ? await res.json() : null;
      if (body && typeof body === 'object') {
        const b = body.batch && typeof body.batch === 'object' ? body.batch : {};
        const batch = Object.fromEntries(['maxItems', 'maxChars', 'maxItemChars'].map((k) => [k, posInt(b[k])]).filter(([, v]) => v !== undefined));
        const hints = { ...(posInt(body.maxConcurrency) ? { maxConcurrency: body.maxConcurrency } : {}), ...(posInt(body.firstBatchItems) ? { firstBatchItems: body.firstBatchItems } : {}), ...(Object.keys(batch).length ? { batch } : {}) };
        memo = { hints, at: now() };
        return hints;
      }
    } catch { /* unreachable: the extension's defaults apply */ } finally {
      clearTimeout(timer);
    }
    return memo ? memo.hints : {};
  };
}

/**
 * Which prompt version and model the backend is running, from GET /health (a free endpoint: it never calls the
 * LLM, so it costs no quota). Used to version the cache. Cached for `ttlMs`; if the backend is unreachable the
 * last known value is used so the cache can still serve reads.
 */
export function createBackendInfo({ baseUrl, fetchImpl = fetch, now = Date.now, ttlMs = 5 * 60 * 1000, timeoutMs = 4000, load = async () => null, save = async () => {} }) {
  let memo = null; // { info, at }
  return async function getInfo() {
    if (memo && now() - memo.at < ttlMs) return memo.info;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/health`, { signal: controller.signal });
      const body = res.ok ? await res.json() : null;
      if (body && typeof body.promptVersion === 'string') {
        const info = { promptVersion: body.promptVersion, model: typeof body.model === 'string' ? body.model : '' };
        memo = { info, at: now() };
        await save(info);
        return info;
      }
    } catch { /* unreachable: fall through to the last known value */ } finally {
      clearTimeout(timer);
    }
    const last = memo ? memo.info : await load();
    return last && typeof last.promptVersion === 'string' ? last : null;
  };
}
