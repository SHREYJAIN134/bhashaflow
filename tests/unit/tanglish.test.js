import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { createFakeChrome, until as untilFake } from '../helpers/fake-chrome.js';
import { workerSend } from '../helpers/worker-send.js';
import { LANGUAGES, DEFAULT_LANGUAGE, normalizeLanguage, isLanguage, TANGLISH_PROMPT_VERSION, LANGUAGE_SHORT } from '../../extension/src/shared/languages.js';
import { DEFAULT_SETTINGS } from '../../extension/src/shared/settings.js';
import { SYSTEM_PROMPT_V2 } from '../../backend/src/prompts/v2.js';
import { SYSTEM_PROMPT_TANGLISH_V1, VERSION_TANGLISH_V1 } from '../../backend/src/prompts/tanglish-v1.js';
import { getPrompt, getPromptForLanguage, PROMPT_VERSIONS } from '../../backend/src/prompts/index.js';
import { validateRequest } from '../../backend/src/handler.js';
import { validateItem } from '../../backend/src/validate.js';
import { createEngine } from '../../backend/src/engine.js';
import { createApp } from '../../backend/src/server.js';
import { loadConfig } from '../../backend/src/config.js';
import { createProvider } from '../../backend/src/providers/index.js';
import { createMockProvider } from '../../backend/src/providers/mock.js';
import { sourceFromTemplate } from '../../extension/src/shared/tokens.js';
import { cacheKey, createTranslationCache, createMemoryStorage } from '../../extension/src/background/translation-cache.js';
import { createTranslationService } from '../../extension/src/background/translation-service.js';
import { createRemoteConverter } from '../../extension/src/content/converter-remote.js';
import { createController } from '../../extension/src/content/controller.js';
import { createSelectionApp } from '../../extension/src/selection/selection-app.js';
import { translatePlan, planSelection } from '../../extension/src/selection/selection-core.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 1500) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(5); } return false; };
const O = '⟦';
const C = '⟧';

const SRC = 'The REST API returns 200 results in JSON format when the request is valid and complete.';
const SRC_ITEM = { id: 0, text: SRC, source: sourceFromTemplate(SRC) };
const TANGLISH = 'REST API request valid-a, complete-a irundha 200 results-a JSON format-la return pannum.';
const HINGLISH = 'REST API 200 results JSON format mein return karti hai jab request valid aur complete hoti hai.';

// ================================================================ the language module and the setting

test('exactly two languages, Hinglish is the default, unknown values fall back to it', () => {
  assert.deepEqual([...LANGUAGES], ['hinglish', 'tanglish']);
  assert.equal(DEFAULT_LANGUAGE, 'hinglish');
  assert.equal(DEFAULT_SETTINGS.targetLanguage, 'hinglish');
  assert.equal(normalizeLanguage('tanglish'), 'tanglish');
  for (const bad of [undefined, null, '', 'TANGLISH', 'tamil', 'hindi', 42, {}]) assert.equal(normalizeLanguage(bad), 'hinglish');
  assert.equal(isLanguage('tanglish'), true);
  assert.equal(isLanguage('klingon'), false);
  assert.deepEqual(LANGUAGE_SHORT, { hinglish: 'Hinglish', tanglish: 'Tanglish' });
});

// ================================================================ prompts

test('the Hinglish-v2 prompt is byte-for-byte unchanged and still the Hinglish prompt', () => {
  assert.equal(createHash('sha256').update(SYSTEM_PROMPT_V2).digest('hex'), 'f81b1f04b2e06bb734eb865b412c97ba4123b4f673d141f034e44db466b112a6');
  assert.equal(getPrompt('hinglish-v2').system, SYSTEM_PROMPT_V2);
  assert.deepEqual(PROMPT_VERSIONS, ['hinglish-v1', 'hinglish-v2'], 'Tanglish is not a Hinglish prompt version');
  assert.equal(getPromptForLanguage('hinglish').system, SYSTEM_PROMPT_V2);
  assert.equal(getPromptForLanguage('hinglish').version, 'hinglish-v2');
});

