import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { testRender } from "@opentui/solid";
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure";
import { createStore } from "solid-js/store";

ensureRuntimePluginSupport();

test("tracked TUI bundle loads through OpenTUI and uses the v2 plugin context", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-tui-"));
  try {
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    const bundle = join(root, "tui.js");
    cpSync(new URL("../dist/tui.js", import.meta.url), bundle);

    const mod = await import(`${pathToFileURL(bundle).href}?test=${Date.now()}`);
    expect(Object.keys(mod)).toEqual(["default"]);
    expect(mod.default.id).toBe("open-dynamic-workflows");
    expect(typeof mod.default.setup).toBe("function");

    const listRequests: unknown[] = [];
    const commandRequests: unknown[] = [];
    const syncedMessages: string[] = [];
    const navigationRequests: unknown[] = [];
    const toasts: any[] = [];
    let failCommands = false;
    const pushedModes: string[] = [];
    const layers: any[] = [];
    const pages: any[] = [];
    const slots: any[] = [];
    const listeners: Array<(event: { details: { type: string } }) => void> = [];
    let unsubscribed = 0;
    const child = {
      id: "child",
      parentID: "parent",
      metadata: {
        odw: true,
        odwWorkflowID: "odw_ab12",
        odwNodeID: "analysis",
        odwRole: "analysis",
        odwProfile: "balanced",
      },
      time: { created: 1, updated: 2 },
    };
    const color = (value: string) => ({ base: value, muted: value });

    const context = {
      storage: {
        store: (_key: string, options: { initial: object }) => {
          const [store, set] = createStore(options.initial as { collapsed: boolean });
          return [store, async (mutation: (draft: { collapsed: boolean }) => void) => set((draft) => mutation(draft))];
        },
      },
      client: { session: {
        list: async (request: unknown) => {
          listRequests.push(request);
          return { data: [child], cursor: {} };
        },
        command: async (request: unknown) => {
          commandRequests.push(request);
          if (failCommands) throw new Error("workflow is already completed");
        },
      } },
      data: {
        listen: (handler: (event: { details: { type: string } }) => void) => {
          listeners.push(handler);
          return () => { unsubscribed++; };
        },
        session: {
          status: () => "running",
          message: {
            list: () => [],
            sync: async (id: string) => { syncedMessages.push(id); },
          },
        },
      },
      keymap: {
        layer: (factory: () => any) => { layers.push(factory()); },
        mode: { push: (mode: string) => { pushedModes.push(mode); return () => {}; } },
      },
      ui: {
        router: {
          register: (page: any) => { pages.push(page); return () => {}; },
          current: () => ({ type: "session", sessionID: "parent" }),
          navigate: (destination: unknown) => navigationRequests.push(destination),
        },
        slot: (claim: any) => { slots.push(claim); return () => {}; },
        toast: { show: (toast: unknown) => toasts.push(toast) },
      },
      theme: { text: {
        base: "#ffffff",
        muted: "#888888",
        action: { primary: color("#00ffff") },
        feedback: { error: color("#ff0000"), warning: color("#ffff00"), success: color("#00ff00"), info: color("#0000ff") },
      } },
    };

    const cleanup = await mod.default.setup(context);
    expect(typeof cleanup).toBe("function");

    expect(slots).toHaveLength(1);
    expect(slots[0].append).toBe("sidebar.content");
    const sidebar = await testRender(
      () => slots[0].render({ sessionID: "parent" }),
      { width: 80, height: 24 },
    );
    try {
      await Bun.sleep(0);
      await sidebar.flush();
      expect(listRequests[0]).toEqual({ parentID: "parent", limit: 200, order: "asc" });
      expect(syncedMessages).toEqual(["child"]);
      expect(sidebar.captureCharFrame()).toContain("Workflows (");
    } finally {
      sidebar.renderer.destroy();
    }

    const palette = layers.find((layer) => layer.commands?.some((command: any) => command.id === "odw.dashboard.open"));
    expect(palette.mode).toBe("global");
    expect(palette.commands).toContainEqual(expect.objectContaining({
      id: "odw.dashboard.open",
      title: "Open Workflows Dashboard",
      group: "Workflows",
      palette: true,
      bind: "<leader>w",
    }));
    palette.commands[0].run();
    expect(navigationRequests.at(-1)).toEqual({ type: "plugin", name: "odw-dashboard", data: { sessionID: "parent" } });

    const base = layers.find((layer) => layer.bindings?.includes("odw.dashboard.open"));
    expect(base.mode).toBeUndefined();

    const page = pages.find((item) => item.name === "odw-dashboard");
    const dashboard = await testRender(
      () => page.render({ data: { sessionID: "parent" } }),
      { width: 100, height: 30 },
    );
    try {
      await dashboard.waitForFrame((frame) => frame.includes("Workflows") && frame.includes("analysis"));
      expect(pushedModes).toEqual(["odw.dashboard"]);
    } finally {
      dashboard.renderer.destroy();
    }

    const controls = layers.find((layer) => layer.mode === "odw.dashboard");
    expect(controls.bindings).toEqual(controls.commands.map((command: any) => command.id));
    for (const [key, action] of [["p", "pause"], ["r", "resume"], ["s", "stop"]]) {
      controls.commands.find((command: any) => command.bind === key).run();
      await Bun.sleep(0);
      expect(commandRequests.at(-1)).toEqual({
        sessionID: "parent",
        name: "odw-control",
        text: `odw_ab12 ${action}`,
      });
    }
    failCommands = true;
    controls.commands.find((command: any) => command.bind === "p").run();
    await Bun.sleep(0);
    expect(toasts).toEqual([{ variant: "error", title: "Workflows", message: "workflow is already completed" }]);
    controls.commands.find((command: any) => command.bind === "escape").run();
    expect(navigationRequests.at(-1)).toEqual({ type: "session", sessionID: "parent" });

    const before = listRequests.length;
    for (const listener of listeners) listener({ details: { type: "message.unrelated" } });
    await Bun.sleep(0);
    expect(listRequests).toHaveLength(before);
    for (const listener of listeners) listener({ details: { type: "session.step.ended" } });
    await Bun.sleep(0);
    expect(listRequests.length).toBeGreaterThan(before);

    cleanup();
    expect(unsubscribed).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
