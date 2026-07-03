import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const TEST_FILE = /\.(test|spec)\.[cm]?js$/i;

export async function runGeneratedTests(projectDir) {
  if (!projectDir || !existsSync(projectDir)) {
    return { exitCode: 1, stdout: '', stderr: 'project directory missing' };
  }

  const testDir = join(projectDir, 'test');
  const files = existsSync(testDir) ? await findTestFiles(testDir) : [];
  if (!files.length) {
    return { exitCode: 1, stdout: '', stderr: 'no generated test files found' };
  }

  const child = spawn(process.execPath, ['--test', ...files], {
    cwd: projectDir,
    env: childTestEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve) => child.on('close', resolve));
  return { exitCode, stdout: stdout.slice(-8000), stderr: stderr.slice(-8000) };
}

function childTestEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

async function findTestFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findTestFiles(path));
    } else if (TEST_FILE.test(entry.name)) {
      files.push(path);
    }
  }
  return files.sort();
}