test('the Tanglish prompt is separate, Roman-only, and carries every requirement', () => {
  const p = getPromptForLanguage('tanglish');
  assert.equal(p.version, 'tanglish-v1');
  assert.equal(p.version, VERSION_TANGLISH_V1);
  assert.equal(p.version, TANGLISH_PROMPT_VERSION);
  assert.equal(p.system, SYSTEM_PROMPT_TANGLISH_V1);
  assert.notEqual(p.system, SYSTEM_PROMPT_V2);
  const s = p.system;
  for (const must of [
    'everyday spoken Tamil written ONLY in English (Roman) letters', 'Never output Tamil script and never output Devanagari',
    'NOT a word-for-word transliteration', 'NOT formal or literary', 'technical terms', 'acronyms', 'numbers', 'URLs',
    'Add nothing and drop nothing', 'Avoid stiff forms', 'Placeholder tokens', 'Every token must appear exactly once',
    '{"results":[{"id":<id>,"hinglish":"<rewritten text>"}]}', '"fix" field', 'exactly one result per input item',
  ]) assert.ok(s.toLowerCase().includes(must.toLowerCase()), `Tanglish prompt lost: ${must}`);
  assert.ok(!/[ऀ-ॿ஀-௿]/.test(s), 'the prompt itself contains no Devanagari or Tamil script, so it cannot teach either');
  assert.ok(!/\bkarein\b|\bkijiye\b/.test(s), 'no Hindi register leaks into the Tamil prompt');
});

test('selected text in Tanglish uses the Tanglish prompt; Hinglish selections keep the compact Hinglish variant', () => {
  assert.equal(getPromptForLanguage('tanglish', { selection: true }).system, SYSTEM_PROMPT_TANGLISH_V1);
  assert.notEqual(getPromptForLanguage('hinglish', { selection: true }).system, SYSTEM_PROMPT_V2);
  assert.equal(getPromptForLanguage('hinglish', { selection: true }).version, 'hinglish-v2');
});

// ================================================================ requests

test('requests carry a language: default Hinglish, Tanglish accepted, anything else rejected', () => {
  const limits = loadConfig({}).limits;
  const item = { id: 0, text: 'A sentence to translate.' };
  assert.equal(validateRequest({ v: 1, items: [item] }, limits).value.lang, 'hinglish');
  assert.equal(validateRequest({ v: 1, lang: 'tanglish', items: [item] }, limits).value.lang, 'tanglish');
  assert.equal(validateRequest({ v: 1, lang: 'hinglish', items: [item] }, limits).value.lang, 'hinglish');
  for (const bad of ['tamil', 'TANGLISH', '', 7, null]) assert.match(validateRequest({ v: 1, lang: bad, items: [item] }, limits).error, /lang must be/);
});

test('the engine picks the prompt by language, reports it, and validates in that language', async () => {
  const seen = [];
  const make = () => {
    const provider = createMockProvider();
    const complete = provider.complete.bind(provider);
    provider.complete = async (args) => { seen.push(args.system); return complete(args); };
    return createEngine({ provider, config: { ...loadConfig({}), retries: 0, requestTimeoutMs: 1000 } });
  };
  const items = [{ id: 0, text: SRC }];
  const h = await make().rewrite({ page: {}, items });
  const t = await make().rewrite({ page: {}, items, lang: 'tanglish' });
  const tSel = await make().rewrite({ page: {}, items: [{ id: 0, text: SRC, role: 'selection' }], lang: 'tanglish' });
  assert.equal(seen[0], SYSTEM_PROMPT_V2);
  assert.equal(seen[1], SYSTEM_PROMPT_TANGLISH_V1);
  assert.equal(seen[2], SYSTEM_PROMPT_TANGLISH_V1);
  assert.equal(h.meta.lang, 'hinglish');
  assert.equal(h.meta.promptVersion, 'hinglish-v2');
  assert.equal(t.meta.lang, 'tanglish');
  assert.equal(t.meta.promptVersion, 'tanglish-v1');
  assert.ok(h.results[0].hinglish && t.results[0].hinglish);
});

// ================================================================ script validation

const check = (out, lang, text = SRC) => validateItem({ id: 0, text, source: sourceFromTemplate(text) }, out, lang);

