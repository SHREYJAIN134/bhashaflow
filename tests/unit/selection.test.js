import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readSelection, extractText, planSelection, translatePlan, assemble, friendlyError, limitsFromHints, SelectionError, MAX_SELECTION_CHARS } from '../../extension/src/selection/selection-core.js';
import { createSelectionApp } from '../../extension/src/selection/selection-app.js';
import { place } from '../../extension/src/selection/panel.js';
import { createRemoteConverter } from '../../extension/src/content/converter-remote.js';
import { createTranslationCache, createMemoryStorage } from '../../extension/src/background/translation-cache.js';
import { createTranslationService } from '../../extension/src/background/translation-service.js';
import { DEFAULT_SETTINGS } from '../../extension/src/shared/settings.js';
import { workerSend } from '../helpers/worker-send.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 1500) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(5); } return false; };

const PAGE = `<!doctype html><html><body>
<main id="main">
  <h1 id="h">Caching basics</h1>
  <p id="p1">A cache stores <a href="/x" id="lnk">frequently used</a> data so that future <b>requests</b> can be served faster.</p>
  <p id="p2">The browser keeps a copy of each image it downloads.</p>
  <ul><li id="l1">First item explains the idea.</li><li id="l2">Second item gives an example.</li></ul>
  <p id="p3">Line one of a poem<br>line two of the poem</p>
  <p id="p4">Use <code id="code">map()</code> to transform every element of the list.</p>
  <pre id="pre">const x = compute(1, 2);\nreturn x;</pre>
  <input id="txt" type="text" value="typed text here"><input id="pw" type="password" value="hunter2hunter2">
  <textarea id="ta">draft message typed by the user</textarea>
  <div id="ce" contenteditable="true">editable words here</div>
  <div class="CodeMirror" id="cm"><div class="CodeMirror-line" id="cmline">let editorContent = 1;</div></div>
</main></body></html>`;

function makeDom() { return new JSDOM(PAGE, { pretendToBeVisual: true, url: 'https://example.com/post' }); }
function selectNode(dom, el) {
  const d = dom.window.document;
  const r = d.createRange(); r.selectNodeContents(el);
  const s = dom.window.getSelection(); s.removeAllRanges(); s.addRange(r);
}
function selectBetween(dom, from, to) {
  const d = dom.window.document;
  const r = d.createRange(); r.setStartBefore(d.getElementById(from)); r.setEndAfter(d.getElementById(to));
  const s = dom.window.getSelection(); s.removeAllRanges(); s.addRange(r);
}

// ================================================================ reading a selection

test('selection text: inline elements (links, bold) are read as plain running text, the page is untouched', () => {
  const dom = makeDom();
  const before = dom.serialize();
  selectNode(dom, dom.window.document.getElementById('p1'));
  const sel = readSelection(dom.window);
  assert.equal(sel.reason, undefined);
  assert.equal(sel.text.trim(), 'A cache stores frequently used data so that future requests can be served faster.');
  assert.equal(dom.serialize(), before, 'reading a selection changes nothing');
});

test('multi-line selections keep their line breaks: paragraphs, list items, <br>', () => {
  const dom = makeDom();
  selectBetween(dom, 'p2', 'l2');
  const lines = readSelection(dom.window).text.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(lines, ['The browser keeps a copy of each image it downloads.', 'First item explains the idea.', 'Second item gives an example.']);
  selectNode(dom, dom.window.document.getElementById('p3'));
  assert.deepEqual(readSelection(dom.window).text.split('\n').map((l) => l.trim()).filter(Boolean), ['Line one of a poem', 'line two of the poem']);
});

test('a selection that starts in the middle of a paragraph and ends inside a link works', () => {
  const dom = makeDom();
  const d = dom.window.document;
  const r = d.createRange();
  r.setStart(d.getElementById('p1').firstChild, 2); // "cache stores "
  r.setEnd(d.getElementById('lnk').firstChild, 8); // "frequent"
  const s = dom.window.getSelection(); s.removeAllRanges(); s.addRange(r);
  assert.equal(readSelection(dom.window).text, 'cache stores frequent');
});

