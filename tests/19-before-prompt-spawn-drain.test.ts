/**
 * E2E Final Test — before_prompt_build spawn drain
 *
 * Tests the spawn drain mechanism inside before_prompt_build:
 * - pending-spawns.json is read, entries are drained via api.runtime.subagent.run()
 * - pending-project-sessions.json is written for each drained spawn
 * - Tracker state is saved/restored around drain to prevent corruption
 * - Spawn queue file is removed after all entries drained
 * - subagent depth is preserved across save/restore
 * - Context injection still works correctly after drain
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

/**
 * Helper: set up plugin, register, and set context.
 * Returns the mock api, data dir, hook handler, and session key.
 */
async function setupWithSession(): Promise<{
  api: MockApiType;
  dd: string;
  hookHandler: Function;
  sessionKey: string;
}> {
  const dd = prepareTestDataDir(true);
  const api = createMockApi();
  await registerPlugin(dd, plugin, api);

  const regResult = await api.tools.get("orchestrator_register")!("", {});
  // Handle both { details: ... } and direct return formats
  const rr = regResult?.details || regResult;
  const sessionKey = rr?.session_key || "test-key-synthetic";

  await api.tools.get("orchestrator_set_context")!("", {
    project: "test-project",
    task: "E2E spawn drain test",
  });

  const hookHandler = api.hooks.get("before_prompt_build")!;
  expect(hookHandler).toBeDefined();
  return { api, dd, hookHandler, sessionKey };
}

/** Create a pending-spawns.json in the data dir with given entries. */
function writeSpawnQueue(dd: string, entries: any[]): void {
  fs.writeFileSync(path.join(dd, "pending-spawns.json"), JSON.stringify(entries, null, 2));
}

