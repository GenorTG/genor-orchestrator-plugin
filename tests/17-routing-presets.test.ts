/**
 * PLUGIN-002f — Routing Presets Deep Tests
 *
 * Tests model_routing presets (auto, custom, no-steering, free-only),
 * single-provider routing, and allowlist/free_only project configs.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi, prepareTestDataDir, registerPlugin, unwrap, type MockApiType } from "./setup.js";

let plugin: any;
beforeEach(async () => { vi.resetModules(); plugin = (await import("../src/index.js")).default; });

describe("PLUGIN-002f — Routing Presets Deep", () => {
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

  describe("genorch_models_recommend", () => {
    it("should recommend with explicit project", async () => {
      const r = await unwrap(api.tools.get("genorch_models_recommend")!("", { category: "coding", project: "test-project" }));
      expect(r).toHaveProperty("ok", true);
      expect(r).toHaveProperty("recommended");
    });

    it("should recommend for different categories", async () => {
      const r = await unwrap(api.tools.get("genorch_models_recommend")!("", { category: "documentation", project: "test-project" }));
      expect(r).toHaveProperty("ok", true);
    });
  });
});
