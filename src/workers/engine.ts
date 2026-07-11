// ═══════════════════════════════════════════════════════════════
//  WORKERS ENGINE — Canonical worker executor (v2)
//
//  Per ARCHITECTURE.md: workers are real agents that plan, execute,
//  test, and report. This engine implements the tool-call loop that
//  drives that lifecycle.
//
//  Flow:
//    1. Build a role-aware system prompt
//    2. Send task to LLM with tool definitions
//    3. Execute any tool_calls the LLM returns
//    4. Send tool results back to LLM
//    5. Repeat until LLM says "DONE" or max iterations hit
//    6. Save the report to the vault
//    7. Update task state
//
//  Unlike the legacy `worker-engine.ts` (which used a hardcoded
//  gateway URL and raw fetch), this engine uses the generic
//  callLLM from worker-runtime.ts (auto-configured on install).
// ═══════════════════════════════════════════════════════════════

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { callLLM, getLLMConfig, type CallLLMResult } from "../worker-runtime.js";
import {
  getWorker,
  getBacklogTask,
  updateBacklogTask,
  updateWorker,
  addWorkerTaskHistory,
  addVaultDoc,
  listVaultDocs,
  type WorkerRow,
  type BacklogRow,
} from "../db.js";
import { getDataDir } from "../shared.js";
import { buildRolePrompt } from "./prompts.js";
import { createStallDetector, type StallDetector } from "./stall-detector.js";

// ═══════════════════════════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════════════════════════

export interface EngineConfig {
  /** Max tool-call iterations before giving up. */
  maxIterations: number;
  /** Max tokens per LLM call. */
  maxTokens: number;
  /** Workspace dir for the project (where files live). */
  workspaceDir: string;
  /** Optional abort signal for cancellation. */
  abortSignal?: AbortSignal;
}

export interface EngineStep {
  iteration: number;
  role: "assistant" | "tool";
  content: string;
  toolName?: string;
  toolArgs?: Record<string, any>;
  toolResult?: string;
  toolError?: string;
  timestamp: string;
}

export interface EngineResult {
  ok: boolean;
  workerId: string;
  taskId: string;
  report: string;
  steps: EngineStep[];
  filesChanged: string[];
  toolCallCount: number;
  iterations: number;
  stopReason: "done" | "max_iterations" | "error" | "aborted";
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
//  TOOL DEFINITIONS (OpenAI tools format)
// ═══════════════════════════════════════════════════════════════

const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file in the project workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the project workspace, e.g. 'src/db/schema.ts'." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a file in the project workspace. Use this for new files or full rewrites.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the project workspace." },
          content: { type: "string", description: "Full file contents to write." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Apply a single text replacement to a file in the project workspace. Use for small targeted changes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the project workspace." },
          old_text: { type: "string", description: "Exact text to find (must match uniquely)." },
          new_text: { type: "string", description: "Replacement text." },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files in the project workspace (recursively, with sensible ignores).",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Optional glob to filter, e.g. 'src/**/*.ts'." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the project workspace. Use for tests, build, git, package install, etc. Returns stdout+stderr.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run, e.g. 'npm test' or 'npx tsc --noEmit'." },
          timeout_ms: { type: "number", description: "Optional timeout in milliseconds (default 60000, max 600000)." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_commit",
      description: "Stage all changes and create a git commit in the project workspace with a descriptive message.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Commit message. Use conventional commits style (feat:, fix:, test:, docs:, etc.)." },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "report_done",
      description: "Signal that the task is complete. Provide a final summary in the 'summary' field. The summary will be saved to the vault and shown to the PM.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Markdown summary of what was done, what was tested, and any follow-ups." },
        },
        required: ["summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_branch",
      description: "Show the current git branch and status. Use to verify you are on the correct task branch.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

// ═══════════════════════════════════════════════════════════════
//  TOOL EXECUTION
// ═══════════════════════════════════════════════════════════════

function safeResolve(workspaceDir: string, relPath: string): string {
  // Reject absolute paths and parent-dir escapes
  if (path.isAbsolute(relPath) || relPath.includes("..")) {
    throw new Error(`Refusing to access path outside workspace: ${relPath}`);
  }
  return path.resolve(workspaceDir, relPath);
}

function toolReadFile(workspaceDir: string, args: { path: string }): string {
  const full = safeResolve(workspaceDir, args.path);
  if (!fs.existsSync(full)) return `(file does not exist: ${args.path})`;
  const stat = fs.statSync(full);
  if (stat.isDirectory()) return fs.readdirSync(full).join("\n");
  return fs.readFileSync(full, "utf-8");
}

function toolWriteFile(workspaceDir: string, args: { path: string; content: string }): string {
  const full = safeResolve(workspaceDir, args.path);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, args.content, "utf-8");
  return `wrote ${args.content.length} bytes to ${args.path}`;
}

