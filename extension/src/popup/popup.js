import { loadSettings, saveSettings } from '../shared/settings.js';
import { MSG } from '../shared/messages.js';
import { normalizeLanguage, LANGUAGE_SHORT } from '../shared/languages.js';

const $ = (id) => document.getElementById(id);
const PREF_KEYS = ['selectionMode', 'preserveHeadings', 'preserveTechnical', 'preserveHindi', 'sendPageContext', 'cacheEnabled'];
const ACTIVE_STATES = new Set(['translating', 'paused']);
const POLL_MS = 250;

let settings;
let tabId = null;
let host = null; // hostname of the active tab, null on non-web pages
let pollTimer = null;
let lastState = 'idle';

const sum = (obj) => Object.values(obj || {}).reduce((a, b) => a + b, 0);

function setStatus(text, isError = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

/** Human-readable status for the page's controller state. Pure: see tests/unit/final-ui.test.js. */
export function describe(s) {
  const failed = sum(s.failed);
  const done = (s.converted || 0) + failed;
  const eligible = s.eligible || 0;
  const reused = (s.cached || 0) + (s.deduped || 0);
  const tail = () => {
    const parts = [];
    if (reused) parts.push(`${reused} reused without a request`);
    if (failed) parts.push(`${failed} left in English (${Object.keys(s.failed).join(', ')})`);
    if (s.notProcessed) parts.push(`${s.notProcessed} not processed`);
    if (s.truncated) parts.push(`${s.truncated} skipped (page too long)`);
    return parts.length ? `, ${parts.join(', ')}` : '';
  };
  switch (s.state) {
    case 'translating': {
      // phase: the scheduler works on what is on screen first, then the rest in the background
      const where = s.phase === 'visible' ? ` · visible content first, ${s.pendingVisible} on screen pending`
        : s.phase === 'background' ? ` · rest in the background, ${s.pendingBackground} pending` : '';
      const errors = failed ? ` · ${failed} failed` : '';
      return `Translating… ${done} of ${eligible} blocks${where}${errors}${s.inflight ? ` (${s.inflight} request${s.inflight === 1 ? '' : 's'} running)` : ''}`;
    }
    case 'paused':
      return `Paused: ${done} of ${eligible} blocks done. Resume to continue, or Stop.`;
    case 'stopped':
      return `Stopped: ${s.converted} blocks converted${tail()}. Restore puts the page back.`;
    case 'translated': {
      const base = `${s.converted} blocks converted, ${sum(s.skipped)} protected or skipped${tail()}`;
      if (s.error) return `Stopped early: ${s.error} (${base}).`;
      return `Done. ${base}.${s.observing ? ' Watching for new content.' : ''}`;
    }
    case 'restored':
      return `Original English restored (${s.restored ?? 0} blocks).`;
    default:
      return 'Ready';
  }
}

function send(message) {
  return chrome.tabs.sendMessage(tabId, message);
}

function renderControls(s) {
  const active = ACTIVE_STATES.has(s.state);
  lastState = s.state;
  $('runControls').hidden = !active;
  $('pause').textContent = s.state === 'paused' ? 'Resume' : 'Pause';
  $('translate').disabled = !settings.enabled || active;
}

function applyEnabledState() {
  $('translate').disabled = !settings.enabled || ACTIVE_STATES.has(lastState);
  if (!settings.enabled) setStatus('BhashaFlow is turned off');
}

async function refreshCacheInfo() {
  const el = $('cacheInfo');
  try {
    const stats = await chrome.runtime.sendMessage({ type: MSG.CACHE_STATS });
    if (!stats || !stats.ok) { el.textContent = ''; return; }
    const size = stats.bytes >= 1048576 ? `${(stats.bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(stats.bytes / 1024))} KB`;
    let text = stats.healthy ? `Saved translations: ${stats.entries} (${stats.entries ? size : '0 KB'})` : 'Saved translations: unavailable right now';
    if (stats.quota) text += ` · Daily AI quota used up until ${new Date(stats.quota.until).toLocaleString()}; saved translations still work`;
    el.textContent = text;
    el.classList.toggle('warn', Boolean(stats.quota));
  } catch {
    el.textContent = '';
  }
}

async function refreshStatus() {
  try {
    const s = await send({ type: MSG.STATUS });
    setStatus(describe(s), Boolean(s.error) && s.state === 'translated');
    renderControls(s);
    return s;
  } catch {
    return null; // content script not injected on this tab yet
  }
}

function pollWhileActive() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const s = await refreshStatus();
    if (!s || (!ACTIVE_STATES.has(s.state) && !s.inflight)) { clearInterval(pollTimer); refreshCacheInfo(); }
  }, POLL_MS);
}

