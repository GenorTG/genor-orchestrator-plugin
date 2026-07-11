/**
 * Software House API routes for the orchestrator dashboard.
 *
 * Provides endpoints for the Software House UI:
 * - Bootstrap: full project state
 * - Workers: CRUD operations
 * - Rooms: CRUD operations
 * - Backlog: task management with LLM-powered worker execution
 * - PM Chat: persistent messaging with real LLM responses
 * - Vault: document management including job reports
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import * as store from "./store.js";
import { buildSystemPrompt, callLLM, generateJobReport, reportWorkerActivity, saveJobReportAsVaultDoc, checkLmStudioHealth, } from "./worker-runtime.js";
import { setProjectConfig, getProjectConfig, deleteProjectConfig, listWorkers, getWorker, addWorker, updateWorker, deleteWorker, deleteWorkersByProject, listRooms, addRoom, updateRoom, deleteRoom, listVaultDocs, getVaultDoc, addVaultDoc, deleteVaultDocsByProject, addPmChat, clearPmChat, addBacklogTask, updateBacklogTask, getBacklogTask, listBacklogTasks, deleteBacklogByProject, deleteSessionsByProject, deleteStateEventsByProject, addWorkerTaskHistory, listWorkerTaskHistory, getWorkerLastActivity, getStalledTasksForWorker, addWorkerMessage, listWorkerMessages, deleteWorkerMessagesByWorker, deleteWorkerMessagesByProject, deleteWorkerSessionsByWorker, deleteWorkerSessionsByProject, deleteWorkerTaskHistoryByWorker, deleteWorkerTaskHistoryByProject, clearStateForProject } from "./db.js";
import { getDataDir } from "./shared.js";
// ── HELPERS ──────────────────────────────────────────────────
function json(res, data, status = 200) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
}
function parseBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString()));
            }
            catch (e) {
                reject(e);
            }
        });
        req.on("error", reject);
    });
}
function getProject(req) {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    return url.searchParams.get("project") || null;
}
// ── GIT HELPERS ────────────────────────────────────────────────
function gitExec(location, args, timeout = 15000) {
    if (!fs.existsSync(path.join(location, ".git")))
        return "";
    try {
        return execSync(`git ${args.join(" ")}`, {
            cwd: location,
            encoding: "utf-8",
            timeout,
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    }
    catch {
        return "";
    }
}
function getRepoStatus(location) {
    const gitDir = path.join(location, ".git");
    if (!fs.existsSync(gitDir)) {
        return { hasRepo: false };
    }
    const branch = gitExec(location, ["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown";
    const lastCommitRaw = gitExec(location, ["log", "--oneline", "-1"]);
    const lastCommit = lastCommitRaw || "";
    const remote = gitExec(location, ["remote", "get-url", "origin"]) || "";
    const statusOut = gitExec(location, ["status", "--porcelain"]) || "";
    const dirty = statusOut.length > 0;
    let ahead = 0;
    let behind = 0;
    if (remote) {
        try {
            const revList = gitExec(location, ["rev-list", "--left-right", "--count", `${branch}...${branch}@{upstream}`], 10000);
            if (revList) {
                const parts = revList.split(/\s+/);
                ahead = parseInt(parts[0], 10) || 0;
                behind = parseInt(parts[1], 10) || 0;
            }
        }
        catch { /* no upstream */ }
    }
    return { hasRepo: true, branch, dirty, lastCommit, remote, ahead, behind };
}
// ── BOOTSTRAP ────────────────────────────────────────────────
/**
 * GET /api/software-house/bootstrap
 * Returns full project state from store.
 */
export async function handleBootstrap(req, res) {
    const project = getProject(req) || "genor-orchestrator-plugin";
    const data = store.getProjectBootstrap(project);
    json(res, { ok: true, ...data });
}
// ── WORKERS ──────────────────────────────────────────────────
/**
 * GET /api/software-house/workers
 * List all workers for a project.
 */
export async function handleWorkersGet(req, res) {
    const project = getProject(req) || "genor-orchestrator-plugin";
    const workers = store.listWorkers(project);
    json(res, workers);
}
/**
 * POST /api/software-house/workers/hire
 * Create a new worker with system prompt and model.
 */
export async function handleWorkerHire(req, res) {
    const body = await parseBody(req);
    const { id: providedId, name, role, sprite, model, prompt, room, project, is_pm } = body;
    if (!name) {
        json(res, { error: "name required" }, 400);
        return;
    }
    const id = providedId || `w${Date.now()}`;
    const proj = project || "genor-orchestrator-plugin";
    // Build default system prompt from role if not provided
    const workerRole = role || "developer";
    const defaultPrompt = prompt || `You are a ${workerRole} working on the ${proj} project. Complete your tasks and report progress clearly.`;
    addWorker(id, name, workerRole, sprite || "blue", model || "", defaultPrompt, room || "", proj, is_pm ? 1 : 0);
    // Record hire in task history
    addWorkerTaskHistory(id, null, "hired", JSON.stringify({
        name, role: workerRole, project: proj,
        hiredAt: new Date().toISOString()
    }));
    json(res, { ok: true, worker: { id, name, role: workerRole } });
}
/**
 * PATCH /api/software-house/workers/:id
 * Edit an existing worker.
 */
export async function handleWorkerEdit(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const id = url.pathname.split("/").pop();
    if (!id) {
        json(res, { error: "worker id required" }, 400);
        return;
    }
    const body = await parseBody(req);
    const updates = {};
    for (const [key, value] of Object.entries(body)) {
        if (["name", "role", "sprite", "model", "prompt", "room", "is_pm"].includes(key)) {
            updates[key] = key === "is_pm" ? (value ? 1 : 0) : value;
        }
    }
    if (Object.keys(updates).length === 0) {
        json(res, { error: "no valid fields to update" }, 400);
        return;
    }
    updateWorker(id, updates);
    json(res, { ok: true, id });
}
/**
 * DELETE /api/software-house/workers/:id
 * Fire a worker — cleans up all associated data.
 */
