// Selection Mode controller: shows the small action next to a selection, and runs a translation ONLY when the user
// activates it (click, or Alt+Shift+T). Nothing is read from the page except the selected text, nothing is sent
// anywhere until then, and the page itself is never modified.

import { readSelection, planSelection, translatePlan, friendlyError, limitsFromHints } from './selection-core.js';
import { createSelectionUI } from './panel.js';
import { DEFAULT_LANGUAGE, normalizeLanguage } from '../shared/languages.js';

const SELECT_KEYS = new Set(['Shift', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'a', 'A']);

export function createSelectionApp({ win, converter, getSettings, rememberLanguage = () => {}, debounceMs = 120 }) {
  const doc = win.document;
  let token = 0; // bumped by every new run and by Close: older work is abandoned
  let current = null; // { key, sel, state: 'loading' | 'done' | 'error' } for the open panel
  let dragging = false;
  let timer = null;
  let frame = null;
  let knownLanguage = DEFAULT_LANGUAGE; // last language read from settings: lets the panel open instantly

  const ui = createSelectionUI({
    doc,
    onAction: () => { const sel = readSelection(win, ui.hosts()); if (!sel.reason) run(sel); else ui.hideAction(); },
    onClose: () => closePanel(),
    onRetry: () => { if (current) run(current.sel, true); },
    // Switching language in the panel re-translates the same selection and is remembered for next time.
    onLanguage: (language) => { try { rememberLanguage(language); } catch { /* the choice still applies to this selection */ } if (current) run(current.sel, true, language); },
  });

  const enabled = async () => {
    try { const s = await getSettings(); knownLanguage = normalizeLanguage(s.targetLanguage); return Boolean(s.enabled) && s.selectionMode !== false; } catch { return true; }
  };

  function closePanel() {
    token++;
    current = null;
    ui.close();
  }

  const preferredLanguage = async () => {
    try { return normalizeLanguage((await getSettings()).targetLanguage); } catch { return DEFAULT_LANGUAGE; }
  };

  async function run(sel, force = false, languageOverride) {
    const key = sel.text;
    if (!force && current && current.key === key && ui.panelOpen) { // repeated click / shortcut on the same selection
      ui.focusPanel(); // just bring it forward; no second request
      return;
    }
    const mine = ++token;
    current = { key, sel, state: 'loading' };
    let language = languageOverride || knownLanguage;
    ui.open({ original: sel.text.replace(/\n{2,}/g, '\n').trim(), rect: sel.rect, language });
    ui.setLoading();

    // The stored preference and the backend's hints are fetched together; the panel is already open.
    const [stored, hints] = await Promise.all([
      languageOverride ? Promise.resolve(languageOverride) : preferredLanguage(),
      (async () => { try { return typeof converter.hints === 'function' ? (await converter.hints()) || {} : {}; } catch { return {}; } })(),
    ]);
    if (mine !== token) return;
    if (stored !== language) { language = stored; ui.setLanguage(language); }
    knownLanguage = language;
    const limits = limitsFromHints(hints);
    const plan = planSelection(sel.text, limits);
    if (plan.error) {
      current.state = 'error';
      ui.setError(plan.error.message, { canRetry: false });
      return;
    }
    ui.setOriginal(plan.blocks.map((b) => b.text).join('\n'));

    try {
      const out = await translatePlan(plan, {
        converter, limits, lang: language, concurrency: Math.min(3, hints.maxConcurrency || 3), // a local model advertises 1; hosted models are not capped
        onProgress: (partial) => { if (mine === token) ui.setLoading(partial); },
        isCancelled: () => mine !== token,
      });
      if (!out || mine !== token) return;
      current.state = 'done';
      ui.setResult(out.text, { fromCache: out.fromCache });
    } catch (e) {
      if (mine !== token) return;
      current.state = 'error';
      ui.setError(friendlyError(e && e.code, e && e.message));
    }
  }

  async function evaluate() {
    timer = null;
    if (!(await enabled())) { ui.hideAction(); return; }
    const sel = readSelection(win, ui.hosts());
    if (sel.reason === 'own-ui') return;
    if (sel.reason) { ui.hideAction(); return; }
    ui.showAction(sel.rect);
  }
  const schedule = (ms) => { win.clearTimeout(timer); timer = win.setTimeout(evaluate, ms); };

  const isOwn = (e) => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    return ui.hosts().some((h) => path.includes(h) || h === e.target);
  };

  const onMouseDown = (e) => { if (isOwn(e)) return; dragging = true; ui.hideAction(); };
  const onMouseUp = (e) => { if (isOwn(e)) return; dragging = false; schedule(10); };
  const onKeyUp = (e) => { if (SELECT_KEYS.has(e.key)) schedule(debounceMs); };
  const onSelectionChange = () => {
    if (dragging) return;
    const s = win.getSelection && win.getSelection();
    if (!s || s.isCollapsed) { if (!(s && ui.hosts().some((h) => h === s.anchorNode))) ui.hideAction(); return; }
    schedule(debounceMs);
  };
  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      if (ui.panelOpen) { e.stopImmediatePropagation(); e.preventDefault(); closePanel(); } else if (ui.actionVisible) ui.hideAction();
      return;
    }
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyT') { // keyboard route to the action
      const sel = readSelection(win, ui.hosts());
      if (sel.reason) return; // nothing valid selected: leave the key to the page
      e.preventDefault();
      enabled().then((on) => { if (on) run(sel); });
    }
  };
  const onViewportChange = () => {
    if (!ui.actionVisible || frame) return;
    frame = (win.requestAnimationFrame || ((f) => win.setTimeout(f, 16)))(() => {
      frame = null;
      const sel = readSelection(win, ui.hosts());
      const vh = win.innerHeight || 0;
      if (sel.reason || !sel.rect || (vh && (sel.rect.bottom < 0 || sel.rect.top > vh))) ui.hideAction(); else ui.showAction(sel.rect);
    });
  };

  doc.addEventListener('mousedown', onMouseDown, true);
  doc.addEventListener('mouseup', onMouseUp, true);
  doc.addEventListener('keyup', onKeyUp, true);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('selectionchange', onSelectionChange);
  win.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
  win.addEventListener('resize', onViewportChange, { passive: true });

  function destroy() {
    doc.removeEventListener('mousedown', onMouseDown, true);
    doc.removeEventListener('mouseup', onMouseUp, true);
    doc.removeEventListener('keyup', onKeyUp, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    doc.removeEventListener('selectionchange', onSelectionChange);
    win.removeEventListener('scroll', onViewportChange, true);
    win.removeEventListener('resize', onViewportChange);
    win.clearTimeout(timer);
    token++;
    ui.hideAction();
    ui.close();
  }

  return { ui, evaluate, destroy, closePanel, translateCurrent: () => { const sel = readSelection(win, ui.hosts()); if (!sel.reason) return run(sel); return Promise.resolve(); } };
}
