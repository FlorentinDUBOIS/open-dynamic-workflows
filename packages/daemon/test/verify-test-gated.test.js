// TEST-GATED verify(): for code, the test suite is the ultimate critic — a
// finding/change set must not pass verification unless tests pass too. These
// tests exercise the guest-side gate through a real QuickJS sandbox with every
// host bridge stubbed (critic verdicts via hostBridges.agent, run_bash via
// hostBridges.tool, recorded so tests can assert it was/wasn't invoked).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createSandbox } = await import('../src/sandbox.js');

const APPROVE = { approved: true, confidence: 0.9, critique: '', rejectedItems: [] };
const REJECT = { approved: false, confidence: 0.9, critique: 'reject', rejectedItems: ['itemX'] };

/** Sandbox factory: fixed critic verdict + a run_bash result (or throwing fn). */
async function sandboxWith({ critic, bash }) {
  const toolCalls = [];
  const sandbox = await createSandbox({
    hostBridges: {
      agent: async () => critic,
      tool: async (payload) => {
        toolCalls.push(payload);
        return typeof bash === 'function' ? bash(payload) : bash;
      },
    },
    totalTimeoutMs: 30_000,
  });
  return { sandbox, toolCalls };
}

/** Guest script returning the raw verify() result for a literal config. */
const script = (configJs) => `
  async function execute() {
    return verify(${configJs});
  }
  module.exports = { execute };
`;

test('verify: green testCommand + approving quorum → passed, testExitCode 0', async () => {
  const { sandbox, toolCalls } = await sandboxWith({ critic: APPROVE, bash: { stdout: 'ok', exitCode: 0 } });
  const result = await sandbox.runScript(script(`{
    target: [1],
    critics: [{ role: "c", prompt: "one" }, { role: "c", prompt: "two" }],
    consensusThreshold: 2,
    testCommand: "npm test",
    testTimeout: 60000
  }`));
  sandbox.dispose();
  assert.equal(result.passed, true);
  assert.equal(result.testExitCode, 0);
  assert.equal(result.testOutput, 'ok');
  assert.equal(result.testError, null);
  assert.equal(result.testCommand, 'npm test');
  assert.equal(result.verdicts.length, 2, 'critic fan-out still ran');
  assert.deepEqual(toolCalls, [{ tool: 'run_bash', args: ['npm test'] }]);
});

test('verify: failing testCommand sinks an approving quorum (suite outranks critics)', async () => {
  // exitCode 1 + failed:true is the bridge's no-throw shape for a red suite.
  const { sandbox } = await sandboxWith({
    critic: APPROVE,
    bash: { stdout: '1 failing' + 'x'.repeat(5000), exitCode: 1, failed: true },
  });
  const result = await sandbox.runScript(script(`{
    target: [1],
    critics: [{ role: "c", prompt: "one" }, { role: "c", prompt: "two" }],
    consensusThreshold: 2,
    testCommand: "npm test"
  }`));
  sandbox.dispose();
  assert.equal(result.passed, false, 'quorum approved but the suite is red');
  assert.equal(result.testExitCode, 1);
  assert.match(result.testOutput, /1 failing/);
  assert.equal(result.testOutput.length, 4000, 'stdout sliced to 4000 chars');
  assert.equal(result.testError, null);
  assert.equal(result.approvals, 2, 'critic quorum unchanged by the test gate');
});

test('verify: rejecting quorum is not rescued by green tests (quorum still required)', async () => {
  // adversarial: 2 confident rejections >= threshold 2 → quorum fails.
  const { sandbox } = await sandboxWith({ critic: REJECT, bash: { stdout: 'ok', exitCode: 0 } });
  const result = await sandbox.runScript(script(`{
    target: [1],
    critics: [{ role: "c", prompt: "one" }, { role: "c", prompt: "two" }],
    consensusThreshold: 2,
    testCommand: "npm test"
  }`));
  sandbox.dispose();
  assert.equal(result.passed, false, 'tests green but the critics rejected');
  assert.equal(result.testExitCode, 0);
  assert.deepEqual(result.rejectedItems, ['itemX', 'itemX']);
});

