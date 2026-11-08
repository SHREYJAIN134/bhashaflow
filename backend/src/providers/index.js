import { createAnthropicProvider } from './anthropic.js';
import { createOpenAICompatProvider } from './openai-compat.js';
import { createOllamaProvider } from './ollama.js';
import { createMockProvider } from './mock.js';

/**
 * Provider contract (the only thing the engine depends on):
 *   { name, model, complete({ system, user, maxTokens, signal }) -> { text, usage: { inputTokens, outputTokens } } }
 * and complete() throws ProviderError (see errors.js) on failure. Add a provider = add a file here.
 */
export function createProvider(config, fetchImpl = fetch) {
  switch (config.provider) {
    case 'anthropic':
      return createAnthropicProvider({ ...config, baseUrl: undefined, fetchImpl }); // the endpoint is fixed: BASE_URL belongs to openai-compat
    case 'openai-compat':
      return createOpenAICompatProvider({ ...config, fetchImpl });
    case 'ollama':
      return createOllamaProvider({ ...config, fetchImpl });
    case 'mock':
      return createMockProvider();
    default:
      throw new Error(`Unknown PROVIDER "${config.provider}" (use ollama, openai-compat, anthropic or mock)`);
  }
}
