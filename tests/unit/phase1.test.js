import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createController } from '../../extension/src/content/controller.js';
import { MOCK_PREFIX } from '../../extension/src/content/converter.js';
import { DEFAULT_SETTINGS } from '../../extension/src/shared/settings.js';

const FIXTURE = `<!doctype html><html><head><title>Fixture</title><style>p{color:red}</style></head><body>
<nav><ul><li>Home page of the whole website is here today</li></ul></nav>
<header><h1>Introduction to Machine Learning</h1></header>
<main id="main">
  <p id="ml">Machine learning is a branch of artificial intelligence that enables computers to learn from data and improve their performance.</p>
  <h2>How it works and why it is useful in practice</h2>
  <p id="inline">Machine learning is a <a href="/x">branch</a> of <b>artificial intelligence</b> that learns from data.</p>
  <p id="short">Short label here</p>
  <pre>function add(a, b) { return a + b; /* this is a code sample for the reader */ }</pre>
  <p><code>const total = items.reduce((a, b) => a + b, 0) in this example here</code></p>
  <button>Click here to subscribe to the newsletter now please</button>
  <input value="This is a value inside a form input field that must stay">
  <textarea>This is some text inside a textarea that must stay unchanged</textarea>
  <p id="hindi">यह एक हिंदी वाक्य है जो इस पेज पर पहले से मौजूद है और बदलना नहीं चाहिए</p>
  <p id="hindi-lang" lang="hi">This element is marked as Hindi so it should never be touched at all</p>
  <p id="notranslate" class="notranslate">This paragraph opted out of translation and must not change at all</p>
  <p id="hidden" style="display:none">This hidden paragraph is not visible so it must not be converted</p>
  <ul><li id="li">A list item that explains how the algorithm works in simple terms.</li></ul>
  <a id="link" href="/more">Read more about this topic in the documentation now</a>
  <p id="url">https://example.com/some/very/long/path/that/is/not/prose</p>
</main>
<section id="dict">
  <div id="headword">impeach</div>
  <div id="pos">verb</div>
  <div id="forms">past tense: impeached; past participle: impeached</div>
  <div id="def">(used about a court of law, especially in the US and some other countries) to officially accuse a public official of committing a serious crime while they are still in office</div>
  <div id="hi-trans" lang="hi">महाभियोग लगाना</div>
</section>
<footer>All rights reserved by the publisher of this website and its partners</footer>
</body></html>`;

function setup() {
  const dom = new JSDOM(FIXTURE);
  const { document } = dom.window;
  const controller = createController({ root: document.body });
  return { dom, document, controller };
}
const text = (document, id) => document.getElementById(id).textContent;

test('converts explanatory prose only', async () => {
  const { document, controller } = setup();
  const status = await controller.translate(DEFAULT_SETTINGS);

  assert.equal(status.state, 'translated');
  // Phase 2: 'inline' (paragraph with a link and bold text) is now converted instead of skipped.
  for (const id of ['ml', 'li', 'def', 'inline']) {
    assert.ok(text(document, id).includes(MOCK_PREFIX), `${id} should be converted`);
  }
  assert.equal(status.converted, 4);
});

test('protects headings, nav, UI, code, forms, Hindi and dictionary labels', async () => {
  const { document, controller } = setup();
  await controller.translate(DEFAULT_SETTINGS);

  const protectedSelectors = 'nav, h1, h2, pre, code, button, footer, textarea';
  for (const el of document.querySelectorAll(protectedSelectors)) {
    assert.ok(!el.textContent.includes(MOCK_PREFIX), `<${el.localName}> must be untouched`);
  }
  assert.ok(!document.querySelector('input').value.includes(MOCK_PREFIX));
  for (const id of ['headword', 'pos', 'forms', 'hi-trans', 'hindi', 'hindi-lang', 'notranslate', 'hidden', 'short', 'link', 'url']) {
    assert.ok(!text(document, id).includes(MOCK_PREFIX), `${id} must be untouched`);
  }
});

test('restore gives a DOM identical to the original and adds no attributes', async () => {
  const { dom, document, controller } = setup();
  const before = dom.serialize();
  const nodeBefore = document.getElementById('ml').firstChild;

  await controller.translate(DEFAULT_SETTINGS);
  assert.notEqual(dom.serialize(), before);
  const result = controller.restore();

  assert.equal(result.restored, 4);
  assert.equal(dom.serialize(), before);
  assert.equal(document.getElementById('ml').firstChild, nodeBefore, 'same original node is back');
});

test('translating twice does not double-convert', async () => {
  const { document, controller } = setup();
  await controller.translate(DEFAULT_SETTINGS);
  const second = await controller.translate(DEFAULT_SETTINGS);

  assert.equal(second.converted, 0);
  assert.equal(text(document, 'ml').split(MOCK_PREFIX).length, 2);
});

test('restore during an in-flight translation cancels it cleanly', async () => {
  const { dom, controller } = setup();
  const before = dom.serialize();
  const slow = { convert: (items) => new Promise((r) => setTimeout(() => r(items.map((i) => ({ id: i.id, hinglish: 'x y' }))), 20)) };
  const c = createController({ root: dom.window.document.body, converter: slow });

  const pending = c.translate(DEFAULT_SETTINGS);
  c.restore();
  await pending;
  assert.equal(dom.serialize(), before);
  assert.equal(c.getStatus().state, 'restored');
  assert.equal(c.getStatus().converted, 0);
});

test('preserveHeadings=false makes headings eligible; preserveHindi=false does not crash', async () => {
  const { document, controller } = setup();
  await controller.translate({ ...DEFAULT_SETTINGS, preserveHeadings: false, preserveHindi: false });
  assert.ok(text(document, 'main').includes(MOCK_PREFIX + 'How it works'));
  assert.ok(document.querySelector('h1').textContent.startsWith(MOCK_PREFIX) === false, 'short h1 stays (too short)');
});

test('restore tolerates elements the page removed', async () => {
  const { document, controller } = setup();
  await controller.translate(DEFAULT_SETTINGS);
  document.getElementById('ml').remove();
  assert.doesNotThrow(() => controller.restore());
});

test('skip reasons are reported', async () => {
  const { controller } = setup();
  const status = await controller.translate(DEFAULT_SETTINGS);
  assert.equal(status.skipped['mixed-content'], undefined, 'mixed content is handled since Phase 2');
  assert.ok(status.skipped['too-short'] >= 1);
  assert.ok(status.skipped['hindi'] >= 1);
  assert.ok(status.skipped['link-text'] >= 1);
});

test('manifest: MV3, manual opt-in, no auto-run or host access, no secrets', () => {
  const manifest = JSON.parse(readFileSync('extension/manifest.json', 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  // Selection Mode: exactly one small content script for http(s) top frames (see final-security.test.js); no <all_urls>.
  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(manifest.content_scripts[0].js, ['selection.js']);
  // The only host permission is the backend origin.
  assert.deepEqual(manifest.host_permissions, ['http://localhost:8787/*']);
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting', 'storage']);
  assert.ok(!/api[_-]?key|secret/i.test(JSON.stringify(manifest)));
});
