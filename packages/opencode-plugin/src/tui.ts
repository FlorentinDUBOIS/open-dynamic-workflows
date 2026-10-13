import type { Plugin } from "@opencode/plugin/tui";
import { createElement, insert, setProp } from "@opentui/solid";
import { createEffect, createSignal, onCleanup, untrack } from "solid-js";
import { collectOdwWorkflows, controlCommand } from "./tui-state.js";

const PLUGIN_ID = "open-dynamic-workflows";
const ROUTE = "odw-dashboard";
const MODE = "odw.dashboard";
const OPEN_COMMAND = "odw.dashboard.open";
const CHILD_LIMIT = 200;
const REFRESH_EVENTS = [
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
  "session.retry.scheduled",
];

type Control = "pause" | "resume" | "stop";

async function setup(context: Plugin.Context): Promise<() => void> {
  const [children, setChildren] = createSignal<unknown[]>([]);
  const [parentID, setParentID] = createSignal<string>();
  const [view, updateView] = context.storage.store("sidebar", { initial: { collapsed: false } });
  const synced = new Set<string>();
  let refreshing: Promise<void> | undefined;
  let again = false;

  const load = async (id: string): Promise<void> => {
    const response = await context.client.session.list({ parentID: id, limit: CHILD_LIMIT, order: "asc" });
    const list = (response.data ?? []) as Array<{ id: string }>;
    for (const child of list) {
      // Messages of a synced session then follow the live event stream.
      if (!synced.has(child.id)) {
        synced.add(child.id);
        void context.data.session.message.sync(child.id).catch(() => synced.delete(child.id));
      }
    }
    setChildren(list);
  };

  // Overlapping refreshes coalesce: one runs, and at most one more follows it.
  const refresh = async (sessionID?: string): Promise<void> => {
    const id = sessionID ?? parentID();
    if (!id) return;
    setParentID(id);
    if (refreshing) {
      again = true;
      return refreshing;
    }
    refreshing = load(id)
      .catch(() => undefined)
      .finally(() => { refreshing = undefined; });
    await refreshing;
    if (again) {
      again = false;
      await refresh();
    }
  };

  const workflows = () => collectOdwWorkflows(
    parentID() ?? "",
    children(),
    (id: string) => context.data.session.status(id),
    (id: string) => context.data.session.message.list(id),
  );

  const sendControl = async (workflowID: string, action: Control): Promise<void> => {
    const parent = parentID();
    if (!parent) return;
    try {
      await context.client.session.command({ sessionID: parent, ...controlCommand(workflowID, action) });
    } catch (error) {
      context.ui.toast.show({ variant: "error", title: "Workflows", message: error instanceof Error ? error.message : String(error) });
    }
    await refresh(parent);
  };

  const newest = (action: Control) => () => {
    const workflow = workflows()[0];
    if (workflow) void sendControl(workflow.id, action);
  };

  const toggle = (): void => {
    void updateView((draft) => { draft.collapsed = !draft.collapsed; })
      .catch((error) => console.error("Failed to persist the Workflows sidebar state", error));
  };

  const open = (): void => {
    const route = context.ui.router.current();
    const sessionID = route.type === "session" ? route.sessionID : parentID();
    if (sessionID) context.ui.router.navigate({ type: "plugin", name: ROUTE, data: { sessionID } });
  };

  const close = (): void => {
    const sessionID = parentID();
    if (sessionID) context.ui.router.navigate({ type: "session", sessionID });
  };

  context.ui.router.register({
    name: ROUTE,
    render: ({ data }) => {
      const sessionID = typeof data?.sessionID === "string" ? data.sessionID : parentID();
      void refresh(sessionID);
      onCleanup(context.keymap.mode.push(MODE));
      const box = createElement("box");
      setProp(box, "flexDirection", "column");
      setProp(box, "padding", 1);
      insert(box, () => renderDashboard(context, workflows(), sendControl));
      return box as never;
    },
  });

  // Reachable from the command palette in every input mode; the shortcut itself is base-mode only.
  context.keymap.layer(() => ({
    mode: "global",
    commands: [{
      id: OPEN_COMMAND,
      title: "Open Workflows Dashboard",
      group: "Workflows",
      palette: true,
      bind: "<leader>w",
      run: open,
    }],
  }));

  context.keymap.layer(() => ({ bindings: [OPEN_COMMAND] }));

  context.keymap.layer(() => ({
    mode: MODE,
    commands: [
      { id: "odw.dashboard.close", title: "Close Workflows dashboard", bind: "escape", run: close },
      { id: "odw.dashboard.pause", title: "Pause newest workflow", bind: "p", run: newest("pause") },
      { id: "odw.dashboard.resume", title: "Resume newest workflow", bind: "r", run: newest("resume") },
      { id: "odw.dashboard.stop", title: "Stop newest workflow", bind: "s", run: newest("stop") },
    ],
    bindings: ["odw.dashboard.close", "odw.dashboard.pause", "odw.dashboard.resume", "odw.dashboard.stop"],
  }));

  const stopEvents = context.data.listen(({ details }) => {
    if (REFRESH_EVENTS.includes(details.type)) void refresh();
  });

  context.ui.slot({
    append: "sidebar.content",
    render: (input) => {
      createEffect(() => {
        const sessionID = input.sessionID;
        untrack(() => void refresh(sessionID));
      });
      const box = createElement("box");
      setProp(box, "flexDirection", "column");
      setProp(box, "paddingTop", 1);
      insert(box, () => renderSidebar(context, workflows(), view.collapsed, toggle));
      return box as never;
    },
  });

  return stopEvents;
}

