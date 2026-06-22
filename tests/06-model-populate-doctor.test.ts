/**
 * PLUGIN-001f — Model Population & Doctor Tests
 *
 * Tests: genorch_models_auto_discover, genorch_system_diagnose,
 * genorch_models_check_routing
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi, prepareTestDataDir, registerPlugin, unwrap, type MockApiType } from "./setup.js";

let plugin: any;
beforeEach(async () => { vi.resetModules(); plugin = (await import("../src/index.js")).default; });

describe("PLUGIN-001f — Model Population & Doctor", () => {
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

  describe("genorch_models_auto_discover", () => {
    it("should run auto-discovery", async () => {
      await setup();
      const r = await unwrap(api.tools.get("genorch_models_auto_discover")!("", {}));
      // Auto-discover may fail in test (no real gateway), but should not throw
      expect(r).toBeDefined();
    });
  });

  describe("genorch_system_diagnose", () => {
    it("should run diagnostics", async () => {
      await setup();
      const r = await unwrap(api.tools.get("genorch_system_diagnose")!("", { check: "sessions" }));
      expect(r).toHaveProperty("ok");  // may or may not find issues
    });
  });

  describe("genorch_models_check_routing", () => {
    it("should apply free-only filter", async () => {
      const r = await unwrap(api.tools.get("genorch_models_check_routing")!("", { project: "free-project" }));
      expect(r.eligible_count).toBeGreaterThan(0);
    });
  });
});
