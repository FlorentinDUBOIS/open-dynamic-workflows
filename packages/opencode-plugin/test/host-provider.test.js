import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpencodeBackend } from '../src/host-provider.js';

function mockClient(promptImpl) {
  const calls = [];
  return {
    calls,
    session: {
      create: async ({ body }) => ({ id: 'sess-' + body.title }),
      prompt: async ({ path, body }) => { calls.push({ id: path.id, body }); return promptImpl(body); },
      delete: async () => {},
    },
  };
}

test('opencode backend: maps a job onto session.prompt — omits model (keyless), uses system, reads parts', async () => {
  const client = mockClient((body) => ({ parts: [{ type: 'text', text: 'reply for ' + body.parts[0].text }] }));
  const backend = createOpencodeBackend(client, { poolSize: 2 });

  const r = await backend.invoke({ prompt: 'p1', systemPrompt: 'be brief' });
  assert.equal(r.text, 'reply for p1');
  const sent = client.calls[0].body;
  assert.equal(sent.system, 'be brief', 'system prompt uses the first-class field');
  assert.equal(sent.model, undefined, 'model OMITTED → inherits the user\'s configured OpenCode model (the keyless win)');
  assert.equal(sent.noReply, true);
  assert.equal(sent.parts[0].text, 'p1');
  await backend.dispose();
});

test('opencode backend: round-robins across a session pool (avoids same-session serialization)', async () => {
  const client = mockClient(() => ({ parts: [{ type: 'text', text: 'ok' }] }));
  const backend = createOpencodeBackend(client, { poolSize: 2 });
  await backend.invoke({ prompt: 'a' });
  await backend.invoke({ prompt: 'b' });
  await backend.invoke({ prompt: 'c' });
  const ids = client.calls.map((c) => c.id);
  assert.equal(new Set(ids).size, 2, 'uses two distinct child sessions');
  assert.notEqual(ids[0], ids[1], 'consecutive calls hit different sessions');
  await backend.dispose();
});

test('opencode backend: reads text from a {data:{parts}} wrapper too', async () => {
  const client = mockClient((body) => ({ data: { parts: [{ type: 'text', text: 'wrapped:' + body.parts[0].text }] } }));
  const backend = createOpencodeBackend(client, { poolSize: 1 });
  const r = await backend.invoke({ prompt: 'z' });
  assert.equal(r.text, 'wrapped:z');
  await backend.dispose();
});

test('opencode backend: forces an explicit providerID/modelID only when asked', async () => {
  const client = mockClient(() => ({ parts: [{ type: 'text', text: 'ok' }] }));
  const backend = createOpencodeBackend(client, { poolSize: 1, model: 'anthropic/claude-sonnet-4-6' });
  await backend.invoke({ prompt: 'p' });
  assert.deepEqual(client.calls[0].body.model, { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' });
  await backend.dispose();
});

test('opencode backend: errors clearly when no session can be created', async () => {
  const client = { session: { prompt: async () => ({ parts: [] }) } }; // no create
  const backend = createOpencodeBackend(client, { poolSize: 2 });
  await assert.rejects(() => backend.invoke({ prompt: 'p' }), /no session available/);
});
