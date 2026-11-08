import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { loadConfig } from '../../backend/src/config.js';
import { createProvider } from '../../backend/src/providers/index.js';
import { createAnthropicProvider, isCurrentGeneration, ANTHROPIC_DEFAULT_MODEL } from '../../backend/src/providers/anthropic.js';
import { createEngine } from '../../backend/src/engine.js';
import { createHandler } from '../../backend/src/handler.js';
import { getPrompt, getSelectionPrompt } from '../../backend/src/prompts/index.js';
import { SYSTEM_PROMPT_V2_SELECTION } from '../../backend/src/prompts/v2-selection.js';
import { SYSTEM_PROMPT_V2 } from '../../backend/src/prompts/v2.js';
import { validateItem } from '../../backend/src/validate.js';
import { sourceFromTemplate } from '../../extension/src/shared/tokens.js';
import { cacheKey } from '../../extension/src/background/translation-cache.js';
import { translatePlan, planSelection } from '../../extension/src/selection/selection-core.js';
import { runLive, PASSAGES, estimateCostUsd, PRICE_PER_MTOK } from '../../scripts/claude-live.js';

const KEY = 'test-anthropic-key-not-real-0123456789';
const GEMINI = 'dummy-gemini-key-not-real-9876543210';
const ENV = { PROVIDER: 'anthropic', MODEL: 'claude-haiku-5-5', ANTHROPIC_API_KEY: KEY };

