/**
 * PLUGIN-001b — Status & Config Tests
 *
 * Tests: genorch_status, genorch_config_show_routing,
 * genorch_models_list, genorch_models_check_routing,
 * genorch_models_recommend
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createMockApi,
  prepareTestDataDir,
  registerPlugin,
  initTest,
  unwrap,
  type MockApiType,
} from "./setup.js";

let plugin: any;
beforeEach(async () => { vi.resetModules(); plugin = (await import("../src/index.js")).default; });

describe("PLUGIN-001b — Status & Config", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
  });

  describe("genorch_status", () => {
    it("should return status with model counts", async () => {
      const r = await unwrap(api.tools.get("genorch_status")!("", {}));
      expect(r).toHaveProperty("total_models");
      expect(r).toHaveProperty("active_models");
      expect(r).toHaveProperty("agent_ready_models");
      expect(r).toHaveProperty("sessions_logged");
      expect(r).toHaveProperty("projects");
      expect(Array.isArray(r.projects)).toBe(true);
    });

    it("should report free_only_mode", async () => {
      const r = await unwrap(api.tools.get("genorch_status")!("", {}));
      expect(r).toHaveProperty("free_only_mode", false);
    });

    it("should include data_dir", async () => {
      const r = await unwrap(api.tools.get("genorch_status")!("", {}));
      expect(r).toHaveProperty("data_dir");
      expect(typeof r.data_dir).toBe("string");
    });
  });

  describe("genorch_config_show_routing", () => {
    it("should return config structure", async () => {
      const r = await unwrap(api.tools.get("genorch_config_show_routing")!("", {}));
      expect(r).toHaveProperty("free_only_mode");
      expect(r).toHaveProperty("disabled_models");
      expect(r).toHaveProperty("projects");
    });

    it("should list disabled models", async () => {
      const r = await unwrap(api.tools.get("genorch_config_show_routing")!("", {}));
      expect(r.disabled_models).toContain("offline-model");
    });
  });

  describe("genorch_models_list", () => {
    it("should list all models by default", async () => {
      const r = await unwrap(api.tools.get("genorch_models_list")!("", {}));
      expect(r).toHaveProperty("total");
      expect(r).toHaveProperty("filtered");
      expect(Array.isArray(r.models)).toBe(true);
    });

    it("should filter by status", async () => {
      const r = await unwrap(api.tools.get("genorch_models_list")!("", { status: "active" }));
      expect(r.filtered).toBeGreaterThan(0);
      for (const m of r.models) expect(m.status).toBe("active");
    });

    it("should filter by provider", async () => {
      const r = await unwrap(api.tools.get("genorch_models_list")!("", { provider: "openai" }));
      expect(r.filtered).toBeGreaterThan(0);
      for (const m of r.models) expect(m.provider).toMatch(/openai/i);
    });

    it("should filter by search", async () => {
      const r = await unwrap(api.tools.get("genorch_models_list")!("", { search: "gemini" }));
      expect(r.filtered).toBeGreaterThan(0);
      for (const m of r.models) {
        expect(m.id + " " + (m.name || "")).toMatch(/gemini/i);
      }
    });

    it("should filter by agent_ready", async () => {
      const r = await unwrap(api.tools.get("genorch_models_list")!("", { agent_ready: false }));
      for (const m of r.models) expect(m.agent_ready).toBe(false);
    });
  });

  describe("genorch_models_check_routing", () => {
    it("should return eligibility", async () => {
      const r = await unwrap(api.tools.get("genorch_models_check_routing")!("", {}));
      expect(r).toHaveProperty("eligible_count");
      expect(r).toHaveProperty("total_available");
      expect(r).toHaveProperty("filters_applied");
    });

    it("should apply project allowlist", async () => {
      const r = await unwrap(api.tools.get("genorch_models_check_routing")!("", { project: "allowlist-project" }));
      expect(r.eligible_count).toBe(2);
    });
  });

  describe("genorch_models_recommend", () => {
    it("should return recommended model for category with explicit project", async () => {
      const r = await unwrap(api.tools.get("genorch_models_recommend")!("", { category: "coding", project: "test-project" }));
      expect(r).toHaveProperty("ok", true);
      expect(r).toHaveProperty("recommended");
      expect(r).toHaveProperty("fallbacks");
    });

    it("should return error for unknown category", async () => {
      const r = await unwrap(api.tools.get("genorch_models_recommend")!("", { category: "unknown-category", project: "test-project" }));
      expect(r).toHaveProperty("ok", false);
      expect(r).toHaveProperty("error");
    });

    it("should accept explicit project param", async () => {
      const r = await unwrap(api.tools.get("genorch_models_recommend")!("", { category: "fixing", project: "test-project" }));
      expect(r).toHaveProperty("ok", true);
    });
  });
});
