import assert from 'node:assert/strict';
import test from 'node:test';
import { createCollector } from '../dist/host/collector.js';

function createHarness(initialAgents = []) {
  const agents = [...initialAgents];
  const handlers = new Map();
  const projectionListeners = new Set();
  const projections = new Map();
  const descendants = new Map();
  const ctx = {
    agents: {
      list: () => agents,
      get: id => agents.find(agent => agent.id === id),
    },
    on(name, callback) {
      const callbacks = handlers.get(name) ?? new Set();
      callbacks.add(callback);
      handlers.set(name, callbacks);
      return () => callbacks.delete(callback);
    },
    sessionProjections: {
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
  return {
    ctx,
    agents,
    projections,
    descendants,
    emit(name, payload) { for (const callback of handlers.get(name) ?? []) callback(payload); },
  };
}

const agent = (id, status = 'idle', session = {}) => ({ id, status, session, options: { model: 'test-model' } });

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
