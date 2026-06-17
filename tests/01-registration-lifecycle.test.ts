/**
 * PLUGIN-001a — Registration & Session Lifecycle Tests
 *
 * Tests: orchestrator_register, orchestrator_unregister,
 * orchestrator_set_context, orchestrator_clear_context,
 * orchestrator_release_project, orchestrator_join_project,
 * orchestrator_get_registered_sessions
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
  // ── orchestrator_register ─────────────────────────────────
  describe("orchestrator_register", () => {
    it("should register the session with a generated key", async () => {
      const exec = api.tools.get("orchestrator_register")!;
      const result = await unwrap(exec("", { project: "test-project" }));
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("project", "test-project");
      expect(result).toHaveProperty("message");
      expect(result.message).toContain("registered and bound to");
      // First call should be newly registered
    });
    it("should reject registration without a project", async () => {
      const exec = api.tools.get("orchestrator_register")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("ok", false);
      expect(result).toHaveProperty("error");
      expect(result.error).toContain("Project name is required");
    });
    it("should reject registration with a non-existent project", async () => {
      const exec = api.tools.get("orchestrator_register")!;
      const result = await unwrap(exec("", { project: "no-such-project" }));
      expect(result).toHaveProperty("ok", false);
      expect(result).toHaveProperty("error");
      expect(result.error).toContain("not configured");
      expect(result).toHaveProperty("available_projects");
    });
    it("should be idempotent on second call", async () => {
      const exec = api.tools.get("orchestrator_register")!;
      const r1 = await unwrap(exec("", { project: "test-project" }));
      const r2 = await unwrap(exec("", { project: "test-project" }));
      expect(r1).toHaveProperty("ok", true);
      expect(r2).toHaveProperty("ok", true);
      expect(r2).toHaveProperty("message", "already registered");
      // Should not throw
    });
    it("should return a session_key in the result", async () => {
      const exec = api.tools.get("orchestrator_register")!;
      const result = await unwrap(exec("", { project: "test-project" }));
      expect(result).toHaveProperty("session_key");
      expect(typeof result.session_key).toBe("string");
      expect(result.session_key.length).toBeGreaterThan(0);
    });
  });
  // ── orchestrator_set_context ──────────────────────────────
  describe("orchestrator_set_context", () => {
    it("should fail if session is not registered", async () => {
      const exec = api.tools.get("orchestrator_set_context")!;
      const result = await unwrap(
        exec("", { project: "test-project", task: "test" }),
      );
      // Should return error about not being registered
      expect(result).not.toHaveProperty("ok", true);
    });
    it("should set project context after registration", async () => {
      api.tools.get("orchestrator_register")!("", { project: "test-project" });
      const exec = api.tools.get("orchestrator_set_context")!;
      const result = await unwrap(
        exec("", { project: "test-project", task: "testing" }),
      );
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("project", "test-project");
      expect(result).toHaveProperty("task", "testing");
    });
    it("should reject binding to a second project", async () => {
      api.tools.get("orchestrator_register")!("", { project: "test-project" });
      api.tools.get("orchestrator_set_context")!("", {
        project: "test-project",
        task: "first task",
      });
      const exec = api.tools.get("orchestrator_set_context")!;
      const result = await unwrap(
        exec("", { project: "free-project", task: "second task" }),
      );
      expect(result).toHaveProperty("ok", false);
      expect(result).toHaveProperty("error");
      expect(result.error).toContain("Binding violation");
    });
    it("should accept same-project re-context", async () => {
      api.tools.get("orchestrator_register")!("", { project: "test-project" });
      api.tools.get("orchestrator_set_context")!("", {
        project: "test-project",
        task: "first",
      });
      const exec = api.tools.get("orchestrator_set_context")!;
      const result = await unwrap(
        exec("", { project: "test-project", task: "second" }),
      );
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("task", "second");
    });
  });
  // ── orchestrator_clear_context ────────────────────────────
  describe("orchestrator_clear_context", () => {
    it("should fail if task completion not logged", async () => {
      api.tools.get("orchestrator_register")!("", { project: "test-project" });
      api.tools.get("orchestrator_set_context")!("", {
        project: "test-project",
        task: "test",
      });
      const exec = api.tools.get("orchestrator_clear_context")!;
      const result = await unwrap(exec("", { project: "test-project" }));
      expect(result).toHaveProperty("ok", false);
      expect(result).toHaveProperty("error");
      expect(result.error).toContain("not logged");
    });
    it("should succeed after logging task completion", async () => {
      api.tools.get("orchestrator_register")!("", { project: "test-project" });
      api.tools.get("orchestrator_set_context")!("", {
        project: "test-project",
        task: "test",
      });
      // Log session completion
      api.tools.get("orchestrator_log_session")!("", {
        project: "test-project",
        task: "test",
        model: "gpt-4",
        agent: "Amy",
        status: "complete",
      });
      const exec = api.tools.get("orchestrator_clear_context")!;
      const result = await unwrap(exec("", { project: "test-project" }));
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("previous_project", "test-project");
    });
  });
  // ── orchestrator_unregister ───────────────────────────────
  describe("orchestrator_unregister", () => {
    it("should unregister a registered session", async () => {
      api.tools.get("orchestrator_register")!("", { project: "test-project" });
      // Log task completion since registration auto-sets project context
      api.tools.get("orchestrator_log_session")!("", {
        project: "test-project",
        task: "Registered for project",
        model: "gpt-4",
        agent: "Amy",
        status: "complete",
      });
      const exec = api.tools.get("orchestrator_unregister")!;
      const result = await unwrap(exec("", {}));
      // unregister returns a string "unregistered" by default
      expect(typeof result === "string" || result.ok === true).toBe(true);
    });
  });
  // ── orchestrator_release_project ──────────────────────────
  describe("orchestrator_release_project", () => {
    it("should fail if no binding exists", async () => {
      api.tools.get("orchestrator_register")!("", { project: "test-project" });
      const exec = api.tools.get("orchestrator_release_project")!;
      const result = await unwrap(exec("", { project: "test-project" }));
      expect(result).toHaveProperty("ok", false);
    });
    it("should fail if task completion not logged", async () => {
      api.tools.get("orchestrator_register")!("", { project: "test-project" });
      api.tools.get("orchestrator_set_context")!("", {
        project: "test-project",
        task: "test",
      });
      const exec = api.tools.get("orchestrator_release_project")!;
      const result = await unwrap(exec("", { project: "test-project" }));
      expect(result).toHaveProperty("ok", false);
      expect(result.error).toContain("not logged");
    });
    it("should release binding after logging completion", async () => {
      api.tools.get("orchestrator_register")!("", { project: "test-project" });
      api.tools.get("orchestrator_set_context")!("", {
        project: "test-project",
        task: "release test",
      });
      api.tools.get("orchestrator_log_session")!("", {
        project: "test-project",
        task: "release test",
        model: "gpt-4",
        agent: "Amy",
        status: "complete",
      });
      const exec = api.tools.get("orchestrator_release_project")!;
      const result = await unwrap(exec("", { project: "test-project" }));
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("released_project", "test-project");
    });
  });
  // ── orchestrator_get_registered_sessions ──────────────────
  describe("orchestrator_get_registered_sessions", () => {
    it("should list registered sessions", async () => {
      api.tools.get("orchestrator_register")!("", { project: "test-project" });
      const exec = api.tools.get("orchestrator_get_registered_sessions")!;
      const result = await unwrap(exec("", { project: "test-project" }));
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("registered_sessions");
      expect(Array.isArray(result.registered_sessions)).toBe(true);
      expect(result.count).toBeGreaterThanOrEqual(1);
    });
    it("should show context for sessions that have it", async () => {
      api.tools.get("orchestrator_register")!("", { project: "test-project" });
      api.tools.get("orchestrator_set_context")!("", {
        project: "test-project",
        task: "context test",
      });
      const exec = api.tools.get("orchestrator_get_registered_sessions")!;
      const result = await unwrap(exec("", { project: "test-project" }));
      const withCtx = result.registered_sessions.find(
        (s: any) => s.has_context,
      );
      expect(withCtx).toBeDefined();
      expect(withCtx.project).toBe("test-project");
    });
  });
  // ── orchestrator_join_project ─────────────────────────────
  describe("orchestrator_join_project", () => {
    it("should register and set context in one step", async () => {
      // Create project dir in data
      const fs = require("node:fs");
      const path = require("node:path");
      fs.mkdirSync(path.join(dd, "projects", "test-project"), { recursive: true });
      const exec = api.tools.get("orchestrator_join_project")!;
      const result = await unwrap(
        exec("", { project: "test-project", task: "joining test" }),
      );
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("registered", true);
      expect(result).toHaveProperty("joined_project", "test-project");
    });
  });
});
