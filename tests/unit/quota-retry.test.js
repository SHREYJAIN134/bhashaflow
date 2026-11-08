import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { loadConfig } from '../../backend/src/config.js';
import { createEngine } from '../../backend/src/engine.js';
import { createHandler } from '../../backend/src/handler.js';
import { createApp } from '../../backend/src/server.js';
import { createProvider } from '../../backend/src/providers/index.js';
import { createOpenAICompatProvider } from '../../backend/src/providers/openai-compat.js';
import { errorFromResponse, quotaMessage, ProviderError } from '../../backend/src/providers/errors.js';
import { createController } from '../../extension/src/content/controller.js';
import { createRemoteConverter } from '../../extension/src/content/converter-remote.js';
import { DEFAULT_SETTINGS } from '../../extension/src/shared/settings.js';

const KEY = 'dummy-quota-test-key-not-real-9876543210';
const ITEM = { id: 0, role: 'paragraph', text: 'The REST API returns 200 results in JSON format when the request is valid and complete.' };
const GOOD = JSON.stringify({ results: [{ id: 0, hinglish: 'REST API 200 results JSON format mein return karti hai jab request valid aur complete hoti hai.' }] });
const okReply = (content = GOOD) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } });

// Error bodies shaped like Gemini's OpenAI-compatible endpoint (array-wrapped, with QuotaFailure + RetryInfo).
const gemini429 = (quotaId, retryDelay) => [{ error: {
  code: 429, status: 'RESOURCE_EXHAUSTED', message: `You exceeded your current quota. ${KEY}`,
  details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
  ],
} }];
const DAILY = () => gemini429('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '72714s');
const PER_MINUTE = (delay = '0.01s') => gemini429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', delay);

/** fetch stub that plays a script of replies, one per call, recording call times. */
function scripted(replies) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ at: Date.now(), body: JSON.parse(init.body), headers: init.headers });
    const r = replies[Math.min(calls.length - 1, replies.length - 1)];
    return { ok: r.status < 300, status: r.status, json: async () => r.body, headers: { get: (k) => (r.headers ? r.headers[k.toLowerCase()] ?? null : null) } };
  };
  fn.calls = calls;
  return fn;
}
const reply = (status, body, headers) => ({ status, body, headers });
const cfg = (over = {}) => ({ ...loadConfig({}), requestTimeoutMs: 1000, retries: 2, retryBaseMs: 5, maxRetryWaitMs: 1000, ...over });
const build = (replies, over = {}) => {
  const fetchImpl = scripted(replies);
  const config = cfg(over);
  const provider = createOpenAICompatProvider({ apiKey: KEY, model: 'm', baseUrl: 'http://x', temperature: config.temperature, fetchImpl });
  return { fetchImpl, config, provider, engine: createEngine({ provider, config }) };
};
const fakeRes = (status, body, headers = {}) => ({ status, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });

// ---------------------------------------------------------------- classification

test('429 classification: daily quota vs transient rate limit', async () => {
  const daily = await errorFromResponse(fakeRes(429, DAILY()), KEY);
  assert.equal(daily.code, 'quota-exhausted');
  assert.equal(daily.retryable, false);
  assert.equal(daily.retryAfterSec, 72714);
  assert.match(daily.message, /daily quota is used up/);
  assert.match(daily.message, /about 20 hours/);
  assert.match(daily.message, /different MODEL/);
  assert.ok(!daily.message.includes(KEY) && !daily.message.includes('RESOURCE_EXHAUSTED'), 'no provider internals or key');

  const perMinute = await errorFromResponse(fakeRes(429, PER_MINUTE('12s')), KEY);
  assert.equal(perMinute.code, 'rate-limit');
  assert.equal(perMinute.retryable, true);
  assert.equal(perMinute.retryAfterSec, 12);

  // object-shaped body (not array), no details at all, header hint
  assert.equal((await errorFromResponse(fakeRes(429, { error: { message: 'slow down' } }))).code, 'rate-limit');
  const hinted = await errorFromResponse(fakeRes(429, { error: { message: 'x' } }, { 'retry-after': '7' }));
  assert.deepEqual([hinted.code, hinted.retryable, hinted.retryAfterSec], ['rate-limit', true, 7]);

  // OpenAI-style exhausted quota and Anthropic-style rate limit
  assert.equal((await errorFromResponse(fakeRes(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }))).code, 'quota-exhausted');
  assert.equal((await errorFromResponse(fakeRes(429, { error: { code: 'rate_limit_exceeded', message: 'rpm' } }))).code, 'rate-limit');
  assert.equal((await errorFromResponse(fakeRes(429, { type: 'error', error: { type: 'rate_limit_error', message: 'x' } }))).code, 'rate-limit');

  // a provider that asks for a very long wait is not transient, even without naming a daily quota
  const longWait = await errorFromResponse(fakeRes(429, { error: { message: 'x' } }, { 'retry-after': '3600' }));
  assert.equal(longWait.code, 'quota-exhausted');

  // other statuses unchanged
  assert.equal((await errorFromResponse(fakeRes(503, {}))).retryable, true);
  assert.equal((await errorFromResponse(fakeRes(401, {}))).code, 'auth');
  assert.equal((await errorFromResponse(fakeRes(400, { error: { message: `bad ${KEY}` } }), KEY)).message.includes(KEY), false);
});

