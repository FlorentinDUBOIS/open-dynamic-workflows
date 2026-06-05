/**
 * open-dynamic-workflows — OpenCode plugin.
 *
 * Self-contained on purpose (node builtins + fetch + @opencode-ai/plugin only),
 * so it works both as an npm plugin (`"plugin": ["odw-opencode"]`) and as a
 * drop-in file in ~/.config/opencode/plugins/.
 *
 * Behavior:
 *  - "chat.message": detects workflow/ultracode intent. With the daemon up it
 *    plans + executes through it and tells the assistant what started; without
 *    the daemon it injects an orchestration directive so the model decomposes
 *    the task with opencode's native subagents (platform-limited), plus a
 *    daemon install hint.
 *  - custom tools: odw_plan / odw_run / odw_status / odw_workflows / odw_ultracode
 *  - slash commands ship as markdown in commands/ (install: copy to .opencode/commands/)
 *
 * @type {import('@opencode-ai/plugin').Plugin}
 */

import { tool } from '@opencode-ai/plugin';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── trigger detection (mirrors odw-core/trigger; inlined to stay dependency-free) ──

const ULTRACODE = /(^|\W)ultracode(\W|$)/i;
const DEEP_RESEARCH = /(^|\s)\/?deep-research(\s|$|:)/i;
const WORKFLOW_INTENT = [
  /^\s*workflow\s*:/i,
  /\brun\s+(a\s+|the\s+)?workflow\b/i,
  /\bstart\s+(a\s+|the\s+)?workflow\b/i,
  /\blaunch\s+(a\s+|the\s+)?workflow\b/i,
  /\buse\s+(a\s+|the\s+)?workflow\b/i,
  /\bas\s+a\s+workflow\b/i,
  /\bdynamic\s+workflow\b/i,
  /\bworkflow\s+to\b/i,
  /\bcreate\s+(a\s+|the\s+)?workflow\b/i,
];
const NEGATIVE = [
  /\b(my|our|the team's|git|ci|release|approval)\s+workflows?\b/i,
  /\bworkflows?\s+(file|yaml|yml|engine|tab|view)\b/i,
];

export function detectTrigger(prompt) {
  const text = String(prompt ?? '');
  if (!text.trim()) return { triggered: false, mode: null, cleanPrompt: '' };
  if (DEEP_RESEARCH.test(text)) {
    return { triggered: true, mode: 'deep-research', cleanPrompt: text.replace(DEEP_RESEARCH, ' ').replace(/\s+/g, ' ').trim() };
  }
  if (ULTRACODE.test(text)) {
    return { triggered: true, mode: 'ultracode', cleanPrompt: text.replace(/(^|\W)ultracode(\W|$)/gi, '$1$2').replace(/\s+/g, ' ').trim() };
  }
  const positive = WORKFLOW_INTENT.some((re) => re.test(text));
  const negative = NEGATIVE.some((re) => re.test(text)) && !/^\s*workflow\s*:/i.test(text);
  if (positive && !negative) {
    return { triggered: true, mode: 'workflow', cleanPrompt: text.replace(/^\s*workflow\s*:\s*/i, '').trim() };
  }
  return { triggered: false, mode: null, cleanPrompt: text.trim() };
}

// ── daemon client ────────────────────────────────────────────────────────────

export function createDaemonClient(port) {
  const base = `http://127.0.0.1:${port}`;
  const request = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(method === 'GET' ? 5000 : 30000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`daemon ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  };
  return {
    base,
    health: async () => {
      try {
        return await request('GET', '/health');
      } catch {
        return null;
      }
    },
    plan: (prompt, options) => request('POST', '/workflows/plan', { prompt, options }),
    exec: (plan, cwd) => request('POST', '/workflows/exec', { plan, cwd }),
    list: () => request('GET', '/workflows'),
    get: (id) => request('GET', `/workflows/${id}`),
    control: (id, action) => request('POST', `/workflows/${id}/ctl`, { action }),
  };
}

export function resolveDaemonPort() {
  if (process.env.ODW_DAEMON_PORT) {
    const fromEnv = Number(process.env.ODW_DAEMON_PORT);
    if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  }
  try {
    const config = JSON.parse(readFileSync(join(process.env.ODW_HOME ?? join(homedir(), '.odw'), 'config.json'), 'utf8'));
    if (config?.daemon?.port) return Number(config.daemon.port);
  } catch {
    /* default */
  }
  return 7345;
}

// ── ultracode state (per project) ────────────────────────────────────────────

function ultracodeStatePath(directory) {
  return join(directory, '.opencode', 'state', 'odw', 'ultracode.json');
}

export function readUltracode(directory) {
  try {
    return JSON.parse(readFileSync(ultracodeStatePath(directory), 'utf8')).enabled === true;
  } catch {
    return false;
  }
}

export function writeUltracode(directory, enabled) {
  const path = ultracodeStatePath(directory);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ enabled, updatedAt: new Date().toISOString() }), 'utf8');
  return enabled;
}

// ── message helpers ──────────────────────────────────────────────────────────

const INSTALL_HINT = 'npm install -g odw-daemon && odw-daemon start';

function planSummary(plan) {
  const e = plan.estimate ?? {};
  return [
    `topology ${plan.topology}`,
    `~${e.totalAgents ?? '?'} agents (max ${e.maxConcurrent ?? '?'} concurrent)`,
    `~${(e.tokens ?? 0).toLocaleString()} tokens`,
    `est. $${e.costUSD ?? '?'}`,
    `~${e.minutes ?? '?'} min`,
  ].join(' · ');
}

function fallbackDirective(cleanPrompt, mode) {
  return [
    `[open-dynamic-workflows · ${mode} trigger · daemon OFFLINE — native fallback]`,
    `Orchestrate this yourself using opencode's native task/subagent capability (platform-limited concurrency):`,
    `1. PLAN FIRST: decompose into a task graph (discovery → fan-out work → adversarial verification → synthesis). State the plan before acting.`,
    `2. Fan out independent items to parallel subagents with hyper-scoped instructions and structured JSON outputs.`,
    `3. Verify aggregated results adversarially (hunt false positives, challenge severity, find gaps) before synthesizing.`,
    `4. Report a final synthesized answer.`,
    `Task: ${cleanPrompt}`,
    `(For 100+ concurrent agents, crash-resume and background execution, install the local daemon: ${INSTALL_HINT})`,
  ].join('\n');
}

// ── the plugin ───────────────────────────────────────────────────────────────

export const OdwPlugin = async ({ directory }) => {
  const port = resolveDaemonPort();
  const daemon = createDaemonClient(port);

  return {
    'chat.message': async (_input, output) => {
      const parts = output?.parts ?? [];
      const textPart = parts.find((p) => p.type === 'text' && typeof p.text === 'string');
      if (!textPart) return;

      const ultra = readUltracode(directory);
      const trigger = detectTrigger(textPart.text);
      const effective = trigger.triggered
        ? trigger
        : ultra && textPart.text.trim().length > 40
          ? { triggered: true, mode: 'ultracode', cleanPrompt: textPart.text.trim() }
          : null;
      if (!effective) return;

      const health = await daemon.health();
      if (!health) {
        textPart.text = fallbackDirective(effective.cleanPrompt, effective.mode);
        return;
      }

      try {
        const { plan } = await daemon.plan(effective.cleanPrompt, { mode: effective.mode });
        const { workflowId } = await daemon.exec(plan, directory);
        textPart.text = [
          `[open-dynamic-workflows · ${effective.mode} trigger · daemon ONLINE]`,
          `A dynamic workflow has been planned and is now executing in the background daemon:`,
          `  workflow  ${workflowId}`,
          `  plan      ${planSummary(plan)}`,
          `Tell the user the workflow started, summarize the plan above, and mention they can check progress with the odw_status tool, the odw_workflows tool, or \`odw-daemon status\` in a shell.`,
          `Original request (handled by the workflow — do NOT redo it yourself): ${effective.cleanPrompt}`,
        ].join('\n');
      } catch (error) {
        textPart.text = [
          `[open-dynamic-workflows · daemon error: ${String(error.message).slice(0, 200)}]`,
          fallbackDirective(effective.cleanPrompt, effective.mode),
        ].join('\n');
      }
    },

    tool: {
      odw_plan: tool({
        description:
          'Plan a dynamic multi-agent workflow without executing it. Returns the task graph, topology, roles, cost/time estimate and the generated orchestration script.',
        args: { prompt: tool.schema.string().describe('what the workflow should accomplish') },
        async execute({ prompt }) {
          if (!(await daemon.health())) return `daemon offline — start it with: ${INSTALL_HINT}`;
          const { plan } = await daemon.plan(prompt);
          return JSON.stringify(
            { planId: plan.planId, topology: plan.topology, estimate: plan.estimate, taskGraph: plan.taskGraph, script: plan.script },
            null,
            2
          ).slice(0, 24000);
        },
      }),

      odw_run: tool({
        description: 'Plan AND execute a dynamic multi-agent workflow via the local odw daemon. Returns the workflow id immediately.',
        args: { prompt: tool.schema.string().describe('what the workflow should accomplish') },
        async execute({ prompt }, context) {
          if (!(await daemon.health())) return `daemon offline — start it with: ${INSTALL_HINT}`;
          const { plan } = await daemon.plan(prompt);
          const { workflowId } = await daemon.exec(plan, context.directory);
          return `workflow ${workflowId} started — ${planSummary(plan)}. Check with odw_status.`;
        },
      }),

      odw_status: tool({
        description: 'Status of one odw workflow: phase, agents completed/failed, cost, result when finished.',
        args: { workflowId: tool.schema.string().describe('the wf_... id') },
        async execute({ workflowId }) {
          if (!(await daemon.health())) return `daemon offline — start it with: ${INSTALL_HINT}`;
          const record = await daemon.get(workflowId);
          return JSON.stringify(
            {
              workflowId,
              status: record.status,
              agents: { total: record.total_agents, completed: record.completed_agents, failed: record.failed_agents },
              costUSD: record.cost_usd,
              nodeStats: record.nodeStats,
            },
            null,
            2
          );
        },
      }),

      odw_workflows: tool({
        description: 'List all workflows known to the local odw daemon with their statuses.',
        args: {},
        async execute() {
          if (!(await daemon.health())) return `daemon offline — start it with: ${INSTALL_HINT}`;
          const { workflows } = await daemon.list();
          if (!workflows.length) return 'no workflows yet';
          return workflows
            .map((w) => `${w.workflow_id}  ${w.status.padEnd(10)} agents ${w.completed_agents}/${w.total_agents}  $${w.cost_usd?.toFixed?.(4) ?? w.cost_usd}  ${String(w.root_prompt).slice(0, 60)}`)
            .join('\n');
        },
      }),

      odw_ultracode: tool({
        description: 'Toggle ultracode mode for this project: when ON, every substantive prompt becomes a planned multi-agent workflow.',
        args: { enabled: tool.schema.boolean().optional().describe('true=on, false=off; omit to toggle') },
        async execute({ enabled }, context) {
          const next = enabled === undefined ? !readUltracode(context.directory) : enabled;
          writeUltracode(context.directory, next);
          return `ultracode mode is now ${next ? 'ON — substantive prompts will be planned and orchestrated as workflows' : 'OFF'}`;
        },
      }),
    },
  };
};

export default OdwPlugin;
