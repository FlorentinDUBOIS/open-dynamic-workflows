// packages/opencode-plugin/src/tui.ts
import { createElement as k, insert as v, setProp as h } from "@opentui/solid";
import { createSignal as b, onCleanup as _ } from "solid-js";

// packages/opencode-plugin/src/tui-state.js
function P(e, t, s, r) {
  let u = /* @__PURE__ */ new Map;
  for (let o of t ?? []) {
    let n = o?.metadata ?? {};
    if (o?.parentID !== e || n.odw !== !0)
      continue;
    if (n.odwParentSessionID && n.odwParentSessionID !== e)
      continue;
    let a = D(n.odwWorkflowID);
    if (!a)
      continue;
    let i = u.get(a);
    if (!i)
      i = {
        id: a,
        parentSessionID: e,
        profile: D(n.odwProfile) ?? "balanced",
        status: "completed",
        children: [],
        nodes: [],
        startedAt: E(n.odwStartedAt) ?? o.time?.created,
        updatedAt: o.time?.updated ?? o.time?.created
      }, u.set(a, i);
    let g = s(o.id)?.type ?? "idle", f = [...r(o.id) ?? []].reverse().find((y) => y.role === "assistant"), p = {
      sessionID: o.id,
      nodeID: D(n.odwNodeID) ?? o.id,
      role: D(n.odwRole) ?? "agent",
      model: W(o, f),
      status: T(g, f),
      durationMs: S(o, f),
      error: f?.error ? String(f.error?.message ?? f.error) : void 0
    };
    if (i.children.push(o.id), i.nodes.push(p), p.status === "running" || p.status === "retrying")
      i.status = "running";
    else if (p.status === "error" && i.status !== "running")
      i.status = "failed";
    i.updatedAt = Math.max(i.updatedAt ?? 0, o.time?.updated ?? f?.time?.completed ?? 0);
  }
  return [...u.values()].sort((o, n) => (n.updatedAt ?? 0) - (o.updatedAt ?? 0));
}
function T(e, t) {
  if (e === "busy")
    return "running";
  if (e === "retry")
    return "retrying";
  if (t?.error)
    return "error";
  return t?.time?.completed ? "completed" : "queued";
}
function W(e, t) {
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
function D(e) {
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
var L = "open-dynamic-workflows", M = "odw.sidebar.collapsed", O = "odw.dashboard", N = async (e) => {
  let [t, s] = b([]), [r, u] = b(), [o, n] = b(e.kv.get(M, !1)), a = async (d) => {
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
    let w = $(d, l);
    await e.client.session.command({ sessionID: c, ...w }), await a(c);
  }, I = () => {
    let d = !o();
    n(d), e.kv.set(M, d);
  }, f = e.route.register([{
    name: "odw-dashboard",
    render: ({ params: d }) => {
      let l = typeof d?.sessionID === "string" ? d.sessionID : r();
      a(l);
      let c = e.mode.push(O);
      _(c);
      let w = k("box");
      return h(w, "flexDirection", "column"), h(w, "padding", 1), v(w, () => q(e, i(), g)), w;
    }
  }]), p = e.keymap.registerLayer({
    commands: [{
      name: "odw.dashboard.open",
      title: "Open ODW Dashboard",
      category: "Open Dynamic Workflows",
      namespace: "palette",
      run() {
        let d = e.route.current, l = d.name === "session" ? d.params.sessionID : r();
        if (l)
          e.route.navigate("odw-dashboard", { sessionID: l });
      }
    }],
    bindings: []
  }), y = e.keymap.registerLayer({
    mode: "base",
    bindings: [{ key: "<leader>w", cmd: "odw.dashboard.open", desc: "ODW dashboard" }]
  }), A = e.keymap.registerLayer({
    mode: O,
    bindings: [
      { key: "escape", cmd: () => r() && e.route.navigate("session", { sessionID: r() }), desc: "Close dashboard" },
      { key: "p", cmd: () => i()[0] && void g(i()[0].id, "pause"), desc: "Pause newest workflow" },
      { key: "r", cmd: () => i()[0] && void g(i()[0].id, "resume"), desc: "Resume newest workflow" },
      { key: "s", cmd: () => i()[0] && void g(i()[0].id, "stop"), desc: "Stop newest workflow" }
    ]
  }), C = [
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
        let c = k("box");
        return h(c, "flexDirection", "column"), h(c, "paddingTop", 1), v(c, () => R(e, i(), o(), I)), c;
      }
    }
  }), e.lifecycle.onDispose(() => {
    f(), p(), y(), A();
    for (let d of C)
      d();
  });
};
function R(e, t, s, r) {
  let u = t.filter((n) => n.status === "running").length, o = [m(`${s ? "▶" : "▼"} ODW (${u} active, ${t.length} total)`, {
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
    return [...o, m("  idle", { fg: e.theme.current.textMuted })];
  for (let n of t)
    o.push(m(`  • ${n.id.slice(0, 14)} ${n.status}`, { fg: x(e, n.status) })), o.push(m(`    ${n.profile} · ${n.nodes.length} nodes`, { fg: e.theme.current.textMuted }));
  return o;
}
function q(e, t, s) {
  let r = [m("Open Dynamic Workflows", { fg: e.theme.current.text, bold: !0 })];
  if (r.push(m("p pause · r resume · s stop · esc close", { fg: e.theme.current.textMuted })), !t.length)
    return [...r, m("No workflows for this session.", { fg: e.theme.current.textMuted })];
  for (let u of t) {
    r.push(m(`${u.id}  ${u.status}  ${u.profile}`, { fg: x(e, u.status), bold: !0 }));
    for (let n of u.nodes)
      if (r.push(m(`  • ${n.nodeID} ${n.role} ${n.status}${n.model ? ` ${n.model}` : ""}`, { fg: x(e, n.status) })), n.error)
        r.push(m(`    ${n.error}`, { fg: e.theme.current.error }));
    let o = m("  [pause] [resume] [stop]", {
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
function m(e, t = {}) {
  let s = k("text");
  for (let [r, u] of Object.entries(t))
    h(s, r, u);
  return v(s, e), s;
}
var K = { id: L, tui: N }, z = K;
export {
  z as default
};
