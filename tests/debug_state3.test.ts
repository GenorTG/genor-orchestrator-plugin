import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMockApi, prepareTestDataDir, registerPlugin, unwrap } from "./tests/setup.js";

let plugin: any, dd: string, api: any;
beforeEach(async () => {
  vi.resetModules();
  dd = prepareTestDataDir("debug-state3");
  api = createMockApi();
  plugin = (await import("./src/index.js")).default;
  await registerPlugin(dd, plugin, api);
});

it("debug state events 3", async () => {
  // Register and set context
  await api.tools.get("genorch_session_register")!("", {});
  await api.tools.get("genorch_session_start_work")!("", {
    project: "test-project",
    task: "debug",
  });

  // Directly test the DB
  const { addStateEvent, getStateEvents, initDb } = await import("./src/db.js");
  
  console.log("=== DIRECT TEST ===");
  addStateEvent("test-proj", "project_created", { 
    type: "project_created", 
    description: "Test description",
    version: "0.0.1"
  });
  
  const events = getStateEvents("test-proj", 100);
  console.log("Events count:", events.length);
  console.log("Event data type:", typeof events[0]?.data);
  console.log("Event data:", events[0]?.data);
  
  // Now create project through the tool
  const exec = api.tools.get("genorch_project_create")!;
  const result = await unwrap(exec("", {
    name: "debug-project",
    description: "Test description 2",
  }));
  
  if (result.state_md) {
    const stateContent = fs.readFileSync(result.state_md, "utf-8");
    console.log("=== STATE.md ===", stateContent);
  }
  
  // Check state events again
  const events2 = getStateEvents("debug-project", 100);
  console.log("Events2 count:", events2.length);
  if (events2.length > 0) {
    console.log("Event2 data:", events2[0].data);
    const parsed = JSON.parse(events2[0].data);
    console.log("Parsed description:", parsed.description);
  }
});
