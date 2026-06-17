/**
 * PLUGIN-001g — Active Projects & Subagent Tests
 *
 * Tests: orchestrator_list_active_projects,
 * orchestrator_spawn_subagent
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
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
describe("PLUGIN-001g — Active Projects & Subagent", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
  });
  // ── orchestrator_list_active_projects ────────────────────
  describe("orchestrator_list_active_projects", () => {
    it("should return all projects with session counts", async () => {
      // Register + set context to create project binding
      api.tools.get("orchestrator_register")!("", {});
      api.tools.get("orchestrator_set_context")!("", {
        project: "test-project",
        task: "test",
      });
      const exec = api.tools.get("orchestrator_list_active_projects")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("all_projects");
      expect(Array.isArray(result.all_projects)).toBe(true);
    });
    it("should include session_logged counts for each project", async () => {
      // Log some sessions
      api.tools.get("orchestrator_register")!("", {});
      api.tools.get("orchestrator_set_context")!("", {
        project: "test-project",
        task: "session counting",
      });
      api.tools.get("orchestrator_log_session")!("", {
        project: "test-project",
        task: "session 1",
        model: "gpt-4",
        agent: "Amy",
        status: "complete",
      });
      const exec = api.tools.get("orchestrator_list_active_projects")!;
      const result = await unwrap(exec("", {}));
      // Find test-project in the list
      const tp = result.all_projects.find(
        (p: any) => p.project === "test-project",
      );
      expect(tp).toBeDefined();
      expect(tp.sessions_logged).toBeGreaterThanOrEqual(1);
    });
    it("should report active sessions for bound projects", async () => {
      api.tools.get("orchestrator_register")!("", {});
      api.tools.get("orchestrator_set_context")!("", {
        project: "test-project",
        task: "active check",
      });
      const exec = api.tools.get("orchestrator_list_active_projects")!;
      const result = await unwrap(exec("", {}));
      expect(result.active_project_count).toBeGreaterThanOrEqual(1);
      const active = result.active_projects.find(
        (p: any) => p.project === "test-project",
      );
      expect(active).toBeDefined();
      expect(active.active_sessions).toBeGreaterThanOrEqual(1);
    });
  });
  // ── orchestrator_spawn_subagent ──────────────────────────
  describe("orchestrator_spawn_subagent", () => {
    it("should fail if session is not registered", async () => {
      const exec = api.tools.get("orchestrator_spawn_subagent")!;
      const result = await unwrap(
        exec("", { task: "do something" }),
      );
      expect(result).toHaveProperty("ok", false);
      expect(result).toHaveProperty("error");
    });
    it("should fail if no active project", async () => {
      api.tools.get("orchestrator_register")!("", {});
      const exec = api.tools.get("orchestrator_spawn_subagent")!;
      const result = await unwrap(
        exec("", { task: "do something" }),
      );
      expect(result).toHaveProperty("ok", false);
      expect(result.error).toContain("No active project");
    });
    it("should return spawn instructions when properly configured", async () => {
      api.tools.get("orchestrator_register")!("", {});
      api.tools.get("orchestrator_set_context")!("", {
        project: "test-project",
        task: "spawn test",
      });
      const exec = api.tools.get("orchestrator_spawn_subagent")!;
      const result = await unwrap(
        exec("", {
          task: "Implement login feature",
          taskName: "login-feature",
          timeoutSeconds: 600,
        }),
      );
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("project", "test-project");
      expect(result).toHaveProperty("task", "Implement login feature");
      expect(result).toHaveProperty("task_name", "login-feature");
      expect(result).toHaveProperty("spawn_instructions");
    });
    it("should include recommended model from session tracker", async () => {
      api.tools.get("orchestrator_register")!("", {});
      api.tools.get("orchestrator_set_context")!("", {
        project: "test-project",
        task: "model test",
      });
      const exec = api.tools.get("orchestrator_spawn_subagent")!;
      const result = await unwrap(
        exec("", { task: "do work" }),
      );
      // No model is set in the session tracker, so recommended_model should
      // be "auto-routed"
      expect(result).toHaveProperty("recommended_model", "auto-routed");
    });
    it("should respect timeoutSeconds upper bound", async () => {
      api.tools.get("orchestrator_register")!("", {});
      api.tools.get("orchestrator_set_context")!("", {
        project: "test-project",
        task: "timeout test",
      });
      const exec = api.tools.get("orchestrator_spawn_subagent")!;
      const result = await unwrap(
        exec("", {
          task: "long task",
          timeoutSeconds: 9999,
        }),
      );
      // Should be capped at 1800
      expect(result).toHaveProperty("timeout_seconds", 1800);
    });
  });
});