test('protected content is never offered: inputs, password, textarea, editable, code editors, code blocks', () => {
  const dom = makeDom();
  const d = dom.window.document;
  for (const id of ['txt', 'pw', 'ta']) {
    const el = d.getElementById(id);
    el.focus();
    el.select();
    assert.equal(readSelection(dom.window).reason, 'protected', `${id} focused with a selection`);
    el.blur();
  }
  for (const id of ['ce', 'cmline', 'pre']) {
    selectNode(dom, d.getElementById(id));
    assert.equal(readSelection(dom.window).reason, 'protected', id);
  }
  selectNode(dom, d.getElementById('code'));
  assert.equal(readSelection(dom.window).reason, 'protected', 'a selection entirely inside inline code');
  d.getElementById('ce').focus();
  selectNode(dom, d.getElementById('p2'));
  assert.equal(readSelection(dom.window).reason, 'protected', 'while the user is typing in an editable element');
});

test('a selection that merely includes inline code is fine; code BLOCKS and editors inside a larger selection are left out', () => {
  const dom = makeDom();
  const d = dom.window.document;
  selectNode(dom, d.getElementById('p4'));
  assert.match(readSelection(dom.window).text, /Use map\(\) to transform every element/);
  selectBetween(dom, 'p4', 'cm');
  const text = readSelection(dom.window).text;
  assert.match(text, /transform every element of the list/);
  assert.ok(!text.includes('compute(1, 2)'), '<pre> text is excluded');
  assert.ok(!text.includes('editorContent'), 'code editor text is excluded');
  assert.ok(!text.includes('hunter2') && !text.includes('typed text here'), 'field values are never in the text');
});

test('empty and collapsed selections are reported as empty; own UI is ignored', () => {
  const dom = makeDom();
  assert.equal(readSelection(dom.window).reason, 'empty');
  const d = dom.window.document;
  const r = d.createRange(); r.setStart(d.getElementById('p2').firstChild, 3); r.collapse(true);
  dom.window.getSelection().addRange(r);
  assert.equal(readSelection(dom.window).reason, 'empty');
  const spaces = d.createElement('p'); spaces.textContent = '   \n  '; d.body.append(spaces);
  selectNode(dom, spaces);
  assert.equal(readSelection(dom.window).reason, 'empty', 'whitespace only');
  const host = d.createElement('div'); host.textContent = 'ui text here'; d.body.append(host);
  selectNode(dom, host);
  assert.equal(readSelection(dom.window, [host]).reason, 'own-ui');
});

test('extractText skips scripts/styles and hidden elements', () => {
  const d = new JSDOM('<p>Visible <script>var s = 1;</script><style>.a{}</style><span hidden>secret</span>text.</p>').window.document;
  assert.equal(extractText(d.querySelector('p')).replace(/\s+/g, ' ').trim(), 'Visible text.');
});

// ================================================================ planning

test('planSelection: empty, tokens, passthrough, length limits', () => {
  assert.equal(planSelection('   \n \n').error.code, 'empty');
  assert.equal(planSelection('12345 67.8 %').error.code, 'nothing-to-translate');
  assert.equal(planSelection('x'.repeat(MAX_SELECTION_CHARS + 1)).error.code, 'too-long');

  const p = planSelection('Heading text here\n\n2024\r\nThe server returns a value.  ');
  assert.deepEqual(p.blocks.map((b) => [b.text, b.passthrough]), [['Heading text here', false], ['2024', true], ['The server returns a value.', false]]);
  assert.deepEqual(p.units, ['Heading text here', 'The server returns a value.']);

  const t = planSelection('Keep ⟦1⟧ this text safe');
  assert.ok(!/[⟦⟧]/.test(t.units[0]), 'placeholder brackets in the selection cannot forge template tokens');
});

test('planSelection: a long paragraph becomes whole-sentence groups; an unsplittable one is refused', () => {
  const sentence = 'This sentence describes one more detail of how the system behaves.';
  const para = Array.from({ length: 8 }, () => sentence).join(' ');
  const plan = planSelection(para, { maxItems: 6, maxChars: 500, maxItemChars: 200 });
  assert.equal(plan.blocks.length, 1);
  assert.ok(plan.blocks[0].parts.length >= 3);
  assert.ok(plan.blocks[0].parts.every((x) => x.length <= 200));
  assert.equal(plan.blocks[0].parts.join(' '), para);
  assert.equal(planSelection('word '.repeat(60), { maxItems: 6, maxChars: 500, maxItemChars: 100 }).error.code, 'too-long');
});

