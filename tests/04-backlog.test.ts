/**
 * PLUGIN-001d — Backlog Tests
 *
 * Tests: orchestrator_backlog_add, orchestrator_backlog_list,
 * orchestrator_backlog_update, orchestrator_backlog_dispatch
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
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
describe("PLUGIN-001d — Backlog", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
    // Ensure test-project exists
    fs.mkdirSync(path.join(dd, "projects", "test-project"), { recursive: true });
    api.tools.get("orchestrator_register")!("", {});
    api.tools.get("orchestrator_set_context")!("", {
      project: "test-project",
      task: "backlog testing",
    });
  });
  // ── orchestrator_backlog_add ──────────────────────────────
  describe("orchestrator_backlog_add", () => {
    it("should add a task to the backlog", async () => {
      const exec = api.tools.get("orchestrator_backlog_add")!;
      const result = await unwrap(
        exec("", {
          project: "test-project",
          title: "Implement login feature",
        }),
      );
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("id");
      expect(result.id).toMatch(/^task_/);
    });
    it("should persist the task to BACKLOG.json", async () => {
      const exec = api.tools.get("orchestrator_backlog_add")!;
      await unwrap(
        exec("", {
          project: "test-project",
          title: "Persistent task",
        }),
      );
      const bp = path.join(dd, "projects", "test-project", "BACKLOG.json");
      expect(fs.existsSync(bp)).toBe(true);
      const raw = JSON.parse(fs.readFileSync(bp, "utf-8"));
      expect(raw.tasks.length).toBe(1);
      expect(raw.tasks[0].title).toBe("Persistent task");
    });
    it("should support priority, description, labels", async () => {
      const exec = api.tools.get("orchestrator_backlog_add")!;
      const result = await unwrap(
        exec("", {
          project: "test-project",
          title: "High priority task",
          description: "This is urgent",
          priority: "p0",
          labels: ["urgent", "security"],
        }),
      );
      expect(result).toHaveProperty("ok", true);
      // Verify via list
      const listExec = api.tools.get("orchestrator_backlog_list")!;
      const list = await unwrap(
        listExec("", { project: "test-project" }),
      );
      const added = list.tasks.find((t: any) => t.id === result.id);
      expect(added).toBeDefined();
      expect(added.priority).toBe("p0");
      expect(added.labels).toEqual(["urgent", "security"]);
      expect(added.description).toBe("This is urgent");
    });
    it("should default priority to p2 when invalid", async () => {
      const exec = api.tools.get("orchestrator_backlog_add")!;
      const result = await unwrap(
        exec("", {
          project: "test-project",
          title: "Invalid priority task",
          priority: "invalid",
        }),
      );
      // Verify via list
      const listExec = api.tools.get("orchestrator_backlog_list")!;
      const list = await unwrap(
        listExec("", { project: "test-project" }),
      );
      const task = list.tasks.find((t: any) => t.id === result.id);
      expect(task.priority).toBe("p2");
    });
  });
  // ── orchestrator_backlog_list ────────────────────────────
  describe("orchestrator_backlog_list", () => {
    it("should list all tasks by default", async () => {
      // Add a few tasks
      const addExec = api.tools.get("orchestrator_backlog_add")!;
      addExec("", { project: "test-project", title: "Task 1" });
      addExec("", { project: "test-project", title: "Task 2" });
      const exec = api.tools.get("orchestrator_backlog_list")!;
      const result = await unwrap(
        exec("", { project: "test-project" }),
      );
      expect(result).toHaveProperty("ok", true);
      expect(result.tasks.length).toBe(2);
    });
    it("should filter by status", async () => {
      const addExec = api.tools.get("orchestrator_backlog_add")!;
      await addExec("", { project: "test-project", title: "Todo task" });
      const doneTask = await addExec("", {
        project: "test-project",
        title: "Done task",
      });
      // Mark one as done
      const updateExec = api.tools.get("orchestrator_backlog_update")!;
      await updateExec("", {
        project: "test-project",
        id: doneTask.id,
        status: "done",
      });
      const listExec = api.tools.get("orchestrator_backlog_list")!;
      const doneList = await unwrap(
        listExec("", { project: "test-project", status: "done" }),
      );
      expect(doneList.tasks.every((t: any) => t.status === "done")).toBe(true);
    });
    it("should filter by priority", async () => {
      const addExec = api.tools.get("orchestrator_backlog_add")!;
      addExec("", {
        project: "test-project",
        title: "P0 task",
        priority: "p0",
      });
      addExec("", {
        project: "test-project",
        title: "P2 task",
        priority: "p2",
      });
      const listExec = api.tools.get("orchestrator_backlog_list")!;
      const p0List = await unwrap(
        listExec("", { project: "test-project", priority: "p0" }),
      );
      expect(p0List.tasks.every((t: any) => t.priority === "p0")).toBe(true);
    });
    it("should filter by label", async () => {
      const addExec = api.tools.get("orchestrator_backlog_add")!;
      addExec("", {
        project: "test-project",
        title: "Bug fix",
        labels: ["bug"],
      });
      addExec("", {
        project: "test-project",
        title: "Feature",
        labels: ["feature"],
      });
      const listExec = api.tools.get("orchestrator_backlog_list")!;
      const result = await unwrap(
        listExec("", { project: "test-project", label: "bug" }),
      );
      expect(result.tasks.length).toBe(1);
      expect(result.tasks[0].title).toBe("Bug fix");
    });
    it("should return empty array for project with no backlog", async () => {
      const exec = api.tools.get("orchestrator_backlog_list")!;
      const result = await unwrap(
        exec("", { project: "free-project" }),
      );
      expect(result).toHaveProperty("ok", true);
      expect(result.tasks).toEqual([]);
    });
  });
  // ── orchestrator_backlog_update ─────────────────────────
  describe("orchestrator_backlog_update", () => {
    it("should update task status", async () => {
      const addExec = api.tools.get("orchestrator_backlog_add")!;
      const added = await unwrap(
        addExec("", { project: "test-project", title: "Update me" }),
      );
      const updateExec = api.tools.get("orchestrator_backlog_update")!;
      const updResult = await unwrap(
        updateExec("", {
          project: "test-project",
          id: added.id,
          status: "in_progress",
        }),
      );
      expect(updResult).toHaveProperty("ok", true);
      const listExec = api.tools.get("orchestrator_backlog_list")!;
      const list = await unwrap(
        listExec("", { project: "test-project" }),
      );
      const task = list.tasks.find((t: any) => t.id === added.id);
      expect(task.status).toBe("in_progress");
    });
    it("should return error for unknown task id", async () => {
      const updateExec = api.tools.get("orchestrator_backlog_update")!;
      const result = await unwrap(
        updateExec("", {
          project: "test-project",
          id: "non_existent_id",
          status: "done",
        }),
      );
      expect(result).toHaveProperty("ok", false);
      expect(result).toHaveProperty("error");
    });
    it("should update priority and labels", async () => {
      const addExec = api.tools.get("orchestrator_backlog_add")!;
      const added = await unwrap(
        addExec("", {
          project: "test-project",
          title: "Multi update",
          priority: "p3",
        }),
      );
      const updateExec = api.tools.get("orchestrator_backlog_update")!;
      updateExec("", {
        project: "test-project",
        id: added.id,
        priority: "p1",
        labels: ["refactored"],
      });
      const listExec = api.tools.get("orchestrator_backlog_list")!;
      const list = await unwrap(
        listExec("", { project: "test-project" }),
      );
      const task = list.tasks.find((t: any) => t.id === added.id);
      expect(task.priority).toBe("p1");
      expect(task.labels).toEqual(["refactored"]);
    });
  });
  // ── orchestrator_backlog_dispatch ───────────────────────
  describe("orchestrator_backlog_dispatch", () => {
    it("should pick highest priority available task", async () => {
      const addExec = api.tools.get("orchestrator_backlog_add")!;
      addExec("", {
        project: "test-project",
        title: "Low priority",
        priority: "p3",
      });
      addExec("", {
        project: "test-project",
        title: "High priority",
        priority: "p0",
      });
      const exec = api.tools.get("orchestrator_backlog_dispatch")!;
      const result = await unwrap(
        exec("", { project: "test-project" }),
      );
      expect(result).toHaveProperty("ok", true);
      expect(result.title).toBe("High priority");
    });
    it("should filter by label with filter_labels", async () => {
      const addExec = api.tools.get("orchestrator_backlog_add")!;
      addExec("", {
        project: "test-project",
        title: "Bug",
        priority: "p1",
        labels: ["bug"],
      });
      addExec("", {
        project: "test-project",
        title: "Feature",
        priority: "p1",
        labels: ["feature"],
      });
      const exec = api.tools.get("orchestrator_backlog_dispatch")!;
      const result = await unwrap(
        exec("", {
          project: "test-project",
          filter_labels: "bug",
        }),
      );
      expect(result).toHaveProperty("ok", true);
      expect(result.title).toBe("Bug");
    });
    it("should respect dependency ordering", async () => {
      const addExec = api.tools.get("orchestrator_backlog_add")!;
      const dep = await unwrap(
        addExec("", {
          project: "test-project",
          title: "Dependency",
          priority: "p0",
        }),
      );
      const blocker = await unwrap(
        addExec("", {
          project: "test-project",
          title: "Blocked task",
          priority: "p0",
          depends_on: [dep.id],
        }),
      );
      // The blocked task should not be dispatchable since dep isn't done
      const exec = api.tools.get("orchestrator_backlog_dispatch")!;
      const result = await unwrap(
        exec("", { project: "test-project" }),
      );
      // Should pick dependency (not blocked task)
      expect(result.title).toBe("Dependency");
    });
  });
});
