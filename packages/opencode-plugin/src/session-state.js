export function createSessionState() {
  const sessions = new Map();
  const childSessions = new Set();
  const fallbackMessages = new Set();

  const ensure = (sessionID) => {
    let state = sessions.get(sessionID);
    if (!state) {
      state = { ultracode: false, workflows: new Map(), lock: null, fallbackPending: false };
      sessions.set(sessionID, state);
    }
    return state;
  };

  return {
    ensure,
    has: (sessionID) => sessions.has(sessionID),
    ultracode: (sessionID) => ensure(sessionID).ultracode,
    setUltracode(sessionID, enabled) {
      ensure(sessionID).ultracode = enabled === true;
      return ensure(sessionID).ultracode;
    },
    addWorkflow(sessionID, workflow) {
      ensure(sessionID).workflows.set(workflow.id, workflow);
      return workflow;
    },
    workflow(sessionID, workflowID) {
      return sessions.get(sessionID)?.workflows.get(workflowID);
    },
    workflows(sessionID) {
      return [...(sessions.get(sessionID)?.workflows.values() ?? [])];
    },
    registerChild(sessionID) { childSessions.add(sessionID); },
    isChild: (sessionID) => childSessions.has(sessionID),
    unregisterChild(sessionID) { childSessions.delete(sessionID); },
    markFallback(messageID) { if (messageID) fallbackMessages.add(messageID); },
    consumeFallback(messageID) {
      if (!messageID || !fallbackMessages.has(messageID)) return false;
      fallbackMessages.delete(messageID);
      return true;
    },
    markSessionFallback(sessionID) { ensure(sessionID).fallbackPending = true; },
    consumeSessionFallback(sessionID) {
      const state = sessions.get(sessionID);
      if (!state?.fallbackPending) return false;
      state.fallbackPending = false;
      return true;
    },
    async remove(sessionID) {
      const state = sessions.get(sessionID);
      sessions.delete(sessionID);
      if (state?.lock) await state.lock.release();
    },
    async dispose() {
      await Promise.all([...sessions.keys()].map((id) => this.remove(id)));
      childSessions.clear();
      fallbackMessages.clear();
    },
  };
}
