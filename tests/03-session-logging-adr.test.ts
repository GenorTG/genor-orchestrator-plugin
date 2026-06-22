/**
 * PLUGIN-001c — Session Logging & ADR Tests
 *
 * Tests: genorch_session_log, genorch_adr_log, genorch_logs_query
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi, prepareTestDataDir, registerPlugin, unwrap, type MockApiType } from "./setup.js";

let plugin: any;
beforeEach(async () => { vi.resetModules(); plugin = (await import("../src/index.js")).default; });

describe("PLUGIN-001c — Session Logging & ADR", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
  });

  async function setup() {
    const mod = await import("../src/index.js");
    mod.__setTestSessionKey("test-key");
    await unwrap(api.tools.get("genorch_session_register")!("", {}));
    await unwrap(api.tools.get("genorch_session_start_work")!("", { project: "test-project", task: "test" }));
  }

  describe("genorch_session_log", () => {
    it("should log with status=complete", async () => {
      await setup();
      const r = await unwrap(api.tools.get("genorch_session_log")!("", { project: "test-project", task: "test", model: "gpt-4", agent: "Amy", status: "done" }));
      expect(r).toHaveProperty("success", true);
    });

    it("should set loggedTaskCompletion flag", async () => {
      await setup();
      await unwrap(api.tools.get("genorch_session_log")!("", { project: "test-project", task: "test", model: "gpt-4", agent: "Amy", status: "done" }));
      const r = await unwrap(api.tools.get("genorch_session_clear_work")!("", {}));
      expect(r).toHaveProperty("ok", true);
    });

    it("should handle subagent agent name", async () => {
      await setup();
      const r = await unwrap(api.tools.get("genorch_session_log")!("", { project: "test-project", task: "test", model: "gpt-4", agent: "sub-agent-1", status: "done" }));
      expect(r).toHaveProperty("success", true);
    });
  });

  describe("genorch_adr_log", () => {
    it("should create an ADR entry", async () => {
      await setup();
      const r = await unwrap(api.tools.get("genorch_adr_log")!("", { project: "test-project", title: "Test Decision", context: "Testing context", decision: "We chose X" }));
      expect(r).toHaveProperty("success", true);
    });

    it("should require required fields", async () => {
      const r = await unwrap(api.tools.get("genorch_adr_log")!("", { project: "test-project" }));
      expect(r).toHaveProperty("ok", false);
    });
  });

  describe("genorch_logs_query", () => {
    it("should filter by source", async () => {
      await setup();
      const r = await unwrap(api.tools.get("genorch_logs_query")!("", { source: "routing" }));
      expect(Array.isArray(r.entries)).toBe(true);
      expect(r).toHaveProperty("total");
    });
  });
});
