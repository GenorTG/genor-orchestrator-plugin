/**
 * PLUGIN-002g — Subagent & Cleanup Hook Tests
 *
 * Tests: subagent_spawned, subagent_ended, agent_end, gateway_stop
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createMockApi,
  prepareTestDataDir,
  registerPlugin,
  unwrap,
  type MockApiType,
} from "./setup.js";

let plugin: any;
beforeEach(async () => {
  vi.resetModules();
  plugin = (await import("../src/index.js")).default;
});

async function setupDefault(): Promise<{
  api: MockApiType;
  dd: string;
  hooks: Record<string, Function>;
  sessionKey: string;
}> {
  const dd = prepareTestDataDir();
  const api = createMockApi();
  await registerPlugin(dd, plugin, api);

  const regResult = await api.tools.get("genorch_session_register")!("", {});
  const rr = typeof regResult?.details === "object" ? regResult.details : regResult;
  const sessionKey = rr?.session_key || "test-key";

  await api.tools.get("genorch_session_start_work")!("", {
    project: "test-project",
    task: "hook tests",
  });

  const hookNames = ["subagent_spawned", "subagent_ended", "agent_end", "gateway_stop"];
  const hooks: Record<string, Function> = {};
  for (const name of hookNames) {
    const h = api.hooks.get(name);
    expect(h).toBeDefined();
    hooks[name] = h;
  }
  return { api, dd, hooks, sessionKey };
}

describe("PLUGIN-002g — Subagent & Cleanup Hooks", () => {
  describe("subagent_spawned", () => {
    it("should track subagent spawn for registered sessions", async () => {
      const { hooks, sessionKey } = await setupDefault();
      await hooks.subagent_spawned({ sessionKey, subagentKey: "sub-abc-123" });
      // Should not throw
    });

    it("should skip unregistered sessions", async () => {
      const dd = prepareTestDataDir();
      const api = createMockApi();
      await registerPlugin(dd, plugin, api);
      const hook = api.hooks.get("subagent_spawned")!;
      await hook({ sessionKey: "unregistered", subagentKey: "sub-xyz" });
      // Should not throw
    });
  });

  describe("subagent_ended", () => {
    it("should handle subagent end", async () => {
      const { hooks, sessionKey } = await setupDefault();
      await hooks.subagent_ended({ sessionKey, subagentKey: "sub-abc-123" });
      // Should not throw (depth becomes 0 or 0 clamped)
    });
  });

  describe("agent_end", () => {
    it("should handle agent_end without throwing", async () => {
      const { hooks, sessionKey } = await setupDefault();
      await hooks.agent_end({ sessionKey });
      // Agent end does cleanup — should not throw
    });
  });

  describe("gateway_stop", () => {
    it("should handle gateway_stop without throwing", async () => {
      const { hooks } = await setupDefault();
      await hooks.gateway_stop();
      // Gateway stop cleans up maintenance — should not throw
    });
  });
});
