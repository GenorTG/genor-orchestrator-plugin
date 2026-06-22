/**
 * PLUGIN-002e — Backlog Dispatch All Tests
 *
 * Tests genorch_backlog_dispatch_all for parallel task dispatching
 * with dependency resolution and label filtering.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi, prepareTestDataDir, registerPlugin, unwrap, type MockApiType } from "./setup.js";

let plugin: any;
beforeEach(async () => { vi.resetModules(); plugin = (await import("../src/index.js")).default; });

describe("PLUGIN-002e — Backlog Dispatch All", () => {
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

  describe("genorch_backlog_dispatch_all", () => {
    it("should dispatch available tasks", async () => {
      await setup();
      await unwrap(api.tools.get("genorch_backlog_add")!("", { project: "test-project", title: "Task 1" }));
      await unwrap(api.tools.get("genorch_backlog_add")!("", { project: "test-project", title: "Task 2" }));
      const r = await unwrap(api.tools.get("genorch_backlog_dispatch_all")!("", { project: "test-project" }));
      expect(r).toHaveProperty("ok", true);
    });
  });
});