export async function handleWorkerFire(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const id = url.pathname.split("/").pop();
    if (!id) {
        json(res, { error: "worker id required" }, 400);
        return;
    }
    // Record firing in history before deleting
    addWorkerTaskHistory(id, null, "fired", JSON.stringify({
        firedAt: new Date().toISOString()
    }));
    // Clean up associated data
    deleteWorkerMessagesByWorker(id);
    deleteWorkerSessionsByWorker(id);
    deleteWorkerTaskHistoryByWorker(id);
    deleteWorker(id);
    json(res, { ok: true, id });
}
// ── ROOMS ────────────────────────────────────────────────────
/**
 * GET /api/software-house/rooms
 * List all rooms for a project.
 */
export async function handleRoomsGet(req, res) {
    const project = getProject(req) || "genor-orchestrator-plugin";
    const rooms = store.listRooms(project);
    json(res, rooms);
}
/**
 * POST /api/software-house/rooms
 * Add a new room.
 */
export async function handleRoomAdd(req, res) {
    const body = await parseBody(req);
    const { id: providedId, name, purpose, taskTypes, project } = body;
    if (!name) {
        json(res, { error: "name required" }, 400);
        return;
    }
    const id = providedId || `room_${Date.now().toString(36)}`;
    addRoom(id, name, purpose || "", JSON.stringify(taskTypes || []), project || "genor-orchestrator-plugin");
    json(res, { ok: true, room: { id, name } });
}
/**
 * PATCH /api/software-house/rooms/:id
 * Edit an existing room.
 */
export async function handleRoomEdit(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const id = url.pathname.split("/").pop();
    if (!id) {
        json(res, { error: "room id required" }, 400);
        return;
    }
    const body = await parseBody(req);
    const updates = {};
    for (const [key, value] of Object.entries(body)) {
        if (["name", "purpose", "taskTypes", "x", "y", "w", "h", "isCommand"].includes(key)) {
            updates[key] = key === "taskTypes" ? JSON.stringify(value) : value;
        }
    }
    if (Object.keys(updates).length === 0) {
        json(res, { error: "no valid fields to update" }, 400);
        return;
    }
    updateRoom(id, updates);
    json(res, { ok: true, id });
}
/**
 * DELETE /api/software-house/rooms/:id
 * Delete a room.
 */
export async function handleRoomDelete(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const id = url.pathname.split("/").pop();
    if (!id) {
        json(res, { error: "room id required" }, 400);
        return;
    }
    deleteRoom(id);
    json(res, { ok: true, id });
}
/**
 * POST /api/software-house/layout/save
 * Save room positions.
 */
export async function handleLayoutSave(req, res) {
    const body = await parseBody(req);
    const { rooms } = body;
    if (!Array.isArray(rooms)) {
        json(res, { error: "rooms array required" }, 400);
        return;
    }
    for (const room of rooms) {
        updateRoom(room.id, { x: room.x || 0, y: room.y || 0, w: room.w || 0, h: room.h || 0 });
    }
    json(res, { ok: true });
}
// ── BACKLOG ──────────────────────────────────────────────────
/**
 * GET /api/software-house/backlog
 * List all tasks for a project.
 */
export async function handleBacklogGet(req, res) {
    const project = getProject(req) || "genor-orchestrator-plugin";
    const tasks = store.listBacklog(project);
    json(res, tasks);
}
/**
 * POST /api/software-house/backlog
 * Create a new task.
 */
export async function handleBacklogCreate(req, res) {
    const body = await parseBody(req);
    const { title, description, priority, labels, project } = body;
    if (!title) {
        json(res, { error: "title required" }, 400);
        return;
    }
    const proj = project || "genor-orchestrator-plugin";
    const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    addBacklogTask({
        id,
        project: proj,
        title,
        description: description || '',
        priority: priority || 'p2',
        status: 'todo',
        labels: JSON.stringify(labels || []),
        depends_on: '[]',
        assigned_to: '',
        session_refs: '[]',
        created_ts: Math.floor(Date.now() / 1000),
        updated_ts: Math.floor(Date.now() / 1000),
    });
    json(res, { ok: true, id });
}
/**
 * POST /api/software-house/backlog/move
 * Move a task to a different phase (simple version — no LLM).
 */
export async function handleBacklogMove(req, res) {
    const body = await parseBody(req);
    const { id, phase, worker_id } = body;
    if (!id) {
        json(res, { error: "task id required" }, 400);
        return;
    }
    const updates = {};
    if (phase)
        updates.status = phase;
    if (worker_id !== undefined)
        updates.worker_id = worker_id;
    updateBacklogTask(id, updates);
    json(res, { ok: true, id });
}
/**
 * POST /api/software-house/backlog/move-v2
 * Move a task with LLM-powered worker activation.
 * When moving to in_progress → triggers worker thinking/response.
 * When moving to done → generates job report and stores in vault.
 */
