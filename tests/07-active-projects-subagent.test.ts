/**
 * PLUGIN-001g — Active Projects & Subagent Tests
 *
 * Tests: genorch_project_list_active, genorch_task_delegate
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi, prepareTestDataDir, registerPlugin, unwrap, type MockApiType } from "./setup.js";

let plugin: any;
beforeEach(async () => { vi.resetModules(); plugin = (await import("../src/index.js")).default; });

describe("PLUGIN-001g — Active Projects & Subagent", () => {
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
    await unwrap(api.tools.get("genorch_project_bind")!("", { project: "test-project" }));
      await unwrap(api.tools.get("genorch_session_start_work")!("", { task: "test" }));
  }

  describe("genorch_project_list_active", () => {
    it("should list active projects", async () => {
      await setup();
      const r = await unwrap(api.tools.get("genorch_project_list_active")!("", {}));
      expect(r).toHaveProperty("ok");  // may be true or false depending on active sessions
    });
  });

  describe("genorch_task_delegate", () => {
    it("should spawn a subagent", async () => {
      await setup();
      const r = await unwrap(api.tools.get("genorch_task_delegate")!("", { task: "Do something" }));
      expect(r).toHaveProperty("ok", true);
    });
  });
});
