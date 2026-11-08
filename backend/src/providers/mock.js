import { ProviderError } from './errors.js';

// Deterministic stand-in for a real model: swaps a few function words for Hindi ones and keeps every
// token. It exists to exercise the plumbing (batching, retries, validation) offline. It is NOT a
// quality baseline and its output is not evidence of translation quality.
const SWAPS = [
  [/\band\b/g, 'aur'], [/\bis\b/g, 'hai'], [/\bare\b/g, 'hain'], [/\bof\b/g, 'ka'], [/\bthat\b/g, 'jo'],
  [/\bwith\b/g, 'ke saath'], [/\bin\b/g, 'mein'], [/\bthe\s+/g, ''],
];
export const mockTransform = (text) => SWAPS.reduce((t, [re, to]) => t.replace(re, to), text);

/**
 * options: { latencyMs, failures: [ProviderError|null...] (consumed per call), corrupt(item, out) }
 * `calls` records every request so tests can assert what was (not) sent.
 */
export function createMockProvider(options = {}) {
  const failures = [...(options.failures || [])];
  const calls = [];
  return {
    name: 'mock',
    model: 'mock-1',
    calls,
    async complete({ system, user, signal }) {
      calls.push({ system, user });
      if (options.latencyMs) await new Promise((r) => setTimeout(r, options.latencyMs));
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const failure = failures.shift();
      if (failure) throw failure instanceof Error ? failure : new ProviderError('unavailable', 'mock failure', { retryable: true });
      const request = JSON.parse(user);
      const results = request.items.map((item) => {
        const out = mockTransform(item.text);
        return { id: item.id, hinglish: options.corrupt ? options.corrupt(item, out, calls.length) : out };
      });
      const text = JSON.stringify({ results });
      return { text, usage: { inputTokens: Math.ceil((system.length + user.length) / 4), outputTokens: Math.ceil(text.length / 3) } };
    },
  };
}
