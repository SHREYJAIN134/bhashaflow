// End-to-end SIMULATION: the real popup, content script and service worker modules run in one Node process,
// connected by a fake `chrome` messaging bus (tests/helpers/fake-chrome.js) and talking to a real HTTP backend
// with the offline mock provider. It exercises our code and the message protocol. It does NOT prove Chrome
// itself behaves the same (manifest loading, worker lifetime, real IndexedDB): see the in-browser checks in
// docs/VERIFICATION.md for what was run in a real browser.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { createFakeChrome, until } from '../helpers/fake-chrome.js';
import { createApp, createServer } from '../../backend/src/server.js';
import { loadConfig } from '../../backend/src/config.js';
import { createMockProvider } from '../../backend/src/providers/mock.js';
import { createOpenAICompatProvider } from '../../backend/src/providers/openai-compat.js';
import { MSG } from '../../extension/src/shared/messages.js';
import { MOCK_PREFIX } from '../../extension/src/content/converter.js';

const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));
const consoleProblems = [];
const realError = console.error;
const realWarn = console.warn;
console.error = (...a) => { consoleProblems.push(`error: ${a.join(' ')}`); };
console.warn = (...a) => { consoleProblems.push(`warn: ${a.join(' ')}`); };
const environments = [];
after(async () => {
  for (const env of environments) await env.close().catch(() => {});
  console.error = realError;
  console.warn = realWarn;
});

const file = (p) => pathToFileURL(resolve(p)).href;
const SW = file('extension/src/background/service-worker.js');
const CONTENT = file('extension/src/content/index.js');
const POPUP = file('extension/src/popup/popup.js');
const popupHtml = readFileSync('extension/src/popup/popup.html', 'utf8').replace(/<script[^>]*><\/script>/, '');
let seq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** assert.equal for big strings: on failure show only where they first differ. */
function same(actual, expected, message) {
  if (actual === expected) return;
  let i = 0;
  while (i < actual.length && actual[i] === expected[i]) i++;
  assert.fail(`${message || 'strings differ'} at index ${i}:
  actual:   ...${actual.slice(Math.max(0, i - 40), i + 80)}
  expected: ...${expected.slice(Math.max(0, i - 40), i + 80)}`);
}

const SMALL_PAGE = `<body><main>
  <p id="p1">Machine learning is a <a id="l1" href="/ml">branch</a> of artificial intelligence that learns from data and improves with experience.</p>
  <p id="p2">The <b>REST API</b> returns 200 results in JSON format when the request is valid and complete for the caller.</p>
  <p id="p3">A typical project begins with collecting data, which is then cleaned to remove errors and missing values from it.</p>
</main></body>`;
const BIG_PAGE = `<body><main>${Array.from({ length: 30 }, (_, i) =>
  `<p>Paragraph ${i} explains how this particular part of the system works and why it is useful in practice, with enough extra words to make the block reasonably long.</p>`).join('')}</main></body>`;

