// Measures perceived translation speed end to end with the REAL content controller, the REAL worker service
// (cache, dedupe, lookup) and the REAL backend stack (engine, provider from .env, normally Ollama) in one process.
// Only Chrome itself is simulated (jsdom, memory cache instead of IndexedDB). It calls the configured model:
// with PROVIDER=ollama that is local and free. It never touches a cloud provider unless .env selects one.
//
//   npm run perf                       7 medium paragraphs, cold then warm
//   npm run perf -- --paras 12         number of paragraphs (default 7)
//   npm run perf -- --concurrency 2    extension setting (the backend hint can still lower it)
//   npm run perf -- --first-batch 3    override the first-request size hint
//   npm run perf -- --visible 3        paragraphs on screen at the start (default 3)
import { execFileSync } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { loadConfig } from '../backend/src/config.js';
import { createApp } from '../backend/src/server.js';
import { createController } from '../extension/src/content/controller.js';
import { createRemoteConverter } from '../extension/src/content/converter-remote.js';
import { createTranslationCache, createMemoryStorage } from '../extension/src/background/translation-cache.js';
import { createTranslationService } from '../extension/src/background/translation-service.js';
import { DEFAULT_SETTINGS } from '../extension/src/shared/settings.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : Number(args[i + 1]); };
const PARAS = flag('paras', 7);
const VISIBLE = flag('visible', 3);

const TEXTS = [
  'A cache stores frequently used data so that future requests can be served much faster than fetching the same data again from a slow database.',
  'When a user opens the page, the browser first downloads the HTML document and then fetches the images, scripts and style sheets that it refers to.',
  'Load balancers spread incoming traffic across several servers so that no single machine is overwhelmed when many people visit the site at once.',
  'A hash table maps each key to a position in an array, which makes finding a value by its key very quick even when the table holds millions of entries.',
  'Version control lets a team work on the same project without overwriting each other changes, and it keeps a full history that can be inspected later.',
  'The operating system decides which program gets the processor at any moment, and it switches between programs so quickly that they appear to run together.',
  'Encryption turns readable data into a scrambled form that only the right key can open, which protects information while it is stored or sent over a network.',
  'An index in a database works like the index of a book: it lets the engine jump straight to the rows it needs instead of reading the whole table.',
  'Unit tests check one small piece of code in isolation, so a failing test points directly at the function that broke instead of at the whole program.',
  'A queue hands out work in the order it arrived, which keeps a busy system fair and makes it easy to see how far behind it has fallen.',
  'Compression removes repeated patterns from a file so that it takes less space on disk and less time to send over a slow connection.',
  'A firewall inspects network traffic against a list of rules and drops anything that does not match, which keeps unwanted connections out.',
];
const page = (n) => `<body><main>${Array.from({ length: n }, (_, i) => `<p data-i="${i}">${TEXTS[i % TEXTS.length]}${i >= TEXTS.length ? ` (part ${i})` : ''}</p>`).join('')}</main></body>`;
const layout = {
  viewport: () => ({ height: 100 * VISIBLE - 10, scrollY: 0 }), // paragraph i sits at y = 100*i: the first VISIBLE are on screen
  rectOf: (el) => { const top = Number(el.dataset.i) * 100; return { top, bottom: top + 80, width: 600, height: 80 }; },
};

/** Working set (MB) and cumulative CPU seconds of Ollama's processes, where Windows lets us see them. */
function ollamaProcs() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-Process | Where-Object { $_.ProcessName -like '*ollama*' -or $_.ProcessName -like '*llama*' } | ForEach-Object { '{0},{1},{2}' -f $_.ProcessName, [math]::Round($_.WorkingSet64/1MB), [math]::Round($_.CPU,1) }"], { encoding: 'utf8' });
    const rows = out.trim().split(/\r?\n/).filter(Boolean).map((l) => l.split(','));
    return { workingSetMB: rows.reduce((n, r) => n + Number(r[1]), 0), cpuSeconds: Math.round(rows.reduce((n, r) => n + Number(r[2]), 0) * 10) / 10, processes: rows.map((r) => r[0]) };
  } catch { return null; }
}

