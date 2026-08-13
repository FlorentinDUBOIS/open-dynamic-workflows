import { tool } from '@opencode-ai/plugin';
import { createWorkflowController, parseControlArguments } from './controller.js';
import { createOpencodeBackend } from './host-provider.js';
import { DEFAULT_PROFILE, PROFILE_NAMES, parseOdwArguments } from './profiles.js';
import { createSessionState } from './session-state.js';
import { sweepStaleChildren } from './stale-sweep.js';

const ULTRACODE = /(^|\W)ultracode(\W|$)/i;
const DEEP_RESEARCH = /(^|\s)\/?deep-research(\s|$|:)/i;
const WORKFLOW_INTENT = [
  /^\s*workflow\s*:/i,
  /\b(?:run|start|launch|use|create)\s+(?:a\s+|the\s+)?workflow\b/i,
  /\bas\s+a\s+workflow\b/i,
  /\bdynamic\s+workflow\b/i,
  /\bworkflow\s+to\b/i,
];
const NEGATIVE = [
  /\b(my|our|the team's|git|ci|release|approval)\s+workflows?\b/i,
  /\bworkflows?\s+(file|yaml|yml|engine|tab|view)\b/i,
];

export function detectRemoteTrigger(prompt) {
  const text = String(prompt ?? '');
  if (!text.trim()) return null;
  if (DEEP_RESEARCH.test(text)) {
    return { mode: 'deep-research', prompt: text.replace(DEEP_RESEARCH, ' ').replace(/\s+/g, ' ').trim() };
  }
  if (ULTRACODE.test(text)) {
    return { mode: 'ultracode', prompt: text.replace(/(^|\W)ultracode(\W|$)/gi, '$1$2').replace(/\s+/g, ' ').trim() };
  }
  const positive = WORKFLOW_INTENT.some((pattern) => pattern.test(text));
  const negative = NEGATIVE.some((pattern) => pattern.test(text)) && !/^\s*workflow\s*:/i.test(text);
  if (!positive || negative) return null;
  return { mode: 'workflow', prompt: text.replace(/^\s*workflow\s*:\s*/i, '').trim() };
}

export async function RemoteOdwPlugin({ directory, client }) {
  const state = createSessionState();
  let controller;
  const staleSweep = client?.session?.list && client?.session?.delete
    ? sweepStaleChildren(client).catch(() => null)
    : Promise.resolve(null);

  async function getController() {
    if (controller) return controller;
    const { createEmbeddedOrchestrator } = await import('odw-daemon/embedded');
    controller = createWorkflowController({
      client,
      directory,
      state,
      createOrchestrator: createEmbeddedOrchestrator,
      createBackend: createOpencodeBackend,
    });
    return controller;
  }

  async function start(sessionID, prompt, profile, mode, agent) {
    if (!sessionID) throw new Error('ODW requires a parent session');
    return (await getController()).start({ sessionID, prompt, profile, mode, agent });
  }

  function startedPart(workflow) {
    return {
      type: 'text',
      text: `[open-dynamic-workflows] ${workflow.id} started with profile ${workflow.profile}. The embedded workflow owns this request; do not duplicate its work.`,
    };
  }

  return {
    async config(config) {
      config.command ??= {};
      config.command.odw = { description: 'Start an embedded Open Dynamic Workflow', template: '$ARGUMENTS' };
      config.command['odw-control'] = { description: 'Pause, resume, or stop an ODW workflow', template: '$ARGUMENTS' };
      config.command['odw-ultracode'] = { description: 'Set session-scoped Ultracode on or off', template: '$ARGUMENTS' };
    },

    async 'chat.message'(input, output) {
      if (!input?.sessionID || state.isChild(input.sessionID) || state.consumeFallback(input.messageID)) return;
      const part = output.parts?.find((candidate) => candidate.type === 'text' && typeof candidate.text === 'string');
      if (!part) return;
      const explicit = detectRemoteTrigger(part.text);
      const effective = explicit ?? (state.ultracode(input.sessionID) && part.text.trim().length > 40
        ? { mode: 'ultracode', prompt: part.text }
        : null);
      if (!effective) return;
      try {
        const workflow = await start(input.sessionID, effective.prompt, DEFAULT_PROFILE, effective.mode, input.agent);
        part.text = startedPart(workflow).text;
      } catch (error) {
        part.text = `${part.text}\n\n[ODW could not start: ${String(error?.message ?? error)}. Handle the original request once in this parent session.]`;
      }
    },

    async 'command.execute.before'(input, output) {
      if (input.command === 'odw') {
        const parsed = parseOdwArguments(input.arguments);
        const workflow = await start(input.sessionID, parsed.task, parsed.profile, 'command');
        output.parts.splice(0, output.parts.length, startedPart(workflow));
        return;
      }
      if (input.command === 'odw-control') {
        const parsed = parseControlArguments(input.arguments);
        const activeController = await getController();
        const workflow = ['replay', 'skip'].includes(parsed.action)
          ? await activeController.reconcile(input.sessionID, parsed.workflowID, parsed.nodeID, parsed.action, parsed.evidence)
          : await activeController.control(input.sessionID, parsed.workflowID, parsed.action);
        output.parts.splice(0, output.parts.length, {
          type: 'text',
          text: `[open-dynamic-workflows] ${workflow.id} is ${workflow.status} after ${parsed.action}.`,
        });
        return;
      }
      if (input.command === 'odw-ultracode') {
        const value = String(input.arguments ?? '').trim().toLowerCase();
        if (!['on', 'off'].includes(value)) throw new Error('usage: /odw-ultracode <on|off>');
        const enabled = state.setUltracode(input.sessionID, value === 'on');
        output.parts.splice(0, output.parts.length, { type: 'text', text: `ODW Ultracode is ${enabled ? 'on' : 'off'} for this session.` });
      }
    },

    async event({ event }) {
      if (event?.type !== 'session.deleted') return;
      const sessionID = event.properties?.info?.id ?? event.properties?.sessionID;
      if (sessionID && state.has(sessionID)) await (await getController()).remove(sessionID);
    },

    async dispose() {
      await staleSweep;
      await state.dispose();
    },

    tool: {
      odw_run: tool({
        description: 'Start an embedded dynamic workflow and return its id immediately.',
        args: {
          prompt: tool.schema.string(),
          profile: tool.schema.enum(PROFILE_NAMES).optional(),
        },
        async execute({ prompt, profile }, context) {
          return JSON.stringify(await start(context.sessionID, prompt, profile ?? DEFAULT_PROFILE, 'tool', context.agent));
        },
      }),
      odw_status: tool({
        description: 'List embedded workflows belonging to the current parent session.',
        args: {},
        async execute(_args, context) {
          return JSON.stringify(controller ? controller.list(context.sessionID) : [], null, 2);
        },
      }),
      odw_control: tool({
        description: 'Pause, resume, or stop an embedded workflow.',
        args: {
          workflowID: tool.schema.string(),
          action: tool.schema.enum(['pause', 'resume', 'stop']),
        },
        async execute({ workflowID, action }, context) {
          return JSON.stringify(await (await getController()).control(context.sessionID, workflowID, action));
        },
      }),
      odw_ultracode: tool({
        description: 'Enable or disable Ultracode for this parent session.',
        args: { enabled: tool.schema.boolean() },
        async execute({ enabled }, context) {
          return `ODW Ultracode is ${state.setUltracode(context.sessionID, enabled) ? 'on' : 'off'} for this session.`;
        },
      }),
    },
  };
}

export default RemoteOdwPlugin;
