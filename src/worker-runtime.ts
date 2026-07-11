/**
 * Worker Runtime — AI-powered worker execution engine.
 *
 * Workers call an OpenAI-compatible chat completions endpoint.
 * Default backend: OpenClaw gateway's `/v1/chat/completions` (same process,
 * same port, OpenAI-compatible, full session tracking via x-openclaw-* headers
 * and the `user` field for stable per-worker session derivation).
 *
 * Alternative backend: LM Studio (http://localhost:1234/v1) — set
 * `WORKER_LLM_BACKEND=lmstudio`. Kept for dev/testing when no OpenClaw
 * gateway is reachable.
 *
 * No additional npm dependencies. Everything uses native fetch.
 */

import { WorkerRow, BacklogRow } from "./db.js";
import { addVaultDoc, addWorkerTaskHistory, updateWorker, updateBacklogTask } from "./db.js";

import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Backend configuration ─────────────────────────────────────

export type LLMBackend = "openclaw" | "lmstudio";

// ponytail: lazy env read so tests can set the env var before first call.
function resolveBackend(): LLMBackend {
  return (process.env.WORKER_LLM_BACKEND as LLMBackend) || "openclaw";
}

const LMSTUDIO_BASE = process.env.LMSTUDIO_BASE || "http://localhost:1234/v1";
const LMSTUDIO_DEFAULT_MODEL = process.env.WORKER_MODEL || "local-model";

// OpenClaw gateway endpoint. The plugin runs inside the same process, so this
// is the local gateway at its configured port. Override via env if needed.
const OPENCLAW_BASE = process.env.OPENCLAW_GATEWAY_BASE
  || (() => {
    // Read gateway port from OpenClaw config, fall back to env or default.
    try {
      const cfgPath = process.env.OPENCLAW_CONFIG || path.join(os.homedir(), ".openclaw", "openclaw.json");
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      const port = cfg?.gateway?.port
        || process.env.OPENCLAW_GATEWAY_PORT
        || 18789;
      return `http://127.0.0.1:${port}`;
    } catch (_) {
      const port = process.env.OPENCLAW_GATEWAY_PORT || 18789;
      return `http://127.0.0.1:${port}`;
    }
  })();

