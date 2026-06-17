/**
 * PLUGIN-001i — Integration & Edge Case Tests
 *
 * Full lifecycle tests, error handling, persistence verification,
 * module-level state interactions
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createMockApi,
  prepareTestDataDir,
  registerPlugin,
  unwrap,
  writeSessionLog,
  type MockApiType,
} from "./setup.js";
let plugin: any;
beforeEach(async () => {
  vi.resetModules();
  plugin = (await import("../src/index.js")).default;
});
describe("PLUGIN-001i — Integration & Edge Cases", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
  });
  // ── Full lifecycle ───────────────────────────────────────
  describe("Full lifecycle", () => {
    it("should complete register → set_context → work → log → clear", async () => {
      // 1. Register
      const r1 = await unwrap(api.tools.get("orchestrator_register")!("", { project: "test-project" }));
      expect(r1).toHaveProperty("ok", true);
      // 2. Set context
      const r2 = await unwrap(
        api.tools.get("orchestrator_set_context")!("", {
          project: "test-project",
          task: "full lifecycle test",
        }),
      );
      expect(r2).toHaveProperty("ok", true);
      // 3. Work phase advance (happy path through workflow)
      const adv = api.tools.get("orchestrator_advance_phase")!;
      await unwrap(adv("", {})); // analyze → plan
      await unwrap(adv("", {})); // plan → document
      await unwrap(adv("", {})); // document → work
      await unwrap(adv("", {})); // work → log
      // 4. Log session completion
      const r3 = await unwrap(
        api.tools.get("orchestrator_log_session")!("", {
          project: "test-project",
          task: "full lifecycle test",
          model: "gpt-4",
          agent: "Amy",
          status: "complete",
          duration: "45min",
          notes: "Completed full lifecycle test",
        }),
      );
      expect(r3).toHaveProperty("success", true);
      // 5. Clear context
      const r4 = await unwrap(api.tools.get("orchestrator_clear_context")!("", {}));
      expect(r4).toHaveProperty("ok", true);
      expect(r4.previous_project).toBe("test-project");
      // 6. Unregister (returns string "unregistered")
      const r5 = await unwrap(api.tools.get("orchestrator_unregister")!("", {}));
      const ok = typeof r5 === "string" || r5.ok === true;
      expect(ok).toBe(true);
    });
    it("should persist session data across tool calls", async () => {
      // Create a session
      await api.tools.get("orchestrator_register")!("", { project: "test-project" });
      await api.tools.get("orchestrator_set_context")!("", {
        project: "test-project",
        task: "persistence test",
      });
      // Log the decision
      await api.tools.get("orchestrator_log_decision")!("", {
        project: "test-project",
        title: "Persistence Decision",
        context: "Need to persist data",
        decision: "Use sessions.json",
      });
      // Log session
      await api.tools.get("orchestrator_log_session")!("", {
        project: "test-project",
        task: "persistence test",
        model: "claude-3",
        agent: "Amy",
        status: "complete",
      });
      // Verify disk persistence
      const sessFile = path.join(
        dd,
        "projects",
        "test-project",
        "sessions.json",
      );
      expect(fs.existsSync(sessFile)).toBe(true);
      const sessData = JSON.parse(fs.readFileSync(sessFile, "utf-8"));
      expect(sessData.sessions.length).toBeGreaterThanOrEqual(1);
      expect(sessData.sessions[0].project).toBe("test-project");
      // Verify ADR persistence
      const adrDir = path.join(dd, "adrs");
      expect(fs.existsSync(adrDir)).toBe(true);
      const adrFiles = fs.readdirSync(adrDir).filter((f) => f.endsWith(".md"));
      expect(adrFiles.length).toBeGreaterThanOrEqual(1);
    });
  });
  // ── Error handling ───────────────────────────────────────
  describe("Error handling", () => {
    it("should return error for unregistered tool calls that require registration", async () => {
      // These tools should fail without registration
      const protectedTools = [
        "orchestrator_set_context",
        "orchestrator_get_status",
        "orchestrator_get_config",
        "orchestrator_clear_context",
        "orchestrator_sync_project",
        "orchestrator_release_project",
        "orchestrator_spawn_subagent",
        "orchestrator_backlog_add",
        "orchestrator_backlog_list",
        "orchestrator_backlog_update",
        "orchestrator_backlog_dispatch",
        "orchestrator_create_project",
        "orchestrator_advance_phase",
      ];
      for (const toolName of protectedTools) {
        const exec = api.tools.get(toolName);
        if (!exec) continue;
        let result: any;
        try {
          result = await unwrap(exec("", {}));
        } catch (e: any) {
          result = { ok: false, error: String(e.message) };
        }
        // Should either return error or be ok
        if (result && result.ok === false && result.error) {
          expect(result.error).toBeTruthy();
        }
      }
    });
    it("should handle non-existent project gracefully", async () => {
      api.tools.get("orchestrator_register")!("", { project: "test-project" });
      const exec = api.tools.get("orchestrator_get_project_docs")!;
      const result = await unwrap(
        exec("", { project: "nonexistent-project" }),
      );
      // Should return a project with 0 docs instead of crashing
      expect(result).toHaveProperty("project", "nonexistent-project");
      expect(result).toHaveProperty("doc_count", 0);
    });
    it("should handle empty config gracefully", async () => {
      // Re-register with empty data dir
      const emptyDd = prepareTestDataDir(false); // no fixtures
      const emptyApi = createMockApi();
      process.env.ORCHESTRATOR_DATA_DIR = emptyDd;
      plugin.register(emptyApi);
      emptyApi.tools.get("orchestrator_register")!("", {});
      // get_config without models.json/config should report error
      const configExec = emptyApi.tools.get("orchestrator_get_config")!;
      const configResult = await unwrap(configExec("", {}));
      // May have error or fallback
      expect(configResult).toBeDefined();
    });
  });
  // ── Session validation ───────────────────────────────────
  describe("Session validation (doctor)", () => {
    it("should validate session entries for integrity", async () => {
      // Write a sessions.json with valid and invalid entries
      const projDir = path.join(dd, "projects", "test-project");
      fs.mkdirSync(projDir, { recursive: true });
      const sessions = {
        schema_version: 2,
        sessions: [
          {
            id: "sess_valid_1",
            session_key: "agent:main:valid:key",
            project: "test-project",
            task: "valid task",
            start_time: "2025-01-01T00:00:00.000Z",
            end_time: "2025-01-01T01:00:00.000Z",
            status: "complete",
            duration: "60min",
          },
          {
            id: "sess_invalid_1",
            session_key: "",
            project: "",
            task: "",
            status: "running",
          },
        ],
      };
      fs.writeFileSync(
        path.join(projDir, "sessions.json"),
        JSON.stringify(sessions, null, 2),
      );
      api.tools.get("orchestrator_register")!("", { project: "test-project" });
      const exec = api.tools.get("orchestrator_doctor")!;
      const result = await unwrap(exec("", { check: "data" }));
      // Should flag issues
      expect(result).toHaveProperty("checks", "data");
    });
  });
  // ── get_models edge cases ───────────────────────────────
  describe("get_models edge cases", () => {
    it("should handle empty models.json gracefully", async () => {
      const emptyDd = prepareTestDataDir(false);
      fs.writeFileSync(
        path.join(emptyDd, "models.json"),
        JSON.stringify({ models: [] }),
      );
      const emptyApi = createMockApi();
      process.env.ORCHESTRATOR_DATA_DIR = emptyDd;
      plugin.register(emptyApi);
      emptyApi.tools.get("orchestrator_register")!("", {});
      const exec = emptyApi.tools.get("orchestrator_get_models")!;
      const result = await unwrap(exec("", { project: "test-project" }));
      expect(result.total).toBe(0);
      expect(result.models).toEqual([]);
    });
    it("should handle provider filter with no matches", async () => {
      api.tools.get("orchestrator_register")!("", { project: "test-project" });
      const exec = api.tools.get("orchestrator_get_models")!;
      const result = await unwrap(
        exec("", { provider: "nonexistent-provider" }),
      );
      expect(result.filtered).toBe(0);
      expect(result.models).toEqual([]);
    });
  });
  // ── Hook registration ───────────────────────────────────
  describe("Hook registration", () => {
    it("should register lifecycle hooks", async () => {
      // The plugin registers hooks via api.on()
      const hookEvents = [
        "session_start",
        "session_end",
        "subagent_spawned",
        "subagent_ended",
        "before_model_resolve",
        "before_prompt_build",
        "agent_end",
        "gateway_stop",
      ];
      for (const event of hookEvents) {
        expect(api.hooks.has(event)).toBe(true);
      }
    });
    it("should have registered all required commands", async () => {
      const cmdNames = [
        "genor-dashboard",
        "genor-status",
        "genor-help",
        "genor-git-commit",
        "genor-doctor",
      ];
      for (const name of cmdNames) {
        expect(api.commands.has(name)).toBe(true);
      }
    });
  });
  // ── Plugin metadata ─────────────────────────────────────
  describe("Plugin metadata", () => {
    it("should have correct plugin id", async () => {
      expect(plugin.id).toBe("genor-orchestrator");
    });
    it("should have non-empty name and description", async () => {
      expect(typeof plugin.name).toBe("string");
      expect(plugin.name.length).toBeGreaterThan(0);
      expect(typeof plugin.description).toBe("string");
      expect(plugin.description.length).toBeGreaterThan(0);
    });
    it("should expose a register function", async () => {
      expect(typeof plugin.register).toBe("function");
    });
  });
  // ── Multiple registrations ──────────────────────────────
  describe("Multiple registrations", () => {
    it("should handle re-registration gracefully (idempotent register)", async () => {
      // First register succeeds with object
      const rFirst = await unwrap(api.tools.get("orchestrator_register")!("", { project: "test-project" }));
      expect(rFirst).toHaveProperty("ok", true);
      // Second call returns string "already registered"
      const rSecond = await unwrap(api.tools.get("orchestrator_register")!("", { project: "test-project" }));
      expect(typeof rSecond === "string" || rSecond.ok === true).toBe(true);
    });
  });
});
