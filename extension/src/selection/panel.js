// The two floating pieces of Selection Mode: the small "Translate Selection" action and the result panel.
// Both live in a closed-off shadow root attached to <html> (not <body>), are position:fixed (no layout impact on the
// page), carry no page text except through textContent, and are removed when hidden.

import { LANGUAGES, LANGUAGE_SHORT, LANGUAGE_LABELS, normalizeLanguage } from '../shared/languages.js';

const GAP = 8;
const EDGE = 8;

/** Where a box of w x h goes next to a selection rect inside a vw x vh viewport: below it if it fits, else above. */
export function place(rect, w, h, vw, vh) {
  if (!rect) return { top: EDGE, left: Math.max(EDGE, vw - w - EDGE) };
  const left = Math.min(Math.max(rect.right - w, EDGE), Math.max(EDGE, vw - w - EDGE));
  let top = rect.bottom + GAP;
  if (top + h > vh - EDGE) top = rect.top - h - GAP;
  if (top < EDGE) top = Math.min(EDGE, Math.max(vh - h - EDGE, 0)) || EDGE;
  return { top, left };
}

const CSS = `
:host { all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.action, .panel { position: fixed; color: #1b1b1f; background: #fff; border: 1px solid #c9ccd6; border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0,0,0,.22); font-size: 14px; line-height: 1.4; }
.action { padding: 6px 12px; cursor: pointer; font-weight: 600; font-size: 13px; color: #fff; background: #4b3fd8; border-color: #3a30b8; }
.action:hover { background: #3a30b8; }
button { font: inherit; cursor: pointer; }
button:focus-visible, .panel:focus-visible { outline: 3px solid #ffbf47; outline-offset: 2px; }
.panel { width: min(380px, calc(100vw - 16px)); max-height: min(70vh, 520px); display: flex; flex-direction: column; overflow: hidden; }
.head { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px 6px 12px; border-bottom: 1px solid #e4e6ee; }
.title { font-weight: 700; font-size: 13px; color: #4b3fd8; }
.lang { font: inherit; font-size: 12px; margin-left: auto; margin-right: 6px; padding: 2px 4px; border: 1px solid #c9ccd6; border-radius: 6px; background: #fff; color: inherit; }
.close { border: 0; background: transparent; font-size: 20px; line-height: 1; padding: 2px 8px; border-radius: 6px; color: #444; }
.close:hover { background: #eceef6; }
.body { padding: 8px 12px; overflow: auto; flex: 1 1 auto; }
h2 { margin: 6px 0 2px; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #5b5f70; }
.orig, .out { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.orig { color: #4a4d5c; max-height: 110px; overflow: auto; font-size: 13px; }
.out { font-size: 15px; min-height: 1.4em; }
.out.error { color: #a4161a; }
.spin { display: inline-block; width: 14px; height: 14px; border: 2px solid #c9ccd6; border-top-color: #4b3fd8; border-radius: 50%;
  vertical-align: -2px; margin-right: 6px; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; border-top-color: #c9ccd6; } }
.foot { display: flex; gap: 8px; align-items: center; padding: 8px 12px 10px; border-top: 1px solid #e4e6ee; }
.btn { border: 1px solid #c9ccd6; background: #f4f5fa; color: #1b1b1f; padding: 5px 12px; border-radius: 8px; font-size: 13px; }
.btn.primary { background: #4b3fd8; border-color: #3a30b8; color: #fff; }
.btn[disabled] { opacity: .5; cursor: default; }
.note { margin-left: auto; font-size: 12px; color: #5b5f70; }
[hidden] { display: none !important; }
@media (prefers-color-scheme: dark) {
  .panel { color: #ececf1; background: #23242b; border-color: #444757; }
  .head, .foot { border-color: #3a3c49; }
  .orig, h2, .note { color: #a9adbd; }
  .close { color: #ddd; } .close:hover { background: #33354000; background: #333540; }
  .btn { background: #31333d; color: #ececf1; border-color: #4a4d5d; }
  .btn.primary { background: #6a5df0; border-color: #6a5df0; color: #fff; }
  .out.error { color: #ff8a8d; }
}
`;

