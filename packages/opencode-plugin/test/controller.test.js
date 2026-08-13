import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowController, parseControlArguments } from '../src/controller.js';
import { createSessionState } from '../src/session-state.js';

function harness() {
  const state = createSessionState();
  const controller = createWorkflowController({
    client: {},
    directory: '/tmp',
    state,
    lockOptions: {
      root: `/tmp/odw-controller-${process.pid}-${Math.random().toString(16).slice(2)}`,
    },
    createBackend: () => ({ invoke() {}, async dispose() {} }),
    createOrchestrator: () => ({
      async start() {
        return {
          workflowId: 'engine-1',
          plan: { topology: 'parallel' },
          completion: Promise.resolve({ workflowId: 'engine-1', status: 'completed', result: 'ok', plan: { topology: 'parallel' } }),
        };
      },
      async control(_id, action) { return { status: action }; },
      reconcileNode(_id, nodeID, input) { return { nodeID, ...input }; },
    }),
  });
  return { controller, state };
}

test('controller owns one session lock and retains completed workflows', async () => {
  const { controller } = harness();
  const first = await controller.start({ sessionID: 'parent-1', prompt: 'one' });
  const second = await controller.start({ sessionID: 'parent-1', prompt: 'two', profile: 'quality' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const workflows = controller.list('parent-1');
  assert.equal(workflows.length, 2);
  assert.equal(workflows.find((item) => item.id === first.id).status, 'completed');
  assert.equal(workflows.find((item) => item.id === second.id).profile, 'quality');
  await controller.remove('parent-1');
});

test('control parser is strict', () => {
  assert.deepEqual(parseControlArguments('odw_1 pause'), { workflowID: 'odw_1', action: 'pause' });
  assert.deepEqual(parseControlArguments('odw_1 replay node_1 effect absent'), {
    workflowID: 'odw_1', action: 'replay', nodeID: 'node_1', evidence: 'effect absent',
  });
  assert.throws(() => parseControlArguments('odw_1 replay'), /usage/);
});
