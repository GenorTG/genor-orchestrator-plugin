/**
 * Worker Runtime — AI-powered worker execution engine.
 *
 * Workers call LM Studio (local) via fetch for real LLM responses.
 * No additional npm dependencies.
 */
import { addVaultDoc, addWorkerTaskHistory, updateWorker, updateBacklogTask } from "./db.js";
const LMSTUDIO_BASE = process.env.LMSTUDIO_BASE || "http://localhost:1234/v1";
const DEFAULT_MODEL = process.env.WORKER_MODEL || "local-model";
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
 * Call LM Studio (or any OpenAI-compatible endpoint) with a chat completion request.
 * Uses fetch, not OpenAI SDK — zero deps.
 */
export async function callLLM(opts) {
    const messages = [
        { role: "system", content: opts.systemPrompt },
    ];
    // Add history (last 10 messages for context, skipping any system overwrites)
    if (opts.history && opts.history.length > 0) {
        const recent = opts.history.slice(-10);
        for (const msg of recent) {
            if (msg.role !== "system") {
                messages.push({ role: msg.role, content: msg.content });
            }
        }
    }
    messages.push({ role: "user", content: opts.userMessage });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout
    try {
        const response = await fetch(`${LMSTUDIO_BASE}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: DEFAULT_MODEL,
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
            throw new Error("LM Studio request timed out after 30s — check if the server is running");
        }
        // Connection refused / not running
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
 * Check if LM Studio is reachable.
 */
export async function checkLmStudioHealth() {
    try {
        const response = await fetch(`${LMSTUDIO_BASE}/models`, {
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
            return { reachable: false, error: `HTTP ${response.status}` };
        }
        const data = (await response.json());
        const models = (data?.data || []).map((m) => m.id || m.name || "");
        return { reachable: true, models };
    }
    catch (err) {
        return { reachable: false, error: err.message };
    }
}
/**
 * Save a job report as a vault document.
 */
export function saveJobReportAsVaultDoc(project, taskId, taskTitle, report) {
    const path = `reports/task-${taskId}-report.md`;
    addVaultDoc(path, `Task Report: ${taskTitle}`, report, "reports", project, JSON.stringify(["report", "completed"]), "completed", "[]", "📋");
}
