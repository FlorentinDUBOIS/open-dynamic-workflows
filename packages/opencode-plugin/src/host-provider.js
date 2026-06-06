/**
 * OpenCode host-model backend for ODW's embedded orchestrator.
 *
 * Maps an ODW agent job onto OpenCode's own SDK so every sub-agent runs on the
 * user's ALREADY-CONFIGURED model/auth — no external ODW key, no daemon. This is
 * the leaf that the embedded orchestrator calls in place of an external provider.
 *
 * Verified against @opencode-ai/sdk (^1.2.x):
 *  - body.model is an OBJECT { providerID, modelID } — so we OMIT it to inherit
 *    the host's configured model (the keyless win); only set it if explicitly forced.
 *  - there is NO body.format / json_schema field — structured output is handled by
 *    the queue's existing schema-suffix + tolerant extractJson cascade upstream.
 *  - the reply text lives in the response's top-level `parts` array, not in `info`.
 *  - body.system is a first-class field for the system prompt.
 */

export function createOpencodeBackend(client, opts = {}) {
  const poolSize = Math.max(1, opts.poolSize ?? 4);
  let sessions = null; // lazily-created pool of child sessions for parallel fan-out
  let rr = 0;

  function readId(created) {
    return created?.id ?? created?.data?.id ?? null;
  }

  async function ensureSessions() {
    if (sessions) return sessions;
    sessions = [];
    if (typeof client?.session?.create === 'function') {
      for (let i = 0; i < poolSize; i++) {
        try {
          const id = readId(await client.session.create({ body: { title: `odw-agent-${i}` } }));
          if (id) sessions.push(id);
        } catch { /* best-effort; degrade to a smaller pool */ }
      }
    }
    // Fall back to a caller-provided session id if we couldn't create our own.
    if (!sessions.length && opts.sessionID) sessions.push(opts.sessionID);
    return sessions;
  }

  async function invoke(job, { signal } = {}) {
    const pool = await ensureSessions();
    if (!pool.length) {
      throw new Error('opencode backend: no session available (client.session.create unavailable)');
    }
    const id = pool[rr++ % pool.length]; // round-robin avoids same-session serialization

    const body = {
      parts: [{ type: 'text', text: String(job.prompt ?? '') }],
      noReply: true,
    };
    if (job.systemPrompt) body.system = String(job.systemPrompt);
    // model OMITTED → inherit the user's configured OpenCode model/auth (keyless).
    // Only force a specific model when explicitly requested as "providerID/modelID".
    if (typeof opts.model === 'string' && opts.model.includes('/')) {
      const [providerID, modelID] = opts.model.split('/');
      body.model = { providerID, modelID };
    }

    const init = signal ? { signal } : undefined;
    const res = await client.session.prompt({ path: { id }, body }, init);
    const payload = res?.data ?? res ?? {};
    const parts = payload.parts ?? payload.info?.parts ?? [];
    const text = parts
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    return { text };
  }

  async function dispose() {
    if (!sessions) return;
    if (typeof client?.session?.delete === 'function') {
      for (const id of sessions) {
        try { await client.session.delete({ path: { id } }); } catch { /* ignore */ }
      }
    }
    sessions = null;
  }

  return { invoke, dispose };
}
