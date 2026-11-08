// Converter contract (stable across phases):
//   convert([{ id, text, context }]) -> Promise<[{ id, hinglish }]>
//
// `text` is a template: plain text plus placeholder tokens for inline markup (see inline.js).
//   ⟦1⟧...⟦/1⟧  wrapper (link, bold...): keep both tokens around the converted words
//   ⟦2=code⟧             atomic element: copy verbatim
// `context` = { pageTitle, heading, tag } for context-aware rewriting.
// The reply is validated by the caller; any invalid block is left in English.
//
// Phase 2 still ships a marker-only stand-in. Phase 3 swaps in a backend-backed converter.

export const MOCK_PREFIX = '[Hinglish test] ';

export const mockConverter = {
  async convert(items) {
    return items.map(({ id, text }) => ({ id, hinglish: MOCK_PREFIX + text }));
  },
};
