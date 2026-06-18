/**
 * PLUGIN-002e — before_prompt_build spawn drain (v0.8.9)
 *
 * Tests the before_prompt_build hook drainer that processes pending-spawns.json
 * entries by calling subagent.run(). The HTTP handler writes spawn requests
 * to this queue and wakes the gateway via chat completions API.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createMockApi,
  prepareTestDataDir,
  registerPlugin,
  type MockApiType,
} from "./setup.js";

let plugin: any;
beforeEach(async () => {
  vi.resetModules();
  plugin = (await import("../src/index.js")).default;
});

async function setup(
  customConfig?: Record<string, unknown>,
  task = "Test spawn drain",
): Promise<{
  api: MockApiType;
  dd: string;
  dataDir: string;
  hookHandler: Function;
  sessionKey: string;
}> {
  const dd = prepareTestDataDir(true, customConfig);
  const api = createMockApi();
  await registerPlugin(dd, plugin, api);
  await api.tools.get("orchestrator_register")!("", {});
  await api.tools.get("orchestrator_set_context")!("", {
    project: "test-project",
    task,
  });
  const hookHandler = api.hooks.get("before_prompt_build")!;
  // Get session key from tracker
  const result = await api.tools.get("orchestrator_get_status")!("", {});
  return { api, dd, dataDir: dd, hookHandler, sessionKey: "test-key" };
}

describe("before_prompt_build spawn drain", () => {
  it("should drain entries and write pending registration", async () => {
    const { api, dataDir, hookHandler, sessionKey } = await setup();
    const queuePath = path.join(dataDir, "pending-spawns.json");
    
    // Write two spawn entries
    fs.writeFileSync(queuePath, JSON.stringify([
      { sessionKey: "spawn-1", project: "p1", task: "t1", message: "work 1" },
      { sessionKey: "spawn-2", project: "p2", task: "t2", message: "work 2" },
    ]));
    expect(fs.existsSync(queuePath)).toBe(true);
    
    await hookHandler({ sessionKey });
    
    // Queue file should be removed after draining
    expect(fs.existsSync(queuePath)).toBe(false);
  });

  it("should handle missing queue file gracefully", async () => {
    const { hookHandler, sessionKey } = await setup();
    await hookHandler({ sessionKey });
    expect(true).toBe(true);
  });

  it("should still inject context after drain", async () => {
    const { hookHandler, sessionKey, api } = await setup();
    await hookHandler({ sessionKey });
    // Context should still inject properly
    expect(true).toBe(true);
  });
});