export async function handleBacklogMoveV2(req, res) {
    const body = await parseBody(req);
    const { id, phase, worker_id } = body;
    if (!id) {
        json(res, { error: "task id required" }, 400);
        return;
    }
    const task = getBacklogTask(id);
    if (!task) {
        json(res, { error: "task not found" }, 404);
        return;
    }
    const proj = task.project;
    const wid = worker_id || task.worker_id || "";
    // Update basic fields
    const updates = { status: phase || task.status };
    if (worker_id !== undefined)
        updates.worker_id = worker_id;
    updateBacklogTask(id, updates);
    // ── LLM trigger: task moved to in_progress ──
    if (phase === "in_progress" || phase === "in-progress") {
        const worker = wid ? getWorker(wid) : undefined;
        if (worker) {
            updateWorker(wid, { status: "thinking" });
            reportWorkerActivity({
                workerId: wid,
                taskId: parseInt(id.replace(/[^0-9]/g, ""), 10) || undefined,
                action: "started",
                message: `Started working on task: ${task.title}`,
                workerStatus: "thinking",
            });
            // Try to get LLM initial response (non-blocking for HTTP response)
            try {
                const systemPrompt = buildSystemPrompt(worker, proj, task.title, task.description);
                const response = await callLLM({
                    systemPrompt,
                    userMessage: `You've been assigned this task: "${task.title}". ${task.description ? `Details: ${task.description}` : ""}\n\nAcknowledge the task, outline your approach, and start working. Keep it concise.`,
                    maxTokens: 512,
                    preferredModel: worker.model || undefined,
                });
                addWorkerTaskHistory(wid, parseInt(id.replace(/[^0-9]/g, ""), 10) || null, "reported", JSON.stringify({ message: response, ts: new Date().toISOString() }));
                updateWorker(wid, { status: "working" });
            }
            catch {
                // LLM unreachable — worker stays in "thinking" but operation succeeds
                updateWorker(wid, { status: "working" });
            }
        }
    }
    // ── LLM trigger: task moved to done ──
    if (phase === "done") {
        const worker = wid ? getWorker(wid) : undefined;
        if (worker) {
            // Gather work history for this task
            const history = listWorkerTaskHistory(wid, 100);
            const numericTaskId = parseInt(id.replace(/[^0-9]/g, ""), 10);
            const taskHistory = history.filter((h) => h.task_id === numericTaskId || String(h.task_id) === id);
            const workLog = taskHistory.map((h) => {
                try {
                    const d = JSON.parse(h.details || "{}");
                    return `[${h.action}] ${d.message || d.ts || ""}`;
                }
                catch {
                    return `[${h.action}] ${h.details || ""}`;
                }
            });
            // Get worker messages about this task
            const workerMsgs = listWorkerMessages(wid);
            const taskMsgs = workerMsgs.filter((m) => m.task_id === numericTaskId || String(m.task_id) === id);
            for (const msg of taskMsgs) {
                workLog.push(`[message from ${msg.from_worker}]: ${msg.content}`);
            }
            reportWorkerActivity({
                workerId: wid,
                taskId: numericTaskId || undefined,
                action: "completed",
                message: `Task "${task.title}" marked as done. Generating report.`,
                workerStatus: "sleep",
            });
            // Generate job report (fire-and-forget)
            generateJobReport({
                workerName: worker.name,
                workerRole: worker.role,
                taskTitle: task.title,
                taskDescription: task.description || "",
                workLog,
            }).then(report => {
                saveJobReportAsVaultDoc(proj, id, task.title, report);
                addWorkerTaskHistory(wid, numericTaskId || null, "reported", JSON.stringify({ message: "Job report generated: " + report.slice(0, 200), ts: new Date().toISOString() }));
            }).catch(() => {
                // Fallback: text report without LLM
                const fallbackReport = [
                    `# Task Report: ${task.title}`,
                    ``,
                    `## Summary`,
                    `Task completed by ${worker.name}.`,
                    ``,
                    `## What Was Done`,
                    ...workLog.map(line => `- ${line}`),
                    ``,
                    `## Outcome`,
                    `Task was completed successfully.`,
                ].join("\n");
                saveJobReportAsVaultDoc(proj, id, task.title, fallbackReport);
            });
        }
    }
    json(res, { ok: true, id });
}
// ── PM CHAT ──────────────────────────────────────────────────
/**
 * GET /api/software-house/pm/chat
 * Load chat history for a project.
 */
export async function handlePmChatGet(req, res) {
    const project = getProject(req) || "genor-orchestrator-plugin";
    const messages = store.listPmChat(project);
    json(res, { ok: true, messages: messages.reverse() });
}
/**
 * POST /api/software-house/pm/chat
 * Send a message. Uses real LLM via worker runtime if available,
 * falls back to keyword-based response if LM Studio is unreachable.
 */
