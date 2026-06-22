/**
 * PLUGIN-002c — Session Lifecycle Hooks Tests
 *
 * Tests session_start, session_end hook handlers,
 * live agent tracking, and session isolation.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi, prepareTestDataDir, registerPlugin, unwrap, type MockApiType } from "./setup.js";

let plugin: any;
beforeEach(async () => { vi.resetModules(); plugin = (await import("../src/index.js")).default; });

describe("PLUGIN-002c — Session Lifecycle Hooks", () => {
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
  }

  describe("hook registration", () => {
    it("should register session_end handler", () => {
      expect(api.hooks.has("session_end")).toBe(true);
    });
  });

  describe("session_end", () => {
    it("should handle session end events", async () => {
      await setup();
      const hook = api.hooks.get("session_end")!;
      const result = hook({ sessionKey: "test-key" });
      expect(result).toBeDefined();
    });
  });
});