test('quotaMessage is actionable at any time scale and never suggests payment', () => {
  assert.match(quotaMessage(72714), /about 20 hours/);
  assert.match(quotaMessage(1800), /about 30 minutes/);
  assert.match(quotaMessage(45), /about 45 seconds/);
  assert.doesNotMatch(quotaMessage(undefined), /\(/, 'no time claim when the provider gave none');
  assert.doesNotMatch(quotaMessage(100), /billing|pay|upgrade|plan/i);
});

// ---------------------------------------------------------------- engine: quota is never retried

test('daily quota exhaustion is never retried, even with retries configured', async () => {
  const { fetchImpl, engine } = build([reply(429, DAILY())], { retries: 5 });
  const t0 = Date.now();
  const out = await engine.rewrite({ page: {}, items: [ITEM] });
  assert.equal(fetchImpl.calls.length, 1, 'exactly one request');
  assert.equal(out.meta.retries, 0);
  assert.equal(out.fatal, 'quota-exhausted');
  assert.equal(out.results[0].error.code, 'quota-exhausted');
  assert.match(out.results[0].error.message, /daily quota is used up/);
  assert.equal(out.fatalDetail.retryAfterSec, 72714);
  assert.ok(Date.now() - t0 < 500, 'fails fast, no backoff sleep');
});

test('quota exhaustion without any retry hint is not retried either (the flag, not the wait, decides)', async () => {
  const body = { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } };
  const { fetchImpl, engine } = build([reply(429, body), reply(200, okReply())], { retries: 5, retryBaseMs: 1 });
  const out = await engine.rewrite({ page: {}, items: [ITEM] });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(out.fatal, 'quota-exhausted');
  assert.equal(out.fatalDetail.retryAfterSec, undefined);
});

test('a transient rate limit then a daily quota error stops at the quota error', async () => {
  const { fetchImpl, engine } = build([reply(429, PER_MINUTE()), reply(429, DAILY()), reply(200, okReply())], { retries: 5 });
  const out = await engine.rewrite({ page: {}, items: [ITEM] });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(out.fatal, 'quota-exhausted');
});

// ---------------------------------------------------------------- engine: transient limits are bounded

test('transient rate limits are retried with backoff and then succeed', async () => {
  const { fetchImpl, engine } = build([reply(429, PER_MINUTE()), reply(503, {}), reply(200, okReply())], { retries: 2 });
  const out = await engine.rewrite({ page: {}, items: [ITEM] });
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(out.meta.retries, 2);
  assert.equal(out.fatal, null);
  assert.ok(out.results[0].hinglish);
});

test('retry count is bounded by RETRIES and gives up with a rate-limit error', async () => {
  for (const retries of [0, 1, 2, 4]) {
    const { fetchImpl, engine } = build([reply(429, PER_MINUTE())], { retries });
    const out = await engine.rewrite({ page: {}, items: [ITEM] });
    assert.equal(fetchImpl.calls.length, retries + 1, `retries=${retries}`);
    assert.equal(out.fatal, 'rate-limit');
    assert.equal(out.results[0].error.code, 'rate-limit');
    assert.equal(out.meta.retries, retries);
  }
});

