import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFakeHost } from './fake-host.js';
import { hasFlock, COULD_NOT_START, ROOT_NOT_ABSOLUTE } from './flock.js';

test('tracked server bundle executes without ODW packages or adjacent WASM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'odw-standalone-'));
  const previousRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = join(root, 'runtime');
  try {
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const bundle = join(root, 'server.js');
    cpSync(new URL('../dist/server.js', import.meta.url), bundle);
    const module = await import(`${pathToFileURL(bundle).href}?test=${Date.now()}`);
    assert.deepEqual(Object.keys(module), ['default'], 'OpenCode 2 reads only the default plugin definition');
    const plugin = module.default;
    assert.equal(plugin.id, 'open-dynamic-workflows');
    assert.equal(typeof plugin.setup, 'function');

    const fake = createFakeHost({
      directory: root,
      sessions: { parent: { id: 'parent', agent: 'build', permissions: [] } },
      respond: (prompt) => (prompt.includes('Enumerate the concrete targets')
        ? '{"items":["one"]}'
        : /Find false positives|Challenge the severity|What is MISSING/.test(prompt)
          ? '{"approved":true,"confidence":1,"critique":"","rejectedItems":[]}'
          : prompt.includes('Merge verified results')
            ? '{"summary":"ok","details":[]}'
            : '{"findings":[],"confidence":1}'),
    });
    const cleanup = await plugin.setup(fake.ctx);
    try {
      assert.deepEqual([...fake.commands.keys()], ['odw', 'odw-control', 'odw-ultracode']);
      assert.deepEqual([...fake.tools.keys()], ['odw_run', 'odw_status', 'odw_control', 'odw_ultracode']);
      const event = await fake.submit('parent', 'workflow: inspect one thing');
      if (!hasFlock) {
        assert.match(event.prompt.text, process.env.XDG_RUNTIME_DIR.startsWith('/') ? COULD_NOT_START : ROOT_NOT_ABSOLUTE);
        return;
      }
      assert.match(event.prompt.text, /started with profile balanced/);
      let status;
      for (let attempt = 0; attempt < 80; attempt++) {
        status = JSON.parse((await fake.tools.get('odw_status').execute({}, { sessionID: 'parent' })).content);
        if (['completed', 'failed', 'cancelled'].includes(status[0]?.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(status[0].status, 'completed');
      assert.deepEqual(status[0].result, { summary: 'ok', details: [] });
    } finally {
      await cleanup();
    }
  } finally {
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntime;
    rmSync(root, { recursive: true, force: true });
  }
});
