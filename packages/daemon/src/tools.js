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

    // ── web research (read-only, no approval needed) ──────────────────────────
    web_fetch: async (url) => {
      const u = String(url);
      if (!/^https?:\/\//i.test(u)) throw new Error('web_fetch: url must be http(s)');
      const res = await fetch(u, { headers: { 'user-agent': 'odw-research/1.0' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`web_fetch ${res.status} for ${u}`);
      const html = await res.text();
      // strip scripts/styles/tags → readable text
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-z#0-9]+;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return { url: u, text: text.slice(0, 8000) };
    },

    web_search: async (query) => {
      // Keyless search via DuckDuckGo's HTML endpoint. Best-effort; returns
      // {title, url, snippet}. If it ever fails, the workflow degrades to
      // model knowledge — the research gate tolerates an empty result.
      const q = encodeURIComponent(String(query));
      const res = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, {
        method: 'POST',
        headers: { 'user-agent': 'Mozilla/5.0 (odw-research)', 'content-type': 'application/x-www-form-urlencoded' },
        body: `q=${q}`,
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`web_search ${res.status}`);
      const html = await res.text();
      const out = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = re.exec(html)) && out.length < 8) {
        let href = m[1];
        const dd = href.match(/uddg=([^&]+)/);
        if (dd) { try { href = decodeURIComponent(dd[1]); } catch { /* keep */ } }
        const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        if (title && /^https?:/i.test(href)) out.push({ title, url: href });
      }
      return out;
    },

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
      // Case-insensitive: Windows command names (Remove-Item, FORMAT) are
      // case-insensitive, so a case-sensitive guard would be trivially bypassed.
      const lower = cmd.toLowerCase();
      for (const blocked of safety.blockedCommands ?? []) {
        if (lower.includes(String(blocked).toLowerCase())) throw new Error(`blocked command pattern: ${blocked}`);
      }
      const shell = process.platform === 'win32' ? 'powershell' : 'bash';
      const flag = process.platform === 'win32' ? '-Command' : '-c';
      try {
        const stdout = execFileSync(shell, [flag, cmd], { cwd, timeout: 120_000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        return { stdout: String(stdout).slice(0, 100_000), exitCode: 0 };
      } catch (e) {
        // A non-zero exit (e.g. a failing test suite) is NOT a tool error — the
        // command's output is the useful signal. Capture stdout+stderr and the
        // exit code so callers (e.g. a fix-until-green loop) can act on it.
        const out = String((e.stdout || '') + (e.stderr || '')).slice(0, 100_000);
        return { stdout: out || String(e.message), exitCode: typeof e.status === 'number' ? e.status : 1, failed: true };
      }
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
