/**
 * Worker Runtime — AI-powered worker execution engine.
 *
 * Generic OpenAI-compatible chat completions client. Works with any
 * endpoint that exposes `/v1/chat/completions` and supports tool calls.
 * The plugin auto-configures to use the local OpenClaw gateway on install,
 * but the endpoint and auth can be pointed at any compatible service.
 *
 * Per-worker session tracking:
 *   - `user` field in the OpenAI request body → server derives a stable
 *     session key (when the server supports it, like OpenClaw does)
 *   - `x-openclaw-session-key` header → explicit session routing
 *   - `x-openclaw-model` header → backend model override (premium burning)
 *   - `x-openclaw-message-channel` header → synthetic ingress context
 *
 * No npm dependencies. Native fetch only.
 */

import { WorkerRow, BacklogRow } from "./db.js";
import { addVaultDoc, addWorkerTaskHistory, updateWorker, updateBacklogTask } from "./db.js";

// ── Configuration ─────────────────────────────────────────────

export interface LLMConfig {
  /** Full URL to the chat completions endpoint, e.g. "http://127.0.0.1:18789/v1/chat/completions". */
  endpoint: string;
  /** Bearer token. May be empty for unauthenticated endpoints. */
  token: string;
  /** Default `model` field for the request body (the agent target like "openclaw"). */
  defaultModel: string;
  /** Default value for the x-openclaw-message-channel header. */
  defaultMessageChannel: string;
  /** Request timeout in milliseconds. */
  timeoutMs: number;
}

let _config: LLMConfig = {
  endpoint: process.env.LLM_ENDPOINT || "http://127.0.0.1:18789/v1/chat/completions",
  token: process.env.LLM_AUTH_TOKEN || "",
  defaultModel: process.env.LLM_DEFAULT_MODEL || "openclaw",
  defaultMessageChannel: process.env.LLM_MESSAGE_CHANNEL || "orchestrator-software-house",
  timeoutMs: 120_000,
};

/**
 * Set the LLM endpoint configuration. Called once at plugin register.
 * Any field can be omitted to keep the current value.
 */
export function configureLLM(patch: Partial<LLMConfig>): void {
  _config = { ..._config, ...patch };
}

/** Get the active LLM config (read-only snapshot). */
export function getLLMConfig(): Readonly<LLMConfig> {
  return { ..._config };
}

// ponytail: prefer non-embedding chat model names for fallback selection.
const CHAT_MODEL_HINTS = ["gemma", "qwen", "llama", "mistral", "minimax", "deepseek", "command"];

/**
 * Pick an available model from the endpoint's /v1/models list.
 * Honors the preferred name if loaded. Otherwise returns the first
 * non-embedding chat model. Used as a fallback when no explicit model
 * is given in the request.
 */
export async function pickAvailableModel(preferred?: string): Promise<string> {
  const base = _config.endpoint.replace(/\/chat\/completions$/, "");
  const headers: Record<string, string> = {};
  if (_config.token) headers.Authorization = `Bearer ${_config.token}`;
  const response = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    throw new Error(`LLM endpoint /v1/models error ${response.status}`);
  }
  const data = (await response.json()) as any;
  const models: string[] = (data?.data || []).map((m: any) => m.id || m.name || "");
  if (!models.length) throw new Error("LLM endpoint reports no models");
  if (preferred && models.includes(preferred)) return preferred;
  const candidate = models.find((m) => {
    if (m.includes("embed")) return false;
    return CHAT_MODEL_HINTS.some((hint) => m.toLowerCase().includes(hint));
  });
  return candidate || models[0];
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
/**
 * Call an OpenAI-compatible chat completions endpoint.
 *
 * Talks to whatever endpoint was set via `configureLLM()` (or env vars
 * LLM_ENDPOINT, LLM_AUTH_TOKEN, LLM_DEFAULT_MODEL, LLM_MESSAGE_CHANNEL).
 * The plugin auto-configures to use the local OpenClaw gateway on install.
 *
 * Per-worker session tracking (OpenClaw-style extensions; ignored by other
 * servers that don't read them):
 *   - `user` field → server derives a stable session key
 *   - `x-openclaw-session-key` → explicit session routing
 *   - `x-openclaw-model` → backend model override (e.g. "openai/gpt-5.4")
 *   - `x-openclaw-message-channel` → synthetic ingress context
 *
 * Tool calls: pass `tools` as the standard OpenAI tools array. The endpoint
 * must support function calling. If `tools` is set and the response contains
 * `tool_calls`, those are returned via the `CallLLMResult` shape.
 *
 * History: if the server supports session derivation from `user` (OpenClaw
 * does), you don't need to ship the history array — the server has it. For
 * stateless endpoints, pass `history` explicitly.
 */
export interface CallLLMResult {
  /** Assistant text (may be empty if the response is only tool calls). */
  content: string;
  /** Tool calls requested by the model (when tools were provided). */
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  /** Raw response for callers that need more. */
  raw: any;
}

