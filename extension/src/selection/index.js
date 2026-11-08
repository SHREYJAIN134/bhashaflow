import { createSelectionApp } from './selection-app.js';
import { createRemoteConverter } from '../content/converter-remote.js';
import { loadSettings } from '../shared/settings.js';
import { MSG } from '../shared/messages.js';

// Loaded on every http(s) page (manifest content_scripts) but inert until the user selects text: it adds no UI,
// reads no page text and makes no request before the user clicks "Translate Selection".
if (!globalThis.__bhashaflowSelection) {
  globalThis.__bhashaflowSelection = createSelectionApp({
    win: window,
    converter: createRemoteConverter({ send: (message) => chrome.runtime.sendMessage(message) }),
    getSettings: loadSettings,
    rememberLanguage: (language) => chrome.runtime.sendMessage({ type: MSG.SET_LANGUAGE, language }), // the worker writes storage, not this script
  });
}
