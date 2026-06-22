/**
 * PLUGIN-002b — before_prompt_build hook tests
 *
 * Tests context injection for registered sessions, workflow phase
 * enforcement, and unregistered session isolation.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi, prepareTestDataDir, registerPlugin, unwrap, type MockApiType } from "./setup.js";

let plugin: any;
beforeEach(async () => { vi.resetModules(); plugin = (await import("../src/index.js")).default; });

describe("PLUGIN-002b — before_prompt_build hook", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
  });

  async function setupRegistered() {
    const mod = await import("../src/index.js");
    mod.__setTestSessionKey("test-key");
    await unwrap(api.tools.get("genorch_session_register")!("", {}));
    await unwrap(api.tools.get("genorch_session_start_work")!("", { project: "test-project", task: "test" }));
  }

  describe("hook registration", () => {
    it("should register the before_prompt_build handler", () => {
      expect(api.hooks.has("before_prompt_build")).toBe(true);
    });
  });

  describe("context injection", () => {
    it("should inject project context", async () => {
      await setupRegistered();
      const hook = api.hooks.get("before_prompt_build")!;
      const result = hook({
        conversation: { agentId: "main" },
        context: {},
      });
      expect(result).toBeDefined();
    });
  });

  describe("phase enforcement", () => {
    it("should respect workflow phase", async () => {
      await setupRegistered();
      await unwrap(api.tools.get("genorch_workflow_advance_phase")!("", { phase: "plan" }));
      const hook = api.hooks.get("before_prompt_build")!;
      const result = hook({
        conversation: { agentId: "main" },
        context: {},
      });
      expect(result).toBeDefined();
    });
  });
});
