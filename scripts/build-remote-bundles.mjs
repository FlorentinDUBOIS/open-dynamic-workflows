import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'packages', 'opencode-plugin', 'dist');
const check = process.argv.includes('--check');
const target = check ? mkdtempSync(join(tmpdir(), 'odw-bundle-check-')) : output;
mkdirSync(target, { recursive: true });

const bundles = [
  {
    entry: 'packages/opencode-plugin/src/remote.js',
    file: 'server.js',
    external: ['@opencode-ai/plugin'],
  },
  {
    entry: 'packages/opencode-plugin/src/tui.ts',
    file: 'tui.js',
    external: ['@opencode-ai/plugin/tui', '@opentui/solid', 'solid-js'],
  },
];

try {
  for (const bundle of bundles) {
    const path = join(target, bundle.file);
    execFileSync('bun', [
      'build', bundle.entry,
      '--target=node', '--format=esm', '--minify',
      ...bundle.external.flatMap((name) => ['--external', name]),
      '--outfile', path,
    ], { cwd: root, stdio: 'inherit' });
    canonicalize(path);
    inspect(path, bundle.external);
    if (check) {
      const tracked = join(output, bundle.file);
      if (!readFileSync(path).equals(readFileSync(tracked))) {
        throw new Error(`${bundle.file} is not reproducible; run npm run build:remote`);
      }
    }
  }
} finally {
  if (check) rmSync(target, { recursive: true, force: true });
}

function canonicalize(path) {
  const source = readFileSync(path, 'utf8');
  const canonical = source.replaceAll(root, '/open-dynamic-workflows');
  writeFileSync(path, canonical);
}

function inspect(path, allowedExternal) {
  const source = readFileSync(path, 'utf8');
  for (const forbidden of ['better-sqlite3', 'ODW_DAEMON_TOKEN', 'ODW_DAEMON_PORT', '127.0.0.1:7345', root]) {
    if (source.includes(forbidden)) throw new Error(`${path} contains forbidden runtime dependency ${forbidden}`);
  }
  const imports = [...source.matchAll(/from["']([^"']+)["']/g)].map((match) => match[1]);
  for (const specifier of imports) {
    if (!specifier.startsWith('node:') && !allowedExternal.includes(specifier)) {
      throw new Error(`${path} imports unexpected runtime package ${specifier}`);
    }
  }
}
