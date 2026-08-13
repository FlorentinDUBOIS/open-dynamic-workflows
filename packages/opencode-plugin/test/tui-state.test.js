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
    (id) => ({ type: id === 'c1' ? 'busy' : 'idle' }),
    (id) => id === 'c2' ? [{ role: 'assistant', model: { providerID: 'openai', modelID: 'gpt-5.6-sol' }, time: { completed: 35 } }] : [],
  );
  assert.equal(workflows.length, 1);
  assert.equal(workflows[0].status, 'running');
  assert.equal(workflows[0].profile, 'quality');
  assert.equal(workflows[0].nodes[1].model, 'openai/gpt-5.6-sol');
});

test('TUI controls produce reserved session commands', () => {
  assert.deepEqual(controlCommand('odw_ab12', 'pause'), { command: 'odw-control', arguments: 'odw_ab12 pause' });
  assert.throws(() => controlCommand('../bad', 'stop'), /invalid ODW workflow id/);
});
