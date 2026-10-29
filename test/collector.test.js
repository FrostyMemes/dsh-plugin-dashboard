import assert from 'node:assert/strict';
import test from 'node:test';
import { createCollector } from '../dist/host/collector.js';

function createHarness(initialAgents = [], { sessionQuery = false } = {}) {
  const agents = [...initialAgents];
  const handlers = new Map();
  const projectionListeners = new Set();
  const projections = new Map();
  const descendants = new Map();
  const logs = [];
  const projectionDefinitions = [];
  const workspaceRegistry = { archivedSessionIds: [] };
  const sessionCatalog = [];
  const sessionTitles = new Map();
  const ctx = {
    logger: name => Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, (message, ...args) => logs.push({ name, level, message, args })])),
    agents: {
      list: () => agents,
      get: id => agents.find(agent => agent.id === id),
    },
    workspaceRegistry,
    on(name, callback) {
      const callbacks = handlers.get(name) ?? new Set();
      callbacks.add(callback);
      handlers.set(name, callbacks);
      return () => callbacks.delete(callback);
    },
    sessionProjections: {
      register: definition => { projectionDefinitions.push(definition); return () => {}; },
      snapshot: session => ({ values: projections.get(session) ?? {} }),
      onChanged(callback) {
        projectionListeners.add(callback);
        return () => projectionListeners.delete(callback);
      },
    },
    subagents: {
      listDescendants: async id => descendants.get(id) ?? [],
    },
  };
  if (sessionQuery) {
    ctx.sessionQuery = {
      listSessions: async () => sessionCatalog,
      readTitleSnapshots: async ids => ids.map(id => ({ status: 'fulfilled', value: { session: { id }, title: sessionTitles.has(id) ? { title: sessionTitles.get(id) } : undefined } })),
    };
  }
  return {
    ctx,
    agents,
    projections,
    descendants,
    logs,
    projectionDefinitions,
    emit(name, ...args) { for (const callback of handlers.get(name) ?? []) callback(...args); },
    changeProjection(session, key) { for (const callback of projectionListeners) callback(session, key); },
    workspaceRegistry,
    sessionCatalog,
    sessionTitles,
  };
}

const agent = (id, status = 'idle', session = {}) => {
  session.id = id;
  if (typeof session.requestHeader !== 'function') session.requestHeader = () => ({ config: { model: session.model ?? 'actual-model' } });
  return { id, status, session, options: { model: 'configured-model' } };
};

test('collector snapshots live agents and does not infer successful completion from idle', () => {
  const live = agent('root-1', 'idle');
  const harness = createHarness([live]);
  const collector = createCollector(harness.ctx, { bootId: 'boot-a' });

  const snapshot = collector.snapshot();
  assert.equal(snapshot.bootId, 'boot-a');
  assert.equal(snapshot.revision, 0);
  assert.equal(snapshot.completeness, 'partial');
  assert.equal(snapshot.agents.length, 1);
  assert.equal(snapshot.agents[0].status, 'idle');
  assert.equal(snapshot.agents[0].task, 'Задача недоступна');
  assert.equal(snapshot.agents[0].metrics.tokens, null);
  assert.equal(snapshot.agents[0].metrics.context.capacity, null);
  assert.equal(snapshot.agents[0].model, 'actual-model');
  assert.equal(snapshot.agents[0].title, null);
  collector.dispose();
});

test('collector handles repeated IDs as updates, forwards unknown status, and removes disposed agents', () => {
  const live = agent('root-1', 'running');
  const harness = createHarness([live]);
  const collector = createCollector(harness.ctx, { bootId: 'boot-b' });
  const events = [];
  collector.subscribe(event => events.push(event));

  live.status = 'idle';
  harness.emit('agent/status', { agent: live });
  assert.equal(collector.snapshot().agents.length, 1);
  assert.equal(collector.snapshot().agents[0].status, 'idle');

  live.status = 'finished';
  harness.emit('agent/status', { agent: live });
  assert.equal(collector.snapshot().agents[0].status, 'unknown');

  harness.agents.splice(0, 1);
  harness.emit('agent/disposed', { agent: live });
  assert.equal(collector.snapshot().agents.length, 0);
  assert.deepEqual(events.map(event => event.revision), [1, 2, 3]);
  assert.equal(events[2].removedId, 'root-1');
  collector.dispose();
});

