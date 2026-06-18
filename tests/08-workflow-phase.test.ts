/**
 * PLUGIN-001h — Workflow Phase Tests
 *
 * Tests: orchestrator_advance_phase, WorkflowTracker class,
 * phase gating, QA integration, handoff enforcement
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

describe("PLUGIN-001h — Workflow Phase", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
    api.tools.get("orchestrator_register")!("", {});
    api.tools.get("orchestrator_set_context")!("", {
      project: "test-project",
      task: "workflow testing",
    });
  });

  // ── WorkflowTracker class (internal) ─────────────────────
  describe("WorkflowTracker (internal)", () => {
    it("should start in analyze phase when enabled", async () => {
      const exec = api.tools.get("orchestrator_get_status")!;
      await unwrap(exec("", {}));
    });
    it("should advance through phases in order", async () => {
      const exec = api.tools.get("orchestrator_advance_phase")!;
      let r = await unwrap(exec("", {}));
      expect(r).toHaveProperty("ok", true);
      expect(r.phase).toBe("plan");
      expect(r.progress).toBe("1/6");
      r = await unwrap(exec("", {}));
      expect(r.phase).toBe("document");
      r = await unwrap(exec("", {}));
      expect(r.phase).toBe("work");
      r = await unwrap(exec("", {}));
      expect(r.phase).toBe("log");

      // Handoff + log required before finish
      await unwrap(api.tools.get("orchestrator_generate_handoff")!("", {}));
      await unwrap(api.tools.get("orchestrator_log_session")!("", {
        project: "test-project", task: "workflow testing",
        model: "test-model", agent: "Amy", status: "complete",
      }));

      r = await unwrap(exec("", {}));
      expect(r.phase).toBe("finish");
      r = await unwrap(exec("", {}));
      expect(r).toHaveProperty("warning");
      expect(r.warning).toContain("Already at last phase");
    });
    it("should support skip parameter on advance", async () => {
      const exec = api.tools.get("orchestrator_advance_phase")!;
      let r = await unwrap(exec("", { phase: "plan", skip: true }));
      expect(r).toHaveProperty("ok", true);
      expect(r.phase).toBe("plan");
      expect(r.phase_history.length).toBeGreaterThanOrEqual(2);
      expect(r.phase_history[0]).toHaveProperty("skipped", true);
    });
    it("should allow explicit target phase", async () => {
      const exec = api.tools.get("orchestrator_advance_phase")!;
      const r = await unwrap(exec("", { phase: "work" }));
      expect(r).toHaveProperty("ok", true);
      expect(r.phase).toBe("work");
    });
    it("should reject backward transitions", async () => {
      const exec = api.tools.get("orchestrator_advance_phase")!;
      await unwrap(exec("", {}));
      await unwrap(exec("", {}));
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
      expect(r.phase_history).toHaveLength(2);
    });
  });

  // ── QA Gate Enforcement ──────────────────────────────────
  describe("QA Gate Enforcement", () => {
    let dd2: string;
    let api2: MockApiType;
    beforeEach(async () => {
      vi.resetModules();
      plugin = (await import("../src/index.js")).default;
      dd2 = prepareTestDataDir(true, {
        free_only_mode: false,
        disabled_models: [],
        projects: {
          "qa-project": {
            location: "/tmp/qa-project-loc",
            workflow: { enabled: true, include_qa: true, auto_commit: false, qa_retries: 3, skip_phases: [] },
            model_routing: { coding: ["test-model"] },
          },
        },
      });
      process.env.ORCHESTRATOR_DATA_DIR = dd2;
      api2 = createMockApi();
      await registerPlugin(dd2, plugin, api2);
      api2.tools.get("orchestrator_register")!("", {});
      api2.tools.get("orchestrator_set_context")!("", { project: "qa-project", task: "qa test" });
    });

    it("should block work→log without QA approval", async () => {
      const adv = api2.tools.get("orchestrator_advance_phase")!;
      await unwrap(adv("", {}));
      await unwrap(adv("", {}));
      await unwrap(adv("", {}));
      const r = await unwrap(adv("", {}));
      expect(r).toHaveProperty("ok", false);
      expect(r).toHaveProperty("qa_required", true);
    });

    it("should allow advance after QA submit + approve", async () => {
      const adv = api2.tools.get("orchestrator_advance_phase")!;
      await unwrap(adv("", {}));
      await unwrap(adv("", {}));
      await unwrap(adv("", {}));

      const qaSubmit = api2.tools.get("orchestrator_qa_submit")!;
      await unwrap(qaSubmit("", { finding: "Needs tests" }));
      const qaApprove = api2.tools.get("orchestrator_qa_approve")!;
      await unwrap(qaApprove("", {}));

      const r = await unwrap(adv("", {}));
      expect(r).toHaveProperty("ok", true);
      expect(r.phase).toBe("log");
    });

    it("should reject and block until resubmitted", async () => {
      const adv = api2.tools.get("orchestrator_advance_phase")!;
      await unwrap(adv("", {}));
      await unwrap(adv("", {}));
      await unwrap(adv("", {}));

      const qaSubmit = api2.tools.get("orchestrator_qa_submit")!;
      await unwrap(qaSubmit("", { finding: "Bugs found" }));
      const qaReject = api2.tools.get("orchestrator_qa_reject")!;
      await unwrap(qaReject("", { reason: "Critical bugs" }));

      const r = await unwrap(adv("", {}));
      expect(r).toHaveProperty("ok", false);
      expect(r).toHaveProperty("qa_required", true);
    });

    it("qa_approve should fail without pending review", async () => {
      const qaApprove = api2.tools.get("orchestrator_qa_approve")!;
      const r = await unwrap(qaApprove("", {}));
      expect(r).toHaveProperty("ok", false);
    });
  });

  // ── Handoff Gate Enforcement ─────────────────────────────
  describe("Handoff Gate Enforcement", () => {
    let dd3: string;
    let api3: MockApiType;
    beforeEach(async () => {
      vi.resetModules();
      plugin = (await import("../src/index.js")).default;
      dd3 = prepareTestDataDir(true, {
        free_only_mode: false,
        disabled_models: [],
        projects: {
          "handoff-project": {
            location: "/tmp/handoff-project-loc",
            workflow: { enabled: true, include_qa: false, auto_commit: false, qa_retries: 3, skip_phases: [] },
            model_routing: { coding: ["test-model"] },
          },
        },
      });
      process.env.ORCHESTRATOR_DATA_DIR = dd3;
      api3 = createMockApi();
      await registerPlugin(dd3, plugin, api3);
      api3.tools.get("orchestrator_register")!("", {});
      api3.tools.get("orchestrator_set_context")!("", { project: "handoff-project", task: "handoff test" });
    });

    it("should block log→finish without handoff", async () => {
      const adv = api3.tools.get("orchestrator_advance_phase")!;
      await unwrap(adv("", {}));
      await unwrap(adv("", {}));
      await unwrap(adv("", {}));
      await unwrap(adv("", {}));
      // First log the session (required before handoff gate)
      await unwrap(api3.tools.get("orchestrator_log_session")!("", {
        project: "handoff-project", task: "handoff test",
        model: "test-model", agent: "Amy", status: "complete",
      }));
      // Now handoff gate should block
      const r = await unwrap(adv("", {}));
      expect(r).toHaveProperty("handoff_required", true);
    });

    it("should allow finish after handoff + log", async () => {
      const adv = api3.tools.get("orchestrator_advance_phase")!;
      await unwrap(adv("", {}));
      await unwrap(adv("", {}));
      await unwrap(adv("", {}));
      await unwrap(adv("", {}));

      await unwrap(api3.tools.get("orchestrator_log_session")!("", {
        project: "handoff-project", task: "handoff test",
        model: "test-model", agent: "Amy", status: "complete",
      }));
      const hr = await unwrap(api3.tools.get("orchestrator_generate_handoff")!("", {}));
      expect(hr).toHaveProperty("ok", true);
      expect(hr).toHaveProperty("handoff_generated", true);

      const r = await unwrap(adv("", {}));
      expect(r).toHaveProperty("ok", true);
      expect(r.phase).toBe("finish");
    });
  });

  // ── Workflow edge cases ──────────────────────────────────
  describe("Workflow edge cases", () => {
    it("should fail if workflow is not enabled", async () => {
      api.tools.get("orchestrator_log_session")!("", {
        project: "test-project", task: "cleanup",
        model: "gpt-4", agent: "Amy", status: "complete",
      });
      api.tools.get("orchestrator_clear_context")!("", {});
      api.tools.get("orchestrator_set_context")!("", {
        project: "free-project", task: "no-workflow",
      });
      const exec = api.tools.get("orchestrator_advance_phase")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("ok", false);
      expect(result.error).toContain("not enabled");
    });
    it("should return phase_history on advance", async () => {
      const exec = api.tools.get("orchestrator_advance_phase")!;
      const r1 = await unwrap(exec("", {}));
      expect(r1).toHaveProperty("phase_history");
      expect(Array.isArray(r1.phase_history)).toBe(true);
      const r2 = await unwrap(exec("", {}));
      expect(r2.phase_history.length).toBeGreaterThanOrEqual(r1.phase_history.length);
    });
  });
});
