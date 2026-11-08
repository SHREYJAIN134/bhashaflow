import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../backend/src/config.js';
import { createProvider } from '../../backend/src/providers/index.js';
import { createOpenAICompatProvider } from '../../backend/src/providers/openai-compat.js';
import { createAnthropicProvider } from '../../backend/src/providers/anthropic.js';
import { createEngine } from '../../backend/src/engine.js';
import { createHandler } from '../../backend/src/handler.js';

const DUMMY_KEY = 'dummy-test-key-not-a-real-credential-0123456789';
const GEMINI_ENV = {
  PROVIDER: 'openai-compat',
  MODEL: 'gemini-3.6-flash',
  LLM_API_KEY: DUMMY_KEY,
  BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
  REASONING_EFFORT: 'none',
};
const ITEM = { id: 0, role: 'paragraph', text: 'The REST API returns 200 results in JSON format when the request is valid and complete.' };

/** fetch stub that records the request and replies with the given status/body. */
const stub = (status, body) => {
  const seen = [];
  const fn = async (url, init) => { seen.push({ url, init, body: JSON.parse(init.body) }); return { ok: status < 300, status, json: async () => body }; };
  fn.seen = seen;
  return fn;
};
const okBody = (content, finish = 'stop') => ({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 5 } });

// ---------------------------------------------------------------- configuration