export async function handlePmChatPost(req, res) {
    const body = await parseBody(req);
    const { message, sender, project } = body;
    if (!message) {
        json(res, { error: "message required" }, 400);
        return;
    }
    const proj = project || "genor-orchestrator-plugin";
    // Store user message
    addPmChat(message, sender || "user", proj);
    // Get project state for context
    const workers = listWorkers(proj);
    const tasks = listBacklogTasks(proj);
    // Find a PM worker
    const pmWorker = workers.find(w => w.is_pm === 1) || workers[0];
    let pmResponse = null;
    // Try real LLM first
    if (pmWorker) {
        try {
            const activeTasks = tasks.filter(t => t.status !== 'done');
            const stateSummary = [
                `Project: ${proj}`,
                `Workers: ${workers.length} (${workers.filter(w => w.status === 'working').length} working, ${workers.filter(w => ['sleep', 'idle'].includes(w.status)).length} idle)`,
                `Active tasks: ${activeTasks.length}`,
            ].join('\n');
            const systemPrompt = buildSystemPrompt({ name: pmWorker.name, role: pmWorker.role, prompt: pmWorker.prompt }, proj);
            // Get recent chat history
            const chatHistory = store.listPmChat(proj);
            const recentMessages = chatHistory.slice(-10).map(m => ({
                role: m.sender === 'user' ? 'user' : 'assistant',
                content: m.message,
            }));
            const userPrompt = [
                `Current state:\n${stateSummary}`,
                ``,
                `User message: ${message}`,
                ``,
                `Respond as a project manager. Be helpful and concise. Use emojis sparingly.`,
                `Reference workers, tasks, and project state naturally.`,
                `If you cannot answer something, be honest.`,
            ].join('\n');
            pmResponse = await callLLM({
                systemPrompt,
                userMessage: userPrompt,
                history: recentMessages,
                maxTokens: 512,
                preferredModel: pmWorker.model || undefined,
            });
            addPmChat(pmResponse, 'pm', proj);
            json(res, { ok: true });
            return;
        }
        catch {
            // LLM failed — fall through to keyword response
            pmResponse = null;
        }
    }
    // Fallback: keyword-based response
    if (!pmResponse) {
        const lower = message.toLowerCase();
        const workingCount = workers.filter(w => w.status === 'working').length;
        const sleepCount = workers.filter(w => ['sleep', 'idle'].includes(w.status)).length;
        const errorCount = workers.filter(w => w.status === 'error').length;
        const activeTasks = tasks.filter(t => t.status !== 'done').length;
        if (lower.includes('status') || lower.includes('raport')) {
            pmResponse = `📊 <b>Status projektu ${proj}</b><br>` +
                `• ${workers.length} workerów (${workingCount} pracuje, ${sleepCount} śpi, ${errorCount} błędów)<br>` +
                `• ${activeTasks} aktywnych tasków<br>` +
                workers.map(w => `• ${w.name}: ${w.status}${w.task ? ' — ' + w.task : ''}`).join('<br>');
        }
        else if (lower.includes('plan') || lower.includes('sprint')) {
            const backlog = tasks.filter(t => t.status === 'backlog').length;
            const inProgress = tasks.filter(t => t.status === 'in-progress').length;
            const review = tasks.filter(t => t.status === 'review').length;
            pmResponse = `📋 <b>Plan sprintu</b><br>` +
                `• Backlog: ${backlog} tasków<br>` +
                `• W toku: ${inProgress}<br>` +
                `• Review: ${review}<br>` +
                `• Zalecam priorytetyzację blokujących tasków.`;
        }
        else if (lower.includes('zatrud') || lower.includes('hire') || lower.includes('nowy')) {
            pmResponse = `👋 Otwieram formularz zatrudnienia. Kliknij <b>+ Zatrudnij</b> przy pokoju.`;
        }
        else if (lower.includes('błąd') || lower.includes('error') || lower.includes('problem')) {
            const errorWorkers = workers.filter(w => w.status === 'error');
            if (errorWorkers.length) {
                pmResponse = `🚧 <b>Blokery (${errorWorkers.length})</b><br>` +
                    errorWorkers.map(w => `• ${w.name}: ${w.task || 'błąd agenta'}`).join('<br>') +
                    '<br>Przywróć workery lub przydziel nowe zadania.';
            }
            else {
                pmResponse = '✅ Brak błędów — zespół działa płynnie.';
            }
        }
        else if (lower.includes('task') || lower.includes('zadani')) {
            const active = tasks.filter(t => t.status !== 'done');
            pmResponse = `📋 <b>Zadania (${active.length})</b><br>` +
                active.slice(0, 8).map(t => `• ${t.priority} ${t.title} (${t.status})`).join('<br>') +
                (active.length > 8 ? '<br>…' : '');
        }
        else if (lower.includes('help') || lower.includes('pomoc')) {
            pmResponse = `💡 Mogę pomóc z:<br>` +
                `• <b>status</b> — raport zespołu<br>` +
                `• <b>plan</b> — plan sprintu<br>` +
                `• <b>zatrudnij</b> — formularz hiringu<br>` +
                `• <b>błąd</b> — lista blokerów<br>` +
                `• <b>taski</b> — lista zadań`;
        }
        else {
            pmResponse = `Rozumiem. Mogę pokazać <b>status</b>, stworzyć <b>plan</b>, sprawdzić <b>błędy</b> albo <b>zatrudnić</b> kogoś.`;
        }
        if (pmResponse) {
            addPmChat(pmResponse, 'pm', proj);
        }
        json(res, { ok: true, fallback: true });
    }
}
// ── VAULT ────────────────────────────────────────────────────
/**
 * GET /api/software-house/vault/tree
 * List all documents for a project.
 */
export async function handleVaultTree(req, res) {
    const project = getProject(req) || "genor-orchestrator-plugin";
    const vault = store.listVaultDocs(project);
    json(res, { ok: true, vault });
}
/**
 * GET /api/software-house/vault/doc
 * Get a document by path.
 */
export async function handleVaultDocGet(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const docPath = url.searchParams.get("path");
    const project = url.searchParams.get("project") || "genor-orchestrator-plugin";
    if (!docPath) {
        json(res, { error: "path required" }, 400);
        return;
    }
    const doc = getVaultDoc(docPath, project);
    if (!doc) {
        json(res, { error: "document not found" }, 404);
        return;
    }
    json(res, doc);
}
/**
 * PUT /api/software-house/vault/doc
 * Update a document.
 */
export async function handleVaultDocPut(req, res) {
    const body = await parseBody(req);
    const { path, content, title, tags, status, links, project } = body;
    if (!path) {
        json(res, { error: "path required" }, 400);
        return;
    }
    addVaultDoc(path, title || path, content || "", "", project || "genor-orchestrator-plugin", JSON.stringify(tags || []), status || "", JSON.stringify(links || []));
    json(res, { ok: true, path });
}
/**
 * POST /api/software-house/vault/inject
 * Inject a document into AI context.
 */
export async function handleVaultInject(req, res) {
    const body = await parseBody(req);
    const { path, content, project } = body;
    if (!path) {
        json(res, { error: "path required" }, 400);
        return;
    }
    const proj = project || "genor-orchestrator-plugin";
    const title = path.split('/').pop()?.replace(/\.md$/, '') || path;
    const folder = path.includes('/') ? path.split('/').slice(0, -1).join('/') : '';
    addVaultDoc(path, title, content || '', folder, proj, '[]', 'active', '[]', '📄');
    json(res, { ok: true, path });
}
// ── WORKER OPERATIONS ────────────────────────────────────────
/**
 * POST /api/software-house/worker/invoke
 * Manually invoke a worker on a task using the LLM.
 */
