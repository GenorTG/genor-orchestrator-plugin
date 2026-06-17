/**
 * PLUGIN-001e — Project Management Tests
 *
 * Tests: orchestrator_create_project, orchestrator_sync_project,
 * orchestrator_get_project_docs
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
describe("PLUGIN-001e — Project Management", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
    api.tools.get("orchestrator_register")!("", {});
    api.tools.get("orchestrator_set_context")!("", {
      project: "test-project",
      task: "project mgmt test",
    });
  });
  // ── orchestrator_create_project ──────────────────────────
  describe("orchestrator_create_project", () => {
    it("should create a new project directory", async () => {
      const exec = api.tools.get("orchestrator_create_project")!;
      const result = await unwrap(
        exec("", {
          name: "new-project",
          description: "A new test project",
        }),
      );
      expect(result).toHaveProperty("ok", true);
      expect(result).toHaveProperty("project", "new-project");
      expect(result).toHaveProperty("state_md");
      expect(fs.existsSync(result.state_md)).toBe(true);
    });
    it("should create STATE.md with description", async () => {
      const exec = api.tools.get("orchestrator_create_project")!;
      const result = await unwrap(
        exec("", {
          name: "docs-project",
          description: "Documentation project",
        }),
      );
      const stateContent = fs.readFileSync(result.state_md, "utf-8");
      expect(stateContent).toContain("Documentation project");
      expect(stateContent).toContain("v0.0.1");
    });
    it("should add project to dashboard-config.json", async () => {
      const exec = api.tools.get("orchestrator_create_project")!;
      await unwrap(
        exec("", {
          name: "config-check",
          directory: "/tmp/config-check-loc",
        }),
      );
      const configPath = path.join(dd, "dashboard-config.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      expect(config.projects).toHaveProperty("config-check");
      expect(config.projects["config-check"].location).toBe(
        "/tmp/config-check-loc",
      );
    });
    it("should reject duplicate project names", async () => {
      const exec = api.tools.get("orchestrator_create_project")!;
      const result = await unwrap(
        exec("", { name: "test-project" }),
      );
      expect(result).toHaveProperty("ok", false);
      expect(result).toHaveProperty("error");
      expect(result.error).toContain("already exists");
    });
    it("should reject invalid project names", async () => {
      const exec = api.tools.get("orchestrator_create_project")!;
      const result = await unwrap(exec("", { name: "a" }));
      expect(result).toHaveProperty("ok", false);
    });
    it("should sanitize project name", async () => {
      const exec = api.tools.get("orchestrator_create_project")!;
      const result = await unwrap(
        exec("", { name: "Bad Name!@#" }),
      );
      expect(result).toHaveProperty("ok", true);
      expect(result.project).toMatch(/^bad-name/);
    });
  });
  // ── orchestrator_sync_project ────────────────────────────
  describe("orchestrator_sync_project", () => {
    it("should error if project has no location configured", async () => {
      const exec = api.tools.get("orchestrator_sync_project")!;
      const result = await unwrap(
        exec("", { project: "free-project" }),
      );
      expect(result).toHaveProperty("error");
    });
    it("should sync project with location and generate CONTEXT.md", async () => {
      // Write a location for test-project
      const configPath = path.join(dd, "dashboard-config.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      // Mock location exists
      const loc = path.join(dd, "sync-src");
      fs.mkdirSync(loc, { recursive: true });
      fs.writeFileSync(path.join(loc, "README.md"), "# Test Project");
      fs.writeFileSync(
        path.join(loc, "package.json"),
        JSON.stringify({ name: "test-project", version: "1.0.0" }),
      );
      config.projects["test-project"] = {
        location: loc,
        workflow: { enabled: false },
      };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      // Override execSync for find command to return specific files
      const childProcess = await import("node:child_process");
      (childProcess.execSync as any).mockImplementation((cmd: string) => {
        if (cmd.startsWith("find ")) {
          return `${loc}/README.md\n${loc}/package.json\n`;
        }
        if (cmd.startsWith("git")) return "";
        if (cmd.startsWith("hostname")) return "test-host\n";
        return "";
      });
      const exec = api.tools.get("orchestrator_sync_project")!;
      const result = await unwrap(
        exec("", { project: "test-project" }),
      );
      expect(result).toHaveProperty("ok", true);
      const contextPath = path.join(
        dd,
        "projects",
        "test-project",
        "CONTEXT.md",
      );
      expect(fs.existsSync(contextPath)).toBe(true);
      const context = fs.readFileSync(contextPath, "utf-8");
      expect(context).toContain("Test Project");
    });
  });
  // ── orchestrator_get_project_docs ────────────────────────
  describe("orchestrator_get_project_docs", () => {
    it("should list project documentation files", async () => {
      // Create a state file for test-project
      const projDir = path.join(dd, "projects", "test-project");
      if (!fs.existsSync(projDir))
        fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(projDir, "STATE.md"), "# TEST");
      fs.writeFileSync(path.join(projDir, "sessions.json"), "{}");
      const exec = api.tools.get("orchestrator_get_project_docs")!;
      const result = await unwrap(
        exec("", { project: "test-project" }),
      );
      expect(result).toHaveProperty("project", "test-project");
      expect(result).toHaveProperty("doc_count");
      expect(result.doc_count).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(result.docs)).toBe(true);
    });
    it("should include both .md and .json files", async () => {
      const projDir = path.join(dd, "projects", "test-project");
      if (!fs.existsSync(projDir))
        fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(projDir, "STATE.md"), "# Test");
      fs.writeFileSync(path.join(projDir, "CONTEXT.md"), "# Context");
      fs.writeFileSync(path.join(projDir, "BACKLOG.json"), "{}");
      const exec = api.tools.get("orchestrator_get_project_docs")!;
      const result = await unwrap(
        exec("", { project: "test-project" }),
      );
      const names = result.docs.map((d: string) => path.basename(d));
      expect(names).toContain("STATE.md");
      expect(names).toContain("BACKLOG.json");
      expect(names).toContain("CONTEXT.md");
    });
  });
});