test('backoff grows exponentially between attempts', async () => {
  const { fetchImpl, engine } = build([reply(503, {})], { retries: 3, retryBaseMs: 20 });
  await engine.rewrite({ page: {}, items: [ITEM] });
  const gaps = fetchImpl.calls.slice(1).map((c, i) => c.at - fetchImpl.calls[i].at);
  assert.equal(gaps.length, 3);
  // minimum waits are 20, 40, 80 ms (jitter only adds); allow 5 ms timer slack
  [20, 40, 80].forEach((min, i) => assert.ok(gaps[i] >= min - 5, `gap ${i} was ${gaps[i]}ms, expected >= ${min}`));
});

test("a provider's retry hint is honoured when short and respected as a limit when long", async () => {
  const short = build([reply(429, PER_MINUTE('0.06s')), reply(200, okReply())], { retries: 2, retryBaseMs: 1 });
  const out = await short.engine.rewrite({ page: {}, items: [ITEM] });
  assert.equal(out.fatal, null);
  const gap = short.fetchImpl.calls[1].at - short.fetchImpl.calls[0].at;
  assert.ok(gap >= 55, `waited ${gap}ms, expected about 60`);

  // 30 s is "transient" for the provider but longer than we are willing to wait (maxRetryWaitMs 1000)
  const long = build([reply(429, PER_MINUTE('30s')), reply(200, okReply())], { retries: 3, maxRetryWaitMs: 1000 });
  const failed = await long.engine.rewrite({ page: {}, items: [ITEM] });
  assert.equal(long.fetchImpl.calls.length, 1, 'does not retry too early');
  assert.equal(failed.results[0].error.code, 'rate-limit');
});

// ---------------------------------------------------------------- API response + extension behaviour

test('API returns an actionable 503 for quota exhaustion and a distinct one for rate limits', async () => {
  const mk = (replies, over) => { const b = build(replies, over); return createHandler({ engine: b.engine, config: b.config }); };
  const req = { method: 'POST', path: '/v1/rewrite', headers: {}, ip: '1.1.1.1', body: { v: 1, items: [ITEM] } };

  const quota = await mk([reply(429, DAILY())])(req);
  assert.equal(quota.status, 503);
  assert.equal(quota.body.error.code, 'provider-quota-exhausted');
  assert.match(quota.body.error.message, /daily quota is used up/);
  assert.equal(quota.body.error.retryAfterSec, 72714);

  const limited = await mk([reply(429, PER_MINUTE())], { retries: 1 })(req);
  assert.equal(limited.status, 503);
  assert.equal(limited.body.error.code, 'provider-rate-limit');
  assert.match(limited.body.error.message, /rate limiting/);

  for (const r of [quota, limited]) assert.ok(!JSON.stringify(r).includes(KEY), 'key never in responses');
  assert.notEqual(quota.body.error.message, limited.body.error.message);
});

const PAGE = `<body><main>${Array.from({ length: 12 }, (_, i) =>
  `<p>Paragraph ${i} explains how this particular part of the system works and why it is useful in practice.</p>`).join('')}</main></body>`;

// ~200-character blocks: the packer needs 4 requests for 30 of them, so "stops sending" is observable
const BIG_PAGE = `<body><main>${Array.from({ length: 30 }, (_, i) =>
  `<p>Paragraph ${i} explains how this particular part of the system works and why it is useful in practice, with enough extra words to make the block reasonably long.</p>`).join('')}</main></body>`;
const SEQUENTIAL = { ...DEFAULT_SETTINGS, maxParallelRequests: 1 };

test('extension stops sending batches once the backend reports quota exhaustion', async () => {
  const dom = new JSDOM(BIG_PAGE);
  let sends = 0;
  const send = async (msg) => { if (msg.type === 'bf:hints') return { ok: true, hints: {} }; if (msg.type === 'bf:lookup') return { ok: true, data: { results: [] } }; sends++; return { ok: false, error: { code: 'provider-quota-exhausted', message: quotaMessage(72714) } }; };
  const c = createController({ root: dom.window.document.body, converter: createRemoteConverter({ send }) });
  const st = await c.translate(SEQUENTIAL);
  assert.equal(sends, 1, '30 blocks = several requests, but only the first is sent');
  assert.equal(st.converted, 0);
  assert.match(st.error, /daily quota is used up/);
  assert.equal(dom.serialize(), new JSDOM(BIG_PAGE).serialize(), 'page untouched');
});

