import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpencodeBackend, createSystemPrompts } from '../src/host-provider.js';
import { createFakeHost } from './fake-host.js';

const echo = (text) => `reply for ${text}`;

test('opencode backend: maps a job onto the selected parent agent, model and variant at session creation', async () => {
  const fake = createFakeHost({ respond: echo });
  const systemPrompts = createSystemPrompts();
  await fake.ctx.session.hook('context', (event) => systemPrompts.apply(event));
  const backend = createOpencodeBackend(fake.ctx, { agent: 'build', model: 'openai/gpt-5.6-sol', parentSessionID: 'parent', workflowID: 'odw_x', systemPrompts });

  const r = await backend.invoke({ prompt: 'p1', systemPrompt: 'be brief', variant: 'max', nodeId: 'node', role: 'analysis' });
  assert.equal(r.text, 'reply for p1');
  const created = fake.calls.create[0];
  assert.equal(created.agent, 'build');
  assert.deepEqual(created.model, { id: 'gpt-5.6-sol', providerID: 'openai', variant: 'max' });
  assert.equal(created.parentID, 'parent');
  assert.equal(created.metadata.odw, true);
  assert.equal(created.metadata.odwWorkflowID, 'odw_x');
  assert.equal(created.metadata.odwNodeID, 'node');
  assert.equal(fake.calls.prompt[0].text, 'p1', 'the prompt text is sent as-is');
  assert.deepEqual(fake.sessions.get(fake.calls.prompt[0].sessionID).system, ['be brief'], 'the system prompt reaches the model request through the context hook');
  const after = { sessionID: fake.calls.prompt[0].sessionID, system: [] };
  systemPrompts.apply(after);
  assert.deepEqual(after.system, [], 'the entry is cleared once the child settles');
  await backend.dispose();
});

test('opencode backend: omits unset routing fields instead of sending undefined', async () => {
  const fake = createFakeHost({ respond: echo });
  const backend = createOpencodeBackend(fake.ctx);
  await backend.invoke({ prompt: 'p' });
  const created = fake.calls.create[0];
  assert.equal('agent' in created, false);
  assert.equal('model' in created, false);
  assert.equal('permissions' in created, false);
  assert.equal('parentID' in created, false);
  assert.equal('odwWorkflowID' in created.metadata, false);
});

test('opencode backend: retains fresh child sessions beneath the parent', async () => {
  const fake = createFakeHost({ respond: () => 'ok' });
  const backend = createOpencodeBackend(fake.ctx);
  await backend.invoke({ prompt: 'a' });
  await backend.invoke({ prompt: 'b' });
  await backend.invoke({ prompt: 'c' });
  const ids = fake.calls.prompt.map((call) => call.sessionID);
  assert.equal(new Set(ids).size, 3, 'every invoke runs in its own child session — a reused session would leak each agent\'s conversation into the next');
  assert.equal(fake.calls.remove.length, 0);
  await backend.dispose();
  assert.equal(fake.calls.remove.length, 0, 'OpenCode removes retained children with their parent');
  assert.deepEqual(backend.createdSessions(), [], 'dispose forgets the in-memory list only');
});

test('opencode backend: forces an explicit providerID/modelID only when asked', async () => {
  const fake = createFakeHost({ respond: () => 'ok' });
  const backend = createOpencodeBackend(fake.ctx, { model: 'anthropic/claude-sonnet-4-6' });
  await backend.invoke({ prompt: 'p' });
  assert.deepEqual(fake.calls.create[0].model, { id: 'claude-sonnet-4-6', providerID: 'anthropic' });
  await backend.dispose();
});

test('opencode backend: routes by role and keeps reconstruction read-only', async () => {
  const fake = createFakeHost({ respond: () => 'ok', sessions: { parent: { id: 'parent', permissions: [{ action: 'shell', resource: '*', effect: 'allow' }] } } });
  const backend = createOpencodeBackend(fake.ctx, {
    parentSessionID: 'parent',
    agent: 'build',
    modelForRole: (role) => (role === 'reconstruction' ? { model: 'openai/gpt-5.6-sol', variant: 'max' } : { model: 'openai/gpt-5.6-luna' }),
  });
  await backend.invoke({ prompt: 'work', role: 'analysis' });
  await backend.invoke({ prompt: 'rebuild', role: 'reconstruction' });
  const [work, rebuild] = fake.calls.create;
  assert.equal(work.agent, 'build');
  assert.deepEqual(work.model, { id: 'gpt-5.6-luna', providerID: 'openai' });
  assert.deepEqual(work.permissions, [{ action: 'shell', resource: '*', effect: 'allow' }], 'children inherit the parent ruleset');
  assert.equal(rebuild.agent, 'plan');
  assert.deepEqual(rebuild.model, { id: 'gpt-5.6-sol', providerID: 'openai', variant: 'max' });
  assert.deepEqual(rebuild.permissions.map((rule) => [rule.action, rule.effect]), [['edit', 'deny'], ['shell', 'deny'], ['subagent', 'deny'], ['slack_*', 'deny']]);
});