function renderSidebar(context: Plugin.Context, workflows: any[], collapsed: boolean, toggle: () => void): unknown[] {
  const theme = context.theme;
  const active = workflows.filter((workflow) => workflow.status === "running").length;
  const nodes: unknown[] = [text(`${collapsed ? "▶" : "▼"} Workflows (${active} active, ${workflows.length} total)`, {
    fg: theme.text.base,
    bold: true,
    onMouseDown: (event: { button: number; stopPropagation(): void }) => {
      if (event.button === 0) { event.stopPropagation(); toggle(); }
    },
  })];
  if (collapsed) return nodes;
  if (!workflows.length) return [...nodes, text("  idle", { fg: theme.text.muted })];
  for (const workflow of workflows) {
    nodes.push(text(`  • ${workflow.id.slice(0, 14)} ${workflow.status}`, { fg: statusColor(context, workflow.status) }));
    nodes.push(text(`    ${workflow.profile} · ${workflow.nodes.length} nodes`, { fg: theme.text.muted }));
  }
  return nodes;
}

function renderDashboard(context: Plugin.Context, workflows: any[], control: (id: string, action: Control) => Promise<void>): unknown[] {
  const theme = context.theme;
  const nodes: unknown[] = [text("Workflows", { fg: theme.text.base, bold: true })];
  nodes.push(text("p pause · r resume · s stop · esc close", { fg: theme.text.muted }));
  if (!workflows.length) return [...nodes, text("No workflows for this session.", { fg: theme.text.muted })];
  for (const workflow of workflows) {
    nodes.push(text(`${workflow.id}  ${workflow.status}  ${workflow.profile}`, { fg: statusColor(context, workflow.status), bold: true }));
    for (const node of workflow.nodes) {
      nodes.push(text(`  • ${node.nodeID} ${node.role} ${node.status}${node.model ? ` ${node.model}` : ""}`, { fg: statusColor(context, node.status) }));
      if (node.error) nodes.push(text(`    ${node.error}`, { fg: theme.text.feedback.error.base }));
    }
    const row = text("  [pause] [resume] [stop]", {
      fg: theme.text.action.primary.base,
      onMouseDown: () => void control(workflow.id, workflow.status === "running" ? "pause" : "resume"),
    });
    nodes.push(row);
  }
  return nodes;
}

function statusColor(context: Plugin.Context, status: string): unknown {
  const theme = context.theme;
  if (status === "failed" || status === "error") return theme.text.feedback.error.base;
  if (status === "retrying" || status === "paused" || status === "reconciliation-required") return theme.text.feedback.warning.base;
  if (status === "running" || status === "completed") return theme.text.feedback.success.base;
  return theme.text.muted;
}

function text(content: string, props: Record<string, unknown> = {}): unknown {
  const node = createElement("text");
  for (const [key, value] of Object.entries(props)) setProp(node, key, value as never);
  insert(node, content);
  return node;
}

const plugin: Plugin.Definition = { id: PLUGIN_ID, setup };
export default plugin;
