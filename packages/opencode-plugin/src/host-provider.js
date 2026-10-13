/**
 * OpenCode host-model backend for ODW's embedded orchestrator.
 *
 * Maps an ODW agent job onto OpenCode's own plugin context so every sub-agent runs on
 * the user's ALREADY-CONFIGURED model/auth — no external ODW key, no daemon. This is
 * the leaf that the embedded orchestrator calls in place of an external provider.
 *
 * Written against the OpenCode 2 Promise plugin context (`ctx.session`), verified LIVE
 * against OpenCode 2.0.28 (isolated server, local OpenAI-compatible mock):
 *  - `session.prompt` is a QUEUED write: it resolves with the inbox entry, never with
 *    the reply, and carries no agent/model/variant/system. The routing therefore moves
 *    to `session.create` (agent, model {id, providerID, variant}, permissions,
 *    metadata), the per-node system prompt is injected through a `context` session
 *    hook (see createSystemPrompts), and the reply is read back from
 *    `session.context` once the session has gone idle.
 *  - `session.wait` resolves when the session's run settles, but it was observed to
 *    resolve once while a provider retry was still pending. Every child is
 *    single-use, so completion is only trusted when the transcript ends with the
 *    `idle` marker message; otherwise the wait is repeated.
 *  - The `idle` marker carries `outcome` (`succeeded`, `failed`, `interrupted`) and the
 *    failing assistant message carries `error`; a failure without any reply text is
 *    surfaced as the retryable `service_unavailable` the queue already understands.
 *  - Cancellation is `session.interrupt`; the host retries a failing provider for
 *    about 85 seconds on its own before reporting the failure, which is kept.
 *  - There is NO model default: omitting `model` inherits the host's configured one.
 *  - The `prompt` session hook also fires for the plugin's own child prompts, which is
 *    why `onSessionCreate` must register a child before its prompt is sent.
 *
 * ISOLATION: every invoke() runs in a FRESH, SINGLE-USE child session. Prompts append
 * to a session's conversation history, so a reused/pooled session would leak every
 * previous agent's conversation into the next agent's context (cross-task
 * contamination + unbounded context growth). Create overhead is ~tens of ms against
 * multi-second model calls, and fresh sessions also give unlimited parallel fan-out
 * with zero same-session serialization (30 parallel children verified live).
 *
 * Children are NOT deleted per call or at dispose(): they stay attached to the parent
 * so the TUI dashboard can show them, and OpenCode deletes them with the parent. The
 * plugin's ledger lets the next start sweep the ones whose parent lock is gone.
 */

const SETTLE_POLL_MS = 250;

/**
 * Per-session system prompts. OpenCode 2 has no per-prompt `system` field, so the
 * plugin registers one `context` hook that appends the entry for the requesting
 * session; the backend sets it before the prompt and clears it afterwards.
 */
export function createSystemPrompts() {
  const prompts = new Map();
  return {
    set: (sessionID, text) => prompts.set(sessionID, text),
    delete: (sessionID) => prompts.delete(sessionID),
    apply(event) {
      const text = prompts.get(event?.sessionID);
      if (text) event.system.push({ type: 'text', text });
    },
  };
}