const messageReply = (text, extra = {}) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 812, output_tokens: 96 }, ...extra });
function stub(...replies) {
  const seen = [];
  const fn = async (url, init) => {
    seen.push({ url: String(url), init, body: init && init.body ? JSON.parse(init.body) : undefined });
    const r = replies[Math.min(seen.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    return { ok: r.status < 300, status: r.status, headers: { get: (h) => (r.headers || {})[h.toLowerCase()] ?? null }, json: async () => r.body };
  };
  fn.seen = seen;
  return fn;
}
const ok = (text, extra) => ({ status: 200, body: messageReply(text, extra) });
const ITEM = { id: 0, role: 'paragraph', text: 'The REST API returns 200 results in JSON format when the request is valid and complete.' };
const GOOD = 'REST API 200 results JSON format mein return karti hai jab request valid aur complete hoti hai.';
const answer = (h) => JSON.stringify({ results: [{ id: 0, hinglish: h }] });
const call = (p) => p.complete({ system: 'SYS', user: 'USR', maxTokens: 300 });

// ---------------------------------------------------------------- configuration and keys

test('config: PROVIDER=anthropic reads ONLY ANTHROPIC_API_KEY; a Gemini key in LLM_API_KEY is never used for Claude', () => {
  const c = loadConfig({ ...ENV, LLM_API_KEY: GEMINI, GEMINI_API_KEY: GEMINI, BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai', REASONING_EFFORT: 'none' });
  assert.equal(c.provider, 'anthropic');
  assert.equal(c.apiKey, KEY);
  assert.equal(c.model, 'claude-haiku-5-5');
  assert.equal(c.promptVersion, 'hinglish-v2');
  assert.ok(!JSON.stringify(c).includes(GEMINI), 'the Gemini key is not even loaded');

  const noClaudeKey = loadConfig({ PROVIDER: 'anthropic', LLM_API_KEY: GEMINI });
  assert.equal(noClaudeKey.apiKey, '', 'with no ANTHROPIC_API_KEY the key is empty, never the other provider\'s');
  assert.throws(() => createProvider(noClaudeKey), /ANTHROPIC_API_KEY/);
  assert.equal(loadConfig({ PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY }).model, ANTHROPIC_DEFAULT_MODEL, 'MODEL defaults to the low-cost Haiku');
  assert.equal(ANTHROPIC_DEFAULT_MODEL, 'claude-haiku-5-5');
});

test('config: other providers keep their own behaviour (Gemini key, Ollama), selected by PROVIDER only', () => {
  const g = loadConfig({ PROVIDER: 'openai-compat', MODEL: 'gemini-3.6-flash', LLM_API_KEY: GEMINI, ANTHROPIC_API_KEY: KEY, BASE_URL: 'https://g.example/openai' });
  assert.equal(g.apiKey, GEMINI, 'Gemini still uses LLM_API_KEY');
  assert.equal(createProvider(g, stub()).name, 'openai-compat');
  const o = loadConfig({ PROVIDER: 'ollama', ANTHROPIC_API_KEY: KEY, LLM_API_KEY: GEMINI });
  assert.equal(o.apiKey, '');
  assert.equal(createProvider(o, stub()).name, 'ollama');
  assert.equal(createProvider(loadConfig(ENV), stub()).name, 'anthropic');
});

test('config: thinking and effort overrides are validated at startup with a clear message', () => {
  assert.throws(() => createProvider(loadConfig({ ...ENV, ANTHROPIC_THINKING: 'always' })), /ANTHROPIC_THINKING must be one of/);
  assert.throws(() => createProvider(loadConfig({ ...ENV, ANTHROPIC_EFFORT: 'max' })), /ANTHROPIC_EFFORT must be one of/);
  assert.equal(createProvider(loadConfig({ ...ENV, ANTHROPIC_THINKING: ' Adaptive ', ANTHROPIC_EFFORT: 'MEDIUM' }), stub()).name, 'anthropic');
});

// ---------------------------------------------------------------- request / response handling

test('request: Claude Haiku 5.5 gets the documented shape: key in a header only, thinking off, low effort, cacheable system, no temperature', async () => {
  const fetchImpl = stub(ok('{"results":[]}'));
  const p = createProvider(loadConfig({ ...ENV, TEMPERATURE: '0.9' }), fetchImpl);
  const out = await call(p);
  const [req] = fetchImpl.seen;
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.init.method, 'POST');
  assert.equal(req.init.headers['x-api-key'], KEY);
  assert.equal(req.init.headers['anthropic-version'], '2023-06-01');
  assert.ok(!('authorization' in req.init.headers));
  assert.deepEqual(req.body, {
    model: 'claude-haiku-5-5',
    max_tokens: 300,
    system: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'USR' }],
    thinking: { type: 'disabled' },
    output_config: { effort: 'low' },
  });
  assert.ok(!('temperature' in req.body), 'Claude 5 models reject a non-default temperature');
  assert.ok(!JSON.stringify(req.body).includes(KEY), 'the key never appears in the body');
  assert.deepEqual(out, { text: '{"results":[]}', usage: { inputTokens: 812, outputTokens: 96 } });
});

test('request: overrides apply, an unknown/older model id keeps the plain shape with temperature', async () => {
  const a = stub(ok('{}'));
  await call(createProvider(loadConfig({ ...ENV, ANTHROPIC_THINKING: 'adaptive', ANTHROPIC_EFFORT: 'medium' }), a));
  assert.deepEqual(a.seen[0].body.thinking, { type: 'adaptive' });
  assert.deepEqual(a.seen[0].body.output_config, { effort: 'medium' });
  const old = stub(ok('{}'));
  await call(createAnthropicProvider({ apiKey: KEY, model: 'claude-3-old', temperature: 0.2, fetchImpl: old }));
  assert.deepEqual(old.seen[0].body, { model: 'claude-3-old', max_tokens: 300, temperature: 0.2, system: 'SYS', messages: [{ role: 'user', content: 'USR' }] });
  assert.equal(isCurrentGeneration('claude-haiku-5-5'), true);
  assert.equal(isCurrentGeneration('claude-sonnet-5-5'), true);
  assert.equal(isCurrentGeneration('claude-haiku-4-5'), false);
});

test('response: usage incl. cache tokens, truncation, refusal and empty answers are explicit', async () => {
  const withCache = stub(ok('{}', { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 700, cache_creation_input_tokens: 0 } }));
  assert.deepEqual((await call(createProvider(loadConfig(ENV), withCache))).usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 700 });
  await assert.rejects(call(createProvider(loadConfig(ENV), stub(ok('{"res', { stop_reason: 'max_tokens' })))), (e) => e.code === 'truncated' && e.retryable === false);
  await assert.rejects(call(createProvider(loadConfig(ENV), stub(ok('', { stop_reason: 'refusal', content: [] })))), (e) => e.code === 'refused' && e.retryable === false);
  await assert.rejects(call(createProvider(loadConfig(ENV), stub(ok('   ')))), (e) => e.code === 'empty-response' && e.retryable === true);
  const blocks = stub({ status: 200, body: messageReply('', { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] }) });
  assert.equal((await call(createProvider(loadConfig(ENV), blocks))).text, '{"a":1}', 'only text blocks, joined');
});

// ---------------------------------------------------------------- errors are understandable and never leak the key

