export const MSG = {
  TRANSLATE: 'bf:translate',
  RESTORE: 'bf:restore',
  STATUS: 'bf:status',
  SET_OBSERVE: 'bf:set-observe',
  EXPLAIN: 'bf:explain',
  CONVERT: 'bf:convert', // content script -> service worker (cache, dedupe) -> backend
  PAUSE: 'bf:pause',
  RESUME: 'bf:resume',
  STOP: 'bf:stop',
  CLEAR_CACHE: 'bf:clear-cache',
  CACHE_STATS: 'bf:cache-stats',
  LOOKUP: 'bf:lookup', // content script -> service worker: cache-only lookup, never calls the backend
  SET_LANGUAGE: 'bf:set-language', // content script -> service worker: remember the chosen target language
  HINTS: 'bf:hints', // content script -> service worker: scheduling hints the backend advertises
};
