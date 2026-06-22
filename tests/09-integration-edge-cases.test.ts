/**
 * PLUGIN-001i — Integration & Edge Cases Tests
 *
 * Full lifecycle, error handling, safeguards
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi, prepareTestDataDir, registerPlugin, unwrap, type MockApiType } from "./setup.js";

let plugin: any;
beforeEach(async () => { vi.resetModules(); plugin = (await import("../src/index.js")).default; });

describe("PLUGIN-001i — Integration & Edge Cases", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
  });

  async function setup() {
    const mod = await import("../src/index.js");
    mod.__setTestSessionKey("test-key");
    await unwrap(api.tools.get("genorch_session_register")!("", {}));
    await unwrap(api.tools.get("genorch_session_start_work")!("", { project: "test-project", task: "test" }));
  }

  describe("Error handling", () => {
    it("should return error for unregistered calls", async () => {
      const r = await unwrap(api.tools.get("genorch_session_start_work")!("", { project: "test-project", task: "x" }));
      expect(r).not.toHaveProperty("ok", true);
    });

    it("should handle non-existent project gracefully", async () => {
      await setup();
      const r = await unwrap(api.tools.get("genorch_session_start_work")!("", { project: "nonexistent", task: "x" }));
      expect(r).toHaveProperty("ok", false);
    });

    it("should handle empty config gracefully", async () => {
      const r = await unwrap(api.tools.get("genorch_config_show_routing")!("", {}));
      expect(r).toHaveProperty("free_only_mode");
    });
  });

  describe("Full lifecycle", () => {
    it("should complete register -> work -> log -> clear", async () => {
      await setup();
      await unwrap(api.tools.get("genorch_session_log")!("", { project: "test-project", task: "test", model: "gpt-4", agent: "Amy", status: "done" }));
      const r = await unwrap(api.tools.get("genorch_session_clear_work")!("", {}));
      expect(r).toHaveProperty("ok", true);
    });

    it("should persist session data across tool calls", async () => {
      await setup();
      // Session list should show registration
      const list = await unwrap(api.tools.get("genorch_session_list")!("", {}));
      expect(list.registered_sessions.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Session validation", () => {
    it("should validate session entries", async () => {
      await setup();
      const r = await unwrap(api.tools.get("genorch_system_diagnose")!("", { check: "sessions" }));
      expect(r).toHaveProperty("ok", true);
    });
  });
});