const anthropicError = (status, type, message, headers) => ({ status, headers, body: { type: 'error', error: { type, message } } });

test('provider errors: typed, retry flags right, key redacted even if the API echoes it', async () => {
  const expectErr = async (reply, code, retryable) => {
    await assert.rejects(call(createProvider(loadConfig(ENV), stub(reply))), (e) => {
      assert.equal(e.code, code);
      assert.equal(e.retryable, retryable);
      assert.ok(!e.message.includes(KEY), 'no key in the message');
      return true;
    });
  };
  await expectErr(anthropicError(401, 'authentication_error', `invalid x-api-key ${KEY}`), 'auth', false);
  await expectErr(anthropicError(429, 'rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit', { 'retry-after': '3' }), 'rate-limit', true);
  await expectErr(anthropicError(529, 'overloaded_error', 'Overloaded'), 'unavailable', true);
  await expectErr(anthropicError(500, 'api_error', 'Internal server error'), 'unavailable', true);
  await expectErr(anthropicError(400, 'invalid_request_error', `Your credit balance is too low to access the Anthropic API. ${KEY}`), 'no-credit', false);
  await expectErr(anthropicError(404, 'not_found_error', 'model: claude-nope'), 'model-not-found', false);
  await expectErr(anthropicError(400, 'invalid_request_error', `temperature: not supported ${KEY}`), 'invalid-settings', false);
  await assert.rejects(call(createProvider(loadConfig(ENV), stub(new TypeError('fetch failed')))), (e) => e.code === 'network' && e.retryable === true && /Anthropic API/.test(e.message));
});

async function viaHandler(reply, env = ENV, body = { v: 1, items: [ITEM] }) {
  const config = { ...loadConfig(env), retries: 0, requestTimeoutMs: 500 };
  const handle = createHandler({ engine: createEngine({ provider: createProvider(config, stub(reply)), config }), config });
  return handle({ method: 'POST', path: '/v1/rewrite', headers: {}, ip: '1.1.1.1', body });
}

test('what the user sees: wrong key, no credit, wrong model id and overload each give an actionable message without the key', async () => {
  const auth = await viaHandler(anthropicError(401, 'authentication_error', `invalid x-api-key ${KEY}`));
  assert.equal(auth.status, 502);
  assert.equal(auth.body.error.code, 'provider-auth');
  assert.match(auth.body.error.message, /ANTHROPIC_API_KEY/);

  const credit = await viaHandler(anthropicError(400, 'invalid_request_error', `Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing. ${KEY}`));
  assert.equal(credit.status, 503);
  assert.equal(credit.body.error.code, 'provider-no-credit');
  assert.match(credit.body.error.message, /no usable credit.*Anthropic console/);
  assert.ok(!credit.body.error.message.includes('Please go to'), 'our own wording, not the provider text');

  const model = await viaHandler(anthropicError(404, 'not_found_error', 'model: claude-haiku-9-9'), { ...ENV, MODEL: 'claude-haiku-9-9' });
  assert.equal(model.body.error.code, 'provider-model-not-found');
  assert.match(model.body.error.message, /"claude-haiku-9-9".*MODEL/);
  const settings = await viaHandler(anthropicError(400, 'invalid_request_error', 'Confidential quarterly numbers echoed by a provider'));
  assert.equal(settings.body.error.code, 'provider-invalid-settings');
  assert.ok(!JSON.stringify(settings).includes('Confidential'), 'provider text is never passed on');

  const overloaded = await viaHandler(anthropicError(529, 'overloaded_error', 'Overloaded'));
  assert.equal(overloaded.body.error.code, 'provider-unavailable');

  for (const r of [auth, credit, model, settings, overloaded]) assert.ok(!JSON.stringify(r).includes(KEY), 'the key is in no response');
  const health = await createHandler({ engine: createEngine({ provider: createProvider(loadConfig(ENV), stub()), config: loadConfig(ENV) }), config: loadConfig(ENV) })({ method: 'GET', path: '/health', headers: {} });
  assert.deepEqual(health.body, { ok: true, provider: 'anthropic', model: 'claude-haiku-5-5', promptVersion: 'hinglish-v2' });
});

// ---------------------------------------------------------------- privacy: only api.anthropic.com, only the Claude key

