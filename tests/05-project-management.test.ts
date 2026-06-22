/**
 * PLUGIN-001e — Project Management Tests
 *
 * Tests: genorch_project_create, genorch_project_sync_files,
 * genorch_project_docs_list
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi, prepareTestDataDir, registerPlugin, unwrap, type MockApiType } from "./setup.js";

let plugin: any;
beforeEach(async () => { vi.resetModules(); plugin = (await import("../src/index.js")).default; });

describe("PLUGIN-001e — Project Management", () => {
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

  describe("genorch_project_create", () => {
    it("should create a new project", async () => {
      await setup();
      const r = await unwrap(api.tools.get("genorch_project_create")!("", { name: "new-project" }));
      expect(r).toHaveProperty("ok", true);
    });
  });

  describe("genorch_project_sync_files", () => {
    it("should sync project files", async () => {
      await setup();
      const fs2 = require("node:fs");
      const p2 = require("node:path");
      // Create the project location directory (as configured in dashboard-config.json)
      const locDir = "/tmp/test-project-loc";
      fs2.mkdirSync(locDir, { recursive: true });
      fs2.writeFileSync(p2.join(locDir, "test.txt"), "hello");
      const r = await unwrap(api.tools.get("genorch_project_sync_files")!("", { project: "test-project" }));
      expect(r).toHaveProperty("ok", true);
      expect(r).toHaveProperty("project", "test-project");
      // Cleanup
      fs2.rmSync(locDir, { recursive: true, force: true });
    });
  });

  describe("genorch_project_docs_list", () => {
    it("should list project docs", async () => {
      await setup();
      const r = await unwrap(api.tools.get("genorch_project_docs_list")!("", { project: "test-project" }));
      expect(r).toHaveProperty("project", "test-project");
      expect(r).toHaveProperty("doc_count");
      expect(Array.isArray(r.docs)).toBe(true);
    });
  });
});
