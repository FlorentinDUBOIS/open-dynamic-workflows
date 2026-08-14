// packages/opencode-plugin/src/tui.ts
import { createElement as D, insert as y, setProp as h } from "@opentui/solid";
import { createSignal as v, onCleanup as _ } from "solid-js";

// packages/opencode-plugin/src/tui-state.js
function P(e, t, s, r) {
  let u = /* @__PURE__ */ new Map;
  for (let o of t ?? []) {
    let n = o?.metadata ?? {};
    if (o?.parentID !== e || n.odw !== !0)
      continue;
    if (n.odwParentSessionID && n.odwParentSessionID !== e)
      continue;
    let a = k(n.odwWorkflowID);
    if (!a)
      continue;
    let i = u.get(a);
    if (!i)
      i = {
        id: a,
        parentSessionID: e,
        profile: k(n.odwProfile) ?? "balanced",
        status: "completed",
        children: [],
        nodes: [],
        startedAt: E(n.odwStartedAt) ?? o.time?.created,
        updatedAt: o.time?.updated ?? o.time?.created
      }, u.set(a, i);
    let g = s(o.id)?.type ?? "idle", m = [...r(o.id) ?? []].reverse().find((b) => b.role === "assistant"), w = {
      sessionID: o.id,
      nodeID: k(n.odwNodeID) ?? o.id,
      role: k(n.odwRole) ?? "agent",
      model: O(o, m),
      status: W(g, m),
      durationMs: S(o, m),
      error: m?.error ? String(m.error?.message ?? m.error) : void 0
    };
    if (i.children.push(o.id), i.nodes.push(w), w.status === "running" || w.status === "retrying")
      i.status = "running";
    else if (w.status === "error" && i.status !== "running")
      i.status = "failed";
    i.updatedAt = Math.max(i.updatedAt ?? 0, o.time?.updated ?? m?.time?.completed ?? 0);
  }
  return [...u.values()].sort((o, n) => (n.updatedAt ?? 0) - (o.updatedAt ?? 0));
}
function W(e, t) {
  if (e === "busy")
    return "running";
  if (e === "retry")
    return "retrying";
  if (t?.error)
    return "error";
  return t?.time?.completed ? "completed" : "queued";
}
function O(e, t) {
  let s = t?.model ?? e?.model;
  if (typeof s === "string")
    return s;
  if (s?.providerID && s?.modelID)
    return `${s.providerID}/${s.modelID}`;
  return;
}
function S(e, t) {
  let s = e.time?.created ?? t?.time?.created, r = t?.time?.completed ?? e.time?.updated;
  return s && r ? Math.max(0, r - s) : void 0;
}
function k(e) {
  return typeof e === "string" && e.length ? e : void 0;
}
function E(e) {
  return Number.isFinite(e) ? e : void 0;
}
function $(e, t) {
  if (!/^odw_[a-f0-9]+$/.test(e))
    throw Error("invalid ODW workflow id");
  if (!["pause", "resume", "stop", "replay", "skip"].includes(t))
    throw Error("invalid ODW control action");
  return { command: "odw-control", arguments: `${e} ${t}` };
}