test('selecting Claude sends page text only to api.anthropic.com, with only the Anthropic key, even with other keys around', async () => {
  const env = { ...ENV, LLM_API_KEY: GEMINI, GEMINI_API_KEY: GEMINI, OPENAI_API_KEY: 'o', BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai', OLLAMA_BASE_URL: 'http://127.0.0.1:11434' };
  for (const fetchImpl of [stub(ok(answer(GOOD))), stub(anthropicError(500, 'api_error', 'x')), stub(new TypeError('fetch failed'))]) {
    const config = { ...loadConfig(env), retries: 1, retryBaseMs: 1 };
    await createEngine({ provider: createProvider(config, fetchImpl), config }).rewrite({ page: { title: 'T' }, items: [ITEM] });
    for (const r of fetchImpl.seen) {
      assert.equal(new URL(r.url).origin, 'https://api.anthropic.com');
      assert.equal(r.init.headers['x-api-key'], KEY);
      assert.ok(!JSON.stringify(r).includes(GEMINI));
    }
  }
});

// ---------------------------------------------------------------- Hinglish behaviour

test('end to end: a valid Claude answer is accepted, meta names provider, model, prompt version and token usage', async () => {
  const config = loadConfig(ENV);
  const out = await createEngine({ provider: createProvider(config, stub(ok(answer(GOOD)))), config }).rewrite({ page: {}, items: [ITEM] });
  assert.equal(out.results[0].hinglish, GOOD);
  assert.equal(out.meta.provider, 'anthropic');
  assert.equal(out.meta.model, 'claude-haiku-5-5');
  assert.equal(out.meta.promptVersion, 'hinglish-v2');
  assert.equal(out.meta.inputTokens, 812);
  assert.equal(out.meta.outputTokens, 96);
});

test('full-page text keeps the full hinglish-v2 prompt; selected text (role "selection") gets the compact variant', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body).system[0].text); return { ok: true, status: 200, headers: { get: () => null }, json: async () => messageReply(answer(GOOD)) }; };
  const config = loadConfig(ENV);
  const engine = createEngine({ provider: createProvider(config, fetchImpl), config });
  await engine.rewrite({ page: {}, items: [ITEM] });
  await engine.rewrite({ page: {}, items: [{ ...ITEM, role: 'selection' }] });
  await engine.rewrite({ page: {}, items: [{ ...ITEM, id: 0, role: 'selection' }, { ...ITEM, id: 1, role: 'paragraph' }].slice(0, 1).concat([{ ...ITEM, id: 1, role: 'paragraph', text: 'Another paragraph of ordinary page text goes here today.' }]) });
  assert.equal(sent[0], getPrompt('hinglish-v2').system);
  assert.equal(sent[0], SYSTEM_PROMPT_V2, 'hinglish-v2 itself is unchanged');
  assert.equal(sent[1], SYSTEM_PROMPT_V2_SELECTION);
  assert.equal(sent[2], SYSTEM_PROMPT_V2, 'a mixed request uses the full prompt');
});

test('the selection prompt keeps every hinglish-v2 requirement and is concise', () => {
  const s = SYSTEM_PROMPT_V2_SELECTION;
  assert.ok(s.length < SYSTEM_PROMPT_V2.length * 0.5, `${s.length} vs ${SYSTEM_PROMPT_V2.length}`);
  for (const must of ['Roman script only', 'Devanagari', 'technical terms', 'URLs', 'numbers', 'Add nothing and drop nothing', 'informal imperatives', 'gender', '{"results":[{"id":<id>,"hinglish":"<rewritten text>"}]}', '"fix" field', 'Exactly one result per input item']) {
    assert.ok(s.includes(must), `selection prompt lost: ${must}`);
  }
  assert.equal(getSelectionPrompt('hinglish-v1').system, getPrompt('hinglish-v1').system, 'other versions have no variant');
  assert.equal(getSelectionPrompt().system, s);
});

test('requests: role "selection" is accepted, unknown roles are still rejected, and selections cache apart from page text', async () => {
  const ok1 = await viaHandler(ok(answer(GOOD)), ENV, { v: 1, items: [{ ...ITEM, role: 'selection' }] });
  assert.equal(ok1.status, 200);
  assert.equal((await viaHandler(ok(answer(GOOD)), ENV, { v: 1, items: [{ ...ITEM, role: 'wizard' }] })).status, 400);
  const base = { promptVersion: 'hinglish-v2', model: 'claude-haiku-5-5', title: '', text: ITEM.text, heading: '' };
  assert.notEqual(await cacheKey({ ...base, role: 'selection' }), await cacheKey({ ...base, role: 'paragraph' }));
});

