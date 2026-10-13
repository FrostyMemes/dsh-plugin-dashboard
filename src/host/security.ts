import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const PAIRING_TTL_MS = 2 * 60 * 1000;
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

function equalText(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

interface PairingEntry {
  authority: string;
  expiresAt: number;
}

interface SessionPayload {
  v: 1;
  authority: string;
  exp: number;
}

export function createPairingStore({
  secret,
  now = Date.now,
  random = randomBytes,
}: {
  secret: string;
  now?: () => number;
  random?: (size: number) => Buffer;
}) {
  if (Buffer.from(secret, 'base64url').length !== 32) {
    throw new TypeError('A 32-byte base64url signing secret is required.');
  }
  const tokens = new Map<string, PairingEntry>();

  function prune(): void {
    const current = now();
    for (const [token, entry] of tokens) if (entry.expiresAt <= current) tokens.delete(token);
  }

  return {
    issue(authority: string): string {
      prune();
      const token = random(32).toString('base64url');
      tokens.set(token, { authority, expiresAt: now() + PAIRING_TTL_MS });
      return token;
    },
    consume(token: unknown, authority: string): boolean {
      if (typeof token !== 'string' || token.length > 128) return false;
      const entry = tokens.get(token);
      if (!entry) return false;
      // Delete before validation so an invalid attempt cannot probe or reuse the token.
      tokens.delete(token);
      return entry.expiresAt > now() && equalText(entry.authority, authority);
    },
    createCookie(authority: string): string {
      const payload = Buffer.from(JSON.stringify({ v: 1, authority, exp: now() + SESSION_TTL_SECONDS * 1000 } satisfies SessionPayload)).toString('base64url');
      return `${payload}.${sign(payload, secret)}`;
    },
    verifyCookie(cookie: string | undefined, authority: string): boolean {
      if (typeof cookie !== 'string' || cookie.length > 2048) return false;
      const separator = cookie.lastIndexOf('.');
      if (separator <= 0) return false;
      const payload = cookie.slice(0, separator);
      const signature = cookie.slice(separator + 1);
      if (!equalText(sign(payload, secret), signature)) return false;
      try {
        const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<SessionPayload>;
        return parsed.v === 1 && parsed.authority === authority && Number.isSafeInteger(parsed.exp) && parsed.exp! > now();
      } catch {
        return false;
      }
    },
    clear(): void { tokens.clear(); },
    get size(): number { return tokens.size; },
  };
}

export function requestAuthority(req: IncomingMessage, expectedAuthority: string): boolean {
  if (req.headers.host !== expectedAuthority) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${expectedAuthority}`) return false;
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
  return true;
}

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string') return undefined;
  for (const pair of raw.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0 || pair.slice(0, index).trim() !== name) continue;
    return pair.slice(index + 1).trim();
  }
  return undefined;
}

export function parseRequestBody(req: IncomingMessage, { maxBytes = 4096 }: { maxBytes?: number } = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    let length = 0;
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      length += Buffer.byteLength(chunk);
      if (length > maxBytes) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.resume();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body) as unknown); }
      catch { reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}
