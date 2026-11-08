import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { createProvider } from './providers/index.js';
import { createEngine } from './engine.js';
import { createHandler } from './handler.js';

/** Wires config -> provider -> engine -> handler. Shared by the local server and api/rewrite.js. */
export function createApp(config = loadConfig(), { provider, log } = {}) {
  const llm = provider || createProvider(config);
  const engine = createEngine({ provider: llm, config });
  return { config, handle: createHandler({ engine, config, log }) };
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { // stop buffering, keep draining so the client can read our 413
        if (chunks.length) { chunks.length = 0; reject(Object.assign(new Error('too large'), { status: 413 })); }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createServer(app) {
  const { config } = app;
  return http.createServer(async (req, res) => {
    const send = (status, body, headers = {}) => {
      const origin = req.headers.origin;
      const cors = origin && config.allowedOrigins.includes(origin)
        ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors, ...headers });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'OPTIONS') {
        return send(204, {}, { 'access-control-allow-headers': 'content-type,x-bf-install,x-bf-token', 'access-control-allow-methods': 'POST,GET' });
      }
      let body;
      if (req.method === 'POST') {
        const raw = await readBody(req, config.limits.maxBodyBytes);
        try { body = JSON.parse(raw); } catch { return send(400, { error: { code: 'invalid-json', message: 'Body is not valid JSON' } }); }
      }
      const url = new URL(req.url, 'http://localhost');
      const out = await app.handle({ method: req.method, path: url.pathname, headers: req.headers, body, ip: req.socket.remoteAddress });
      send(out.status, out.body, out.headers);
    } catch (err) {
      if (err.status === 413) return send(413, { error: { code: 'too-large', message: 'Request body too large' } }, { connection: 'close' });
      console.error('unhandled', err.message);
      send(500, { error: { code: 'internal', message: 'Internal error' } });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let app;
  try {
    app = createApp(loadConfig(), { log: (entry) => console.log(JSON.stringify({ t: new Date().toISOString(), ...entry })) });
  } catch (err) { // a missing key or a bad setting: say so plainly instead of printing a stack trace
    console.error(`BhashaFlow backend cannot start: ${err.message}`);
    process.exit(1);
  }
  createServer(app).listen(app.config.port, '127.0.0.1', () => {
    const { provider, model } = app.config;
    console.log(`BhashaFlow backend on http://127.0.0.1:${app.config.port} (provider=${provider}${model ? `, model=${model}` : ''})`);
    if (provider === 'ollama') console.log(`Local Ollama at ${app.config.ollamaBaseUrl}: no API key used, page text stays on this machine. Make sure Ollama is running and "ollama pull ${model}" is done.`);
    if (provider === 'mock') console.log('WARNING: mock provider active; output is not real Hinglish. Set PROVIDER/MODEL/LLM_API_KEY in .env');
  });
}
