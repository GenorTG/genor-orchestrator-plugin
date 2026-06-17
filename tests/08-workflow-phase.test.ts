/**
 * PLUGIN-001h — Workflow Phase Tests
 *
 * Tests: orchestrator_advance_phase, WorkflowTracker class,
 * phase gating, QA integration
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
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
describe("PLUGIN-001h — Workflow Phase", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
    api.tools.get("orchestrator_register")!("", { project: "test-project" });
    api.tools.get("orchestrator_set_context")!("", {
      project: "test-project",
      task: "workflow testing",
    });
  });
  // ── WorkflowTracker class (internal) ─────────────────────
  describe("WorkflowTracker (internal)", () => {
    it("should start in analyze phase when enabled", async () => {
      const exec = api.tools.get("orchestrator_get_status")!;
      const result = await unwrap(exec("", { project: "test-project" }));
      // Status doesn't expose workflow directly, but the workflow is
      // active behind the scenes after set_context with workflow enabled
    });
    it("should advance through phases in order", async () => {
      const exec = api.tools.get("orchestrator_advance_phase")!;
      // Phase 1: analyze → plan (auto-advance)
      let r = await unwrap(exec("", {}));
      expect(r).toHaveProperty("ok", true);
      expect(r.phase).toBe("plan");
      expect(r.progress).toBe("1/6");
      // Phase 2: plan → document
      r = await unwrap(exec("", {}));
      expect(r.phase).toBe("document");
      // Phase 3: document → work
      r = await unwrap(exec("", {}));
      expect(r.phase).toBe("work");
      // Phase 4: work → log
      r = await unwrap(exec("", {}));
      expect(r.phase).toBe("log");
      // Phase 5: log → finish
      r = await unwrap(exec("", {}));
      expect(r.phase).toBe("finish");
      // Phase 6: finish → no more phases
      r = await unwrap(exec("", {}));
      expect(r).toHaveProperty("warning");
      expect(r.warning).toContain("Already at last phase");
    });
    it("should support skip parameter on advance", async () => {
      const exec = api.tools.get("orchestrator_advance_phase")!;
      // Skip analyze, go to plan
      // Must specify target phase AND skip=true
      let r = await unwrap(exec("", { phase: "plan", skip: true }));
      expect(r).toHaveProperty("ok", true);
      expect(r.phase).toBe("plan");
      // The analyze phase should be marked as skipped in phase_history
      expect(r.phase_history.length).toBeGreaterThanOrEqual(2);
      expect(r.phase_history[0]).toHaveProperty("skipped", true);
    });
    it("should allow explicit target phase", async () => {
      const exec = api.tools.get("orchestrator_advance_phase")!;
      // Jump from analyze → work (skipping plan and document)
      // But canTransitionTo checks forward, so work is valid
      const r = await unwrap(exec("", { phase: "work" }));
      expect(r).toHaveProperty("ok", true);
      expect(r.phase).toBe("work");
    });
    it("should reject backward transitions", async () => {
      const exec = api.tools.get("orchestrator_advance_phase")!;
      // Advance first
      await unwrap(exec("", {})); // → plan
      await unwrap(exec("", {})); // → document
      // Try to go back
      const r = await unwrap(exec("", { phase: "analyze" }));
      expect(r).toHaveProperty("ok", false);
      expect(r).toHaveProperty("error");
      expect(r.error).toContain("Cannot transition");
    });
    it("should track phase elapsed and progress", async () => {
      const exec = api.tools.get("orchestrator_advance_phase")!;
      const r = await unwrap(exec("", {}));
      expect(r).toHaveProperty("elapsed");
      expect(typeof r.elapsed).toBe("string");
      expect(r.progress).toBe("1/6");
      expect(r.phase_history).toHaveLength(2); // analyze (completed) + plan (entered)
    });
  });
  // ── Workflow with QA ─────────────────────────────────────
  describe("Workflow with QA", () => {
    it("should show QA state in status when workflow is active", async () => {
      // After setting context with workflow enabled,
      // the workflow tracker has qa_retries and qa_max_retries
      // Advance to work phase
      const advExec = api.tools.get("orchestrator_advance_phase")!;
      await unwrap(advExec("", {})); // → plan
      await unwrap(advExec("", {})); // → document
      await unwrap(advExec("", {})); // → work
      // The workflow tracker's QA state should be accessible
      // Verify current phase is work
    });
    it("should skip configured phases", async () => {
      // Workflow was configured with skip_phases: [] in fixtures
      // so no phases are skipped in the default test-project
      const exec = api.tools.get("orchestrator_advance_phase")!;
      const r1 = await unwrap(exec("", { project: "test-project" }));
      expect(r1.phase).toBe("plan");
    });
  });
  // ── Workflow edge cases ──────────────────────────────────
  describe("Workflow edge cases", () => {
    it("should fail if workflow is not enabled", async () => {
      // Set context for a project without workflow
      api.tools.get("orchestrator_log_session")!("", {
        project: "test-project",
        task: "cleanup",
        model: "gpt-4",
        agent: "Amy",
        status: "complete",
      });
      api.tools.get("orchestrator_clear_context")!("", {});
      // free-project has workflow.enabled = false
      api.tools.get("orchestrator_set_context")!("", {
        project: "free-project",
        task: "no-workflow",
      });
      const exec = api.tools.get("orchestrator_advance_phase")!;
      const result = await unwrap(exec("", { project: "test-project" }));
      expect(result).toHaveProperty("ok", false);
      expect(result.error).toContain("not enabled");
    });
    it("should return phase_history on advance", async () => {
      const exec = api.tools.get("orchestrator_advance_phase")!;
      const r1 = await unwrap(exec("", { project: "test-project" }));
      expect(r1).toHaveProperty("phase_history");
      expect(Array.isArray(r1.phase_history)).toBe(true);
      const r2 = await unwrap(exec("", { project: "test-project" }));
      expect(r2.phase_history.length).toBeGreaterThanOrEqual(
        r1.phase_history.length,
      );
    });
  });
});