const config = loadConfig(process.env);
const app = createApp(config, {});
const health = (await app.handle({ method: 'GET', path: '/health', headers: {} })).body;
const hints = {
  ...(health.maxConcurrency ? { maxConcurrency: health.maxConcurrency } : {}),
  ...(health.firstBatchItems ? { firstBatchItems: health.firstBatchItems } : {}),
  ...(health.batch ? { batch: health.batch } : {}),
};
if (flag('first-batch', 0)) hints.firstBatchItems = flag('first-batch', 0);
const setting = flag('concurrency', DEFAULT_SETTINGS.maxParallelRequests);

const info = { promptVersion: health.promptVersion, model: health.model };
const backendCalls = [];
const svc = createTranslationService({
  cache: createTranslationCache({ storage: createMemoryStorage() }),
  getInfo: async () => info,
  backend: async (payload) => {
    const t = Date.now();
    const res = await app.handle({ method: 'POST', path: '/v1/rewrite', headers: {}, ip: '127.0.0.1', body: payload });
    backendCalls.push({ blocks: payload.items.length, ms: Date.now() - t, status: res.status, error: res.body.error && res.body.error.code, meta: res.body.meta });
    return res.status === 200 ? { ok: true, data: res.body } : { ok: false, error: res.body.error };
  },
});
const send = async (m) => {
  if (m.type === 'bf:hints') return { ok: true, hints };
  if (m.type === 'bf:lookup') return svc.lookup(m.payload, { useCache: m.useCache });
  return svc.convert(m.payload, { useCache: m.useCache });
};

async function visit(label) {
  const dom = new JSDOM(page(PARAS));
  const ctl = createController({ root: dom.window.document.body, converter: createRemoteConverter({ send }), layout });
  backendCalls.length = 0;
  const before = ollamaProcs();
  const mem0 = process.memoryUsage().rss;
  const t0 = Date.now();
  const samples = [];
  const timer = setInterval(() => { const s = ctl.getStatus(); samples.push([Date.now() - t0, s.converted, s.phase]); }, 250);
  const st = await ctl.translate({ ...DEFAULT_SETTINGS, maxParallelRequests: setting });
  clearInterval(timer);
  const wall = Date.now() - t0;
  const after = ollamaProcs();
  const p = st.perf;
  const result = {
    visit: label, paragraphs: PARAS, translated: st.converted, failed: st.failed, wallMs: wall,
    clickToFirstBlockMs: p.firstBlockMs, clickToFirstCachedMs: p.firstCachedBlockMs, clickToFirstFreshMs: p.firstFreshBlockMs,
    cacheLookupMs: p.cacheLookupMs, cacheHitRate: p.cacheHitRate, requests: st.perf.requests, blocksRequested: p.blocksRequested,
    requestMs: { avg: p.requestMsAvg, p95: p.requestMsP95 }, perBlockMs: { avg: p.blockMsAvg, p95: p.blockMsP95 },
    requestSizes: backendCalls.map((c) => c.blocks), backendErrors: backendCalls.filter((c) => c.error).map((c) => c.error),
    concurrency: st.concurrency, hints,
    progress: samples.filter((_, i) => i % 4 === 0).map(([ms, n, ph]) => `${(ms / 1000).toFixed(1)}s:${n}${ph === 'visible' ? 'v' : ph === 'background' ? 'b' : ''}`).join(' '),
    nodeRssDeltaMB: Math.round((process.memoryUsage().rss - mem0) / 1048576),
  };
  if (before && after) result.ollama = { workingSetMB: after.workingSetMB, cpuSecondsUsed: Math.round((after.cpuSeconds - before.cpuSeconds) * 10) / 10, cpuCoresAvg: wall > 500 ? Math.round(((after.cpuSeconds - before.cpuSeconds) / (wall / 1000)) * 100) / 100 : null };
  return result;
}

console.log(`provider=${health.provider} model=${health.model} prompt=${health.promptVersion} concurrencySetting=${setting} hints=${JSON.stringify(hints)}`);
console.log(JSON.stringify(await visit('cold (nothing cached)'), null, 1));
console.log(JSON.stringify(await visit('warm (same page again, cache filled)'), null, 1));
