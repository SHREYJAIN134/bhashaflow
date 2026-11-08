export class ProviderError extends Error {
  /**
   * code: auth | rate-limit | quota-exhausted | timeout | unavailable | bad-request | bad-json | network
   *       | truncated | empty-response
   * retryAfterSec: how long the provider asked us to wait, when it said.
   */
  constructor(code, message, { status, retryable = false, retryAfterSec } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    if (retryAfterSec !== undefined) this.retryAfterSec = retryAfterSec;
  }
}

// A 429 is a quota problem (do NOT retry) rather than a brief rate limit (retry with backoff) when the
// provider names a per-day / insufficient quota, or asks us to wait longer than any sensible retry.
const QUOTA_MARKERS = /per[-_ ]?day|daily|requestsperday|insufficient_quota/i;
export const MAX_TRANSIENT_WAIT_SEC = 60;

/** "72714s" | "12.5s" | 12 -> seconds, else undefined. */
function toSeconds(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)s?$/);
  return m ? Number(m[1]) : undefined;
}

function waitPhrase(sec) {
  if (sec === undefined) return '';
  if (sec >= 5400) return ` (about ${Math.round(sec / 3600)} hours from now)`;
  if (sec >= 90) return ` (about ${Math.round(sec / 60)} minutes from now)`;
  return ` (in about ${Math.ceil(sec)} seconds)`;
}

/** Actionable text for the extension. Contains no provider internals, request content or credentials. */
export function quotaMessage(retryAfterSec) {
  return `The AI provider's daily quota is used up, so no more requests can be made until it resets${waitPhrase(retryAfterSec)}. ` +
    'Wait for the reset, or set a different MODEL in the backend .env.';
}

/** Maps a failed HTTP response to a ProviderError without echoing request content or credentials. */
export async function errorFromResponse(res, secret = '') {
  let detail = '';
  let err = null;
  try {
    const body = await res.json();
    err = (Array.isArray(body) ? body[0] : body)?.error ?? null; // Gemini's OpenAI endpoint may wrap errors in an array
    detail = String((err && (err.message || err.type)) || (body && body.message) || '').slice(0, 200);
    if (secret) detail = detail.split(secret).join('[redacted]'); // a provider must never be able to echo our key back
  } catch { /* non-JSON error body */ }
  const status = res.status;

  if (status === 401 || status === 403) return new ProviderError('auth', 'Provider rejected the credentials', { status });

  if (status === 429) {
    const details = Array.isArray(err?.details) ? err.details : [];
    const violations = details.flatMap((d) => (Array.isArray(d.violations) ? d.violations : []));
    const markers = [...violations.map((v) => `${v.quotaId ?? ''} ${v.quotaMetric ?? ''}`), err?.code, err?.type].join(' ');
    const retryAfterSec = toSeconds(details.find((d) => d.retryDelay !== undefined)?.retryDelay)
      ?? toSeconds(res.headers?.get?.('retry-after'));
    const quota = QUOTA_MARKERS.test(markers) || (retryAfterSec !== undefined && retryAfterSec > MAX_TRANSIENT_WAIT_SEC);
    if (quota) return new ProviderError('quota-exhausted', quotaMessage(retryAfterSec), { status, retryable: false, retryAfterSec });
    return new ProviderError('rate-limit', 'Provider rate limit reached', { status, retryable: true, retryAfterSec });
  }

  if (status === 408 || status === 409 || status >= 500) {
    return new ProviderError('unavailable', `Provider unavailable (${status})`, { status, retryable: true });
  }
  return new ProviderError('bad-request', `Provider rejected the request (${status}) ${detail}`.trim(), { status });
}
