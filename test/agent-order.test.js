import assert from 'node:assert/strict';
import test from 'node:test';
import { orderAgents } from '../src/web/agent-order.mjs';

test('running agents precede idle agents, newest running transition first, ties stay stable', () => {
  const source = [
    { id: 'unknown', status: 'unknown', runningOrder: null },
    { id: 'running-old', status: 'running', runningOrder: 2 },
    { id: 'running-new', status: 'running', runningOrder: 3 },
    { id: 'running-tie', status: 'running', runningOrder: 3 },
    { id: 'idle', status: 'idle', runningOrder: null },
  ];

  assert.deepEqual(orderAgents(source).map(agent => agent.id), [
    'running-new', 'running-tie', 'running-old', 'idle', 'unknown',
  ]);
  assert.deepEqual(source.map(agent => agent.id), [
    'unknown', 'running-old', 'running-new', 'running-tie', 'idle',
  ]);
});

test('an agent that exits Running moves behind every remaining Running agent', () => {
  const agents = [
    { id: 'just-finished', status: 'idle', runningOrder: 4 },
    { id: 'still-running', status: 'running', runningOrder: 2 },
    { id: 'unknown', status: 'unknown', runningOrder: null },
  ];
  assert.deepEqual(orderAgents(agents).map(agent => agent.id), [
    'still-running', 'just-finished', 'unknown',
  ]);
});