async function startBackend(provider) {
  const config = { ...loadConfig({}), retries: 0, requestTimeoutMs: 3000, retryBaseMs: 1, rateLimitPerMin: 100000 };
  const server = createServer(createApp(config, { provider }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`, provider,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }), // drop keep-alive sockets too
  };
}

const quotaProvider = (calls) => createOpenAICompatProvider({
  apiKey: 'dummy-key', model: 'q-model', baseUrl: 'http://x',
  fetchImpl: async () => {
    calls.n++;
    return { ok: false, status: 429, headers: { get: () => null }, json: async () => [{ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', details: [
      { violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { retryDelay: '72714s' }] } }] };
  },
});

/** Builds one browser-like environment: backend + service worker + popup + a page the popup will inject into. */
async function setup({ provider = createMockProvider({ latencyMs: 5 }), page = SMALL_PAGE, tabUrl = 'https://example.com/article', settings = {} } = {}) {
  const fake = createFakeChrome({ tabUrl, storage: settings });
  const backend = await startBackend(provider);
  const popupDom = new JSDOM(popupHtml, { url: 'chrome-extension://bhashaflow-test/popup.html' });
  const env = { fake, backend, popupDom, pageDom: new JSDOM(page, { url: tabUrl }), page, injections: 0 };

  env.startWorker = async () => { // a (re)started service worker: new module instance, same chrome.storage
    fake.resetWorker();
    fake.registerAs('sw');
    globalThis.chrome = fake.chrome;
    globalThis.__BACKEND_URL__ = backend.url;
    await import(`${SW}?sw=${++seq}`);
    await fake.fireInstalled();
  };
  env.freshPage = () => { env.pageDom = new JSDOM(page, { url: tabUrl }); };
  fake.hooks.onExecute = async () => { // popup -> chrome.scripting.executeScript({ files: ['content.js'] })
    env.injections++;
    if (env.contentFor === env.pageDom) return; // same page + same isolated world: the __bhashaflow guard keeps the first controller
    const previous = globalThis.document;
    globalThis.document = env.pageDom.window.document;
    globalThis.__bhashaflow = undefined;
    fake.resetContent();
    fake.registerAs('content');
    await import(`${CONTENT}?c=${++seq}`);
    env.contentFor = env.pageDom;
    fake.registerAs('sw');
    globalThis.document = previous;
  };

  await env.startWorker();
  globalThis.document = popupDom.window.document;
  await import(`${POPUP}?p=${++seq}`);
  env.$ = (id) => popupDom.window.document.getElementById(id);
  env.click = (id) => env.$(id).click();
  env.toggle = (id) => { const el = env.$(id); el.checked = !el.checked; el.dispatchEvent(new popupDom.window.Event('change')); };
  env.status = () => env.$('status').textContent;
  env.pageText = () => env.pageDom.window.document.body.textContent;
  env.converted = () => [...env.pageDom.window.document.querySelectorAll('p')].filter((p) => p.textContent.includes(MOCK_PREFIX)).length || [...env.pageDom.window.document.querySelectorAll('p')].filter((p) => p.textContent !== new JSDOM(page).window.document.querySelector(`#${p.id}`)?.textContent && p.id).length;
  env.close = () => backend.close();
  environments.push(env);
  await until(() => env.$('cacheInfo').textContent.startsWith('Saved translations'), { what: 'popup to initialise' });
  return env;
}

// The mock converter prefix is not used by the backend path; Hinglish from the mock provider swaps some words.
const looksTranslated = (text) => / hai | ka | ke saath | mein /.test(text);
const original = (html) => new JSDOM(html).serialize();

// ================================================================ the complete user workflow

test('workflow: Translate -> Hinglish applied, links intact -> cache filled -> Restore -> identical page', async () => {
  const env = await setup();
  const clicks = [];
  env.pageDom.window.document.getElementById('l1').addEventListener('click', () => clicks.push('l1'));
  assert.equal(env.status(), 'Ready');

  env.click('translate');
  await until(() => env.status().startsWith('Done.'), { what: 'translation to finish' });
  assert.match(env.status(), /3 blocks converted/);
  assert.ok(looksTranslated(env.pageText()), 'Hinglish from the backend is on the page');
  assert.equal(env.$('runControls').hidden, true);
  assert.equal(env.$('translate').disabled, false);

  const link = env.pageDom.window.document.getElementById('l1');
  assert.equal(link.getAttribute('href'), '/ml');
  link.dispatchEvent(new env.pageDom.window.Event('click'));
  assert.deepEqual(clicks, ['l1'], 'the original link element and its handler survived');

  await until(() => /Saved translations: 3 /.test(env.$('cacheInfo').textContent), { what: 'cache statistics' });

  env.click('restore');
  await until(() => env.status().startsWith('Original English restored'), { what: 'restore' });
  assert.match(env.status(), /\(3 blocks\)/);
  same(env.pageDom.serialize(), original(SMALL_PAGE), 'page is byte-identical to the original');
  link.dispatchEvent(new env.pageDom.window.Event('click'));
  assert.equal(clicks.length, 2, 'the listener still fires after restore');
  await env.close();
});

test('workflow: a second Translate on the same page is served from the saved translations', async () => {
  const provider = createMockProvider({ latencyMs: 5 });
  const env = await setup({ provider });
  env.click('translate');
  await until(() => env.status().startsWith('Done.'));
  const callsAfterFirst = provider.calls.length;
  assert.ok(callsAfterFirst >= 1);

  env.click('restore');
  await until(() => env.status().startsWith('Original English restored'));
  env.click('translate');
  await until(() => env.status().startsWith('Done.') && /reused without a request/.test(env.status()), { what: 'cached run' });
  assert.equal(provider.calls.length, callsAfterFirst, 'zero new model requests');
  assert.match(env.status(), /3 reused without a request/);
  await env.close();
});

// ================================================================ pause / resume / stop through the popup

test('workflow: Pause freezes new requests, Resume finishes, progress and buttons stay truthful', async () => {
  const provider = createMockProvider({ latencyMs: 400 }); // longer than the popup's 250 ms poll
  const env = await setup({ provider, page: BIG_PAGE, settings: { maxParallelRequests: 1 } });
  env.click('translate');
  await until(() => env.status().startsWith('Translating'), { what: 'translation to start' });
  assert.equal(env.$('runControls').hidden, false);
  assert.equal(env.$('translate').disabled, true, 'cannot start a second run');
  assert.equal(env.$('pause').textContent, 'Pause');

  env.click('pause');
  await until(() => env.status().startsWith('Paused'), { what: 'pause' });
  assert.equal(env.$('pause').textContent, 'Resume');
  const callsWhenPaused = provider.calls.length;
  await sleep(900);
  assert.equal(provider.calls.length, callsWhenPaused, 'no request was started while paused');
  assert.match(env.status(), /Paused: \d+ of 30 blocks done/);

  env.click('pause'); // now "Resume"
  await until(() => env.status().startsWith('Done.'), { what: 'run to finish after resume', ms: 12000 });
  assert.match(env.status(), /30 blocks converted/);
  assert.equal(env.$('runControls').hidden, true);
  assert.ok(provider.calls.length > callsWhenPaused);
  await env.close();
});

test('workflow: Stop keeps what is translated, Restore undoes it, Translate can finish the rest', async () => {
  const provider = createMockProvider({ latencyMs: 350 });
  const env = await setup({ provider, page: BIG_PAGE, settings: { maxParallelRequests: 1 } });
  env.click('translate');
  await until(() => env.status().startsWith('Translating'));
  await until(() => /Translating… [1-9]\d* of/.test(env.status()), { what: 'first blocks done', ms: 6000 });
  env.click('stop');
  await until(() => env.status().startsWith('Stopped'), { what: 'stop' });
  assert.equal(env.$('runControls').hidden, true);
  assert.equal(env.$('translate').disabled, false);
  assert.match(env.status(), /the rest stay in English|not processed/);
  // Stop means "send nothing new". A request already in flight still lands, so wait for it, then check.
  const originals = [...new JSDOM(BIG_PAGE).window.document.querySelectorAll('p')].map((p) => p.textContent);
  const changedCount = () => [...env.pageDom.window.document.querySelectorAll('p')].filter((p, i) => p.textContent !== originals[i]).length;
  await sleep(700);
  const callsAfterLanding = provider.calls.length;
  const settled = env.pageText();
  await sleep(900);
  assert.equal(provider.calls.length, callsAfterLanding, 'no new request after Stop');
  assert.equal(env.pageText(), settled, 'the page is stable after the in-flight request landed');
  assert.ok(changedCount() > 0 && changedCount() < 30, 'partly translated');
  const shown = /Stopped: (\d+) blocks converted/.exec(env.status());
  assert.ok(shown, `unexpected status: ${env.status()}`);
  assert.equal(Number(shown[1]), changedCount(), 'the popup shows the true final count');
  assert.ok(looksTranslated(settled));

  env.click('translate');
  await until(() => env.status().startsWith('Done.'), { what: 'second run', ms: 12000 });
  assert.match(env.status(), /30 blocks converted|\d+ blocks converted/);

  env.click('restore');
  await until(() => env.status().startsWith('Original English restored'));
  same(env.pageDom.serialize(), original(BIG_PAGE));
  await env.close();
});

// ================================================================ quota and errors

test('quota exhaustion: clear message, no retries, state survives a service-worker restart', async () => {
  const calls = { n: 0 };
  const env = await setup({ provider: quotaProvider(calls), page: BIG_PAGE });
  env.click('translate');
  await until(() => /Stopped early/.test(env.status()), { what: 'quota message' });
  assert.match(env.status(), /daily quota is used up/);
  assert.match(env.status(), /different MODEL/);
  assert.equal(env.$('status').classList.contains('error'), true);
  assert.ok(calls.n >= 1 && calls.n <= 2, `${calls.n} provider requests (parallel limit 2)`);
  same(env.pageDom.serialize(), original(BIG_PAGE), 'page untouched');

  await until(() => /Daily AI quota used up until/.test(env.$('cacheInfo').textContent), { what: 'quota shown in popup' });
  assert.equal(env.$('cacheInfo').classList.contains('warn'), true);
  const stored = env.fake.data.quotaBreakers;
  assert.ok(stored && Object.keys(stored).length === 1, 'block persisted in chrome.storage');
  assert.ok(Object.values(stored)[0].until > Date.now() + 3600_000);

  const callsBefore = calls.n;
  await env.startWorker(); // Chrome stopped and restarted the worker
  env.freshPage();
  env.click('translate');
  await until(() => /Stopped early/.test(env.status()) && /daily quota/.test(env.status()), { what: 'blocked after restart' });
  assert.equal(calls.n, callsBefore, 'no provider request after the restart');
  await env.close();
});

test('backend not running: a clear error, page untouched, nothing hangs', async () => {
  const env = await setup();
  await env.close(); // backend is gone
  env.click('translate');
  await until(() => /Stopped early|Could not/.test(env.status()), { what: 'error message', ms: 8000 });
  assert.match(env.status(), /Could not reach the BhashaFlow backend/);
  same(env.pageDom.serialize(), original(SMALL_PAGE));
  assert.equal(env.$('translate').disabled, false, 'can try again');
  assert.equal(env.$('runControls').hidden, true);
});

test('a page the extension cannot run on is reported, not attempted', async () => {
  const env = await setup({ tabUrl: 'chrome://extensions/' });
  assert.equal(env.$('dynamicSite').disabled, true);
  env.click('translate');
  await until(() => /cannot run on this page/.test(env.status()));
  assert.equal(env.$('status').classList.contains('error'), true);
  assert.equal(env.injections, 0, 'no script was injected');
  await env.close();
});

// ================================================================ settings and cache controls

test('settings: every toggle persists to chrome.storage and the master switch undoes and disables', async () => {
  const env = await setup();
  for (const id of ['preserveHeadings', 'preserveTechnical', 'preserveHindi', 'sendPageContext', 'cacheEnabled']) {
    assert.equal(env.$(id).checked, true, `${id} defaults on`);
    env.toggle(id);
    await until(() => env.fake.data[id] === false, { what: `${id} saved` });
  }
  env.toggle('preserveHeadings');
  await until(() => env.fake.data.preserveHeadings === true);

  env.toggle('dynamicSite');
  await until(() => (env.fake.data.dynamicSites || []).includes('example.com'), { what: 'site opt-in saved' });
  env.toggle('dynamicSite');
  await until(() => (env.fake.data.dynamicSites || []).length === 0);

  env.click('translate');
  await until(() => env.status().startsWith('Done.'));
  env.toggle('enabled');
  await until(() => env.status().startsWith('Original English restored'), { what: 'switch off restores the page' });
  same(env.pageDom.serialize(), original(SMALL_PAGE));
  assert.equal(env.$('translate').disabled, true);
  assert.equal(env.fake.data.enabled, false);
  await env.close();
});

test('settings: opted-in sites start watching for new content after Translate', async () => {
  const env = await setup({ settings: { dynamicSites: ['example.com'] } });
  assert.equal(env.$('dynamicSite').checked, true);
  env.click('translate');
  await until(() => /Watching for new content/.test(env.status()), { what: 'observer on' });
  await env.close();
});

test('cache controls: statistics are accurate, Remember off stores nothing, Clear empties it', async () => {
  const env = await setup();
  env.click('translate');
  await until(() => env.status().startsWith('Done.'));
  await until(() => /Saved translations: 3 /.test(env.$('cacheInfo').textContent), { what: '3 entries counted' });
  const stats = await env.fake.chrome.runtime.sendMessage({ type: MSG.CACHE_STATS });
  assert.equal(stats.entries, 3);
  assert.ok(stats.bytes > 0);
  assert.equal(stats.healthy, true);

  env.click('clearCache');
  await until(() => env.status() === 'Saved translations cleared (3 entries).', { what: 'clear message' });
  await until(() => /Saved translations: 0 /.test(env.$('cacheInfo').textContent));

  env.toggle('cacheEnabled'); // Remember translations: off
  await until(() => env.fake.data.cacheEnabled === false);
  env.click('restore');
  await until(() => env.status().startsWith('Original English restored'));
  const before = env.fake.sent.length;
  env.click('translate');
  await until(() => env.status().startsWith('Done.'));
  const afterMsgs = env.fake.sent.slice(before).filter((m) => m.message.type === MSG.CONVERT);
  assert.ok(afterMsgs.length >= 1 && afterMsgs.every((m) => m.message.useCache === false), 'requests told the worker not to use the cache');
  const stats2 = await env.fake.chrome.runtime.sendMessage({ type: MSG.CACHE_STATS });
  assert.equal(stats2.entries, 0, 'nothing was stored');
  await env.close();
});

// ================================================================ messaging contract and hygiene

test('messaging: worker and content script answer every documented message and reject nonsense cleanly', async () => {
  const env = await setup();
  const rt = env.fake.chrome.runtime;
  assert.equal((await rt.sendMessage({ type: MSG.CACHE_STATS })).ok, true);
  assert.deepEqual(await rt.sendMessage({ type: MSG.CLEAR_CACHE }), { ok: true, removed: 0 });
  await assert.rejects(rt.sendMessage({ type: 'bf:nonsense' }), /port closed/);
  const garbage = await rt.sendMessage({ type: MSG.CONVERT, payload: null });
  assert.equal(garbage.ok, false);
  assert.equal(garbage.error.code, 'invalid-request');
  const wrongShape = await rt.sendMessage({ type: MSG.CONVERT, payload: { v: 1, items: [{ id: 0 }] } });
  assert.equal(wrongShape.ok, true);
  assert.equal(wrongShape.data.results[0].error.code, 'invalid-item');

  await assert.rejects(env.fake.chrome.tabs.sendMessage(1, { type: MSG.STATUS }), /Receiving end does not exist/, 'no content script before Translate');
  env.click('translate');
  await until(() => env.status().startsWith('Done.'));
  const status = await env.fake.chrome.tabs.sendMessage(1, { type: MSG.STATUS });
  for (const field of ['state', 'converted', 'eligible', 'pending', 'inflight', 'concurrency', 'skipped', 'failed', 'cached', 'deduped', 'notProcessed']) assert.ok(field in status, field);
  assert.equal(status.state, 'translated');
  assert.equal(status.pending, 0);
  assert.equal(env.injections, 1);
  env.click('translate'); // double injection is harmless
  await until(() => env.status().startsWith('Done.'));
  assert.equal(env.pageDom.window.document.querySelectorAll('p').length, 3);
  await env.close();
});

test('messaging: the only requests that leave the page go to the worker, and carry no URL or protected text', async () => {
  const page = `<body><nav><a href="/secret-nav">Navigation menu text that is long enough to look like prose to a careless scanner</a></nav>
    <main>${SMALL_PAGE.replace(/<\/?body>/g, '').replace(/<\/?main>/g, '')}
    <pre>const apiToken = "never-send-this-code-sample-to-anyone";</pre>
    <div class="ad-slot"><p>Buy our amazing product today and get a free gift with every single order you place.</p></div></main></body>`;
  const env = await setup({ page, tabUrl: 'https://private.example.org/account/42?token=abc' });
  env.click('translate');
  await until(() => env.status().startsWith('Done.'));
  const wire = JSON.stringify(env.fake.sent.filter((m) => m.message.type === MSG.CONVERT));
  for (const secret of ['secret-nav', 'Navigation menu', 'never-send-this', 'apiToken', 'Buy our amazing', 'token=abc', '/account/42', 'private.example.org']) assert.ok(!wire.includes(secret), `"${secret}" left the page`);
  assert.deepEqual([...new Set(env.fake.sent.map((m) => m.to))].sort(), ['service-worker', 'tab-1']);
  await env.close();
});

test('hygiene: no unhandled rejections, no console errors or warnings, and no leaked servers or timers', async () => {
  for (const env of environments) await env.close();
  await sleep(700); // let popup poll timers wind down
  const stdio = new Set([process.stdin, process.stdout, process.stderr]);
  const leaked = process._getActiveHandles().filter((h) => !stdio.has(h)).map((h) => h && h.constructor && h.constructor.name);
  assert.deepEqual(leaked.filter((k) => k !== 'Socket' && k !== 'Pipe'), [], 'servers or timers still alive after all tests');
  assert.deepEqual(unhandled.map(String), []);
  assert.deepEqual(consoleProblems, []);
});
