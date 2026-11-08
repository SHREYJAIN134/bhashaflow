import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync, crc32 } from 'node:zlib';
import { JSDOM } from 'jsdom';
import { createApp } from '../../backend/src/server.js';
import { loadConfig } from '../../backend/src/config.js';
import { createMockProvider } from '../../backend/src/providers/mock.js';
import { createOpenAICompatProvider } from '../../backend/src/providers/openai-compat.js';
import { createController } from '../../extension/src/content/controller.js';
import { createObserver } from '../../extension/src/content/observer.js';
import { DEFAULT_SETTINGS } from '../../extension/src/shared/settings.js';
import { makeIconPng, ICON_SIZES } from '../../scripts/make-icons.js';

const walk = (dir, skip = new Set(['node_modules', '.git'])) => readdirSync(dir).flatMap((f) => {
  if (skip.has(f)) return [];
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p, skip) : [p];
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A clean production build is part of the contract: validate what `npm run build` actually produces.
execFileSync(process.execPath, ['scripts/build.js'], { stdio: 'pipe' });
const dist = (f) => join('extension/dist', f);
const manifest = JSON.parse(readFileSync(dist('manifest.json'), 'utf8'));

// ================================================================ manifest and build output

test('manifest: Manifest V3, minimal permissions, one backend host, and exactly one inert content script (Selection Mode)', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'BhashaFlow');
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['http://localhost:8787/*'], 'only the local backend, never page access');
  for (const forbidden of ['web_accessible_resources', 'externally_connectable', 'optional_host_permissions', 'declarative_net_request', 'commands', 'omnibox', 'devtools_page', 'chrome_url_overrides']) {
    assert.equal(manifest[forbidden], undefined, forbidden);
  }
  // Selection Mode needs a button next to selected text on any page, which only a content script can provide (activeTab
  // alone cannot run before a click). It is the ONLY page access: http(s) top frames, one small script, no <all_urls>.
  assert.deepEqual(manifest.content_scripts, [{ matches: ['http://*/*', 'https://*/*'], js: ['selection.js'], run_at: 'document_idle', all_frames: false }]);
  const text = JSON.stringify(manifest);
  assert.ok(!/<all_urls>|\*:\/\/|"\*"|webRequest|tabs"|history|cookies|downloads|nativeMessaging|identity/.test(text), 'no broad or sensitive permission');
  assert.equal(manifest.background.type, undefined, 'classic service worker (bundled), not a module');
});

test('manifest: every referenced file exists in the build and is well formed', () => {
  const referenced = [manifest.action.default_popup, manifest.background.service_worker, ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
  for (const f of referenced) assert.ok(existsSync(dist(f)), `${f} missing from extension/dist`);
  const popup = readFileSync(dist('popup.html'), 'utf8');
  for (const asset of [...popup.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])) assert.ok(existsSync(dist(asset)), `popup.html references missing ${asset}`);
  assert.ok(existsSync(dist('content.js')), 'whole-page content script, injected on demand');
  assert.ok(existsSync(dist('selection.js')), 'selection content script');
  for (const js of ['content.js', 'selection.js', 'popup.js', 'service-worker.js']) {
    const code = readFileSync(dist(js), 'utf8');
    assert.ok(!/^\s*(import|export)\s/m.test(code), `${js} must be a classic script (no ES module syntax)`);
    execFileSync(process.execPath, ['--check', dist(js)]);
  }
});

