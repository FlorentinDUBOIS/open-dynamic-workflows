#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const testDir = join(process.cwd(), 'test');
if (!existsSync(testDir)) {
  console.error(`test directory not found: ${testDir}`);
  process.exit(1);
}

const files = await findTestFiles(testDir);
if (!files.length) {
  console.error(`no test files found in ${testDir}`);
  process.exit(1);
}

const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });
child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on('close', (code, signal) => {
  if (signal) {
    console.error(`node --test terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});

async function findTestFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findTestFiles(path));
    } else if (/\.(test|spec)\.[cm]?js$/i.test(entry.name) || /\.js$/i.test(entry.name)) {
      files.push(path);
    }
  }
  return files.sort();
}