async function translate() {
  if (!host) {
    setStatus('BhashaFlow cannot run on this page.', true);
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    setStatus('Scanning page…');
    const options = { ...settings, observe: settings.dynamicSites.includes(host) };
    const pending = send({ type: MSG.TRANSLATE, options });
    renderControls({ state: 'translating' });
    pollWhileActive();
    const result = await pending;
    clearInterval(pollTimer);
    setStatus(describe(result), Boolean(result.error));
    renderControls(result);
    refreshCacheInfo();
  } catch (err) {
    clearInterval(pollTimer);
    setStatus(`Could not translate this page: ${err.message}`, true);
    renderControls({ state: 'idle' });
  }
}

async function control(type) {
  try {
    const s = await send({ type });
    setStatus(describe(s));
    renderControls(s);
    if (ACTIVE_STATES.has(s.state) || s.inflight) pollWhileActive(); // requests still in flight land after Stop/Pause
  } catch {
    setStatus('Nothing is running on this page.');
    renderControls({ state: 'idle' });
  }
}

async function restore() {
  clearInterval(pollTimer);
  try {
    const s = await send({ type: MSG.RESTORE });
    setStatus(describe(s));
    renderControls(s);
  } catch {
    setStatus('Nothing to restore on this page.');
  }
}

async function toggleSite(on) {
  const sites = new Set(settings.dynamicSites);
  if (on) sites.add(host); else sites.delete(host);
  settings.dynamicSites = [...sites];
  await saveSettings({ dynamicSites: settings.dynamicSites });
  try {
    await send({ type: MSG.SET_OBSERVE, on }); // takes effect immediately if the page is already translated
    await refreshStatus();
  } catch { /* page not translated yet: applied on the next Translate click */ }
}

async function clearCache() {
  const reply = await chrome.runtime.sendMessage({ type: MSG.CLEAR_CACHE });
  setStatus(reply && reply.ok ? `Saved translations cleared (${reply.removed} entries).` : 'Could not clear the cache.', !(reply && reply.ok));
  refreshCacheInfo();
}

async function init() {
  settings = await loadSettings();
  const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  tabId = tab && tab.id;
  try {
    const url = new URL(tab.url);
    if (/^https?:$/.test(url.protocol)) host = url.hostname;
  } catch { /* chrome:// pages etc. */ }

  $('enabled').checked = settings.enabled;
  for (const key of PREF_KEYS) $(key).checked = settings[key];
  $('siteName').textContent = host || 'this site';
  $('dynamicSite').checked = Boolean(host) && settings.dynamicSites.includes(host);
  $('dynamicSite').disabled = !host;
  $('dynamicRow').classList.toggle('disabled', !host);
  applyEnabledState();

  $('enabled').addEventListener('change', async (e) => {
    settings.enabled = e.target.checked;
    await saveSettings({ enabled: settings.enabled });
    applyEnabledState();
    if (!settings.enabled) await restore(); // turning off puts the page back
  });
  for (const key of PREF_KEYS) {
    $(key).addEventListener('change', (e) => {
      settings[key] = e.target.checked;
      saveSettings({ [key]: e.target.checked });
    });
  }
  $('targetLanguage').value = normalizeLanguage(settings.targetLanguage);
  $('targetLanguage').addEventListener('change', (e) => {
    settings.targetLanguage = normalizeLanguage(e.target.value);
    saveSettings({ targetLanguage: settings.targetLanguage });
    setStatus(`Language: ${LANGUAGE_SHORT[settings.targetLanguage]}. Select text on a page, or use Translate whole page (a page already translated is restored first).`);
  });
  $('dynamicSite').addEventListener('change', (e) => toggleSite(e.target.checked));
  $('clearCache').addEventListener('click', clearCache);
  $('pause').addEventListener('click', () => control(lastState === 'paused' ? MSG.RESUME : MSG.PAUSE));
  $('stop').addEventListener('click', () => control(MSG.STOP));
  $('translate').addEventListener('click', translate);
  $('restore').addEventListener('click', restore);

  refreshCacheInfo();
  if (settings.enabled && tabId != null) {
    const s = await refreshStatus();
    if (s && ACTIVE_STATES.has(s.state)) pollWhileActive(); // popup reopened mid-translation
  }
}

init().catch((err) => setStatus(`BhashaFlow could not start: ${err.message}`, true));
