import { randomBytes } from 'node:crypto';
import { Service } from '@deepseek-ai/cordis';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { Context } from '@deepseek-ai/cordis';
import { createCollector } from './collector.js';
import { registerDashboardRoutes } from './http.js';
import { createPairingStore } from './security.js';

const PACKAGE = 'dsh-agent-control-center';
const BASE = '/dsh-agent-control-center';
const SECRET_KEY = credentialKey(PACKAGE, 'dashboard-cookie');

function getValidSecret(record: unknown): string | undefined {
  if (!record || typeof record !== 'object' || !('kind' in record) || record.kind !== 'grant' || !('payload' in record)) return undefined;
  const payload = record.payload;
  if (!payload || typeof payload !== 'object' || !('version' in payload) || payload.version !== 1 || !('secret' in payload) || typeof payload.secret !== 'string') return undefined;
  const bytes = Buffer.from(payload.secret, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== payload.secret) return undefined;
  return payload.secret;
}

export class DashboardHost extends TypertRemoteService {
  static inject = ['agents', 'sessionProjections', 'subagents', 'webServer', 'credentials'];

  private pairing: ReturnType<typeof createPairingStore> | undefined;
  private collector: ReturnType<typeof createCollector>;
  private routeDisposer: (() => void) | undefined;

  constructor(ctx: Context) {
    super(ctx, 'agentControlCenter');
    this.collector = createCollector(ctx);
    ctx.effect(() => async () => this.dispose());
  }

  async [Service.init](): Promise<void> {
    if (this.ctx.webServer.host !== '127.0.0.1' || !Number.isSafeInteger(this.ctx.webServer.port) || this.ctx.webServer.port < 1) {
      throw new Error('Agent Control Center requires the Host web server to bind to 127.0.0.1 on an active port.');
    }
    this.pairing = await loadPairingStore(this.ctx);
    this.routeDisposer = registerDashboardRoutes({
      webServer: this.ctx.webServer,
      collector: this.collector,
      pairing: this.pairing,
      getAuthority: () => `127.0.0.1:${this.ctx.webServer.port}`,
    });
  }

  /** Mint a two-minute single-use dashboard link from the explicitly opened Bundle page. */
  @Remote
  async createPairingLink(): Promise<string> {
    if (!this.pairing) throw new Error('Dashboard pairing is not ready.');
    if (this.ctx.webServer.host !== '127.0.0.1') throw new Error('Dashboard access is available only on loopback.');
    const authority = `127.0.0.1:${this.ctx.webServer.port}`;
    const token = this.pairing.issue(authority);
    return `http://${authority}${BASE}/#token=${encodeURIComponent(token)}`;
  }

  private async dispose(): Promise<void> {
    this.routeDisposer?.();
    this.routeDisposer = undefined;
    this.pairing?.clear();
    this.pairing = undefined;
    this.collector.dispose();
  }
}

async function loadPairingStore(ctx: Context): Promise<ReturnType<typeof createPairingStore>> {
  await ctx.credentials.modifyRecord(SECRET_KEY, current => Promise.resolve(
    getValidSecret(current)
      ? current
      : { kind: 'grant' as const, payload: { version: 1, secret: randomBytes(32).toString('base64url') } },
  ));
  const secret = getValidSecret(await ctx.credentials.readRecord(SECRET_KEY));
  if (!secret) throw new Error('Dashboard signing secret could not be loaded from DSH Credentials.');
  return createPairingStore({ secret });
}

export default DashboardHost;
