import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMockApi, prepareTestDataDir, registerPlugin, unwrap } from "./tests/setup.js";

let plugin: any, dd: string, api: any;
beforeEach(async () => {
  vi.resetModules();
  dd = prepareTestDataDir("debug-state");
  api = createMockApi();
  plugin = (await import("./src/index.js")).default;
  await registerPlugin(dd, plugin, api);
});

it("debug state events", async () => {
  const exec = api.tools.get("orchestrator_create_project")!;
  const result = await unwrap(exec("", {
    name: "docs-project",
    description: "Documentation project",
  }));
  console.log("=== RESULT ===", JSON.stringify(result, null, 2));
  const stateContent = fs.readFileSync(result.state_md, "utf-8");
  console.log("=== STATE.md ===", stateContent);
});