function toolEditFile(workspaceDir: string, args: { path: string; old_text: string; new_text: string }): string {
  const full = safeResolve(workspaceDir, args.path);
  if (!fs.existsSync(full)) return `(file does not exist: ${args.path})`;
  const original = fs.readFileSync(full, "utf-8");
  if (!original.includes(args.old_text)) {
    return `(old_text not found in ${args.path}; ${original.length} bytes scanned)`;
  }
  // Require unique match
  const occurrences = original.split(args.old_text).length - 1;
  if (occurrences !== 1) {
    return `(old_text matches ${occurrences} times in ${args.path}; must be unique)`;
  }
  const updated = original.replace(args.old_text, args.new_text);
  fs.writeFileSync(full, updated, "utf-8");
  return `edited ${args.path} (${args.old_text.length} -> ${args.new_text.length} bytes)`;
}

function toolListFiles(workspaceDir: string, args: { pattern?: string }): string {
  // Simple recursive listing with node_modules, .git, dist, coverage ignored
  const ignores = new Set(["node_modules", ".git", "dist", "coverage", "stryker-tmp"]);
  function walk(dir: string, prefix: string, out: string[]): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (ignores.has(e)) continue;
      const full = path.join(dir, e);
      const rel = prefix ? `${prefix}/${e}` : e;
      let stat: fs.Stats;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.isDirectory()) walk(full, rel, out);
      else if (stat.isFile()) out.push(rel);
    }
  }
  const all: string[] = [];
  walk(workspaceDir, "", all);
  if (args.pattern) {
    // Very simple glob: just match the suffix or substring
    const re = new RegExp(args.pattern.replace(/\*/g, ".*").replace(/\?/g, "."));
    return all.filter(f => re.test(f)).join("\n");
  }
  return all.slice(0, 200).join("\n") + (all.length > 200 ? `\n... (${all.length - 200} more)` : "");
}