test('collector reconciles all currently live agents before producing a reconnect snapshot', () => {
  const existing = agent('existing');
  const harness = createHarness([existing]);
  const collector = createCollector(harness.ctx, { bootId: 'boot-resync' });
  const late = agent('late-registry-agent', 'running');
  harness.agents.push(late);

  const snapshot = collector.snapshot();
  assert.deepEqual(snapshot.agents.map(item => item.id), ['existing', 'late-registry-agent']);
  assert.equal(snapshot.agents[1].status, 'running');
  assert.equal(snapshot.agents[1].model, 'actual-model');
  collector.dispose();
});

test('collector restores persisted session tiles without loading agents and removes deleted sessions on refresh', async () => {
  const current = agent('current-session', 'idle');
  const harness = createHarness([current], { sessionQuery: true });
  harness.sessionCatalog.push(
    { header: { id: 'current-session' }, live: true, persisted: true },
    { header: { id: 'older-session' }, live: false, persisted: true },
    { header: { id: 'another-session' }, live: false, persisted: true },
  );
  harness.sessionTitles.set('older-session', 'Модель ИИ идентификация');
  harness.sessionTitles.set('another-session', 'Тест');
  const collector = createCollector(harness.ctx, { bootId: 'boot-persisted' });
  const events = [];

  await collector.refresh();
  await new Promise(resolve => setTimeout(resolve, 350));
  collector.subscribe(event => events.push(event));
  const initial = collector.snapshot();
  assert.deepEqual(initial.agents.map(item => item.id), ['current-session', 'older-session', 'another-session']);
  assert.equal(initial.agents[0].status, 'idle');
  assert.equal(initial.agents[1].status, 'unknown');
  assert.equal(initial.agents[1].title, 'Модель ИИ идентификация');
  assert.equal(initial.agents[1].model, null);
  assert.equal(initial.agents[2].status, 'unknown');
  assert.equal(initial.agents[2].title, 'Тест');

  harness.sessionCatalog.splice(2, 1);
  await collector.refresh();
  assert.deepEqual(collector.snapshot().agents.map(item => item.id), ['current-session', 'older-session']);
  assert.ok(events.some(event => event.removedId === 'another-session'));
  collector.dispose();
});

test('collector refreshes a persisted title after the session has been loaded and renamed', async () => {
  const harness = createHarness([], { sessionQuery: true });
  harness.sessionCatalog.push({ header: { id: 'renamed-session' }, live: false, persisted: true });
  harness.sessionTitles.set('renamed-session', 'Old title');
  const collector = createCollector(harness.ctx);
  await collector.refresh();
  assert.equal(collector.snapshot().agents[0].title, 'Old title');

  const live = agent('renamed-session');
  harness.agents.push(live);
  harness.projections.set(live.session, { title: 'New title' });
  harness.changeProjection(live.session, 'title');
  assert.equal(collector.snapshot().agents[0].title, 'New title');

  harness.agents.splice(0, 1);
  harness.emit('agent/disposed', { agent: live });
  harness.sessionTitles.set('renamed-session', 'New title');
  await collector.refresh();
  assert.equal(collector.snapshot().agents[0].title, 'New title');
  collector.dispose();
});

