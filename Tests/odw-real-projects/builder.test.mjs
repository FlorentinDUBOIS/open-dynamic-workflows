import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildProject } from './builder.mjs';
import { projectCatalog } from './catalog.mjs';

test('mock real-project build completes the ODW workflow and generated tests', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'odw-real-project-build-'));
  const project = projectCatalog().find((item) => item.id === '070');

  const result = await buildProject({ project, outputRoot, providerMode: 'mock' });

  assert.equal(result.odwStatus, 'completed', JSON.stringify(result, null, 2));
  assert.equal(result.ok, true);
  assert.ok(result.providerCalls >= 7, 'builder should exercise product/backend/security/QA and critics');
});