function toolRunCommand(workspaceDir: string, args: { command: string; timeout_ms?: number }): string {
  const timeout = Math.min(Math.max(args.timeout_ms ?? 60_000, 1000), 600_000);
  try {
    const stdout = execSync(args.command, {
      cwd: workspaceDir,
      encoding: "utf-8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout || "(no output)";
  } catch (err: any) {
    const out = (err.stdout || "") + (err.stderr ? "\n[stderr]\n" + err.stderr : "");
    return `[exit ${err.status ?? "?"}]\n${out || err.message}`;
  }
}

function toolGitBranch(workspaceDir: string): string {
  try {
    const branch = execSync(`git rev-parse --abbrev-ref HEAD`, {
      cwd: workspaceDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const status = execSync(`git status --short`, {
      cwd: workspaceDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const log = execSync(`git log --oneline -5`, {
      cwd: workspaceDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return `Branch: ${branch}\nStatus: ${status || "clean"}\nRecent commits:\n${log}`;
  } catch (err: any) {
    return `git branch info failed: ${err.message}`;
  }
}

function toolGitCommit(workspaceDir: string, args: { message: string }, filesChanged: string[]): string {
  try {
    // Stage only the files the engine has touched, plus any untracked that
    // were created. Safer than `git add -A` which can pull in noise.
    for (const f of filesChanged) {
      try { execSync(`git add -- "${f}"`, { cwd: workspaceDir, stdio: "ignore" }); } catch { /* untracked */ }
    }
    // Also pick up any untracked files (newly created) within scope
    try { execSync(`git add -A -- src tests README.md package.json tsconfig.json vitest.config.ts eslint.config.js .prettierrc 2>/dev/null || true`, { cwd: workspaceDir, stdio: "ignore" }); } catch { /* ignore */ }
    const status = execSync(`git status --short`, { cwd: workspaceDir, encoding: "utf-8" });
    if (!status.trim()) return "(nothing to commit)";
    const sha = execSync(`git commit -m ${JSON.stringify(args.message)}`, {
      cwd: workspaceDir,
      encoding: "utf-8",
    });
    return `committed: ${sha.trim().split("\n").pop() || args.message}`;
  } catch (err: any) {
    return `git commit failed: ${err.message}`;
  }
}

async function executeTool(
  toolName: string,
  rawArgs: string,
  workspaceDir: string,
  filesChanged: string[],
): Promise<{ result: string; isError: boolean }> {
  let args: any = {};
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch (e: any) {
    return { result: `invalid JSON args: ${e.message}`, isError: true };
  }
  try {
    switch (toolName) {
      case "read_file":    return { result: toolReadFile(workspaceDir, args), isError: false };
      case "write_file":   { const r = toolWriteFile(workspaceDir, args); filesChanged.push(args.path); return { result: r, isError: false }; }
      case "edit_file":    { const r = toolEditFile(workspaceDir, args); if (r.startsWith("edited ")) filesChanged.push(args.path); return { result: r, isError: false }; }
      case "list_files":   return { result: toolListFiles(workspaceDir, args), isError: false };
      case "run_command":  return { result: toolRunCommand(workspaceDir, args), isError: false };
      case "git_commit":   return { result: toolGitCommit(workspaceDir, args, filesChanged), isError: false };
      case "git_branch":   return { result: toolGitBranch(workspaceDir), isError: false };
      case "report_done":  return { result: JSON.stringify({ acknowledged: true, summary: args.summary }), isError: false };
      default:             return { result: `unknown tool: ${toolName}`, isError: true };
    }
  } catch (err: any) {
    return { result: `tool ${toolName} failed: ${err.message}`, isError: true };
  }
}

// ═══════════════════════════════════════════════════════════════
//  REPORT GENERATION
// ═══════════════════════════════════════════════════════════════

function buildReport(worker: WorkerRow, task: BacklogRow, result: EngineResult): string {
  const lines: string[] = [];
  lines.push(`# ${task.title}`);
  lines.push("");
  lines.push(`**Worker:** ${worker.name} (${worker.role})  `);
  lines.push(`**Task ID:** ${task.id}  `);
  lines.push(`**Status:** ${result.stopReason}  `);
  lines.push(`**Iterations:** ${result.iterations}  `);
  lines.push(`**Tool calls:** ${result.toolCallCount}  `);
  lines.push(`**Files changed:** ${result.filesChanged.length || 0}  `);
  lines.push(`**Date:** ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(result.report);
  if (result.filesChanged.length) {
    lines.push("");
    lines.push("## Files");
    lines.push("");
    for (const f of result.filesChanged) lines.push(`- \`${f}\``);
  }
  if (result.error) {
    lines.push("");
    lines.push("## Error");
    lines.push("");
    lines.push("```");
    lines.push(result.error);
    lines.push("```");
  }
  return lines.join("\n");
}

function saveReportToVault(project: string, task: BacklogRow, report: string): void {
  try {
    const safe = task.id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const docPath = `reports/${safe}.md`;
    addVaultDoc(docPath, `Report: ${task.title}`, report, "reports", project);
  } catch (e: any) {
    // best-effort; vault may be unavailable
  }
}

// ═══════════════════════════════════════════════════════════════
//  MAIN EXECUTE
// ═══════════════════════════════════════════════════════════════

export async function executeWorkerTask(
  workerId: string,
  taskId: string,
  config: Partial<EngineConfig> = {},
): Promise<EngineResult> {
  const cfg: EngineConfig = {
    maxIterations: config.maxIterations ?? 25,
    maxTokens: config.maxTokens ?? 2048,
    workspaceDir: config.workspaceDir ?? "",
    abortSignal: config.abortSignal,
  };

  const startedAt = new Date().toISOString();
  const steps: EngineStep[] = [];
  const filesChanged: string[] = [];
  let toolCallCount = 0;
  let stopReason: EngineResult["stopReason"] = "error";
  let finalReport = "";
  let error: string | undefined;

  const worker = getWorker(workerId);
  if (!worker) {
    return {
      ok: false, workerId, taskId, report: "", steps, filesChanged, toolCallCount,
      iterations: 0, stopReason: "error", error: `Worker not found: ${workerId}`,
    };
  }
  const task = getBacklogTask(taskId);
  if (!task) {
    return {
      ok: false, workerId, taskId, report: "", steps, filesChanged, toolCallCount,
      iterations: 0, stopReason: "error", error: `Task not found: ${taskId}`,
    };
  }
  const project = task.project || worker.project;
  const workspaceDir = cfg.workspaceDir || getDataDir() + "/projects/" + project;

  // Build system prompt
  const systemPrompt = buildRolePrompt(worker, project, task);

  // Initial user message
  const userMessage = [
    `## Task`,
    `**Title:** ${task.title}`,
    `**Description:** ${task.description || "(no description)"}`,
    `**Priority:** ${task.priority}`,
    `**Workspace:** ${workspaceDir}`,
    ``,
    `## Instructions`,
    `1. Read the project structure first (list_files) to understand the codebase.`,
    `2. Plan your approach internally.`,
    `3. Use write_file / edit_file to make the changes.`,
    `4. Use run_command to run tests, build, and other checks.`,
    `5. Use git_commit with a clear conventional commit message.`,
    `6. Call report_done with a markdown summary when finished.`,
    ``,
    `If tests fail, iterate: read the failure, fix the code, re-run tests.`,
    `Do not stop until tests pass (or you have a clear reason they cannot).`,
  ].join("\n");

  let history: Array<{ role: string; content: string; tool_calls?: any[]; tool_call_id?: string; name?: string }> = [
    { role: "user", content: userMessage },
  ];

  // Prepend any worker prompt as additional context
  if (worker.prompt) {
    history = [
      { role: "system", content: worker.prompt },
      ...history,
    ];
  }

  // ── Branch-per-task: create a feature branch so parallel workers don't collide ──
  const branchName = `task/${taskId}`;
  let originalBranch = "main";
  try {
    originalBranch = execSync(`git rev-parse --abbrev-ref HEAD`, {
      cwd: workspaceDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch { /* not a git repo yet */ }
  try {
    // Create and checkout the task branch from the current HEAD
    execSync(`git checkout -b ${branchName}`, {
      cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    // Branch may already exist — just switch to it
    try {
      execSync(`git checkout ${branchName}`, {
        cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch { /* best effort */ }
  }

  updateWorker(workerId, { status: "working" } as any);
  addWorkerTaskHistory(workerId, Number(taskId), "started", JSON.stringify({ startedAt, branch: branchName }));

  // ── Stall detector: monitor OpenClaw session file for activity ──
  const stallDetector = createStallDetector({
    sessionKey: `agent:main:worker:${workerId}`,
    stallTimeoutMs: 180_000, // 3 minutes of no activity = stall
    onStall: ({ idleMs }) => {
      stopReason = "error";
      error = `Worker stalled — no activity for ${(idleMs / 1000).toFixed(0)}s`;
    },
  });
  stallDetector.start();

  // ── Tool-call loop ──
  for (let i = 0; i < cfg.maxIterations; i++) {
    // Check stall before each iteration
    if (stallDetector.status().active === false && stopReason === "error") {
      break; // stall detected by onStall callback
    }
    if (cfg.abortSignal?.aborted) {
      stopReason = "aborted";
      error = "aborted by caller";
      break;
    }

    let result: CallLLMResult;
    try {
      result = await callLLM({
        systemPrompt,
        userMessage: history[history.length - 1]?.content || userMessage,
        history: history.slice(0, -1).filter(m => m.role !== "system").map(m => ({ role: m.role, content: m.content })),
        maxTokens: cfg.maxTokens,
        user: `worker-${workerId}`,
        sessionKey: `agent:main:worker:${workerId}`,
        messageChannel: "orchestrator-software-house",
        tools: TOOL_DEFS,
        toolChoice: "auto",
      });
    } catch (e: any) {
      stopReason = "error";
      error = `LLM call failed: ${e.message}`;
      steps.push({ iteration: i, role: "assistant", content: "", timestamp: new Date().toISOString(), toolError: error });
      break;
    }

    toolCallCount += result.toolCalls?.length ?? 0;
    steps.push({
      iteration: i,
      role: "assistant",
      content: result.content,
      timestamp: new Date().toISOString(),
    });

    // No tool calls → keep going. The model often returns plain text as
    // "thinking out loud". Only an explicit `report_done` tool call marks
    // the task as done. We do this by nudging: add a system message
    // asking the model to use a tool, then continue the loop.
    if (!result.toolCalls?.length) {
      history.push({
        role: "user",
        content: "You must use one of the available tools to make progress. If the task is complete, call `report_done` with a summary.",
      });
      continue;
    }

    // Append assistant turn
    history.push({
      role: "assistant",
      content: result.content,
      tool_calls: result.toolCalls.map(tc => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    // Execute each tool call
    let reportedSummary: string | null = null;
    for (const tc of result.toolCalls) {
      const exec = await executeTool(tc.name, tc.arguments, workspaceDir, filesChanged);
      steps.push({
        iteration: i,
        role: "tool",
        content: exec.result,
        toolName: tc.name,
        toolArgs: safeJsonParse(tc.arguments),
        toolResult: exec.result,
        toolError: exec.isError ? exec.result : undefined,
        timestamp: new Date().toISOString(),
      });
      history.push({
        role: "tool",
        content: exec.result,
        tool_call_id: tc.id,
        name: tc.name,
      });
      if (tc.name === "report_done") {
        try {
          const args = JSON.parse(tc.arguments || "{}");
          reportedSummary = args.summary || "";
        } catch { /* ignore */ }
      }
      stallDetector.touch(); // reset stall timer after each tool call
    }

    if (reportedSummary !== null) {
      finalReport = reportedSummary;
      stopReason = "done";
      break;
    }
  }

  stallDetector.stop();

  if (stopReason !== "done" && stopReason !== "aborted" && stopReason !== "error") {
    stopReason = "max_iterations";
  }

  // ── Branch merge: on success, merge task branch back to original branch ──
  if (stopReason === "done") {
    try {
      // Commit any remaining uncommitted changes on the task branch
      const status = execSync(`git status --short`, { cwd: workspaceDir, encoding: "utf-8" });
      if (status.trim()) {
        execSync(`git add -A`, { cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"] });
        execSync(`git commit -m "chore: final changes for ${taskId}"`, {
          cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"],
        });
      }
      // Switch back to original branch and merge
      execSync(`git checkout ${originalBranch}`, {
        cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"],
      });
      const mergeOut = execSync(`git merge ${branchName} --no-edit`, {
        cwd: workspaceDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
      });
      // Clean up the task branch
      execSync(`git branch -d ${branchName}`, {
        cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"],
      });
      steps.push({
        iteration: steps.length,
        role: "assistant",
        content: `Merged ${branchName} → ${originalBranch}`,
        timestamp: new Date().toISOString(),
      });
    } catch (mergeErr: any) {
      // Merge conflict or other issue — leave the branch for manual resolution
      steps.push({
        iteration: steps.length,
        role: "assistant",
        content: `Merge failed: ${mergeErr.message}. Branch ${branchName} left for manual resolution.`,
        timestamp: new Date().toISOString(),
      });
      error = `Merge failed: ${mergeErr.message}`;
    }
  } else {
    // On failure/abort — switch back to original branch, leave task branch for inspection
    try {
      execSync(`git checkout ${originalBranch}`, {
        cwd: workspaceDir, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch { /* best effort */ }
  }

  // Persist
  const result: EngineResult = {
    ok: stopReason === "done",
    workerId,
    taskId,
    report: finalReport,
    steps,
    filesChanged,
    toolCallCount,
    iterations: steps.filter(s => s.role === "assistant").length,
    stopReason,
    error,
  };

  const fullReport = buildReport(worker, task, result);
  saveReportToVault(project, task, fullReport);

  updateWorker(workerId, { status: result.ok ? "idle" : "error" } as any);
  if (result.ok) {
    updateBacklogTask(taskId, { status: "done" } as any);
    addWorkerTaskHistory(workerId, Number(taskId), "completed", JSON.stringify({
      iterations: result.iterations,
      toolCalls: result.toolCallCount,
      filesChanged: result.filesChanged,
      finishedAt: new Date().toISOString(),
    }));
  } else {
    addWorkerTaskHistory(workerId, Number(taskId), "failed", JSON.stringify({
      stopReason, error,
      iterations: result.iterations,
      finishedAt: new Date().toISOString(),
    }));
  }
  addWorkerTaskHistory(workerId, Number(taskId), "reported", JSON.stringify({
    message: finalReport || error || "(no summary)",
    ts: new Date().toISOString(),
  }));

  return result;
}

function safeJsonParse(s: string): Record<string, any> | undefined {
  try { return JSON.parse(s); } catch { return undefined; }
}