test('collector rechecks the live registry when lifecycle events happen during a title read', async () => {
  const oldLive = agent('still-persisted', 'running');
  const harness = createHarness([oldLive], { sessionQuery: true });
  harness.sessionCatalog.push(
    { header: { id: 'still-persisted' }, live: true, persisted: true },
    { header: { id: 'cold-session' }, live: false, persisted: true },
  );
  let titleReadStarted;
  const started = new Promise(resolve => { titleReadStarted = resolve; });
  let resolveTitles;
  let titleReadCount = 0;
  harness.ctx.sessionQuery.readTitleSnapshots = ids => new Promise(resolve => {
    titleReadCount += 1;
    if (titleReadCount > 1) {
      resolve(ids.map(id => ({ status: 'fulfilled', value: { session: { id }, title: { title: 'Cold title' } } })));
      return;
    }
    resolveTitles = () => resolve(ids.map(id => ({ status: 'fulfilled', value: { session: { id }, title: { title: 'Cold title' } } })));
    titleReadStarted();
  });
  const collector = createCollector(harness.ctx);

  const refreshing = collector.refresh();
  await started;
  harness.agents.splice(0, 1);
  harness.emit('agent/disposed', { agent: oldLive });
  const newLive = agent('created-during-read', 'running');
  harness.agents.push(newLive);
  harness.emit('agent/created', { agent: newLive });
  resolveTitles();
  await refreshing;

  const rows = collector.snapshot().agents;
  assert.equal(rows.find(item => item.id === 'still-persisted')?.status, 'unknown');
  assert.equal(rows.find(item => item.id === 'created-during-read')?.status, 'running');
  assert.equal(rows.find(item => item.id === 'cold-session')?.title, 'Cold title');
  collector.dispose();
});

test('collector retries a failed persisted title read instead of caching the missing title', async () => {
  const harness = createHarness([], { sessionQuery: true });
  harness.sessionCatalog.push({ header: { id: 'title-retry' }, live: false, persisted: true });
  let attempts = 0;
  harness.ctx.sessionQuery.readTitleSnapshots = async ids => {
    attempts += 1;
    return ids.map(id => attempts === 1
      ? { status: 'rejected', reason: new Error('temporary') }
      : { status: 'fulfilled', value: { session: { id }, title: { title: 'Recovered title' } } });
  };
  const collector = createCollector(harness.ctx);

  await collector.refresh();
  assert.equal(collector.snapshot().agents[0].title, null);
  await collector.refresh();
  assert.equal(collector.snapshot().agents[0].title, 'Recovered title');
  assert.equal(attempts, 2);
  collector.dispose();
});

test('collector reconciliation broadcasts removals to existing subscribers', () => {
  const live = agent('root-removed');
  const harness = createHarness([live]);
  const collector = createCollector(harness.ctx);
  const events = [];
  collector.subscribe(event => events.push(event));
  harness.agents.splice(0, 1);

  assert.equal(collector.snapshot().agents.length, 0);
  assert.equal(events.at(-1).removedId, live.id);
  collector.dispose();
});

test('catalog-only children remain unknown until a live agent confirms status', async () => {
  const parent = agent('parent-1', 'running');
  const harness = createHarness([parent]);
  harness.descendants.set(parent.id, [{ kind: 'agent', id: 'child-1', parentId: parent.id, label: 'Child', hasChildren: false }]);
  const collector = createCollector(harness.ctx, { bootId: 'boot-c' });
  await new Promise(resolve => setTimeout(resolve, 350));

  const child = collector.snapshot().agents.find(item => item.id === 'child-1');
  assert.ok(child);
  assert.equal(child.status, 'unknown');
  assert.equal(child.metrics.children.direct, 0);
  assert.match(child.sourceDiagnostics.join(' '), /live status is unavailable/);
  collector.dispose();
});

test('collector updates session title and last active model without retaining session content', () => {
  const live = agent('root-title');
  const harness = createHarness([live]);
  harness.projections.set(live.session, { title: 'A named session' });
  const collector = createCollector(harness.ctx, { bootId: 'boot-title' });

  assert.equal(collector.snapshot().agents[0].title, 'A named session');
  live.status = 'running';
  harness.emit('agent/status', { agent: live });
  assert.equal(collector.snapshot().agents[0].model, 'actual-model');
  assert.equal(collector.snapshot().agents[0].runningOrder, 1);
  harness.projections.set(live.session, { title: 'Renamed before next request' });
  harness.changeProjection(live.session, 'title');
  assert.equal(collector.snapshot().agents[0].model, 'actual-model');

  harness.emit('session/event', live.session, { type: 'request/header', data: { header: { config: { model: 'active-model' } } } });
  assert.equal(collector.snapshot().agents[0].model, 'active-model');
  live.status = 'idle';
  harness.emit('agent/status', { agent: live });
  assert.equal(collector.snapshot().agents[0].model, 'active-model');

  harness.projections.set(live.session, { title: 'Renamed session' });
  harness.changeProjection(live.session, 'title');
  assert.equal(collector.snapshot().agents[0].title, 'Renamed session');
  assert.equal(collector.snapshot().agents[0].model, 'active-model');
  collector.dispose();
});