test('limitsFromHints can only lower the defaults', () => {
  assert.deepEqual(limitsFromHints({ batch: { maxItems: 2, maxChars: 99999, maxItemChars: 300 } }), { maxItems: 2, maxChars: 1800, maxItemChars: 300 });
  assert.deepEqual(limitsFromHints(undefined), { maxItems: 12, maxChars: 1800, maxItemChars: 3900 });
});

// ================================================================ running a plan

const converterOf = ({ saved = {}, fresh = (t) => `HI ${t}`, convert } = {}) => {
  const calls = { lookup: 0, convert: [] };
  return {
    calls,
    lookup: async (items) => { calls.lookup++; return items.filter((i) => saved[i.text]).map((i) => ({ id: i.id, hinglish: saved[i.text], cached: true })); },
    convert: convert || (async (items) => { calls.convert.push(items.map((i) => i.text)); return items.map((i) => ({ id: i.id, hinglish: fresh(i.text) })); }),
  };
};

test('translatePlan: all saved -> no convert at all; mixed -> only misses, one request at a time in small batches, progress as it goes', async () => {
  const plan = planSelection('Alpha sentence one.\nBeta sentence two.\nGamma sentence three.');
  const all = converterOf({ saved: { 'Alpha sentence one.': 'A1', 'Beta sentence two.': 'B2', 'Gamma sentence three.': 'G3' } });
  const out = await translatePlan(plan, { converter: all });
  assert.deepEqual(out, { text: 'A1\nB2\nG3', fromCache: true, requests: 0 });
  assert.equal(all.calls.convert.length, 0);

  const mixed = converterOf({ saved: { 'Beta sentence two.': 'B2' } });
  const progress = [];
  const out2 = await translatePlan(plan, { converter: mixed, limits: { maxItems: 1, maxChars: 500, maxItemChars: 600 }, onProgress: (t) => progress.push(t) });
  assert.equal(out2.text, 'HI Alpha sentence one.\nB2\nHI Gamma sentence three.');
  assert.deepEqual(mixed.calls.convert, [['Alpha sentence one.'], ['Gamma sentence three.']]);
  assert.equal(out2.fromCache, false);
  assert.deepEqual(progress[progress.length - 1], 'HI Alpha sentence one.\nB2\nHI Gamma sentence three.');
  assert.ok(progress.length >= 2);
});

test('translatePlan: duplicates are translated once; passthrough blocks are never sent', async () => {
  const plan = planSelection('Same line here.\n42\nSame line here.');
  const c = converterOf();
  const out = await translatePlan(plan, { converter: c });
  assert.deepEqual(c.calls.convert, [['Same line here.']]);
  assert.equal(out.text, 'HI Same line here.\n42\nHI Same line here.');
});

test('translatePlan: errors carry codes; a bad or short reply fails clearly; cancelling stops further requests', async () => {
  const plan = planSelection('First line is here.\nSecond line is here.');
  await assert.rejects(translatePlan(plan, { converter: converterOf({ convert: async () => { throw Object.assign(new Error('x'), { code: 'provider-ollama-not-running' }); } }) }),
    (e) => e instanceof SelectionError && e.code === 'provider-ollama-not-running');
  await assert.rejects(translatePlan(plan, { converter: converterOf({ convert: async (items) => items.map((i) => ({ id: i.id, error: { code: 'invalid-output', message: 'bad' } })) }) }),
    (e) => e.code === 'invalid-output');
  await assert.rejects(translatePlan(plan, { converter: converterOf({ convert: async (items) => [{ id: 0, hinglish: 'only one' }] }) }), (e) => e.code === 'missing-result');
  await assert.rejects(translatePlan(plan, { converter: converterOf({ convert: async () => 'junk' }) }), (e) => e.code === 'missing-result');
  await assert.rejects(translatePlan(plan, { converter: converterOf({ convert: async (items) => items.map((i) => ({ id: i.id, hinglish: 42 })) }) }), (e) => e.code === 'bad-response');

  let calls = 0;
  let cancelled = false;
  const c = converterOf({ convert: async (items) => { calls++; cancelled = true; return items.map((i) => ({ id: i.id, hinglish: 'x' })); } });
  assert.equal(await translatePlan(plan, { converter: c, limits: { maxItems: 1, maxChars: 500, maxItemChars: 600 }, isCancelled: () => cancelled }), null);
  assert.equal(calls, 1, 'no second request after cancellation');
});

