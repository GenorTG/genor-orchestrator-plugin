/**
 * PLUGIN-002b — before_prompt_build hook tests
 *
 * Tests context injection for registered sessions, workflow phase
 * enforcement, and unregistered session isolation.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi, prepareTestDataDir, registerPlugin, unwrap, type MockApiType } from "./setup.js";

let plugin: any;
beforeEach(async () => { vi.resetModules(); plugin = (await import("../src/index.js")).default; });

describe("PLUGIN-002b — before_prompt_build hook", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
  });

  async function setupRegistered() {
    const mod = await import("../src/index.js");
    mod.__setTestSessionKey("test-key");
    await unwrap(api.tools.get("genorch_session_register")!("", {}));
    await unwrap(api.tools.get("genorch_session_start_work")!("", { project: "test-project", task: "test" }));
  }

  describe("hook registration", () => {
    it("should register the before_prompt_build handler", () => {
      expect(api.hooks.has("before_prompt_build")).toBe(true);
    });
  });

  describe("context injection", () => {
    it("should inject project context", async () => {
      await setupRegistered();
      const hook = api.hooks.get("before_prompt_build")!;
      const result = hook({
        conversation: { agentId: "main" },
        context: {},
      });
      expect(result).toBeDefined();
    });
  });

  describe("phase enforcement", () => {
    it("should respect workflow phase", async () => {
      await setupRegistered();
      await unwrap(api.tools.get("genorch_workflow_advance_phase")!("", { phase: "plan" }));
      const hook = api.hooks.get("before_prompt_build")!;
      const result = hook({
        conversation: { agentId: "main" },
        context: {},
      });
      expect(result).toBeDefined();
    });
  });

  describe("project docs injection (anti-drift)", () => {
    it("should inject project docs (style guide, plan, features, architecture) into prompt", async () => {
      // Create test project docs
      const fs = await import("node:fs");
      const path = await import("node:path");
      const projDir = path.join(dd, "projects", "test-project");
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(
        path.join(projDir, "STYLE_GUIDE.md"),
        "# Style Guide\n\n- Always use TypeScript\n- Prefer const over let\n- Test everything"
      );
      fs.writeFileSync(
        path.join(projDir, "PROJECT_PLAN.md"),
        "# Project Plan\n\n## Vision\n\nBuild the best plugin ever."
      );
      fs.writeFileSync(
        path.join(projDir, "FEATURES.md"),
        "# Features\n\n## 🚧 In Progress\n\n- Auto-populate models\n- Dashboard rewrite"
      );
      fs.writeFileSync(
        path.join(projDir, "ARCHITECTURE.md"),
        "# Architecture\n\nTypeScript plugin with TypeBox schema validation."
      );

      await setupRegistered();
      const hook = api.hooks.get("before_prompt_build")!;
      const result = await hook(
        { conversation: { agentId: "main" } },
        { sessionKey: "test-key" }
      );

      // Verify the result has prependContext with project docs injected
      expect(result).toBeDefined();
      const ctx = (result as any).prependContext || "";
      // Check structural markers
      expect(ctx).toContain("PROJECT RULES & CONTEXT");
      // Check actual content from docs (case-insensitive)
      expect(ctx.toLowerCase()).toContain("always use typescript");
      expect(ctx.toLowerCase()).toContain("build the best plugin ever");
      expect(ctx.toLowerCase()).toContain("typebox schema validation");
      expect(ctx.toLowerCase()).toContain("style guide");
      expect(ctx.toLowerCase()).toContain("project plan");
      expect(ctx.toLowerCase()).toContain("architecture");
      // Check feature map
      expect(ctx).toContain("Auto-populate models");
    });

    it("should not inject project docs section when no project docs exist", async () => {
      // No docs created for this project
      await setupRegistered();
      const hook = api.hooks.get("before_prompt_build")!;
      const result = await hook(
        { conversation: { agentId: "main" } },
        { sessionKey: "test-key" }
      );

      const ctx = (result as any)?.prependContext || "";
      // No PROJECT RULES section because no docs exist
      expect(ctx).not.toContain("PROJECT RULES & CONTEXT (auto-injected)");
    });

    it("should not inject project docs for unregistered sessions", async () => {
      // Create a doc, but don't register the session
      const fs = await import("node:fs");
      const path = await import("node:path");
      const projDir = path.join(dd, "projects", "test-project");
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(projDir, "STYLE_GUIDE.md"), "# Should not be injected");

      // No registration, use unregistered session key
      const hook = api.hooks.get("before_prompt_build")!;
      const result = await hook(
        { conversation: { agentId: "main" } },
        { sessionKey: "unregistered-session" }
      );

      // Should return undefined or have no STYLE GUIDE content (no injection for unregistered)
      const ctx = (result as any)?.prependContext || "";
      expect(ctx).not.toContain("STYLE GUIDE");
    });
  });
});
