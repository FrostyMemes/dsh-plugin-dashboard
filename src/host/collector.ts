import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-subagent';
import type {} from '@deepseek-ai/dsh-token-meter';

const unavailable = null;

export interface DashboardAgent {
  id: string;
  parentId: string | null;
  name: string;
  status: 'idle' | 'running' | 'unknown';
  task: string;
  model: string | null;
  metrics: {
    context: { used: number | null; capacity: number | null; estimated: boolean };
    tokens: { input: number | null; output: number | null; cacheRead: number | null; cacheWrite: number | null } | null;
    children: { direct: number | null; total: number | null };
    durationMs: number | null;
  };
  sourceDiagnostics: string[];
}

export interface DashboardSnapshot {
  bootId: string;
  revision: number;
  generatedAt: string;
  completeness: 'partial';
  agents: DashboardAgent[];
}

function safeModel(agent: Agent): string | null {
  const model = agent.options?.model;
  return typeof model === 'string' && model.length <= 160 ? model : unavailable;
}

export function createCollector(ctx: Context, {
  bootId = globalThis.crypto.randomUUID(),
  now = () => new Date().toISOString(),
}: {
  bootId?: string;
  now?: () => string;
} = {}) {
  const agents = new Map<string, DashboardAgent>();
  const listeners = new Set<(event: CollectorEvent) => void>();
  let revision = 0;
  let disposed = false;
  const cleanups: Array<() => void> = [];
  let treeTimer: ReturnType<typeof setTimeout> | undefined;
  let treeGeneration = 0;

  function project(agent: Agent): DashboardAgent {
    const id = String(agent.id);
    const previous = agents.get(id);
    const projections = ctx.sessionProjections.snapshot(agent.session, ['tokenUsage', 'contextPressure', 'subagentCatalog']).values as Record<string, unknown>;
    const tokenUsage = projections.tokenUsage as {
      uncachedInputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    } | undefined;
    const pressure = projections.contextPressure as {
      pressureTokens?: number;
      projectedTokens?: number;
      contextWindow?: number;
    } | undefined;
    const childCatalog = projections.subagentCatalog as Array<{ id: string }> | undefined;
    return {
      id,
      parentId: previous?.parentId ?? null,
      name: id,
      status: agent.status === 'running' || agent.status === 'idle' ? agent.status : 'unknown',
      task: 'Задача недоступна',
      model: safeModel(agent),
      metrics: {
        context: {
          used: pressure?.projectedTokens ?? pressure?.pressureTokens ?? unavailable,
          capacity: pressure?.contextWindow ?? unavailable,
          estimated: pressure?.projectedTokens !== undefined,
        },
        tokens: tokenUsage ? {
          input: tokenUsage.uncachedInputTokens ?? unavailable,
          output: tokenUsage.outputTokens ?? unavailable,
          cacheRead: tokenUsage.cacheReadTokens ?? unavailable,
          cacheWrite: tokenUsage.cacheWriteTokens ?? unavailable,
        } : null,
        children: { direct: childCatalog?.length ?? unavailable, total: unavailable },
        durationMs: null,
      },
      sourceDiagnostics: [
        ...(!tokenUsage ? ['Token usage projection is unavailable.'] : []),
        ...(!pressure?.contextWindow ? ['Context capacity has not been reported.'] : []),
        ...(!childCatalog ? ['Subagent catalog projection is unavailable.'] : []),
      ],
    };
  }

  function publish(agent: Agent): void {
    if (disposed) return;
    const entry = project(agent);
    agents.set(entry.id, entry);
    revision += 1;
    const event: CollectorEvent = { bootId, revision, generatedAt: now(), agent: structuredClone(entry) };
    for (const listener of [...listeners]) listener(event);
  }

  function on(name: 'agent/created' | 'agent/status' | 'agent/disposed', callback: (payload: { agent: Agent }) => void): void {
    const dispose = ctx.on(name, callback as never);
    if (typeof dispose === 'function') cleanups.push(dispose);
  }

  for (const agent of ctx.agents.list()) agents.set(String(agent.id), project(agent));
  on('agent/created', ({ agent }) => { publish(agent); scheduleTreeRefresh(); });
  on('agent/status', ({ agent }) => publish(agent));
  on('agent/disposed', ({ agent }) => {
    if (disposed) return;
    const id = String(agent.id);
    if (!agents.delete(id)) return;
    revision += 1;
    const event: CollectorEvent = { bootId, revision, generatedAt: now(), removedId: id };
    for (const listener of [...listeners]) listener(event);
    scheduleTreeRefresh();
  });
  cleanups.push(ctx.sessionProjections.onChanged((session, key) => {
    const agent = ctx.agents.list().find(candidate => candidate.session === session);
    if (!agent) return;
    publish(agent);
    if (key === 'subagentCatalog') scheduleTreeRefresh();
  }));

  scheduleTreeRefresh();

  function scheduleTreeRefresh(): void {
    if (disposed) return;
    // Invalidate an asynchronous catalog read as soon as newer lifecycle or
    // projection information arrives, not only when the next read begins.
    treeGeneration += 1;
    if (treeTimer) clearTimeout(treeTimer);
    const generation = treeGeneration;
    treeTimer = setTimeout(() => { void refreshTree(generation); }, 250);
  }

  async function refreshTree(generation: number): Promise<void> {
    const liveAgents = ctx.agents.list();
    const discovered = new Map<string, DashboardAgent>();
    const diagnosticsByParent = new Map<string, string[]>();
    for (const root of liveAgents) {
      try {
        const rows = await ctx.subagents.listDescendants(root.id);
        for (const row of rows) {
          if (row.kind === 'diagnostic') {
            const values = diagnosticsByParent.get(String(row.parentId)) ?? [];
            values.push(`Subagent catalog ${row.reason} for ${String(row.id)}.`);
            diagnosticsByParent.set(String(row.parentId), values);
            continue;
          }
          const current = ctx.agents.get(row.id);
          discovered.set(String(row.id), {
            id: String(row.id),
            parentId: String(row.parentId),
            name: row.label || String(row.id),
            status: current?.status === 'running' || current?.status === 'idle' ? current.status : 'unknown',
            task: 'Задача недоступна',
            model: current ? safeModel(current) : unavailable,
            metrics: {
              context: { used: unavailable, capacity: unavailable, estimated: false },
              tokens: null,
              children: { direct: row.hasChildren ? unavailable : 0, total: unavailable },
              durationMs: unavailable,
            },
            sourceDiagnostics: current ? [] : ['Child session is known from its parent catalog; live status is unavailable.'],
          });
        }
      } catch {
        diagnosticsByParent.set(String(root.id), ['Subagent catalog could not be read.']);
      }
      if (generation !== treeGeneration || disposed) return;
    }
    const liveIds = new Set(liveAgents.map(agent => String(agent.id)));
    for (const id of [...agents.keys()]) {
      if (!liveIds.has(id) && !discovered.has(id)) {
        agents.delete(id);
        revision += 1;
        const event: CollectorEvent = { bootId, revision, generatedAt: now(), removedId: id };
        for (const listener of [...listeners]) listener(event);
      }
    }
    for (const [id, entry] of discovered) {
      const previous = agents.get(id);
      const withDiagnostics = { ...entry, sourceDiagnostics: [...entry.sourceDiagnostics, ...(diagnosticsByParent.get(id) ?? [])] };
      if (JSON.stringify(previous) === JSON.stringify(withDiagnostics)) continue;
      agents.set(id, withDiagnostics);
      revision += 1;
      const event: CollectorEvent = { bootId, revision, generatedAt: now(), agent: structuredClone(withDiagnostics) };
      for (const listener of [...listeners]) listener(event);
    }
    for (const [id, diagnostics] of diagnosticsByParent) {
      const parent = agents.get(id);
      if (!parent) continue;
      const updated = { ...parent, sourceDiagnostics: [...new Set([...parent.sourceDiagnostics, ...diagnostics])] };
      agents.set(id, updated);
      revision += 1;
      const event: CollectorEvent = { bootId, revision, generatedAt: now(), agent: structuredClone(updated) };
      for (const listener of [...listeners]) listener(event);
    }
    for (const parentAgent of liveAgents) {
      const id = String(parentAgent.id);
      const previous = agents.get(id);
      if (!previous) continue;
      const updated = project(parentAgent);
      updated.sourceDiagnostics = [
        ...updated.sourceDiagnostics,
        ...(diagnosticsByParent.get(id) ?? []),
      ];
      if (JSON.stringify(previous) === JSON.stringify(updated)) continue;
      agents.set(id, updated);
      revision += 1;
      const event: CollectorEvent = { bootId, revision, generatedAt: now(), agent: structuredClone(updated) };
      for (const listener of [...listeners]) listener(event);
    }
  }

  return {
    snapshot(): DashboardSnapshot {
      return { bootId, revision, generatedAt: now(), completeness: 'partial', agents: [...agents.values()].map(entry => structuredClone(entry)) };
    },
    subscribe(listener: (event: CollectorEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (treeTimer) clearTimeout(treeTimer);
      treeGeneration += 1;
      for (const cleanup of cleanups.splice(0)) cleanup();
      listeners.clear();
      agents.clear();
    },
  };
}

export type CollectorEvent = {
  bootId: string;
  revision: number;
  generatedAt: string;
  agent: DashboardAgent;
} | {
  bootId: string;
  revision: number;
  generatedAt: string;
  removedId: string;
};
