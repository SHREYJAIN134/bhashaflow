export const DEFAULT_SETTINGS = {
  enabled: true,
  targetLanguage: 'hinglish', // hinglish | tanglish: remembered, used by Selection Mode and whole-page translation
  selectionMode: true, // default mode: a Translate Selection button next to selected text; whole-page translation is an optional popup action
  preserveHeadings: true,
  preserveTechnical: true,
  preserveHindi: true,
  maxParallelRequests: 2, // concurrent backend requests (1-4); see README before raising on a free key
  cacheEnabled: true, // remember validated translations on this device (IndexedDB) to avoid repeat requests
  sendPageContext: true, // send page title + nearest heading to the AI as disambiguation context
  useMock: false, // developer switch: marker-only converter, no backend call
  dynamicSites: [], // hostnames where the user opted in to converting newly inserted content
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function saveSettings(patch) {
  return chrome.storage.local.set(patch);
}
