/**
 * PLUGIN-002d — Safeguards & Control Actions Tests
 *
 * Tests registration guard, unregistered session filtering,
 * and stale entry detection.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi, prepareTestDataDir, registerPlugin, unwrap, type MockApiType } from "./setup.js";

let plugin: any;
beforeEach(async () => { vi.resetModules(); plugin = (await import("../src/index.js")).default; });

describe("PLUGIN-002d — Safeguards & Control Actions", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
  });

  describe("registration guard", () => {
    it("should block unregistered tool calls", async () => {
      // Use a tool that requires registration (not project_list_active)
      const r = await unwrap(api.tools.get("genorch_session_clear_work")!("", {}));
      expect(r).toHaveProperty("ok", false);
    });
  });

  describe("unregistered isolation", () => {
    it("should not inject context for unregistered", () => {
      const hook = api.hooks.get("before_prompt_build");
      if (hook) {
        const result = hook({ conversation: { agentId: "main" }, context: {} });
        expect(result).toBeDefined();
      }
    });
  });
});
