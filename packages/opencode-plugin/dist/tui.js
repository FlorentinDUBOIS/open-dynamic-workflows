// packages/opencode-plugin/src/tui.ts
import { createElement as D, insert as v, setProp as h } from "@opentui/solid";
import { createEffect as q, createSignal as E, onCleanup as H, untrack as U } from "solid-js";

// packages/opencode-plugin/src/tui-state.js
function C(e, o, t, i) {
  let a = /* @__PURE__ */ new Map;
  for (let r of o ?? []) {
    let d = r?.metadata ?? {};
    if (r?.parentID !== e || d.odw !== !0)
      continue;
    if (d.odwParentSessionID && d.odwParentSessionID !== e)
      continue;
    let n = k(d.odwWorkflowID);
    if (!n)
      continue;
    let l = a.get(n);
    if (!l)
      l = {
        id: n,
        parentSessionID: e,
        profile: k(d.odwProfile) ?? "balanced",
        status: "completed",
        children: [],
        nodes: [],
        startedAt: L(d.odwStartedAt) ?? r.time?.created,
        updatedAt: r.time?.updated ?? r.time?.created
      }, a.set(n, l);
    let w = t(r.id) ?? "idle", c = [...i(r.id) ?? []].reverse().find((b) => b.type === "assistant"), m = {
      sessionID: r.id,
      nodeID: k(d.odwNodeID) ?? r.id,
      role: k(d.odwRole) ?? "agent",
      model: T(r, c),
      status: _(w, c),
      durationMs: F(r, c),
      error: c?.error ? String(c.error?.message ?? c.error) : void 0
    };
    if (l.children.push(r.id), l.nodes.push(m), m.status === "running" || m.status === "retrying")
      l.status = "running";
    else if (m.status === "error" && l.status !== "running")
      l.status = "failed";
    l.updatedAt = Math.max(l.updatedAt ?? 0, r.time?.updated ?? c?.time?.completed ?? 0);
  }
  return [...a.values()].sort((r, d) => (d.updatedAt ?? 0) - (r.updatedAt ?? 0));
}
function _(e, o, t = Date.now()) {
  if (e === "running")
    return o?.retry?.at > t ? "retrying" : "running";
  if (o?.error)
    return "error";
  return o?.time?.completed ? "completed" : "queued";
}
function T(e, o) {
  let t = o?.model ?? e?.model;
  if (typeof t === "string")
    return t;
  if (t?.providerID && t?.id)
    return `${t.providerID}/${t.id}`;
  return;
}
function F(e, o) {
  let t = e.time?.created ?? o?.time?.created, i = o?.time?.completed ?? e.time?.updated;
  return t && i ? Math.max(0, i - t) : void 0;
}
function k(e) {
  return typeof e === "string" && e.length ? e : void 0;
}
function L(e) {
  return Number.isFinite(e) ? e : void 0;
}
function x(e, o) {
  if (!/^odw_[a-f0-9]+$/.test(e))
    throw Error("invalid ODW workflow id");
  if (!["pause", "resume", "stop", "replay", "skip"].includes(o))
    throw Error("invalid ODW control action");
  return { name: "odw-control", text: `${e} ${o}` };
}