test('opencode backend: refreshes the parent session permissions for every child', async () => {
  const fake = createFakeHost({ respond: () => 'ok', sessions: {} });
  let revision = 0;
  fake.ctx.session.get = async () => ({ id: 'parent', permissions: [{ action: 'shell', resource: '*', effect: revision++ ? 'allow' : 'deny' }] });
  const backend = createOpencodeBackend(fake.ctx, { parentSessionID: 'parent', agent: 'build' });
  await backend.invoke({ prompt: 'first' });
  await backend.invoke({ prompt: 'second' });
  assert.equal(fake.calls.create[0].permissions[0].effect, 'deny');
  assert.equal(fake.calls.create[1].permissions[0].effect, 'allow');
});

test('opencode backend: errors clearly when no session can be created', async () => {
  const backend = createOpencodeBackend({ session: { prompt: async () => ({}) } }); // no create
  await assert.rejects(() => backend.invoke({ prompt: 'p' }), /no session available/);
  const fake = createFakeHost({ failCreate: true });
  await assert.rejects(() => createOpencodeBackend(fake.ctx).invoke({ prompt: 'p' }), /create failed/);
});

test('opencode backend: reports every created child session via onSessionCreate before its prompt (recursion-guard wiring)', async () => {
  const fake = createFakeHost({ respond: () => 'ok' });
  const seen = [];
  const backend = createOpencodeBackend(fake.ctx, { onSessionCreate: (id) => seen.push([id, fake.calls.prompt.length]) });
  await backend.invoke({ prompt: 'p' });
  await backend.invoke({ prompt: 'q' });
  assert.deepEqual(seen.map(([, prompts]) => prompts), [0, 1], 'a child is reported before its prompt is sent so the prompt hook can skip it');
  assert.equal(seen.length, 2);
  await backend.dispose();
});

test('opencode backend: a failed session without reply text throws retryable service_unavailable', async () => {
  const fake = createFakeHost({ respond: () => new Error('ConnectionRefused') });
  const backend = createOpencodeBackend(fake.ctx);
  await assert.rejects(
    () => backend.invoke({ prompt: 'p' }),
    (err) => err.code === 'service_unavailable' && /ConnectionRefused/.test(err.message),
    'an upstream failure settles the session as failed with the error on the assistant message and must surface as a retryable error',
  );
  await backend.dispose();
});

test('opencode backend: reads the final assistant text after native tool turns', async () => {
  const fake = createFakeHost({ respond: () => '{"findings":[]}' });
  const original = fake.ctx.session.context;
  fake.ctx.session.context = async (input) => {
    const messages = await original(input);
    const assistant = messages.find((message) => message.type === 'assistant');
    assistant.content.unshift({ type: 'reasoning', text: 'I will inspect files.' }, { type: 'tool', name: 'glob', state: { status: 'completed' } });
    return messages;
  };
  const backend = createOpencodeBackend(fake.ctx);
  const result = await backend.invoke({ prompt: 'p' });
  assert.equal(result.text, '{"findings":[]}');
  await backend.dispose();
});

test('opencode backend: empty reply WITHOUT a host error is returned as-is (left to schema-correction retry)', async () => {
  const fake = createFakeHost({ respond: () => '' });
  const backend = createOpencodeBackend(fake.ctx);
  const r = await backend.invoke({ prompt: 'p' });
  assert.equal(r.text, '', 'a legitimately-empty reply is not an infrastructure failure');
  await backend.dispose();
});

test('opencode backend: an early session.wait is repeated until the transcript ends with the idle marker', async () => {
  const fake = createFakeHost({ respond: echo, earlyWaits: 1, latency: 20 });
  const backend = createOpencodeBackend(fake.ctx);
  const r = await backend.invoke({ prompt: 'late' });
  assert.equal(r.text, 'reply for late');
  assert.equal(fake.calls.wait.length, 2, 'the early return is retried once the transcript still lacks the idle marker');
});

test('opencode backend: abort interrupts the child session and rejects with AbortError', async () => {
  const fake = createFakeHost({ respond: () => new Promise(() => {}) }); // never replies
  const backend = createOpencodeBackend(fake.ctx);
  const controller = new AbortController();
  const pending = backend.invoke({ prompt: 'slow' }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(() => pending, (err) => err.name === 'AbortError');
  assert.deepEqual(fake.calls.interrupt, [fake.calls.prompt[0].sessionID]);
  const already = new AbortController();
  already.abort();
  await assert.rejects(() => backend.invoke({ prompt: 'never' }, { signal: already.signal }), (err) => err.name === 'AbortError');
});

test('opencode backend: without a system registry the system prompt is prepended to the prompt text', async () => {
  const fake = createFakeHost({ respond: echo });
  const backend = createOpencodeBackend(fake.ctx);
  await backend.invoke({ prompt: 'task', systemPrompt: 'rules' });
  assert.equal(fake.calls.prompt[0].text, 'rules\n\ntask');
});