test('Tamil script is rejected in BOTH modes, Devanagari too, with a message the model can act on', () => {
  const tamil = 'REST API 200 results JSON format-la திருப்பி தரும்.';
  const deva = 'REST API 200 results JSON format में लौटाता है।';
  for (const lang of LANGUAGES) {
    const a = check(tamil, lang);
    assert.equal(a.ok, false);
    assert.match(a.issue, /Tamil script/);
    const b = check(deva, lang);
    assert.equal(b.ok, false);
    assert.match(b.issue, /Devanagari/);
  }
  assert.equal(check('ஒரு', 'tanglish', 'A').ok, false, 'a single Tamil letter is enough');
  assert.equal(check('௯ பேர்', 'hinglish', 'Nine').ok, false, 'Tamil digits and signs are in the blocked range');
});

test('natural Roman Tanglish is accepted: hyphenated endings, long spellings, numbers, acronyms, URLs, tokens', () => {
  assert.equal(check(TANGLISH, 'tanglish').ok, true);
  assert.equal(check('Machine learning-nu sollradhu artificial intelligence-oda oru branch. Idhula computers data-la irundhu kathukittu, adhoda performance-a improve pannikkum.', 'tanglish',
    'Machine learning is a branch of artificial intelligence that enables computers to learn from data and improve their performance.').ok, true);
  const withTokens = `A ${O}1${C}hash table${O}/1${C} stores data as ${O}2=code${C} pairs, so a lookup usually takes constant time.`;
  assert.equal(check(`Oru ${O}1${C}hash table${O}/1${C} data-va ${O}2=code${C} pairs-a store pannum, adhunaala lookup-ku usually constant time dhaan edukkum.`, 'tanglish', withTokens).ok, true);
  assert.equal(check('Visit https://example.com for 3.5 MB of NASA data. Idhu romba useful.', 'tanglish', 'Visit https://example.com for 3.5 MB of NASA data. This is useful.').ok, true);
});

test('Tanglish may run longer than Hinglish (romanised Tamil is spelled out), but not absurdly', () => {
  const src = 'The server restarts every night at 2 AM.';
  const long = 'Server ovvoru raathiriyum 2 AM-ku thaanaave restart aayidum, adhunaala yaarum edhayum panna vendaam, ellaam thaanaave nadakkum.';
  assert.ok(long.length / src.length > 2.6 && long.length / src.length < 3.4);
  assert.equal(check(long, 'tanglish', src).ok, true);
  assert.equal(check(long, 'hinglish', src).ok, false, 'the Hinglish limits are unchanged');
  assert.equal(check('x '.repeat(60).trim(), 'tanglish', src).ok, false);
});

test('the other validation rules apply to Tanglish too: numbers, acronyms, URLs, commentary, unchanged text', () => {
  assert.equal(check('REST API results JSON format-la return pannum.', 'tanglish').ok, false, 'dropped number 200');
  assert.equal(check('rest api 200 results json format-la return pannum, request valid irundha.', 'tanglish').ok, false, 'acronyms must be kept as written');
  assert.equal(check('Sure! ' + TANGLISH, 'tanglish').ok, false);
  assert.equal(check('Tanglish: ' + TANGLISH, 'tanglish').ok, false);
  assert.equal(check(SRC, 'tanglish').ok, false, 'English returned unchanged');
  assert.equal(check('', 'tanglish').ok, false);
  assert.equal(check(`Oru ${O}1${C}hash table pairs-a store pannum.`, 'tanglish', `A ${O}1${C}hash table${O}/1${C} stores pairs.`).ok, false, 'broken tokens');
});

// ================================================================ cache keys and the worker

test('cache keys include the language and the prompt version: Hinglish and Tanglish can never collide', async () => {
  const base = { promptVersion: 'hinglish-v2', model: 'claude-haiku-5-5', title: 'T', text: SRC, role: 'paragraph', heading: 'H' };
  const h = await cacheKey({ ...base, lang: 'hinglish' });
  const t = await cacheKey({ ...base, lang: 'tanglish' });
  const tOwnVersion = await cacheKey({ ...base, lang: 'tanglish', promptVersion: 'tanglish-v1' });
  assert.equal(await cacheKey(base), h, 'a missing language is Hinglish');
  assert.notEqual(h, t, 'language alone separates the keys');
  assert.notEqual(t, tOwnVersion, 'the prompt version alone separates the keys');
  assert.notEqual(h, tOwnVersion);
  assert.notEqual(await cacheKey({ ...base, lang: 'hinglish', promptVersion: 'hinglish-v1' }), h);
});

