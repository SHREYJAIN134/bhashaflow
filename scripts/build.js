import { build } from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { makeIconPng, ICON_SIZES } from './make-icons.js';

// The backend the extension talks to. Only this origin is requested as a host permission.
const backendUrl = process.env.BHASHAFLOW_BACKEND_URL || 'http://localhost:8787';
const backendOrigin = new URL(backendUrl).origin;
const isLocal = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(backendOrigin);
if (!backendOrigin.startsWith('https://') && !isLocal) {
  throw new Error(`BHASHAFLOW_BACKEND_URL must be https (or http://localhost): ${backendOrigin}`);
}

const out = 'extension/dist';
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: {
    content: 'extension/src/content/index.js',
    selection: 'extension/src/selection/index.js',
    popup: 'extension/src/popup/popup.js',
    'service-worker': 'extension/src/background/service-worker.js',
  },
  outdir: out,
  bundle: true,
  format: 'iife',
  target: 'chrome110',
  define: { __BACKEND_URL__: JSON.stringify(backendUrl) },
  logLevel: 'info',
});

await mkdir(`${out}/icons`, { recursive: true });
for (const size of ICON_SIZES) await writeFile(`${out}/icons/icon-${size}.png`, makeIconPng(size));

const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
manifest.host_permissions = [`${backendOrigin}/*`];
await writeFile(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
await cp('extension/src/popup/popup.html', `${out}/popup.html`);
await cp('extension/src/popup/popup.css', `${out}/popup.css`);
console.log(`Built extension -> ${out} (backend: ${backendUrl}; load this folder via chrome://extensions)`);