test('translatePlan tolerates a broken lookup and falls back to the model', async () => {
  const plan = planSelection('Only line here.');
  const c = converterOf();
  c.lookup = async () => { throw new Error('worker asleep'); };
  assert.equal((await translatePlan(plan, { converter: c })).text, 'HI Only line here.');
  c.lookup = async () => [{ id: 9, hinglish: 'x' }, null, { id: 0, hinglish: '   ' }];
  assert.equal((await translatePlan(plan, { converter: c })).text, 'HI Only line here.');
});

test('assemble: partial output stops at the first unfinished block', () => {
  const plan = planSelection('One line here.\nTwo line here.\nThree line here.');
  const results = new Map([['One line here.', '1'], ['Three line here.', '3']]);
  assert.equal(assemble(plan, results, true), '1');
  assert.equal(assemble(plan, new Map(), true), '');
});

test('friendlyError: clear, actionable messages; backend wording kept where it names the fix', () => {
  assert.match(friendlyError('provider-ollama-not-running', 'Could not reach Ollama at http://127.0.0.1:11434. Start it (run "ollama serve").'), /ollama serve/);
  assert.match(friendlyError('ollama-model-missing', 'Ollama does not have the model "qwen3:4b". Install it with: ollama pull qwen3:4b'), /ollama pull/);
  assert.match(friendlyError('unreachable'), /npm run backend/);
  assert.match(friendlyError('provider-timeout'), /too long/);
  assert.match(friendlyError('provider-bad-json'), /unusable/);
  assert.match(friendlyError('invalid-output'), /unusable/);
  assert.equal(friendlyError('internal', 'secret detail'), 'Translation failed. Try again.');
  assert.equal(friendlyError(undefined, undefined), 'Translation failed. Try again.');
});

test('panel placement stays inside the viewport and flips above when there is no room below', () => {
  assert.deepEqual(place({ top: 100, bottom: 120, left: 50, right: 300 }, 200, 100, 1000, 800), { top: 128, left: 100 });
  assert.equal(place({ top: 700, bottom: 720, left: 50, right: 300 }, 200, 100, 1000, 800).top, 592, 'above the selection');
  assert.equal(place({ top: 10, bottom: 30, left: 0, right: 5 }, 400, 100, 300, 800).left, 8, 'never off the left edge');
  assert.ok(place(null, 200, 100, 1000, 800).top >= 8);
});

// ================================================================ the whole feature in a page

/** Real worker service (cache, dedupe, validation hook) + real remote converter; counted fake backend. */
function setup({ settings = {}, latency = 0, backend } = {}) {
  const dom = makeDom();
  const info = { promptVersion: 'hinglish-v2', model: 'qwen3:4b' };
  const backendCalls = [];
  const messages = [];
  let gate = null;
  const svc = createTranslationService({
    cache: createTranslationCache({ storage: createMemoryStorage() }),
    getInfo: async () => info,
    backend: backend ? async (p) => { backendCalls.push(p.items.map((i) => i.text)); return backend(p, info); } : async (p) => {
      backendCalls.push(p.items.map((i) => i.text));
      if (latency) await sleep(latency);
      if (gate) await gate.promise;
      return { ok: true, data: { results: p.items.map((i) => ({ id: i.id, hinglish: `Hinglish: ${i.text}` })), meta: info } };
    },
  });
  const inner = workerSend(svc, { maxConcurrency: 1, batch: { maxItems: 6, maxChars: 500, maxItemChars: 600 } });
  const converter = createRemoteConverter({ send: async (m) => { messages.push(m); return inner(m); } });
  const app = createSelectionApp({ win: dom.window, converter, getSettings: async () => ({ ...DEFAULT_SETTINGS, ...settings }), debounceMs: 5 });
  const parts = () => app.ui._parts();
  return {
    dom, app, svc, backendCalls, messages, parts,
    hold() { let open; gate = { promise: new Promise((r) => { open = r; }) }; return () => { open(); gate = null; }; },
    action: () => parts().action && parts().action.button,
    out: () => parts().panel && parts().panel.out.textContent,
    note: () => parts().panel && parts().panel.note.textContent,
    sent: () => messages.filter((m) => m.type === 'bf:convert' || m.type === 'bf:lookup'),
  };
}

