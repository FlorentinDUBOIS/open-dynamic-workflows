import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { startMockLLM } from './mock-llm.js';

const HOME = mkdtempSync(join(tmpdir(), 'odw-int-'));
process.env.ODW_HOME = HOME;

const { startDaemon } = await import('../src/index.js');

let mock;
let daemon;
let base;

before(async () => {
  mock = await startMockLLM();
  daemon = await startDaemon({
    port: 0, // ephemeral
    dbPath: join(HOME, 'integration.db'),
    logStream: { write() {} },
    configOverrides: {
      daemon: { maxConcurrency: 8, logLevel: 'error' },
      baseURLs: { default: mock.url },
      models: { planning: 'mock-planner', default: 'mock-model', fallback: 'mock-model' },
    },
  });
  base = `http://127.0.0.1:${daemon.port}`;
});

after(async () => {
  await daemon.close();
  await mock.close();
  rmSync(HOME, { recursive: true, force: true });
});

const post = (path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('integration: /health reports a live daemon', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const health = await res.json();
  assert.equal(health.status, 'ok');
  assert.equal(health.maxConcurrency, 8);
});

test('integration: plan → exec → result completes a full workflow over HTTP', async () => {
  const planRes = await post('/workflows/plan', { prompt: 'audit all API endpoints for missing auth checks' });
  assert.equal(planRes.status, 200);
  const { plan } = await planRes.json();
  assert.match(plan.script, /module\.exports = \{ execute \};/);
  assert.ok(plan.estimate.totalAgents > 1);
  assert.equal(plan.topology, 'hybrid');

  const execRes = await post('/workflows/exec', { plan });
  assert.equal(execRes.status, 202);
  const { workflowId } = await execRes.json();
  assert.match(workflowId, /^wf_/);

  const resultRes = await fetch(`${base}/workflows/${workflowId}/result?wait`);
  const body = await resultRes.json();
  assert.equal(body.status, 'completed', JSON.stringify(body).slice(0, 400));
  // synthesis output from the mock
  assert.equal(body.result.summary, 'mock synthesis of all results');

  // workflow record reflects completion + accounting
  const record = await (await fetch(`${base}/workflows/${workflowId}`)).json();
  assert.equal(record.status, 'completed');
  assert.ok(record.completed_agents >= 5, `agents: ${record.completed_agents}`); // 1 discovery + 3 fanout + 3 critics + 1 synth (≥5)
  assert.ok(record.tokens_input > 0 && record.cost_usd >= 0);
  assert.equal(record.nodeStats.completed, record.completed_agents);

  // script endpoint serves the compiled plan
  const script = await (await fetch(`${base}/workflows/${workflowId}/script`)).text();
  assert.match(script, /async function execute\(context\)/);
});

test('integration: list endpoint includes the workflow', async () => {
  const { workflows } = await (await fetch(`${base}/workflows`)).json();
  assert.ok(workflows.length >= 1);
  assert.ok(workflows[0].workflow_id);
});

test('integration: websocket replays journal and streams live events', async () => {
  const planRes = await post('/workflows/plan', { prompt: 'rename this function' });
  const { plan } = await planRes.json();
  const { workflowId } = await (await post('/workflows/exec', { plan })).json();

  // wait for completion first, then connect with after=0 → full replay
  await fetch(`${base}/workflows/${workflowId}/result?wait`);

  const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws/${workflowId}?after=0`);
  const received = [];
  ws.on('message', (data) => received.push(JSON.parse(data.toString())));
  await once(ws, 'open');
  await new Promise((r) => setTimeout(r, 300));
  ws.close();

  const types = received.map((e) => e.type);
  assert.ok(types.includes('workflow_started'), types.join(','));
  assert.ok(types.includes('agent_complete'));
  assert.ok(types.includes('workflow_complete'));
});

test('integration: websocket rejects unknown workflow', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws/wf_does_not_exist`);
  const [error] = await once(ws, 'error');
  assert.match(String(error.message), /404/);
});

test('integration: bad requests return structured errors without stack traces', async () => {
  const res = await post('/workflows/plan', {});
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'bad_request');
  assert.ok(!JSON.stringify(body).includes('at '), 'no stack frames in response');

  const missing = await fetch(`${base}/workflows/wf_nope`);
  assert.equal(missing.status, 404);
});