test('build output contains only what the extension needs', () => {
  const files = walk('extension/dist').map((f) => f.replace(/\\/g, '/').replace('extension/dist/', '')).sort();
  assert.deepEqual(files, ['content.js', 'icons/icon-128.png', 'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'manifest.json', 'popup.css', 'popup.html', 'popup.js', 'selection.js', 'service-worker.js']);
});

test('the always-loaded selection script cannot talk to the network or store anything: it only messages the extension worker', () => {
  const code = readFileSync(dist('selection.js'), 'utf8');
  for (const forbidden of [/\bfetch\s*\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/, /localStorage/, /indexedDB/, /document\.cookie/, /chrome\.storage\.local\.set/]) {
    assert.ok(!forbidden.test(code), `selection.js must not use ${forbidden}`);
  }
  assert.ok(/chrome\.runtime\.sendMessage/.test(code));
  assert.ok(!/innerHTML\s*=\s*[^`'"\s]/.test(code), 'innerHTML is only ever assigned our own static template, never page text');
  const entry = readFileSync('extension/src/selection/index.js', 'utf8');
  assert.ok(!/addEventListener|querySelector|getSelection/.test(entry), 'the entry point itself does nothing on load beyond wiring');
});

test('the backend URL baked into the build is a local or https origin only', () => {
  const sw = readFileSync(dist('service-worker.js'), 'utf8');
  assert.ok(sw.includes('http://localhost:8787'));
  assert.throws(() => execFileSync(process.execPath, ['scripts/build.js'], { env: { ...process.env, BHASHAFLOW_BACKEND_URL: 'http://evil.example.com' }, stdio: 'pipe' }), /must be https/);
  execFileSync(process.execPath, ['scripts/build.js'], { stdio: 'pipe' }); // restore the normal build
});

test('icons are valid PNGs of the right size with a visible mark and transparent corners', () => {
  for (const size of ICON_SIZES) {
    const png = readFileSync(dist(`icons/icon-${size}.png`));
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
    let offset = 8;
    const chunks = [];
    while (offset < png.length) {
      const len = png.readUInt32BE(offset);
      const type = png.toString('ascii', offset + 4, offset + 8);
      const body = png.subarray(offset + 8, offset + 8 + len);
      assert.equal(png.readUInt32BE(offset + 8 + len), crc32(png.subarray(offset + 4, offset + 8 + len)), `${type} CRC`);
      chunks.push([type, body]);
      offset += 12 + len;
    }
    assert.deepEqual(chunks.map(([t]) => t), ['IHDR', 'IDAT', 'IEND']);
    const ihdr = chunks[0][1];
    assert.equal(ihdr.readUInt32BE(0), size);
    assert.equal(ihdr.readUInt32BE(4), size);
    assert.equal(ihdr[8], 8);
    assert.equal(ihdr[9], 6);
    const raw = inflateSync(chunks[1][1]);
    assert.equal(raw.length, size * (size * 4 + 1));
    const px = (x, y) => [...raw.subarray(y * (size * 4 + 1) + 1 + x * 4, y * (size * 4 + 1) + 1 + x * 4 + 4)];
    assert.equal(px(0, 0)[3], 0, 'rounded corner is transparent');
    assert.equal(px(Math.floor(size / 2), 1)[3], 255, 'body is opaque');
    const colours = new Set();
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) colours.add(px(x, y).join(','));
    assert.ok(colours.size >= 3, 'letter is drawn on the background');
  }
  assert.deepEqual(makeIconPng(16), makeIconPng(16), 'deterministic build output');
});

// ================================================================ secrets and privacy

test('the API key exists only in the git-ignored .env: not in sources, build, docs, results or logs', () => {
  const key = existsSync('.env') ? ((readFileSync('.env', 'utf8').match(/^(?:LLM_API_KEY|GEMINI_API_KEY)=(.+)$/m) || [])[1] || '').trim() : '';
  if (!key) return; // no key installed on this machine: the generic pattern scan below still applies
  const hits = walk('.').filter((f) => !f.replace(/\\/g, '/').endsWith('/.env') && f !== '.env')
    .filter((f) => { try { return statSync(f).size < 20_000_000 && readFileSync(f, 'utf8').includes(key); } catch { return false; } });
  assert.deepEqual(hits, [], 'the key value was found outside .env (file names only are shown; the key is not)');
});

test('extension sources never read the environment, name a provider, or hold credentials', () => {
  const sources = walk('extension/src');
  assert.ok(sources.length > 10);
  for (const f of sources) {
    const code = readFileSync(f, 'utf8');
    assert.ok(!/process\.env|x-api-key|anthropic-version|api\.anthropic\.com|api\.openai\.com|generativelanguage|groq\.com|\bBearer\b|AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{20,}/.test(code), `${f} mentions credentials or a provider`);
  }
});

test('no automatic translation paths: scripts are injected only by the popup, only on a click', () => {
  const uses = (needle) => walk('extension/src').filter((f) => readFileSync(f, 'utf8').includes(needle)).map((f) => f.replace(/\\/g, '/'));
  assert.deepEqual(uses('executeScript'), ['extension/src/popup/popup.js']);
  for (const trigger of ['onUpdated', 'onActivated', 'webNavigation', 'onCommitted', 'declarativeContent', 'registerContentScripts', 'alarms']) assert.deepEqual(uses(trigger), [], trigger);
  const popup = readFileSync('extension/src/popup/popup.js', 'utf8');
  const translateCalls = popup.split('\n').filter((l) => /\btranslate\(\)|addEventListener\('click', translate\)/.test(l));
  assert.ok(translateCalls.every((l) => /addEventListener\('click'/.test(l) || /async function translate/.test(l)), 'translate() is only bound to the button');
});

test('the backend never logs or returns page text, titles or the key, including on provider errors', async () => {
  const KEY = 'dummy-sensitive-key-for-log-test-0123456789';
  const SECRET = 'Confidential quarterly numbers for the secret project are explained in this paragraph here.';
  const logs = [];
  const consoleLines = [];
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...a) => consoleLines.push(a.join(' '));
  console.error = (...a) => consoleLines.push(a.join(' '));
  try {
    const failing = createOpenAICompatProvider({ apiKey: KEY, model: 'm', baseUrl: 'http://x', fetchImpl: async () => ({ ok: false, status: 400, headers: { get: () => null }, json: async () => ({ error: { message: `bad request echoing ${KEY} and ${SECRET}` } }) }) });
    for (const provider of [createMockProvider(), failing]) {
      const app = createApp({ ...loadConfig({}), retries: 0, requestTimeoutMs: 500 }, { provider, log: (e) => logs.push(e) });
      const res = await app.handle({ method: 'POST', path: '/v1/rewrite', headers: { 'x-bf-install': 'install-id-for-log-test-0001' }, ip: '1.2.3.4', body: { v: 1, page: { title: 'Secret page title' }, items: [{ id: 0, text: SECRET, heading: 'Secret heading' }] } });
      const everything = JSON.stringify([res, logs, consoleLines]);
      assert.ok(!everything.includes(KEY), 'key leaked');
      assert.ok(!logs.length || !JSON.stringify(logs).includes('Confidential'), 'page text in logs');
      assert.ok(!JSON.stringify(logs).includes('Secret page title') && !JSON.stringify(logs).includes('Secret heading'));
      if (provider !== failing) continue;
      assert.ok(!JSON.stringify(res).includes('Confidential'), 'provider text echoed to the extension');
    }
  } finally {
    console.log = realLog;
    console.error = realErr;
  }
  assert.ok(logs.length >= 1, 'requests are logged as counts only');
  assert.ok(logs.every((e) => Object.values(e).every((v) => typeof v === 'number')), 'log entries are numbers only');
});

test('no paid-API or billing dependency exists anywhere in the product', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(pkg.dependencies, undefined);
  assert.deepEqual(Object.keys(pkg.devDependencies).sort(), ['esbuild', 'jsdom']);
  for (const f of [...walk('backend'), ...walk('extension/src'), ...walk('api'), '.env.example']) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /stripe|billing|payment|razorpay|paypal|subscription plan|credit card/i, f);
  }
});

// ================================================================ resource hygiene

test('no timer or observer survives Restore or a stopped observer (no leaks)', async () => {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const live = new Set();
  globalThis.setTimeout = (fn, ms, ...a) => { const id = realSet((...x) => { live.delete(id); fn(...x); }, ms, ...a); live.add(id); return id; };
  globalThis.clearTimeout = (id) => { live.delete(id); return realClear(id); };
  try {
    const dom = new JSDOM('<body><main><p>Paragraph one explains how this particular part of the system works and why it is useful in practice today.</p></main></body>');
    const doc = dom.window.document;
    const conv = { limits: { maxItems: 12, maxChars: 1800, maxItemChars: 3900 }, convert: async (items) => items.map((i) => ({ id: i.id, hinglish: `Hinglish ${i.text}` })) };
    const ctl = createController({ root: doc.body, converter: conv });
    await ctl.translate({ ...DEFAULT_SETTINGS, observe: true });
    assert.equal(ctl.getStatus().observing, true);
    const p = doc.createElement('p');
    p.textContent = 'A newly added paragraph explains how this particular part of the system works and why it matters here today.';
    doc.querySelector('main').append(p);
    await sleep(30); // mutation delivered: the observer's debounce timer is now pending
    ctl.restore();
    await sleep(5);
    const stray = [...live].length;
    assert.equal(stray, 0, `${stray} timers still pending after restore`);
    assert.equal(ctl.getStatus().observing, false);

    const obs = createObserver({ root: doc.body, onNodes: async () => {} });
    obs.start();
    doc.body.append(doc.createElement('section'));
    await sleep(20);
    obs.stop();
    assert.equal(obs.active, false);
    assert.equal([...live].length, 0);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});

// ================================================================ documentation

test('README documents setup, the exact Chrome folder, usage and limits; no stale phase wording', () => {
  const readme = readFileSync('README.md', 'utf8');
  for (const must of ['npm install', 'npm run build', 'npm run backend', 'extension/dist', 'Load unpacked', '.env', 'LLM_API_KEY', 'gemini-3.6-flash', 'REASONING_EFFORT', 'Translate this page', 'Pause', 'Stop', 'Restore', 'Clear saved translations', 'Remember translations', 'Known limitations', 'daily', 'quota']) {
    assert.ok(readme.includes(must), `README is missing: ${must}`);
  }
  for (const stale of ['Phase 3 (AI engine', 'Phase 2 (content engine) complete', 'Nothing leaves your browser yet', 'is still a test marker', 'batches of 5']) {
    assert.ok(!readme.includes(stale), `README still contains outdated text: ${stale}`);
  }
  const roadmap = readFileSync('ROADMAP.md', 'utf8');
  assert.ok(/viewport-first/i.test(roadmap) && /parallel/i.test(roadmap));
  assert.ok(!/Phase 4 - Hybrid performance[^\n]*not started/i.test(roadmap), 'ROADMAP still says Phase 4 is not started');
});
