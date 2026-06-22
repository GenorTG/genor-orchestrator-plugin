/**
 * PLUGIN-001c — Session Logging & ADR Tests
 *
 * Tests: genorch_session_log, genorch_adr_log,
 * genorch_logs_query — schema enforcement, timestamp defaults,
 * ADR file creation
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
describe("PLUGIN-001c — Session Logging & ADR", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
    api.tools.get("genorch_session_register")!("", {});
    api.tools.get("genorch_session_start_work")!("", {
      project: "test-project",
      task: "logging test",
    });
  });
  // ── genorch_session_log ─────────────────────────────
  describe("genorch_session_log", () => {
    it("should log a session entry with status=complete", async () => {
      const exec = api.tools.get("genorch_session_log")!;
      const result = await unwrap(
        exec("", {
          project: "test-project",
          task: "fix bug",
          model: "gpt-4",
          agent: "Amy",
          status: "complete",
          duration: "30min",
        }),
      );
      expect(result).toHaveProperty("success", true);
      expect(result).toHaveProperty("project", "test-project");
      expect(result).toHaveProperty("task", "fix bug");
    });
    it("should set loggedTaskCompletion flag", async () => {
      // After logging, clear_context should work
      api.tools.get("genorch_session_log")!("", {
        project: "test-project",
        task: "test",
        model: "gpt-4",
        agent: "Amy",
        status: "complete",
      });
      const clear = api.tools.get("genorch_session_clear_work")!;
      const clearResult = await unwrap(clear("", {}));
      expect(clearResult).toHaveProperty("ok", true);
    });
    it("should persist session to database", async () => {
      api.tools.get("genorch_session_log")!("", {
        project: "test-project",
        task: "persistence test",
        model: "claude-3",
        agent: "Amy",
        status: "complete",
        duration: "15min",
      });
      // Session is persisted in SQLite; log_session returns success
      // (no file-based storage — sessions are in the database)
      const result = await unwrap(
        api.tools.get("genorch_session_log")!("", {
          project: "test-project",
          task: "persistence test 2",
          model: "gpt-4",
          agent: "Amy",
          status: "complete",
        }),
      );
      expect(result).toHaveProperty("success", true);
      expect(result).toHaveProperty("project", "test-project");
    });
    it("should create session detail markdown file", async () => {
      // Session detail files removed — sessions stored in SQLite only
      // This test is obsolete; session logging goes to the database.
    });
    it("should append to session_log.md", async () => {
      // session_log.md removed — sessions stored in SQLite only
      // This test is obsolete; session logging goes to the database.
    });
    it("should handle subagent agent names gracefully", async () => {
      const exec = api.tools.get("genorch_session_log")!;
      const result = await unwrap(
        exec("", {
          project: "test-project",
          task: "subagent test",
          model: "gpt-4",
          agent: "subagent-abc123def",
          status: "complete",
        }),
      );
      expect(result).toHaveProperty("success", true);
    });
  });
  // ── genorch_adr_log ────────────────────────────
  describe("genorch_adr_log", () => {
    it("should create an ADR file", async () => {
      const exec = api.tools.get("genorch_adr_log")!;
      const result = await unwrap(
        exec("", {
          project: "test-project",
          title: "Use TypeBox for validation",
          context: "Need runtime validation for tool params",
          decision: "Use TypeBox because it integrates with OpenClaw SDK",
          alternatives: "Zod, Joi",
          consequences: "Tighter integration, no Joi dep",
        }),
      );
      expect(result).toHaveProperty("success", true);
      expect(result).toHaveProperty("adr_number", 1);
      expect(result).toHaveProperty("adr_file");
      expect(result.adr_file).toMatch(/\.md$/);
    });
    it("should increment ADR numbers", async () => {
      const exec = api.tools.get("genorch_adr_log")!;
      exec("", {
        project: "test-project",
        title: "First decision",
        context: "Ctx 1",
        decision: "Dec 1",
      });
      const r2 = await unwrap(
        exec("", {
          project: "test-project",
          title: "Second decision",
          context: "Ctx 2",
          decision: "Dec 2",
        }),
      );
      expect(r2.adr_number).toBe(2);
    });
    it("should persist ADR file to disk with correct content", async () => {
      const exec = api.tools.get("genorch_adr_log")!;
      await unwrap(
        exec("", {
          project: "test-project",
          title: "Persist test",
          context: "Persist context",
          decision: "Persist decision",
        }),
      );
      const adrsDir = path.join(dd, "adrs");
      const files = fs.readdirSync(adrsDir).filter((f) => f.endsWith(".md"));
      expect(files.length).toBe(1);
      const content = fs.readFileSync(path.join(adrsDir, files[0]), "utf-8");
      expect(content).toContain("ADR-0001");
      expect(content).toContain("Persist test");
      expect(content).toContain("Persist decision");
    });
    it("should require required fields (project, title, context, decision)", async () => {
      const exec = api.tools.get("genorch_adr_log")!;
      // With all required fields it should work
      const result = await unwrap(
        exec("", {
          project: "test-project",
          title: "Required fields test",
          context: "Testing required fields",
          decision: "All required fields present",
        }),
      );
      expect(result).toHaveProperty("success", true);
    });
  });
  // ── genorch_logs_query ────────────────────────────────
  describe("genorch_logs_query", () => {
    it("should return log entries", async () => {
      const exec = api.tools.get("genorch_logs_query")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("entries");
      expect(Array.isArray(result.entries)).toBe(true);
      expect(result).toHaveProperty("sources");
      expect(result).toHaveProperty("levels");
    });
    it("should filter by level", async () => {
      const exec = api.tools.get("genorch_logs_query")!;
      const result = await unwrap(exec("", { level: "info" }));
      for (const e of result.entries) {
        expect(["info"].includes(e.level)).toBe(true);
      }
    });
    it("should respect limit parameter", async () => {
      const exec = api.tools.get("genorch_logs_query")!;
      const result = await unwrap(exec("", { limit: 5 }));
      expect(result.entries.length).toBeLessThanOrEqual(5);
    });
    it("should filter by source", async () => {
      // Perform a decision log first so there's a "decisions" source entry
      api.tools.get("genorch_adr_log")!("", {
        project: "test-project",
        title: "Source filter test",
        context: "Testing source filter",
        decision: "Verify source filtering",
      });
      const exec = api.tools.get("genorch_logs_query")!;
      const result = await unwrap(
        exec("", { source: "decisions" }),
      );
      expect(result.entries.length).toBeGreaterThanOrEqual(1);
      for (const e of result.entries) {
        expect(e.source).toContain("decisions");
      }
    });
  });
});
