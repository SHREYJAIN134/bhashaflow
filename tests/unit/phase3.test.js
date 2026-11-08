import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { sourceFromTemplate, parseConverted, visibleText } from '../../extension/src/shared/tokens.js';
import { scan } from '../../extension/src/content/scanner.js';
import { createController } from '../../extension/src/content/controller.js';
import { createRemoteConverter } from '../../extension/src/content/converter-remote.js';
import { callBackend } from '../../extension/src/background/backend-client.js';
import { DEFAULT_SETTINGS } from '../../extension/src/shared/settings.js';
import { loadConfig } from '../../backend/src/config.js';
import { createEngine, parseModelReply } from '../../backend/src/engine.js';
import { validateItem } from '../../backend/src/validate.js';
import { validateRequest, createHandler } from '../../backend/src/handler.js';
import { createApp, createServer } from '../../backend/src/server.js';
import { createMockProvider } from '../../backend/src/providers/mock.js';
import { ProviderError } from '../../backend/src/providers/errors.js';
import { createAnthropicProvider } from '../../backend/src/providers/anthropic.js';
import { createOpenAICompatProvider } from '../../backend/src/providers/openai-compat.js';
import { createProvider } from '../../backend/src/providers/index.js';
import { SYSTEM_PROMPT, buildUserMessage } from '../../backend/src/prompt.js';
import { scoreCase } from '../../benchmark/score.js';

const O = '⟦';
const C = '⟧';
const cases = JSON.parse(readFileSync('benchmark/cases.json', 'utf8'));
const engineCfg = { requestTimeoutMs: 400, retries: 2, maxItemsPerCall: 12, maxCharsPerCall: 8000 };
const ITEMS = [
  { id: 0, role: 'paragraph', text: `Machine learning is a ${O}1${C}branch${O}/1${C} of artificial intelligence that learns from data and improves with experience.` },
  { id: 1, role: 'paragraph', text: 'The REST API returns 200 results in JSON format when the request is valid and complete.' },
  { id: 2, role: 'list-item', text: `Use ${O}1=code${C} to start the server and then open the page in your browser to check it works.` },
];
const withSource = (it) => ({ ...it, source: sourceFromTemplate(it.text) });
const jsonReply = (results) => JSON.stringify({ results });

// ---------------------------------------------------------------- tokens / privacy of inline atoms

test('tokens: templates are parsed, malformed ones rejected, atom payloads limited to kinds', () => {
  assert.ok(sourceFromTemplate(ITEMS[0].text));
  assert.equal(sourceFromTemplate(`a ${O}1${C}b`), null, 'unclosed');
  assert.equal(sourceFromTemplate(`${O}1${C}a${O}/2${C}`), null, 'mismatched close');
  assert.equal(sourceFromTemplate(`${O}1=code${C} ${O}1=code${C}`), null, 'duplicate id');
  assert.equal(sourceFromTemplate(`${O}1=secret_value()${C}`), null, 'atom payload must be a kind');
  assert.equal(visibleText(ITEMS[0].text).includes(O), false);
});

test('privacy: protected inline elements are reduced to a kind before leaving the page', () => {
  const dom = new JSDOM(`<body><main><p>Call <code>deleteAllUsers(secretKey)</code> and the <span lang="hi">गुप्त शब्द</span> helper, then <b>read</b> the logs <img src="x.png" alt="private"> carefully today.</p></main></body>`);
  const { items } = scan(dom.window.document.body, DEFAULT_SETTINGS);
  const text = items.find((i) => i.run.plain.includes('Call'))?.run.template;
  assert.ok(text, 'run found');
  assert.ok(text.includes(`${O}1=code${C}`) && text.includes('=hi') && text.includes('=img'));
  for (const secret of ['deleteAllUsers', 'secretKey', 'गुप्त', 'private', 'x.png']) assert.ok(!text.includes(secret), secret);
  assert.ok(sourceFromTemplate(text), 'template is well-formed');
});

// ---------------------------------------------------------------- validator

