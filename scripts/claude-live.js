// One-time live check of the Anthropic (Claude) provider.
//
//   npm run test:claude-live -- --confirm-live        make ONE real request (costs a fraction of a cent)
//   npm run test:claude-live -- --dry-run             show exactly what would be sent; no network, no key needed
//
// Exactly one HTTP request is made: five passages translated together in a single call through the same adapter, the same
// compact selection prompt and the same response parser/validator the app uses. There are NO retries and NO repair
// requests, so a rejected answer is reported, not re-asked. It refuses to run without --confirm-live and without
// ANTHROPIC_API_KEY. It is not part of `npm test` and nothing else calls it.
import { pathToFileURL } from 'node:url';
import { createAnthropicProvider, ANTHROPIC_DEFAULT_MODEL, isCurrentGeneration } from '../backend/src/providers/anthropic.js';
import { getSelectionPrompt } from '../backend/src/prompts/index.js';
import { buildUserMessage } from '../backend/src/prompt.js';
import { parseModelReply } from '../backend/src/engine.js';
import { validateItem } from '../backend/src/validate.js';
import { sourceFromTemplate } from '../extension/src/shared/tokens.js';

export const PASSAGES = [
  'The REST API returns up to 200 results in JSON format when the request is valid and the token has not expired.',
  'Thanks for waiting! Let me know if anything in this section is unclear.',
  'To reset your password, open Settings, click Security, and choose Reset password.',
  'A cache stores frequently used data so that future requests can be served faster. It is usually much quicker than reading from a database, but it can return stale results if the data changes.',
  'Time complexity of binary search',
];

// USD per million tokens (Claude Haiku 5.5, prompts up to 100K tokens): input 0.10, output 0.50. Cache writes are billed at
// 1.25x and cache reads at 0.1x of the input price. This is an estimate for the model named below, not an invoice.
export const PRICE_PER_MTOK = { input: 0.1, output: 0.5, cacheWriteFactor: 1.25, cacheReadFactor: 0.1 };

export function estimateCostUsd(usage) {
  const p = PRICE_PER_MTOK;
  const cacheWrite = usage.cacheWriteTokens || 0;
  const cacheRead = usage.cacheReadTokens || 0;
  return ((usage.inputTokens || 0) * p.input + cacheWrite * p.input * p.cacheWriteFactor + cacheRead * p.input * p.cacheReadFactor + (usage.outputTokens || 0) * p.output) / 1e6;
}

const usd = (n) => `$${n.toFixed(6)}`;