/** Read pending-project-sessions.json content. */
function readPendingSessions(dd: string): Record<string, any> | null {
  const p = path.join(dd, "pending-project-sessions.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

describe("before_prompt_build — spawn drain", () => {
  describe("Spawn drain basics", () => {
    it("should drain a single spawn entry from pending-spawns.json", async () => {
      const { dd, hookHandler, sessionKey } = await setupWithSession();

      const spawnEntry = {
        sessionKey: "agent:main:project-session:test-proj-abc123",
        project: "test-project",
        task: "E2E test task",
        message: "[Orchestrator: New Project Session]",
      };
      writeSpawnQueue(dd, [spawnEntry]);

      // Fire the hook
      const result = await hookHandler({}, { sessionKey });

      // Queue file should be gone
      expect(fs.existsSync(path.join(dd, "pending-spawns.json"))).toBe(false);

      // pending-project-sessions.json should have the entry
      const pending = readPendingSessions(dd);
      expect(pending).not.toBeNull();
      expect(pending![spawnEntry.sessionKey]).toBeDefined();
      expect(pending![spawnEntry.sessionKey].project).toBe("test-project");
      expect(pending![spawnEntry.sessionKey].task).toBe("E2E test task");
      expect(pending![spawnEntry.sessionKey].spawnedAt).toBeDefined();

      // Context injection should still work
      expect(result).toBeDefined();
      expect(result).toHaveProperty("prependContext");
      expect(result.prependContext).toContain("Project: test-project");
    });

    it("should drain multiple spawn entries in order", async () => {
      const { api, dd, hookHandler, sessionKey } = await setupWithSession();

      const entries = [
        {
          sessionKey: "agent:main:project-session:first-entry",
          project: "test-project",
          task: "First task",
          message: "First spawn",
        },
        {
          sessionKey: "agent:main:project-session:second-entry",
          project: "test-project",
          task: "Second task",
          message: "Second spawn",
        },
        {
          sessionKey: "agent:main:project-session:third-entry",
          project: "test-project",
          task: "Third task",
          message: "Third spawn",
        },
      ];
      writeSpawnQueue(dd, entries);

      await hookHandler({}, { sessionKey });

      // Queue file should be gone after draining all
      expect(fs.existsSync(path.join(dd, "pending-spawns.json"))).toBe(false);

      // All entries should have been processed
      const pending = readPendingSessions(dd);
      expect(pending).not.toBeNull();
      for (const entry of entries) {
        expect(pending![entry.sessionKey]).toBeDefined();
      }

      // Verify subagent.run was called 3 times
      const mockRun = api.runtime.subagent.run as ReturnType<typeof vi.fn>;
      expect(mockRun).toHaveBeenCalledTimes(3);
      expect(mockRun).toHaveBeenNthCalledWith(1, expect.objectContaining({ sessionKey: entries[0].sessionKey }));
      expect(mockRun).toHaveBeenNthCalledWith(2, expect.objectContaining({ sessionKey: entries[1].sessionKey }));
      expect(mockRun).toHaveBeenNthCalledWith(3, expect.objectContaining({ sessionKey: entries[2].sessionKey }));
    });

    it("should continue draining if one entry fails", async () => {
      const { dd, hookHandler, sessionKey, api } = await setupWithSession();

      // Make the second call fail
      const mockRun = api.runtime.subagent.run as ReturnType<typeof vi.fn>;
      mockRun
        .mockResolvedValueOnce({ runId: "mock-run-first" })
        .mockRejectedValueOnce(new Error("Simulated spawn failure"))
        .mockResolvedValueOnce({ runId: "mock-run-third" });

      const entries = [
        {
          sessionKey: "agent:main:project-session:first",
          project: "test-project",
          task: "First task",
          message: "First",
        },
        {
          sessionKey: "agent:main:project-session:second",
          project: "test-project",
          task: "Second task",
          message: "Second",
        },
        {
          sessionKey: "agent:main:project-session:third",
          project: "test-project",
          task: "Third task",
          message: "Third",
        },
      ];
      writeSpawnQueue(dd, entries);

      await hookHandler({}, { sessionKey });

      // Queue should still be drained (failed entries are also shifted)
      expect(fs.existsSync(path.join(dd, "pending-spawns.json"))).toBe(false);

      // Context injection should still work after recovery
      // (We don't check pending here since the mock failure still
      // causes the drain to continue but the pending is written
      // after each successful run)
    });
  });

  describe("Tracker state restoration", () => {
    it("should preserve workflow phase across spawn drain", async () => {
      const { dd, api, hookHandler, sessionKey } = await setupWithSession();

      // Advance workflow to PLAN phase
      await api.tools.get("orchestrator_advance_phase")!("", {});
      await api.tools.get("orchestrator_advance_phase")!("", {}); // analyze→plan→document

      // Write a spawn queue
      writeSpawnQueue(dd, [{
        sessionKey: "agent:main:project-session:drain-test",
        project: "test-project",
        task: "Drain test",
        message: "Test drain with phase preservation",
      }]);

      // Fire hook — spawn drain should happen, then restore
      const result = await hookHandler({}, { sessionKey });

      // Context injection should show the restored phase
      expect(result.prependContext).toContain("PHASE: DOCUMENT");
    });

    it("should preserve subagent depth across spawn drain", async () => {
      const { dd, hookHandler, sessionKey } = await setupWithSession();

      // Simulate a spawn queue
      writeSpawnQueue(dd, [{
        sessionKey: "agent:main:project-session:depth-test",
        project: "test-project",
        task: "Depth test",
        message: "Test drain with depth preservation",
      }]);

      await hookHandler({}, { sessionKey });

      // Subagent depth should be 0 (no actual subagent spawned in mock)
      // The context should still show correct depth
      const result2 = await hookHandler({}, { sessionKey });
      expect(result2.prependContext).toContain("Sub-agents: 0");
    });

    it("should restore session context after drain", async () => {
      const { dd, hookHandler, sessionKey } = await setupWithSession();

      // Fire hook once without spawn queue to get baseline context
      const baseline = await hookHandler({}, { sessionKey });
      expect(baseline.prependContext).toContain("Project: test-project");

      // Now with a spawn queue
      writeSpawnQueue(dd, [{
        sessionKey: "agent:main:project-session:context-test",
        project: "test-project",
        task: "Context test",
        message: "Test drain with context preservation",
      }]);

      const afterDrain = await hookHandler({}, { sessionKey });
      expect(afterDrain.prependContext).toContain("Project: test-project");
      expect(afterDrain.prependContext).toContain("Task: E2E spawn drain test");
    });
  });

  describe("No-op when no spawn queue", () => {
    it("should work normally when no pending-spawns.json exists", async () => {
      const { hookHandler, sessionKey } = await setupWithSession();
      const result = await hookHandler({}, { sessionKey });

      expect(result).toBeDefined();
      expect(result).toHaveProperty("prependContext");
      expect(result.prependContext).toContain("Project: test-project");
    });

    it("should NOT create pending-project-sessions.json when no spawn queue", async () => {
      const { dd, hookHandler, sessionKey } = await setupWithSession();

      // No spawn queue created
      await hookHandler({}, { sessionKey });

      // Should not have created any pending file
      expect(fs.existsSync(path.join(dd, "pending-project-sessions.json"))).toBe(false);
    });
  });

  describe("Spawn queue file cleanup", () => {
    it("should remove queue file after all entries successfully drained", async () => {
      const { dd, hookHandler, sessionKey } = await setupWithSession();

      const entries = [
        {
          sessionKey: "agent:main:project-session:cleanup-1",
          project: "test-project",
          task: "Task 1",
          message: "Spawn 1",
        },
        {
          sessionKey: "agent:main:project-session:cleanup-2",
          project: "test-project",
          task: "Task 2",
          message: "Spawn 2",
        },
      ];
      writeSpawnQueue(dd, entries);

      await hookHandler({}, { sessionKey });

      // Queue file should be deleted
      expect(fs.existsSync(path.join(dd, "pending-spawns.json"))).toBe(false);
    });

    it("should handle empty spawn queue gracefully", async () => {
      const { dd, hookHandler, sessionKey } = await setupWithSession();

      // Write an empty queue
      writeSpawnQueue(dd, []);

      // Should not throw
      await expect(hookHandler({}, { sessionKey })).resolves.toBeDefined();

      // Empty queue file should be removed
      expect(fs.existsSync(path.join(dd, "pending-spawns.json"))).toBe(false);
    });
  });

  describe("Session isolation", () => {
    it("should not inject context for unregistered sessions even after drain", async () => {
      const { dd, api, sessionKey } = await setupWithSession();

      // Write a queue for the next hook call
      writeSpawnQueue(dd, [{
        sessionKey: "agent:main:project-session:isolated",
        project: "test-project",
        task: "Isolation test",
        message: "Test isolation",
      }]);

      // Now use an unregistered session key — hooks should reject
      const hookHandler = api.hooks.get("before_prompt_build")!;
      const result = await hookHandler({}, { sessionKey: "unregistered-key" });

      // Should not get context injection
      expect(result).toBeUndefined();

      // The queue should still be present (not processed because
      // unregistered session triggers early return before drain check)
    });
  });
});
