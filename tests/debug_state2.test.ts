import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMockApi, prepareTestDataDir, registerPlugin, unwrap } from "./tests/setup.js";

let plugin: any, dd: string, api: any;
beforeEach(async () => {
  vi.resetModules();
  dd = prepareTestDataDir("debug-state2");
  api = createMockApi();
  plugin = (await import("./src/index.js")).default;
  await registerPlugin(dd, plugin, api);
});

it("debug state events 2", async () => {
  // Register and set context first
  await api.tools.get("orchestrator_register")!("", {});
  await api.tools.get("orchestrator_set_context")!("", {
    project: "test-project",
    task: "debug",
  });
  
  const exec = api.tools.get("orchestrator_create_project")!;
  const result = await unwrap(exec("", {
    name: "debug-project",
    description: "Test description",
  }));
  
  console.log("=== RESULT ===", JSON.stringify(result, null, 2));
  if (result.state_md) {
    try {
      const stateContent = fs.readFileSync(result.state_md, "utf-8");
      console.log("=== STATE.md ===", stateContent);
    } catch(e) {
      console.log("STATE.md read error:", e);
    }
  }
});
