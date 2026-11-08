// Small in-memory fixed-window rate limiter. Per process: on serverless hosts each instance has its
// own counters, so treat it as a safety net and rely on the provider-side spend cap as the real limit.

export function createRateLimiter({ limit, windowMs = 60_000, now = Date.now }) {
  const buckets = new Map();
  return {
    /** Returns { ok, retryAfterSec }. */
    check(key) {
      const t = now();
      let b = buckets.get(key);
      if (!b || t >= b.resetAt) {
        b = { count: 0, resetAt: t + windowMs };
        buckets.set(key, b);
        if (buckets.size > 5000) for (const [k, v] of buckets) if (t >= v.resetAt) buckets.delete(k);
      }
      b.count++;
      return b.count <= limit ? { ok: true } : { ok: false, retryAfterSec: Math.ceil((b.resetAt - t) / 1000) };
    },
  };
}
