// Converter backed by the BhashaFlow backend (see converter.js for the contract). The page never talks
// to the network: requests go content script -> service worker -> backend.
//
// What leaves the browser, per item: the run's template text (prose with placeholder tokens, atomic
// elements reduced to a kind such as "code"), its role and nearest heading. Page title/heading are
// context only and can be switched off (sendPageContext). URLs, protected text, ads and form fields
// are never included because they never become eligible runs.

import { MSG } from '../shared/messages.js';
import { BATCH_LIMITS } from './batching.js';
import { normalizeLanguage } from '../shared/languages.js';

export function createRemoteConverter({ send }) {
  return {
    // Request size limits the scheduler packs to (see batching.js for how they were derived).
    limits: BATCH_LIMITS,
    /** Backend-advertised concurrency / batch size (GET /health, via the service worker). {} when unknown. */
    async hints() {
      try {
        const reply = await send({ type: MSG.HINTS });
        return reply && reply.ok && reply.hints && typeof reply.hints === 'object' ? reply.hints : {};
      } catch { return {}; }
    },
    /** Saved translations only (no backend request): [{ id, hinglish, cached: true }] for the items already cached. */
    async lookup(items, { sendContext = true, lang } = {}) {
      try {
        const payload = {
          v: 1,
          lang: normalizeLanguage(lang),
          page: sendContext && items[0] ? { title: items[0].context.pageTitle } : {},
          items: items.map((it) => ({ id: it.id, text: it.text, role: it.context.role, ...(sendContext && it.context.heading ? { heading: it.context.heading } : {}) })),
        };
        const reply = await send({ type: MSG.LOOKUP, payload, useCache: true });
        return reply && reply.ok && reply.data && Array.isArray(reply.data.results) ? reply.data.results : [];
      } catch { return []; }
    },
    async convert(items, { sendContext = true, useCache = true, lang } = {}) {
      const payload = {
        v: 1,
        lang: normalizeLanguage(lang),
        page: sendContext && items[0] ? { title: items[0].context.pageTitle } : {},
        items: items.map((it) => ({
          id: it.id,
          text: it.text,
          role: it.context.role,
          ...(sendContext && it.context.heading ? { heading: it.context.heading } : {}),
        })),
      };
      const reply = await send({ type: MSG.CONVERT, payload, useCache });
      if (!reply || !reply.ok) {
        const err = (reply && reply.error) || { code: 'no-reply', message: 'No reply from the extension service worker' };
        throw Object.assign(new Error(err.message), { code: err.code });
      }
      return Array.isArray(reply.data && reply.data.results) ? reply.data.results : [];
    },
  };
}
