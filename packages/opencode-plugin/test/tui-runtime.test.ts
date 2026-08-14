import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { testRender } from "@opentui/solid";
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure";

ensureRuntimePluginSupport();

test("tracked TUI bundle loads through OpenTUI and uses the v2 session client", async () => {
  const root = mkdtempSync(join(tmpdir(), "odw-tui-"));
  try {
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    const bundle = join(root, "tui.js");
    cpSync(new URL("../dist/tui.js", import.meta.url), bundle);

    const mod = await import(`${pathToFileURL(bundle).href}?test=${Date.now()}`);
    expect(Object.keys(mod)).toEqual(["default"]);
    expect(mod.default.id).toBe("open-dynamic-workflows");
    expect(typeof mod.default.tui).toBe("function");

    const childrenRequests: unknown[] = [];
    const commandRequests: unknown[] = [];
    const layers: any[] = [];
    const routes: any[] = [];
    const slots: any[] = [];
    const disposals: Array<() => void> = [];
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

    const api = {
      kv: { get: (_key: string, fallback: unknown) => fallback, set() {} },
      client: { session: {
        children: async (request: unknown) => {
          childrenRequests.push(request);
          return { data: [child] };
        },
        command: async (request: unknown) => {
          commandRequests.push(request);
          return { data: undefined };
        },
      } },
      state: { session: {
        status: () => ({ type: "busy" }),
        messages: () => [],
      } },
      route: {
        register: (items: any[]) => {
          routes.push(...items);
          return () => {};
        },
        current: { name: "session", params: { sessionID: "parent" } },
        navigate() {},
      },
      mode: { push: () => () => {} },
      keymap: {
        registerLayer: (layer: any) => {
          layers.push(layer);
          return () => {};
        },
      },
      event: { on: () => () => {} },
      slots: {
        register: (slot: any) => {
          slots.push(slot);
          return "open-dynamic-workflows";
        },
      },
      lifecycle: {
        onDispose: (dispose: () => void) => {
          disposals.push(dispose);
          return () => {};
        },
      },
      theme: { current: {
        text: "#ffffff",
        textMuted: "#888888",
        error: "#ff0000",
        warning: "#ffff00",
        success: "#00ff00",
        accent: "#00ffff",
      } },
    };

    await mod.default.tui(api);

    const sidebar = await testRender(
      () => slots[0].slots.sidebar_content({}, { session_id: "parent" }),
      { width: 80, height: 24 },
    );
    try {
      await Bun.sleep(0);
      await sidebar.flush();
      expect(childrenRequests[0]).toEqual({ sessionID: "parent" });
      expect(sidebar.captureCharFrame()).toContain("ODW (");
    } finally {
      sidebar.renderer.destroy();
    }

    const base = layers.find((layer) => layer.mode === "base");
    expect(base.commands).toContainEqual(expect.objectContaining({
      name: "odw.dashboard.open",
      title: "Open ODW Dashboard",
    }));
    expect(base.bindings).toContainEqual(expect.objectContaining({
      key: "<leader>w",
      cmd: "odw.dashboard.open",
    }));

    const route = routes.find((item) => item.name === "odw-dashboard");
    const dashboard = await testRender(
      () => route.render({ params: { sessionID: "parent" } }),
      { width: 100, height: 30 },
    );
    try {
      await dashboard.waitForFrame((frame) => frame.includes("Open Dynamic Workflows"));
    } finally {
      dashboard.renderer.destroy();
    }

    const controls = layers.find((layer) => layer.mode === "odw.dashboard");
    for (const [key, action] of [["p", "pause"], ["r", "resume"], ["s", "stop"]]) {
      controls.bindings.find((binding: any) => binding.key === key).cmd();
      await Bun.sleep(0);
      expect(commandRequests.at(-1)).toEqual({
        sessionID: "parent",
        command: "odw-control",
        arguments: `odw_ab12 ${action}`,
      });
    }

    for (const dispose of disposals) dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