export async function handleWorkerInvoke(req, res) {
    const body = await parseBody(req);
    const { workerId, taskId, message } = body;
    if (!workerId) {
        json(res, { error: "workerId required" }, 400);
        return;
    }
    const worker = getWorker(workerId);
    if (!worker) {
        json(res, { error: "worker not found" }, 404);
        return;
    }
    let taskTitle = "";
    let taskDescription = "";
    let proj = worker.project;
    if (taskId) {
        const task = getBacklogTask(taskId.toString());
        if (task) {
            taskTitle = task.title;
            taskDescription = task.description || "";
            proj = task.project;
        }
    }
    try {
        updateWorker(workerId, { status: "thinking" });
        const systemPrompt = buildSystemPrompt(worker, proj, taskTitle, taskDescription);
        const userMsg = message
            ? message
            : taskId
                ? `Process this task: "${taskTitle}". ${taskDescription ? `Details: ${taskDescription}` : ""}`
                : "What are you working on? Give a status update.";
        const response = await callLLM({
            systemPrompt,
            userMessage: userMsg,
            maxTokens: 1024,
            preferredModel: worker?.model || undefined,
        });
        addWorkerTaskHistory(workerId, taskId || null, taskId ? "reported" : "status_update", JSON.stringify({ message: response, ts: new Date().toISOString() }));
        updateWorker(workerId, { status: "working" });
        json(res, { ok: true, workerId, taskId, response });
    }
    catch (err) {
        updateWorker(workerId, { status: "error" });
        addWorkerTaskHistory(workerId, taskId || null, "error", JSON.stringify({ message: err.message, ts: new Date().toISOString() }));
        json(res, { error: err.message }, 500);
    }
}
/**
 * GET /api/software-house/worker/:id/history
 * Returns the worker's full task history.
 */
export async function handleWorkerHistory(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const parts = url.pathname.split("/");
    const workerId = parts[parts.length - 2]; // /api/software-house/worker/:id/history
    if (!workerId) {
        json(res, { error: "worker id required" }, 400);
        return;
    }
    const history = listWorkerTaskHistory(workerId, 50);
    const worker = getWorker(workerId);
    json(res, {
        ok: true,
        worker: worker ? { id: worker.id, name: worker.name, role: worker.role, status: worker.status } : null,
        history: history.map((h) => ({
            id: h.id,
            action: h.action,
            taskId: h.task_id,
            details: (() => {
                try {
                    return JSON.parse(h.details || "{}");
                }
                catch {
                    return { message: h.details };
                }
            })(),
            createdAt: h.created_at,
        })),
    });
}
/**
 * GET /api/software-house/task/:id/report
 * Returns the job report for a completed task.
 */
export async function handleTaskReport(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const parts = url.pathname.split("/");
    const taskId = parts[parts.length - 2]; // /api/software-house/task/:id/report
    if (!taskId) {
        json(res, { error: "task id required" }, 400);
        return;
    }
    const project = getProject(req) || "genor-orchestrator-plugin";
    const reportPath = `reports/task-${taskId}-report.md`;
    const doc = getVaultDoc(reportPath, project);
    if (doc) {
        json(res, { ok: true, report: doc.content, path: reportPath, title: doc.title });
        return;
    }
    // Fallback search
    const allDocs = listVaultDocs(project);
    const match = allDocs.find((d) => d.path.includes(`task-${taskId}`));
    if (match) {
        json(res, { ok: true, report: match.content, path: match.path, title: match.title });
        return;
    }
    json(res, { error: "report not found for this task" }, 404);
}
/**
 * GET /api/software-house/lmstudio/health
 * Check if LM Studio is reachable.
 */
export async function handleLmStudioHealth(_req, res) {
    const health = await checkLmStudioHealth();
    json(res, { ok: true, ...health });
}
// ── EXISTING ENDPOINTS ───────────────────────────────────────
/**
 * POST /api/software-house/worker/start
 * Start a worker on a task.
 */
export async function handleWorkerStart(req, res) {
    const body = await parseBody(req);
    const { workerId, taskId } = body;
    if (!workerId || !taskId) {
        json(res, { error: "workerId and taskId required" }, 400);
        return;
    }
    updateWorker(workerId, { status: 'working' });
    updateBacklogTask(taskId, { worker_id: workerId, status: 'in-progress' });
    addWorkerTaskHistory(workerId, taskId, 'started', JSON.stringify({ startedAt: new Date().toISOString() }));
    json(res, { ok: true, workerId, taskId });
}
/**
 * POST /api/software-house/worker/message
 * Send message between workers.
 */
export async function handleWorkerMessage(req, res) {
    const body = await parseBody(req);
    const { fromWorker, toWorker, type, content } = body;
    if (!fromWorker || !toWorker || !content) {
        json(res, { error: "fromWorker, toWorker, and content required" }, 400);
        return;
    }
    addWorkerMessage(fromWorker, toWorker, type || 'chat', content);
    json(res, { ok: true });
}
/**
 * GET /api/software-house/worker/health/:id
 * Check worker health.
 */
