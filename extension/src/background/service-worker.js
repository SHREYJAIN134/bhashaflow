import { DEFAULT_SETTINGS } from '../shared/settings.js';
import { MSG } from '../shared/messages.js';
import { normalizeLanguage } from '../shared/languages.js';
import { callBackend, createBackendInfo, createBackendHints } from './backend-client.js';
import { createTranslationCache, createMemoryStorage } from './translation-cache.js';
import { createIdbStorage } from './idb-storage.js';
import { createTranslationService } from './translation-service.js';

// Injected by scripts/build.js from BHASHAFLOW_BACKEND_URL (default http://localhost:8787).
const BACKEND_URL = __BACKEND_URL__;

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  await chrome.storage.local.set({ ...DEFAULT_SETTINGS, ...existing });
});

async function getInstallId() {
  const { installId } = await chrome.storage.local.get('installId');
  if (installId) return installId;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ installId: fresh });
  return fresh;
}

// IndexedDB in the extension's own origin; memory-only if it is unavailable. Cache failures never block translation.
const cache = createTranslationCache({
  storage: typeof indexedDB === 'undefined' ? createMemoryStorage() : createIdbStorage(),
  onError: (err) => console.warn('BhashaFlow cache disabled for a minute:', err && err.message),
});

const getHints = createBackendHints({ baseUrl: BACKEND_URL });

const service = createTranslationService({
  cache,
  // the daily-quota block survives service-worker restarts (Chrome stops idle workers after ~30 s)
  breakerStore: {
    load: async () => (await chrome.storage.local.get('quotaBreakers')).quotaBreakers || null,
    save: (blocks) => chrome.storage.local.set({ quotaBreakers: blocks }),
  },
  getInfo: createBackendInfo({
    baseUrl: BACKEND_URL,
    load: async () => (await chrome.storage.local.get('backendInfo')).backendInfo || null,
    save: (info) => chrome.storage.local.set({ backendInfo: info }),
  }),
  backend: async (payload) => {
    const { backendToken } = await chrome.storage.local.get('backendToken');
    return callBackend({ baseUrl: BACKEND_URL, payload, installId: await getInstallId(), token: backendToken });
  },
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === MSG.CONVERT) {
    service.convert(msg.payload, { useCache: msg.useCache !== false })
      .then(sendResponse, () => sendResponse({ ok: false, error: { code: 'internal', message: 'Translation failed unexpectedly' } }));
    return true; // async response
  }
  if (msg.type === MSG.LOOKUP) {
    service.lookup(msg.payload, { useCache: msg.useCache !== false })
      .then(sendResponse, () => sendResponse({ ok: true, data: { results: [] } }));
    return true;
  }
  if (msg.type === MSG.SET_LANGUAGE) { // the selection panel's language choice is remembered here (the page script never writes storage itself)
    const language = normalizeLanguage(msg.language);
    chrome.storage.local.set({ targetLanguage: language }).then(() => sendResponse({ ok: true, language }), () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === MSG.HINTS) {
    getHints().then((hints) => sendResponse({ ok: true, hints }), () => sendResponse({ ok: true, hints: {} }));
    return true;
  }
  if (msg.type === MSG.CLEAR_CACHE) {
    service.clearCache().then((removed) => sendResponse({ ok: true, removed }), () => sendResponse({ ok: false, removed: 0 }));
    return true;
  }
  if (msg.type === MSG.CACHE_STATS) {
    service.stats().then((stats) => sendResponse({ ok: true, ...stats }), () => sendResponse({ ok: false }));
    return true;
  }
  return false;
});
