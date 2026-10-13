// An in-memory stand-in for the OpenCode 2 Promise plugin context, shaped from what OpenCode 2.0.28
// returned in a live isolated run (session.create -> SessionInfo, prompt -> queued inbox entry,
// wait -> void, context -> transcript ending with an `idle` marker, event.subscribe -> async iterable).
// It has no test of its own; the node test runner just loads it as an empty file.

export function createFakeHost(options = {}) {
  const sessions = new Map();
  const hooks = { prompt: [], context: [] };
  const commands = new Map();
  const tools = new Map();
  const store = new Map();
  const subscribers = new Set();
  const calls = { create: [], prompt: [], synthetic: [], remove: [], interrupt: [], wait: [] };
  let sequence = 0;
  let early = options.earlyWaits ?? 0;

  function transcript(id) {
    const session = sessions.get(id);
    if (!session) throw new Error(`session not found: ${id}`);
    return session;
  }

  async function run(session, text) {
    const event = { sessionID: session.info.id, agent: session.info.agent, system: [], messages: [], tools: {} };
    for (const hook of hooks.context) await hook(event);
    session.system = event.system.map((part) => part.text);
    await new Promise((resolve) => setTimeout(resolve, options.latency ?? 0));
    const reply = await (options.respond ?? (() => '{"findings":[],"confidence":1}'))(text, session);
    const now = Date.now();
    const base = { id: `msg_${++sequence}`, time: { created: now } };
    if (reply instanceof Error) {
      const error = { type: 'provider.internal', message: reply.message, status: 500 };
      session.messages.push({ ...base, type: 'assistant', agent: session.info.agent, model: session.info.model, content: [], finish: 'error', error });
      session.messages.push({ id: `msg_${++sequence}`, time: { created: now }, type: 'idle', outcome: 'failed', error });
      session.info.outcome = 'failed';
      return;
    }
    session.messages.push({
      ...base, type: 'assistant', agent: session.info.agent, model: session.info.model,
      content: reply === '' ? [] : [{ type: 'text', text: reply }], finish: 'stop',
    });
    session.messages.push({ id: `msg_${++sequence}`, time: { created: now }, type: 'idle', outcome: 'succeeded' });
    session.info.outcome = 'succeeded';
  }

  const ctx = {
    location: { directory: options.directory ?? '/tmp/odw-fake' },
    options: {},
    session: {
      async create(input) {
        calls.create.push(input);
        const info = {
          id: `ses_${++sequence}`, agent: input.agent, model: input.model && { variant: 'default', ...input.model },
          title: input.title, parentID: input.parentID, metadata: input.metadata, permissions: input.permissions,
        };
        if (options.failCreate) throw new Error('create failed');
        sessions.set(info.id, { info, messages: [], done: Promise.resolve(), system: [] });
        return info;
      },
      async get({ sessionID }) {
        if (options.sessions?.[sessionID]) return options.sessions[sessionID];
        return transcript(sessionID).info;
      },
      async remove({ sessionID }) {
        calls.remove.push(sessionID);
        transcript(sessionID);
        sessions.delete(sessionID);
      },
      async prompt({ sessionID, text, metadata }) {
        const session = transcript(sessionID);
        calls.prompt.push({ sessionID, text, metadata });
        session.messages.push({ id: `msg_${++sequence}`, time: { created: Date.now() }, type: 'user', text });
        session.done = run(session, text);
        return { id: `msg_${sequence}`, sessionID, type: 'user', payload: { text } };
      },
      async wait({ sessionID }) {
        calls.wait.push(sessionID);
        const session = transcript(sessionID);
        if (early > 0) { early--; return; }
        await session.done;
      },
      async context({ sessionID }) {
        return [...transcript(sessionID).messages];
      },
      async interrupt({ sessionID }) {
        calls.interrupt.push(sessionID);
        return { interrupted: true };
      },
      async synthetic(input) {
        calls.synthetic.push(input);
        return { id: `msg_${++sequence}`, type: 'synthetic', payload: { text: input.text } };
      },
      async hook(name, callback) {
        hooks[name].push(callback);
        return { dispose: async () => { hooks[name].splice(hooks[name].indexOf(callback), 1); } };
      },
    },
    command: {
      async transform(callback) { callback({ add: (definition) => commands.set(definition.name, definition) }); },
    },
    tool: {
      async transform(callback) { callback({ add: (definition) => tools.set(definition.name, definition) }); },
    },
    storage: {
      async get(key) { return store.get(key); },
      async set(key, value) { store.set(key, value); },
      async remove(key) { store.delete(key); },
      async scan({ prefix, after, limit = 100 }) {
        const keys = [...store.keys()].filter((key) => key.startsWith(prefix) && (after === undefined || key > after)).sort();
        const page = keys.slice(0, limit);
        return {
          entries: page.map((key) => ({ key, value: store.get(key) })),
          ...(keys.length > limit ? { next: page.at(-1) } : {}),
        };
      },
    },
    event: {
      subscribe({ signal } = {}) {
        const queue = [];
        let wake;
        const subscriber = { push(event) { queue.push(event); wake?.(); } };
        subscribers.add(subscriber);
        signal?.addEventListener('abort', () => wake?.(), { once: true });
        return {
          async *[Symbol.asyncIterator]() {
            try {
              while (!signal?.aborted) {
                if (!queue.length) await new Promise((resolve) => { wake = resolve; });
                while (queue.length) yield queue.shift();
              }
            } finally {
              subscribers.delete(subscriber);
            }
          },
        };
      },
    },
  };

  return {
    ctx,
    calls,
    hooks,
    commands,
    tools,
    store,
    sessions,
    emit(event) { for (const subscriber of subscribers) subscriber.push(event); },
    subscribers: () => subscribers.size,
    // Runs the registered prompt hooks the way the host does before admitting a user prompt.
    async submit(sessionID, text, extra = {}) {
      const event = { sessionID, messageID: `msg_${++sequence}`, prompt: { text }, delivery: 'steer', ...extra };
      for (const hook of hooks.prompt) await hook(event);
      return event;
    },
  };
}
