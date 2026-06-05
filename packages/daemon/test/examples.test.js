import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox } from '../src/sandbox.js';

const examplesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples', 'workflows');

// The shipped examples must actually execute in the shipped sandbox.

function exampleBridges() {
  const agents = [];
  return {
    agents,
    bridges: {
      agent: async (job) => {
        agents.push(job.role);
        const p = job.prompt;
        if (/Findings to review:/.test(p)) return { approved: true, confidence: 0.9, critique: '', rejectedItems: [] };
        if (/investigation angles/i.test(p)) return { angles: [{ id: 'a', focus: 'angle one' }, { id: 'b', focus: 'angle two' }] };
        if (/Research this angle/i.test(p)) return { angle: 'x', claims: [{ claim: 'c', confidence: 0.8, reasoning: 'r' }] };
        if (/security audit report/i.test(p)) return { summary: 'report', criticalCount: 0, recommendations: [] };
        if (/Check .* for missing authentication/i.test(p)) return { file: 'f', findings: [], confidence: 0.9 };
        if (/Convert this JavaScript file/i.test(p)) return { outputFile: 'src/x.ts', code: 'export const x: number = 1;', typesAdded: 1 };
        if (/Review this JS→TS conversion/i.test(p)) return { approved: false, issues: ['demo: do not write in tests'] };
        if (/research summary/i.test(p)) return { summary: 's', keyFindings: ['k'], openQuestions: [], confidence: 0.8 };
        return { result: 'ok' };
      },
      tool: async ({ tool }) => {
        if (tool === 'glob') return ['src/a.js', 'src/b.js'];
        if (tool === 'read_file') return 'const x = 1;';
        throw new Error(`unexpected tool in example test: ${tool}`);
      },
      checkpoint: async () => null,
      log: () => {},
      phase: () => {},
      budget: () => ({ tokensUsed: 0, costUSD: 0, maxTokens: 1, maxCostUSD: 1, percentUsed: 0 }),
      args: () => ({ question: 'how do sandboxes work?' }),
    },
  };
}

test('example: security-audit.js executes end-to-end in the sandbox', async () => {
  const script = readFileSync(join(examplesDir, 'security-audit.js'), 'utf8');
  const { bridges, agents } = exampleBridges();
  const sandbox = await createSandbox({ hostBridges: bridges, strategy: { concurrency: { max: 4 } } });
  const result = await sandbox.runScript(script);
  sandbox.dispose();
  assert.equal(result.summary, 'report');
  assert.ok(agents.filter((r) => r === 'security-auditor').length === 2, 'one audit per discovered file');
});

test('example: migrate-to-typescript.js executes (write path approval-gated)', async () => {
  const script = readFileSync(join(examplesDir, 'migrate-to-typescript.js'), 'utf8');
  const { bridges } = exampleBridges();
  const sandbox = await createSandbox({ hostBridges: bridges, strategy: { concurrency: { max: 4 } } });
  const result = await sandbox.runScript(script);
  sandbox.dispose();
  // reviewer rejects in this fixture → nothing written, nothing failed
  assert.equal(result.migrated, 0);
  assert.equal(result.skipped, 2);
  assert.equal(result.failed, 0);
});

test('example: deep-research.js executes with args()', async () => {
  const script = readFileSync(join(examplesDir, 'deep-research.js'), 'utf8');
  const { bridges } = exampleBridges();
  const sandbox = await createSandbox({ hostBridges: bridges, strategy: { concurrency: { max: 4 } } });
  const result = await sandbox.runScript(script);
  sandbox.dispose();
  assert.equal(result.summary, 's');
  assert.deepEqual(result.keyFindings, ['k']);
});

test('example: studio-prime.workflow.js builds + tests + reviews end-to-end in the sandbox', async () => {
  const script = readFileSync(join(examplesDir, 'studio-prime.workflow.js'), 'utf8');
  const phases = [];
  const checkpoints = [];
  const written = [];
  const bridges = {
    agent: async (job) => {
      const role = job.role || '';
      const p = job.prompt || '';
      if (/Findings to review:/.test(p) || /steelman|zero-trust|completeness-checker/i.test(role)) {
        return { approved: true, confidence: 0.9, critique: 'mock: sound', rejectedItems: [] };
      }
      if (/northstar-validator/.test(role)) return { requirements: [{ id: 'r1', status: 'MET', reason: 'built + tested' }], overall: 'MET', gaps: [] };
      // every builder role returns a file set + an entry
      return {
        projectName: 'demo', entry: 'src/index.js',
        files: [
          { path: 'package.json', contents: '{"name":"demo","type":"module","scripts":{"test":"node --test test/"}}' },
          { path: 'src/index.js', contents: 'export const add = (a,b)=>a+b;' },
          { path: 'test/add.test.js', contents: 'import {test} from "node:test";' },
        ],
        notes: 'mock', requirements: [], overall: 'MET', gaps: [],
      };
    },
    tool: async ({ tool, args: a }) => {
      if (tool === 'read_file') throw new Error('no brief file');
      if (tool === 'web_search') return [{ title: 'Result', url: 'https://example.com/x' }];
      if (tool === 'web_fetch') return { url: 'https://example.com/x', text: 'mock page text' };
      if (tool === 'write_file') { written.push(a[0]); return { written: a[0] }; }
      if (tool === 'run_bash') {
        const cmd = String(a[0] || '');
        if (cmd.includes('--test')) return { stdout: '# tests 1\n# pass 1\n# fail 0\n' }; // green suite
        return { stdout: 'usage: demo [options]\n' };
      }
      return null;
    },
    checkpoint: async (d) => { checkpoints.push(d.phase); return null; },
    log: () => {},
    phase: ({ name }) => phases.push(name),
    budget: () => ({ tokensUsed: 0, costUSD: 0, maxTokens: 1, maxCostUSD: 1, percentUsed: 0 }),
    args: () => ({ northstar: 'Build a tiny add() utility, tested, MIT.' }),
  };
  const sandbox = await createSandbox({ hostBridges: bridges, totalTimeoutMs: 120000 });
  const result = await sandbox.runScript(script);
  sandbox.dispose();
  assert.deepEqual(phases, ['P1 Blueprint', 'P2 Link', 'P3 Architecture', 'P4 Implement', 'P5 Stylize', 'P6 Release', 'North Star Validation']);
  assert.equal(checkpoints.length, 6, 'one Apex checkpoint per phase P1-P6');
  assert.equal(result.productBuilt, true, 'mock test suite is green → product built');
  assert.ok(written.includes('package.json') && written.includes('src/index.js'), 'real files were written via the tool');
  assert.equal(result.unresolvedBlockers.length, 0);
  assert.equal(result.northstarValidation.overall, 'MET');
});
