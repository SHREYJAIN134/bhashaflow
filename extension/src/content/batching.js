// Request packing. Requests (not tokens) are the scarce resource on a free API tier, so each request
// carries as many blocks as it safely can, bounded by:
//   - maxItems / maxItemChars: well inside the backend's validation limits (40 items, 4000 chars/item)
//   - maxChars: keeps one request to ONE model call (the backend splits >12 items or >8000 chars) and, more
//     importantly, keeps the model's answer inside the 30 s request timeout. Derivation (measured in the
//     Phase 3 runs): Hinglish output is ~0.37 tokens per source char, ~60 tokens of JSON overhead, and the
//     model decoded at ~43 tokens/s end to end, so 1800 chars -> ~730 tokens -> ~18 s, leaving ~40% headroom
//     under 30 s. Do not raise this without re-measuring; do not raise the timeout instead.
// Packing is greedy and keeps document order, so the top of the page is translated first and each
// request's blocks sit near each other (better heading context).

export const BATCH_LIMITS = Object.freeze({ maxItems: 12, maxChars: 1800, maxItemChars: 3900 });

/** Rough latency of one full request, from the measured constants above. Used by tests to guard the budget. */
export function estimateRequestSeconds(chars) {
  return (chars * 0.371 + 60) / 43 + 1;
}

/**
 * entries: any array; lengthOf(entry) -> source characters.
 * Returns { batches, oversized }. Items longer than maxItemChars can never be sent (the backend would reject
 * the whole request), so they are returned separately and the caller reports them without a request.
 */
export function packBatches(entries, lengthOf, limits = BATCH_LIMITS) {
  const batches = [];
  const oversized = [];
  let current = [];
  let chars = 0;
  const flush = () => {
    if (current.length) batches.push(current);
    current = [];
    chars = 0;
  };
  for (const entry of entries) {
    const len = lengthOf(entry);
    if (len > limits.maxItemChars) { oversized.push(entry); continue; }
    if (len > limits.maxChars) { flush(); batches.push([entry]); continue; } // a long paragraph travels alone
    if (current.length && (current.length >= limits.maxItems || chars + len > limits.maxChars)) flush();
    current.push(entry);
    chars += len;
  }
  flush();
  return { batches, oversized };
}

/**
 * Takes the next request's worth of entries off the FRONT of a (priority-ordered) queue, using the same rules
 * as packBatches. Used by the scheduler so the most important blocks always go first. Mutates `queue`.
 */
export function takeBatch(queue, limits, lengthOf) {
  const batch = [];
  let chars = 0;
  while (queue.length) {
    const len = lengthOf(queue[0]);
    if (len > limits.maxChars) { // a long paragraph travels alone
      if (batch.length) break;
      batch.push(queue.shift());
      break;
    }
    if (batch.length && (batch.length >= limits.maxItems || chars + len > limits.maxChars)) break;
    batch.push(queue.shift());
    chars += len;
  }
  return batch;
}

/** Fixed-size chunks for converters that do not pack by size (the offline mock). */
export function chunk(entries, size) {
  const out = [];
  for (let i = 0; i < entries.length; i += size) out.push(entries.slice(i, i + size));
  return out;
}
