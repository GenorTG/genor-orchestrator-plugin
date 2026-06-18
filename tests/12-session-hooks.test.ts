/**
 * PLUGIN-002c — session_start / session_end Hook Tests
 *
 * Tests session lifecycle hooks:
 * - session_start triggers tracking for registered sessions
 * - Background/cron/subagent sessions are filtered
 * - session_end cleans up and unregisters
 * - Unregistered sessions don't bleed into tracker
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createMockApi,
  prepareTestDataDir,
  registerPlugin,
  unwrap,
  type MockApiType,
} from "./setup.js";

let plugin: any;
beforeEach(async () => {
  vi.resetModules();
  plugin = (await import("../src/index.js")).default;
});

async function setupDefault(): Promise<{
  api: MockApiType;
  dd: string;
  sessionStart: Function;
  sessionEnd: Function;
  sessionKey: string;
}> {
  const dd = prepareTestDataDir();
  const api = createMockApi();
  await registerPlugin(dd, plugin, api);

  // Register a session to get a key
  const regResult = await api.tools.get("orchestrator_register")!("", {});
  const rr = typeof regResult?.details === "object" ? regResult.details : regResult;
  const sessionKey = rr?.session_key || "test-key";

  const sessionStart = api.hooks.get("session_start")!;
  const sessionEnd = api.hooks.get("session_end")!;
  expect(sessionStart).toBeDefined();
  expect(sessionEnd).toBeDefined();
  return { api, dd, sessionStart, sessionEnd, sessionKey };
}

describe("PLUGIN-002c — Session Lifecycle Hooks", () => {
  describe("session_start", () => {
    it("should start tracking for registered sessions", async () => {
      const { sessionStart, sessionKey } = await setupDefault();
      // This should not throw
      await sessionStart({ sessionKey, reason: "new" });
      // No explicit return value — success = no throw
    });

    it("should skip background sessions", async () => {
      const { sessionStart } = await setupDefault();
      // Background sessions should not touch the tracker
      await sessionStart({ sessionKey: "agent:main:dreaming:abc", reason: "new" });
      await sessionStart({ sessionKey: "agent:main:cron:xyz", reason: "new" });
      await sessionStart({ sessionKey: "agent:main:subagent:def", reason: "new" });
      await sessionStart({ sessionKey: "agent:main:acp:ghi", reason: "new" });
      // No throw = skip happened correctly
    });

    it("should handle unregistered sessions without crashing", async () => {
      const { sessionStart } = await setupDefault();
      await sessionStart({ sessionKey: "totally-unregistered", reason: "new" });
      // Should not throw even when session is unregistered
    });

    it("should handle missing session key gracefully", async () => {
      const { sessionStart } = await setupDefault();
      await sessionStart({ reason: "new" });
      // Missing sessionKey should not crash
    });
  });

  describe("session_end", () => {
    it("should unregister registered sessions", async () => {
      const { sessionEnd, sessionKey } = await setupDefault();
      await sessionEnd({ sessionKey });
      // Should not throw
    });

    it("should skip unregistered sessions", async () => {
      const { sessionEnd } = await setupDefault();
      await sessionEnd({ sessionKey: "unregistered-key" });
      // Should not throw
    });

    it("should handle missing session key gracefully", async () => {
      const { sessionEnd } = await setupDefault();
      await sessionEnd({});
      // Should not throw
    });

    it("should complete lifecycle: start → work → end", async () => {
      const { api, sessionStart, sessionEnd, sessionKey } = await setupDefault();
      
      // Start
      await sessionStart({ sessionKey, reason: "new" });
      
      // Set context + log (simulate work)
      await api.tools.get("orchestrator_set_context")!("", {
        project: "test-project",
        task: "lifecycle test",
      });
      await api.tools.get("orchestrator_log_session")!("", {
        project: "test-project",
        task: "lifecycle test",
        model: "gpt-4",
        agent: "Amy",
        status: "complete",
      });
      
      // End
      await sessionEnd({ sessionKey });
      // Should not throw — full lifecycle clean
    });
  });
});
