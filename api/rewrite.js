// Vercel serverless entry (deploy with the repository root as the project root so the shared
// token module resolves). Same handler as the local server; nothing here is Vercel-specific
// beyond the (req, res) signature. Not deployed or tested on Vercel in Phase 3.
import { createApp } from '../backend/src/server.js';

let app;

export default async function handler(req, res) {
  app ||= createApp();
  const out = await app.handle({
    method: req.method,
    path: '/v1/rewrite',
    headers: req.headers,
    body: req.body,
    ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress,
  });
  for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
  res.setHeader('cache-control', 'no-store');
  res.status(out.status).json(out.body);
}