test('default mode: selecting text shows the button but sends NOTHING; only a click translates', async () => {
  const t = setup();
  selectNode(t.dom, t.dom.window.document.getElementById('p2'));
  await t.app.evaluate();
  assert.ok(t.action(), 'the Translate Selection button is shown');
  assert.equal(t.action().textContent, 'Translate Selection');
  await sleep(50);
  assert.equal(t.messages.length, 0, 'no message of any kind left the page');
  assert.equal(t.backendCalls.length, 0);
  assert.equal(t.app.ui.panelOpen, false);

  t.action().click();
  assert.equal(t.app.ui.panelOpen, true);
  assert.ok(await until(() => /Hinglish: /.test(t.out() || '')));
  assert.equal(t.out(), 'Hinglish: The browser keeps a copy of each image it downloads.');
  assert.equal(t.backendCalls.length, 1);
  t.app.destroy();
});

test('the panel shows original, Hinglish, loading state, Copy and Close; the page is left exactly as it was', async () => {
  const t = setup();
  const d = t.dom.window.document;
  const before = t.dom.serialize();
  const textBefore = d.getElementById('p1').textContent;
  const release = t.hold();
  selectNode(t.dom, d.getElementById('p1'));
  await t.app.evaluate();
  t.action().click();
  const p = t.parts().panel;
  assert.match(p.out.textContent, /Translating/);
  assert.ok(p.out.querySelector('.spin'), 'loading indicator');
  assert.equal(p.copy.disabled, true, 'nothing to copy yet');
  assert.match(p.orig.textContent, /A cache stores frequently used data so that future requests can be served faster\./);
  release();
  assert.ok(await until(() => /Hinglish: /.test(t.out())));
  assert.equal(p.copy.disabled, false);
  assert.equal(d.getElementById('p1').textContent, textBefore, 'selected text is not replaced');
  assert.equal(d.getElementById('lnk').getAttribute('href'), '/x');
  assert.equal(d.getElementById('lnk').isConnected, true);
  assert.equal(t.dom.window.getSelection().toString().trim().startsWith('A cache stores'), true, 'the page selection is still there');
  const closeBtn = p.panel.querySelector('.close');
  closeBtn.click();
  assert.equal(t.app.ui.panelOpen, false);
  assert.equal(t.dom.serialize(), before, 'after Close the DOM is byte-identical to the original');
  t.app.destroy();
});

test('multi-line selection across elements is translated line by line and shown with the same line breaks', async () => {
  const t = setup();
  selectBetween(t.dom, 'p2', 'l2');
  await t.app.evaluate();
  t.action().click();
  assert.ok(await until(() => /Second item/.test(t.out() || '')));
  assert.equal(t.out(), ['Hinglish: The browser keeps a copy of each image it downloads.', 'Hinglish: First item explains the idea.', 'Hinglish: Second item gives an example.'].join('\n'));
  assert.deepEqual(t.backendCalls.flat().length, 3);
  t.app.destroy();
});