test('the extension asks for the selection role (so the compact prompt is used)', async () => {
  const roles = [];
  const converter = { convert: async (items) => { roles.push(...items.map((i) => i.context.role)); return items.map((i) => ({ id: i.id, hinglish: 'x' })); } };
  await translatePlan(planSelection('Select this sentence please.'), { converter });
  assert.deepEqual(roles, ['selection']);
});

test('validation does not reject valid Hinglish for short text or a legitimate leading word, but still catches real problems', () => {
  const v = (text, out) => validateItem({ id: 0, text, source: sourceFromTemplate(text) }, out);
  assert.equal(v('Yes', 'Haan, bilkul').ok, true, 'short answers may be longer');
  assert.equal(v('Done', 'Ho gaya').ok, true);
  assert.equal(v('Hello', 'Namaste').ok, true);
  assert.equal(v('Sure thing, I will send the file today.', 'Sure, main file aaj bhej dunga.').ok, true, 'source starts with "Sure"');
  assert.equal(v('Here is the list of items we need.', 'Here hai items ki list jo humein chahiye.').ok, true);
  assert.equal(v('The server restarts every night.', 'Sure! Server har raat restart hota hai.').ok, false, 'commentary is still rejected');
  assert.equal(v('The server restarts every night.', 'Server har raat restart hota hai. यह सच है').ok, false, 'Devanagari is still rejected');
  assert.equal(v('The server restarts every night at 2 AM.', 'Server har raat restart hota hai.').ok, false, 'a dropped number is still rejected');
  assert.equal(v('A long sentence with enough words to count properly here.', 'x').ok, false, 'a long source cannot become one letter');
});

// ---------------------------------------------------------------- the one-time live command (offline: only mocked fetch)

function capture() { const lines = []; return { write: (s) => lines.push(s), text: () => lines.join('') }; }
const liveOk = () => {
  const results = PASSAGES.map((p, id) => ({ id, hinglish: `Hinglish ${id}: ${p}` })); // keeps acronyms and numbers, so it passes the real validator
  return stub({ status: 200, body: messageReply(JSON.stringify({ results }), { usage: { input_tokens: 1000, output_tokens: 300 } }) });
};

test('claude-live refuses without --confirm-live, and without a key: no request, exit code 2', async () => {
  for (const [argv, env, why] of [[[], { ANTHROPIC_API_KEY: KEY }, 'no flag'], [['--confirm-live'], {}, 'no key'], [['--confirm-live'], { ANTHROPIC_API_KEY: '   ' }, 'blank key'], [['--confirm-live'], { ANTHROPIC_API_KEY: KEY, PROVIDER: 'anthropic', MODEL: 'gpt-x' }, 'not a Claude model']]) {
    const f = stub(ok('{}'));
    const out = capture();
    assert.equal(await runLive({ argv, env, fetchImpl: f, write: out.write }), 2, why);
    assert.equal(f.seen.length, 0, `${why}: nothing was sent`);
    assert.ok(!out.text().includes(KEY));
  }
});

test('claude-live --dry-run shows the plan and sends nothing, even with a key and the flag', async () => {
  const f = stub(ok('{}'));
  const out = capture();
  assert.equal(await runLive({ argv: ['--dry-run', '--confirm-live'], env: { ANTHROPIC_API_KEY: KEY }, fetchImpl: f, write: out.write }), 0);
  assert.equal(f.seen.length, 0);
  assert.match(out.text(), /DRY RUN/);
  for (const p of PASSAGES) assert.ok(out.text().includes(p));
});

