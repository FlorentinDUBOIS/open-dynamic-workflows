import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('tracked server bundle executes without ODW packages or adjacent WASM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odw-standalone-'));
  try {
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const bundle = join(root, 'server.js');
    cpSync(new URL('../dist/server.js', import.meta.url), bundle);
    const { default: plugin } = await import(`${pathToFileURL(bundle).href}?test=${Date.now()}`);
    let sequence = 0;
    const client = { session: {
      list: async () => [],
      delete: async () => true,
      get: async () => ({ permission: [] }),
      create: async () => ({ id: `child-${++sequence}` }),
      prompt: async ({ body }) => {
        const prompt = body.parts[0].text;
        const text = prompt.includes('Enumerate the concrete targets')
          ? '{"items":["one"]}'
          : /Find false positives|Challenge the severity|What is MISSING/.test(prompt)
            ? '{"approved":true,"confidence":1,"critique":"","rejectedItems":[]}'
          : prompt.includes('Merge verified results')
            ? '{"summary":"ok","details":[]}'
            : '{"findings":[],"confidence":1}';
        return { parts: [{ type: 'text', text }] };
      },
    } };
    const hooks = await plugin({ directory: root, client });
    try {
      const output = { parts: [{ type: 'text', text: 'workflow: inspect one thing' }] };
      await hooks['chat.message']({ sessionID: 'parent', messageID: 'message' }, output);
      assert.match(output.parts[0].text, /started with profile balanced/);
      let status;
      for (let attempt = 0; attempt < 40; attempt++) {
        status = JSON.parse(await hooks.tool.odw_status.execute({}, { sessionID: 'parent' }));
        if (status[0]?.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(status[0].status, 'completed');
      assert.deepEqual(status[0].result, { summary: 'ok', details: [] });
    } finally {
      await hooks.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