test('a repeated selection is served from the cache: no Ollama/backend request, instant', async () => {
  const t = setup();
  const d = t.dom.window.document;
  selectNode(t.dom, d.getElementById('p2'));
  await t.app.evaluate();
  t.action().click();
  assert.ok(await until(() => /Hinglish: /.test(t.out() || '')));
  assert.equal(t.backendCalls.length, 1);
  assert.equal(t.note(), '');
  t.app.closePanel();

  selectNode(t.dom, d.getElementById('p2'));
  await t.app.evaluate();
  const t0 = Date.now();
  t.action().click();
  assert.ok(await until(() => /Hinglish: /.test(t.out() || '')));
  assert.ok(Date.now() - t0 < 250, 'rendered from the cache');
  assert.equal(t.backendCalls.length, 1, 'the model was not asked again');
  assert.equal(t.sent().filter((m) => m.type === 'bf:convert').length, 1, 'no second convert message, only a cache lookup');
  assert.match(t.note(), /Saved/);
  t.app.destroy();
});

test('a different selection that contains a saved line only requests the new line', async () => {
  const t = setup();
  const d = t.dom.window.document;
  selectNode(t.dom, d.getElementById('p2'));
  await t.app.evaluate(); t.action().click();
  assert.ok(await until(() => /Hinglish: /.test(t.out() || '')));
  t.app.closePanel();
  selectBetween(t.dom, 'p2', 'l1');
  await t.app.evaluate(); t.action().click();
  assert.ok(await until(() => /First item/.test(t.out() || '')));
  assert.deepEqual(t.backendCalls[1], ['First item explains the idea.']);
  t.app.destroy();
});

