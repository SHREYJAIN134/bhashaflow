import { ProviderError, errorFromResponse } from './errors.js';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-5-5';

// Claude 5-generation models (Haiku 5.5, Sonnet 5.x, Opus 5.x, Fable, Mythos) reject non-default sampling parameters
// (a `temperature` other than the default is a 400) and think by default. A translation wants neither: temperature is
// omitted and thinking is switched off (effort kept low), which is also what keeps latency and cost down. Older or
// unknown model ids keep the plain request shape (temperature when configured, nothing else).
const CURRENT_GENERATION = /^claude-(haiku-5|sonnet-5|opus-5|fable|mythos)/;
export const isCurrentGeneration = (model) => CURRENT_GENERATION.test(model || '');

const THINKING_MODES = ['disabled', 'adaptive'];
const EFFORTS = ['low', 'medium', 'high'];

/** Anthropic Messages API (https://docs.anthropic.com). One request = one completion. */
export function createAnthropicProvider({
  apiKey, model = ANTHROPIC_DEFAULT_MODEL, baseUrl = 'https://api.anthropic.com', temperature,
  anthropicThinking = 'disabled', anthropicEffort = 'low', fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error('The anthropic provider needs ANTHROPIC_API_KEY in the backend .env (get one at https://console.anthropic.com).');
  if (!model) throw new Error('Anthropic provider needs MODEL (for example claude-haiku-5-5)');
  if (!THINKING_MODES.includes(anthropicThinking)) throw new Error(`ANTHROPIC_THINKING must be one of ${THINKING_MODES.join(', ')} (got "${anthropicThinking}")`);
  if (!EFFORTS.includes(anthropicEffort)) throw new Error(`ANTHROPIC_EFFORT must be one of ${EFFORTS.join(', ')} (got "${anthropicEffort}")`);
  const current = isCurrentGeneration(model);
  const root = baseUrl.replace(/\/+$/, '');
  return {
    name: 'anthropic',
    model,
    async complete({ system, user, maxTokens, signal }) {
      let res;
      try {
        res = await fetchImpl(`${root}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            ...(!current && Number.isFinite(temperature) ? { temperature } : {}),
            // The instructions are identical on every request, so mark them cacheable (a no-op when below the model's
            // minimum cacheable size).
            system: current ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system,
            messages: [{ role: 'user', content: user }],
            ...(current ? { thinking: { type: anthropicThinking }, output_config: { effort: anthropicEffort } } : {}),
          }),
          signal,
        });
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        throw new ProviderError('network', 'Could not reach the Anthropic API', { retryable: true });
      }
      if (!res.ok) {
        const err = await errorFromResponse(res, apiKey);
        // The three request-level failures a user can fix get OUR wording (no provider text is passed on).
        if (err.code === 'bad-request' && err.status === 404) {
          throw new ProviderError('model-not-found', `Anthropic does not know the model "${model}". Check MODEL in the backend .env (for example claude-haiku-5-5).`, { status: 404 });
        }
        if (err.code === 'bad-request' && /credit balance|purchase credits/i.test(err.message)) {
          throw new ProviderError('no-credit', 'Your Anthropic account has no usable credit. Add credit in the Anthropic console (console.anthropic.com), then try again.', { status: err.status });
        }
        if (err.code === 'bad-request') {
          throw new ProviderError('invalid-settings', 'Anthropic rejected the request. Check MODEL, ANTHROPIC_THINKING and ANTHROPIC_EFFORT in the backend .env.', { status: err.status });
        }
        throw err;
      }
      const data = await res.json();
      const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      if (data.stop_reason === 'max_tokens') {
        throw new ProviderError('truncated', 'Model output was cut off at the token limit', { retryable: false });
      }
      if (data.stop_reason === 'refusal') {
        throw new ProviderError('refused', 'The model declined to translate this text', { retryable: false });
      }
      if (!text.trim()) throw new ProviderError('empty-response', 'Model returned an empty response', { retryable: true });
      const u = data.usage || {};
      return {
        text,
        usage: {
          inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0,
          ...(u.cache_read_input_tokens ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
          ...(u.cache_creation_input_tokens ? { cacheWriteTokens: u.cache_creation_input_tokens } : {}),
        },
      };
    },
  };
}
