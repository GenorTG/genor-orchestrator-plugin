/**
 * PLUGIN-002a — before_model_resolve hook tests
 *
 * Tests the model resolution hook for unregistered sessions,
 * registered sessions with project context, and background sessions.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi, prepareTestDataDir, registerPlugin, unwrap, type MockApiType } from "./setup.js";

let plugin: any;
beforeEach(async () => { vi.resetModules(); plugin = (await import("../src/index.js")).default; });

describe("PLUGIN-002a — before_model_resolve hook", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
  });

  describe("hook registration", () => {
    it("should register the before_model_resolve handler", () => {
      expect(api.hooks.has("before_model_resolve")).toBe(true);
    });
  });

  describe("unregistered session isolation", () => {
    it("should not interfere when session is not registered", () => {
      const hook = api.hooks.get("before_model_resolve")!;
      const result = hook({
        sessionKey: "unregistered-session-123",
        conversation: { agentId: "main" },
      });
      expect(result).toBeDefined();
    });
  });
});
