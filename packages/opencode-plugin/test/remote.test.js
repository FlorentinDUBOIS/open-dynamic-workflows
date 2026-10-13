import { test } from 'node:test';
import assert from 'node:assert/strict';
import plugin, { PLUGIN_ID, detectRemoteTrigger } from '../src/remote.js';
import { createFakeHost } from './fake-host.js';

test('remote trigger recognizes workflow modes and rejects incidental mentions', () => {
  assert.deepEqual(detectRemoteTrigger('workflow: audit auth'), { mode: 'workflow', prompt: 'audit auth' });
  assert.equal(detectRemoteTrigger('ultracode inspect this').mode, 'ultracode');
  assert.equal(detectRemoteTrigger('/deep-research: storage').mode, 'deep-research');
  assert.equal(detectRemoteTrigger('describe our CI workflows'), null);
});

// ── OpenCode 2 plugin definition, driven through an in-memory plugin context ──

function workflowHost(options = {}) {
  const lockRoot = `/tmp/odw-remote-${process.pid}-${Math.random().toString(16).slice(2)}`;
  process.env.XDG_RUNTIME_DIR = lockRoot;
  return createFakeHost({
    sessions: { parent: { id: 'parent', agent: 'build', permissions: [] } },
    respond: (text) => (/Enumerate the concrete targets/.test(text)
      ? '{"items":["one"]}'
      : /Find false positives|Challenge the severity|What is MISSING/.test(text)
        ? '{"approved":true,"confidence":1,"critique":"","rejectedItems":[]}'
        : text.includes('Merge verified results') ? '{"summary":"ok","details":[]}' : '{"findings":[],"confidence":1}'),
    ...options,
  });
}

async function settled(fake, sessionID = 'parent') {
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = JSON.parse((await fake.tools.get('odw_status').execute({}, { sessionID })).content);
    if (status.length && status.every((workflow) => ['completed', 'failed', 'cancelled'].includes(workflow.status))) return status;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('workflow did not settle');
}

test('remote plugin: default export is a v2 definition and nothing else is required at runtime', () => {
  assert.equal(plugin.id, PLUGIN_ID);
  assert.equal(PLUGIN_ID, 'open-dynamic-workflows');
  assert.equal(typeof plugin.setup, 'function');
});

test('remote plugin: registers commands, tools without code mode, hooks and an event subscription, and cleans up', async () => {
  const fake = workflowHost();
  const cleanup = await plugin.setup(fake.ctx);
  try {
    assert.deepEqual([...fake.commands.keys()], ['odw', 'odw-control', 'odw-ultracode']);
    assert.deepEqual([...fake.tools.keys()], ['odw_run', 'odw_status', 'odw_control', 'odw_ultracode']);
    for (const tool of fake.tools.values()) {
      assert.deepEqual(tool.options, { codemode: false });
      assert.equal(tool.input.type, 'object');
      assert.equal(tool.input.additionalProperties, false);
    }
    assert.deepEqual(fake.tools.get('odw_run').input.required, ['prompt']);
    assert.deepEqual(fake.tools.get('odw_run').input.properties.profile.enum, ['balanced', 'quality', 'economy']);
    assert.equal(fake.hooks.prompt.length, 1);
    assert.equal(fake.hooks.context.length, 1);
    assert.equal(fake.subscribers(), 1);
  } finally {
    await cleanup();
  }
  assert.equal(fake.subscribers(), 0, 'cleanup ends the event subscription');
});

test('remote plugin: a workflow trigger in a prompt starts an embedded run on child sessions and rewrites the prompt', async () => {
  const fake = workflowHost();
  const cleanup = await plugin.setup(fake.ctx);
  try {
    const event = await fake.submit('parent', 'workflow: inspect one thing');
    assert.match(event.prompt.text, /started with profile balanced/);
    const status = await settled(fake);
    assert.equal(status[0].status, 'completed');
    assert.deepEqual(status[0].result, { summary: 'ok', details: [] });
    assert.ok(fake.calls.create.length >= 3);
    assert.ok(fake.calls.create.every((input) => input.parentID === 'parent' && input.metadata.odwWorkflowID === status[0].id));
    assert.equal(fake.calls.create[0].agent, 'build', 'the parent agent is read from the session');
    assert.equal((await fake.ctx.storage.scan({ prefix: 'child/' })).entries.length, fake.calls.create.length, 'every child is recorded for the stale sweep');
  } finally {
    await cleanup();
  }
});