/** The real worker service with a counted fake backend that answers in the language it was asked for. */
function stack({ metaFor } = {}) {
  const info = { promptVersion: 'hinglish-v2', model: 'claude-haiku-5-5' };
  const calls = [];
  const svc = createTranslationService({
    cache: createTranslationCache({ storage: createMemoryStorage() }),
    getInfo: async () => info,
    backend: async (payload) => {
      calls.push({ lang: payload.lang, texts: payload.items.map((i) => i.text) });
      const lang = payload.lang;
      return { ok: true, data: { results: payload.items.map((i) => ({ id: i.id, hinglish: `${lang}: ${i.text}` })), meta: metaFor ? metaFor(lang, info) : { promptVersion: lang === 'tanglish' ? 'tanglish-v1' : 'hinglish-v2', model: info.model, lang } } };
    },
  });
  return { svc, calls, info };
}
const payload = (lang, ...texts) => ({ v: 1, ...(lang ? { lang } : {}), page: {}, items: texts.map((text, id) => ({ id, text, role: 'paragraph' })) });

test('the same text in two languages is two cache entries; each is then served from the cache without the backend', async () => {
  const { svc, calls } = stack();
  const h1 = await svc.convert(payload('hinglish', SRC));
  const t1 = await svc.convert(payload('tanglish', SRC));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.lang), ['hinglish', 'tanglish']);
  assert.equal(h1.data.results[0].hinglish, `hinglish: ${SRC}`);
  assert.equal(t1.data.results[0].hinglish, `tanglish: ${SRC}`);

  const h2 = await svc.convert(payload('hinglish', SRC));
  const t2 = await svc.convert(payload('tanglish', SRC));
  const d = await svc.convert(payload(undefined, SRC));
  assert.equal(calls.length, 2, 'both languages were served from the cache');
  assert.equal(h2.data.results[0].cached, true);
  assert.equal(t2.data.results[0].hinglish, `tanglish: ${SRC}`);
  assert.equal(d.data.results[0].hinglish, `hinglish: ${SRC}`, 'no language = Hinglish');

  const lookH = await svc.lookup(payload('hinglish', SRC));
  const lookT = await svc.lookup(payload('tanglish', SRC));
  assert.equal(lookH.data.results[0].hinglish, `hinglish: ${SRC}`);
  assert.equal(lookT.data.results[0].hinglish, `tanglish: ${SRC}`);
  assert.equal(calls.length, 2, 'lookup never touches the backend');
});

test('an answer is only cached when the backend says it used the prompt for that language', async () => {
  const { svc, calls } = stack({ metaFor: (lang, info) => ({ promptVersion: 'hinglish-v2', model: info.model, lang }) }); // wrong version for Tanglish
  await svc.convert(payload('tanglish', SRC));
  await svc.convert(payload('tanglish', SRC));
  assert.equal(calls.length, 2, 'a Tanglish answer labelled hinglish-v2 is not trusted into the cache');
  await svc.convert(payload('hinglish', SRC));
  await svc.convert(payload('hinglish', SRC));
  assert.equal(calls.length, 3, 'the Hinglish answer was cached');
});

test('the remote converter sends the language on convert and lookup, defaulting to Hinglish', async () => {
  const sent = [];
  const conv = createRemoteConverter({ send: async (m) => { sent.push(m.payload && m.payload.lang); return { ok: true, data: { results: [] } }; } });
  const items = [{ id: 0, text: SRC, context: { pageTitle: '', heading: '', role: 'paragraph' } }];
  await conv.convert(items, { lang: 'tanglish' }).catch(() => {});
  await conv.convert(items, {}).catch(() => {});
  await conv.lookup(items, { lang: 'tanglish' });
  await conv.lookup(items, {});
  await conv.convert(items, { lang: 'klingon' }).catch(() => {});
  assert.deepEqual(sent, ['tanglish', 'hinglish', 'tanglish', 'hinglish', 'hinglish']);
});

// ================================================================ through the real backend handler (Claude adapter, mocked HTTP)