export async function handleWorkerHealth(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const parts = url.pathname.split('/');
    const workerId = parts[parts.length - 1];
    if (!workerId) {
        json(res, { error: "worker id required" }, 400);
        return;
    }
    const worker = getWorker(workerId);
    if (!worker) {
        json(res, { error: "worker not found" }, 404);
        return;
    }
    const stalledTasks = getStalledTasksForWorker(workerId);
    const lastHistory = getWorkerLastActivity(workerId);
    let minutesSinceActive = null;
    if (lastHistory?.details) {
        try {
            const details = JSON.parse(lastHistory.details);
            const lastTime = new Date(details.startedAt || details.assignedAt);
            minutesSinceActive = Math.floor((Date.now() - lastTime.getTime()) / 60000);
        }
        catch (_) { }
    }
    const healthy = worker.status !== 'error' && stalledTasks.length < 3;
    json(res, {
        ok: true,
        worker,
        healthy,
        stalledTasks: stalledTasks?.length || 0,
        minutesSinceActive,
    });
}
/**
 * POST /api/software-house/worker/recover
 * Recover a stalled worker.
 */
export async function handleWorkerRecover(req, res) {
    const body = await parseBody(req);
    const { workerId } = body;
    if (!workerId) {
        json(res, { error: "workerId required" }, 400);
        return;
    }
    updateWorker(workerId, { status: 'idle' });
    const stalled = getStalledTasksForWorker(workerId);
    for (const task of stalled) {
        updateBacklogTask(task.id, { worker_id: null, status: 'backlog' });
    }
    json(res, { ok: true, tasksRequeued: stalled.length });
}
// ── MODELS ───────────────────────────────────────────────────
/**
 * GET /api/software-house/models
 * List available agent-ready models from store.
 */
export async function handleModels(req, res) {
    try {
        const models = store.listModels(true);
        json(res, models.map((m) => ({
            id: m.id || m.name,
            name: m.name || m.id,
            provider: m.provider || "",
        })));
    }
    catch (e) {
        json(res, { error: "Failed to load models" }, 500);
    }
}
// ── PROJECT MANAGEMENT ───────────────────────────────────────
/**
 * POST /api/software-house/projects/create
 * Create a new project via the orchestrator.
 */
export async function handleCreateProject(req, res) {
    const body = await parseBody(req);
    const name = body?.name?.trim();
    if (!name) {
        json(res, { error: "name required" }, 400);
        return;
    }
    const repoUrl = body?.repo_url?.trim() || "";
    try {
        const dataDir = getDataDir();
        const location = path.join(dataDir, "projects", name);
        let cloned = false;
        if (repoUrl) {
            if (fs.existsSync(location)) {
                fs.rmSync(location, { recursive: true, force: true });
            }
            fs.mkdirSync(path.dirname(location), { recursive: true });
            execSync(`git clone "${repoUrl}" "${location}"`, {
                encoding: "utf-8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"],
            });
            cloned = true;
        }
        else {
            fs.mkdirSync(location, { recursive: true });
            execSync(`git init "${location}"`, {
                encoding: "utf-8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
            });
        }
        const config = { location };
        if (repoUrl)
            config.repo_url = repoUrl;
        setProjectConfig(name, config);
        if (!cloned) {
            const host = req.headers.host || "localhost:18789";
            const proto = "http";
            try {
                await fetch(`${proto}://${host}/orchestrator/api/create-project`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name }),
                });
            }
            catch { /* orchestrator API may not be available */ }
        }
        json(res, { ok: true, project: name, location, repo_url: repoUrl, cloned });
    }
    catch (e) {
        json(res, { error: e.message || "Failed to create project" }, 500);
    }
}
// ── GIT / REPO ENDPOINTS ──────────────────────────────────
/**
 * POST /api/software-house/projects/clone
 * Clone a repo into an existing project location.
 */
export async function handleCloneProject(req, res) {
    const body = await parseBody(req);
    const { project, repo_url } = body;
    if (!project || !repo_url) {
        json(res, { error: "project and repo_url required" }, 400);
        return;
    }
    try {
        const dataDir = getDataDir();
        const existing = getProjectConfig(project);
        const location = existing?.location || path.join(dataDir, "projects", project);
        if (fs.existsSync(location)) {
            fs.rmSync(location, { recursive: true, force: true });
        }
        fs.mkdirSync(path.dirname(location), { recursive: true });
        execSync(`git clone "${repo_url}" "${location}"`, {
            encoding: "utf-8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"],
        });
        setProjectConfig(project, { location, repo_url });
        json(res, { ok: true, project, location });
    }
    catch (e) {
        json(res, { error: e.message || "Failed to clone project" }, 500);
    }
}
/**
 * GET /api/software-house/projects/:name/repo
 * Return git status for a project.
 */
export async function handleRepoStatus(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const cleanPath = url.pathname.replace(/^\/orchestrator/, "");
    const match = cleanPath.match(/^\/api\/software-house\/projects\/([^/]+)\/repo$/);
    if (!match) {
        json(res, { error: "invalid path" }, 400);
        return;
    }
    const projectName = match[1];
    try {
        const pc = getProjectConfig(projectName);
        const location = pc?.location;
        if (!location || !fs.existsSync(location)) {
            json(res, { ok: true, hasRepo: false, error: "Project location not found" });
            return;
        }
        const status = getRepoStatus(location);
        json(res, { ok: true, ...status });
    }
    catch (e) {
        json(res, { error: e.message || "Failed to get repo status" }, 500);
    }
}
/**
 * POST /api/software-house/projects/:name/repo/push
 * Stage all, commit, and push.
 */
