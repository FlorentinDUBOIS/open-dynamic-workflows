import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowController, parseControlArguments } from '../src/controller.js';
import { createSessionState } from '../src/session-state.js';
import { hasFlock, NO_FLOCK } from './flock.js';

function harness() {
  const backends = [];
  const state = createSessionState();
  const controller = createWorkflowController({
    host: {},
    directory: '/tmp',
    state,
    lockOptions: {
      root: `/tmp/odw-controller-${process.pid}-${Math.random().toString(16).slice(2)}`,
    },
    createBackend: (host, backendOptions) => {
      backends.push({ host, backendOptions });
      return { invoke() {}, async dispose() {} };
    },
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
  return { controller, state, backends };
}

test('controller owns one session lock and retains completed workflows', async () => {
  const { controller } = harness();
  if (!hasFlock) {
    await assert.rejects(() => controller.start({ sessionID: 'parent-1', prompt: 'one' }), NO_FLOCK);
    return;
  }
  const first = await controller.start({ sessionID: 'parent-1', prompt: 'one' });
  const second = await controller.start({ sessionID: 'parent-1', prompt: 'two', profile: 'quality' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const workflows = controller.list('parent-1');
  assert.equal(workflows.length, 2);
  assert.equal(workflows.find((item) => item.id === first.id).status, 'completed');
  assert.equal(workflows.find((item) => item.id === second.id).profile, 'quality');
  await controller.remove('parent-1');
});

test('controller hands the backend its parent session and workflow id', async () => {
  const { controller, backends } = harness();
  if (!hasFlock) {
    await assert.rejects(() => controller.start({ sessionID: 'parent-2', prompt: 'one', agent: 'build' }), NO_FLOCK);
    assert.equal(backends.length, 0, 'no backend is created for a workflow that cannot own its session');
    return;
  }
  const workflow = await controller.start({ sessionID: 'parent-2', prompt: 'one', agent: 'build' });
  assert.equal(backends.length, 1);
  assert.deepEqual(backends[0].host, {});
  assert.equal(backends[0].backendOptions.parentSessionID, 'parent-2');
  assert.equal(backends[0].backendOptions.workflowID, workflow.id);
  assert.equal(backends[0].backendOptions.agent, 'build');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await controller.remove('parent-2');
});

test('control parser is strict', () => {
  assert.deepEqual(parseControlArguments('odw_1 pause'), { workflowID: 'odw_1', action: 'pause' });
  assert.deepEqual(parseControlArguments('odw_1 replay node_1 effect absent'), {
    workflowID: 'odw_1', action: 'replay', nodeID: 'node_1', evidence: 'effect absent',
  });
  assert.throws(() => parseControlArguments('odw_1 replay'), /usage/);
});