test('end to end offline: a Tanglish request reaches Claude with the Tanglish prompt; Tamil-script output is rejected, never returned', async () => {
  const sentSystems = [];
  let reply = TANGLISH;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    sentSystems.push(body.system[0].text);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ results: [{ id: 0, hinglish: reply }] }) }], stop_reason: 'end_turn', usage: { input_tokens: 700, output_tokens: 60 } }) };
  };
  const config = { ...loadConfig({ PROVIDER: 'anthropic', MODEL: 'claude-haiku-5-5', ANTHROPIC_API_KEY: 'test-anthropic-key-not-real-0123456789' }), retries: 0 };
  const app = createApp(config, { provider: createProvider(config, fetchImpl) });
  const ask = (lang) => app.handle({ method: 'POST', path: '/v1/rewrite', headers: {}, ip: '1.1.1.1', body: { v: 1, ...(lang ? { lang } : {}), items: [{ id: 0, text: SRC }] } });

  const ok = await ask('tanglish');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.results[0].hinglish, TANGLISH);
  assert.equal(ok.body.meta.lang, 'tanglish');
  assert.equal(ok.body.meta.promptVersion, 'tanglish-v1');
  assert.equal(sentSystems[0], SYSTEM_PROMPT_TANGLISH_V1);

  reply = 'REST API 200 results JSON format-la திருப்பி தரும்.';
  const bad = await ask('tanglish');
  assert.equal(bad.status, 200);
  assert.equal(bad.body.results[0].hinglish, undefined, 'Tamil script never reaches the page');
  assert.equal(bad.body.results[0].error.code, 'invalid-output');
  assert.match(bad.body.results[0].error.message, /Tamil script/);
  assert.equal(sentSystems.length, 3, 'initial call + exactly one repair pass for the rejected item');

  reply = HINGLISH;
  const h = await ask(undefined);
  assert.equal(h.body.meta.lang, 'hinglish');
  assert.equal(sentSystems[3], SYSTEM_PROMPT_V2);
  assert.equal((await ask('tamil')).status, 400);
});

// ================================================================ whole page

const para = (i) => `<p id="p${i}">Paragraph ${i} explains how this particular part of the system works and why it is useful in practice today.</p>`;
const PAGE = `<body><main>${[0, 1, 2].map(para).join('')}</main></body>`;
const opts = (over = {}) => ({ ...DEFAULT_SETTINGS, ...over });

function pageStack() {
  const s = stack();
  const messages = [];
  const send = async (m) => { messages.push(m); return workerSend(s.svc)(m); };
  const controller = (dom) => createController({ root: dom.window.document.body, converter: createRemoteConverter({ send }) });
  return { ...s, messages, controller };
}

test('whole-page translation follows the chosen language (Hinglish by default) and passes it with every request', async () => {
  const s = pageStack();
  const d = new JSDOM(PAGE);
  const st = await s.controller(d).translate(opts());
  assert.equal(st.converted, 3);
  assert.ok(s.calls.every((c) => c.lang === 'hinglish'));
  assert.ok(d.window.document.getElementById('p0').textContent.startsWith('hinglish: '));

  const d2 = new JSDOM(PAGE);
  await s.controller(d2).translate(opts({ targetLanguage: 'tanglish' }));
  assert.ok(s.calls.some((c) => c.lang === 'tanglish'));
  assert.ok(d2.window.document.getElementById('p1').textContent.startsWith('tanglish: '));
  const langs = s.messages.filter((m) => m.payload).map((m) => m.payload.lang);
  assert.ok(langs.every((l) => l === 'hinglish' || l === 'tanglish'));
});

