import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebServer } from '@deepseek-ai/dsh-host-webserver';
import type { createCollector } from './collector.js';
import { parseRequestBody, readCookie, requestAuthority } from './security.js';

const BASE = '/dsh-agent-control-center';
const COOKIE = 'dsh_agent_control_center';
const STATIC_ROOT = resolve(fileURLToPath(new URL('../web/', import.meta.url)));

type PairingStore = ReturnType<typeof import('./security.js').createPairingStore>;
type Collector = ReturnType<typeof createCollector>;

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function forbidden(res: ServerResponse): void {
  sendJson(res, 403, { error: 'forbidden' });
}

export function registerDashboardRoutes({ webServer, collector, pairing, getAuthority }: {
  webServer: WebServer;
  collector: Collector;
  pairing: PairingStore;
  getAuthority: () => string;
}): () => void {
  const streams = new Set<ServerResponse>();
  const unregister = webServer.register({ kind: 'prefix', path: BASE, handler: (req, res) => {
    void handleRequest(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      else res.destroy();
    });
  } });
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    unregister();
    for (const response of [...streams]) response.end();
  };

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'invalid'}`);
    const path = url.pathname;
    const authority = getAuthority();
    if (!requestAuthority(req, authority)) return forbidden(res);

    if (path === `${BASE}/api/pair` && req.method === 'POST') {
      if (req.headers.origin !== `http://${authority}` || req.headers['sec-fetch-site'] !== 'same-origin') return forbidden(res);
      let body: unknown;
      try {
        body = await parseRequestBody(req);
      } catch (error) {
        const status = error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number'
          ? error.statusCode
          : 400;
        return sendJson(res, status, { error: status === 413 ? 'request_too_large' : 'invalid_request' });
      }
      const token = body !== null && typeof body === 'object' && 'token' in body ? body.token : undefined;
      if (!pairing.consume(token, authority)) {
        return sendJson(res, 401, { error: 'pairing_invalid_or_expired' });
      }
      return sendJson(res, 200, { paired: true }, {
        'Set-Cookie': `${COOKIE}=${pairing.createCookie(authority)}; HttpOnly; SameSite=Strict; Path=${BASE}; Max-Age=2592000`,
      });
    }

    if (path === `${BASE}/api/snapshot` && req.method === 'GET') {
      if (!isAuthorized(req, pairing, authority)) return sendJson(res, 401, { error: 'unauthorized' });
      return sendJson(res, 200, collector.snapshot());
    }

    if (path === `${BASE}/api/events` && req.method === 'GET') {
      if (!isAuthorized(req, pairing, authority)) return sendJson(res, 401, { error: 'unauthorized' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      res.write(`event: snapshot\ndata: ${JSON.stringify(collector.snapshot())}\n\n`);
      const unsubscribe = collector.subscribe(event => {
        const eventName = 'removedId' in event ? 'remove' : 'update';
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(event)}\n\n`);
      });
      const heartbeat = setInterval(() => res.write(`event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`), 15_000);
      streams.add(res);
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        unsubscribe();
        streams.delete(res);
      };
      res.on('close', cleanup);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD, POST', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    return serveStatic(req, res, path);
  }
}

function isAuthorized(req: IncomingMessage, pairing: PairingStore, authority: string): boolean {
  return pairing.verifyCookie(readCookie(req, COOKIE), authority);
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const relative = pathname.slice(BASE.length).replace(/^\/+/, '') || 'index.html';
  let decoded: string;
  try { decoded = decodeURIComponent(relative); }
  catch { return sendJson(res, 400, { error: 'bad_path' }); }
  const filePath = resolve(STATIC_ROOT, decoded);
  if (filePath !== STATIC_ROOT && !filePath.startsWith(`${STATIC_ROOT}${sep}`)) return sendJson(res, 404, { error: 'not_found' });
  let body: Buffer;
  let actualPath = filePath;
  try { body = await readFile(filePath); }
  catch {
    // Browser routes use the SPA shell; unknown asset paths stay 404.
    if (extname(decoded) !== '') return sendJson(res, 404, { error: 'not_found' });
    actualPath = resolve(STATIC_ROOT, 'index.html');
    try { body = await readFile(actualPath); }
    catch { return sendJson(res, 503, { error: 'dashboard_not_built' }); }
  }
  res.writeHead(200, {
    'Content-Type': contentTypes[extname(actualPath)] ?? 'application/octet-stream',
    'Cache-Control': actualPath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  if (req.method === 'HEAD') res.end();
  else res.end(body);
}
