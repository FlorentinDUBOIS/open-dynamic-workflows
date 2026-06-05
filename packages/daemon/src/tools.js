/**
 * Daemon-side workflow tools. Read-only tools (glob, read_file, search) are
 * implemented locally, rooted at the workflow's working directory.
 * Mutating tools (write_file, run_bash, git) are approval-gated: the daemon
 * has no interactive approval channel, so they only run when the user's
 * safety config explicitly removes them from requireApprovalFor — otherwise
 * they fail with a clear message (platform plugins mediate approvals).
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, realpathSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, relative, dirname, sep } from 'node:path';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_RESULTS = 500;

/**
 * @param {{cwd: string, safety: {requireApprovalFor: string[], autoApproveReadOnly: boolean,
 *          dryRun: boolean, blockedCommands?: string[]}, logger?: object}} options
 * @returns {(payload: {tool: string, args: any[]}) => Promise<any>}
 */
export function createToolExecutor(options) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const safety = options.safety;

  const realRoot = (() => {
    try {
      return realpathSync(cwd);
    } catch {
      return cwd;
    }
  })();

  const insideRoot = (p) => {
    const abs = resolve(cwd, p);
    const rel = relative(cwd, abs);
    if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
      throw new Error(`path escapes the workflow root: ${p}`);
    }
    // Symlink containment: resolve the deepest existing ancestor and re-check.
    let probe = abs;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    try {
      const real = realpathSync(probe);
      const realRel = relative(realRoot, real);
      if (realRel.startsWith('..') || realRel.includes(`..${sep}`)) {
        throw new Error(`path escapes the workflow root via symlink: ${p}`);
      }
    } catch (error) {
      if (/escapes the workflow root/.test(String(error.message))) throw error;
      // realpath failure on exotic paths: fall through to the lexical check above
    }
    return abs;
  };

  const requireUnattendedApproval = (tool) => {
    if (safety.requireApprovalFor?.includes(tool)) {
      throw new Error(
        `${tool} requires approval and the daemon has no interactive approval channel. ` +
        `Run this workflow through a platform plugin, or remove "${tool}" from safety.requireApprovalFor in ~/.odw/config.json.`
      );
    }
    if (safety.dryRun) {
      throw new Error(`${tool} skipped: dryRun is enabled`);
    }
  };

  const tools = {
    glob: async (pattern) => globWalk(cwd, String(pattern ?? '**/*')).slice(0, MAX_RESULTS),

    read_file: async (path) => {
      const abs = insideRoot(String(path));
      const stats = statSync(abs);
      if (stats.size > MAX_FILE_BYTES) throw new Error(`file too large (${stats.size} bytes > ${MAX_FILE_BYTES})`);
      return readFileSync(abs, 'utf8');
    },

    search: async (pattern, globPattern) => {
      const re = new RegExp(String(pattern), 'i');
      const files = globWalk(cwd, String(globPattern ?? '**/*')).slice(0, MAX_RESULTS);
      const matches = [];
      for (const file of files) {
        let content;
        try {
          const abs = insideRoot(file);
          if (statSync(abs).size > MAX_FILE_BYTES) continue;
          content = readFileSync(abs, 'utf8');
        } catch {
          continue;
        }
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matches.push({ file, line: i + 1, text: lines[i].slice(0, 400) });
            if (matches.length >= MAX_RESULTS) return matches;
          }
        }
      }
      return matches;
    },

    write_file: async (path, content) => {
      requireUnattendedApproval('write_file');
      const abs = insideRoot(String(path));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, String(content ?? ''), 'utf8');
      return { written: relative(cwd, abs) };
    },

    run_bash: async (command) => {
      requireUnattendedApproval('run_bash');
      const cmd = String(command ?? '');
      for (const blocked of safety.blockedCommands ?? []) {
        if (cmd.includes(blocked)) throw new Error(`blocked command pattern: ${blocked}`);
      }
      const shell = process.platform === 'win32' ? 'powershell' : 'bash';
      const flag = process.platform === 'win32' ? '-Command' : '-c';
      const stdout = execFileSync(shell, [flag, cmd], { cwd, timeout: 60_000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      return { stdout: stdout.slice(0, 100_000) };
    },

    git: async (...args) => {
      requireUnattendedApproval('git_commit');
      const stdout = execFileSync('git', args.map(String), { cwd, timeout: 60_000, encoding: 'utf8' });
      return { stdout: stdout.slice(0, 100_000) };
    },
  };

  return async ({ tool, args }) => {
    const impl = tools[tool];
    if (!impl) throw new Error(`unknown tool: ${tool}`);
    return impl(...(Array.isArray(args) ? args : []));
  };
}

/** Minimal glob: supports **, *, ? and {a,b} alternation. Skips node_modules/.git. */
export function globWalk(root, pattern) {
  const re = globToRegExp(pattern);
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (entry.isDirectory()) walk(abs);
      else if (re.test(rel)) {
        out.push(rel);
        if (out.length >= MAX_RESULTS * 4) return;
      }
    }
  };
  walk(root);
  return out;
}

function globToRegExp(pattern) {
  let re = '';
  let i = 0;
  const p = pattern.replace(/\\/g, '/');
  while (i < p.length) {
    const ch = p[i];
    if (ch === '*') {
      if (p[i + 1] === '*') {
        re += p[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += p[i + 2] === '/' ? 3 : 2;
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '{') {
      const end = p.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
        i++;
      } else {
        const alts = p.slice(i + 1, end).split(',').map(escapeRe);
        re += `(?:${alts.join('|')})`;
        i = end + 1;
      }
    } else {
      re += escapeRe(ch);
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
