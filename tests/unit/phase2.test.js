import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createController } from '../../extension/src/content/controller.js';
import { MOCK_PREFIX } from '../../extension/src/content/converter.js';
import { DEFAULT_SETTINGS } from '../../extension/src/shared/settings.js';

const FIXTURES = ['article-news', 'educational-gfg', 'dictionary', 'wiki-mixed', 'ads-regression', 'trap-names', 'nested-soup'];
const load = (name) => new JSDOM(readFileSync(`tests/fixtures/${name}.html`, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snippet = (el) => el.textContent.replace(/\s+/g, ' ').trim().slice(0, 60);

/** Runs one fixture and returns false positives / false negatives against its data-expect markers. */
async function evaluate(name, opts = DEFAULT_SETTINGS) {
  const dom = load(name);
  const controller = createController({ root: dom.window.document.body });
  const status = await controller.translate(opts);
  const falsePositives = [];
  const falseNegatives = [];
  let expected = 0;
  for (const el of dom.window.document.querySelectorAll('[data-expect]')) {
    expected++;
    const converted = el.textContent.includes(MOCK_PREFIX);
    if (el.dataset.expect === 'keep' && converted) falsePositives.push(snippet(el));
    if (el.dataset.expect === 'convert' && !converted) falseNegatives.push(snippet(el));
  }
  return { dom, controller, status, falsePositives, falseNegatives, expected };
}

for (const name of FIXTURES) {
  test(`fixture ${name}: main content selected, ads/peripheral excluded`, async (t) => {
    const r = await evaluate(name);
    t.diagnostic(`${name}: ${r.expected} annotated blocks, false positives=${r.falsePositives.length}, ` +
      `false negatives=${r.falseNegatives.length}, regions=${r.status.regions}, scan=${r.status.scanMs}ms`);
    const why = r.controller.explain().filter((e) => r.falsePositives.concat(r.falseNegatives).some((s) => e.text.startsWith(s.slice(0, 30))));
    assert.deepEqual(r.falsePositives, [], `false positives (ad/peripheral converted): ${JSON.stringify(why)}`);
    assert.deepEqual(r.falseNegatives, [], `false negatives (content missed): ${JSON.stringify(why)}`);
  });

  test(`fixture ${name}: restore returns the exact original DOM`, async () => {
    const r = await evaluate(name);
    const original = load(name).serialize();
    r.controller.restore();
    assert.equal(r.dom.serialize(), original);
  });
}

test('regression: ads are not converted while link-containing article paragraphs are', async () => {
  const { dom, status } = await evaluate('ads-regression');
  const doc = dom.window.document;
  const converted = [...doc.querySelectorAll('p')].filter((p) => p.textContent.includes(MOCK_PREFIX));
  assert.equal(converted.length, 4);
  assert.ok(converted.every((p) => p.closest('.entry')), 'only article paragraphs');
  assert.ok(converted.some((p) => p.querySelector('a')), 'paragraphs with links are converted');
  assert.ok(status.skipped['ad-label'] >= 1 || status.skipped['ad-container'] >= 1);
});

test('every candidate gets a classification reason', async () => {
  const { controller } = await evaluate('article-news');
  const log = controller.explain();
  assert.ok(log.length > 10);
  assert.ok(log.every((e) => typeof e.reason === 'string' && e.reason));
  const reasons = new Set(log.map((e) => e.reason));
  for (const r of ['main-content', 'peripheral', 'card', 'ad-label', 'link-text', 'too-short']) {
    assert.ok(reasons.has(r) || r === 'card' || r === 'ad-label', `expected reason ${r}`);
  }
});

test('inline markup: elements are reused, listeners and attributes survive, restore is exact', async () => {
  const dom = new JSDOM(`<body><main><p id="p">Learn about <a id="a" href="/x" class="k">the <b id="b">machine</b> learning</a> and use <code id="c">fit()</code> on <em>your</em> data every day.</p></main></body>`);
  const doc = dom.window.document;
  const before = dom.serialize();
  const a = doc.getElementById('a');
  const b = doc.getElementById('b');
  let clicks = 0;
  a.addEventListener('click', () => clicks++);

  const swap = { // reorders siblings like Hinglish word order might
    async convert(items) {
      return items.map(({ id, text }) => ({ id, hinglish: text.replace('Learn about', 'Seekho') }));
    },
  };
  const c = createController({ root: doc.body, converter: swap });
  const st = await c.translate(DEFAULT_SETTINGS);
  assert.equal(st.converted, 1);
  assert.ok(doc.getElementById('p').textContent.startsWith('Seekho'));
  assert.equal(doc.getElementById('a'), a, 'same <a> element');
  assert.equal(doc.getElementById('b'), b, 'same nested <b> element');
  assert.equal(a.getAttribute('href'), '/x');
  assert.equal(doc.getElementById('c').textContent, 'fit()');
  a.dispatchEvent(new dom.window.Event('click'));
  assert.equal(clicks, 1, 'listener still attached');

  c.restore();
  assert.equal(dom.serialize(), before);
  a.dispatchEvent(new dom.window.Event('click'));
  assert.equal(clicks, 2);
});

test('inline markup: sibling reordering is allowed, invalid rewrites are rejected and left in English', async () => {
  const html = `<body><main><p id="p">Machine learning is a <a href="/x">branch</a> of <b>artificial intelligence</b> that learns from data.</p></main></body>`;
  const run = async (rewrite) => {
    const dom = new JSDOM(html);
    const c = createController({ root: dom.window.document.body, converter: { convert: async (items) => items.map(({ id, text }) => ({ id, hinglish: rewrite(text) })) } });
    const st = await c.translate(DEFAULT_SETTINGS);
    return { dom, st, text: dom.window.document.getElementById('p').textContent };
  };

  const ok = await run(() => '⟦2⟧Artificial intelligence⟦/2⟧ ki aisi ⟦1⟧branch⟦/1⟧ hai jo data se seekhti hai aur improve karti hai.');
  assert.equal(ok.st.converted, 1);
  assert.ok(ok.text.startsWith('Artificial intelligence ki aisi branch'));

  const original = await run((t) => t);
  assert.equal(original.st.converted, 1);

  const bad = {
    'missing token': () => 'Machine learning ek ⟦1⟧branch⟦/1⟧ hai jo artificial intelligence se seekhti hai.',
    'unknown id': () => 'Machine learning ⟦1⟧branch⟦/1⟧ ⟦2⟧AI⟦/2⟧ ⟦9⟧x⟦/9⟧ hai bahut accha.',
    'duplicate id': () => '⟦1⟧a⟦/1⟧ ⟦1⟧b⟦/1⟧ ⟦2⟧c⟦/2⟧ yeh bahut accha hai.',
    'bad nesting': () => '⟦1⟧branch ⟦2⟧AI⟦/1⟧ hai⟦/2⟧ yeh bahut accha hai.',
    'unclosed': () => '⟦1⟧branch hai ⟦2⟧AI⟦/2⟧ yeh bahut accha hai.',
    'moved to other parent': () => '⟦1⟧branch ⟦2⟧AI⟦/2⟧⟦/1⟧ hai yeh bahut accha hai.',
  };
  for (const [label, fn] of Object.entries(bad)) {
    const r = await run(fn);
    assert.equal(r.st.converted, 0, label);
    assert.equal(r.st.failed['placeholder-mismatch'], 1, label);
    assert.equal(r.dom.serialize(), new JSDOM(html).serialize(), `${label}: page unchanged`);
  }
});

test('runs split around nested blocks; each run converts and restores independently', async () => {
  const html = `<body><main><ul><li id="li">The first sentence explains how the algorithm starts working.<ul><li>child</li></ul>The second sentence explains how the algorithm finishes its work.</li></ul></main></body>`;
  const dom = new JSDOM(html);
  const c = createController({ root: dom.window.document.body });
  const st = await c.translate(DEFAULT_SETTINGS);
  assert.equal(st.converted, 2);
  assert.equal(dom.window.document.querySelector('li li').textContent, 'child');
  c.restore();
  assert.equal(dom.serialize(), new JSDOM(html).serialize());
});

test('translate twice never double-processes', async () => {
  let calls = 0;
  const dom = load('educational-gfg');
  const counting = { async convert(items) { calls += items.length; return items.map((i) => ({ id: i.id, hinglish: MOCK_PREFIX + i.text })); } };
  const c = createController({ root: dom.window.document.body, converter: counting });
  const first = await c.translate(DEFAULT_SETTINGS);
  const callsAfterFirst = calls;
  const second = await c.translate(DEFAULT_SETTINGS);
  assert.ok(first.converted > 0);
  assert.equal(second.converted, 0);
  assert.equal(calls, callsAfterFirst);
  assert.ok(!dom.window.document.body.textContent.includes(MOCK_PREFIX + MOCK_PREFIX));
});

test('dynamic content: opt-in observer converts new content, ignores ads, never loops, stops on restore', async () => {
  const dom = load('educational-gfg');
  const doc = dom.window.document;
  let calls = 0;
  const counting = { async convert(items) { calls += items.length; return items.map((i) => ({ id: i.id, hinglish: MOCK_PREFIX + i.text })); } };
  const c = createController({ root: doc.body, converter: counting });
  const article = doc.querySelector('.article-viewer_content');

  // Without opt-in nothing is observed.
  await c.translate({ ...DEFAULT_SETTINGS, observe: false });
  assert.equal(c.getStatus().observing, false);
  const p0 = doc.createElement('p');
  p0.textContent = 'This paragraph is added without any opt in so it must stay in plain English text.';
  article.appendChild(p0);
  await sleep(500);
  assert.ok(!p0.textContent.includes(MOCK_PREFIX));

  // Opt in on this site.
  c.setObserve(true);
  assert.equal(c.getStatus().observing, true);
  const added = doc.createElement('p');
  added.textContent = 'A lazily loaded paragraph explains how gradient descent slowly finds the minimum of a function.';
  const ad = doc.createElement('div');
  ad.className = 'ad-slot';
  ad.innerHTML = '<p>Click this amazing offer today and win a brand new phone with free shipping included for everyone.</p>';
  const sidebarInsert = doc.createElement('p');
  sidebarInsert.textContent = 'A small notice was added to the right column that talks about something else entirely here.';
  article.append(added, ad);
  doc.querySelector('.right-rail .box').appendChild(sidebarInsert);
  await sleep(700);

  assert.ok(added.textContent.includes(MOCK_PREFIX), 'new article paragraph converted');
  assert.ok(!ad.textContent.includes(MOCK_PREFIX), 'inserted ad ignored');
  assert.ok(!sidebarInsert.textContent.includes(MOCK_PREFIX), 'insert outside main content ignored');

  const settled = calls;
  await sleep(800);
  assert.equal(calls, settled, 'no observer feedback loop');

  c.restore();
  const late = doc.createElement('p');
  late.textContent = 'Added after restore so the observer must already be stopped and leave this untouched.';
  article.appendChild(late);
  await sleep(500);
  assert.ok(!late.textContent.includes(MOCK_PREFIX));
  assert.ok(!doc.body.textContent.includes(MOCK_PREFIX));
});

test('long page: capped, chunked, restorable', async (t) => {
  const paras = Array.from({ length: 3500 }, (_, i) =>
    `<p>Paragraph number ${i} explains how this particular part of the system works and why it is useful in practice.</p>`).join('');
  const html = `<body><article><h1>Long</h1>${paras}</article></body>`;
  const dom = new JSDOM(html);
  const c = createController({ root: dom.window.document.body });
  const st = await c.translate(DEFAULT_SETTINGS);
  t.diagnostic(`3500 paragraphs in jsdom: scan ${st.scanMs}ms, converted ${st.converted}, truncated ${st.truncated}`);
  assert.equal(st.converted, 3000);
  assert.equal(st.truncated, 500);
  c.restore();
  assert.equal(dom.serialize(), new JSDOM(html).serialize());
});

test('ad detection does not fire on look-alike class names', async () => {
  const { falsePositives, falseNegatives } = await evaluate('trap-names');
  assert.deepEqual(falseNegatives, []);
  assert.deepEqual(falsePositives, []);
});

test('dictionary: headword, part of speech, grammar line and Hindi stay; definition and example convert', async () => {
  const { dom } = await evaluate('dictionary');
  const doc = dom.window.document;
  for (const sel of ['.hd', '.pos', '.forms', '.hi-trans', 'input', 'button']) {
    assert.ok(!doc.querySelector(sel).textContent.includes(MOCK_PREFIX), sel);
  }
  assert.equal(doc.querySelector('.hi-trans').textContent, 'महाभियोग लगाना');
  assert.ok(doc.querySelector('.def').textContent.startsWith(MOCK_PREFIX + '(used about a court of law'));
});
