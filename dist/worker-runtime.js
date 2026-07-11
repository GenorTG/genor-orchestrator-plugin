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
import { addVaultDoc, addWorkerTaskHistory, updateWorker, updateBacklogTask } from "./db.js";
import { readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// ponytail: lazy env read so tests can set the env var before first call.
function resolveBackend() {
    return process.env.WORKER_LLM_BACKEND || "openclaw";
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
        }
        catch (_) {
            const port = process.env.OPENCLAW_GATEWAY_PORT || 18789;
            return `http://127.0.0.1:${port}`;
        }
    })();
// ponytail: cached at module load. Token is stable for the gateway lifetime.
let _openclawToken = null;
function getOpenClawToken() {
    if (_openclawToken)
        return _openclawToken;
    // Same lookup logic as base URL.
    const candidates = [
        process.env.OPENCLAW_GATEWAY_TOKEN,
        process.env.OPENCLAW_GATEWAY_PASSWORD,
    ];
    for (const c of candidates)
        if (c) {
            _openclawToken = c;
            return c;
        }
    try {
        const cfgPath = process.env.OPENCLAW_CONFIG || path.join(os.homedir(), ".openclaw", "openclaw.json");
        const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
        const auth = cfg?.gateway?.auth;
        const t = auth?.token || auth?.password;
        if (t) {
            _openclawToken = t;
            return t;
        }
    }
    catch (_) { }
    throw new Error("OpenClaw gateway token not found. Set OPENCLAW_GATEWAY_TOKEN env var " +
        "or ensure ~/.openclaw/openclaw.json has gateway.auth.token");
}
// ponytail: prefer non-embedding chat models; gemma/qwen prefixes are usually chat.
const CHAT_MODEL_HINTS = ["gemma", "qwen", "llama", "mistral", "minimax", "deepseek", "command"];
export async function pickAvailableModel(preferred) {
    const health = await checkLmStudioHealth();
    if (!health.reachable || !health.models?.length) {
        throw new Error("LM Studio unreachable — cannot pick a model");
    }
    // Honor the preferred name if it's actually loaded
    if (preferred && health.models.includes(preferred))
        return preferred;
    // Otherwise pick the first non-embedding chat model
    const candidate = health.models.find((m) => {
        if (m.includes("embed"))
            return false;
        return CHAT_MODEL_HINTS.some((hint) => m.toLowerCase().includes(hint));
    });
    return candidate || health.models[0];
}
// ── Role-based system prompts ──
const ROLE_PROMPTS = {
    developer: "You are a software developer working in a software house. Write clean, maintainable code. " +
        "Follow best practices, test your work, and report clearly what you built. " +
        "Keep responses technical and concise. Provide code when relevant.",
    designer: "You are a UI/UX designer in a software house. Focus on usability, accessibility, and visual polish. " +
        "Provide design rationale and concrete suggestions. Be constructive and specific.",
    pm: "You are a project manager coordinating a software team. Plan sprints, track progress, " +
        "identify blockers, and report status clearly. Be diplomatic and action-oriented.",
    qa: "You are a QA engineer. Find bugs, verify requirements, write test cases, and report issues clearly. " +
        "Be thorough but constructive. Distinguish between critical and cosmetic issues.",
    default: "You are a helpful AI worker in a software house. Complete tasks assigned to you and " +
        "report your work clearly. Be concise and professional.",
};
/**
 * Build a system prompt for a worker based on their role, name, and current context.
 */