test('switching language on an already translated page re-translates from the ORIGINAL; Restore is still exact', async () => {
  const s = pageStack();
  const d = new JSDOM(PAGE);
  const ctl = s.controller(d);
  await ctl.translate(opts({ targetLanguage: 'hinglish' }));
  assert.ok(d.window.document.body.textContent.includes('hinglish: '));
  const callsBefore = s.calls.length;

  const same = await ctl.translate(opts({ targetLanguage: 'hinglish' }));
  assert.equal(s.calls.length, callsBefore, 'same language again: nothing to do');
  assert.equal(same.state, 'translated');

  const st = await ctl.translate(opts({ targetLanguage: 'tanglish' }));
  assert.equal(st.state, 'translated');
  const text = d.window.document.body.textContent;
  assert.ok(text.includes('tanglish: Paragraph 0 explains'), 'translated from English, not from the Hinglish text');
  assert.ok(!text.includes('hinglish: '), 'no Hinglish left behind');
  assert.ok(!text.includes('tanglish: hinglish'), 'never a translation of a translation');

  const back = await ctl.translate(opts({ targetLanguage: 'hinglish' }));
  assert.equal(back.state, 'translated');
  assert.ok(d.window.document.body.textContent.includes('hinglish: Paragraph 0'));
  const before = s.calls.length;
  assert.equal(before, callsBefore + 1, 'going back to Hinglish was served from the saved translations (only the Tanglish pass called the backend)');

  ctl.restore();
  assert.equal(d.serialize(), new JSDOM(PAGE).serialize(), 'exact original markup');
});

test('a language switch while a run is in progress is ignored (one run at a time); Pause and Stop are unaffected', async () => {
  const slow = stack();
  const slowBackend = async (p) => { await sleep(60); return { ok: true, data: { results: p.items.map((i) => ({ id: i.id, hinglish: `${p.lang}: ${i.text}` })), meta: { promptVersion: p.lang === 'tanglish' ? 'tanglish-v1' : 'hinglish-v2', model: slow.info.model } } }; };
  const svc = createTranslationService({ cache: createTranslationCache({ storage: createMemoryStorage() }), getInfo: async () => slow.info, backend: slowBackend });
  const d = new JSDOM(PAGE);
  const ctl = createController({ root: d.window.document.body, converter: createRemoteConverter({ send: workerSend(svc) }) });
  const run = ctl.translate(opts({ targetLanguage: 'hinglish' }));
  await sleep(10);
  const second = await ctl.translate(opts({ targetLanguage: 'tanglish' }));
  assert.equal(second.state, 'translating', 'ignored while running');
  const done = await run;
  assert.equal(done.state, 'translated');
  assert.ok(d.window.document.body.textContent.includes('hinglish: '));
  assert.ok(!d.window.document.body.textContent.includes('tanglish: '));
});

// ================================================================ selected text

const SEL_PAGE = `<!doctype html><html><body><main><h1>Caching</h1><p id="p1">A cache stores <a href="/x" id="lnk">frequently used</a> data so that future requests can be served faster.</p><p id="p2">The browser keeps a copy of each image it downloads.</p></main></body></html>`;
function selectNode(dom, el) {
  const r = dom.window.document.createRange(); r.selectNodeContents(el);
  const s = dom.window.getSelection(); s.removeAllRanges(); s.addRange(r);
}
function selectionSetup({ language } = {}) {
  const dom = new JSDOM(SEL_PAGE, { pretendToBeVisual: true, url: 'https://example.com/post' });
  const s = stack();
  const settings = { ...DEFAULT_SETTINGS, ...(language ? { targetLanguage: language } : {}) };
  const remembered = [];
  const converter = createRemoteConverter({ send: workerSend(s.svc) });
  const app = createSelectionApp({
    win: dom.window, converter, debounceMs: 5,
    getSettings: async () => ({ ...settings }),
    rememberLanguage: (l) => { remembered.push(l); settings.targetLanguage = l; }, // what the worker does with chrome.storage
  });
  const parts = () => app.ui._parts();
  return { dom, app, s, settings, remembered, parts, out: () => parts().panel && parts().panel.out.textContent };
}

test('selection panel: a language selector with both options, Hinglish by default, nothing sent until the click', async () => {
  const t = selectionSetup();
  selectNode(t.dom, t.dom.window.document.getElementById('p2'));
  await t.app.evaluate();
  assert.equal(t.s.calls.length, 0);
  t.app.ui._parts().action.button.click();
  const p = t.parts().panel;
  const select = p.lang;
  assert.equal(select.tagName, 'SELECT');
  assert.equal(select.getAttribute('aria-label'), 'Translate to');
  assert.deepEqual([...select.options].map((o) => o.value), ['hinglish', 'tanglish']);
  assert.equal(select.value, 'hinglish');
  assert.equal(p.outLabel.textContent, 'Hinglish');
  assert.ok(await until(() => /hinglish: /.test(t.out() || '')));
  assert.equal(t.s.calls[0].lang, 'hinglish');
  t.app.destroy();
});