test('validator accepts good output and rejects each class of bad output', () => {
  const [a, b, c] = ITEMS.map(withSource);
  const good = `Machine learning artificial intelligence ki ${O}1${C}branch${O}/1${C} hai jo data se seekhti hai aur experience ke saath behtar hoti hai.`;
  assert.deepEqual(validateItem(a, good), { ok: true });

  const bad = [
    [a, good.replace(`${O}1${C}`, '').replace(`${O}/1${C}`, ''), /placeholder/],
    [a, `${good} ${O}1${C}x${O}/1${C}`, /placeholder/],
    [a, 'Machine learning ek branch hai jo data se seekhti hai aur experience se behtar hoti jaati hai. हिंदी', /Devanagari/],
    [a, `Sure, here is the translation: ${good}`, /commentary/],
    [a, '', /empty/],
    [b, 'REST API 300 results return karti hai jab request valid aur complete hoti hai.', /numbers/],
    [b, 'Rest api 200 results JSON format mein return karti hai jab request valid aur complete hoti hai.', /acronyms/],
    [b, 'Ye hai.', /length/],
    [b, ITEMS[1].text, /unchanged/],
    [c, `${O}1=code${C} ${O}1=code${C} server start karo.`, /placeholder/],
  ];
  for (const [item, out, re] of bad) {
    const v = validateItem(item, out);
    assert.equal(v.ok, false, out);
    assert.match(v.issue, re, out);
  }
});

test('benchmark: every hand-written reference passes the validator; corrupted ones do not', () => {
  assert.equal(cases.length, 25);
  for (const c of cases) {
    const s = scoreCase(c, c.reference);
    assert.ok(s.valid, `${c.id}: ${s.issue}`);
    assert.ok(s.termsKept, `${c.id} missing ${s.missingTerms}`);
    assert.ok(s.senseOk, c.id);
  }
  const tokenCase = cases.find((c) => c.id === 'mixed-1');
  assert.equal(scoreCase(tokenCase, tokenCase.reference.replace(`${O}1${C}`, '')).valid, false);
  const acronymCase = cases.find((c) => c.id === 'tech-4');
  assert.equal(scoreCase(acronymCase, acronymCase.reference.replace('REST API', 'rest api')).termsKept, false);
  const senseCase = cases.find((c) => c.id === 'amb-2');
  assert.equal(scoreCase(senseCase, 'Nadi ke kinare par loan approve hua credit history dekh kar.').senseOk, false);
  assert.equal(scoreCase(cases[0], undefined).valid, false);
});

test('prompt: states the contract the validator enforces and includes the spec example', () => {
  for (const must of ['Roman script', 'Devanagari', 'exactly once', 'JSON', 'Ye word court of law ke context mein use hota hai']) {
    assert.ok(SYSTEM_PROMPT.includes(must), must);
  }
  const msg = JSON.parse(buildUserMessage({ page: { title: 'T' }, items: [{ id: 3, text: 'x', role: 'definition', heading: 'impeach' }], fixes: { 3: 'bad' } }));
  assert.deepEqual(msg.items[0], { id: 3, role: 'definition', heading: 'impeach', text: 'x', fix: 'bad' });
});

// ---------------------------------------------------------------- engine

test('engine: rewrites a batch through the provider and returns validated results', async () => {
  const provider = createMockProvider();
  const out = await createEngine({ provider, config: engineCfg }).rewrite({ page: { title: 'ML' }, items: ITEMS });
  assert.equal(out.fatal, null);
  assert.equal(out.results.length, 3);
  assert.ok(out.results.every((r) => typeof r.hinglish === 'string'));
  assert.equal(provider.calls.length, 1, 'one call for one chunk');
  assert.ok(parseConverted(out.results[0].hinglish, sourceFromTemplate(ITEMS[0].text)));
  assert.equal(out.meta.promptVersion, 'hinglish-v2');
});

test('engine: retries transient provider failures, then succeeds', async () => {
  const provider = createMockProvider({ failures: [new ProviderError('rate-limit', 'x', { retryable: true }), new ProviderError('unavailable', 'x', { retryable: true })] });
  const out = await createEngine({ provider, config: engineCfg }).rewrite({ page: {}, items: ITEMS });
  assert.equal(out.fatal, null);
  assert.equal(out.meta.retries, 2);
  assert.ok(out.results.every((r) => r.hinglish));
});

