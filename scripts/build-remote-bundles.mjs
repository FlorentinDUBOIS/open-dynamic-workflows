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
    entry: 'packages/opencode-plugin/src/server-entry.js',
    file: 'server.js',
    external: [],
    exports: ['default'],
    minify: ['--minify'],
  },
  {
    entry: 'packages/opencode-plugin/src/tui.ts',
    file: 'tui.js',
    external: ['@opencode-ai/plugin/tui', '@opentui/solid', 'solid-js'],
    exports: ['default'],
    minify: ['--minify-syntax', '--minify-identifiers'],
    runtimeBridge: true,
  },
];

try {
  for (const bundle of bundles) {
    const path = join(target, bundle.file);
    execFileSync('bun', [
      'build', bundle.entry,
      '--target=node', '--format=esm', ...bundle.minify,
      ...bundle.external.flatMap((name) => ['--external', name]),
      '--outfile', path,
    ], { cwd: root, stdio: 'inherit' });
    canonicalize(path);
    inspect(path, bundle);
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
  const canonical = source
    .replaceAll(root, '/open-dynamic-workflows')
    .replace(/[\t ]+$/gm, '');
  writeFileSync(path, canonical);
}

function inspect(path, bundle) {
  const source = readFileSync(path, 'utf8');
  for (const forbidden of ['better-sqlite3', 'ODW_DAEMON_TOKEN', 'ODW_DAEMON_PORT', '127.0.0.1:7345', root]) {
    if (source.includes(forbidden)) throw new Error(`${path} contains forbidden runtime dependency ${forbidden}`);
  }
  const imports = [...source.matchAll(/(?:^|[;\n])import[^;\n]*?\bfrom\s*["']([^"']+)["']/g)]
    .map((match) => match[1]);
  for (const specifier of imports) {
    if (!specifier.startsWith('node:') && !bundle.external.includes(specifier)) {
      throw new Error(`${path} imports unexpected runtime package ${specifier}`);
    }
  }
  if (bundle.runtimeBridge && /\bfrom["']/.test(source)) {
    throw new Error(`${path} contains a static import that the OpenTUI runtime bridge cannot rewrite`);
  }
  const actual = readExports(source);
  const expected = [...bundle.exports].sort();
  if (actual.join(',') !== expected.join(',')) {
    throw new Error(
      `${path} exports ${actual.join(',') || '(nothing)'} but must export exactly ${expected.join(',')}; ` +
      'OpenCode instantiates every export of a plugin module as a plugin factory, so a helper ' +
      'exported here is called with the plugin input and its return value is used as the hooks object',
    );
  }
}

// Reads the export surface of a bundle. Bun emits one trailing `export{...}` statement per
// ES module, so the last match is the module's real export list rather than a string literal.
function readExports(source) {
  const statements = [...source.matchAll(/\bexport\s*\{([^}]*)\}/g)];
  const last = statements.at(-1);
  const names = (last ? last[1].split(',') : [])
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split(/\s+as\s+/).at(-1).trim());
  if (/\bexport\s+default\b/.test(source)) names.push('default');
  return [...new Set(names)].sort();
}
