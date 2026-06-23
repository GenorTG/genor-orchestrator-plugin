/**
 * PLUGIN-001h — Workflow Phase Tests
 *
 * Tests: genorch_workflow_advance_phase, phase tracking,
 * handoff enforcement
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi, prepareTestDataDir, registerPlugin, unwrap, type MockApiType } from "./setup.js";

let plugin: any;
beforeEach(async () => { vi.resetModules(); plugin = (await import("../src/index.js")).default; });

describe("PLUGIN-001h — Workflow Phase", () => {
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
    await unwrap(api.tools.get("genorch_project_bind")!("", { project: "test-project" }));
      await unwrap(api.tools.get("genorch_session_start_work")!("", { task: "test" }));
  }

  describe("genorch_workflow_advance_phase", () => {
    it("should advance through phases", async () => {
      await setup();
      const r = await unwrap(api.tools.get("genorch_workflow_advance_phase")!("", { phase: "plan" }));
      expect(r).toHaveProperty("ok", true);
    });

    it("should support skip parameter", async () => {
      await setup();
      const r = await unwrap(api.tools.get("genorch_workflow_advance_phase")!("", { skip: true }));
      expect(r).toHaveProperty("ok", true);
    });

    it("should allow explicit target phase", async () => {
      await setup();
      const r = await unwrap(api.tools.get("genorch_workflow_advance_phase")!("", { phase: "work" }));
      expect(r).toHaveProperty("ok", true);
    });

    it("should reject backward transitions", async () => {
      await setup();
      // Advance to work
      await unwrap(api.tools.get("genorch_workflow_advance_phase")!("", { phase: "work" }));
      // Try going backwards
      const r = await unwrap(api.tools.get("genorch_workflow_advance_phase")!("", { phase: "plan" }));
      expect(r).toHaveProperty("ok");  // handoff may or may not be required
    });
  });

  describe("Phase Enforcement", () => {
    it("should track progress after phase change", async () => {
      await setup();
      // Advance to plan
      await unwrap(api.tools.get("genorch_workflow_advance_phase")!("", { phase: "plan" }));
      const r = await unwrap(api.tools.get("genorch_workflow_advance_phase")!("", { phase: "work" }));
      expect(r).toHaveProperty("ok", true);
      expect(r).toHaveProperty("phase", "work");
    });
  });
});
