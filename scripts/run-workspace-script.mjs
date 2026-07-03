#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const packagesDir = join(root, 'packages');
const scriptName = process.argv[2] ?? 'test';
const npmCommand = process.env.npm_execpath
  ? { command: process.execPath, args: [process.env.npm_execpath] }
  : { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [] };

const entries = await readdir(packagesDir, { withFileTypes: true });
const workspaces = [];
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const dir = join(packagesDir, entry.name);
  const text = await readFile(join(dir, 'package.json'), 'utf8');
  const pkg = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (pkg.scripts?.[scriptName]) {
    workspaces.push({ name: pkg.name, dir: entry.name });
  }
}

workspaces.sort((a, b) => a.dir.localeCompare(b.dir));

for (const workspace of workspaces) {
  console.log(`\n==> ${workspace.name} ${scriptName}`);
  const code = await run(npmCommand.command, [...npmCommand.args, 'run', scriptName, '--workspace', workspace.name]);
  if (code !== 0) {
    console.error(`workspace ${workspace.name} ${scriptName} failed with exit code ${code}`);
    process.exit(code);
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', cwd: root });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) {
        console.error(`${command} ${args.join(' ')} terminated by ${signal}`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}