test('remote plugin: child prompts and unrelated prompts pass through untouched', async () => {
  const fake = workflowHost();
  const cleanup = await plugin.setup(fake.ctx);
  try {
    const plain = await fake.submit('parent', 'what does this function do?');
    assert.equal(plain.prompt.text, 'what does this function do?');
    await fake.submit('parent', 'workflow: inspect one thing');
    await settled(fake);
    const child = fake.calls.create.length && [...fake.sessions.keys()].find((id) => id !== 'parent');
    const nested = await fake.submit(child, 'workflow: this must not recurse');
    assert.equal(nested.prompt.text, 'workflow: this must not recurse');
  } finally {
    await cleanup();
  }
});

test('remote plugin: ultracode applies to long prompts only after /odw-ultracode on', async () => {
  const fake = workflowHost();
  const cleanup = await plugin.setup(fake.ctx);
  try {
    const long = 'Please refactor the authentication module and then update every caller accordingly';
    assert.equal((await fake.submit('parent', long)).prompt.text, long);
    await fake.commands.get('odw-ultracode').execute({ sessionID: 'parent', prompt: { text: 'on' } });
    assert.match(fake.calls.synthetic.at(-1).text, /Ultracode is on/);
    assert.equal(fake.calls.synthetic.at(-1).resume, false, 'a command answers without starting a model turn');
    assert.match((await fake.submit('parent', long)).prompt.text, /started with profile balanced/);
    await assert.rejects(() => fake.commands.get('odw-ultracode').execute({ sessionID: 'parent', prompt: { text: 'maybe' } }), /usage/);
  } finally {
    await cleanup();
  }
});

test('remote plugin: /odw and /odw-control drive a workflow and answer with synthetic messages', async () => {
  const fake = workflowHost();
  const cleanup = await plugin.setup(fake.ctx);
  try {
    await assert.rejects(() => fake.commands.get('odw').execute({ sessionID: 'parent', prompt: { text: '' } }), /task is required/);
    await fake.commands.get('odw').execute({ sessionID: 'parent', prompt: { text: '--profile quality inspect one thing' } });
    assert.match(fake.calls.synthetic.at(-1).text, /started with profile quality/);
    const [workflow] = await settled(fake);
    await assert.rejects(
      () => fake.commands.get('odw-control').execute({ sessionID: 'parent', prompt: { text: `${workflow.id} pause` } }),
      /already completed/,
    );
    const viaTool = JSON.parse((await fake.tools.get('odw_run').execute({ prompt: 'again', profile: 'economy' }, { sessionID: 'parent', agent: 'build' })).content);
    assert.equal(viaTool.profile, 'economy');
    await settled(fake);
    await assert.rejects(
      () => fake.tools.get('odw_control').execute({ workflowID: viaTool.id, action: 'stop' }, { sessionID: 'parent' }),
      /already completed/,
    );
  } finally {
    await cleanup();
  }
});

test('remote plugin: session.deleted ends the workflows of that parent', async () => {
  const fake = workflowHost();
  const cleanup = await plugin.setup(fake.ctx);
  try {
    await fake.submit('parent', 'workflow: inspect one thing');
    await settled(fake);
    fake.emit({ type: 'session.deleted', data: { sessionID: 'parent' } });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (JSON.parse((await fake.tools.get('odw_status').execute({}, { sessionID: 'parent' })).content).length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(JSON.parse((await fake.tools.get('odw_status').execute({}, { sessionID: 'parent' })).content), []);
  } finally {
    await cleanup();
  }
});

test('remote plugin: setup sweeps the children a previous process left behind', async () => {
  const fake = workflowHost();
  const stale = await fake.ctx.session.create({ parentID: 'dead-parent' });
  await fake.ctx.storage.set(`child/${stale.id}`, { parentID: 'dead-parent', createdAt: 1 });
  const cleanup = await plugin.setup(fake.ctx);
  await cleanup(); // awaits the sweep
  assert.deepEqual(fake.calls.remove, [stale.id]);
  assert.equal(fake.store.size, 0);
});