export async function callLLM(opts: {
  systemPrompt: string;
  userMessage: string;
  /** Per-worker stable identifier. Used as the `user` field; the server
   *  uses it to derive a session key when supported. */
  user?: string;
  /** Optional explicit session routing (x-openclaw-session-key header). */
  sessionKey?: string;
  /** Optional ingress context (x-openclaw-message-channel header). */
  messageChannel?: string;
  /** Optional backend model override (x-openclaw-model header). */
  backendModel?: string;
  /** OpenAI-style tools array. When set, the server may respond with tool_calls. */
  tools?: Array<Record<string, any>>;
  /** Force tool use: "auto" | "none" | "required" | { type: "function", function: { name } }. */
  toolChoice?: string | Record<string, any>;
  /** Optional chat history (for stateless endpoints that don't derive sessions). */
  history?: Array<{ role: string; content: string }>;
  maxTokens?: number;
}): Promise<CallLLMResult> {
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: opts.systemPrompt },
  ];
  if (opts.history?.length) {
    for (const m of opts.history.slice(-20)) {
      if (m.role !== "system") messages.push(m);
    }
  }
  messages.push({ role: "user", content: opts.userMessage });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (_config.token) headers.Authorization = `Bearer ${_config.token}`;
  if (opts.sessionKey) headers["x-openclaw-session-key"] = opts.sessionKey;
  if (opts.backendModel) headers["x-openclaw-model"] = opts.backendModel;
  if (opts.messageChannel) headers["x-openclaw-message-channel"] = opts.messageChannel;
  else if (_config.defaultMessageChannel) headers["x-openclaw-message-channel"] = _config.defaultMessageChannel;

  const body: Record<string, any> = {
    model: _config.defaultModel,
    messages,
    max_completion_tokens: opts.maxTokens ?? 1024,
    temperature: 0.7,
    stream: false,
  };
  if (opts.user) body.user = opts.user;
  if (opts.tools?.length) {
    body.tools = opts.tools;
    if (opts.toolChoice) body.tool_choice = opts.toolChoice;
    else body.tool_choice = "auto";
  } else if (opts.toolChoice) {
    body.tool_choice = opts.toolChoice;
  } else {
    // No tools requested — force the model to respond in plain text.
    // The default for session-based backends (e.g. openclaw) is to attempt
    // tool calls when the session has tools attached, which returns an
    // "Agent couldn't generate a response" error on a plain chat completions
    // endpoint that has no tool runtime. See dogfood run 2026-07-11.
    body.tool_choice = "none";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), _config.timeoutMs);
  try {
    const response = await fetch(_config.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`LLM endpoint error ${response.status} at ${_config.endpoint}: ${errorText.slice(0, 300)}`);
    }

    const data = (await response.json()) as any;
    const msg = data?.choices?.[0]?.message || {};
    const content = (msg.content || "").trim();
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls.map((tc: any) => ({
      id: tc.id,
      name: tc.function?.name || "",
      arguments: tc.function?.arguments || "{}",
    })) : undefined;

    if (!content && !toolCalls?.length) {
      throw new Error("LLM endpoint returned empty response");
    }
    return { content, toolCalls, raw: data };
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error(`LLM endpoint request timed out after ${_config.timeoutMs / 1000}s`);
    }
    if (err.message?.includes("fetch") || err.code === "ECONNREFUSED" || err.cause?.code === "ECONNREFUSED") {
      throw new Error(
        `Cannot reach LLM endpoint at ${_config.endpoint}. ` +
        `Check the URL, network, and auth. Error: ${err.message}`
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

  const result = await callLLM({
    systemPrompt,
    userMessage: prompt,
    maxTokens: 1536,
  });
  return result.content;
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
 * Health check for the configured LLM endpoint.
 * GETs /v1/models (lists agent targets for OpenClaw, loaded models for
 * LM Studio / vLLM, or empty list for opaque servers).
 */
export async function checkLLMHealth(): Promise<{
  reachable: boolean;
  endpoint: string;
  error?: string;
  models?: string[];
}> {
  const base = _config.endpoint.replace(/\/chat\/completions$/, "");
  const headers: Record<string, string> = {};
  if (_config.token) headers.Authorization = `Bearer ${_config.token}`;
  try {
    const response = await fetch(`${base}/models`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { reachable: false, endpoint: _config.endpoint, error: `HTTP ${response.status}` };
    }
    const data = (await response.json()) as any;
    const models = (data?.data || []).map((m: any) => m.id || m.name || "");
    return { reachable: true, endpoint: _config.endpoint, models };
  } catch (err: any) {
    return { reachable: false, endpoint: _config.endpoint, error: err.message };
  }
}

/** Backward-compat alias. */
export const checkLmStudioHealth = checkLLMHealth;

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