export async function handleRepoPush(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const cleanPath = url.pathname.replace(/^\/orchestrator/, "");
    const match = cleanPath.match(/^\/api\/software-house\/projects\/([^/]+)\/repo\/push$/);
    if (!match) {
        json(res, { error: "invalid path" }, 400);
        return;
    }
    const projectName = match[1];
    const body = await parseBody(req);
    const { message } = body;
    if (!message) {
        json(res, { error: "commit message required" }, 400);
        return;
    }
    try {
        const pc = getProjectConfig(projectName);
        const location = pc?.location;
        if (!location || !fs.existsSync(path.join(location, ".git"))) {
            json(res, { error: "No git repository" }, 400);
            return;
        }
        let committed = false;
        let pushed = false;
        execSync(`git add -A`, { cwd: location, encoding: "utf-8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
        const statusOut = execSync(`git status --porcelain`, { cwd: location, encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
        if (statusOut) {
            const msgFile = path.join(location, ".git", "_commit_msg.txt");
            fs.writeFileSync(msgFile, message, "utf-8");
            execSync(`git commit -F "${msgFile}"`, {
                cwd: location, encoding: "utf-8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"],
            });
            fs.rmSync(msgFile, { force: true });
            committed = true;
        }
        const remote = gitExec(location, ["remote", "get-url", "origin"]);
        if (remote) {
            execSync(`git push`, { cwd: location, encoding: "utf-8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
            pushed = true;
        }
        json(res, { ok: true, committed, pushed });
    }
    catch (e) {
        json(res, { error: e.message || "Failed to push" }, 500);
    }
}
/**
 * POST /api/software-house/projects/:name/repo/pull
 * Pull from remote.
 */
export async function handleRepoPull(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const cleanPath = url.pathname.replace(/^\/orchestrator/, "");
    const match = cleanPath.match(/^\/api\/software-house\/projects\/([^/]+)\/repo\/pull$/);
    if (!match) {
        json(res, { error: "invalid path" }, 400);
        return;
    }
    const projectName = match[1];
    try {
        const pc = getProjectConfig(projectName);
        const location = pc?.location;
        if (!location || !fs.existsSync(path.join(location, ".git"))) {
            json(res, { error: "No git repository" }, 400);
            return;
        }
        let filesChanged = 0;
        let pullOutput = "";
        try {
            const beforeHead = gitExec(location, ["rev-parse", "HEAD"]);
            pullOutput = execSync(`git pull`, { cwd: location, encoding: "utf-8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }).trim();
            if (beforeHead) {
                const changed = gitExec(location, ["diff", "--name-only", `${beforeHead}...HEAD`]);
                filesChanged = changed ? changed.split("\n").filter(Boolean).length : 0;
            }
            if (!filesChanged) {
                const match = pullOutput.match(/(\d+) files? changed/);
                if (match)
                    filesChanged = parseInt(match[1], 10);
            }
        }
        catch { /* pull failed */ }
        json(res, { ok: true, pulled: true, filesChanged });
    }
    catch (e) {
        json(res, { error: e.message || "Failed to pull" }, 500);
    }
}
/**
 * GET /api/software-house/projects/list
 * List all projects with details.
 */
export async function handleProjectList(_req, res) {
    try {
        const projects = store.listProjects();
        json(res, { ok: true, projects });
    }
    catch (e) {
        json(res, { error: e.message || "Failed to list projects" }, 500);
    }
}
/**
 * DELETE /api/software-house/projects/:name
 * Delete a project.
 */
export async function handleProjectDelete(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const cleanPath = url.pathname.replace(/^\/orchestrator/, "");
    const match = cleanPath.match(/^\/api\/software-house\/projects\/([^/]+)$/);
    if (!match) {
        json(res, { error: "invalid path" }, 400);
        return;
    }
    const projectName = match[1];
    const deleteFiles = url.searchParams.get("deleteFiles") === "true";
    try {
        const pc = getProjectConfig(projectName);
        const location = pc?.location || path.join(getDataDir(), "projects", projectName);
        deleteWorkerTaskHistoryByProject(projectName);
        deleteWorkerMessagesByProject(projectName);
        deleteWorkerSessionsByProject(projectName);
        deleteBacklogByProject(projectName);
        deleteWorkersByProject(projectName);
        const rooms = listRooms(projectName);
        for (const room of rooms)
            deleteRoom(room.id);
        deleteSessionsByProject(projectName);
        clearPmChat(projectName);
        deleteVaultDocsByProject(projectName);
        deleteStateEventsByProject(projectName);
        deleteProjectConfig(projectName);
        clearStateForProject(projectName);
        let filesDeleted = false;
        if (deleteFiles && fs.existsSync(location)) {
            fs.rmSync(location, { recursive: true, force: true });
            filesDeleted = true;
        }
        json(res, { ok: true, project: projectName, filesDeleted });
    }
    catch (e) {
        json(res, { error: e.message || "Failed to delete project" }, 500);
    }
}
// ── ROUTER ───────────────────────────────────────────────────
/**
 * Route Software House API requests.
 * Returns true if handled, false if not a Software House route.
 */
export async function handleSoftwareHouseRoute(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const pathname = url.pathname;
    const normalizedPathname = pathname.replace(/^\/orchestrator/, "");
    if (!normalizedPathname.startsWith("/api/software-house/")) {
        return false;
    }
    const method = req.method || "GET";
    try {
        // ── Bootstrap ──
        if (normalizedPathname === "/api/software-house/bootstrap" && method === "GET") {
            await handleBootstrap(req, res);
            return true;
        }
        // ── Models ──
        if (normalizedPathname === "/api/software-house/models" && method === "GET") {
            await handleModels(req, res);
            return true;
        }
        // ── LM Studio health ──
        if (normalizedPathname === "/api/software-house/lmstudio/health" && method === "GET") {
            await handleLmStudioHealth(req, res);
            return true;
        }
        // ── Project management ──
        if (normalizedPathname === "/api/software-house/projects/create" && method === "POST") {
            await handleCreateProject(req, res);
            return true;
        }
        if (normalizedPathname === "/api/software-house/projects/clone" && method === "POST") {
            await handleCloneProject(req, res);
            return true;
        }
        if (normalizedPathname.match(/^\/api\/software-house\/projects\/[^/]+\/repo$/)) {
            if (method === "GET") {
                await handleRepoStatus(req, res);
                return true;
            }
        }
        if (normalizedPathname.match(/^\/api\/software-house\/projects\/[^/]+\/repo\/push$/) && method === "POST") {
            await handleRepoPush(req, res);
            return true;
        }
        if (normalizedPathname.match(/^\/api\/software-house\/projects\/[^/]+\/repo\/pull$/) && method === "POST") {
            await handleRepoPull(req, res);
            return true;
        }
        // ── Workers ──
        if (normalizedPathname === "/api/software-house/workers" && method === "GET") {
            await handleWorkersGet(req, res);
            return true;
        }
        if (normalizedPathname === "/api/software-house/workers/hire" && method === "POST") {
            await handleWorkerHire(req, res);
            return true;
        }
        if (normalizedPathname.match(/^\/api\/software-house\/workers\/[^/]+$/) && method === "PATCH") {
            await handleWorkerEdit(req, res);
            return true;
        }
        if (normalizedPathname.match(/^\/api\/software-house\/workers\/[^/]+$/) && method === "DELETE") {
            await handleWorkerFire(req, res);
            return true;
        }
        // ── Worker operations ──
        if (normalizedPathname === "/api/software-house/worker/invoke" && method === "POST") {
            await handleWorkerInvoke(req, res);
            return true;
        }
        if (normalizedPathname.match(/^\/api\/software-house\/worker\/[^/]+\/history$/) && method === "GET") {
            await handleWorkerHistory(req, res);
            return true;
        }
        if (normalizedPathname === "/api/software-house/worker/start" && method === "POST") {
            await handleWorkerStart(req, res);
            return true;
        }
        if (normalizedPathname === "/api/software-house/worker/message" && method === "POST") {
            await handleWorkerMessage(req, res);
            return true;
        }
        if (normalizedPathname.match(/^\/api\/software-house\/worker\/health\/[^/]+$/) && method === "GET") {
            await handleWorkerHealth(req, res);
            return true;
        }
        if (normalizedPathname === "/api/software-house/worker/recover" && method === "POST") {
            await handleWorkerRecover(req, res);
            return true;
        }
        // ── Rooms ──
        if (normalizedPathname === "/api/software-house/rooms" && method === "GET") {
            await handleRoomsGet(req, res);
            return true;
        }
        if (normalizedPathname === "/api/software-house/rooms" && method === "POST") {
            await handleRoomAdd(req, res);
            return true;
        }
        if (normalizedPathname.match(/^\/api\/software-house\/rooms\/[^/]+$/) && method === "PATCH") {
            await handleRoomEdit(req, res);
            return true;
        }
        if (normalizedPathname.match(/^\/api\/software-house\/rooms\/[^/]+$/) && method === "DELETE") {
            await handleRoomDelete(req, res);
            return true;
        }
        if (normalizedPathname === "/api/software-house/layout/save" && method === "POST") {
            await handleLayoutSave(req, res);
            return true;
        }
        // ── Backlog ──
        if (normalizedPathname === "/api/software-house/backlog" && method === "POST") {
            await handleBacklogCreate(req, res);
            return true;
        }
        if (normalizedPathname === "/api/software-house/backlog" && method === "GET") {
            await handleBacklogGet(req, res);
            return true;
        }
        if (normalizedPathname === "/api/software-house/backlog/assign" && method === "POST") {
            const body = await parseBody(req);
            const { taskId, workerId } = body;
            if (!taskId || !workerId) {
                json(res, { error: "taskId and workerId required" }, 400);
                return true;
            }
            updateBacklogTask(taskId, { worker_id: workerId });
            updateWorker(workerId, { status: "thinking" });
            addWorkerTaskHistory(workerId, taskId, "assigned", JSON.stringify({ assignedAt: new Date().toISOString() }));
            json(res, { ok: true, taskId, workerId });
            return true;
        }
        if (normalizedPathname === "/api/software-house/backlog/move" && method === "POST") {
            await handleBacklogMove(req, res);
            return true;
        }
        if (normalizedPathname === "/api/software-house/backlog/move-v2" && method === "POST") {
            await handleBacklogMoveV2(req, res);
            return true;
        }
        // ── Task report ──
        if (normalizedPathname.match(/^\/api\/software-house\/task\/[^/]+\/report$/) && method === "GET") {
            await handleTaskReport(req, res);
            return true;
        }
        // ── PM Chat ──
        if (normalizedPathname === "/api/software-house/pm/chat" && method === "GET") {
            await handlePmChatGet(req, res);
            return true;
        }
        if (normalizedPathname === "/api/software-house/pm/chat" && method === "POST") {
            await handlePmChatPost(req, res);
            return true;
        }
        // ── Vault ──
        if (normalizedPathname === "/api/software-house/vault/tree" && method === "GET") {
            await handleVaultTree(req, res);
            return true;
        }
        if (normalizedPathname === "/api/software-house/vault/doc" && method === "GET") {
            await handleVaultDocGet(req, res);
            return true;
        }
        if (normalizedPathname === "/api/software-house/vault/doc" && method === "PUT") {
            await handleVaultDocPut(req, res);
            return true;
        }
        if (normalizedPathname === "/api/software-house/vault/inject" && method === "POST") {
            await handleVaultInject(req, res);
            return true;
        }
        // ── Project list/delete ──
        if (normalizedPathname === "/api/software-house/projects/list" && method === "GET") {
            await handleProjectList(req, res);
            return true;
        }
        if (normalizedPathname.match(/^\/api\/software-house\/projects\/[^/]+$/) && method === "DELETE") {
            await handleProjectDelete(req, res);
            return true;
        }
        json(res, { error: "not found" }, 404);
        return true;
    }
    catch (e) {
        console.error("[software-house] Error:", e.message);
        json(res, { error: e.message }, 500);
        return true;
    }
}
