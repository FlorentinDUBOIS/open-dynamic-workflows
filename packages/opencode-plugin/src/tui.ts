import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createElement, insert, setProp } from "@opentui/solid";
import { createSignal, onCleanup } from "solid-js";
import { collectOdwWorkflows, controlCommand } from "./tui-state.js";

const PLUGIN_ID = "open-dynamic-workflows";
const COLLAPSED_KEY = "odw.sidebar.collapsed";
const MODE = "odw.dashboard";

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  const [children, setChildren] = createSignal<unknown[]>([]);
  const [parentID, setParentID] = createSignal<string>();
  const [collapsed, setCollapsed] = createSignal(api.kv.get(COLLAPSED_KEY, false));

  const refresh = async (sessionID?: string): Promise<void> => {
    const id = sessionID ?? parentID();
    if (!id) return;
    setParentID(id);
    const response = await api.client.session.children({ sessionID: id });
    setChildren((response.data ?? response) as unknown[]);
  };

  const workflows = () => collectOdwWorkflows(
    parentID() ?? "",
    children(),
    (id: string) => api.state.session.status(id),
    (id: string) => api.state.session.messages(id),
  );

  const sendControl = async (workflowID: string, action: "pause" | "resume" | "stop"): Promise<void> => {
    const parent = parentID();
    if (!parent) return;
    const command = controlCommand(workflowID, action);
    await api.client.session.command({ sessionID: parent, ...command });
    await refresh(parent);
  };

  const toggle = (): void => {
    const next = !collapsed();
    setCollapsed(next);
    api.kv.set(COLLAPSED_KEY, next);
  };

  const unregisterRoute = api.route.register([{
    name: "odw-dashboard",
    render: ({ params }) => {
      const sessionID = typeof params?.sessionID === "string" ? params.sessionID : parentID();
      void refresh(sessionID);
      const popMode = api.mode.push(MODE);
      onCleanup(popMode);
      const box = createElement("box");
      setProp(box, "flexDirection", "column");
      setProp(box, "padding", 1);
      insert(box, () => renderDashboard(api, workflows(), sendControl));
      return box as never;
    },
  }]);

  const unregisterCommand = api.keymap.registerLayer({
    commands: [{
      name: "odw.dashboard.open",
      title: "Open ODW Dashboard",
      category: "Open Dynamic Workflows",
      namespace: "palette",
      run() {
        const current = api.route.current;
        const sessionID = current.name === "session" ? current.params.sessionID : parentID();
        if (sessionID) api.route.navigate("odw-dashboard", { sessionID });
      },
    }],
    bindings: [],
  });

  const unregisterShortcut = api.keymap.registerLayer({
    mode: "base",
    bindings: [{ key: "<leader>w", cmd: "odw.dashboard.open", desc: "ODW dashboard" }],
  });

  const unregisterDashboardKeys = api.keymap.registerLayer({
    mode: MODE,
    bindings: [
      { key: "escape", cmd: () => parentID() && api.route.navigate("session", { sessionID: parentID() }), desc: "Close dashboard" },
      { key: "p", cmd: () => workflows()[0] && void sendControl(workflows()[0].id, "pause"), desc: "Pause newest workflow" },
      { key: "r", cmd: () => workflows()[0] && void sendControl(workflows()[0].id, "resume"), desc: "Resume newest workflow" },
      { key: "s", cmd: () => workflows()[0] && void sendControl(workflows()[0].id, "stop"), desc: "Stop newest workflow" },
    ],
  });

  const unregisterEvents = [
    api.event.on("session.created", () => void refresh()),
    api.event.on("session.updated", () => void refresh()),
    api.event.on("session.status", () => void refresh()),
    api.event.on("message.updated", () => void refresh()),
  ];

  api.slots.register({
    order: 210,
    slots: {
      sidebar_content(_ctx, props: { session_id: string }) {
        void refresh(props.session_id);
        const box = createElement("box");
        setProp(box, "flexDirection", "column");
        setProp(box, "paddingTop", 1);
        insert(box, () => renderSidebar(api, workflows(), collapsed(), toggle));
        return box as never;
      },
    },
  });

  api.lifecycle.onDispose(() => {
    unregisterRoute();
    unregisterCommand();
    unregisterShortcut();
    unregisterDashboardKeys();
    for (const unregister of unregisterEvents) unregister();
  });
};

function renderSidebar(api: TuiPluginApi, workflows: any[], collapsed: boolean, toggle: () => void): unknown[] {
  const active = workflows.filter((workflow) => workflow.status === "running").length;
  const nodes: unknown[] = [text(`${collapsed ? "▶" : "▼"} ODW (${active} active, ${workflows.length} total)`, {
    fg: api.theme.current.text,
    bold: true,
    onMouseDown: (event: { button: number; stopPropagation(): void }) => {
      if (event.button === 0) { event.stopPropagation(); toggle(); }
    },
  })];
  if (collapsed) return nodes;
  if (!workflows.length) return [...nodes, text("  idle", { fg: api.theme.current.textMuted })];
  for (const workflow of workflows) {
    nodes.push(text(`  • ${workflow.id.slice(0, 14)} ${workflow.status}`, { fg: statusColor(api, workflow.status) }));
    nodes.push(text(`    ${workflow.profile} · ${workflow.nodes.length} nodes`, { fg: api.theme.current.textMuted }));
  }
  return nodes;
}

function renderDashboard(api: TuiPluginApi, workflows: any[], control: (id: string, action: "pause" | "resume" | "stop") => Promise<void>): unknown[] {
  const nodes: unknown[] = [text("Open Dynamic Workflows", { fg: api.theme.current.text, bold: true })];
  nodes.push(text("p pause · r resume · s stop · esc close", { fg: api.theme.current.textMuted }));
  if (!workflows.length) return [...nodes, text("No workflows for this session.", { fg: api.theme.current.textMuted })];
  for (const workflow of workflows) {
    nodes.push(text(`${workflow.id}  ${workflow.status}  ${workflow.profile}`, { fg: statusColor(api, workflow.status), bold: true }));
    for (const node of workflow.nodes) {
      nodes.push(text(`  • ${node.nodeID} ${node.role} ${node.status}${node.model ? ` ${node.model}` : ""}`, { fg: statusColor(api, node.status) }));
      if (node.error) nodes.push(text(`    ${node.error}`, { fg: api.theme.current.error }));
    }
    const row = text("  [pause] [resume] [stop]", {
      fg: api.theme.current.accent,
      onMouseDown: () => void control(workflow.id, workflow.status === "running" ? "pause" : "resume"),
    });
    nodes.push(row);
  }
  return nodes;
}

function statusColor(api: TuiPluginApi, status: string): unknown {
  if (status === "failed" || status === "error") return api.theme.current.error;
  if (status === "retrying" || status === "paused" || status === "reconciliation-required") return api.theme.current.warning;
  if (status === "running" || status === "completed") return api.theme.current.success;
  return api.theme.current.textMuted;
}

function text(content: string, props: Record<string, unknown> = {}): unknown {
  const node = createElement("text");
  for (const [key, value] of Object.entries(props)) setProp(node, key, value as never);
  insert(node, content);
  return node;
}

const plugin: TuiPluginModule & { id: string } = { id: PLUGIN_ID, tui };
export default plugin;
