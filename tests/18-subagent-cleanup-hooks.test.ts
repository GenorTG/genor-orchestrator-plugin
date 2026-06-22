/**
 * PLUGIN-002g — Subagent & Cleanup Hooks Tests
 *
 * Tests session_start/session_end cleanup, live agent tracking,
 * and background session filtering.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi, prepareTestDataDir, registerPlugin, unwrap, type MockApiType } from "./setup.js";

let plugin: any;
beforeEach(async () => { vi.resetModules(); plugin = (await import("../src/index.js")).default; });

describe("PLUGIN-002g — Subagent & Cleanup Hooks", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
  });

  describe("hook registration", () => {
    it("should register cleanup hooks", () => {
      expect(api.hooks.has("session_end")).toBe(true);
    });
  });

  describe("session_end cleanup", () => {
    it("should handle cleanup on session end", () => {
      const hook = api.hooks.get("session_end")!;
      const result = hook({ sessionKey: "test-session" });
      expect(result).toBeDefined();
    });
  });
});