test('changing the language in the panel re-translates the same selection, labels it, and is remembered', async () => {
  const t = selectionSetup();
  const d = t.dom.window.document;
  const before = t.dom.serialize();
  selectNode(t.dom, d.getElementById('p2'));
  await t.app.evaluate();
  t.parts().action.button.click();
  assert.ok(await until(() => /hinglish: /.test(t.out() || '')));

  const p = t.parts().panel;
  p.lang.value = 'tanglish';
  p.lang.dispatchEvent(new t.dom.window.Event('change'));
  assert.equal(p.outLabel.textContent, 'Tanglish');
  assert.match(p.panel.getAttribute('aria-label'), /Tanglish/);
  assert.ok(await until(() => /tanglish: /.test(t.out() || '')));
  assert.equal(t.out(), 'tanglish: The browser keeps a copy of each image it downloads.');
  assert.deepEqual(t.remembered, ['tanglish']);
  assert.deepEqual(t.s.calls.map((c) => c.lang), ['hinglish', 'tanglish']);

  p.lang.value = 'hinglish';
  p.lang.dispatchEvent(new t.dom.window.Event('change'));
  assert.ok(await until(() => /hinglish: /.test(t.out() || '')));
  assert.equal(t.s.calls.length, 2, 'switching back is served from the saved translations');
  assert.deepEqual(t.remembered, ['tanglish', 'hinglish']);

  t.app.closePanel();
  assert.equal(t.dom.serialize(), before, 'the page was never changed');
  t.app.destroy();
});

test('the remembered language is used for the next selection, and the panel opens already set to it', async () => {
  const t = selectionSetup({ language: 'tanglish' });
  const d = t.dom.window.document;
  selectNode(t.dom, d.getElementById('p1'));
  await t.app.evaluate();
  t.parts().action.button.click();
  assert.equal(t.parts().panel.lang.value, 'tanglish', 'set from the first moment');
  assert.ok(await until(() => /tanglish: /.test(t.out() || '')));
  assert.equal(t.s.calls[0].lang, 'tanglish');
  assert.equal(t.parts().panel.outLabel.textContent, 'Tanglish');
  t.app.destroy();
});

test('a stored value that is not a language falls back to Hinglish', async () => {
  const t = selectionSetup({ language: 'martian' });
  selectNode(t.dom, t.dom.window.document.getElementById('p2'));
  await t.app.evaluate();
  t.parts().action.button.click();
  assert.ok(await until(() => /hinglish: /.test(t.out() || '')));
  assert.equal(t.parts().panel.lang.value, 'hinglish');
  t.app.destroy();
});

test('selection errors in either language are handled: a rejected Tanglish answer shows a clear message and Try again works', async () => {
  const dom = new JSDOM(SEL_PAGE, { pretendToBeVisual: true, url: 'https://example.com/post' });
  let attempt = 0;
  const svc = createTranslationService({
    cache: createTranslationCache({ storage: createMemoryStorage() }), getInfo: async () => ({ promptVersion: 'hinglish-v2', model: 'm' }),
    backend: async (p) => {
      attempt++;
      return { ok: true, data: { results: p.items.map((i) => (attempt === 1 ? { id: i.id, error: { code: 'invalid-output', message: 'contains Tamil script; use Roman (English) letters only' } } : { id: i.id, hinglish: `${p.lang}: ${i.text}` })), meta: { promptVersion: 'tanglish-v1', model: 'm' } } };
    },
  });
  const app = createSelectionApp({ win: dom.window, converter: createRemoteConverter({ send: workerSend(svc) }), debounceMs: 5, getSettings: async () => ({ ...DEFAULT_SETTINGS, targetLanguage: 'tanglish' }) });
  selectNode(dom, dom.window.document.getElementById('p2'));
  await app.evaluate();
  app.ui._parts().action.button.click();
  assert.ok(await until(() => /unusable/.test(app.ui._parts().panel.out.textContent)));
  app.ui._parts().panel.retry.click();
  assert.ok(await until(() => /tanglish: /.test(app.ui._parts().panel.out.textContent)));
  app.destroy();
});

