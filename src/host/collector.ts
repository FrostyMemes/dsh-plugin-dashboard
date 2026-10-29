import { z } from 'zod';
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
  title: string | null;
  status: 'idle' | 'running' | 'unknown';
  task: string;
  model: string | null;
  runningOrder: number | null;
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

interface SessionQueryRecord {
  header: { id: string };
  live: boolean;
  persisted: boolean;
}

interface SessionTitleResult {
  status: 'fulfilled' | 'rejected';
  value?: { session: { id: string }; title?: { title: string } };
}

interface SessionObservation {
  projections?: { values: Record<string, unknown> };
  [Symbol.dispose](): void;
}

const modelProjectionKey = 'agentControlCenterLastModel';
const modelSchema = z.string().min(1).max(160).nullable();
function confirmedModel(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 ? value : null;
}

function metricsFromProjections(values: Record<string, unknown>): DashboardAgent['metrics'] {
  const usage = values.tokenUsage as { uncachedInputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined;
  const pressure = values.contextPressure as { pressureTokens?: number; projectedTokens?: number; contextWindow?: number } | undefined;
  const children = values.subagentCatalog as unknown[] | undefined;
  return {
    context: { used: pressure?.projectedTokens ?? pressure?.pressureTokens ?? null, capacity: pressure?.contextWindow ?? null, estimated: pressure?.projectedTokens !== undefined },
    tokens: usage ? { input: usage.uncachedInputTokens ?? null, output: usage.outputTokens ?? null, cacheRead: usage.cacheReadTokens ?? null, cacheWrite: usage.cacheWriteTokens ?? null } : null,
    children: { direct: children?.length ?? null, total: null },
    durationMs: null,
  };
}

interface SessionQueryService {
  observeSession?(id: string): Promise<SessionObservation>;
  listSessions(): Promise<SessionQueryRecord[]>;
  readTitleSnapshots(ids: string[]): Promise<SessionTitleResult[]>;
}

export function createCollector(ctx: Context, {
  bootId = globalThis.crypto.randomUUID(),
  now = () => new Date().toISOString(),
  archivePollMs = 1_000,
  sessionPollMs = 3_000,
}: {
  bootId?: string;
  now?: () => string;
  archivePollMs?: number;
  sessionPollMs?: number;
} = {}) {
  const agents = new Map<string, DashboardAgent>();
  const listeners = new Set<(event: CollectorEvent) => void>();
  const log = ctx.logger('dsh-agent-control-center');
  const workspaceRegistry = (ctx as unknown as { workspaceRegistry?: { archivedSessionIds: readonly string[] } }).workspaceRegistry;
  const sessionQuery = (ctx as unknown as { sessionQuery?: SessionQueryService }).sessionQuery;
  let archivedIds = new Set(workspaceRegistry?.archivedSessionIds ?? []);
  const queriedSessionIds = new Set<string>();
  const queriedTitles = new Map<string, string | null>();
  const queriedDetails = new Map<string, { model: string | null; metrics: DashboardAgent['metrics'] }>();
  const metadataFailures = new Set<string>();
  const titleRevisions = new Map<string, number>();
  let sessionOrder: string[] = [];
  let catalogInitialized = false;
  let catalogRefresh: Promise<void> | undefined;
  let catalogReadWarned = false;
  let titleReadWarned = false;
  let lifecycleGeneration = 0;
  const lastActiveModels = new Map<string, string | null>();
  let nextRunningOrder = 0;
  let revision = 0;
  let disposed = false;
  const cleanups: Array<() => void> = [];
  // Only the model name is exposed; the dashboard never requests observation.events.
  cleanups.push(ctx.sessionProjections.register({
    key: modelProjectionKey,
    stateVersion: 1,
    stateSchema: modelSchema,
    init: () => null,
    apply: (state: string | null, event: { type: string; data: { header?: { config?: { model?: unknown } } } }) =>
      event.type === 'request/header' ? confirmedModel(event.data.header?.config?.model) : state,
    wire: { viewSchema: modelSchema, view: (state: string | null) => state },
  } as never));
  let treeTimer: ReturnType<typeof setTimeout> | undefined;
  let treeGeneration = 0;
  const archiveTimer = setInterval(reconcileArchivedSessions, archivePollMs);
  const sessionTimer = setInterval(() => { void refreshSessionCatalog(); }, sessionPollMs);

  function modelOf(agent: Agent): string | null {
    const id = String(agent.id);
    const cachedModel = lastActiveModels.get(id);
    if (typeof cachedModel === 'string' && cachedModel.length <= 160) return cachedModel;
    const headerModel = agent.session.requestHeader()?.config.model;
    if (typeof headerModel === 'string' && headerModel.length <= 160) {
      lastActiveModels.set(id, headerModel);
      return headerModel;
    }
    return unavailable;
  }

  function project(agent: Agent, runningOrder?: number | null): DashboardAgent {
    const id = String(agent.id);
    const previous = agents.get(id);
    queriedTitles.delete(id);
    queriedDetails.delete(id);
    metadataFailures.delete(id);
    const projections = ctx.sessionProjections.snapshot(agent.session, ['tokenUsage', 'contextPressure', 'subagentCatalog', 'title'] as never).values as Record<string, unknown>;
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
    const title = projections.title;
    return {
      id,
      parentId: previous?.parentId ?? null,
      name: id,
      title: typeof title === 'string' && title.trim() ? title : null,
      status: agent.status === 'running' || agent.status === 'idle' ? agent.status : 'unknown',
      task: 'Задача недоступна',
      model: modelOf(agent),
      runningOrder: runningOrder === undefined ? previous?.runningOrder ?? null : runningOrder,
      metrics: metricsFromProjections(projections),
      sourceDiagnostics: [
        ...(!tokenUsage ? ['Token usage projection is unavailable.'] : []),
        ...(!pressure?.contextWindow ? ['Context capacity has not been reported.'] : []),
        ...(!childCatalog ? ['Subagent catalog projection is unavailable.'] : []),
      ],
    };
  }

  function publish(agent: Agent): void {
    if (disposed) return;
    publishEntry(project(agent));
  }

  function publishEntry(entry: DashboardAgent): void {
    const previous = agents.get(entry.id);
    if (previous && previous.status !== entry.status) invalidateTreeRefresh();
    if (entry.status === 'running' && previous?.status !== 'running') {
      entry = { ...entry, runningOrder: ++nextRunningOrder };
      log.info('Agent entered Running.');
    } else if (previous?.runningOrder !== null && previous?.runningOrder !== undefined && entry.runningOrder === null) {
      entry = { ...entry, runningOrder: previous.runningOrder };
    }
    if (previous && JSON.stringify(previous) === JSON.stringify(entry)) return;
    agents.set(entry.id, entry);
    if (archivedIds.has(entry.id)) return;
    revision += 1;
    const event: CollectorEvent = { bootId, revision, generatedAt: now(), agent: structuredClone(entry) };
    for (const listener of [...listeners]) listener(event);
  }

  function on(name: 'agent/created' | 'agent/status' | 'agent/disposed', callback: (payload: { agent: Agent }) => void): void {
    const dispose = ctx.on(name, callback as never);
    if (typeof dispose === 'function') cleanups.push(dispose);
  }

  const initialAgents = ctx.agents.list();
  let initialRunningOrder = initialAgents.filter(agent => agent.status === 'running').length;
  nextRunningOrder = initialRunningOrder;
  for (const agent of initialAgents) {
    const id = String(agent.id);
    const requestModel = agent.session.requestHeader()?.config.model;
    lastActiveModels.set(id, typeof requestModel === 'string' && requestModel.length <= 160 ? requestModel : null);
    agents.set(id, project(agent, agent.status === 'running' ? initialRunningOrder-- : null));
  }
  log.info('Collector started (%d live agents).', agents.size);
  on('agent/created', ({ agent }) => { lifecycleGeneration += 1; publish(agent); scheduleTreeRefresh(); });
  on('agent/status', ({ agent }) => publish(agent));
  on('agent/disposed', ({ agent }) => {
    if (disposed) return;
    lifecycleGeneration += 1;
    const id = String(agent.id);
    queriedTitles.delete(id);
    queriedDetails.delete(id);
    titleRevisions.set(id, (titleRevisions.get(id) ?? 0) + 1);
    if (!agents.delete(id)) return;
    revision += 1;
    const event: CollectorEvent = { bootId, revision, generatedAt: now(), removedId: id };
    for (const listener of [...listeners]) listener(event);
    scheduleTreeRefresh();
  });
  cleanups.push(ctx.sessionProjections.onChanged((session, key) => {
    const agent = ctx.agents.list().find(candidate => candidate.session === session);
    if (!agent) return;
    if (String(key) === 'title') {
      const id = String(agent.id);
      queriedTitles.delete(id);
      titleRevisions.set(id, (titleRevisions.get(id) ?? 0) + 1);
    }
    publish(agent);
    if (key === 'subagentCatalog') scheduleTreeRefresh();
  }));

  cleanups.push(ctx.on('session/event', (session, event) => {
    if (event.type !== 'request/header') return;
    const agent = ctx.agents.get(session.id);
    if (!agent) return;
    const model = event.data.header.config.model;
    lastActiveModels.set(String(agent.id), typeof model === 'string' && model.length <= 160 ? model : null);
    log.info('Confirmed request model updated.');
    publish(agent);
  }));

  scheduleTreeRefresh();
  void refreshSessionCatalog();

  function scheduleTreeRefresh(): void {
    if (disposed) return;
    // Invalidate an asynchronous catalog read as soon as newer lifecycle or
    // projection information arrives, not only when the next read begins.
    treeGeneration += 1;
    if (treeTimer) clearTimeout(treeTimer);
    const generation = treeGeneration;
    treeTimer = setTimeout(() => { void refreshTree(generation); }, 250);
  }

  function invalidateTreeRefresh(): void {
    scheduleTreeRefresh();
  }

  function reconcileArchivedSessions(): void {
    if (disposed || !workspaceRegistry) return;
    const next = new Set(workspaceRegistry.archivedSessionIds);
    const changed = next.size !== archivedIds.size || [...next].some(id => !archivedIds.has(id));
    if (!changed) return;
    const newlyArchived = [...next].filter(id => !archivedIds.has(id));
    const restored = [...archivedIds].filter(id => !next.has(id));
    archivedIds = next;
    if (newlyArchived.length || restored.length) {
      log.info('Archive state changed (%d archived, %d restored).', newlyArchived.length, restored.length);
    }
    for (const id of newlyArchived) publishRemoval(id);
    for (const id of restored) {
      const entry = agents.get(id);
      if (!entry) continue;
      revision += 1;
      const event: CollectorEvent = { bootId, revision, generatedAt: now(), agent: structuredClone(entry) };
      for (const listener of [...listeners]) listener(event);
    }
    scheduleTreeRefresh();
  }

  function publishRemoval(id: string, forget = false): void {
    if (!agents.has(id)) return;
    if (forget) agents.delete(id);
    revision += 1;
    const event: CollectorEvent = { bootId, revision, generatedAt: now(), removedId: id };
    for (const listener of [...listeners]) listener(event);
  }

  function reconcileLiveAgents(): void {
    const liveAgents = ctx.agents.list();
    const liveIds = new Set(liveAgents.map(agent => String(agent.id)));
    for (const agent of liveAgents) {
      const id = String(agent.id);
      if (!agents.has(id)) {
        const model = agent.session.requestHeader()?.config.model;
        lastActiveModels.set(id, typeof model === 'string' && model.length <= 160 ? model : null);
        publish(agent);
      }
    }
    let removedCount = 0;
    for (const [id, entry] of agents) {
      if (!entry.parentId && !liveIds.has(id) && (!sessionQuery || (catalogInitialized && !queriedSessionIds.has(id)))) {
        publishRemoval(id, true);
        removedCount += 1;
      }
    }
    if (removedCount) log.info('Live registry reconciliation removed %d agent(s).', removedCount);
    reconcileArchivedSessions();
  }

  async function refreshSessionCatalog(): Promise<void> {
    if (disposed || !sessionQuery) return;
    if (catalogRefresh) return catalogRefresh;
    catalogRefresh = refreshSessionCatalogInternal().finally(() => { catalogRefresh = undefined; });
    return catalogRefresh;
  }

  async function refreshSessionCatalogInternal(retries = 0): Promise<void> {
    try {
      const startingLifecycleGeneration = lifecycleGeneration;
      const records = await sessionQuery!.listSessions();
      if (disposed) return;
      const usableRecords = records.filter(record => typeof record?.header?.id === 'string' && record.header.id.length > 0);
      const currentIds = new Set(usableRecords.map(record => record.header.id));
      const liveAtRead = new Map(ctx.agents.list().map(agent => [String(agent.id), agent]));
      const titleIds = usableRecords
        .filter(record => !archivedIds.has(record.header.id) && !liveAtRead.has(record.header.id) && !queriedTitles.has(record.header.id))
        .map(record => record.header.id);
      if (titleIds.length) {
        const readRevisions = new Map(titleIds.map(id => [id, titleRevisions.get(id) ?? 0]));
        let failed = false;
        const canCommit = (id: string) => !disposed && !ctx.agents.get(id as never)
          && readRevisions.get(id) === (titleRevisions.get(id) ?? 0);
        const fail = (id: string) => {
          if (!canCommit(id)) return;
          failed = true;
          metadataFailures.add(id);
        };
        if (sessionQuery!.observeSession) {
          let cursor = 0;
          const worker = async () => {
            while (!disposed && cursor < titleIds.length) {
              const id = titleIds[cursor++];
              let observation: SessionObservation | undefined;
              try {
                observation = await sessionQuery!.observeSession!(id);
                if (!canCommit(id)) continue;
                const values = observation.projections?.values;
                if (!values) { fail(id); continue; }
                const title = values.title;
                queriedTitles.set(id, typeof title === 'string' && title.trim() ? title : null);
                queriedDetails.set(id, { model: confirmedModel(values[modelProjectionKey]), metrics: metricsFromProjections(values) });
                metadataFailures.delete(id);
              } catch {
                fail(id);
              } finally {
                observation?.[Symbol.dispose]();
              }
            }
          };
          await Promise.all(Array.from({ length: Math.min(4, titleIds.length) }, worker));
        } else {
          // Compatibility fallback: the official title snapshot wraps the text in title.title.
          try {
            const results = await sessionQuery!.readTitleSnapshots(titleIds);
            for (const [index, result] of results.entries()) {
              const id = titleIds[index];
              if (!id || !canCommit(id)) continue;
              if (result.status !== 'fulfilled') { fail(id); continue; }
              const title = result.value?.title?.title;
              queriedTitles.set(id, typeof title === 'string' && title.trim() ? title : null);
              metadataFailures.delete(id);
            }
          } catch {
            for (const id of titleIds) fail(id);
          }
        }
        if (disposed) return;
        if (failed && !titleReadWarned) log.warn('Some persisted session metadata could not be read; retrying.');
        titleReadWarned = failed;
      }

      if (startingLifecycleGeneration !== lifecycleGeneration && retries < 2) {
        return refreshSessionCatalogInternal(retries + 1);
      }

      const liveById = new Map(ctx.agents.list().map(agent => [String(agent.id), agent]));
      const catalogOrder: string[] = [];
      for (const record of usableRecords) {
        const id = record.header.id;
        if (archivedIds.has(id)) continue;
        catalogOrder.push(id);
        const liveAgent = liveById.get(id);
        if (liveAgent) {
          publishEntry(project(liveAgent));
          continue;
        }
        const existing = agents.get(id);
        const title = queriedTitles.get(id) ?? null;
        const details = queriedDetails.get(id);
        publishEntry({
          id,
          parentId: existing?.parentId ?? null,
          name: existing?.name ?? id,
          title,
          status: 'unknown',
          task: 'Задача недоступна',
          model: details?.model ?? null,
          runningOrder: existing?.runningOrder ?? null,
          metrics: details?.metrics ?? metricsFromProjections({}),
          sourceDiagnostics: [
            'Session is persisted, but no live agent is currently loaded. Metrics describe the saved session.',
            ...(metadataFailures.has(id) ? ['Persisted session metadata could not be read; retrying.'] : []),
          ],
        });
      }
      sessionOrder = catalogOrder;
      for (const id of [...queriedSessionIds]) {
        if (currentIds.has(id) || liveById.has(id)) continue;
        publishRemoval(id, true);
        queriedTitles.delete(id);
        queriedDetails.delete(id);
        metadataFailures.delete(id);
        queriedSessionIds.delete(id);
      }
      for (const id of currentIds) queriedSessionIds.add(id);
      catalogInitialized = true;
      for (const [id, entry] of agents) {
        if (archivedIds.has(id) || currentIds.has(id) || liveById.has(id) || entry.parentId) continue;
        publishRemoval(id, true);
      }
      catalogReadWarned = false;
      reconcileArchivedSessions();
    } catch (error) {
      if (catalogReadWarned || disposed) return;
      catalogReadWarned = true;
      const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name) ? error.name : 'Error';
      log.warn('Persisted session catalog read failed (%s).', name);
    }
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
            title: null,
            status: current?.status === 'running' || current?.status === 'idle' ? current.status : 'unknown',
            task: 'Задача недоступна',
            model: current ? modelOf(current) : unavailable,
            runningOrder: agents.get(String(row.id))?.runningOrder ?? null,
            metrics: {
              context: { used: unavailable, capacity: unavailable, estimated: false },
              tokens: null,
              children: { direct: row.hasChildren ? unavailable : 0, total: unavailable },
              durationMs: unavailable,
            },
            sourceDiagnostics: current ? [] : ['Child session is known from its parent catalog; live status is unavailable.'],
          });
        }
      } catch (error) {
        const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name) ? error.name : 'Error';
        log.warn('Subagent catalog read failed (%s).', name);
        diagnosticsByParent.set(String(root.id), ['Subagent catalog could not be read. Check the Host log for the error category.']);
      }
      if (generation !== treeGeneration || disposed) return;
    }
    const liveIds = new Set(liveAgents.map(agent => String(agent.id)));
    for (const id of [...agents.keys()]) {
      if (!liveIds.has(id) && !discovered.has(id) && !queriedSessionIds.has(id)) {
        agents.delete(id);
        revision += 1;
        const event: CollectorEvent = { bootId, revision, generatedAt: now(), removedId: id };
        for (const listener of [...listeners]) listener(event);
      }
    }
    for (const [id, entry] of discovered) {
      const withDiagnostics = { ...entry, sourceDiagnostics: [...entry.sourceDiagnostics, ...(diagnosticsByParent.get(id) ?? [])] };
      if (archivedIds.has(id)) continue;
      publishEntry(withDiagnostics);
    }
    for (const [id, diagnostics] of diagnosticsByParent) {
      if (archivedIds.has(id)) continue;
      const parent = agents.get(id);
      if (!parent) continue;
      const updated = { ...parent, sourceDiagnostics: [...new Set([...parent.sourceDiagnostics, ...diagnostics])] };
      publishEntry(updated);
    }
    for (const parentAgent of liveAgents) {
      const id = String(parentAgent.id);
      if (archivedIds.has(id)) continue;
      if (!agents.has(id)) continue;
      const updated = project(parentAgent);
      updated.sourceDiagnostics = [
        ...updated.sourceDiagnostics,
        ...(diagnosticsByParent.get(id) ?? []),
      ];
      publishEntry(updated);
    }
  }

  return {
    snapshot(): DashboardSnapshot {
      reconcileLiveAgents();
      const orderedIds = [...sessionOrder, ...[...agents.keys()].filter(id => !sessionOrder.includes(id))];
      return { bootId, revision, generatedAt: now(), completeness: 'partial', agents: orderedIds.map(id => agents.get(id)).filter((entry): entry is DashboardAgent => entry !== undefined && !archivedIds.has(entry.id)).map(entry => structuredClone(entry)) };
    },
    async refresh(): Promise<void> {
      reconcileLiveAgents();
      await refreshSessionCatalog();
      reconcileLiveAgents();
    },
    subscribe(listener: (event: CollectorEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearInterval(archiveTimer);
      clearInterval(sessionTimer);
      if (treeTimer) clearTimeout(treeTimer);
      treeGeneration += 1;
      for (const cleanup of cleanups.splice(0)) cleanup();
      listeners.clear();
      agents.clear();
      log.info('Collector stopped.');
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