test('repeated clicks and the keyboard shortcut during a translation make ONE request; a new selection supersedes the old one', async () => {
  const t = setup();
  const d = t.dom.window.document;
  const release = t.hold();
  selectNode(t.dom, d.getElementById('p2'));
  await t.app.evaluate();
  t.action().click();
  t.dom.window.document.dispatchEvent(new t.dom.window.KeyboardEvent('keydown', { key: 'T', code: 'KeyT', altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  await t.app.translateCurrent();
  await sleep(40);
  assert.equal(t.backendCalls.length, 1, 'one in-flight request');

  selectNode(t.dom, d.getElementById('l1')); // user selects something else and translates it while the first is pending
  await t.app.evaluate();
  t.action().click();
  release();
  assert.ok(await until(() => /First item/.test(t.out() || '')));
  assert.equal(t.out(), 'Hinglish: First item explains the idea.', 'the superseded answer never shows');
  t.app.destroy();
});

test('Alt+Shift+T translates the current selection; with no selection it leaves the key to the page', async () => {
  const t = setup();
  const d = t.dom.window.document;
  const key = () => new t.dom.window.KeyboardEvent('keydown', { key: 'T', code: 'KeyT', altKey: true, shiftKey: true, bubbles: true, cancelable: true });
  const none = key();
  d.dispatchEvent(none);
  assert.equal(none.defaultPrevented, false);
  assert.equal(t.app.ui.panelOpen, false);
  selectNode(t.dom, d.getElementById('p2'));
  const ev = key();
  d.dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true);
  assert.ok(await until(() => /Hinglish: /.test(t.out() || '')));
  t.app.destroy();
});

test('Escape closes the panel (and only then swallows the key); focus returns to where the user was', async () => {
  const t = setup();
  const d = t.dom.window.document;
  const link = d.getElementById('lnk');
  link.focus();
  const pageSaw = [];
  t.dom.window.addEventListener('keydown', (e) => pageSaw.push(e.key));

  selectNode(t.dom, d.getElementById('p2'));
  await t.app.evaluate();
  const idle = new t.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  d.body.dispatchEvent(idle);
  assert.equal(idle.defaultPrevented, false, 'with only the button showing, Escape is not swallowed');
  assert.equal(t.app.ui.actionVisible, false, 'but it hides the button');
  assert.equal(pageSaw.length, 1);

  await t.app.evaluate();
  t.action().click();
  assert.equal(t.app.ui.panelOpen, true);
  assert.equal(t.parts().panel.panel.getAttribute('role'), 'dialog');
  const esc = new t.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  d.body.dispatchEvent(esc);
  assert.equal(t.app.ui.panelOpen, false);
  assert.equal(pageSaw.length, 1, 'the page did not also receive this Escape');
  assert.equal(d.activeElement, link, 'focus is back where it was');
  const other = new t.dom.window.KeyboardEvent('keydown', { key: 'a', bubbles: true });
  d.body.dispatchEvent(other);
  assert.equal(pageSaw.length, 2, 'ordinary keys are untouched');
  t.app.destroy();
});

test('keyboard accessibility: real buttons with labels, the panel takes focus, controls are tabbable', async () => {
  const t = setup();
  const d = t.dom.window.document;
  selectNode(t.dom, d.getElementById('p2'));
  await t.app.evaluate();
  assert.equal(t.action().tagName, 'BUTTON');
  assert.match(t.action().getAttribute('aria-label'), /Translate/);
  t.action().click();
  const p = t.parts().panel;
  assert.equal(p.panel.getAttribute('aria-label'), 'BhashaFlow Hinglish translation');
  assert.match(p.panel.querySelector('.close').getAttribute('aria-label'), /Close.*Escape/);
  assert.equal(p.out.getAttribute('aria-live'), 'polite');
  assert.ok(p.panel.tabIndex === -1, 'focusable programmatically');
  assert.ok(await until(() => /Hinglish: /.test(t.out())));
  for (const b of p.panel.querySelectorAll('button')) assert.equal(b.tabIndex, 0, `${b.className} is in the tab order`);
  t.app.destroy();
});

test('Copy Translation copies the Hinglish text (clipboard API, with a legacy fallback)', async () => {
  const t = setup();
  const d = t.dom.window.document;
  const copied = [];
  Object.defineProperty(t.dom.window.navigator, 'clipboard', { value: { writeText: async (x) => { copied.push(x); } }, configurable: true });
  selectNode(t.dom, d.getElementById('p2'));
  await t.app.evaluate(); t.action().click();
  assert.ok(await until(() => /Hinglish: /.test(t.out())));
  assert.equal(await t.app.ui.copyResult(), true);
  assert.deepEqual(copied, ['Hinglish: The browser keeps a copy of each image it downloads.']);
  assert.equal(t.note(), 'Copied');

  Object.defineProperty(t.dom.window.navigator, 'clipboard', { value: undefined, configurable: true });
  d.execCommand = () => true;
  assert.equal(await t.app.ui.copyResult(), true, 'legacy path');
  d.execCommand = () => false;
  assert.equal(await t.app.ui.copyResult(), false);
  assert.equal(t.note(), 'Could not copy');
  t.app.destroy();
});

test('Ollama not running: a clear message and a working Try again', async () => {
  let up = false;
  const t = setup({ backend: async (p, info) => (up
    ? { ok: true, data: { results: p.items.map((i) => ({ id: i.id, hinglish: `Hinglish: ${i.text}` })), meta: info } }
    : { ok: false, error: { code: 'provider-ollama-not-running', message: 'Could not reach Ollama at http://127.0.0.1:11434. Start it (run "ollama serve", or open the Ollama app) and try again.' } }) });
  selectNode(t.dom, t.dom.window.document.getElementById('p2'));
  await t.app.evaluate(); t.action().click();
  assert.ok(await until(() => /ollama serve/.test(t.out() || '')));
  const p = t.parts().panel;
  assert.equal(p.out.className, 'out error');
  assert.equal(p.retry.hidden, false);
  assert.equal(p.copy.disabled, true);
  up = true;
  p.retry.click();
  assert.ok(await until(() => /Hinglish: /.test(t.out() || '')));
  assert.equal(p.retry.hidden, true);
  t.app.destroy();
});

test('timeout and failed translations are reported plainly; the page and the panel stay usable', async () => {
  const t = setup({ backend: async () => ({ ok: false, error: { code: 'provider-timeout', message: 'The AI provider took too long to answer. Try again.' } }) });
  selectNode(t.dom, t.dom.window.document.getElementById('p2'));
  await t.app.evaluate(); t.action().click();
  assert.ok(await until(() => /too long/.test(t.out() || '')));
  t.app.closePanel();

  const bad = setup({ backend: async (p, info) => ({ ok: true, data: { results: p.items.map((i) => ({ id: i.id, error: { code: 'invalid-output', message: 'x' } })), meta: info } }) });
  selectNode(bad.dom, bad.dom.window.document.getElementById('p2'));
  await bad.app.evaluate(); bad.action().click();
  assert.ok(await until(() => /unusable/.test(bad.out() || '')));
  assert.equal(bad.parts().panel.retry.hidden, false);
  t.app.destroy(); bad.app.destroy();
});

test('a selection that is too long is refused with a clear message and nothing is sent', async () => {
  const t = setup();
  const d = t.dom.window.document;
  const p = d.createElement('p'); p.id = 'huge'; p.textContent = 'Word '.repeat(600); d.getElementById('main').append(p);
  selectNode(t.dom, p);
  await t.app.evaluate(); t.action().click();
  assert.ok(await until(() => /characters/.test(t.out() || '')));
  assert.equal(t.parts().panel.retry.hidden, true);
  assert.equal(t.sent().length, 0);
  t.app.destroy();
});

test('nothing is offered for empty, protected or disabled cases', async () => {
  const t = setup();
  const d = t.dom.window.document;
  await t.app.evaluate();
  assert.equal(t.app.ui.actionVisible, false, 'no selection');
  d.getElementById('ta').focus(); d.getElementById('ta').select();
  await t.app.evaluate();
  assert.equal(t.app.ui.actionVisible, false, 'text area');
  d.getElementById('ta').blur();
  selectNode(t.dom, d.getElementById('pre'));
  await t.app.evaluate();
  assert.equal(t.app.ui.actionVisible, false, 'code block');
  t.app.destroy();

  for (const settings of [{ selectionMode: false }, { enabled: false }]) {
    const off = setup({ settings });
    selectNode(off.dom, off.dom.window.document.getElementById('p2'));
    await off.app.evaluate();
    assert.equal(off.app.ui.actionVisible, false, JSON.stringify(settings));
    off.app.destroy();
  }
});

test('real mouse and keyboard events drive the button: select with the mouse, press a key to hide it, collapse the selection', async () => {
  const t = setup();
  const d = t.dom.window.document;
  const w = t.dom.window;
  d.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
  selectNode(t.dom, d.getElementById('p2'));
  d.dispatchEvent(new w.MouseEvent('mouseup', { bubbles: true }));
  assert.ok(await until(() => t.app.ui.actionVisible), 'button appears after the mouse is released');
  w.getSelection().removeAllRanges();
  d.dispatchEvent(new w.Event('selectionchange'));
  assert.equal(t.app.ui.actionVisible, false, 'and goes away when the selection does');
  d.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(t.app.ui.actionVisible, false);
  t.app.destroy();
});

test('the floating UI does not interfere with the page: its own host nodes only, page handlers and focus still work', async () => {
  const t = setup();
  const d = t.dom.window.document;
  let clicks = 0;
  d.getElementById('lnk').addEventListener('click', (e) => { e.preventDefault(); clicks++; });
  const before = [...d.body.children].map((n) => n.outerHTML);
  selectNode(t.dom, d.getElementById('p2'));
  await t.app.evaluate();
  const added = [...d.documentElement.children].filter((n) => n.hasAttribute('data-bhashaflow'));
  assert.equal(added.length, 1, 'one host element, attached to <html>, nothing inside <body>');
  assert.deepEqual([...d.body.children].map((n) => n.outerHTML), before);
  const md = new t.dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true });
  t.action().dispatchEvent(md);
  assert.equal(md.defaultPrevented, true, 'pressing the button does not collapse the page selection');
  d.getElementById('lnk').click();
  assert.equal(clicks, 1, 'page click handlers still run');
  t.app.destroy();
  assert.equal([...d.documentElement.children].filter((n) => n.hasAttribute('data-bhashaflow')).length, 0, 'destroy removes every trace');
});

test('selection mode is on by default and the whole-page action is still wired in the popup', async () => {
  assert.equal(DEFAULT_SETTINGS.selectionMode, true);
  const { readFileSync } = await import('node:fs');
  const html = readFileSync('extension/src/popup/popup.html', 'utf8');
  assert.match(html, /id="translate"[^>]*>Translate whole page/);
  assert.match(html, /id="selectionMode"/);
  assert.match(html, /Translate Selection/);
});