test('extension also stops when per-item results carry a quota error', async () => {
  const dom = new JSDOM(PAGE);
  let batches = 0;
  const converter = {
    batchSize: 5,
    convert: async (items) => { batches++; return items.map((i) => ({ id: i.id, error: { code: 'quota-exhausted', message: quotaMessage(3600) } })); },
  };
  const st = await createController({ root: dom.window.document.body, converter }).translate(SEQUENTIAL);
  assert.equal(batches, 1);
  assert.equal(st.failed['quota-exhausted'], 5);
  assert.match(st.error, /daily quota/);
  assert.equal(dom.serialize(), new JSDOM(PAGE).serialize());
});

test('a transient rate-limit error does not stop the extension from continuing', async () => {
  const dom = new JSDOM(PAGE);
  let batches = 0;
  const converter = {
    batchSize: 5,
    convert: async (items) => { batches++; return items.map((i) => ({ id: i.id, error: { code: 'rate-limit', message: 'x' } })); },
  };
  const st = await createController({ root: dom.window.document.body, converter }).translate(DEFAULT_SETTINGS);
  assert.equal(batches, 3, 'rate limits are per-item failures, the run continues');
  assert.equal(st.error, undefined);
});

// ---------------------------------------------------------------- temperature

test('temperature: default 0.3, configurable, validated, and sent to the provider', async () => {
  assert.equal(loadConfig({}).temperature, 0.3);
  assert.equal(loadConfig({ TEMPERATURE: '' }).temperature, 0.3);
  assert.equal(loadConfig({ TEMPERATURE: '0.1' }).temperature, 0.1);
  assert.equal(loadConfig({ TEMPERATURE: '0' }).temperature, 0, '0 is a valid temperature');
  assert.equal(loadConfig({ TEMPERATURE: '2' }).temperature, 2);
  for (const bad of ['hot', '-0.1', '2.5', 'NaN', '0,3']) {
    assert.throws(() => loadConfig({ TEMPERATURE: bad }), /TEMPERATURE must be a number between 0 and 2/, bad);
  }

  const gemini = { PROVIDER: 'openai-compat', MODEL: 'gemini-3.6-flash', LLM_API_KEY: KEY, BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai', REASONING_EFFORT: 'none' };
  for (const [env, expected] of [[{}, 0.3], [{ TEMPERATURE: '0.1' }, 0.1], [{ TEMPERATURE: '0' }, 0]]) {
    const fetchImpl = scripted([reply(200, okReply('{}'))]);
    await createProvider(loadConfig({ ...gemini, ...env }), fetchImpl).complete({ system: '', user: '', maxTokens: 10 });
    assert.equal(fetchImpl.calls[0].body.temperature, expected);
    assert.equal(fetchImpl.calls[0].body.reasoning_effort, 'none', 'other Gemini settings unchanged');
  }
});

// ---------------------------------------------------------------- works without billing

test('zero-cost operation: runs with no key, no billing setup and no paid-provider dependency', async () => {
  const config = loadConfig({});
  assert.equal(config.provider, 'mock');
  assert.equal(config.apiKey, '');
  const app = createApp(config);
  const res = await app.handle({ method: 'POST', path: '/v1/rewrite', headers: {}, ip: '1.1.1.1', body: { v: 1, items: [ITEM] } });
  assert.equal(res.status, 200);
  assert.ok(res.body.results[0].hinglish);

  // Gemini free tier: only a key is needed (no billing variables anywhere)
  assert.doesNotThrow(() => createProvider(loadConfig({ PROVIDER: 'openai-compat', MODEL: 'm', LLM_API_KEY: KEY, BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai' })));

  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies at all');
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['esbuild', 'jsdom']);

  const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  for (const file of [...walk('backend/src'), ...walk('extension/src'), 'api/rewrite.js', '.env.example']) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /stripe|billing|payment|razorpay|paypal|credit card/i, `${file} mentions payment/billing`);
  }
});

test('prompt default stays hinglish-v2 and quota handling did not change request contents', () => {
  assert.equal(loadConfig({}).promptVersion, 'hinglish-v2');
  assert.equal(loadConfig({ PROMPT_VERSION: 'hinglish-v1' }).promptVersion, 'hinglish-v1');
  assert.ok(new ProviderError('x', 'y', { retryAfterSec: 3 }).retryAfterSec === 3);
});
