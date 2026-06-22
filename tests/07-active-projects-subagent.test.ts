/**
 * PLUGIN-001g — Active Projects & Subagent Tests
 *
 * Tests: genorch_project_list_active,
 * genorch_task_delegate
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
  // ── genorch_project_list_active ────────────────────
  describe("genorch_project_list_active", () => {
    it("should return all projects with session counts", async () => {
      // Register + set context to create project binding
      api.tools.get("genorch_session_register")!("", {});
      api.tools.get("genorch_session_start_work")!("", {
        project: "test-project",
        task: "test",
      });
      const exec = api.tools.get("genorch_project_list_active")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("all_projects");
      expect(Array.isArray(result.all_projects)).toBe(true);
    });
    it("should include session_logged counts for each project", async () => {
      // Log some sessions
      api.tools.get("genorch_session_register")!("", {});
      api.tools.get("genorch_session_start_work")!("", {
        project: "test-project",
        task: "session counting",
      });
      api.tools.get("genorch_session_log")!("", {
        project: "test-project",
        task: "session 1",
        model: "gpt-4",
        agent: "Amy",
        status: "complete",
      });
      const exec = api.tools.get("genorch_project_list_active")!;
      const result = await unwrap(exec("", {}));
      // Find test-project in the list
      const tp = result.all_projects.find(
        (p: any) => p.project === "test-project",
      );
      expect(tp).toBeDefined();
      expect(tp.sessions_logged).toBeGreaterThanOrEqual(1);
    });
    it("should report active sessions for bound projects", async () => {
      api.tools.get("genorch_session_register")!("", {});
      api.tools.get("genorch_session_start_work")!("", {
        project: "test-project",
        task: "active check",
      });
      const exec = api.tools.get("genorch_project_list_active")!;
      const result = await unwrap(exec("", {}));
      expect(result.active_project_count).toBeGreaterThanOrEqual(1);
      const active = result.active_projects.find(
        (p: any) => p.project === "test-project",
      );
      expect(active).toBeDefined();
      expect(active.active_sessions).toBeGreaterThanOrEqual(1);
    });
  });
  // ── genorch_task_delegate ──────────────────────────
  describe("genorch_task_delegate", () => {
    it("should fail if session is not registered", async () => {
      const exec = api.tools.get("genorch_task_delegate")!;
      const result = await unwrap(
        exec("", { task: "do something" }),
      );
      expect(result).toHaveProperty("ok", false);
      expect(result).toHaveProperty("error");
    });
    it("should fail if no active project", async () => {
      api.tools.get("genorch_session_register")!("", {});
      const exec = api.tools.get("genorch_task_delegate")!;
      const result = await unwrap(
        exec("", { task: "do something" }),
      );
      expect(result).toHaveProperty("ok", false);
      expect(result.error).toContain("No active project");
    });
    it("should spawn a subagent via runtime API", async () => {
      api.tools.get("genorch_session_register")!("", {});
      api.tools.get("genorch_session_start_work")!("", {
        project: "test-project",
        task: "spawn test",
      });
      const exec = api.tools.get("genorch_task_delegate")!;
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
      expect(result).toHaveProperty("run_id", "mock-run-123");
      expect(result).toHaveProperty("message");
      expect(result.message).toContain("mock-run-123");
      // Verify the runtime subagent.run was called
      expect(api.runtime.subagent.run).toHaveBeenCalledOnce();
    });
    it("should pass model override to subagent.run", async () => {
      api.tools.get("genorch_session_register")!("", {});
      api.tools.get("genorch_session_start_work")!("", {
        project: "test-project",
        task: "model test",
      });
      const exec = api.tools.get("genorch_task_delegate")!;
      const result = await unwrap(
        exec("", { task: "do work", model: "gpt-4" }),
      );
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("model", "gpt-4");
      // Verify the call had the right params
      const callArgs = api.runtime.subagent.run.mock.calls[0][0];
      expect(callArgs).toHaveProperty("model", "gpt-4");
      expect(callArgs).toHaveProperty("sessionKey");
      expect(callArgs).toHaveProperty("message");
    });
    it("should respect timeoutSeconds upper bound", async () => {
      api.tools.get("genorch_session_register")!("", {});
      api.tools.get("genorch_session_start_work")!("", {
        project: "test-project",
        task: "timeout test",
      });
      const exec = api.tools.get("genorch_task_delegate")!;
      const result = await unwrap(
        exec("", {
          task: "long task",
          timeoutSeconds: 9999,
        }),
      );
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("run_id", "mock-run-123");
    });
  });
});