export function createOpencodeBackend(host, opts = {}) {
  const created = [];

  async function invoke(job, { signal } = {}) {
    const sessions = host?.session;
    let id = null;
    let createError;
    if (typeof sessions?.create === 'function') {
      try {
        let parent;
        if (opts.parentSessionID && typeof sessions.get === 'function') {
          try {
            parent = await sessions.get({ sessionID: opts.parentSessionID });
          } catch { /* a missing parent ruleset means the configured agent policy applies */ }
        }
        const routed = opts.modelForRole?.(job.role) ?? {};
        const model = resolveModel(job.model ?? routed.model ?? opts.model);
        const readOnly = job.role === 'reconstruction';
        const agent = readOnly ? (opts.readOnlyAgent ?? 'plan') : opts.agent;
        const permissions = readOnly ? readOnlyPermissions() : parent?.permissions;
        const variant = job.variant ?? routed.variant;
        const session = await sessions.create(defined({
          title: `odw-${job.workflowId ?? opts.workflowID ?? 'workflow'}-${job.nodeId ?? created.length}`,
          parentID: opts.parentSessionID,
          agent: agent ? String(agent) : undefined,
          model: model ? defined({ id: model.modelID, providerID: model.providerID, variant: variant ? String(variant) : undefined }) : undefined,
          metadata: defined({
            odw: true,
            odwParentSessionID: opts.parentSessionID,
            odwWorkflowID: job.workflowId ?? opts.workflowID,
            odwNodeID: job.nodeId,
            odwRole: job.role,
            odwProfile: opts.profile,
            odwStartedAt: Date.now(),
          }),
          permissions,
        }));
        id = session?.id ?? null;
      } catch (error) { createError = error; /* fall through to the caller-provided session below */ }
      if (id) {
        created.push(id);
        // Let the caller track ODW-owned sessions so its prompt hook can skip
        // them — child prompts MUST NOT re-trigger orchestration.
        opts.onSessionCreate?.(id);
      }
    }
    // Degraded fallback only: a caller-provided session accumulates history
    // across calls (no isolation) — better than failing outright.
    if (!id && opts.sessionID) id = opts.sessionID;
    if (!id) {
      throw new Error(
        `opencode backend: no session available (session.create unavailable${createError ? `: ${String(createError?.message ?? createError)}` : ''})`,
      );
    }

    let text = String(job.prompt ?? '');
    if (job.systemPrompt) {
      if (opts.systemPrompts) opts.systemPrompts.set(id, String(job.systemPrompt));
      else text = `${job.systemPrompt}\n\n${text}`;
    }
    try {
      await sessions.prompt({ sessionID: id, text });
      const messages = await settle(sessions, id, signal);
      return reply(messages);
    } finally {
      opts.systemPrompts?.delete(id);
    }
  }

  async function dispose() {
    created.length = 0;
  }

  return { invoke, dispose, createdSessions: () => [...created] };
}

/** Waits until the child's transcript ends with the `idle` marker and returns the transcript. */
async function settle(sessions, sessionID, signal) {
  const aborted = abortion(signal);
  try {
    for (;;) {
      await race(sessions.wait({ sessionID }), aborted);
      const messages = await race(sessions.context({ sessionID }), aborted);
      if (messages?.at(-1)?.type === 'idle') return messages;
      await race(sleep(SETTLE_POLL_MS), aborted);
    }
  } catch (error) {
    if (error?.name === 'AbortError') await sessions.interrupt?.({ sessionID }).catch(() => {});
    throw error;
  } finally {
    aborted?.dispose();
  }
}

function reply(messages) {
  const idle = messages.at(-1);
  const assistant = [...messages].reverse().find((message) => message?.type === 'assistant');
  const text = (assistant?.content ?? [])
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  if (process.env.ODW_DEBUG && !reply._shapeLogged) {
    reply._shapeLogged = true;
    console.error(`[odw] first reply shape: messages=${messages.length} outcome=${idle?.outcome} content=${(assistant?.content ?? []).map((part) => part?.type).join(',')} text.length=${text.length}`);
  }
  // An unreachable/failed upstream settles the session as `failed` with the error on
  // the assistant message and the idle marker, and an interrupted one settles with an
  // aborted step. Treat them as retryable host-protocol failures so they do not stall
  // the embedded queue as empty schema-correction replies. A turn that only ran
  // native OpenCode tools resolves with no ODW text-protocol JSON and is returned as-is.
  const failure = assistant?.error ?? idle?.error;
  if (!text && (failure || idle?.outcome === 'failed' || idle?.outcome === 'interrupted')) {
    const err = new Error(`opencode backend: empty reply — host error: ${JSON.stringify(failure ?? { outcome: idle?.outcome }).slice(0, 200)}`);
    err.code = 'service_unavailable';
    throw err;
  }
  return { text };
}

function abortion(signal) {
  if (!signal) return null;
  const error = () => Object.assign(new Error('opencode backend: aborted'), { name: 'AbortError' });
  let listener;
  const promise = new Promise((_, reject) => {
    if (signal.aborted) return reject(error());
    listener = () => reject(error());
    signal.addEventListener('abort', listener, { once: true });
  });
  promise.catch(() => {});
  return { promise, dispose: () => listener && signal.removeEventListener('abort', listener) };
}

function race(promise, aborted) {
  return aborted ? Promise.race([promise, aborted.promise]) : promise;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function readOnlyPermissions() {
  return [
    { action: 'edit', resource: '*', effect: 'deny' },
    { action: 'shell', resource: '*', effect: 'deny' },
    { action: 'subagent', resource: '*', effect: 'deny' },
    { action: 'slack_*', resource: '*', effect: 'deny' },
  ];
}

function resolveModel(value) {
  if (typeof value !== 'string' || !value.includes('/')) return undefined;
  const [providerID, ...rest] = value.split('/');
  const modelID = rest.join('/');
  return providerID && modelID ? { providerID, modelID } : undefined;
}
