// Prompt text lives in prompts/ (one immutable file per version). This module keeps the request builder
// and re-exports the default prompt for backwards compatibility.
import { getPrompt, DEFAULT_PROMPT_VERSION } from './prompts/index.js';

export { getPrompt, PROMPT_VERSIONS, DEFAULT_PROMPT_VERSION } from './prompts/index.js';
export const PROMPT_VERSION = DEFAULT_PROMPT_VERSION;
export const SYSTEM_PROMPT = getPrompt().system;

/** User message: page context once, then the items. `fixes` maps item id -> reason for a repair pass. */
export function buildUserMessage({ page, items, fixes = {} }) {
  return JSON.stringify({
    page: page || {},
    items: items.map((it) => ({
      id: it.id,
      role: it.role || 'paragraph',
      ...(it.heading ? { heading: it.heading } : {}),
      text: it.text,
      ...(fixes[it.id] ? { fix: fixes[it.id] } : {}),
    })),
  });
}