test('claude-live with --confirm-live: exactly ONE request carrying all five passages, no retries, full report', async () => {
  const f = liveOk();
  const out = capture();
  const code = await runLive({ argv: ['--confirm-live'], env: { ANTHROPIC_API_KEY: KEY, PROVIDER: 'ollama', MODEL: 'qwen3:4b', LLM_API_KEY: GEMINI }, fetchImpl: f, write: out.write });
  assert.equal(code, 0, out.text());
  assert.equal(f.seen.length, 1, 'exactly one API request');
  const body = f.seen[0].body;
  assert.equal(body.model, 'claude-haiku-5-5', 'an Ollama MODEL in .env is not used for Claude');
  assert.equal(f.seen[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(f.seen[0].init.headers['x-api-key'], KEY, 'only the Anthropic key');
  const sent = JSON.parse(body.messages[0].content);
  assert.deepEqual(sent.items.map((i) => i.text), PASSAGES);
  assert.ok(sent.items.every((i) => i.role === 'selection'));
  assert.equal(body.system[0].text, SYSTEM_PROMPT_V2_SELECTION);

  const text = out.text();
  for (const p of PASSAGES) assert.ok(text.includes(p), 'original reported');
  assert.match(text, /Hinglish 1: /);
  assert.match(text, /Total API latency\s*: \d+ ms/);
  assert.match(text, /Input tokens\s*: 1000/);
  assert.match(text, /Output tokens\s*: 300/);
  assert.match(text, /Estimated cost\s*: \$0\.000250 USD/, '1000 x $0.10 + 300 x $0.50 per million');
  assert.match(text, /Requests made\s*: 1/);
  assert.ok(!text.includes(KEY) && !text.includes(GEMINI), 'no key in the output');
});

test('claude-live cost estimate: input, output and cache tokens priced from the Haiku 5.5 list price', () => {
  assert.equal(PRICE_PER_MTOK.input, 0.1);
  assert.equal(PRICE_PER_MTOK.output, 0.5);
  assert.ok(Math.abs(estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }) - 0.6) < 1e-9);
  assert.ok(Math.abs(estimateCostUsd({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000, cacheReadTokens: 1_000_000 }) - (0.125 + 0.01)) < 1e-9);
});

test('claude-live failure and rejection paths: one request, no retry, no repair, clear report, exit 1', async () => {
  const unauthorized = stub(anthropicError(401, 'authentication_error', `invalid x-api-key ${KEY}`));
  let out = capture();
  assert.equal(await runLive({ argv: ['--confirm-live'], env: { ANTHROPIC_API_KEY: KEY }, fetchImpl: unauthorized, write: out.write }), 1);
  assert.equal(unauthorized.seen.length, 1);
  assert.match(out.text(), /FAILED/);
  assert.match(out.text(), /auth/);
  assert.ok(!out.text().includes(KEY));

  const overloaded = stub(anthropicError(529, 'overloaded_error', 'Overloaded'));
  out = capture();
  assert.equal(await runLive({ argv: ['--confirm-live'], env: { ANTHROPIC_API_KEY: KEY }, fetchImpl: overloaded, write: out.write }), 1);
  assert.equal(overloaded.seen.length, 1, 'a retryable error is NOT retried');

  const bad = stub(ok(JSON.stringify({ results: PASSAGES.map((p, id) => ({ id, hinglish: id === 1 ? 'यह हिंदी है' : `ok ${p}` })) })));
  out = capture();
  assert.equal(await runLive({ argv: ['--confirm-live'], env: { ANTHROPIC_API_KEY: KEY }, fetchImpl: bad, write: out.write }), 1);
  assert.equal(bad.seen.length, 1, 'a rejected answer is reported, not re-requested');
  assert.match(out.text(), /REJECTED \(contains Devanagari/);
  assert.match(out.text(), /no repair request was sent/);

  const junk = stub(ok('this is not json'));
  out = capture();
  assert.equal(await runLive({ argv: ['--confirm-live'], env: { ANTHROPIC_API_KEY: KEY }, fetchImpl: junk, write: out.write }), 1);
  assert.equal(junk.seen.length, 1);
  assert.match(out.text(), /could not be parsed/);
});

test('the live command is not part of npm test and is wired as a separate script', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.match(pkg.scripts['test:claude-live'], /scripts\/claude-live\.js/);
  assert.ok(!/claude-live|scripts\//.test(pkg.scripts.test), 'npm test cannot reach the live script');
});

// ---------------------------------------------------------------- configuration files

test('.env.example has an empty ANTHROPIC_API_KEY placeholder and no real credential', () => {
  const lines = readFileSync('.env.example', 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const vars = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.equal(vars.ANTHROPIC_API_KEY, '');
  assert.equal(vars.LLM_API_KEY, '');
  assert.match(readFileSync('.env.example', 'utf8'), /claude-haiku-5-5/);
});

test('the Anthropic key never reaches the extension sources or build, and .env stays git-ignored', () => {
  const ignore = readFileSync('.gitignore', 'utf8');
  assert.match(ignore, /^\.env$/m);
  for (const f of ['extension/dist/content.js', 'extension/dist/selection.js', 'extension/dist/service-worker.js', 'extension/dist/popup.js', 'extension/dist/manifest.json']) {
    const code = readFileSync(f, 'utf8');
    assert.ok(!/ANTHROPIC_API_KEY|x-api-key|api\.anthropic\.com|sk-ant-/.test(code), `${f} contains Anthropic credential material`);
  }
});

// ---------------------------------------------------------------- the backend really reads ANTHROPIC_API_KEY from .env

test('a .env file with PROVIDER=anthropic and ANTHROPIC_API_KEY is loaded by the backend config (child process, key never printed)', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'bf-claude-env-'));
  try {
    const file = join(dir, '.env');
    writeFileSync(file, ['PROVIDER=anthropic', 'MODEL=claude-haiku-5-5', `ANTHROPIC_API_KEY=${KEY}`, `LLM_API_KEY=${GEMINI}`, 'BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai'].join('\n'));
    const url = new URL('../../backend/src/config.js', import.meta.url).href;
    const script = `import('${url}').then(({ loadConfig }) => { const c = loadConfig(); console.log(JSON.stringify({ provider: c.provider, model: c.model, keyLength: c.apiKey.length, usesGeminiKey: c.apiKey.startsWith('dummy-gemini') })); })`;
    const out = execFileSync(process.execPath, [`--env-file=${file}`, '-e', script], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), { provider: 'anthropic', model: 'claude-haiku-5-5', keyLength: KEY.length, usesGeminiKey: false });
    assert.ok(!out.includes(KEY) && !out.includes(GEMINI));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the project .env (if present): Claude selected, ANTHROPIC_API_KEY line present, no Gemini-shaped key left, no fallback settings', () => {
  if (!existsSync('.env')) return;
  const env = readFileSync('.env', 'utf8');
  const vars = Object.fromEntries(env.split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.equal(vars.PROVIDER, 'anthropic');
  assert.equal(vars.MODEL, 'claude-haiku-5-5');
  assert.ok('ANTHROPIC_API_KEY' in vars, 'the key line exists (its value is yours to paste)');
  assert.ok(!/^AIza|^AQ[.]/.test(vars.LLM_API_KEY || ''), 'the previously exposed Gemini key is gone');
  assert.ok(!vars.LLM_API_KEY, 'and nothing replaced it (absent or empty)');
  assert.ok(!Object.keys(vars).some((k) => /FALLBACK/i.test(k)), 'there is no fallback provider setting');
});

