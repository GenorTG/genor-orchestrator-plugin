/**
 * PLUGIN-001b — Status & Config Tests
 *
 * Tests: genorch_status, genorch_config_show_routing,
 * genorch_models_list, genorch_models_check_routing,
 * genorch_models_recommend
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
describe("PLUGIN-001b — Status & Config", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
    // Register + set context for tools that need it
    api.tools.get("genorch_session_register")!("", {});
    api.tools.get("genorch_session_start_work")!("", {
      project: "test-project",
      task: "testing",
    });
  });
  // ── genorch_status ──────────────────────────────
  describe("genorch_status", () => {
    it("should return status object with model counts", async () => {
      const exec = api.tools.get("genorch_status")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("total_models");
      expect(result).toHaveProperty("active_models");
      expect(result).toHaveProperty("agent_ready_models");
      expect(result).toHaveProperty("sessions_logged");
      expect(result).toHaveProperty("projects");
      expect(Array.isArray(result.projects)).toBe(true);
    });
    it("should report free_only_mode from config", async () => {
      const exec = api.tools.get("genorch_status")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("free_only_mode", false);
    });
    it("should include data_dir in response", async () => {
      const exec = api.tools.get("genorch_status")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("data_dir");
      expect(typeof result.data_dir).toBe("string");
    });
  });
  // ── genorch_config_show_routing ──────────────────────────────
  describe("genorch_config_show_routing", () => {
    it("should return config with free_only_mode and projects", async () => {
      const exec = api.tools.get("genorch_config_show_routing")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("free_only_mode");
      expect(result).toHaveProperty("disabled_models");
      expect(result).toHaveProperty("projects");
      expect(result).toHaveProperty("project_count", 3);
    });
    it("should list disabled models from config", async () => {
      const exec = api.tools.get("genorch_config_show_routing")!;
      const result = await unwrap(exec("", {}));
      expect(result.disabled_models).toContain("offline-model");
    });
    it("should include total model count", async () => {
      const exec = api.tools.get("genorch_config_show_routing")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("total_models", 8);
    });
  });
  // ── genorch_models_list ──────────────────────────────
  describe("genorch_models_list", () => {
    it("should list all models by default", async () => {
      const exec = api.tools.get("genorch_models_list")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("total", 8);
      expect(result).toHaveProperty("filtered");
      expect(Array.isArray(result.models)).toBe(true);
    });
    it("should filter by status", async () => {
      const exec = api.tools.get("genorch_models_list")!;
      const result = await unwrap(exec("", { status: "active" }));
      expect(result.filtered).toBeGreaterThan(0);
      for (const m of result.models) {
        expect(m.status).toBe("active");
      }
    });
    it("should filter by provider (partial match)", async () => {
      const exec = api.tools.get("genorch_models_list")!;
      const result = await unwrap(exec("", { provider: "openai" }));
      expect(result.filtered).toBeGreaterThan(0);
      for (const m of result.models) {
        expect(m.provider).toMatch(/openai/i);
      }
    });
    it("should filter by search term", async () => {
      const exec = api.tools.get("genorch_models_list")!;
      const result = await unwrap(exec("", { search: "gemini" }));
      expect(result.filtered).toBeGreaterThan(0);
      for (const m of result.models) {
        const q = "gemini";
        expect(
          m.id.toLowerCase().includes(q) ||
            (m.name || "").toLowerCase().includes(q),
        ).toBe(true);
      }
    });
    it("should filter by agent_ready flag", async () => {
      const exec = api.tools.get("genorch_models_list")!;
      const result = await unwrap(exec("", { agent_ready: false }));
      for (const m of result.models) {
        expect(m.agent_ready).toBe(false);
      }
    });
  });
  // ── genorch_models_check_routing ────────────────────────────
  describe("genorch_models_check_routing", () => {
    it("should return eligibility without project", async () => {
      const exec = api.tools.get("genorch_models_check_routing")!;
      const result = await unwrap(exec("", {}));
      expect(result).toHaveProperty("eligible_count");
      expect(result).toHaveProperty("total_available", 8);
      expect(result).toHaveProperty("filters_applied");
      // offline-model is globally disabled
      expect(result.eligible_count).toBe(7);
    });
    it("should apply project-level allowlist", async () => {
      const exec = api.tools.get("genorch_models_check_routing")!;
      const result = await unwrap(
        exec("", { project: "allowlist-project" }),
      );
      expect(result.eligible_count).toBe(2); // deepseek-v2, gemini-pro
    });
    it("should apply project-level free_only", async () => {
      const exec = api.tools.get("genorch_models_check_routing")!;
      const result = await unwrap(exec("", { project: "free-project" }));
      // free_only filters out subscription and payg models
      expect(result.eligible_count).toBeGreaterThan(0);
      expect(result.free_only_mode).toBe(false);
      expect(result.filters_applied).toContain("project_free_only");
    });
  });
  // ── genorch_models_recommend ─────────────────────────────
  describe("genorch_models_recommend", () => {
    it("should return recommended model for a category", async () => {
      const exec = api.tools.get("genorch_models_recommend")!;
      // Set context for test-project which has model_routing
      const result = await unwrap(
        exec("", { category: "coding" }),
      );
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("recommended");
      expect(result).toHaveProperty("fallbacks");
      expect(result.recommended).toBe("gpt-4");
    });
    it("should return error for unknown category", async () => {
      const exec = api.tools.get("genorch_models_recommend")!;
      const result = await unwrap(
        exec("", { category: "unknown-category" }),
      );
      expect(result).toHaveProperty("ok", false);
      expect(result).toHaveProperty("error");
    });
    it("should accept explicit project parameter", async () => {
      const exec = api.tools.get("genorch_models_recommend")!;
      const result = await unwrap(
        exec("", { category: "fixing", project: "test-project" }),
      );
      expect(result).toHaveProperty("ok", true);
      expect(result.recommended).toBe("claude-3");
    });
  });
});