// packages/opencode-plugin/src/tui.ts
var V = "open-dynamic-workflows", W = "odw-dashboard", O = "odw.dashboard", M = "odw.dashboard.open", j = 200, G = [
  "session.created",
  "session.deleted",
  "session.status",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.retry.scheduled"
];
async function z(e) {
  let [o, t] = E([]), [i, a] = E(), [r, d] = e.storage.store("sidebar", { initial: { collapsed: !1 } }), n = /* @__PURE__ */ new Set, l, w = !1, P = async (s) => {
    let f = (await e.client.session.list({ parentID: s, limit: j, order: "asc" })).data ?? [];
    for (let g of f)
      if (!n.has(g.id))
        n.add(g.id), e.data.session.message.sync(g.id).catch(() => n.delete(g.id));
    t(f);
  }, c = async (s) => {
    let u = s ?? i();
    if (!u)
      return;
    if (a(u), l)
      return w = !0, l;
    if (l = P(u).catch(() => {
      return;
    }).finally(() => {
      l = void 0;
    }), await l, w)
      w = !1, await c();
  }, m = () => C(i() ?? "", o(), (s) => e.data.session.status(s), (s) => e.data.session.message.list(s)), b = async (s, u) => {
    let f = i();
    if (!f)
      return;
    try {
      await e.client.session.command({ sessionID: f, ...x(s, u) });
    } catch (g) {
      e.ui.toast.show({ variant: "error", title: "Workflows", message: g instanceof Error ? g.message : String(g) });
    }
    await c(f);
  }, y = (s) => () => {
    let u = m()[0];
    if (u)
      b(u.id, s);
  }, S = () => {
    d((s) => {
      s.collapsed = !s.collapsed;
    }).catch((s) => console.error("Failed to persist the Workflows sidebar state", s));
  }, A = () => {
    let s = e.ui.router.current(), u = s.type === "session" ? s.sessionID : i();
    if (u)
      e.ui.router.navigate({ type: "plugin", name: W, data: { sessionID: u } });
  }, N = () => {
    let s = i();
    if (s)
      e.ui.router.navigate({ type: "session", sessionID: s });
  };
  e.ui.router.register({
    name: W,
    render: ({ data: s }) => {
      let u = typeof s?.sessionID === "string" ? s.sessionID : i();
      c(u), H(e.keymap.mode.push(O));
      let f = D("box");
      return h(f, "flexDirection", "column"), h(f, "padding", 1), v(f, () => J(e, m(), b)), f;
    }
  }), e.keymap.layer(() => ({
    mode: "global",
    commands: [{
      id: M,
      title: "Open Workflows Dashboard",
      group: "Workflows",
      palette: !0,
      bind: "<leader>w",
      run: A
    }]
  })), e.keymap.layer(() => ({ bindings: [M] })), e.keymap.layer(() => ({
    mode: O,
    commands: [
      { id: "odw.dashboard.close", title: "Close Workflows dashboard", bind: "escape", run: N },
      { id: "odw.dashboard.pause", title: "Pause newest workflow", bind: "p", run: y("pause") },
      { id: "odw.dashboard.resume", title: "Resume newest workflow", bind: "r", run: y("resume") },
      { id: "odw.dashboard.stop", title: "Stop newest workflow", bind: "s", run: y("stop") }
    ],
    bindings: ["odw.dashboard.close", "odw.dashboard.pause", "odw.dashboard.resume", "odw.dashboard.stop"]
  }));
  let R = e.data.listen(({ details: s }) => {
    if (G.includes(s.type))
      c();
  });
  return e.ui.slot({
    append: "sidebar.content",
    render: (s) => {
      q(() => {
        let f = s.sessionID;
        U(() => void c(f));
      });
      let u = D("box");
      return h(u, "flexDirection", "column"), h(u, "paddingTop", 1), v(u, () => B(e, m(), r.collapsed, S)), u;
    }
  }), R;
}
function B(e, o, t, i) {
  let a = e.theme, r = o.filter((n) => n.status === "running").length, d = [p(`${t ? "▶" : "▼"} Workflows (${r} active, ${o.length} total)`, {
    fg: a.text.base,
    bold: !0,
    onMouseDown: (n) => {
      if (n.button === 0)
        n.stopPropagation(), i();
    }
  })];
  if (t)
    return d;
  if (!o.length)
    return [...d, p("  idle", { fg: a.text.muted })];
  for (let n of o)
    d.push(p(`  • ${n.id.slice(0, 14)} ${n.status}`, { fg: I(e, n.status) })), d.push(p(`    ${n.profile} · ${n.nodes.length} nodes`, { fg: a.text.muted }));
  return d;
}
function J(e, o, t) {
  let i = e.theme, a = [p("Workflows", { fg: i.text.base, bold: !0 })];
  if (a.push(p("p pause · r resume · s stop · esc close", { fg: i.text.muted })), !o.length)
    return [...a, p("No workflows for this session.", { fg: i.text.muted })];
  for (let r of o) {
    a.push(p(`${r.id}  ${r.status}  ${r.profile}`, { fg: I(e, r.status), bold: !0 }));
    for (let n of r.nodes)
      if (a.push(p(`  • ${n.nodeID} ${n.role} ${n.status}${n.model ? ` ${n.model}` : ""}`, { fg: I(e, n.status) })), n.error)
        a.push(p(`    ${n.error}`, { fg: i.text.feedback.error.base }));
    let d = p("  [pause] [resume] [stop]", {
      fg: i.text.action.primary.base,
      onMouseDown: () => void t(r.id, r.status === "running" ? "pause" : "resume")
    });
    a.push(d);
  }
  return a;
}
function I(e, o) {
  let t = e.theme;
  if (o === "failed" || o === "error")
    return t.text.feedback.error.base;
  if (o === "retrying" || o === "paused" || o === "reconciliation-required")
    return t.text.feedback.warning.base;
  if (o === "running" || o === "completed")
    return t.text.feedback.success.base;
  return t.text.muted;
}
function p(e, o = {}) {
  let t = D("text");
  for (let [i, a] of Object.entries(o))
    h(t, i, a);
  return v(t, e), t;
}
var K = { id: V, setup: z }, oe = K;
export {
  oe as default
};