/** Runs the check. Returns the process exit code: 0 ok, 1 request or answer failed, 2 refused to run. */
export async function runLive({ argv = [], env = {}, fetchImpl = fetch, write = (s) => process.stdout.write(s) } = {}) {
  const line = (s = '') => write(`${s}\n`);
  const confirm = argv.includes('--confirm-live');
  const dry = argv.includes('--dry-run');
  const model = (env.PROVIDER === 'anthropic' && env.MODEL) || ANTHROPIC_DEFAULT_MODEL;
  const system = getSelectionPrompt('hinglish-v2').system;
  const items = PASSAGES.map((text, id) => ({ id, role: 'selection', text }));
  const user = buildUserMessage({ page: {}, items });
  const maxTokens = 1500;

  if (dry) {
    line('DRY RUN: nothing is sent.');
    line(`Would make exactly 1 request to https://api.anthropic.com/v1/messages with model "${model}", max_tokens ${maxTokens}, no retries, no repair pass.`);
    line(`System prompt: hinglish-v2 (selection variant), ${system.length} characters. Passages: ${PASSAGES.length}.`);
    PASSAGES.forEach((p, i) => line(`  ${i + 1}. ${p}`));
    line(`Estimated cost if run: about ${usd(estimateCostUsd({ inputTokens: Math.ceil((system.length + user.length) / 3.5), outputTokens: 450 }))} (rough).`);
    return 0;
  }
  if (!confirm) {
    line('Refusing to run: this makes a real, paid Anthropic API request.');
    line('Re-run with the explicit flag:  npm run test:claude-live -- --confirm-live');
    line('(Use --dry-run to see what would be sent without any request.)');
    return 2;
  }
  if (!env.ANTHROPIC_API_KEY || !env.ANTHROPIC_API_KEY.trim()) {
    line('Refusing to run: ANTHROPIC_API_KEY is not set. Put it in the root .env file (ANTHROPIC_API_KEY=...). Nothing was sent.');
    return 2;
  }
  if (!/^claude-/.test(model)) {
    line(`Refusing to run: MODEL "${model}" is not a Claude model id (expected something like ${ANTHROPIC_DEFAULT_MODEL}). Nothing was sent.`);
    return 2;
  }

  let requests = 0;
  const once = async (...args) => {
    if (++requests > 1) throw new Error('internal guard: a second request was attempted'); // can never happen; belt and braces
    return fetchImpl(...args);
  };
  let provider;
  try {
    provider = createAnthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY.trim(), model, fetchImpl: once,
      anthropicThinking: (env.ANTHROPIC_THINKING || 'disabled').trim().toLowerCase(), anthropicEffort: (env.ANTHROPIC_EFFORT || 'low').trim().toLowerCase(),
    });
  } catch (err) {
    line(`Refusing to run: ${err.message}`);
    return 2;
  }

  line(`Live check: 1 request, model ${model}${isCurrentGeneration(model) ? '' : ' (not a Claude 5 model: pricing below assumes Haiku 5.5)'}, ${PASSAGES.length} passages, no retries.`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  const t0 = Date.now();
  let reply;
  try {
    reply = await provider.complete({ system, user, maxTokens, signal: controller.signal });
  } catch (err) {
    const latencyMs = Date.now() - t0;
    line(`FAILED after ${latencyMs} ms: ${err.name === 'AbortError' ? 'timed out after 60 s' : `${err.code || 'error'}: ${err.message}`}`);
    line('One request was made; nothing was retried.');
    return 1;
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - t0;

  let answers = new Map();
  let parseError = null;
  try { answers = parseModelReply(reply.text); } catch (err) { parseError = err.message; }

  line();
  let bad = 0;
  items.forEach((it, i) => {
    const out = answers.get(it.id);
    const v = validateItem({ id: it.id, text: it.text, source: sourceFromTemplate(it.text) }, out);
    if (!v.ok) bad++;
    line(`${i + 1}. English : ${it.text}`);
    line(`   Hinglish: ${typeof out === 'string' ? out : '(missing)'}`);
    line(`   validation: ${v.ok ? 'passed' : `REJECTED (${v.issue})`}`);
    line();
  });
  if (parseError) line(`Reply could not be parsed: ${parseError}`);

  const u = reply.usage;
  line(`Total API latency : ${latencyMs} ms (${(latencyMs / 1000).toFixed(2)} s) for 1 request`);
  line(`Input tokens      : ${u.inputTokens}${u.cacheWriteTokens ? ` (+${u.cacheWriteTokens} cache write)` : ''}${u.cacheReadTokens ? ` (+${u.cacheReadTokens} cache read)` : ''}`);
  line(`Output tokens     : ${u.outputTokens}`);
  line(`Estimated cost    : ${usd(estimateCostUsd(u))} USD (Haiku 5.5 list price: $${PRICE_PER_MTOK.input}/MTok in, $${PRICE_PER_MTOK.output}/MTok out)`);
  line(`Requests made     : ${requests}`);
  if (bad || parseError) line(`${bad} of ${PASSAGES.length} answers failed the app's validation (no repair request was sent, by design).`);
  return bad || parseError ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runLive({ argv: process.argv.slice(2), env: process.env }).then((code) => process.exit(code), (err) => { console.error(`Unexpected error: ${err && err.message ? err.message : err}`); process.exit(1); });
}