test('translatePlan passes the language to the cache lookup and to every request', async () => {
  const langs = [];
  const converter = {
    lookup: async (items, o) => { langs.push(['lookup', o.lang]); return []; },
    convert: async (items, o) => { langs.push(['convert', o.lang]); return items.map((i) => ({ id: i.id, hinglish: 'x ' + i.text })); },
  };
  await translatePlan(planSelection('Select this sentence please.'), { converter, lang: 'tanglish' });
  assert.deepEqual(langs, [['lookup', 'tanglish'], ['convert', 'tanglish']]);
});

// ================================================================ popup and worker (real modules, fake chrome)

const file = (p) => pathToFileURL(resolve(p)).href;
let seq = 0;

test('popup: the language selector shows the saved choice, defaults to Hinglish, and saves changes', async () => {
  const popupHtml = readFileSync('extension/src/popup/popup.html', 'utf8').replace(/<script[^>]*><\/script>/, '');
  const select = new JSDOM(popupHtml).window.document.getElementById('targetLanguage');
  assert.deepEqual([...select.options].map((o) => o.value), ['hinglish', 'tanglish']);
  assert.match(select.options[0].textContent, /Hinglish/);
  assert.match(select.options[1].textContent, /Tanglish/);

  for (const [stored, expected] of [[undefined, 'hinglish'], ['tanglish', 'tanglish'], ['nonsense', 'hinglish']]) {
    const fake = createFakeChrome({ tabUrl: 'https://example.com/a', storage: stored ? { targetLanguage: stored } : {} });
    const dom = new JSDOM(popupHtml, { url: 'chrome-extension://bhashaflow-test/popup.html' });
    globalThis.chrome = fake.chrome;
    globalThis.document = dom.window.document;
    await import(`${file('extension/src/popup/popup.js')}?lang=${++seq}`);
    const el = dom.window.document.getElementById('targetLanguage');
    await untilFake(() => el.value === expected, { what: `selector to show ${expected} for ${stored}` });

    el.value = 'tanglish';
    el.dispatchEvent(new dom.window.Event('change'));
    await untilFake(() => fake.data.targetLanguage === 'tanglish', { what: 'Tanglish to be saved' });
    assert.match(dom.window.document.getElementById('status').textContent, /Tanglish/);
    el.value = 'hinglish';
    el.dispatchEvent(new dom.window.Event('change'));
    await untilFake(() => fake.data.targetLanguage === 'hinglish', { what: 'Hinglish to be saved' });
  }
});

test('service worker: SET_LANGUAGE stores only a valid language (the page script itself never writes storage)', async () => {
  const fake = createFakeChrome({ storage: {} });
  globalThis.chrome = fake.chrome;
  globalThis.__BACKEND_URL__ = 'http://127.0.0.1:1';
  fake.registerAs('sw');
  await import(`${file('extension/src/background/service-worker.js')}?lang=${++seq}`);
  const ask = (language) => fake.chrome.runtime.sendMessage({ type: 'bf:set-language', language });
  assert.deepEqual(await ask('tanglish'), { ok: true, language: 'tanglish' });
  assert.equal(fake.data.targetLanguage, 'tanglish');
  assert.deepEqual(await ask('klingon'), { ok: true, language: 'hinglish' });
  assert.equal(fake.data.targetLanguage, 'hinglish');
  assert.deepEqual(await ask(undefined), { ok: true, language: 'hinglish' });

  const selectionEntry = readFileSync('extension/src/selection/index.js', 'utf8');
  assert.match(selectionEntry, /MSG\.SET_LANGUAGE/);
  assert.ok(!/storage\.local\.set/.test(readFileSync('extension/dist/selection.js', 'utf8')), 'the always-loaded script only messages the worker');
});

test('the build ships no Tamil script or language data that is not needed, and the key stays out of the extension', () => {
  const bundle = readFileSync('extension/dist/selection.js', 'utf8') + readFileSync('extension/dist/popup.js', 'utf8');
  assert.ok(!/ANTHROPIC_API_KEY|x-api-key|sk-ant-/.test(bundle));
});
