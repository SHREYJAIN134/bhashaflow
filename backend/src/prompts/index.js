import { SYSTEM_PROMPT_V1, VERSION_V1 } from './v1.js';
import { SYSTEM_PROMPT_V2, VERSION_V2 } from './v2.js';
import { SYSTEM_PROMPT_V2_SELECTION } from './v2-selection.js';
import { SYSTEM_PROMPT_TANGLISH_V1, VERSION_TANGLISH_V1 } from './tanglish-v1.js';

// Prompts are immutable once released: change the wording => add a new version file and register it.
const PROMPTS = { [VERSION_V1]: SYSTEM_PROMPT_V1, [VERSION_V2]: SYSTEM_PROMPT_V2 };

export const PROMPT_VERSIONS = Object.keys(PROMPTS);
export const DEFAULT_PROMPT_VERSION = VERSION_V2;

/**
 * The prompt for a target language. Hinglish keeps its versioned prompts exactly as before (selected text uses the compact
 * variant); Tanglish has its own prompt, which serves page text and selections alike.
 */
export function getPromptForLanguage(lang, { version = DEFAULT_PROMPT_VERSION, selection = false } = {}) {
  if (lang === 'tanglish') return { version: VERSION_TANGLISH_V1, system: SYSTEM_PROMPT_TANGLISH_V1 };
  return selection ? getSelectionPrompt(version) : getPrompt(version);
}

/** The compact variant for selected text (role "selection"). Only hinglish-v2 has one; other versions fall back to themselves. */
export function getSelectionPrompt(version = DEFAULT_PROMPT_VERSION) {
  const base = getPrompt(version);
  return version === VERSION_V2 ? { version, system: SYSTEM_PROMPT_V2_SELECTION } : base;
}

/** Selected with PROMPT_VERSION; defaults to the latest. v1 stays available for A/B comparison. */
export function getPrompt(version = DEFAULT_PROMPT_VERSION) {
  const system = PROMPTS[version];
  if (!system) throw new Error(`Unknown PROMPT_VERSION "${version}" (available: ${PROMPT_VERSIONS.join(', ')})`);
  return { version, system };
}