test('engine: does not retry auth errors and reports a fatal provider failure', async () => {
  const provider = createMockProvider({ failures: [new ProviderError('auth', 'Provider rejected the credentials', { status: 401 })] });
  const out = await createEngine({ provider, config: engineCfg }).rewrite({ page: {}, items: ITEMS });
  assert.equal(out.fatal, 'auth');
  assert.equal(provider.calls.length, 1);
  assert.ok(out.results.every((r) => r.error && r.error.code === 'auth'));
});

test('engine: repairs only the rejected items with a fix hint, once', async () => {
  const provider = createMockProvider({
    corrupt: (item, out, call) => (call === 1 && item.id === 1 ? out.replace('200', '300') : out),
  });
  const out = await createEngine({ provider, config: engineCfg }).rewrite({ page: {}, items: ITEMS });
  assert.equal(provider.calls.length, 2);
  const second = JSON.parse(provider.calls[1].user);
  assert.deepEqual(second.items.map((i) => i.id), [1]);
  assert.match(second.items[0].fix, /numbers/);
  assert.ok(out.results.every((r) => r.hinglish));
  assert.equal(out.meta.repaired, 1);
});

test('engine: an item that stays invalid becomes an error; valid siblings are unaffected', async () => {
  const provider = createMockProvider({ corrupt: (item, out) => (item.id === 0 ? out.replace(`${O}1${C}`, '') : out) });
  const out = await createEngine({ provider, config: engineCfg }).rewrite({ page: {}, items: ITEMS });
  assert.equal(out.results[0].error.code, 'invalid-output');
  assert.ok(out.results[1].hinglish && out.results[2].hinglish);
  assert.equal(provider.calls.length, 2, 'exactly one repair pass');
});

test('engine: malformed model JSON is retried; timeouts surface as a timeout error', async () => {
  let n = 0;
  const flaky = { name: 'flaky', model: 'm', async complete() { n++; return { text: n === 1 ? 'not json at all' : jsonReply(ITEMS.map((i) => ({ id: i.id, hinglish: `Hinglish ${i.text}` }))), usage: {} }; } };
  const first = await createEngine({ provider: flaky, config: engineCfg }).rewrite({ page: {}, items: [ITEMS[1]] });
  assert.equal(n, 2);
  assert.ok(first.results[0].hinglish || first.results[0].error);

  const slow = createMockProvider({ latencyMs: 150 });
  const out = await createEngine({ provider: slow, config: { ...engineCfg, requestTimeoutMs: 30, retries: 1 } }).rewrite({ page: {}, items: ITEMS });
  assert.equal(out.fatal, 'timeout');
});

test('engine: malformed templates are rejected without calling the model', async () => {
  const provider = createMockProvider();
  const out = await createEngine({ provider, config: engineCfg }).rewrite({ page: {}, items: [{ id: 0, text: `broken ${O}1${C} template` }] });
  assert.equal(out.results[0].error.code, 'bad-template');
  assert.equal(provider.calls.length, 0);
});

test('engine: large batches are split into chunks that run in parallel', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: i, text: ITEMS[1].text }));
  const provider = createMockProvider();
  const out = await createEngine({ provider, config: engineCfg }).rewrite({ page: {}, items: many });
  assert.equal(provider.calls.length, 3);
  assert.ok(out.results.every((r) => r.hinglish));
});

test('parseModelReply tolerates code fences and prose around the JSON', () => {
  const answers = parseModelReply('Here you go:\n```json\n{"results":[{"id":2,"hinglish":"x"}]}\n```');
  assert.equal(answers.get(2), 'x');
  assert.throws(() => parseModelReply('no json'), (e) => e.code === 'bad-json');
});

// ---------------------------------------------------------------- providers (wire format, no network)

