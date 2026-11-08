import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../backend/src/config.js';
import { createProvider } from '../../backend/src/providers/index.js';
import { createOllamaProvider, resolveOllamaUrl, RESULT_SCHEMA } from '../../backend/src/providers/ollama.js';
import { createEngine } from '../../backend/src/engine.js';
import { createHandler } from '../../backend/src/handler.js';
import { getPrompt } from '../../backend/src/prompts/index.js';

const OLLAMA_ENV = { PROVIDER: 'ollama', MODEL: 'qwen3:4b', OLLAMA_BASE_URL: 'http://127.0.0.1:11434' };
const GEMINI_KEY = 'dummy-gemini-key-not-real-0123456789';
const ITEM = { id: 0, role: 'paragraph', text: 'The REST API returns 200 results in JSON format when the request is valid and complete.' };
const GOOD = 'REST API 200 results JSON format mein return karti hai jab request valid aur complete hoti hai.';

const chatReply = (content, extra = {}) => ({ message: { role: 'assistant', content }, done: true, done_reason: 'stop', prompt_eval_count: 11, eval_count: 7, ...extra });

/** fetch stub: replies come from a list (the last one repeats); records every request. */
function stub(...replies) {
  const seen = [];
  const fn = async (url, init) => {
    seen.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = replies[Math.min(seen.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    return { ok: r.status < 300, status: r.status, json: async () => { if (r.notJson) throw new SyntaxError('bad'); return r.body; } };
  };
  fn.seen = seen;
  return fn;
}
const ok = (content, extra) => ({ status: 200, body: chatReply(content, extra) });
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
const answer = (hinglish) => JSON.stringify({ results: [{ id: 0, hinglish }] });
const call = (provider) => provider.complete({ system: '', user: '', maxTokens: 5 });

// ---------------------------------------------------------------- configuration + provider selection

test('config: PROVIDER=ollama needs no key, defaults to qwen3:4b at 127.0.0.1:11434, ignores cloud settings', () => {
  const c = loadConfig({ PROVIDER: 'ollama' });
  assert.equal(c.provider, 'ollama');
  assert.equal(c.model, 'qwen3:4b');
  assert.equal(c.ollamaBaseUrl, 'http://127.0.0.1:11434');
  assert.equal(c.apiKey, '');
  assert.equal(c.promptVersion, 'hinglish-v2');
  assert.equal(c.retries, 1);
  assert.equal(c.retryTimeouts, false);
  assert.deepEqual(c.tokenBudget, { base: 40, perItem: 25, perChar: 0.9 });
  assert.equal(c.requestTimeoutMs, 40000, 'longer than the hosted default, below the extension 45 s limit');

  const withCloud = loadConfig({ ...OLLAMA_ENV, LLM_API_KEY: GEMINI_KEY, GEMINI_API_KEY: GEMINI_KEY, BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai', REASONING_EFFORT: 'none' });
  assert.equal(withCloud.apiKey, '', 'a Gemini key in .env is never loaded for Ollama');
  assert.equal(withCloud.baseUrl, '');
  assert.ok(!JSON.stringify(withCloud).includes(GEMINI_KEY));
  assert.equal(loadConfig({ ...OLLAMA_ENV, MODEL: 'qwen3:8b' }).model, 'qwen3:8b');
  assert.equal(loadConfig({ ...OLLAMA_ENV, REQUEST_TIMEOUT_MS: '90000', RETRIES: '1' }).requestTimeoutMs, 90000);
  assert.equal(loadConfig({ ...OLLAMA_ENV, RETRIES: '1' }).retries, 1);
});

test('config: Gemini and other providers are unchanged by the Ollama work', () => {
  const g = loadConfig({ PROVIDER: 'openai-compat', MODEL: 'gemini-3.6-flash', LLM_API_KEY: GEMINI_KEY, BASE_URL: 'https://g.example/openai' });
  assert.equal(g.apiKey, GEMINI_KEY);
  assert.equal(g.baseUrl, 'https://g.example/openai');
  assert.equal(g.retries, 2);
  assert.equal(g.requestTimeoutMs, 30000);
  assert.equal(createProvider(g, stub()).name, 'openai-compat');
  assert.equal(createProvider({ provider: 'mock' }).name, 'mock');
});

test('provider selection: ollama -> ollama adapter; unknown provider lists the valid ones', () => {
  const p = createProvider(loadConfig(OLLAMA_ENV), stub());
  assert.equal(p.name, 'ollama');
  assert.equal(p.model, 'qwen3:4b');
  assert.throws(() => createProvider({ provider: 'nope' }), /ollama, openai-compat, anthropic or mock/);
});

test('OLLAMA_BASE_URL: must be a valid http(s) URL, and loopback unless explicitly allowed', () => {
  assert.equal(resolveOllamaUrl('http://localhost:11434/'), 'http://localhost:11434');
  assert.equal(resolveOllamaUrl('http://[::1]:11434'), 'http://[::1]:11434');
  assert.throws(() => resolveOllamaUrl('not a url'), /not a valid URL/);
  assert.throws(() => resolveOllamaUrl('ftp://127.0.0.1'), /http/);
  assert.throws(() => loadConfig({ PROVIDER: 'ollama', OLLAMA_BASE_URL: 'https://cloud.example.com' }), /not this machine/);
  assert.equal(loadConfig({ PROVIDER: 'ollama', OLLAMA_BASE_URL: 'http://192.168.1.5:11434', OLLAMA_ALLOW_REMOTE: 'true' }).ollamaBaseUrl, 'http://192.168.1.5:11434');
});

// ---------------------------------------------------------------- request format

test('request: /api/chat, no auth header, thinking off, schema-constrained JSON, no streaming, context + token limits', async () => {
  const fetchImpl = stub(ok('{"results":[]}'));
  const p = createProvider(loadConfig({ ...OLLAMA_ENV, LLM_API_KEY: GEMINI_KEY }), fetchImpl);
  const out = await p.complete({ system: 'SYS', user: 'USR', maxTokens: 700 });

  const [req] = fetchImpl.seen;
  assert.equal(req.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(req.init.method, 'POST');
  assert.deepEqual(Object.keys(req.init.headers), ['content-type'], 'no Authorization header');
  assert.deepEqual(req.body, {
    model: 'qwen3:4b',
    messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USR' }],
    stream: false,
    think: false,
    format: RESULT_SCHEMA,
    options: { num_ctx: 8192, num_predict: 700, temperature: 0.3 },
  });
  assert.ok(!JSON.stringify(req).includes(GEMINI_KEY));
  assert.deepEqual(out, { text: '{"results":[]}', usage: { inputTokens: 11, outputTokens: 7 } });
});

test('the output schema matches what the engine parses (results[].id integer, hinglish string)', () => {
  assert.deepEqual(RESULT_SCHEMA.required, ['results']);
  assert.deepEqual(RESULT_SCHEMA.properties.results.items.required, ['id', 'hinglish']);
});

test('request: OLLAMA_NUM_CTX and OLLAMA_KEEP_ALIVE are passed through', async () => {
  const fetchImpl = stub(ok('{}'));
  await call(createProvider(loadConfig({ ...OLLAMA_ENV, OLLAMA_NUM_CTX: '16384', OLLAMA_KEEP_ALIVE: '30m' }), fetchImpl));
  assert.equal(fetchImpl.seen[0].body.options.num_ctx, 16384);
  assert.equal(fetchImpl.seen[0].body.keep_alive, '30m');
});

test('a model that rejects the think field is asked again without it', async () => {
  const fetchImpl = stub({ status: 400, body: { error: '"llama3" does not support thinking' } }, ok('{"results":[]}'));
  const out = await call(createProvider(loadConfig({ ...OLLAMA_ENV, MODEL: 'llama3' }), fetchImpl));
  assert.equal(fetchImpl.seen.length, 2);
  assert.equal(fetchImpl.seen[0].body.think, false);
  assert.ok(!('think' in fetchImpl.seen[1].body));
  assert.equal(out.text, '{"results":[]}');
});

test('the prompt sent is exactly hinglish-v2, unchanged', async () => {
  const fetchImpl = stub(ok(answer(GOOD)));
  const config = loadConfig(OLLAMA_ENV);
  await createEngine({ provider: createProvider(config, fetchImpl), config }).rewrite({ page: {}, items: [ITEM] });
  assert.equal(fetchImpl.seen[0].body.messages[0].content, getPrompt('hinglish-v2').system);
  assert.equal(JSON.parse(fetchImpl.seen[0].body.messages[1].content).items[0].text, ITEM.text);
});

// ---------------------------------------------------------------- response handling

test('reasoning text never reaches the translation: <think> blocks are stripped', async () => {
  const think = `<think>\nLet me translate this carefully...\n</think>\n${answer(GOOD)}`;
  const body = chatReply(think, { message: { role: 'assistant', content: think, thinking: 'hidden reasoning' } });
  const { text } = await call(createOllamaProvider({ fetchImpl: stub({ status: 200, body }) }));
  assert.equal(text, answer(GOOD));
  assert.ok(!/think|Let me|hidden/i.test(text));

  const unopened = createOllamaProvider({ fetchImpl: stub(ok(`reasoning with no opening tag</think>${answer(GOOD)}`)) });
  assert.equal((await call(unopened)).text, answer(GOOD));

  await assert.rejects(call(createOllamaProvider({ fetchImpl: stub(ok('<think>never finished answering</think>')) })), (e) => e.code === 'empty-response');
});

test('end to end through the engine: valid answer accepted, usage recorded, provider named in meta', async () => {
  const config = loadConfig(OLLAMA_ENV);
  const out = await createEngine({ provider: createProvider(config, stub(ok(answer(GOOD)))), config }).rewrite({ page: {}, items: [ITEM] });
  assert.equal(out.results[0].hinglish, GOOD);
  assert.equal(out.meta.provider, 'ollama');
  assert.equal(out.meta.model, 'qwen3:4b');
  assert.equal(out.meta.promptVersion, 'hinglish-v2');
  assert.equal(out.meta.inputTokens, 11);
});

test('validation still applies: Devanagari output is rejected, repaired once, then reported per item', async () => {
  const config = loadConfig(OLLAMA_ENV);
  const fetchImpl = stub(ok(answer('यह एक परीक्षण है')));
  const out = await createEngine({ provider: createProvider(config, fetchImpl), config }).rewrite({ page: {}, items: [ITEM] });
  assert.equal(fetchImpl.seen.length, 2, 'initial call plus one repair pass');
  assert.equal(out.results[0].error.code, 'invalid-output');
  assert.equal(out.results[0].hinglish, undefined);
});

// ---------------------------------------------------------------- errors

async function viaHandler(fetchImpl, env = OLLAMA_ENV) {
  const config = { ...loadConfig(env), requestTimeoutMs: 300 };
  const handle = createHandler({ engine: createEngine({ provider: createProvider(config, fetchImpl), config }), config });
  return handle({ method: 'POST', path: '/v1/rewrite', headers: {}, ip: '1.1.1.1', body: { v: 1, items: [ITEM] } });
}

test('Ollama not running: clear, non-retried 503 provider-ollama-not-running that names the fix', async () => {
  const fetchImpl = stub(refused());
  const res = await viaHandler(fetchImpl, { ...OLLAMA_ENV, RETRIES: '3' });
  assert.equal(fetchImpl.seen.length, 1, 'no retries against a server that is down');
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'provider-ollama-not-running');
  assert.match(res.body.error.message, /Could not reach Ollama at http:\/\/127\.0\.0\.1:11434/);
  assert.match(res.body.error.message, /ollama serve/);
});

test('model missing: 404 becomes provider-ollama-model-missing with the pull command', async () => {
  const fetchImpl = stub({ status: 404, body: { error: "model 'qwen3:4b' not found" } });
  const res = await viaHandler(fetchImpl);
  assert.equal(fetchImpl.seen.length, 1);
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'provider-ollama-model-missing');
  assert.match(res.body.error.message, /ollama pull qwen3:4b/);
});

test('timeout: a hung Ollama gives a 504 provider-timeout, and the request is aborted', async () => {
  let aborted = false;
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => {
    aborted = true;
    reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  }));
  const res = await viaHandler(hang);
  assert.equal(res.status, 504);
  assert.equal(res.body.error.code, 'provider-timeout');
  assert.ok(aborted);
});

test('malformed responses: non-JSON body, wrong shape, and non-JSON model text each fail clearly, never as a translation', async () => {
  for (const bad of [{ status: 200, notJson: true }, { status: 200, body: { unexpected: true } }, { status: 200, body: { message: { content: 42 } } }]) {
    await assert.rejects(call(createOllamaProvider({ fetchImpl: stub(bad) })), (e) => e.code === 'bad-json' && e.retryable === true);
  }
  const res = await viaHandler(stub(ok('Sure! Here is your translation, no JSON.')));
  assert.equal(res.status, 502);
  assert.equal(res.body.error.code, 'provider-bad-json');
  assert.match(res.body.error.message, /malformed/);
  assert.ok(!JSON.stringify(res.body).includes('Sure!'), 'model text is not echoed');
});

test('truncated output (done_reason=length) and empty output are explicit errors', async () => {
  await assert.rejects(call(createOllamaProvider({ fetchImpl: stub(ok('{"results":[{"id":0,"hing', { done_reason: 'length' })) })),
    (e) => e.code === 'truncated' && e.retryable === true, 'a random repetition loop is worth one more try');
  await assert.rejects(call(createOllamaProvider({ fetchImpl: stub(ok('  ')) })), (e) => e.code === 'empty-response' && e.retryable === true);
});

test('server errors are retryable "unavailable"; other 4xx are bad-request', async () => {
  await assert.rejects(call(createOllamaProvider({ fetchImpl: stub({ status: 500, body: { error: 'runner crashed' } }) })),
    (e) => e.code === 'unavailable' && e.retryable === true);
  await assert.rejects(call(createOllamaProvider({ fetchImpl: stub({ status: 400, body: { error: 'invalid options' } }) })),
    (e) => e.code === 'bad-request' && /invalid options/.test(e.message));
});

// ---------------------------------------------------------------- privacy: nothing goes to a cloud provider

test('selecting Ollama sends page text only to the local Ollama host, even with cloud credentials in the environment, even on failure', async () => {
  const env = { ...OLLAMA_ENV, LLM_API_KEY: GEMINI_KEY, GEMINI_API_KEY: GEMINI_KEY, BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai', ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'y' };
  const scenarios = [stub(ok(answer(GOOD))), stub(refused()), stub({ status: 404, body: { error: 'model not found' } }), stub({ status: 500, body: {} })];
  for (const fetchImpl of scenarios) {
    const config = { ...loadConfig(env), retries: 2, retryBaseMs: 1 };
    await createEngine({ provider: createProvider(config, fetchImpl), config }).rewrite({ page: { title: 'T' }, items: [ITEM] });
    assert.ok(fetchImpl.seen.length >= 1);
    for (const r of fetchImpl.seen) {
      assert.equal(new URL(r.url).origin, 'http://127.0.0.1:11434');
      assert.ok(!JSON.stringify(r).includes(GEMINI_KEY));
    }
  }
});

test('/health reports the Ollama provider and model without any credential', async () => {
  const config = loadConfig({ ...OLLAMA_ENV, LLM_API_KEY: GEMINI_KEY });
  const handle = createHandler({ engine: createEngine({ provider: createProvider(config, stub()), config }), config });
  const res = await handle({ method: 'GET', path: '/health', headers: {} });
  assert.deepEqual(res.body, {
    ok: true, provider: 'ollama', model: 'qwen3:4b', promptVersion: 'hinglish-v2',
    maxConcurrency: 1, firstBatchItems: 1, batch: { maxItems: 6, maxChars: 500, maxItemChars: 600 }, // scheduling hints: one request at a time, small batches
  });
});

// ---------------------------------------------------------------- bounded runaway generation (local model)

test('Ollama output budget is tight and scales with items and characters; hosted providers keep the generous one', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body).options.num_predict); return { ok: true, status: 200, json: async () => chatReply(answer(GOOD)) }; };
  const config = loadConfig(OLLAMA_ENV);
  await createEngine({ provider: createProvider(config, fetchImpl), config }).rewrite({ page: {}, items: [ITEM] });
  assert.equal(sent[0], Math.ceil(40 + 25 * 1 + 0.9 * ITEM.text.length), 'about 2x a normal ~0.5 tokens/char answer, not the hosted 400 + 1.1/char');
  assert.ok(sent[0] < 250);

  const hosted = loadConfig({ PROVIDER: 'openai-compat', MODEL: 'm', LLM_API_KEY: 'k', BASE_URL: 'http://x' });
  assert.deepEqual(hosted.tokenBudget, { base: 400, perItem: 0, perChar: 1.1 });
  assert.equal(hosted.retryTimeouts, true);
});

test('a repetition loop that hits the budget is retried once and the retry succeeds', async () => {
  const loop = ok('{"results":[{"id":0,"hinglish":"Load balancers ko bhi bhi bhi bhi bhi', { done_reason: 'length' });
  const fetchImpl = stub(loop, ok(answer(GOOD)));
  const config = { ...loadConfig(OLLAMA_ENV), retryBaseMs: 1 };
  const out = await createEngine({ provider: createProvider(config, fetchImpl), config }).rewrite({ page: {}, items: [ITEM] });
  assert.equal(fetchImpl.seen.length, 2);
  assert.equal(out.results[0].hinglish, GOOD);
  assert.equal(out.meta.retries, 1);
});

test('a timed-out local request is NOT retried (it would only queue behind the still-running generation)', async () => {
  const seen = [];
  const hang = (url, init) => new Promise((_, reject) => { seen.push(1); init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
  const config = { ...loadConfig(OLLAMA_ENV), requestTimeoutMs: 50, retries: 2, retryBaseMs: 1 };
  const out = await createEngine({ provider: createProvider(config, hang), config }).rewrite({ page: {}, items: [ITEM] });
  assert.equal(seen.length, 1);
  assert.equal(out.results[0].error.code, 'timeout');
});