test('config: Gemini settings load, reasoning effort validated, retries configurable including zero', () => {
  const c = loadConfig(GEMINI_ENV);
  assert.equal(c.provider, 'openai-compat');
  assert.equal(c.model, 'gemini-3.6-flash');
  assert.equal(c.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(c.reasoningEffort, 'none');
  assert.equal(c.apiKey, DUMMY_KEY);
  assert.equal(c.retries, 2, 'default unchanged');
  assert.equal(loadConfig({ ...GEMINI_ENV, RETRIES: '0' }).retries, 0);
  assert.equal(loadConfig({ ...GEMINI_ENV, RETRIES: '4' }).retries, 4);
  assert.equal(loadConfig({ ...GEMINI_ENV, RETRIES: 'abc' }).retries, 2);
  assert.equal(loadConfig({ ...GEMINI_ENV, REASONING_EFFORT: '' }).reasoningEffort, '');
  assert.equal(loadConfig({ ...GEMINI_ENV, REASONING_EFFORT: ' LOW ' }).reasoningEffort, 'low');
  assert.throws(() => loadConfig({ ...GEMINI_ENV, REASONING_EFFORT: 'maximum' }), /REASONING_EFFORT must be one of/);
});

test('config: GEMINI_API_KEY alone is accepted; LLM_API_KEY takes precedence when both are set', () => {
  const { LLM_API_KEY: _omit, ...withoutGeneric } = GEMINI_ENV;
  assert.equal(loadConfig({ ...withoutGeneric, GEMINI_API_KEY: 'gemini-specific-dummy' }).apiKey, 'gemini-specific-dummy');
  assert.equal(loadConfig({ ...withoutGeneric, LLM_API_KEY: '', GEMINI_API_KEY: 'gemini-specific-dummy' }).apiKey, 'gemini-specific-dummy');
  assert.equal(loadConfig({ ...GEMINI_ENV, GEMINI_API_KEY: 'gemini-specific-dummy' }).apiKey, DUMMY_KEY);
  assert.equal(loadConfig(withoutGeneric).apiKey, '', 'no key configured -> empty, never a default');
});

test('adapter request format for Gemini: endpoint, auth header, reasoning_effort, JSON mode, token param', async () => {
  const fetchImpl = stub(200, okBody('{"results":[]}'));
  const provider = createProvider(loadConfig(GEMINI_ENV), fetchImpl);
  assert.equal(provider.name, 'openai-compat');
  await provider.complete({ system: 'SYS', user: 'USR', maxTokens: 700 });

  const [req] = fetchImpl.seen;
  assert.equal(req.url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(req.init.method, 'POST');
  assert.equal(req.init.headers.authorization, `Bearer ${DUMMY_KEY}`);
  assert.deepEqual(req.body, {
    model: 'gemini-3.6-flash',
    messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USR' }],
    max_tokens: 700,
    temperature: 0.3,
    reasoning_effort: 'none',
    response_format: { type: 'json_object' },
  });
  assert.ok(!JSON.stringify(req.body).includes(DUMMY_KEY), 'key is only ever in the Authorization header');
});

test('reasoning_effort is omitted unless configured', async () => {
  const fetchImpl = stub(200, okBody('{}'));
  await createProvider(loadConfig({ ...GEMINI_ENV, REASONING_EFFORT: '' }), fetchImpl).complete({ system: '', user: '', maxTokens: 10 });
  assert.ok(!('reasoning_effort' in fetchImpl.seen[0].body));
});

// ---------------------------------------------------------------- empty / truncated responses

test('finish_reason=length is an explicit truncated error, with or without partial content', async () => {
  for (const content of ['', '{"results":[{"id":0,"hing']) {
    const p = createOpenAICompatProvider({ apiKey: DUMMY_KEY, model: 'm', baseUrl: 'http://x', fetchImpl: stub(200, okBody(content, 'length')) });
    await assert.rejects(p.complete({ system: '', user: '', maxTokens: 5 }), (e) => {
      assert.equal(e.code, 'truncated');
      assert.equal(e.retryable, false, 'retrying the same request would truncate again');
      return true;
    });
  }
  const a = createAnthropicProvider({ apiKey: DUMMY_KEY, model: 'm', fetchImpl: stub(200, { content: [{ type: 'text', text: '{"res' }], stop_reason: 'max_tokens', usage: {} }) });
  await assert.rejects(a.complete({ system: '', user: '', maxTokens: 5 }), (e) => e.code === 'truncated');
});

test('an empty reply with a normal finish is a retryable empty-response error', async () => {
  const p = createOpenAICompatProvider({ apiKey: DUMMY_KEY, model: 'm', baseUrl: 'http://x', fetchImpl: stub(200, okBody('   ', 'stop')) });
  await assert.rejects(p.complete({ system: '', user: '', maxTokens: 5 }), (e) => e.code === 'empty-response' && e.retryable === true);
  const none = createOpenAICompatProvider({ apiKey: DUMMY_KEY, model: 'm', baseUrl: 'http://x', fetchImpl: stub(200, { choices: [] }) });
  await assert.rejects(none.complete({ system: '', user: '', maxTokens: 5 }), (e) => e.code === 'empty-response');
});

test('engine + handler: truncation is not retried, items report the code, API answers 502 provider-truncated', async () => {
  const fetchImpl = stub(200, okBody('', 'length'));
  const config = { ...loadConfig(GEMINI_ENV), retries: 2, requestTimeoutMs: 500 };
  const provider = createProvider(config, fetchImpl);

  const out = await createEngine({ provider, config }).rewrite({ page: {}, items: [ITEM] });
  assert.equal(fetchImpl.seen.length, 1, 'no retries for a deterministic failure');
  assert.equal(out.fatal, 'truncated');
  assert.equal(out.results[0].error.code, 'truncated');

  const handle = createHandler({ engine: createEngine({ provider, config }), config });
  const res = await handle({ method: 'POST', path: '/v1/rewrite', headers: {}, ip: '1.1.1.1', body: { v: 1, items: [ITEM] } });
  assert.equal(res.status, 502);
  assert.equal(res.body.error.code, 'provider-truncated');
});

test('engine: an empty reply is retried and a later good reply succeeds; RETRIES=0 disables retrying', async () => {
  const good = okBody(JSON.stringify({ results: [{ id: 0, hinglish: 'REST API 200 results JSON format mein return karti hai jab request valid aur complete hoti hai.' }] }));
  const replies = [okBody(''), good];
  let calls = 0;
  const fetchImpl = async (url, init) => ({ ok: true, status: 200, json: async () => replies[Math.min(calls++, replies.length - 1)] });
  const base = loadConfig(GEMINI_ENV);

  const withRetry = { ...base, retries: 2, requestTimeoutMs: 1000 };
  const ok = await createEngine({ provider: createProvider(withRetry, fetchImpl), config: withRetry }).rewrite({ page: {}, items: [ITEM] });
  assert.equal(ok.results[0].error, undefined);
  assert.equal(ok.meta.retries, 1);

  calls = 0;
  const noRetry = { ...base, retries: 0, requestTimeoutMs: 1000 };
  const failed = await createEngine({ provider: createProvider(noRetry, fetchImpl), config: noRetry }).rewrite({ page: {}, items: [ITEM] });
  assert.equal(calls, 1);
  assert.equal(failed.results[0].error.code, 'empty-response');
});

// ---------------------------------------------------------------- the key never leaks

test('a provider error that echoes the key is redacted before it leaves the adapter', async () => {
  const p = createOpenAICompatProvider({ apiKey: DUMMY_KEY, model: 'm', baseUrl: 'http://x',
    fetchImpl: stub(400, { error: { message: `API key ${DUMMY_KEY} is malformed` } }) });
  await assert.rejects(p.complete({ system: '', user: '', maxTokens: 5 }), (e) => {
    assert.ok(!e.message.includes(DUMMY_KEY));
    assert.match(e.message, /redacted/);
    return true;
  });
});

test('the key is absent from API responses, even when the provider fails', async () => {
  const config = { ...loadConfig(GEMINI_ENV), retries: 0, requestTimeoutMs: 500 };
  const provider = createProvider(config, stub(401, { error: { message: `bad key ${DUMMY_KEY}` } }));
  const handle = createHandler({ engine: createEngine({ provider, config }), config });
  const res = await handle({ method: 'POST', path: '/v1/rewrite', headers: {}, ip: '1.1.1.1', body: { v: 1, items: [ITEM] } });
  assert.equal(res.status, 502);
  assert.ok(!JSON.stringify(res).includes(DUMMY_KEY));
  const health = await handle({ method: 'GET', path: '/health', headers: {} });
  assert.ok(!JSON.stringify(health).includes(DUMMY_KEY));
});

test('.env loading via --env-file works and a child process never prints the key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bf-env-'));
  try {
    const envFile = join(dir, '.env');
    writeFileSync(envFile, Object.entries(GEMINI_ENV).map(([k, v]) => `${k}=${v}`).join('\n'));
    const script = `import('${new URL('../../backend/src/config.js', import.meta.url).href}').then(({ loadConfig }) => {
      const c = loadConfig(); console.log(JSON.stringify({ provider: c.provider, model: c.model, effort: c.reasoningEffort, keyLoaded: Boolean(c.apiKey), keyLength: c.apiKey.length }));
    })`;
    const out = execFileSync(process.execPath, [`--env-file=${envFile}`, '-e', script], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(out), { provider: 'openai-compat', model: 'gemini-3.6-flash', effort: 'none', keyLoaded: true, keyLength: DUMMY_KEY.length });
    assert.ok(!out.includes(DUMMY_KEY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the real .env (if present) is configured for Claude, Ollama or Gemini; its key is never read into test output', () => {
  if (!existsSync('.env')) return; // fresh clone: nothing to check
  const script = `import('${new URL('../../backend/src/config.js', import.meta.url).href}').then(({ loadConfig }) => {
    const c = loadConfig(); console.log(JSON.stringify({ provider: c.provider, model: c.model, baseUrl: c.baseUrl, effort: c.reasoningEffort, retries: c.retries, ollamaBaseUrl: c.ollamaBaseUrl, keyLoaded: Boolean(c.apiKey) }));
  })`;
  const info = JSON.parse(execFileSync(process.execPath, ['--env-file=.env', '-e', script], { encoding: 'utf8' }));
  if (info.provider === 'anthropic') {
    assert.equal(info.model, 'claude-haiku-5-5');
    return; // keyLoaded depends on whether ANTHROPIC_API_KEY has been filled in: deliberately not asserted
  }
  if (info.provider === 'ollama') {
    assert.equal(info.model, 'qwen3:4b');
    assert.equal(info.ollamaBaseUrl, 'http://127.0.0.1:11434');
    assert.equal(info.keyLoaded, false, 'no cloud key is loaded while Ollama is selected');
    return;
  }
  assert.equal(info.provider, 'openai-compat');
  assert.equal(info.model, 'gemini-3.6-flash');
  assert.equal(info.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(info.effort, 'none');
  assert.equal(info.retries, 2, 'retries left at the default');
});

// ---------------------------------------------------------------- git ignore + committed files

test('.gitignore: every .env variant is ignored, .env.example is not (checked with real git)', (t) => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { return t.skip('git not available'); }
  const dir = mkdtempSync(join(tmpdir(), 'bf-git-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    copyFileSync('.gitignore', join(dir, '.gitignore'));
    mkdirSync(join(dir, 'benchmark', 'results'), { recursive: true });
    mkdirSync(join(dir, 'extension', 'dist'), { recursive: true });
    const ignored = (file) => {
      try { execFileSync('git', ['check-ignore', '-q', file], { cwd: dir }); return true; } catch (e) { if (e.status === 1) return false; throw e; }
    };
    for (const f of ['.env', '.env.local', '.env.production', '.env.development.local', '.env.secret', 'benchmark/results/run.json', 'extension/dist/content.js']) {
      assert.equal(ignored(f), true, `${f} must be ignored`);
    }
    assert.equal(ignored('.env.example'), false, '.env.example must stay tracked');
    assert.equal(ignored('README.md'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('.env.example is placeholders only', () => {
  const lines = readFileSync('.env.example', 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const vars = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.equal(vars.LLM_API_KEY, '');
  assert.equal(vars.PROVIDER, 'mock');
  assert.equal(vars.MODEL, '');
  assert.equal(vars.BASE_URL, '');
  for (const [k, v] of Object.entries(vars)) assert.ok(v.length < 30, `${k} looks like it holds a real value`);
});

test('no credential-shaped strings anywhere in the project except the git-ignored .env', () => {
  const patterns = [/AIza[0-9A-Za-z_-]{30,}/, /\bAQ\.[A-Za-z0-9_-]{20,}/, /\bsk-[A-Za-z0-9_-]{20,}/, /gsk_[A-Za-z0-9]{20,}/];
  const skip = new Set(['node_modules', '.git', 'results', '.env']);
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) { walk(p); continue; }
      if (s.size > 3_000_000) continue;
      const text = readFileSync(p, 'utf8');
      if (patterns.some((re) => re.test(text))) found.push(p);
    }
  };
  walk('.');
  assert.deepEqual(found, []);
});