// packages/opencode-plugin/src/tui.ts
var L = "open-dynamic-workflows", M = "odw.sidebar.collapsed", A = "odw.dashboard", N = async (e) => {
  let [t, s] = v([]), [r, u] = v(), [o, n] = v(e.kv.get(M, !1)), a = async (d) => {
    let l = d ?? r();
    if (!l)
      return;
    u(l);
    let c = await e.client.session.children({ sessionID: l });
    s(c.data ?? c);
  }, i = () => P(r() ?? "", t(), (d) => e.state.session.status(d), (d) => e.state.session.messages(d)), g = async (d, l) => {
    let c = r();
    if (!c)
      return;
    let p = $(d, l);
    await e.client.session.command({ sessionID: c, ...p }), await a(c);
  }, I = () => {
    let d = !o();
    n(d), e.kv.set(M, d);
  }, m = e.route.register([{
    name: "odw-dashboard",
    render: ({ params: d }) => {
      let l = typeof d?.sessionID === "string" ? d.sessionID : r();
      a(l);
      let c = e.mode.push(A);
      _(c);
      let p = D("box");
      return h(p, "flexDirection", "column"), h(p, "padding", 1), y(p, () => q(e, i(), g)), p;
    }
  }]), w = e.keymap.registerLayer({
    commands: [{
      name: "odw.dashboard.open",
      title: "Open Workflows Dashboard",
      category: "Workflows",
      namespace: "palette",
      run() {
        let d = e.route.current, l = d.name === "session" ? d.params.sessionID : r();
        if (l)
          e.route.navigate("odw-dashboard", { sessionID: l });
      }
    }],
    bindings: []
  }), b = e.keymap.registerLayer({
    mode: "base",
    bindings: [{ key: "<leader>w", cmd: "odw.dashboard.open", desc: "Workflows dashboard" }]
  }), C = e.keymap.registerLayer({
    mode: A,
    bindings: [
      { key: "escape", cmd: () => r() && e.route.navigate("session", { sessionID: r() }), desc: "Close dashboard" },
      { key: "p", cmd: () => i()[0] && void g(i()[0].id, "pause"), desc: "Pause newest workflow" },
      { key: "r", cmd: () => i()[0] && void g(i()[0].id, "resume"), desc: "Resume newest workflow" },
      { key: "s", cmd: () => i()[0] && void g(i()[0].id, "stop"), desc: "Stop newest workflow" }
    ]
  }), T = [
    e.event.on("session.created", () => void a()),
    e.event.on("session.updated", () => void a()),
    e.event.on("session.status", () => void a()),
    e.event.on("message.updated", () => void a())
  ];
  e.slots.register({
    order: 210,
    slots: {
      sidebar_content(d, l) {
        a(l.session_id);
        let c = D("box");
        return h(c, "flexDirection", "column"), h(c, "paddingTop", 1), y(c, () => R(e, i(), o(), I)), c;
      }
    }
  }), e.lifecycle.onDispose(() => {
    m(), w(), b(), C();
    for (let d of T)
      d();
  });
};
function R(e, t, s, r) {
  let u = t.filter((n) => n.status === "running").length, o = [f(`${s ? "▶" : "▼"} Workflows (${u} active, ${t.length} total)`, {
    fg: e.theme.current.text,
    bold: !0,
    onMouseDown: (n) => {
      if (n.button === 0)
        n.stopPropagation(), r();
    }
  })];
  if (s)
    return o;
  if (!t.length)
    return [...o, f("  idle", { fg: e.theme.current.textMuted })];
  for (let n of t)
    o.push(f(`  • ${n.id.slice(0, 14)} ${n.status}`, { fg: x(e, n.status) })), o.push(f(`    ${n.profile} · ${n.nodes.length} nodes`, { fg: e.theme.current.textMuted }));
  return o;
}
function q(e, t, s) {
  let r = [f("Workflows", { fg: e.theme.current.text, bold: !0 })];
  if (r.push(f("p pause · r resume · s stop · esc close", { fg: e.theme.current.textMuted })), !t.length)
    return [...r, f("No workflows for this session.", { fg: e.theme.current.textMuted })];
  for (let u of t) {
    r.push(f(`${u.id}  ${u.status}  ${u.profile}`, { fg: x(e, u.status), bold: !0 }));
    for (let n of u.nodes)
      if (r.push(f(`  • ${n.nodeID} ${n.role} ${n.status}${n.model ? ` ${n.model}` : ""}`, { fg: x(e, n.status) })), n.error)
        r.push(f(`    ${n.error}`, { fg: e.theme.current.error }));
    let o = f("  [pause] [resume] [stop]", {
      fg: e.theme.current.accent,
      onMouseDown: () => void s(u.id, u.status === "running" ? "pause" : "resume")
    });
    r.push(o);
  }
  return r;
}
function x(e, t) {
  if (t === "failed" || t === "error")
    return e.theme.current.error;
  if (t === "retrying" || t === "paused" || t === "reconciliation-required")
    return e.theme.current.warning;
  if (t === "running" || t === "completed")
    return e.theme.current.success;
  return e.theme.current.textMuted;
}
function f(e, t = {}) {
  let s = D("text");
  for (let [r, u] of Object.entries(t))
    h(s, r, u);
  return y(s, e), s;
}
var K = { id: L, tui: N }, z = K;
export {
  z as default
};