test('collector keeps the last confirmed model until the next request header arrives', () => {
  const live = agent('root-no-new-request', 'idle');
  const harness = createHarness([live]);
  const collector = createCollector(harness.ctx);

  live.status = 'running';
  harness.emit('agent/status', { agent: live });
  assert.equal(collector.snapshot().agents[0].model, 'actual-model');
  live.status = 'idle';
  harness.emit('agent/status', { agent: live });
  assert.equal(collector.snapshot().agents[0].model, 'actual-model');
  collector.dispose();
});

test('collector accepts a request model event that arrives just before the Running transition', () => {
  const live = agent('root-header-before-running', 'idle');
  const harness = createHarness([live]);
  const collector = createCollector(harness.ctx);

  harness.emit('session/event', live.session, { type: 'request/header', data: { header: { config: { model: 'selected-model' } } } });
  live.status = 'running';
  harness.emit('agent/status', { agent: live });
  assert.equal(collector.snapshot().agents[0].model, 'selected-model');
  collector.dispose();
});

test('collector removes archived sessions from snapshots and restores live sessions when unarchived', async () => {
  const live = agent('root-archive');
  const harness = createHarness([live]);
  const collector = createCollector(harness.ctx, { bootId: 'boot-archive', archivePollMs: 5 });
  const events = [];
  collector.subscribe(event => events.push(event));

  harness.workspaceRegistry.archivedSessionIds.push(live.id);
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(events.at(-1).removedId, live.id);
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(events.some(event => event.agent?.id === live.id), false);

  harness.workspaceRegistry.archivedSessionIds.length = 0;
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(events.at(-1).agent.id, live.id);
  assert.equal(collector.snapshot().agents.length, 1);
  collector.dispose();
});

test('collector logs concise lifecycle events without session data', () => {
  const live = agent('private-session-id');
  const harness = createHarness([live]);
  harness.projections.set(live.session, { title: 'Private user prompt text' });
  const collector = createCollector(harness.ctx);
  live.status = 'running';
  harness.emit('agent/status', { agent: live });

  const serialized = JSON.stringify(harness.logs);
  assert.match(serialized, /Collector started/);
  assert.match(serialized, /entered Running/);
  assert.doesNotMatch(serialized, /private-session-id|Private user prompt text|actual-model/);
  collector.dispose();
});


test('cold dashboard fills metadata for unopened sessions without reading raw events or creating agents', async t => {
  const live = agent('open-session');
  const harness = createHarness([live], { sessionQuery: true });
  harness.sessionCatalog.push(
    { header: { id: 'open-session' }, live: true, persisted: true },
    { header: { id: 'cold-a' }, live: false, persisted: true },
    { header: { id: 'cold-b' }, live: false, persisted: true },
  );
  const released = [];
  const reads = [];
  harness.ctx.sessionQuery.observeSession = async id => {
    reads.push(id);
    return {
      projections: { values: {
        title: id === 'cold-a' ? 'Тест1' : 'Тест 2',
        agentControlCenterLastModel: id === 'cold-a' ? 'qwen3.8-flash' : 'minimax-m3',
        tokenUsage: { uncachedInputTokens: 17, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 9 },
        contextPressure: { projectedTokens: 975, contextWindow: 1000000 },
        subagentCatalog: [],
      } },
      get events() { throw new Error('Dashboard must not access raw session events'); },
      [Symbol.dispose]() { released.push(id); },
    };
  };
  const collector = createCollector(harness.ctx);
  t.after(() => collector.dispose());
  await collector.refresh();
  const rows = collector.snapshot().agents;
  assert.deepEqual(rows.map(row => row.title), [null, 'Тест1', 'Тест 2']);
  assert.deepEqual(rows.slice(1).map(row => row.model), ['qwen3.8-flash', 'minimax-m3']);
  assert.ok(rows.slice(1).every(row => row.status === 'unknown'));
  assert.deepEqual(rows[1].metrics.tokens, { input: 17, output: 2, cacheRead: 0, cacheWrite: 9 });
  assert.deepEqual(rows[1].metrics.context, { used: 975, capacity: 1000000, estimated: true });
  assert.equal(rows[1].metrics.children.direct, 0);
  assert.deepEqual(harness.agents, [live]);
  assert.deepEqual(released.sort(), ['cold-a', 'cold-b']);
  await collector.refresh();
  assert.equal(reads.length, 2, 'successful metadata is reused instead of replaying history on every poll');
  const definition = harness.projectionDefinitions.find(item => item.key === 'agentControlCenterLastModel');
  let state = definition.init();
  state = definition.apply(state, { type: 'request/header', data: { header: { config: { model: 'confirmed-model', secret: 'hidden' } } } });
  state = definition.apply(state, { type: 'user/message', data: { content: 'private prompt' } });
  assert.equal(definition.wire.view(state), 'confirmed-model');
});

