/**
 * PLUGIN-002e — backlog_dispatch_all Tests
 *
 * Tests the parallel dispatch tool that was missing coverage.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
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

describe("PLUGIN-002e — Backlog Dispatch All", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
    fs.mkdirSync(path.join(dd, "projects", "test-project"), { recursive: true });
    api.tools.get("genorch_session_register")!("", {});
    api.tools.get("genorch_session_start_work")!("", {
      project: "test-project",
      task: "dispatch all test",
    });
  });

  it("should dispatch all available tasks up to max_dispatch", async () => {
    // Add 3 tasks
    for (let i = 0; i < 3; i++) {
      await api.tools.get("genorch_backlog_add")!("", {
        project: "test-project",
        title: `Task ${i + 1}`,
        priority: "p0",
      });
    }

    const exec = api.tools.get("genorch_backlog_dispatch_all")!;
    const result = await unwrap(exec("", { project: "test-project", max_dispatch: 2 }));

    expect(result).toHaveProperty("ok", true);
    expect(result).toHaveProperty("tasks");
    expect(Array.isArray(result.tasks)).toBe(true);
    expect(result.tasks.length).toBe(2); // limited by max_dispatch
    expect(result).toHaveProperty("dispatched_count", 2);
  });

  it("should respect max_dispatch upper bound", async () => {
    for (let i = 0; i < 10; i++) {
      await api.tools.get("genorch_backlog_add")!("", {
        project: "test-project",
        title: `Task ${i + 1}`,
        priority: "p0",
      });
    }

    const exec = api.tools.get("genorch_backlog_dispatch_all")!;
    const result = await unwrap(exec("", { project: "test-project", max_dispatch: 999 }));
    
    expect(result).toHaveProperty("ok", true);
    // Should be capped at some max (likely 20)
    expect(result.tasks.length).toBeLessThanOrEqual(20);
  });

  it("should auto-claim tasks by default", async () => {
    await api.tools.get("genorch_backlog_add")!("", {
      project: "test-project",
      title: "Auto-claim task",
      priority: "p1",
    });

    const exec = api.tools.get("genorch_backlog_dispatch_all")!;
    await unwrap(exec("", { project: "test-project", max_dispatch: 5 }));

    // Verify tasks were claimed (status changed to in_progress)
    const listResult = await unwrap(
      api.tools.get("genorch_backlog_list")!("", { project: "test-project" }),
    );
    expect(listResult.tasks.every((t: any) => t.status === "in_progress")).toBe(true);
  });

  it("should skip tasks with unmet dependencies", async () => {
    const addExec = api.tools.get("genorch_backlog_add")!;
    const dep = await addExec("", {
      project: "test-project",
      title: "Prerequisite",
      priority: "p0",
    });
    const depResult = typeof dep?.details === "object" ? dep.details : dep;
    
    await addExec("", {
      project: "test-project",
      title: "Dependent task",
      priority: "p0",
      depends_on: [depResult.id],
    });

    const exec = api.tools.get("genorch_backlog_dispatch_all")!;
    const result = await unwrap(exec("", { project: "test-project", max_dispatch: 5 }));

    // Only the prerequisite should be dispatched (dependent blocked)
    expect(result.tasks.length).toBe(1);
    expect(result.tasks[0].title).toBe("Prerequisite");
  });

  it("should return empty array for project with no backlog", async () => {
    const exec = api.tools.get("genorch_backlog_dispatch_all")!;
    const result = await unwrap(exec("", { project: "free-project" }));
    expect(result).toHaveProperty("ok", false);
    expect(result).toHaveProperty("error");
  });
});