test('verify: a run_bash bridge throw (approval gate) fails closed without crashing', async () => {
  const { sandbox } = await sandboxWith({
    critic: APPROVE,
    bash: () => {
      throw new Error('run_bash requires approval and the daemon has no interactive approval channel.');
    },
  });
  const result = await sandbox.runScript(script(`{
    target: [1],
    critics: [{ role: "c", prompt: "one" }, { role: "c", prompt: "two" }],
    consensusThreshold: 2,
    testCommand: "npm test"
  }`));
  sandbox.dispose();
  assert.equal(result.passed, false, 'a gate that cannot run is a failed gate');
  assert.equal(result.testExitCode, null);
  assert.match(result.testError, /requires approval/);
  assert.equal(result.testOutput, '');
  assert.equal(result.verdicts.length, 2, 'critic verdicts still returned');
});

test('verify: no testCommand → prior behavior, run_bash never invoked, no test fields', async () => {
  const { sandbox, toolCalls } = await sandboxWith({ critic: APPROVE, bash: { stdout: 'ok', exitCode: 0 } });
  const result = await sandbox.runScript(script(`{
    target: [1],
    critics: [{ role: "c", prompt: "one" }, { role: "c", prompt: "two" }],
    consensusThreshold: 2
  }`));
  sandbox.dispose();
  assert.equal(result.passed, true);
  assert.equal(toolCalls.length, 0, 'tool bridge must never be called');
  assert.equal('testCommand' in result, false, 'additive fields only appear with a testCommand');
  assert.equal('testExitCode' in result, false);
  assert.equal('testOutput' in result, false);
  assert.equal('testError' in result, false);
});

test("verify: mode 'test-gated' without a testCommand throws a clear error", async () => {
  const { sandbox, toolCalls } = await sandboxWith({ critic: APPROVE, bash: { stdout: 'ok', exitCode: 0 } });
  const result = await sandbox.runScript(`
    async function execute() {
      try {
        await verify({ target: [1], mode: "test-gated", critics: [{ role: "c", prompt: "one" }] });
        return "no-error";
      } catch (e) {
        return "caught:" + e.message;
      }
    }
    module.exports = { execute };
  `);
  sandbox.dispose();
  assert.match(result, /^caught:/);
  assert.match(result, /test-gated/);
  assert.match(result, /testCommand/);
  assert.equal(toolCalls.length, 0);
});

test("verify: mode 'test-gated' quorum behaves adversarially (errored critic cannot sink it)", async () => {
  // 3 critics: approve(0.9), reject(0.9), crash(→confidence 0): only 1 confident
  // rejection < threshold 2, so the adversarial-alias quorum survives.
  let call = 0;
  const toolCalls = [];
  const sandbox = await createSandbox({
    hostBridges: {
      agent: async () => {
        call++;
        if (call === 1) return APPROVE;
        if (call === 2) return REJECT;
        throw new Error('critic crashed');
      },
      tool: async (payload) => {
        toolCalls.push(payload);
        return { stdout: 'ok', exitCode: 0 };
      },
    },
    totalTimeoutMs: 30_000,
  });
  const result = await sandbox.runScript(script(`{
    target: [1],
    mode: "test-gated",
    critics: [{ role: "c", prompt: "one" }, { role: "c", prompt: "two" }, { role: "c", prompt: "three" }],
    consensusThreshold: 2,
    minConfidence: 0.5,
    testCommand: "npm test"
  }`));
  sandbox.dispose();
  assert.equal(result.passed, true, 'adversarial semantics + green tests');
  assert.equal(result.mode, 'test-gated', 'caller-supplied mode echoed back');
  assert.equal(result.rejections, 1);
  assert.equal(result.testExitCode, 0);
  assert.equal(toolCalls.length, 1);
});