const fakeFetch = (status, body, capture) => async (url, init) => {
  capture.url = url; capture.init = init; capture.body = JSON.parse(init.body);
  return { ok: status < 300, status, json: async () => body };
};

test('anthropic adapter: request shape, usage parsing, key only in a header', async () => {
  const cap = {};
  const p = createAnthropicProvider({ apiKey: 'sk-test-123', model: 'm-1', temperature: 0.2,
    fetchImpl: fakeFetch(200, { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5, output_tokens: 7 } }, cap) });
  const r = await p.complete({ system: 'S', user: 'U', maxTokens: 99 });
  assert.equal(cap.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(cap.init.headers['x-api-key'], 'sk-test-123');
  assert.equal(cap.init.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(cap.body, { model: 'm-1', max_tokens: 99, temperature: 0.2, system: 'S', messages: [{ role: 'user', content: 'U' }] });
  assert.ok(!JSON.stringify(cap.body).includes('sk-test-123'));
  assert.deepEqual(r, { text: 'hi', usage: { inputTokens: 5, outputTokens: 7 } });
});

test('openai-compatible adapter: request shape, configurable token param, usage parsing', async () => {
  const cap = {};
  const p = createOpenAICompatProvider({ apiKey: 'k', model: 'gm', baseUrl: 'https://api.groq.com/openai/v1/', maxTokensParam: 'max_completion_tokens',
    fetchImpl: fakeFetch(200, { choices: [{ message: { content: 'yo' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }, cap) });
  const r = await p.complete({ system: 'S', user: 'U', maxTokens: 50 });
  assert.equal(cap.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(cap.init.headers.authorization, 'Bearer k');
  assert.equal(cap.body.max_completion_tokens, 50);
  assert.deepEqual(cap.body.response_format, { type: 'json_object' });
  assert.deepEqual(cap.body.messages.map((m) => m.role), ['system', 'user']);
  assert.deepEqual(r, { text: 'yo', usage: { inputTokens: 3, outputTokens: 4 } });
});

test('providers map HTTP failures to typed errors without leaking credentials', async () => {
  const expect = async (status, code, retryable) => {
    const p = createAnthropicProvider({ apiKey: 'sk-secret', model: 'm', fetchImpl: fakeFetch(status, { error: { message: 'boom sk-secret' } }, {}) });
    await assert.rejects(p.complete({ system: '', user: '', maxTokens: 1 }), (e) => {
      assert.equal(e.code, code);
      assert.equal(e.retryable, retryable);
      assert.ok(!e.message.includes('sk-secret') || code !== 'auth');
      return true;
    });
  };
  await expect(401, 'auth', false);
  await expect(429, 'rate-limit', true);
  await expect(503, 'unavailable', true);
  await expect(400, 'invalid-settings', false); // the Anthropic adapter words request-level 400s itself (no provider text)
  const down = createOpenAICompatProvider({ apiKey: 'k', model: 'm', baseUrl: 'http://x', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(down.complete({ system: '', user: '', maxTokens: 1 }), (e) => e.code === 'network' && e.retryable);
});

test('provider factory: selects by config, refuses to start without credentials', () => {
  assert.equal(createProvider({ provider: 'mock' }).name, 'mock');
  assert.throws(() => createProvider({ provider: 'anthropic', model: 'm' }), /ANTHROPIC_API_KEY/);
  assert.throws(() => createProvider({ provider: 'openai-compat', apiKey: 'k', model: 'm' }), /BASE_URL/);
  assert.throws(() => createProvider({ provider: 'nope' }), /Unknown PROVIDER/);
  assert.equal(loadConfig({}).provider, 'mock');
});

// ---------------------------------------------------------------- request validation + handler

test('request validation rejects malformed input and any atomic payload that is not a kind', () => {
  const limits = loadConfig({}).limits;
  const ok = { v: 1, items: [{ id: 0, text: 'hello world' }] };
  assert.ok(validateRequest(ok, limits).value);
  const rejects = [
    null, { v: 2, items: ok.items }, { v: 1, items: [] },
    { v: 1, items: [{ id: 0, text: 'a' }, { id: 0, text: 'b' }] },
    { v: 1, items: [{ id: -1, text: 'a' }] },
    { v: 1, items: [{ id: 0, text: '   ' }] },
    { v: 1, items: [{ id: 0, text: 'x'.repeat(limits.maxItemChars + 1) }] },
    { v: 1, items: [{ id: 0, text: 'ok', role: 'ad' }] },
    { v: 1, items: [{ id: 0, text: `see ${O}1=password123${C}` }] },
    { v: 1, items: Array.from({ length: limits.maxItems + 1 }, (_, i) => ({ id: i, text: 'x' })) },
  ];
  for (const body of rejects) assert.ok(validateRequest(body, limits).error, JSON.stringify(body)?.slice(0, 60));
});

test('handler: auth token, rate limiting, routing and provider-failure mapping', async () => {
  const mk = (cfg, provider = createMockProvider()) => {
    const config = { ...loadConfig({}), retries: 0, requestTimeoutMs: 200, ...cfg };
    return createHandler({ engine: createEngine({ provider, config }), config });
  };
  const req = (extra = {}) => ({ method: 'POST', path: '/v1/rewrite', headers: {}, ip: '1.1.1.1', body: { v: 1, items: [ITEMS[1]] }, ...extra });

  const guarded = mk({ accessToken: 's3cret' });
  assert.equal((await guarded(req())).status, 401);
  assert.equal((await guarded(req({ headers: { 'x-bf-token': 's3cret' } }))).status, 200);

  const limited = mk({ rateLimitPerMin: 2 });
  assert.equal((await limited(req())).status, 200);
  assert.equal((await limited(req())).status, 200);
  const blocked = await limited(req());
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.equal((await limited(req({ headers: { 'x-bf-install': 'another-install-id-0001' } }))).status, 200, 'separate install ids have separate budgets');

  const h = mk({});
  assert.equal((await h({ method: 'GET', path: '/health', headers: {} })).status, 200);
  assert.equal((await h({ method: 'GET', path: '/v1/rewrite', headers: {} })).status, 405);
  assert.equal((await h({ method: 'POST', path: '/nope', headers: {} })).status, 404);
  assert.equal((await h(req({ body: { v: 1, items: [] } }))).status, 400);

  const authFail = mk({}, createMockProvider({ failures: [new ProviderError('auth', 'x', { status: 401 })] }));
  const r = await authFail(req());
  assert.equal(r.status, 502);
  assert.equal(r.body.error.code, 'provider-auth');
  assert.ok(!JSON.stringify(r.body).includes('401'), 'no provider internals leaked');
  const timeout = mk({}, createMockProvider({ latencyMs: 500 }));
  assert.equal((await timeout(req())).status, 504);
});

// ---------------------------------------------------------------- HTTP server + full pipeline

async function withServer(providerOptions, fn, configOverride = {}) {
  const provider = createMockProvider(providerOptions);
  const app = createApp({ ...loadConfig({}), retries: 0, requestTimeoutMs: 1000, ...configOverride }, { provider });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try { return await fn({ baseUrl, provider }); } finally { await new Promise((r) => server.close(r)); }
}

test('http server: health, rewrite, invalid JSON, oversized body', async () => {
  await withServer({}, async ({ baseUrl }) => {
    assert.equal((await (await fetch(`${baseUrl}/health`)).json()).ok, true);
    const res = await fetch(`${baseUrl}/v1/rewrite`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, items: [ITEMS[1]] }) });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(body.results[0].hinglish);
    assert.equal(body.meta.provider, 'mock');
    assert.equal((await fetch(`${baseUrl}/v1/rewrite`, { method: 'POST', body: '{nope' })).status, 400);
    assert.equal((await fetch(`${baseUrl}/v1/rewrite`, { method: 'POST', body: 'x'.repeat(300 * 1024) })).status, 413);
  });
});

function pipeline(dom, baseUrl, payloads, opts = {}) {
  const send = async (msg) => {
    if (msg.type === 'bf:hints') return { ok: true, hints: {} }; // no scheduling hints from this test backend
    if (msg.type === 'bf:lookup') return { ok: true, data: { results: [] } }; // nothing cached
    payloads.push(msg.payload);
    return callBackend({ baseUrl, payload: msg.payload, installId: 'test-install-0000000000', fetchImpl: fetch, retryNetwork: false, ...opts });
  };
  return createController({ root: dom.window.document.body, converter: createRemoteConverter({ send }) });
}

test('end to end: DOM -> extension -> backend -> engine -> DOM, links kept, restore exact', async () => {
  const html = readFileSync('tests/fixtures/wiki-mixed.html', 'utf8');
  await withServer({}, async ({ baseUrl }) => {
    const dom = new JSDOM(html);
    const payloads = [];
    const c = pipeline(dom, baseUrl, payloads);
    const a = dom.window.document.querySelector('a[href="/wiki/Light"]');
    const st = await c.translate(DEFAULT_SETTINGS);
    assert.ok(st.converted >= 4, JSON.stringify(st));
    assert.equal(a.isConnected, true);
    assert.ok(dom.window.document.querySelector('.mw-parser-output').textContent.includes(' hai '), 'mock Hinglish applied');
    assert.deepEqual(st.failed, {});
    c.restore();
    assert.equal(dom.serialize(), new JSDOM(html).serialize());
  });
});

test('privacy end to end: ads, sidebars, nav, code, buttons, inputs and Hindi never reach the backend', async () => {
  await withServer({}, async ({ baseUrl }) => {
    for (const [name, secrets] of [
      ['educational-gfg', ['Enroll now', 'Upgrade your career', 'Join thousands', 'Contact us', 'scikit-learn', 'LinearRegression', 'Trending Now', 'Master data structures', 'Learn programming faster']],
      ['wiki-mixed', ['Smith, J.', 'Main page', 'Random article']],
      ['ads-regression', ['Shop the biggest sale', 'Buy now', 'Discover why millions', 'Click here to claim', 'You may also like']],
      ['dictionary', ['महाभियोग', 'Search', 'define impeach', 'Call our experienced legal team']],
    ]) {
      const dom = new JSDOM(readFileSync(`tests/fixtures/${name}.html`, 'utf8'));
      const payloads = [];
      const st = await pipeline(dom, baseUrl, payloads).translate({ ...DEFAULT_SETTINGS, sendPageContext: false });
      assert.ok(st.converted > 0, name);
      const wire = JSON.stringify(payloads);
      for (const s of secrets) assert.ok(!wire.includes(s), `${name}: "${s}" was sent to the backend`);
      assert.ok(!/https?:\/\//.test(wire), `${name}: no URLs in payload`);
    }
  });
});

test('privacy: page title and heading are context only and can be switched off', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const html = readFileSync('tests/fixtures/educational-gfg.html', 'utf8');
    const on = [];
    await pipeline(new JSDOM(html), baseUrl, on).translate(DEFAULT_SETTINGS);
    assert.equal(on[0].page.title, 'Introduction to Machine Learning - LearnSite');
    assert.ok(on[0].items.some((i) => i.heading));
    const off = [];
    await pipeline(new JSDOM(html), baseUrl, off).translate({ ...DEFAULT_SETTINGS, sendPageContext: false });
    assert.deepEqual(off[0].page, {});
    assert.ok(off[0].items.every((i) => !('heading' in i)));
  });
});

test('definition role is sent for dictionary entries', async () => {
  await withServer({}, async ({ baseUrl }) => {
    const payloads = [];
    await pipeline(new JSDOM(readFileSync('tests/fixtures/dictionary.html', 'utf8')), baseUrl, payloads).translate(DEFAULT_SETTINGS);
    assert.ok(payloads[0].items.some((i) => i.role === 'definition' && i.text.startsWith('(used about a court of law')));
  });
});

test('failure handling: unreachable backend leaves the page untouched and reports why', async () => {
  const html = readFileSync('tests/fixtures/article-news.html', 'utf8');
  const dom = new JSDOM(html);
  const send = (msg) => callBackend({ baseUrl: 'http://127.0.0.1:1', payload: msg.payload, installId: 'x', fetchImpl: fetch, retryNetwork: false });
  const c = createController({ root: dom.window.document.body, converter: createRemoteConverter({ send }) });
  const st = await c.translate(DEFAULT_SETTINGS);
  assert.equal(st.converted, 0);
  assert.match(st.error, /backend/i);
  assert.equal(dom.serialize(), new JSDOM(html).serialize());
});

test('failure handling: items the engine rejects stay in English, others convert', async () => {
  await withServer({ corrupt: (item, out) => (item.text.includes('antibodies') ? '' : out) }, async ({ baseUrl }) => {
    const html = readFileSync('tests/fixtures/article-news.html', 'utf8');
    const dom = new JSDOM(html);
    const st = await pipeline(dom, baseUrl, []).translate(DEFAULT_SETTINGS);
    assert.ok(st.converted > 0);
    assert.equal(st.failed['invalid-output'], 2, 'the two paragraphs mentioning antibodies');
    assert.ok(dom.window.document.body.textContent.includes('the antibodies that were made earlier'), 'English kept');
    assert.ok(dom.window.document.body.textContent.includes('showing body a harmless'), 'other paragraphs converted');
  });
});

test('defence in depth: the extension re-validates placeholders even if the backend misbehaves', async () => {
  const html = `<body><main><p>Machine learning is a <a href="/x">branch</a> of artificial intelligence that learns from data.</p></main></body>`;
  const dom = new JSDOM(html);
  const forged = { batchSize: 10, convert: async (items) => items.map((i) => ({ id: i.id, hinglish: 'Machine learning ek branch hai jo data se seekhti hai.' })) };
  const c = createController({ root: dom.window.document.body, converter: forged });
  const st = await c.translate(DEFAULT_SETTINGS);
  assert.equal(st.converted, 0);
  assert.equal(st.failed['placeholder-mismatch'], 1);
  assert.equal(dom.serialize(), new JSDOM(html).serialize());
});

test('backend client: success, structured errors, one network retry, timeout', async () => {
  const ok = await callBackend({ baseUrl: 'http://b/', payload: { v: 1 }, installId: 'i', token: 't',
    fetchImpl: async (url, init) => { assert.equal(url, 'http://b/v1/rewrite'); assert.equal(init.headers['x-bf-token'], 't'); return { ok: true, status: 200, json: async () => ({ results: [] }) }; } });
  assert.equal(ok.ok, true);
  const limited = await callBackend({ baseUrl: 'http://b', payload: {}, installId: 'i', fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: { code: 'rate-limited', message: 'Too many requests' } }) }) });
  assert.deepEqual(limited, { ok: false, error: { code: 'rate-limited', message: 'Too many requests' } });
  let tries = 0;
  const flaky = await callBackend({ baseUrl: 'http://b', payload: {}, installId: 'i', fetchImpl: async () => { if (++tries === 1) throw new TypeError('x'); return { ok: true, status: 200, json: async () => ({ results: [] }) }; } });
  assert.equal(flaky.ok, true);
  assert.equal(tries, 2);
  const down = await callBackend({ baseUrl: 'http://b', payload: {}, installId: 'i', fetchImpl: async () => { throw new TypeError('x'); } });
  assert.equal(down.error.code, 'unreachable');
  const slow = await callBackend({ baseUrl: 'http://b', payload: {}, installId: 'i', timeoutMs: 20,
    fetchImpl: (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' })))) });
  assert.equal(slow.error.code, 'timeout');
});

// ---------------------------------------------------------------- secrets

test('no credentials or provider code in the extension sources or built bundles', () => {
  const walk = (dir) => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  const files = [...walk('extension/src'), 'extension/manifest.json'];
  try { files.push(...walk('extension/dist').filter((f) => f.endsWith('.js'))); } catch { /* not built */ }
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    assert.ok(!/x-api-key|anthropic-version|api\.anthropic\.com|api\.openai\.com|groq\.com|sk-[A-Za-z0-9_-]{16,}|process\.env/.test(text), `${f} contains provider/credential material`);
  }
});
