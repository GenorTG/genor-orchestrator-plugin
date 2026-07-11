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
import { addVaultDoc, addWorkerTaskHistory, updateWorker, updateBacklogTask } from "./db.js";
let _config = {
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
export function configureLLM(patch) {
    _config = { ..._config, ...patch };
}
/** Get the active LLM config (read-only snapshot). */
export function getLLMConfig() {
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
export async function pickAvailableModel(preferred) {
    const base = _config.endpoint.replace(/\/chat\/completions$/, "");
    const headers = {};
    if (_config.token)
        headers.Authorization = `Bearer ${_config.token}`;
    const response = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
        throw new Error(`LLM endpoint /v1/models error ${response.status}`);
    }
    const data = (await response.json());
    const models = (data?.data || []).map((m) => m.id || m.name || "");
    if (!models.length)
        throw new Error("LLM endpoint reports no models");
    if (preferred && models.includes(preferred))
        return preferred;
    const candidate = models.find((m) => {
        if (m.includes("embed"))
            return false;
        return CHAT_MODEL_HINTS.some((hint) => m.toLowerCase().includes(hint));
    });
    return candidate || models[0];
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
export async function callLLM(opts) {
    const messages = [
        { role: "system", content: opts.systemPrompt },
    ];
    if (opts.history?.length) {
        for (const m of opts.history.slice(-20)) {
            if (m.role !== "system")
                messages.push(m);
        }
    }
    messages.push({ role: "user", content: opts.userMessage });
    const headers = {
        "Content-Type": "application/json",
    };
    if (_config.token)
        headers.Authorization = `Bearer ${_config.token}`;
    if (opts.sessionKey)
        headers["x-openclaw-session-key"] = opts.sessionKey;
    if (opts.backendModel)
        headers["x-openclaw-model"] = opts.backendModel;
    if (opts.messageChannel)
        headers["x-openclaw-message-channel"] = opts.messageChannel;
    else if (_config.defaultMessageChannel)
        headers["x-openclaw-message-channel"] = _config.defaultMessageChannel;
    const body = {
        model: _config.defaultModel,
        messages,
        max_completion_tokens: opts.maxTokens ?? 1024,
        temperature: 0.7,
        stream: false,
    };
    if (opts.user)
        body.user = opts.user;
    if (opts.tools?.length) {
        body.tools = opts.tools;
        if (opts.toolChoice)
            body.tool_choice = opts.toolChoice;
        else
            body.tool_choice = "auto";
    }
    else if (opts.toolChoice) {
        body.tool_choice = opts.toolChoice;
    }
    else {
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
        const data = (await response.json());
        const msg = data?.choices?.[0]?.message || {};
        const content = (msg.content || "").trim();
        const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls.map((tc) => ({
            id: tc.id,
            name: tc.function?.name || "",
            arguments: tc.function?.arguments || "{}",
        })) : undefined;
        if (!content && !toolCalls?.length) {
            throw new Error("LLM endpoint returned empty response");
        }
        return { content, toolCalls, raw: data };
    }
    catch (err) {
        if (err.name === "AbortError") {
            throw new Error(`LLM endpoint request timed out after ${_config.timeoutMs / 1000}s`);
        }
        if (err.message?.includes("fetch") || err.code === "ECONNREFUSED" || err.cause?.code === "ECONNREFUSED") {
            throw new Error(`Cannot reach LLM endpoint at ${_config.endpoint}. ` +
                `Check the URL, network, and auth. Error: ${err.message}`);
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
 * Health check for the configured LLM endpoint.
 * GETs /v1/models (lists agent targets for OpenClaw, loaded models for
 * LM Studio / vLLM, or empty list for opaque servers).
 */
export async function checkLLMHealth() {
    const base = _config.endpoint.replace(/\/chat\/completions$/, "");
    const headers = {};
    if (_config.token)
        headers.Authorization = `Bearer ${_config.token}`;
    try {
        const response = await fetch(`${base}/models`, {
            headers,
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
            return { reachable: false, endpoint: _config.endpoint, error: `HTTP ${response.status}` };
        }
        const data = (await response.json());
        const models = (data?.data || []).map((m) => m.id || m.name || "");
        return { reachable: true, endpoint: _config.endpoint, models };
    }
    catch (err) {
        return { reachable: false, endpoint: _config.endpoint, error: err.message };
    }
}
/** Backward-compat alias. */
export const checkLmStudioHealth = checkLLMHealth;
/**
 * Save a job report as a vault document.
 */
export function saveJobReportAsVaultDoc(project, taskId, taskTitle, report) {
    const path = `reports/task-${taskId}-report.md`;
    addVaultDoc(path, `Task Report: ${taskTitle}`, report, "reports", project, JSON.stringify(["report", "completed"]), "completed", "[]", "📋");
}