test('cold metadata failures retry independently and do not flood logs', async t => {
  const harness = createHarness([], { sessionQuery: true });
  harness.sessionCatalog.push({ header: { id: 'retry-cold' }, live: false, persisted: true });
  let attempts = 0;
  let releases = 0;
  harness.ctx.sessionQuery.observeSession = async () => {
    if (++attempts < 3) throw new Error('private backend detail must not be logged');
    return { projections: { values: { title: 'Recovered', agentControlCenterLastModel: 'last-model' } }, [Symbol.dispose]() { releases++; } };
  };
  const collector = createCollector(harness.ctx);
  t.after(() => collector.dispose());
  await collector.refresh();
  assert.match(collector.snapshot().agents[0].sourceDiagnostics.join(' '), /retrying/);
  await collector.refresh();
  await collector.refresh();
  const row = collector.snapshot().agents[0];
  assert.equal(row.title, 'Recovered');
  assert.equal(row.model, 'last-model');
  assert.equal(releases, 1);
  assert.equal(harness.logs.filter(entry => entry.level === 'warn').length, 1);
  assert.ok(!JSON.stringify(harness.logs).includes('private backend detail'));
});

test('live activation wins over an in-flight cold metadata read and releases its lease', async t => {
  const harness = createHarness([], { sessionQuery: true });
  harness.sessionCatalog.push({ header: { id: 'activating' }, live: false, persisted: true });
  let resolveRead;
  let released = false;
  const started = new Promise(resolve => {
    harness.ctx.sessionQuery.observeSession = () => { resolve(); return new Promise(done => { resolveRead = done; }); };
  });
  const collector = createCollector(harness.ctx);
  t.after(() => collector.dispose());
  const refreshing = collector.refresh();
  await started;
  const active = agent('activating', 'running');
  harness.agents.push(active);
  harness.projections.set(active.session, { title: 'Live title' });
  harness.emit('agent/created', { agent: active });
  resolveRead({ projections: { values: { title: 'Stale cold title', agentControlCenterLastModel: 'stale-model' } }, [Symbol.dispose]() { released = true; } });
  await refreshing;
  const row = collector.snapshot().agents[0];
  assert.equal(row.title, 'Live title');
  assert.equal(row.status, 'running');
  assert.equal(row.model, 'actual-model');
  assert.equal(released, true);
});


test('unloading a previously opened session refreshes its saved metadata without a disposed event', async t => {
  const harness = createHarness([], { sessionQuery: true });
  harness.sessionCatalog.push({ header: { id: 'open-then-cold' }, live: false, persisted: true });
  let title = 'Old saved title';
  harness.ctx.sessionQuery.observeSession = async () => ({
    projections: { values: { title, agentControlCenterLastModel: 'saved-model' } },
    [Symbol.dispose]() {},
  });
  const collector = createCollector(harness.ctx);
  t.after(() => collector.dispose());
  await collector.refresh();
  const live = agent('open-then-cold');
  harness.agents.push(live);
  harness.projections.set(live.session, { title: 'New live title' });
  harness.emit('agent/created', { agent: live });
  assert.equal(collector.snapshot().agents[0].title, 'New live title');
  harness.agents.splice(0);
  title = 'New saved title';
  await collector.refresh();
  assert.equal(collector.snapshot().agents[0].title, 'New saved title');
  assert.equal(collector.snapshot().agents[0].status, 'unknown');
});