// ponytail: cached at module load. Token is stable for the gateway lifetime.
let _openclawToken: string | null = null;
function getOpenClawToken(): string {
  if (_openclawToken) return _openclawToken;
  // Same lookup logic as base URL.
  const candidates = [
    process.env.OPENCLAW_GATEWAY_TOKEN,
    process.env.OPENCLAW_GATEWAY_PASSWORD,
  ];
  for (const c of candidates) if (c) { _openclawToken = c; return c; }
  try {
    const cfgPath = process.env.OPENCLAW_CONFIG || path.join(os.homedir(), ".openclaw", "openclaw.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const auth = cfg?.gateway?.auth;
    const t = auth?.token || auth?.password;
    if (t) { _openclawToken = t; return t; }
  } catch (_) {}
  throw new Error(
    "OpenClaw gateway token not found. Set OPENCLAW_GATEWAY_TOKEN env var " +
    "or ensure ~/.openclaw/openclaw.json has gateway.auth.token"
  );
}

// ponytail: prefer non-embedding chat models; gemma/qwen prefixes are usually chat.
const CHAT_MODEL_HINTS = ["gemma", "qwen", "llama", "mistral", "minimax", "deepseek", "command"];

export async function pickAvailableModel(preferred?: string): Promise<string> {
  const health = await checkLmStudioHealth();
  if (!health.reachable || !health.models?.length) {
    throw new Error("LM Studio unreachable — cannot pick a model");
  }
  // Honor the preferred name if it's actually loaded
  if (preferred && health.models.includes(preferred)) return preferred;
  // Otherwise pick the first non-embedding chat model
  const candidate = health.models.find((m) => {
    if (m.includes("embed")) return false;
    return CHAT_MODEL_HINTS.some((hint) => m.toLowerCase().includes(hint));
  });
  return candidate || health.models[0];
}

// ── Role-based system prompts ──

const ROLE_PROMPTS: Record<string, string> = {
  developer:
    "You are a software developer working in a software house. Write clean, maintainable code. " +
    "Follow best practices, test your work, and report clearly what you built. " +
    "Keep responses technical and concise. Provide code when relevant.",
  designer:
    "You are a UI/UX designer in a software house. Focus on usability, accessibility, and visual polish. " +
    "Provide design rationale and concrete suggestions. Be constructive and specific.",
  pm:
    "You are a project manager coordinating a software team. Plan sprints, track progress, " +
    "identify blockers, and report status clearly. Be diplomatic and action-oriented.",
  qa:
    "You are a QA engineer. Find bugs, verify requirements, write test cases, and report issues clearly. " +
    "Be thorough but constructive. Distinguish between critical and cosmetic issues.",
  default:
    "You are a helpful AI worker in a software house. Complete tasks assigned to you and " +
    "report your work clearly. Be concise and professional.",
};

/**
 * Build a system prompt for a worker based on their role, name, and current context.
 */
export function buildSystemPrompt(
  worker: Pick<WorkerRow, "name" | "role" | "prompt">,
  project: string,
  taskTitle?: string,
  taskDescription?: string,
): string {
  const roleKey = worker.role.toLowerCase().includes("developer")
    ? "developer"
    : worker.role.toLowerCase().includes("design")
      ? "designer"
      : worker.role.toLowerCase().includes("manager") || worker.role.toLowerCase().includes("pm")
        ? "pm"
        : worker.role.toLowerCase().includes("qa") || worker.role.toLowerCase().includes("review")
          ? "qa"
          : "default";

  const basePrompt = ROLE_PROMPTS[roleKey] || ROLE_PROMPTS.default;

  const lines: string[] = [
    `## Role: ${worker.name} — ${worker.role}`,
    ``,
    basePrompt,
    ``,
    `### Project Context`,
    `- Project: ${project}`,
    `- Your name: ${worker.name}`,
    `- Your role: ${worker.role}`,
  ];

  if (taskTitle) {
    lines.push(`- Current task: ${taskTitle}`);
  }
  if (taskDescription) {
    lines.push(`- Task details: ${taskDescription}`);
  }

  if (worker.prompt) {
    lines.push(``);
    lines.push(`### Custom Instructions`);
    lines.push(worker.prompt);
  }

  lines.push(``);
  lines.push(`### Response Format`);
  lines.push(`- Keep responses clear and concise.`);
  lines.push(`- Use markdown for structure when appropriate.`);
  lines.push(`- For task work, start with a brief summary of what you understand.`);
  lines.push(`- Report progress, blockers, and next steps clearly.`);

  return lines.join("\n");
}

/**
 * Call an OpenAI-compatible chat completions endpoint.
 *
 * Default backend: OpenClaw gateway (`/v1/chat/completions`).
 *   - Same process, no network hop
 *   - Bearer auth via gateway token
 *   - Per-worker session routing via `user` field (stable across requests)
 *   - Optional `x-openclaw-session-key` for explicit routing
 *   - Optional `x-openclaw-model` to override backend model (e.g. premium
 *     model burning via `x-openclaw-model: openai/gpt-5.4`)
 *   - OpenClaw tracks session history server-side — no need to ship the
 *     full `history` array; the `user` field is enough for continuity.
 *
 * Alternative backend: LM Studio. Set `WORKER_LLM_BACKEND=lmstudio` env var,
 * or pass `backend: "lmstudio"` per call.
 *
 * Uses native fetch — zero npm deps.
 */
export async function callLLM(opts: {
  systemPrompt: string;
  userMessage: string;
  /** Per-worker stable identifier. Used as the `user` field in the OpenAI
   *  request, which OpenClaw uses to derive a stable session key. This gives
   *  us free per-worker session tracking without explicit session_key wiring. */
  user?: string;
  /** Optional explicit session routing. Overrides `user`-derived session. */
  sessionKey?: string;
  /** Optional message channel context (sets x-openclaw-message-channel). */
  messageChannel?: string;
  /** Optional backend model override (sets x-openclaw-model).
   *  Use this to pin premium models for the 5h free-sub burn. */
  backendModel?: string;
  /** Per-call backend override. Defaults to `BACKEND` env / module default. */
  backend?: LLMBackend;
  /** Optional raw chat history. OpenClaw tracks server-side, so this is
   *  only needed for non-OpenClaw backends (LM Studio). */
  history?: Array<{ role: string; content: string }>;
  maxTokens?: number;
  /** Legacy: preferred LM Studio model name. Ignored for OpenClaw backend. */
  preferredModel?: string;
}): Promise<string> {
  const backend: LLMBackend = opts.backend || resolveBackend();
  if (backend === "openclaw") return callOpenClaw(opts);
  return callLmStudio(opts);
}

/**
 * Call OpenClaw gateway with OpenClaw-syntax extensions.
 *
 * OpenClaw syntax:
 *   - `model: "openclaw"` → routes to default agent
 *   - `model: "openclaw/<agentId>"` → routes to specific agent
 *   - `user: "<stable-id>"` → OpenClaw derives a session key from this
 *   - `x-openclaw-session-key: <key>` → explicit session routing
 *   - `x-openclaw-model: <provider/model>` → backend model override (owner-level)
 *   - `x-openclaw-message-channel: <ch>` → synthetic ingress channel
 */
async function callOpenClaw(opts: Parameters<typeof callLLM>[0]): Promise<string> {
  // ponytail: system prompt goes in the first message per OpenAI spec.
  // OpenClaw already tracks session history from previous calls with the
  // same `user` value, so we don't need to send the history array.
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.userMessage },
  ];

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${getOpenClawToken()}`,
  };
  if (opts.sessionKey) headers["x-openclaw-session-key"] = opts.sessionKey;
  if (opts.backendModel) headers["x-openclaw-model"] = opts.backendModel;
  if (opts.messageChannel) headers["x-openclaw-message-channel"] = opts.messageChannel;

  const body: Record<string, any> = {
    model: "openclaw", // default agent
    messages,
    max_completion_tokens: opts.maxTokens ?? 1024,
    temperature: 0.7,
    stream: false,
  };
  // `user` field drives session derivation; reuse the same value per worker.
  if (opts.user) body.user = opts.user;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000); // 60s — OpenClaw may do tool calls
  try {
    const response = await fetch(`${OPENCLAW_BASE}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`OpenClaw error ${response.status}: ${errorText.slice(0, 300)}`);
    }

    const data = (await response.json()) as any;
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("OpenClaw returned empty response");
    }
    return content.trim();
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error("OpenClaw request timed out after 60s");
    }
    if (err.message?.includes("fetch") || err.code === "ECONNREFUSED" || err.cause?.code === "ECONNREFUSED") {
      throw new Error(
        `Cannot reach OpenClaw gateway at ${OPENCLAW_BASE}. ` +
        `Is the gateway running? Error: ${err.message}`
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Call LM Studio (legacy backend). Same OpenAI-compatible format, no auth.
 */
async function callLmStudio(opts: Parameters<typeof callLLM>[0]): Promise<string> {
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: opts.systemPrompt },
  ];

  if (opts.history && opts.history.length > 0) {
    const recent = opts.history.slice(-10);
    for (const msg of recent) {
      if (msg.role !== "system") {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
  }

  messages.push({ role: "user", content: opts.userMessage });

  const model = await pickAvailableModel(opts.preferredModel).catch(() => LMSTUDIO_DEFAULT_MODEL);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${LMSTUDIO_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: 0.7,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`LM Studio error ${response.status}: ${errorText.slice(0, 200)}`);
    }

    const data = (await response.json()) as any;
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("LM Studio returned empty response");
    }
    return content.trim();
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error("LM Studio request timed out after 30s");
    }
    if (err.message?.includes("fetch") || err.code === "ECONNREFUSED" || err.cause?.code === "ECONNREFUSED") {
      throw new Error(
        `Cannot reach LM Studio at ${LMSTUDIO_BASE}. ` +
        `Make sure LM Studio is running and a model is loaded. Error: ${err.message}`
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Generate a structured job report for a completed task by calling the LLM.
 */
export async function generateJobReport(opts: {
  workerName: string;
  workerRole: string;
  taskTitle: string;
  taskDescription: string;
  workLog: string[];
}): Promise<string> {
  const logText = opts.workLog.join("\n");

  const prompt = `Generate a structured job report for completed task "${opts.taskTitle}".

Worker: ${opts.workerName} (${opts.workerRole})
Task: ${opts.taskTitle}
Description: ${opts.taskDescription}

Work log:
${logText}

Create a report with these sections (markdown):
## Summary
(1-2 sentence overview)

## What Was Done
(bullet list of completed items)

## Outcome
(what was achieved, any blockers overcome)

## Technical Details
(implementation approach, tools used, any notable decisions)

## Next Steps
(what should be done next, if anything)`;

  const systemPrompt =
    "You generate concise, structured job reports for a software house. " +
    "Each report is factual, specific to the work done, and actionable for the next iteration.";

  return callLLM({
    systemPrompt,
    userMessage: prompt,
    maxTokens: 1536,
  });
}

/**
 * Record a worker activity in the task history, updating worker/task status if needed.
 */
export async function reportWorkerActivity(opts: {
  workerId: string;
  taskId?: number;
  action: string;
  message: string;
  workerStatus?: string;
  taskStatus?: string;
  project?: string;
}): Promise<void> {
  // Store in worker_task_history
  addWorkerTaskHistory(
    opts.workerId,
    opts.taskId ?? null,
    opts.action,
    JSON.stringify({ message: opts.message, ts: new Date().toISOString() }),
  );

  // Update worker status if provided
  if (opts.workerStatus) {
    updateWorker(opts.workerId, { status: opts.workerStatus } as any);
  }

  // Update task status if provided
  if (opts.taskId && opts.taskStatus) {
    updateBacklogTask(opts.taskId.toString(), { status: opts.taskStatus });
  }
}

/**
 * Health check for the active backend.
 * For OpenClaw: GETs /v1/models (lists agent targets).
 * For LM Studio: GETs /v1/models (lists loaded models).
 */
export async function checkLmStudioHealth(): Promise<{
  reachable: boolean;
  backend: LLMBackend;
  error?: string;
  models?: string[];
}> {
  const base = resolveBackend() === "openclaw" ? OPENCLAW_BASE : LMSTUDIO_BASE;
  const headers: Record<string, string> = {};
  if (resolveBackend() === "openclaw") {
    try { headers.Authorization = `Bearer ${getOpenClawToken()}`; } catch (_) {}
  }
  try {
    const response = await fetch(`${base}/v1/models`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { reachable: false, backend: resolveBackend(), error: `HTTP ${response.status}` };
    }
    const data = (await response.json()) as any;
    const models = (data?.data || []).map((m: any) => m.id || m.name || "");
    return { reachable: true, backend: resolveBackend(), models };
  } catch (err: any) {
    return { reachable: false, backend: resolveBackend(), error: err.message };
  }
}

/**
 * Save a job report as a vault document.
 */
export function saveJobReportAsVaultDoc(
  project: string,
  taskId: string,
  taskTitle: string,
  report: string,
): void {
  const path = `reports/task-${taskId}-report.md`;
  addVaultDoc(
    path,
    `Task Report: ${taskTitle}`,
    report,
    "reports",
    project,
    JSON.stringify(["report", "completed"]),
    "completed",
    "[]",
    "📋",
  );
}
