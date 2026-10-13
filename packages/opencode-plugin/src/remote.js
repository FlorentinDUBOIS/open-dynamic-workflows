import { createWorkflowController, parseControlArguments } from './controller.js';
import { createOpencodeBackend, createSystemPrompts } from './host-provider.js';
import { DEFAULT_PROFILE, PROFILE_NAMES, parseOdwArguments } from './profiles.js';
import { createSessionState } from './session-state.js';
import { createChildLedger, sweepStaleChildren } from './stale-sweep.js';

export const PLUGIN_ID = 'open-dynamic-workflows';

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

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export async function setup(ctx) {
  const directory = ctx.location.directory;
  const state = createSessionState();
  const systemPrompts = createSystemPrompts();
  const ledger = createChildLedger(ctx.storage);
  const events = new AbortController();
  let controller;
  const staleSweep = sweepStaleChildren(ctx, ledger).catch(() => null);

  async function getController() {
    if (controller) return controller;
    const { createEmbeddedOrchestrator } = await import('odw-daemon/embedded');
    controller = createWorkflowController({
      host: ctx,
      directory,
      state,
      createOrchestrator: createEmbeddedOrchestrator,
      createBackend: (host, options) => createOpencodeBackend(host, {
        ...options,
        systemPrompts,
        onSessionCreate(childID) {
          options.onSessionCreate(childID);
          ledger.add(options.parentSessionID, childID).catch(() => {});
        },
      }),
    });
    return controller;
  }

  async function start(sessionID, prompt, profile, mode, agent) {
    if (!sessionID) throw new Error('ODW requires a parent session');
    return (await getController()).start({ sessionID, prompt, profile, mode, agent });
  }

  async function agentOf(sessionID) {
    try {
      return (await ctx.session.get({ sessionID })).agent;
    } catch {
      return undefined;
    }
  }

  function startedText(workflow) {
    return `[open-dynamic-workflows] ${workflow.id} started with profile ${workflow.profile}. The embedded workflow owns this request; do not duplicate its work.`;
  }

  // A command answers with a synthetic transcript entry (verified visible in the TUI) that does
  // not start a model turn; the model reads its text with the next prompt.
  const answer = (sessionID, text, description = text) => ctx.session.synthetic({ sessionID, text, description, resume: false });

  await ctx.command.transform((commands) => {
    commands.add({
      name: 'odw',
      description: 'Start an embedded Open Dynamic Workflow',
      async execute({ sessionID, prompt }) {
        const parsed = parseOdwArguments(prompt.text);
        const workflow = await start(sessionID, parsed.task, parsed.profile, 'command', await agentOf(sessionID));
        await answer(sessionID, startedText(workflow), `ODW ${workflow.id} started (${workflow.profile})`);
      },
    });
    commands.add({
      name: 'odw-control',
      description: 'Pause, resume, or stop an ODW workflow',
      async execute({ sessionID, prompt }) {
        const parsed = parseControlArguments(prompt.text);
        const activeController = await getController();
        const workflow = ['replay', 'skip'].includes(parsed.action)
          ? await activeController.reconcile(sessionID, parsed.workflowID, parsed.nodeID, parsed.action, parsed.evidence)
          : await activeController.control(sessionID, parsed.workflowID, parsed.action);
        await answer(sessionID, `[open-dynamic-workflows] ${workflow.id} is ${workflow.status} after ${parsed.action}.`);
      },
    });
    commands.add({
      name: 'odw-ultracode',
      description: 'Set session-scoped Ultracode on or off',
      async execute({ sessionID, prompt }) {
        const value = String(prompt.text ?? '').trim().toLowerCase();
        if (!['on', 'off'].includes(value)) throw new Error('usage: /odw-ultracode <on|off>');
        const enabled = state.setUltracode(sessionID, value === 'on');
        await answer(sessionID, `ODW Ultracode is ${enabled ? 'on' : 'off'} for this session.`);
      },
    });
  });

  await ctx.session.hook('prompt', async (event) => {
    if (!event?.sessionID || state.isChild(event.sessionID) || state.consumeFallback(event.messageID)) return;
    const text = event.prompt?.text;
    if (typeof text !== 'string') return;
    const explicit = detectRemoteTrigger(text);
    const effective = explicit ?? (state.ultracode(event.sessionID) && text.trim().length > 40
      ? { mode: 'ultracode', prompt: text }
      : null);
    if (!effective) return;
    try {
      const workflow = await start(event.sessionID, effective.prompt, DEFAULT_PROFILE, effective.mode, await agentOf(event.sessionID));
      event.prompt.text = startedText(workflow);
    } catch (error) {
      event.prompt.text = `${text}\n\n[ODW could not start: ${String(error?.message ?? error)}. Handle the original request once in this parent session.]`;
    }
  });

  await ctx.session.hook('context', (event) => systemPrompts.apply(event));

  await ctx.tool.transform((tools) => {
    tools.add({
      name: 'odw_run',
      description: 'Start an embedded dynamic workflow and return its id immediately.',
      input: object({ prompt: { type: 'string' }, profile: { type: 'string', enum: [...PROFILE_NAMES] } }, ['prompt']),
      options: { codemode: false },
      async execute({ prompt, profile }, context) {
        return { content: JSON.stringify(await start(context.sessionID, prompt, profile ?? DEFAULT_PROFILE, 'tool', context.agent)) };
      },
    });
    tools.add({
      name: 'odw_status',
      description: 'List embedded workflows belonging to the current parent session.',
      input: object({}),
      options: { codemode: false },
      async execute(_input, context) {
        return { content: JSON.stringify(controller ? controller.list(context.sessionID) : [], null, 2) };
      },
    });
    tools.add({
      name: 'odw_control',
      description: 'Pause, resume, or stop an embedded workflow.',
      input: object({ workflowID: { type: 'string' }, action: { type: 'string', enum: ['pause', 'resume', 'stop'] } }, ['workflowID', 'action']),
      options: { codemode: false },
      async execute({ workflowID, action }, context) {
        return { content: JSON.stringify(await (await getController()).control(context.sessionID, workflowID, action)) };
      },
    });
    tools.add({
      name: 'odw_ultracode',
      description: 'Enable or disable Ultracode for this parent session.',
      input: object({ enabled: { type: 'boolean' } }, ['enabled']),
      options: { codemode: false },
      async execute({ enabled }, context) {
        return { content: `ODW Ultracode is ${state.setUltracode(context.sessionID, enabled) ? 'on' : 'off'} for this session.` };
      },
    });
  });

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: events.signal })) {
        if (event?.type !== 'session.deleted') continue;
        const sessionID = event.data?.sessionID;
        if (sessionID && state.has(sessionID)) await (await getController()).remove(sessionID).catch(() => {});
      }
    } catch { /* the subscription ends with the plugin */ }
  })();

  return async () => {
    events.abort();
    await staleSweep;
    await state.dispose();
  };
}

export default { id: PLUGIN_ID, setup };
