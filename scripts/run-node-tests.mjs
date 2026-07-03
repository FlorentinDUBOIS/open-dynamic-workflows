#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const inputs = process.argv.slice(2);
const files = inputs.length ? await resolveInputs(inputs) : await findDefaultTestFiles();

if (!files.length) {
  console.error(inputs.length ? `no test files matched: ${inputs.join(' ')}` : 'no test files found in ./test');
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

async function findDefaultTestFiles() {
  const testDir = join(process.cwd(), 'test');
  if (!existsSync(testDir)) {
    console.error(`test directory not found: ${testDir}`);
    process.exit(1);
  }
  return findTestFiles(testDir);
}

async function resolveInputs(patterns) {
  const files = new Set();
  for (const pattern of patterns) {
    const matches = hasGlob(pattern)
      ? await expandGlob(pattern)
      : [resolve(process.cwd(), pattern)];
    for (const file of matches) files.add(file);
  }
  return [...files].sort();
}

async function expandGlob(pattern) {
  const parts = pattern.replace(/\\/g, '/').split('/');
  const firstGlob = parts.findIndex(hasGlob);
  const baseDir = resolve(process.cwd(), ...parts.slice(0, firstGlob));
  return collectGlob(baseDir, parts.slice(firstGlob));
}

async function collectGlob(dir, parts) {
  const [part, ...rest] = parts;
  if (!part) return [];

  if (!hasGlob(part)) {
    const path = join(dir, part);
    if (!existsSync(path)) return [];
    if (!rest.length) return [path];
    return collectGlob(path, rest);
  }

  if (!existsSync(dir)) return [];
  const matcher = wildcardMatcher(part);
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!matcher.test(entry.name)) continue;
    const path = join(dir, entry.name);
    if (rest.length && entry.isDirectory()) {
      files.push(...await collectGlob(path, rest));
    } else if (!rest.length && entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function hasGlob(value) {
  return value.includes('*');
}

function wildcardMatcher(value) {
  const escaped = value.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`);
}
