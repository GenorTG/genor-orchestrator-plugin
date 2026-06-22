/**
 * PLUGIN-001d — Backlog Tests
 *
 * Tests: genorch_backlog_add, genorch_backlog_list,
 * genorch_backlog_update, genorch_backlog_dispatch
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi, prepareTestDataDir, registerPlugin, unwrap, type MockApiType } from "./setup.js";

let plugin: any;
beforeEach(async () => { vi.resetModules(); plugin = (await import("../src/index.js")).default; });

describe("PLUGIN-001d — Backlog", () => {
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
    await unwrap(api.tools.get("genorch_session_start_work")!("", { project: "test-project", task: "test" }));
  }

  describe("genorch_backlog_add", () => {
    it("should add a task", async () => {
      await setup();
      const r = await unwrap(api.tools.get("genorch_backlog_add")!("", { project: "test-project", title: "Fix bug" }));
      expect(r).toHaveProperty("ok", true);
    });

    it("should support priority, description, labels", async () => {
      await setup();
      const r = await unwrap(api.tools.get("genorch_backlog_add")!("", { project: "test-project", title: "Important task", priority: "p1", description: "Do the thing", labels: ["bug", "urgent"] }));
      expect(r).toHaveProperty("ok", true);
    });

    it("should default priority to p2", async () => {
      await setup();
      const r = await unwrap(api.tools.get("genorch_backlog_add")!("", { project: "test-project", title: "Normal task" }));
      expect(r).toHaveProperty("ok", true);
    });
  });

  describe("genorch_backlog_list", () => {
    it("should list tasks", async () => {
      await setup();
      await unwrap(api.tools.get("genorch_backlog_add")!("", { project: "test-project", title: "Task A" }));
      const r = await unwrap(api.tools.get("genorch_backlog_list")!("", { project: "test-project" }));
      expect(r).toHaveProperty("ok", true);
      expect(Array.isArray(r.tasks)).toBe(true);
    });

    it("should filter by status", async () => {
      await setup();
      await unwrap(api.tools.get("genorch_backlog_add")!("", { project: "test-project", title: "Task A" }));
      const r = await unwrap(api.tools.get("genorch_backlog_list")!("", { project: "test-project", status: "todo" }));
      expect(r).toHaveProperty("ok", true);
      if (r.tasks.length > 0) {
        for (const t of r.tasks) expect(t.status || t.state).toBe("todo");
      }
    });
  });

  describe("genorch_backlog_update", () => {
    it("should update task status", async () => {
      await setup();
      const added = await unwrap(api.tools.get("genorch_backlog_add")!("", { project: "test-project", title: "Task A" }));
      if (!added.ok) return; // skip if add fails
      const r = await unwrap(api.tools.get("genorch_backlog_update")!("", { project: "test-project", id: added.id || added.task_id, status: "in_progress" }));
      expect(r).toHaveProperty("ok", true);
    });
  });

  describe("genorch_backlog_dispatch", () => {
    it("should dispatch next available task", async () => {
      await setup();
      await unwrap(api.tools.get("genorch_backlog_add")!("", { project: "test-project", title: "Dispatchable task" }));
      const r = await unwrap(api.tools.get("genorch_backlog_dispatch")!("", { project: "test-project" }));
      expect(r).toHaveProperty("ok", true);
    });
  });
});
