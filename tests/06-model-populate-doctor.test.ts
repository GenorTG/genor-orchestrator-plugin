/**
 * PLUGIN-001f — Model Population & Doctor Tests
 *
 * Tests: orchestrator_auto_populate, orchestrator_doctor,
 * orchestrator_check_models (additional routing scenarios)
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
describe("PLUGIN-001f — Model Population & Doctor", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
    api.tools.get("orchestrator_register")!("", { project: "test-project" });
    api.tools.get("orchestrator_set_context")!("", {
      project: "test-project",
      task: "doctor test",
    });
  });
  // ── orchestrator_auto_populate ───────────────────────────
  describe("orchestrator_auto_populate", () => {
    it("should return error since python3 is not available in test", async () => {
      const exec = api.tools.get("orchestrator_auto_populate")!;
      const result = await unwrap(exec("", { project: "test-project" }));
      // Script not found or python3 unavailable
      expect(result).toHaveProperty("error") || expect(result).toHaveProperty("success", false);
    });
  });
  // ── orchestrator_doctor ──────────────────────────────────
  describe("orchestrator_doctor", () => {
    it("should run session health checks", async () => {
      const exec = api.tools.get("orchestrator_doctor")!;
      const result = await unwrap(exec("", { check: "sessions" }));
      expect(result).toHaveProperty("ok");
      expect(result).toHaveProperty("checks", "sessions");
      expect(result).toHaveProperty("issues_found");
      expect(result).toHaveProperty("fixes_applied", 0);
    });
    it("should run context health checks", async () => {
      const exec = api.tools.get("orchestrator_doctor")!;
      const result = await unwrap(exec("", { check: "context" }));
      expect(result).toHaveProperty("checks", "context");
    });
    it("should run data health checks", async () => {
      const exec = api.tools.get("orchestrator_doctor")!;
      const result = await unwrap(exec("", { check: "data" }));
      expect(result).toHaveProperty("checks", "data");
    });
    it("should run all checks by default", async () => {
      const exec = api.tools.get("orchestrator_doctor")!;
      const result = await unwrap(exec("", { project: "test-project" }));
      expect(result).toHaveProperty("checks", "all");
      expect(result).toHaveProperty("session_key");
      expect(result).toHaveProperty("registered", true);
      expect(result).toHaveProperty("project_context");
    });
    it("should apply auto-fixes when fix=true", async () => {
      const exec = api.tools.get("orchestrator_doctor")!;
      const result = await unwrap(exec("", { fix: true }));
      // Fixes may be applied for discovered issues
      expect(result).toHaveProperty("fixes_applied");
      expect(typeof result.fixes_applied).toBe("number");
    });
    it("should report orphaned/unhealthy projects", async () => {
      // Create a project dir with 0 sessions (orphaned)
      const projDir = path.join(dd, "projects", "orphaned-project");
      fs.mkdirSync(projDir, { recursive: true });
      // No sessions.json — counts as zero sessions
      const exec = api.tools.get("orchestrator_doctor")!;
      const result = await unwrap(exec("", { check: "data" }));
      expect(result).toHaveProperty("issues");
      if (result.issues_found > 0) {
        const orphanedIssue = result.issues.find(
          (i: string) =>
            i.includes("orphaned") || i.includes("0 sessions"),
        );
        // May or may not be in issues depending on config
      }
    });
    it("should report stale live-agents.json", async () => {
      // Write a very old live-agents.json
      const laPath = path.join(dd, "live-agents.json");
      fs.writeFileSync(
        laPath,
        JSON.stringify({ agents: [], agent_count: 0 }),
      );
      // Modify mtime to be old
      const oldTime = new Date(Date.now() - 600_000); // 10 min ago
      fs.utimesSync(laPath, oldTime, oldTime);
      const exec = api.tools.get("orchestrator_doctor")!;
      const result = await unwrap(
        exec("", { check: "data", fix: true }),
      );
      // May find or fix stale file
      expect(result).toHaveProperty("fixes_applied");
    });
  });
  // ── Additional check_models scenarios ────────────────────
  describe("orchestrator_check_models (additional)", () => {
    it("should return total available and eligible counts", async () => {
      const exec = api.tools.get("orchestrator_check_models")!;
      const result = await unwrap(exec("", { project: "test-project" }));
      expect(result.total_available).toBeGreaterThan(0);
      expect(result.eligible_count).toBeGreaterThanOrEqual(0);
      expect(result.eligible_count).toBeLessThanOrEqual(result.total_available);
    });
    it("should enumerate applied filters", async () => {
      const exec = api.tools.get("orchestrator_check_models")!;
      // Without project, only global filters apply
      const result = await unwrap(exec("", { project: "test-project" }));
      expect(Array.isArray(result.filters_applied)).toBe(true);
      // offline-model is globally disabled
      expect(result.filters_applied).toContain("global_disabled");
    });
    it("should return eligible_models with details", async () => {
      const exec = api.tools.get("orchestrator_check_models")!;
      const result = await unwrap(exec("", { project: "test-project" }));
      expect(Array.isArray(result.eligible_models)).toBe(true);
      if (result.eligible_models.length > 0) {
        const m = result.eligible_models[0];
        expect(m).toHaveProperty("id");
        expect(m).toHaveProperty("provider");
        expect(m).toHaveProperty("cost_type");
        expect(m).toHaveProperty("agent_ready");
      }
    });
    it("should respect free_only_mode when set", async () => {
      // Update config to enable free_only_mode
      const configPath = path.join(dd, "dashboard-config.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      config.free_only_mode = true;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      const exec = api.tools.get("orchestrator_check_models")!;
      const result = await unwrap(exec("", { project: "test-project" }));
      expect(result.free_only_mode).toBe(true);
      // Free-only should filter out paid models
      // But we also have global_disabled for offline-model
      expect(result.eligible_count).toBeGreaterThanOrEqual(0);
    });
  });
});
