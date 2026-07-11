// ═══════════════════════════════════════════════════════════════
//  tests/workers-engine.test.ts
//  Mocked-LLM tests for the workers engine tool-call loop.
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";

import {
  addWorker,
  addBacklogTask,
  getDb,
  initDb,
  listVaultDocs,
  resetDb,
  setProjectConfig,
} from "../src/db.js";
import { executeWorkerTask } from "../src/workers/engine.js";
import { configureLLM } from "../src/worker-runtime.js";

// ── mock callLLM so we can script tool-call sequences ──

let mockScript: Array<{ content: string; toolCalls?: any[] }> = [];
let mockScriptIdx = 0;

vi.mock("../src/worker-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/worker-runtime.js")>();
  return {
    ...actual,
    callLLM: vi.fn(async () => {
      const next = mockScript[Math.min(mockScriptIdx, mockScript.length - 1)];
      mockScriptIdx++;
      return { content: next.content, toolCalls: next.toolCalls, raw: { mocked: true } };
    }),
    pickAvailableModel: vi.fn(async () => "mock-model"),
  };
});

// ── tests ──

describe("executeWorkerTask", () => {
  let workspaceDir: string;
  let dataDir: string;
  let workerId: string;
  let taskId: string;
  const project = "engine-test";

  beforeEach(async () => {
    // Use a fresh data dir for the DB
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-data-"));
    process.env.ORCHESTRATOR_DATA_DIR = dataDir;
    resetDb();
    initDb(dataDir);

    mockScript = [];
    mockScriptIdx = 0;

    configureLLM({
      endpoint: "http://localhost:1/v1/chat/completions",
      token: "test-token",
      defaultModel: "mock-model",
      timeoutMs: 1000,
    });

    // Fresh workspace
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "engine-ws-"));
    fs.writeFileSync(path.join(workspaceDir, "package.json"), JSON.stringify({ name: project, version: "0.0.1" }));
    fs.mkdirSync(path.join(workspaceDir, ".git"));
    execSync("git init -q", { cwd: workspaceDir, stdio: "ignore" });
    execSync("git config user.email t@t", { cwd: workspaceDir, stdio: "ignore" });
    execSync("git config user.name t", { cwd: workspaceDir, stdio: "ignore" });
    execSync("git add -A", { cwd: workspaceDir, stdio: "ignore" });
    execSync("git commit -qm initial", { cwd: workspaceDir, stdio: "ignore" });

    // Worker + task
    setProjectConfig(project, { location: workspaceDir });
    workerId = "w-test-" + Date.now();
    addWorker(workerId, "TestDev", "developer", "blue", "mock-model",
      "You are a dev.", "", project, 0);

    const tid = "task_test_" + Date.now();
    addBacklogTask({
      id: tid,
      project,
      title: "Add a hello function",
      description: "Create src/hello.ts with a function `hello(): string` that returns 'Hello, world!'.",
      priority: "p0",
      status: "todo",
      labels: "[]",
      depends_on: "[]",
      assigned_to: "",
      session_refs: "[]",
      created_ts: Math.floor(Date.now() / 1000),
      updated_ts: Math.floor(Date.now() / 1000),
    });
    taskId = tid;
  });

  it("creates a file, runs tests, commits, and reports done", async () => {
    mockScript.push({ content: "Let me check the structure first." });
    mockScript.push({
      content: "",
      toolCalls: [{ id: "call_1", name: "list_files", arguments: JSON.stringify({}) }],
    });
    mockScript.push({
      content: "I'll create the file.",
      toolCalls: [{
        id: "call_2",
        name: "write_file",
        arguments: JSON.stringify({ path: "src/hello.ts", content: "export function hello(): string {\n  return 'Hello, world!';\n}\n" }),
      }],
    });
    mockScript.push({
      content: "Run a check.",
      toolCalls: [{
        id: "call_3",
        name: "run_command",
        arguments: JSON.stringify({ command: "cat src/hello.ts" }),
      }],
    });
    mockScript.push({
      content: "Committing.",
      toolCalls: [{
        id: "call_4",
        name: "git_commit",
        arguments: JSON.stringify({ message: "feat: add hello() function" }),
      }],
    });
    mockScript.push({
      content: "",
      toolCalls: [{
        id: "call_5",
        name: "report_done",
        arguments: JSON.stringify({ summary: "Created src/hello.ts with hello() function." }),
      }],
    });

    const result = await executeWorkerTask(workerId, taskId, {
      workspaceDir,
      maxIterations: 10,
      maxTokens: 512,
    });

    expect(result.ok).toBe(true);
    expect(result.stopReason).toBe("done");
    expect(result.toolCallCount).toBeGreaterThanOrEqual(4);
    expect(result.filesChanged).toContain("src/hello.ts");
    expect(fs.existsSync(path.join(workspaceDir, "src/hello.ts"))).toBe(true);
    const fileContent = fs.readFileSync(path.join(workspaceDir, "src/hello.ts"), "utf-8");
    expect(fileContent).toContain("Hello, world!");

    const taskRow = getDb().prepare("SELECT status FROM backlog_tasks WHERE id = ?").get(taskId) as any;
    expect(taskRow.status).toBe("done");
  }, 30000);

  it("stops at max_iterations if model never reports done", async () => {
    for (let i = 0; i < 5; i++) {
      mockScript.push({ content: "thinking..." });
    }

    const result = await executeWorkerTask(workerId, taskId, {
      workspaceDir,
      maxIterations: 3,
      maxTokens: 256,
    });

    expect(result.ok).toBe(false);
    expect(result.iterations).toBeLessThanOrEqual(3);
  }, 15000);

  it("refuses to write outside workspace", async () => {
    mockScript.push({
      content: "",
      toolCalls: [{
        id: "call_1",
        name: "write_file",
        arguments: JSON.stringify({ path: "/etc/passwd", content: "pwned" }),
      }],
    });
    mockScript.push({
      content: "",
      toolCalls: [{
        id: "call_2",
        name: "report_done",
        arguments: JSON.stringify({ summary: "Done" }),
      }],
    });

    const result = await executeWorkerTask(workerId, taskId, {
      workspaceDir,
      maxIterations: 5,
      maxTokens: 256,
    });

    expect(result.ok).toBe(true);
    expect(result.filesChanged.every(f => !f.startsWith("/"))).toBe(true);
    expect(fs.existsSync("/etc/passwd.override")).toBe(false); // sanity
  }, 15000);

  it("saves report to vault", async () => {
    mockScript.push({
      content: "",
      toolCalls: [{
        id: "call_1",
        name: "report_done",
        arguments: JSON.stringify({ summary: "Vault test report content" }),
      }],
    });

    const result = await executeWorkerTask(workerId, taskId, {
      workspaceDir,
      maxIterations: 5,
      maxTokens: 256,
    });

    expect(result.ok).toBe(true);
    const docs = listVaultDocs(project);
    const report = docs.find(d => d.path?.includes("reports/"));
    expect(report).toBeDefined();
    expect(report!.content).toContain("Vault test report content");
  }, 15000);
});