export function buildSystemPrompt(worker, project, taskTitle, taskDescription) {
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
    const lines = [
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
export async function callLLM(opts) {
    const backend = opts.backend || resolveBackend();
    if (backend === "openclaw")
        return callOpenClaw(opts);
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
async function callOpenClaw(opts) {
    // ponytail: system prompt goes in the first message per OpenAI spec.
    // OpenClaw already tracks session history from previous calls with the
    // same `user` value, so we don't need to send the history array.
    const messages = [
        { role: "system", content: opts.systemPrompt },
        { role: "user", content: opts.userMessage },
    ];
    const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getOpenClawToken()}`,
    };
    if (opts.sessionKey)
        headers["x-openclaw-session-key"] = opts.sessionKey;
    if (opts.backendModel)
        headers["x-openclaw-model"] = opts.backendModel;
    if (opts.messageChannel)
        headers["x-openclaw-message-channel"] = opts.messageChannel;
    const body = {
        model: "openclaw", // default agent
        messages,
        max_completion_tokens: opts.maxTokens ?? 1024,
        temperature: 0.7,
        stream: false,
    };
    // `user` field drives session derivation; reuse the same value per worker.
    if (opts.user)
        body.user = opts.user;
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
        const data = (await response.json());
        const content = data?.choices?.[0]?.message?.content;
        if (!content) {
            throw new Error("OpenClaw returned empty response");
        }
        return content.trim();
    }
    catch (err) {
        if (err.name === "AbortError") {
            throw new Error("OpenClaw request timed out after 60s");
        }
        if (err.message?.includes("fetch") || err.code === "ECONNREFUSED" || err.cause?.code === "ECONNREFUSED") {
            throw new Error(`Cannot reach OpenClaw gateway at ${OPENCLAW_BASE}. ` +
                `Is the gateway running? Error: ${err.message}`);
        }
        throw err;
    }
    finally {
        clearTimeout(timeout);
    }
}
/**
 * Call LM Studio (legacy backend). Same OpenAI-compatible format, no auth.
 */
async function callLmStudio(opts) {
    const messages = [
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
        const data = (await response.json());
        const content = data?.choices?.[0]?.message?.content;
        if (!content) {
            throw new Error("LM Studio returned empty response");
        }
        return content.trim();
    }
    catch (err) {
        if (err.name === "AbortError") {
            throw new Error("LM Studio request timed out after 30s");
        }
        if (err.message?.includes("fetch") || err.code === "ECONNREFUSED" || err.cause?.code === "ECONNREFUSED") {
            throw new Error(`Cannot reach LM Studio at ${LMSTUDIO_BASE}. ` +
                `Make sure LM Studio is running and a model is loaded. Error: ${err.message}`);
        }
        throw err;
    }
    finally {
        clearTimeout(timeout);
    }
}
/**
 * Generate a structured job report for a completed task by calling the LLM.
 */
export async function generateJobReport(opts) {
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
    const systemPrompt = "You generate concise, structured job reports for a software house. " +
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
export async function reportWorkerActivity(opts) {
    // Store in worker_task_history
    addWorkerTaskHistory(opts.workerId, opts.taskId ?? null, opts.action, JSON.stringify({ message: opts.message, ts: new Date().toISOString() }));
    // Update worker status if provided
    if (opts.workerStatus) {
        updateWorker(opts.workerId, { status: opts.workerStatus });
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
export async function checkLmStudioHealth() {
    const base = resolveBackend() === "openclaw" ? OPENCLAW_BASE : LMSTUDIO_BASE;
    const headers = {};
    if (resolveBackend() === "openclaw") {
        try {
            headers.Authorization = `Bearer ${getOpenClawToken()}`;
        }
        catch (_) { }
    }
    try {
        const response = await fetch(`${base}/v1/models`, {
            headers,
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
            return { reachable: false, backend: resolveBackend(), error: `HTTP ${response.status}` };
        }
        const data = (await response.json());
        const models = (data?.data || []).map((m) => m.id || m.name || "");
        return { reachable: true, backend: resolveBackend(), models };
    }
    catch (err) {
        return { reachable: false, backend: resolveBackend(), error: err.message };
    }
}
/**
 * Save a job report as a vault document.
 */
export function saveJobReportAsVaultDoc(project, taskId, taskTitle, report) {
    const path = `reports/task-${taskId}-report.md`;
    addVaultDoc(path, `Task Report: ${taskTitle}`, report, "reports", project, JSON.stringify(["report", "completed"]), "completed", "[]", "📋");
}
