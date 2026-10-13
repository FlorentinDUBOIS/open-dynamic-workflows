import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectOdwWorkflows, controlCommand } from '../src/tui-state.js';

test('TUI projection filters to focused ODW children and groups by workflow', () => {
  const children = [
    { id: 'c1', parentID: 'parent', metadata: { odw: true, odwWorkflowID: 'odw_ab', odwNodeID: 'n1', odwRole: 'analysis', odwProfile: 'quality' }, time: { created: 10, updated: 30 } },
    { id: 'c2', parentID: 'parent', metadata: { odw: true, odwWorkflowID: 'odw_ab', odwNodeID: 'n2', odwRole: 'verification' }, time: { created: 12, updated: 40 } },
    { id: 'other', parentID: 'other-parent', metadata: { odw: true, odwWorkflowID: 'odw_cd' } },
  ];
  const workflows = collectOdwWorkflows(
    'parent',
    children,
    (id) => (id === 'c1' ? 'running' : 'idle'),
    (id) => id === 'c2' ? [{ type: 'user' }, { type: 'assistant', model: { providerID: 'openai', id: 'gpt-5.6-sol' }, time: { completed: 35 } }] : [],
  );
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0].status, 'running');
  assert.equal(workflows[0].profile, 'quality');
  assert.equal(workflows[0].nodes[1].model, 'openai/gpt-5.6-sol');
});

test('TUI node status follows the session status, retry schedule and assistant error', () => {
  const child = (id) => ({ id, parentID: 'parent', metadata: { odw: true, odwWorkflowID: 'odw_ab' } });
  const states = collectOdwWorkflows(
    'parent',
    [child('waiting'), child('failed'), child('done'), child('fresh')],
    (id) => (id === 'waiting' ? 'running' : 'idle'),
    (id) => ({
      waiting: [{ type: 'assistant', retry: { attempt: 2, at: Date.now() + 60_000 } }],
      failed: [{ type: 'assistant', error: { type: 'provider.internal', message: 'boom' } }],
      done: [{ type: 'assistant', time: { completed: 5 } }],
      fresh: [],
    })[id],
  );
  const byID = Object.fromEntries(states[0].nodes.map((node) => [node.sessionID, node]));
  assert.equal(byID.waiting.status, 'retrying');
  assert.equal(byID.failed.status, 'error');
  assert.equal(byID.failed.error, 'boom');
  assert.equal(byID.done.status, 'completed');
  assert.equal(byID.fresh.status, 'queued');
});

test('TUI controls produce reserved session commands', () => {
  assert.deepEqual(controlCommand('odw_ab12', 'pause'), { name: 'odw-control', text: 'odw_ab12 pause' });
  assert.throws(() => controlCommand('../bad', 'stop'), /invalid ODW workflow id/);
});
