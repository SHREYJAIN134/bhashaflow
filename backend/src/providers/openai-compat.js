import { ProviderError, errorFromResponse } from './errors.js';

/**
 * Any OpenAI-compatible /chat/completions endpoint: OpenAI, Groq, Google Gemini's OpenAI-compat
 * endpoint, Together, OpenRouter, local servers. Selected with BASE_URL + MODEL + LLM_API_KEY.
 */
export function createOpenAICompatProvider({
  apiKey, model, baseUrl, temperature, maxTokensParam = 'max_tokens', reasoningEffort = '', jsonMode = true, fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error('openai-compat provider needs LLM_API_KEY');
  if (!model) throw new Error('openai-compat provider needs MODEL');
  if (!baseUrl) throw new Error('openai-compat provider needs BASE_URL (e.g. https://api.groq.com/openai/v1)');
  const root = baseUrl.replace(/\/+$/, '');
  return {
    name: 'openai-compat',
    model,
    async complete({ system, user, maxTokens, signal }) {
      let res;
      try {
        res = await fetchImpl(`${root}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            [maxTokensParam]: maxTokens,
            ...(Number.isFinite(temperature) ? { temperature } : {}),
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
            ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
          }),
          signal,
        });
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        throw new ProviderError('network', 'Could not reach the provider', { retryable: true });
      }
      if (!res.ok) throw await errorFromResponse(res, apiKey);
      const data = await res.json();
      const choice = data.choices?.[0];
      const text = choice?.message?.content ?? '';
      // Hidden reasoning tokens count toward the limit, so a model can stop with nothing (or half a JSON
      // document) and finish_reason=length. Never hand that on as an answer.
      if (choice?.finish_reason === 'length') {
        throw new ProviderError('truncated', 'Model output was cut off at the token limit', { retryable: false });
      }
      if (!text.trim()) throw new ProviderError('empty-response', 'Model returned an empty response', { retryable: true });
      return { text, usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0 } };
    },
  };
}