test('integration: stop control cancels a slow workflow', async () => {
  const slowMock = await startMockLLM({ latencyMs: 800 });
  const slowDaemon = await startDaemon({
    port: 0,
    dbPath: join(HOME, 'slow.db'),
    logStream: { write() {} },
    configOverrides: {
      daemon: { maxConcurrency: 2, logLevel: 'error' },
      baseURLs: { default: slowMock.url },
      models: { default: 'mock-model' },
    },
  });
  try {
    const slowBase = `http://127.0.0.1:${slowDaemon.port}`;
    const { plan } = await (await fetch(`${slowBase}/workflows/plan`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'audit all API endpoints for missing auth checks' }),
    })).json();
    const { workflowId } = await (await fetch(`${slowBase}/workflows/exec`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan }),
    })).json();

    await new Promise((r) => setTimeout(r, 300)); // let it start
    const ctl = await (await fetch(`${slowBase}/workflows/${workflowId}/ctl`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'stop' }),
    })).json();
    assert.equal(ctl.status, 'cancelled');

    await new Promise((r) => setTimeout(r, 500));
    const record = await (await fetch(`${slowBase}/workflows/${workflowId}`)).json();
    assert.equal(record.status, 'cancelled');
  } finally {
    await slowDaemon.close();
    await slowMock.close();
  }
});

test('integration: crash-resume — completed nodes are cached, only missing work re-runs', async () => {
  // Mock that fails synthesis for the whole first run (the queue retries 3×
  // inside one agent call, so all three must fail): the workflow errors after
  // completing discovery + fanout + critics, simulating an interruption.
  let synthCalls = 0;
  const flakyMock = await startMockLLM({
    behavior: (prompt) => {
      const instruction = prompt.split(' Context: ')[0];
      if (/Merge verified results|final deliverable/i.test(instruction)) {
        synthCalls++;
        if (synthCalls <= 3) return 'NOT JSON __ force schema failure __';
        return { summary: 'resumed synthesis', details: [] };
      }
      if (/Enumerate/i.test(instruction)) return { items: ['one.js', 'two.js'] };
      if (/Analyze ONE/i.test(instruction)) return { findings: [], confidence: 0.9 };
      return { approved: true, confidence: 0.9, critique: '', rejectedItems: [] };
    },
  });

  const flakyDaemon = await startDaemon({
    port: 0,
    dbPath: join(HOME, 'resume.db'),
    logStream: { write() {} },
    configOverrides: {
      daemon: { maxConcurrency: 4, logLevel: 'error' },
      baseURLs: { default: flakyMock.url },
      models: { default: 'mock-model' },
    },
  });

  try {
    const flakyBase = `http://127.0.0.1:${flakyDaemon.port}`;
    const { plan } = await (await fetch(`${flakyBase}/workflows/plan`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'audit all API endpoints for missing auth checks' }),
    })).json();
    // tighten retries so the bad synthesis output exhausts quickly
    plan.strategy.retry.maxAttempts = 1;

    const { workflowId } = await (await fetch(`${flakyBase}/workflows/exec`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan }),
    })).json();

    // first run must FAIL at synthesis
    const firstResult = await (await fetch(`${flakyBase}/workflows/${workflowId}/result?wait`)).json();
    assert.equal(firstResult.status, 'failed');

    const callsBeforeResume = flakyMock.calls.length;
    const completedBefore = (await (await fetch(`${flakyBase}/workflows/${workflowId}`)).json()).completed_agents;
    assert.ok(completedBefore >= 6, `pre-resume completed agents: ${completedBefore}`);

    // resume via ctl
    const ctl = await (await fetch(`${flakyBase}/workflows/${workflowId}/ctl`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'resume' }),
    })).json();
    assert.equal(ctl.status, 'running');

    const final = await (await fetch(`${flakyBase}/workflows/${workflowId}/result?wait`)).json();
    assert.equal(final.status, 'completed', JSON.stringify(final).slice(0, 300));
    assert.equal(final.result.summary, 'resumed synthesis');

    // THE resume guarantee: only the synthesis re-ran; cached nodes did not call the provider again
    const newCalls = flakyMock.calls.length - callsBeforeResume;
    assert.equal(newCalls, 1, `expected exactly 1 new provider call on resume, saw ${newCalls}`);
  } finally {
    await flakyDaemon.close();
    await flakyMock.close();
  }
});
