// The two target languages. Shared by the extension (settings, cache keys, requests) and the backend (prompt choice,
// validation). Both are Roman script ONLY: no Devanagari and no Tamil script in either mode.

export const LANGUAGES = Object.freeze(['hinglish', 'tanglish']);
export const DEFAULT_LANGUAGE = 'hinglish';

export const LANGUAGE_LABELS = Object.freeze({
  hinglish: 'Hinglish (Hindi in Roman script)',
  tanglish: 'Tanglish (Tamil in Roman script)',
});
export const LANGUAGE_SHORT = Object.freeze({ hinglish: 'Hinglish', tanglish: 'Tanglish' });

// Prompt version used in cache keys for Tanglish. Hinglish keeps using the backend's configured version (hinglish-v2 by
// default), reported by /health, so changing either prompt can never reuse the other's saved translations.
export const TANGLISH_PROMPT_VERSION = 'tanglish-v1';

export const isLanguage = (value) => LANGUAGES.includes(value);

/** Anything unknown becomes the default, so a corrupt setting can never break translation. */
export const normalizeLanguage = (value) => (isLanguage(value) ? value : DEFAULT_LANGUAGE);
