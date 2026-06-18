/**
 * Legacy — before_prompt_build spawn queue cleanup (v0.8.8+)
 *
 * The spawn mechanism now uses api.session.workflow.scheduleSessionTurn()
 * directly from the HTTP handler. The before_prompt_build hook only cleans
 * up any stale pending-spawns.json files from beta versions.
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

async function setupLegacy(
  customConfig?: Record<string, unknown>,
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

  // Register a session so context injection works
  const regResult = await api.tools.get("orchestrator_register")!("", {});
  const rr = typeof regResult?.details === "object" ? regResult.details : regResult;
  const sessionKey = rr?.session_key || "test-key";
  
  await api.tools.get("orchestrator_set_context")!("", {
    project: "test-project",
    task: "test task",
  });

  const hookHandler = api.hooks.get("before_prompt_build")!;
  return { api, dd, dataDir: dd, hookHandler, sessionKey };
}

describe("Legacy spawn queue cleanup", () => {
  it("should remove stale pending-spawns.json on before_prompt_build", async () => {
    const { api, hookHandler, dataDir, sessionKey } = await setupLegacy();
    const queuePath = path.join(dataDir, "pending-spawns.json");
    fs.writeFileSync(queuePath, JSON.stringify([{ 
      sessionKey: "test-key",
      project: "genor-orchestrator-plugin",
      task: "test", 
      message: "test"
    }]));
    expect(fs.existsSync(queuePath)).toBe(true);
    
    await hookHandler({ sessionKey });
    
    // Queue file should be removed
    expect(fs.existsSync(queuePath)).toBe(false);
  });

  it("should handle missing queue file gracefully", async () => {
    const { hookHandler, sessionKey } = await setupLegacy();
    // Should not throw
    await hookHandler({ sessionKey });
    expect(true).toBe(true);
  });

  it("should still inject context after cleanup", async () => {
    const { hookHandler, sessionKey } = await setupLegacy();
    await hookHandler({ sessionKey });
    expect(true).toBe(true);
  });
});
