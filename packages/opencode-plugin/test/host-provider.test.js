import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpencodeBackend } from '../src/host-provider.js';

function mockClient(promptImpl) {
  const calls = [];
  const creates = [];
  const deleted = [];
  let seq = 0;
  return {
    calls,
    creates,
    deleted,
    session: {
      create: async ({ body }) => { creates.push(body); return { id: `sess-${++seq}` }; },
      prompt: async ({ path, body }) => { calls.push({ id: path.id, body }); return promptImpl(body); },
      delete: async ({ path }) => { deleted.push(path.id); },
    },
  };
}

test('opencode backend: maps a job onto the selected parent agent, model and variant', async () => {
  const client = mockClient((body) => ({ parts: [{ type: 'text', text: 'reply for ' + body.parts[0].text }] }));
  const backend = createOpencodeBackend(client, { agent: 'build', model: 'openai/gpt-5.6-sol', parentSessionID: 'parent' });

  const r = await backend.invoke({ prompt: 'p1', systemPrompt: 'be brief', variant: 'max', workflowId: 'wf', nodeId: 'node', role: 'analysis' });
  assert.equal(r.text, 'reply for p1');
  const sent = client.calls[0].body;
  assert.equal(sent.system, 'be brief', 'system prompt uses the first-class field');
  assert.equal(sent.agent, 'build');
  assert.deepEqual(sent.model, { providerID: 'openai', modelID: 'gpt-5.6-sol' });
  assert.equal(sent.variant, 'max');
  assert.equal(sent.noReply, undefined, 'noReply must NOT be set — noReply:true makes session.prompt echo the user parts back without generating (verified live on CLI 1.2.27)');
  assert.equal(sent.parts[0].text, 'p1');
  assert.equal(client.creates[0].parentID, 'parent');
  assert.equal(client.creates[0].metadata.odw, true);
  assert.equal(client.creates[0].metadata.odwWorkflowID, 'wf');
  await backend.dispose();
});

test('opencode backend: retains fresh child sessions beneath the parent', async () => {
  const client = mockClient(() => ({ parts: [{ type: 'text', text: 'ok' }] }));
  const backend = createOpencodeBackend(client);
  await backend.invoke({ prompt: 'a' });
  await backend.invoke({ prompt: 'b' });
  await backend.invoke({ prompt: 'c' });
  const ids = client.calls.map((c) => c.id);
  assert.equal(new Set(ids).size, 3, 'every invoke runs in its own child session — without noReply, a reused session would leak each agent\'s conversation into the next');
  assert.equal(client.deleted.length, 0);
  await backend.dispose();
  assert.equal(client.deleted.length, 0, 'OpenCode recursively deletes retained children with their parent');
});

test('opencode backend: reads text from a {data:{parts}} wrapper too', async () => {
  const client = mockClient((body) => ({ data: { parts: [{ type: 'text', text: 'wrapped:' + body.parts[0].text }] } }));
  const backend = createOpencodeBackend(client);
  const r = await backend.invoke({ prompt: 'z' });
  assert.equal(r.text, 'wrapped:z');
  await backend.dispose();
});

test('opencode backend: forces an explicit providerID/modelID only when asked', async () => {
  const client = mockClient(() => ({ parts: [{ type: 'text', text: 'ok' }] }));
  const backend = createOpencodeBackend(client, { model: 'anthropic/claude-sonnet-4-6' });
  await backend.invoke({ prompt: 'p' });
  assert.deepEqual(client.calls[0].body.model, { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' });
  await backend.dispose();
});

test('opencode backend: explicit agent overrides the default plain text agent', async () => {
  const client = mockClient(() => ({ parts: [{ type: 'text', text: 'ok' }] }));
  const backend = createOpencodeBackend(client, { agent: 'build' });
  await backend.invoke({ prompt: 'p' });
  assert.equal(client.calls[0].body.agent, 'build');
  await backend.dispose();
});

test('opencode backend: errors clearly when no session can be created', async () => {
  const client = { session: { prompt: async () => ({ parts: [] }) } }; // no create
  const backend = createOpencodeBackend(client);
  await assert.rejects(() => backend.invoke({ prompt: 'p' }), /no session available/);
});

test('opencode backend: reports every created child session via onSessionCreate (recursion-guard wiring)', async () => {
  const client = mockClient(() => ({ parts: [{ type: 'text', text: 'ok' }] }));
  const seen = [];
  const backend = createOpencodeBackend(client, { onSessionCreate: (id) => seen.push(id) });
  await backend.invoke({ prompt: 'p' });
  await backend.invoke({ prompt: 'q' });
  assert.equal(seen.length, 2, 'every per-invoke session is reported so the chat.message hook can skip it');
  await backend.dispose();
});

test('opencode backend: empty reply WITH a host error throws retryable service_unavailable', async () => {
  const client = mockClient(() => ({ parts: [], info: { error: { code: 'ConnectionRefused' } } }));
  const backend = createOpencodeBackend(client);
  await assert.rejects(
    () => backend.invoke({ prompt: 'p' }),
    (err) => err.code === 'service_unavailable' && /ConnectionRefused/.test(err.message),
    'an upstream failure resolves with empty parts + info.error (verified live) and must surface as a retryable error'
  );
  await backend.dispose();
});

test('opencode backend: accepts native tool parts when OpenCode also returns final text', async () => {
  const client = mockClient(() => ({
    parts: [
      { type: 'reasoning', text: 'I will inspect files.' },
      { type: 'tool', tool: 'glob', state: { status: 'completed' } },
      { type: 'text', text: '{"findings":[]}' },
    ],
    info: { finish: 'tool-calls' },
  }));
  const backend = createOpencodeBackend(client);
  const result = await backend.invoke({ prompt: 'p' });
  assert.equal(result.text, '{"findings":[]}');
  await backend.dispose();
});

test('opencode backend: empty reply WITHOUT a host error is returned as-is (left to schema-correction retry)', async () => {
  const client = mockClient(() => ({ parts: [] }));
  const backend = createOpencodeBackend(client);
  const r = await backend.invoke({ prompt: 'p' });
  assert.equal(r.text, '', 'a legitimately-empty reply is not an infrastructure failure');
  await backend.dispose();
});

test('opencode backend: sessions from failed invokes remain attached for inspection', async () => {
  const client = mockClient(() => { throw new Error('boom'); });
  const backend = createOpencodeBackend(client);
  await assert.rejects(() => backend.invoke({ prompt: 'p' }), /boom/);
  await backend.dispose();
  assert.equal(client.deleted.length, 0);
});

test('opencode backend: refreshes the parent session permission for every child', async () => {
  const client = mockClient(() => ({ parts: [{ type: 'text', text: 'ok' }] }));
  let revision = 0;
  client.session.get = async () => ({ data: { permission: [{ permission: 'bash', pattern: '*', action: revision++ ? 'allow' : 'deny' }] } });
  const backend = createOpencodeBackend(client, { parentSessionID: 'parent', agent: 'build' });
  await backend.invoke({ prompt: 'first' });
  await backend.invoke({ prompt: 'second' });
  assert.equal(client.creates[0].permission[0].action, 'deny');
  assert.equal(client.creates[1].permission[0].action, 'allow');
});
