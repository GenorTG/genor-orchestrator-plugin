/**
 * PLUGIN-001a — Registration & Session Lifecycle Tests
 *
 * Tests: genorch_session_register, genorch_session_unregister,
 * genorch_session_start_work, genorch_session_clear_work,
 * genorch_project_leave, genorch_project_join,
 * genorch_session_list
 *
 * Pattern: Each test describes one tool call with one assertion.
 * beforeEach creates fresh data dir + plugin register.
 * Tests that need a session call __setTestSessionKey + register first.
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
    it("should fail without session key", async () => {
      const exec = api.tools.get("genorch_session_register")!;
      const result = await unwrap(exec("", {}));
      expect(typeof result === "string" && result.includes("session key")).toBe(true);
    });

    it("should register after setting session key", async () => {
      const mod = await import("../src/index.js");
      mod.__setTestSessionKey("test-key");
      const exec = api.tools.get("genorch_session_register")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("session_key");
    });

    it("should be idempotent on second call", async () => {
      const mod = await import("../src/index.js");
      mod.__setTestSessionKey("test-key");
      const exec = api.tools.get("genorch_session_register")!;
      await unwrap(exec("", {}));
      const r2 = await unwrap(exec("", {}));
      expect(r2).toBe("already registered");
    });

    it("should return session_key string", async () => {
      const mod = await import("../src/index.js");
      mod.__setTestSessionKey("test-key");
      const exec = api.tools.get("genorch_session_register")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("session_key");
      expect(typeof result.session_key).toBe("string");
      expect(result.session_key.length).toBeGreaterThan(0);
    });
  });

  // ── genorch_session_start_work ──────────────────────────────
  describe("genorch_session_start_work", () => {
    it("should fail if session not registered", async () => {
      const exec = api.tools.get("genorch_session_start_work")!;
      const result = await unwrap(exec("", { project: "test-project", task: "test" }));
      expect(result).not.toHaveProperty("ok", true);
    });

    it("should set project context after registration", async () => {
      const mod = await import("../src/index.js");
      mod.__setTestSessionKey("test-key");
      await unwrap(api.tools.get("genorch_session_register")!("", {}));
      const exec = api.tools.get("genorch_session_start_work")!;
      const result = await unwrap(exec("", { project: "test-project", task: "testing" }));
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("project", "test-project");
      expect(result).toHaveProperty("task", "testing");
    });

    it("should reject binding to second project", async () => {
      const mod = await import("../src/index.js");
      mod.__setTestSessionKey("test-key");
      await unwrap(api.tools.get("genorch_session_register")!("", {}));
      await unwrap(api.tools.get("genorch_session_start_work")!("", { project: "test-project", task: "first" }));
      const exec = api.tools.get("genorch_session_start_work")!;
      const result = await unwrap(exec("", { project: "free-project", task: "second" }));
      expect(result).toHaveProperty("ok", false);
      expect(result.error).toMatch(/session|context|registered/i);
    });

    it("should accept same-project re-context", async () => {
      const mod = await import("../src/index.js");
      mod.__setTestSessionKey("test-key");
      await unwrap(api.tools.get("genorch_session_register")!("", {}));
      await unwrap(api.tools.get("genorch_session_start_work")!("", { project: "test-project", task: "first" }));
      const exec = api.tools.get("genorch_session_start_work")!;
      const result = await unwrap(exec("", { project: "test-project", task: "second" }));
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("task", "second");
    });
  });

  // ── genorch_session_clear_work ────────────────────────────
  describe("genorch_session_clear_work", () => {
    it("should fail if task not logged", async () => {
      const mod = await import("../src/index.js");
      mod.__setTestSessionKey("test-key");
      await unwrap(api.tools.get("genorch_session_register")!("", {}));
      await unwrap(api.tools.get("genorch_session_start_work")!("", { project: "test-project", task: "test" }));
      const exec = api.tools.get("genorch_session_clear_work")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("ok", false);
      expect(result.error).toContain("not logged");
    });

    it("should succeed after logging completion", async () => {
      const mod = await import("../src/index.js");
      mod.__setTestSessionKey("test-key");
      await unwrap(api.tools.get("genorch_session_register")!("", {}));
      await unwrap(api.tools.get("genorch_session_start_work")!("", { project: "test-project", task: "test" }));
      await unwrap(api.tools.get("genorch_session_log")!("", { project: "test-project", task: "test", model: "gpt-4", agent: "Amy", status: "done" }));
      const exec = api.tools.get("genorch_session_clear_work")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("ok", true);
    });
  });

  // ── genorch_session_unregister ───────────────────────────────
  describe("genorch_session_unregister", () => {
    it("should unregister a registered session", async () => {
      const mod = await import("../src/index.js");
      mod.__setTestSessionKey("test-key");
      await unwrap(api.tools.get("genorch_session_register")!("", {}));
      const exec = api.tools.get("genorch_session_unregister")!;
      const result = await unwrap(exec("", {}));
      expect(result).toBe("unregistered");
    });
  });

  // ── genorch_project_leave ──────────────────────────
  describe("genorch_project_leave", () => {
    it("should fail if no binding", async () => {
      const mod = await import("../src/index.js");
      mod.__setTestSessionKey("test-key");
      await unwrap(api.tools.get("genorch_session_register")!("", {}));
      const exec = api.tools.get("genorch_project_leave")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("ok", false);
    });

    it("should fail if task not logged", async () => {
      const mod = await import("../src/index.js");
      mod.__setTestSessionKey("test-key");
      await unwrap(api.tools.get("genorch_session_register")!("", {}));
      await unwrap(api.tools.get("genorch_session_start_work")!("", { project: "test-project", task: "test" }));
      const exec = api.tools.get("genorch_project_leave")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("ok", false);
      expect(result.error).toContain("not logged");
    });
  });

  // ── genorch_session_list ──────────────────
  describe("genorch_session_list", () => {
    it("should list registered sessions", async () => {
      const mod = await import("../src/index.js");
      mod.__setTestSessionKey("test-key");
      await unwrap(api.tools.get("genorch_session_register")!("", {}));
      const exec = api.tools.get("genorch_session_list")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("registered_sessions");
      expect(Array.isArray(result.registered_sessions)).toBe(true);
    });
  });

  // ── genorch_project_join ─────────────────────────────
  describe("genorch_project_join", () => {
    it("should register and set context in one step", async () => {
      const mod = await import("../src/index.js");
      mod.__setTestSessionKey("test-key");
      const fs2 = require("node:fs");
      const p2 = require("node:path");
      fs2.mkdirSync(p2.join(dd, "projects", "test-project"), { recursive: true });
      const exec = api.tools.get("genorch_project_join")!;
      const result = await unwrap(exec("", { project: "test-project", task: "joining test" }));
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("joined_project", "test-project");
    });
  });
});