function makeHost(doc) {
  const host = doc.createElement('div');
  host.setAttribute('data-bhashaflow', 'selection');
  host.setAttribute('data-bf-ignore', ''); // other tooling (and our own scanners) can recognise it
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = CSS;
  root.append(style);
  return { host, root };
}

/**
 * UI controller. Callbacks: onAction() when the small button is activated, onClose(), onRetry().
 * It never touches page nodes except to append/remove its own host elements.
 */
export function createSelectionUI({ doc, onAction, onClose, onRetry, onLanguage = () => {} }) {
  const win = doc.defaultView;
  let actionParts = null;
  let panelParts = null;
  let returnFocus = null;
  let copyTimer = null;

  const viewport = () => ({ vw: win.innerWidth || doc.documentElement.clientWidth || 1024, vh: win.innerHeight || doc.documentElement.clientHeight || 768 });
  const mount = (host) => (doc.documentElement || doc.body).append(host);

  // ------------------------------------------------------------------ the small action
  function showAction(rect) {
    if (!actionParts) {
      const { host, root } = makeHost(doc);
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'action';
      button.textContent = 'Translate Selection';
      button.setAttribute('aria-label', 'Translate selection to Hinglish');
      // Keep the page selection alive while the button is pressed (mousedown would collapse it otherwise).
      button.addEventListener('mousedown', (e) => e.preventDefault());
      button.addEventListener('click', (e) => { e.preventDefault(); onAction(); });
      root.append(button);
      mount(host);
      actionParts = { host, button };
    }
    const { vw, vh } = viewport();
    const w = actionParts.button.offsetWidth || 150;
    const h = actionParts.button.offsetHeight || 30;
    const pos = place(rect, w, h, vw, vh);
    actionParts.button.style.top = `${pos.top}px`;
    actionParts.button.style.left = `${pos.left}px`;
  }

  function hideAction() {
    if (!actionParts) return;
    actionParts.host.remove();
    actionParts = null;
  }

  // ------------------------------------------------------------------ the result panel
  function reposition(rect) {
    if (!panelParts) return;
    const { vw, vh } = viewport();
    const w = panelParts.panel.offsetWidth || 380;
    const h = panelParts.panel.offsetHeight || 160;
    const pos = place(rect || panelParts.anchor, w, h, vw, vh);
    panelParts.anchor = rect || panelParts.anchor;
    panelParts.panel.style.top = `${pos.top}px`;
    panelParts.panel.style.left = `${pos.left}px`;
  }

  function setLanguage(language) {
    if (!panelParts) return;
    const value = normalizeLanguage(language);
    panelParts.lang.value = value;
    panelParts.outLabel.textContent = LANGUAGE_SHORT[value];
    panelParts.panel.setAttribute('aria-label', `BhashaFlow ${LANGUAGE_SHORT[value]} translation`);
  }

  function open({ original, rect, language }) {
    hideAction();
    if (!panelParts) {
      returnFocus = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : null;
      const { host, root } = makeHost(doc);
      const panel = doc.createElement('div');
      panel.className = 'panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'BhashaFlow Hinglish translation');
      panel.tabIndex = -1;
      panel.innerHTML = `
        <div class="head"><span class="title">BhashaFlow</span>
          <select class="lang" aria-label="Translate to">${LANGUAGES.map((l) => `<option value="${l}" title="${LANGUAGE_LABELS[l]}">${LANGUAGE_SHORT[l]}</option>`).join('')}</select>
          <button type="button" class="close" aria-label="Close translation (Escape)">×</button></div>
        <div class="body">
          <h2>Original</h2><p class="orig" dir="auto"></p>
          <h2 class="outlabel">Hinglish</h2><p class="out" role="status" aria-live="polite"></p>
        </div>
        <div class="foot">
          <button type="button" class="btn primary copy" disabled>Copy translation</button>
          <button type="button" class="btn retry" hidden>Try again</button>
          <span class="note" aria-live="polite"></span>
        </div>`;
      root.append(panel);
      const q = (s) => panel.querySelector(s);
      panelParts = { host, panel, lang: q('.lang'), outLabel: q('.outlabel'), orig: q('.orig'), out: q('.out'), copy: q('.copy'), retry: q('.retry'), note: q('.note'), result: '', anchor: rect };
      q('.close').addEventListener('click', () => onClose());
      panelParts.lang.addEventListener('change', () => { const language = normalizeLanguage(panelParts.lang.value); setLanguage(language); onLanguage(language); });
      panelParts.retry.addEventListener('click', () => onRetry());
      panelParts.copy.addEventListener('click', () => copyResult());
      mount(host);
    }
    panelParts.orig.textContent = original;
    setLanguage(language);
    panelParts.anchor = rect;
    reposition(rect);
    panelParts.panel.focus({ preventScroll: true });
  }

  function focusPanel() {
    if (panelParts) panelParts.panel.focus({ preventScroll: true });
  }

  function setOriginal(text) {
    if (panelParts) panelParts.orig.textContent = text;
  }

  function setLoading(partial = '') {
    if (!panelParts) return;
    const { out, copy, retry, note } = panelParts;
    out.className = 'out';
    out.textContent = '';
    if (partial) out.append(doc.createTextNode(`${partial}\n`));
    const spin = doc.createElement('span');
    spin.className = 'spin';
    spin.setAttribute('aria-hidden', 'true');
    out.append(spin, doc.createTextNode('Translating…'));
    panelParts.result = '';
    copy.disabled = true;
    retry.hidden = true;
    note.textContent = '';
    reposition();
  }

  function setResult(text, { fromCache = false } = {}) {
    if (!panelParts) return;
    const { out, copy, retry, note } = panelParts;
    out.className = 'out';
    out.textContent = text;
    panelParts.result = text;
    copy.disabled = false;
    retry.hidden = true;
    note.textContent = fromCache ? 'Saved · instant' : '';
    reposition();
  }

  function setError(message, { canRetry = true } = {}) {
    if (!panelParts) return;
    const { out, copy, retry, note } = panelParts;
    out.className = 'out error';
    out.textContent = message;
    panelParts.result = '';
    copy.disabled = true;
    retry.hidden = !canRetry;
    note.textContent = '';
    reposition();
    if (canRetry) retry.focus({ preventScroll: true });
  }

  async function copyResult() {
    if (!panelParts || !panelParts.result) return false;
    const text = panelParts.result;
    let ok = false;
    try {
      if (win.navigator.clipboard && win.navigator.clipboard.writeText) { await win.navigator.clipboard.writeText(text); ok = true; }
    } catch { ok = false; }
    if (!ok) { // pages without clipboard access (plain http, permissions policy): legacy copy from a temporary textarea
      try {
        const area = doc.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
        panelParts.panel.append(area);
        area.select();
        ok = doc.execCommand('copy');
        area.remove();
      } catch { ok = false; }
    }
    if (panelParts) {
      panelParts.note.textContent = ok ? 'Copied' : 'Could not copy';
      win.clearTimeout(copyTimer);
      copyTimer = win.setTimeout(() => { if (panelParts) panelParts.note.textContent = ''; }, 1800);
    }
    return ok;
  }

  function close() {
    if (!panelParts) return;
    win.clearTimeout(copyTimer);
    panelParts.host.remove();
    panelParts = null;
    const back = returnFocus;
    returnFocus = null;
    if (back && back.isConnected && typeof back.focus === 'function') { try { back.focus({ preventScroll: true }); } catch { /* element gone */ } }
  }

  return {
    showAction, hideAction, open, focusPanel, setOriginal, setLanguage, setLoading, setResult, setError, close, copyResult, reposition,
    get panelOpen() { return Boolean(panelParts); },
    get actionVisible() { return Boolean(actionParts); },
    hosts: () => [actionParts && actionParts.host, panelParts && panelParts.host].filter(Boolean),
    // test/diagnostic access (the shadow root itself is closed to the page)
    _parts: () => ({ action: actionParts, panel: panelParts }),
  };
}