// ---------------------------------------------------------------- selected text: several requests run together for a hosted model

test('a long selection needing several requests runs them together for Claude, in order, and one at a time when told to', async () => {
  const lines = Array.from({ length: 6 }, (_, i) => `Line number ${i} explains one idea clearly ${'x'.repeat(5)}.`);
  const plan = planSelection(lines.join('\n'));
  const limits = { maxItems: 2, maxChars: 1800, maxItemChars: 3900 };
  const run = async (concurrency) => {
    let inflight = 0;
    let peak = 0;
    const converter = { convert: async (items) => {
      inflight++; peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 20 - items[0].id));
      inflight--;
      return items.map((i) => ({ id: i.id, hinglish: 'HI ' + i.text }));
    } };
    const out = await translatePlan(plan, { converter, limits, concurrency });
    return { peak, text: out.text };
  };
  const together = await run(3);
  const one = await run(1);
  assert.equal(together.peak, 3);
  assert.equal(one.peak, 1);
  assert.equal(together.text, one.text, 'same result, same order');
  assert.equal(together.text.split('\n').length, 6);
});

test('with concurrency, one failed request is reported once and no new request starts after it', async () => {
  const plan = planSelection(Array.from({ length: 6 }, (_, i) => `Another line ${i} that needs translating today.`).join('\n'));
  let calls = 0;
  const converter = { convert: async (items) => { calls++; if (calls === 1) throw Object.assign(new Error('x'), { code: 'provider-timeout' }); return items.map((i) => ({ id: i.id, hinglish: 'HI ' + i.text })); } };
  await assert.rejects(translatePlan(plan, { converter, limits: { maxItems: 1, maxChars: 1800, maxItemChars: 3900 }, concurrency: 2 }), (e) => e.code === 'provider-timeout');
  assert.ok(calls <= 3, 'stopped scheduling after the failure (' + calls + ' requests)');
});
