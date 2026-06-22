/**
 * PLUGIN-001a — Registration & Session Lifecycle Tests
 *
 * Tests: genorch_session_register, genorch_session_unregister,
 * genorch_session_start_work, genorch_session_clear_work,
 * genorch_project_leave, genorch_project_join,
 * genorch_session_list
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
describe("PLUGIN-001a — Registration & Session Lifecycle", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
  });
  // ── genorch_session_register ─────────────────────────────────
  describe("genorch_session_register", () => {
    it("should register the session with a generated key", async () => {
      const exec = api.tools.get("genorch_session_register")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("message", "registered");
      // First call should be newly registered
    });
    it("should be idempotent on second call", async () => {
      const exec = api.tools.get("genorch_session_register")!;
      const r1 = await unwrap(exec("", {}));
      const r2 = await unwrap(exec("", {}));
      expect(r1).toHaveProperty("ok", true);
      // Second call returns string "already registered"
      expect(typeof r2 === "string" || r2.ok === true).toBe(true);
      // Should not throw
    });
    it("should return a session_key in the result", async () => {
      const exec = api.tools.get("genorch_session_register")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("session_key");
      expect(typeof result.session_key).toBe("string");
      expect(result.session_key.length).toBeGreaterThan(0);
    });
  });
  // ── genorch_session_start_work ──────────────────────────────
  describe("genorch_session_start_work", () => {
    it("should fail if session is not registered", async () => {
      const exec = api.tools.get("genorch_session_start_work")!;
      const result = await unwrap(
        exec("", { project: "test-project", task: "test" }),
      );
      // Should return error about not being registered
      expect(result).not.toHaveProperty("ok", true);
    });
    it("should set project context after registration", async () => {
      api.tools.get("genorch_session_register")!("", {});
      const exec = api.tools.get("genorch_session_start_work")!;
      const result = await unwrap(
        exec("", { project: "test-project", task: "testing" }),
      );
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("project", "test-project");
      expect(result).toHaveProperty("task", "testing");
    });
    it("should reject binding to a second project", async () => {
      api.tools.get("genorch_session_register")!("", {});
      api.tools.get("genorch_session_start_work")!("", {
        project: "test-project",
        task: "first task",
      });
      const exec = api.tools.get("genorch_session_start_work")!;
      const result = await unwrap(
        exec("", { project: "free-project", task: "second task" }),
      );
      expect(result).toHaveProperty("ok", false);
      expect(result).toHaveProperty("error");
      expect(result.error).toContain("Binding violation");
    });
    it("should accept same-project re-context", async () => {
      api.tools.get("genorch_session_register")!("", {});
      api.tools.get("genorch_session_start_work")!("", {
        project: "test-project",
        task: "first",
      });
      const exec = api.tools.get("genorch_session_start_work")!;
      const result = await unwrap(
        exec("", { project: "test-project", task: "second" }),
      );
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("task", "second");
    });
  });
  // ── genorch_session_clear_work ────────────────────────────
  describe("genorch_session_clear_work", () => {
    it("should fail if task completion not logged", async () => {
      api.tools.get("genorch_session_register")!("", {});
      api.tools.get("genorch_session_start_work")!("", {
        project: "test-project",
        task: "test",
      });
      const exec = api.tools.get("genorch_session_clear_work")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("ok", false);
      expect(result).toHaveProperty("error");
      expect(result.error).toContain("not logged");
    });
    it("should succeed after logging task completion", async () => {
      api.tools.get("genorch_session_register")!("", {});
      api.tools.get("genorch_session_start_work")!("", {
        project: "test-project",
        task: "test",
      });
      // Log session completion
      api.tools.get("genorch_session_log")!("", {
        project: "test-project",
        task: "test",
        model: "gpt-4",
        agent: "Amy",
        status: "complete",
      });
      const exec = api.tools.get("genorch_session_clear_work")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("previous_project", "test-project");
    });
  });
  // ── genorch_session_unregister ───────────────────────────────
  describe("genorch_session_unregister", () => {
    it("should unregister a registered session", async () => {
      api.tools.get("genorch_session_register")!("", {});
      const exec = api.tools.get("genorch_session_unregister")!;
      const result = await unwrap(exec("", {}));
      // unregister returns string "unregistered" or {ok} with message
      const ok = typeof result === "string" || result.ok === true;
      expect(ok).toBe(true);
    });
  });
  // ── genorch_project_leave ──────────────────────────
  describe("genorch_project_leave", () => {
    it("should fail if no binding exists", async () => {
      api.tools.get("genorch_session_register")!("", {});
      const exec = api.tools.get("genorch_project_leave")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("ok", false);
    });
    it("should fail if task completion not logged", async () => {
      api.tools.get("genorch_session_register")!("", {});
      api.tools.get("genorch_session_start_work")!("", {
        project: "test-project",
        task: "test",
      });
      const exec = api.tools.get("genorch_project_leave")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("ok", false);
      expect(result.error).toContain("not logged");
    });
    it("should release binding after logging completion", async () => {
      api.tools.get("genorch_session_register")!("", {});
      api.tools.get("genorch_session_start_work")!("", {
        project: "test-project",
        task: "release test",
      });
      api.tools.get("genorch_session_log")!("", {
        project: "test-project",
        task: "release test",
        model: "gpt-4",
        agent: "Amy",
        status: "complete",
      });
      const exec = api.tools.get("genorch_project_leave")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("released_project", "test-project");
    });
  });
  // ── genorch_session_list ──────────────────
  describe("genorch_session_list", () => {
    it("should list registered sessions", async () => {
      api.tools.get("genorch_session_register")!("", {});
      const exec = api.tools.get("genorch_session_list")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("registered_sessions");
      expect(Array.isArray(result.registered_sessions)).toBe(true);
      expect(result.count).toBeGreaterThanOrEqual(1);
    });
    it("should show context for sessions that have it", async () => {
      api.tools.get("genorch_session_register")!("", {});
      api.tools.get("genorch_session_start_work")!("", {
        project: "test-project",
        task: "context test",
      });
      const exec = api.tools.get("genorch_session_list")!;
      const result = await unwrap(exec("", {}));
      const withCtx = result.registered_sessions.find(
        (s: any) => s.has_context,
      );
      expect(withCtx).toBeDefined();
      expect(withCtx.project).toBe("test-project");
    });
  });
  // ── genorch_project_join ─────────────────────────────
  describe("genorch_project_join", () => {
    it("should register and set context in one step", async () => {
      // Create project dir in data
      const fs = require("node:fs");
      const path = require("node:path");
      fs.mkdirSync(path.join(dd, "projects", "test-project"), { recursive: true });
      const exec = api.tools.get("genorch_project_join")!;
      const result = await unwrap(
        exec("", { project: "test-project", task: "joining test" }),
      );
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("registered", true);
      expect(result).toHaveProperty("joined_project", "test-project");
    });
  });
});
