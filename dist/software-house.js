/**
 * Software House API routes for the orchestrator dashboard.
 *
 * Provides endpoints for the Software House UI:
 * - Bootstrap: full project state
 * - Workers: CRUD operations
 * - Rooms: CRUD operations
 * - Backlog: task management
 * - PM Chat: persistent messaging
 * - Vault: document management
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { getDb, listModels, setProjectConfig, getProjectConfig, deleteProjectConfig, getAllProjectConfigs } from "./db.js";
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
 * Returns full project state matching mock JSON shape exactly.
 */
export async function handleBootstrap(req, res) {
    const db = getDb();
    const project = getProject(req) || "genor-orchestrator-plugin";
    // Fetch all projects from orchestrator
    let allProjects = [];
    try {
        const host = req.headers.host || "localhost:18789";
        const proto = "http";
        const prRes = await fetch(`${proto}://${host}/orchestrator/api/projects`);
        if (prRes.ok) {
            const prData = await prRes.json();
            allProjects = (prData.projects || []).map((p) => p.name);
        }
    }
    catch { }
    // Query workers
    const workers = db.prepare("SELECT * FROM workers WHERE project = ?").all(project);
    // Query rooms
    const rooms = db.prepare("SELECT * FROM rooms WHERE project = ?").all(project);
    // Query tasks
    const tasks = db.prepare("SELECT * FROM backlog_tasks WHERE project = ?").all(project);
    // Query vault docs
    const vaultDocs = db.prepare("SELECT * FROM vault_docs WHERE project = ?").all(project);
    // Build project list — all orchestrator projects + any from software house DB
    const dbProjects = db.prepare("SELECT DISTINCT project FROM workers UNION SELECT DISTINCT project FROM rooms").all();
    const extraProjects = [...new Set([...allProjects, ...dbProjects.map((r) => r.project)])].filter(Boolean);
    const projects = {};
    for (const pId of extraProjects) {
        const pc = getProjectConfig(pId);
        const repoUrl = pc?.repo_url || "";
        const location = pc?.location || "";
        let repoStatus = null;
        if (location && fs.existsSync(location)) {
            repoStatus = getRepoStatus(location);
        }
        projects[pId] = {
            id: pId,
            name: pId,
            hasWorkers: db.prepare("SELECT COUNT(*) as c FROM workers WHERE project = ?").get(pId).c > 0,
            repo_url: repoUrl,
            repo: repoStatus,
        };
    }
    // Fill current project with full detail
    const pc = getProjectConfig(project);
    const repoUrl = pc?.repo_url || "";
    const location = pc?.location || "";
    let repoStatus = null;
    if (location && fs.existsSync(location)) {
        repoStatus = getRepoStatus(location);
    }
    projects[project] = {
        id: project,
        name: project,
        hasWorkers: workers.length > 0,
        repo_url: repoUrl,
        repo: repoStatus,
        rooms: rooms.map(r => ({
            id: r.id,
            name: r.name,
            tag: r.id,
            color: "#5e9cff",
            isCommand: r.isCommand === 1,
            purpose: r.purpose,
            taskTypes: JSON.parse(r.taskTypes || "[]"),
            layout: "auto",
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h,
        })),
        workers: workers.map(w => ({
            id: w.id,
            name: w.name,
            role: w.role,
            sprite: w.sprite,
            model: w.model,
            status: w.status,
            task: null,
            progress: 0,
            room: w.room,
            isOrchestrator: w.is_pm === 1 || w.role.toLowerCase().includes("project manager"),
            is_pm: w.is_pm === 1,
            prompt: w.prompt,
            ctx: "—",
        })),
        tasks: tasks.map(t => ({
            id: t.id,
            title: t.title,
            desc: t.description,
            worker: t.worker_id || null,
            phase: t.status,
            pri: t.priority,
            type: JSON.parse(t.labels || "[]")[0] || "dev",
        })),
        vault: Object.fromEntries(vaultDocs.map(d => [
            d.path,
            {
                folder: d.folder || null,
                icon: d.icon,
                title: d.title,
                updated: d.updated_at,
                tags: JSON.parse(d.tags || "[]"),
                status: d.status,
                links: JSON.parse(d.links || "[]"),
                html: d.content,
            },
        ])),
    };
    json(res, { ok: true, defaultProjectId: project, projects });
}
// ── WORKERS ──────────────────────────────────────────────────
/**
 * GET /api/software-house/workers
 * List all workers for a project.
 */
export async function handleWorkersGet(req, res) {
    const db = getDb();
    const project = getProject(req) || "genor-orchestrator-plugin";
    const workers = db.prepare("SELECT * FROM workers WHERE project = ?").all(project);
    json(res, workers);
}
/**
 * POST /api/software-house/workers/hire
 * Create a new worker.
 */
export async function handleWorkerHire(req, res) {
    const db = getDb();
    const body = await parseBody(req);
    const { id: providedId, name, role, sprite, model, prompt, room, project, is_pm } = body;
    if (!name) {
        json(res, { error: "name required" }, 400);
        return;
    }
    // Generate ID if not provided
    const id = providedId || `w${Date.now()}`;
    const isPmValue = is_pm ? 1 : 0;
    db.prepare(`
    INSERT OR REPLACE INTO workers (id, name, role, sprite, model, prompt, room, project, is_pm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, role || "", sprite || "blue", model || "", prompt || "", room || "", project || "genor-orchestrator-plugin", isPmValue);
    json(res, { ok: true, worker: { id, name } });
}
/**
 * PATCH /api/software-house/workers/:id
 * Edit an existing worker.
 */
export async function handleWorkerEdit(req, res) {
    const db = getDb();
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const id = url.pathname.split("/").pop();
    if (!id) {
        json(res, { error: "worker id required" }, 400);
        return;
    }
    const body = await parseBody(req);
    const updates = [];
    const values = [];
    for (const [key, value] of Object.entries(body)) {
        if (["name", "role", "sprite", "model", "prompt", "room", "is_pm"].includes(key)) {
            updates.push(`${key} = ?`);
            values.push(key === "is_pm" ? (value ? 1 : 0) : value);
        }
    }
    if (updates.length === 0) {
        json(res, { error: "no valid fields to update" }, 400);
        return;
    }
    values.push(id);
    db.prepare(`UPDATE workers SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    json(res, { ok: true, id });
}
/**
 * DELETE /api/software-house/workers/:id
 * Fire a worker.
 */
export async function handleWorkerFire(req, res) {
    const db = getDb();
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const id = url.pathname.split("/").pop();
    if (!id) {
        json(res, { error: "worker id required" }, 400);
        return;
    }
    db.prepare("DELETE FROM workers WHERE id = ?").run(id);
    json(res, { ok: true, id });
}
// ── ROOMS ────────────────────────────────────────────────────
/**
 * GET /api/software-house/rooms
 * List all rooms for a project.
 */
export async function handleRoomsGet(req, res) {
    const db = getDb();
    const project = getProject(req) || "genor-orchestrator-plugin";
    const rooms = db.prepare("SELECT * FROM rooms WHERE project = ?").all(project);
    json(res, rooms);
}
/**
 * POST /api/software-house/rooms
 * Add a new room.
 */
export async function handleRoomAdd(req, res) {
    const db = getDb();
    const body = await parseBody(req);
    const { id: providedId, name, purpose, taskTypes, project } = body;
    if (!name) {
        json(res, { error: "name required" }, 400);
        return;
    }
    const id = providedId || `room_${Date.now().toString(36)}`;
    db.prepare(`
    INSERT OR REPLACE INTO rooms (id, name, purpose, taskTypes, project)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, purpose || "", JSON.stringify(taskTypes || []), project || "genor-orchestrator-plugin");
    json(res, { ok: true, room: { id, name } });
}
/**
 * PATCH /api/software-house/rooms/:id
 * Edit an existing room.
 */
export async function handleRoomEdit(req, res) {
    const db = getDb();
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const id = url.pathname.split("/").pop();
    if (!id) {
        json(res, { error: "room id required" }, 400);
        return;
    }
    const body = await parseBody(req);
    const updates = [];
    const values = [];
    for (const [key, value] of Object.entries(body)) {
        if (["name", "purpose", "taskTypes", "x", "y", "w", "h", "isCommand"].includes(key)) {
            updates.push(`${key} = ?`);
            values.push(key === "taskTypes" ? JSON.stringify(value) : value);
        }
    }
    if (updates.length === 0) {
        json(res, { error: "no valid fields to update" }, 400);
        return;
    }
    values.push(id);
    db.prepare(`UPDATE rooms SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    json(res, { ok: true, id });
}
/**
 * DELETE /api/software-house/rooms/:id
 * Delete a room.
 */
export async function handleRoomDelete(req, res) {
    const db = getDb();
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const id = url.pathname.split("/").pop();
    if (!id) {
        json(res, { error: "room id required" }, 400);
        return;
    }
    db.prepare("DELETE FROM rooms WHERE id = ?").run(id);
    json(res, { ok: true, id });
}
/**
 * POST /api/software-house/layout/save
 * Save room positions.
 */
export async function handleLayoutSave(req, res) {
    const db = getDb();
    const body = await parseBody(req);
    const { rooms } = body;
    if (!Array.isArray(rooms)) {
        json(res, { error: "rooms array required" }, 400);
        return;
    }
    const stmt = db.prepare("UPDATE rooms SET x = ?, y = ?, w = ?, h = ? WHERE id = ?");
    for (const room of rooms) {
        stmt.run(room.x || 0, room.y || 0, room.w || 0, room.h || 0, room.id);
    }
    json(res, { ok: true });
}
// ── BACKLOG ──────────────────────────────────────────────────
/**
 * GET /api/software-house/backlog
 * List all tasks for a project.
 */
export async function handleBacklogGet(req, res) {
    const db = getDb();
    const project = getProject(req) || "genor-orchestrator-plugin";
    const tasks = db.prepare("SELECT * FROM backlog_tasks WHERE project = ?").all(project);
    json(res, tasks);
}
/**
 * POST /api/software-house/backlog
 * Create a new task.
 */
export async function handleBacklogCreate(req, res) {
    const db = getDb();
    const body = await parseBody(req);
    const { title, description, priority, labels, project } = body;
    if (!title) {
        json(res, { error: "title required" }, 400);
        return;
    }
    const proj = project || "genor-orchestrator-plugin";
    const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    db.prepare(`
    INSERT INTO backlog_tasks (id, project, title, description, priority, status, labels, created_ts, updated_ts)
    VALUES (?, ?, ?, ?, ?, 'todo', ?, unixepoch(), unixepoch())
  `).run(id, proj, title, description || '', priority || 'p2', JSON.stringify(labels || []));
    json(res, { ok: true, id });
}
/**
 * POST /api/software-house/backlog/move
 * Move a task to a different phase.
 */
export async function handleBacklogMove(req, res) {
    const db = getDb();
    const body = await parseBody(req);
    const { id, phase, worker_id } = body;
    if (!id) {
        json(res, { error: "task id required" }, 400);
        return;
    }
    const updates = ["updated_ts = ?"];
    const values = [Math.floor(Date.now() / 1000)];
    if (phase) {
        updates.push("status = ?");
        values.push(phase);
    }
    if (worker_id !== undefined) {
        updates.push("worker_id = ?");
        values.push(worker_id);
    }
    values.push(id);
    db.prepare(`UPDATE backlog_tasks SET ${updates.join(", ")} WHERE id = ?`).run(...values);
    json(res, { ok: true, id });
}
// ── PM CHAT ──────────────────────────────────────────────────
/**
 * GET /api/software-house/pm/chat
 * Load chat history for a project.
 */
export async function handlePmChatGet(req, res) {
    const db = getDb();
    const project = getProject(req) || "genor-orchestrator-plugin";
    const messages = db.prepare("SELECT * FROM pm_chat WHERE project = ? ORDER BY created_at DESC LIMIT 100").all(project);
    json(res, { ok: true, messages: messages.reverse() });
}
/**
 * POST /api/software-house/pm/chat
 * Send a message. Generates a PM response based on keywords.
 */
export async function handlePmChatPost(req, res) {
    const db = getDb();
    const body = await parseBody(req);
    const { message, sender, project } = body;
    if (!message) {
        json(res, { error: "message required" }, 400);
        return;
    }
    const proj = project || "genor-orchestrator-plugin";
    // Store user message
    db.prepare(`
    INSERT INTO pm_chat (message, sender, project)
    VALUES (?, ?, ?)
  `).run(message, sender || "user", proj);
    // Generate PM response based on keywords
    const lower = message.toLowerCase();
    let pmResponse = '';
    // Get project state for context
    const workers = db.prepare("SELECT * FROM workers WHERE project = ?").all(proj);
    const tasks = db.prepare("SELECT * FROM backlog_tasks WHERE project = ?").all(proj);
    const rooms = db.prepare("SELECT * FROM rooms WHERE project = ?").all(proj);
    const workingCount = workers.filter(w => w.status === 'working').length;
    const sleepCount = workers.filter(w => w.status === 'idle' || w.status === 'sleep').length;
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
    // Store PM response
    if (pmResponse) {
        db.prepare(`
      INSERT INTO pm_chat (message, sender, project)
      VALUES (?, ?, ?)
    `).run(pmResponse, 'pm', proj);
    }
    json(res, { ok: true });
}
// ── VAULT ────────────────────────────────────────────────────
/**
 * GET /api/software-house/vault/tree
 * List all documents for a project.
 */
export async function handleVaultTree(req, res) {
    const db = getDb();
    const project = getProject(req) || "genor-orchestrator-plugin";
    const docs = db.prepare("SELECT * FROM vault_docs WHERE project = ?").all(project);
    const vault = {};
    for (const doc of docs) {
        vault[doc.path] = {
            folder: doc.folder,
            icon: doc.icon,
            title: doc.title,
            updated: doc.updated_at,
            tags: JSON.parse(doc.tags || "[]"),
            status: doc.status,
            links: JSON.parse(doc.links || "[]"),
            html: doc.content,
        };
    }
    json(res, { ok: true, vault });
}
/**
 * GET /api/software-house/vault/doc
 * Get a document by path.
 */
export async function handleVaultDocGet(req, res) {
    const db = getDb();
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const docPath = url.searchParams.get("path");
    const project = url.searchParams.get("project") || "genor-orchestrator-plugin";
    if (!docPath) {
        json(res, { error: "path required" }, 400);
        return;
    }
    const doc = db.prepare("SELECT * FROM vault_docs WHERE path = ? AND project = ?").get(docPath, project);
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
    const db = getDb();
    const body = await parseBody(req);
    const { path, content, title, tags, status, links, project } = body;
    if (!path) {
        json(res, { error: "path required" }, 400);
        return;
    }
    const now = new Date().toISOString();
    db.prepare(`
    INSERT OR REPLACE INTO vault_docs (id, path, content, project, title, tags, status, links, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(path.replace(/[^a-zA-Z0-9]/g, "_"), path, content || "", project || "genor-orchestrator-plugin", title || path, JSON.stringify(tags || []), status || "", JSON.stringify(links || []), now);
    json(res, { ok: true, path });
}
/**
 * POST /api/software-house/vault/inject
 * Inject a document into AI context.
 */
export async function handleVaultInject(req, res) {
    const db = getDb();
    const body = await parseBody(req);
    const { path, content, project } = body;
    if (!path) {
        json(res, { error: "path required" }, 400);
        return;
    }
    const proj = project || "genor-orchestrator-plugin";
    const title = path.split('/').pop()?.replace(/\.md$/, '') || path;
    const folder = path.includes('/') ? path.split('/').slice(0, -1).join('/') : '';
    db.prepare(`
    INSERT OR REPLACE INTO vault_docs (path, title, content, folder, project, status, tags, links, icon, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', '[]', '[]', '📄', datetime('now'))
  `).run(path, title, content || '', folder, proj);
    json(res, { ok: true, path });
}
// ── WORKER OPERATIONS ────────────────────────────────────────
/**
 * POST /api/software-house/worker/start
 * Start a worker on a task.
 */
export async function handleWorkerStart(req, res) {
    const db = getDb();
    const body = await parseBody(req);
    const { workerId, taskId } = body;
    if (!workerId || !taskId) {
        json(res, { error: "workerId and taskId required" }, 400);
        return;
    }
    // Update worker status
    db.prepare("UPDATE workers SET status = 'working' WHERE id = ?").run(workerId);
    // Update task
    db.prepare("UPDATE backlog_tasks SET worker_id = ?, status = 'in-progress', updated_ts = ? WHERE id = ?")
        .run(workerId, Math.floor(Date.now() / 1000), taskId);
    // Log to history
    db.prepare("INSERT INTO worker_task_history (worker_id, task_id, action, details) VALUES (?, ?, 'started', ?)")
        .run(workerId, taskId, JSON.stringify({ startedAt: new Date().toISOString() }));
    json(res, { ok: true, workerId, taskId });
}
/**
 * POST /api/software-house/worker/message
 * Send message between workers.
 */
export async function handleWorkerMessage(req, res) {
    const db = getDb();
    const body = await parseBody(req);
    const { fromWorker, toWorker, type, content, project } = body;
    if (!fromWorker || !toWorker || !content) {
        json(res, { error: "fromWorker, toWorker, and content required" }, 400);
        return;
    }
    const proj = project || "genor-orchestrator-plugin";
    db.prepare(`
    INSERT INTO worker_messages (from_worker, to_worker, type, content)
    VALUES (?, ?, ?, ?)
  `).run(fromWorker, toWorker, type || 'chat', content);
    json(res, { ok: true });
}
/**
 * GET /api/software-house/worker/health/:id
 * Check worker health.
 */
export async function handleWorkerHealth(req, res) {
    const db = getDb();
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const parts = url.pathname.split('/');
    const workerId = parts[parts.length - 1];
    if (!workerId) {
        json(res, { error: "worker id required" }, 400);
        return;
    }
    const worker = db.prepare("SELECT * FROM workers WHERE id = ?").get(workerId);
    if (!worker) {
        json(res, { error: "worker not found" }, 404);
        return;
    }
    // Check for stalled tasks
    const stalledTasks = db.prepare("SELECT COUNT(*) as cnt FROM backlog_tasks WHERE worker_id = ? AND status = 'in-progress'").get(workerId);
    // Check last activity
    const lastHistory = db.prepare("SELECT * FROM worker_task_history WHERE worker_id = ? ORDER BY id DESC LIMIT 1").get(workerId);
    let minutesSinceActive = null;
    if (lastHistory?.details) {
        try {
            const details = JSON.parse(lastHistory.details);
            const lastTime = new Date(details.startedAt || details.assignedAt);
            minutesSinceActive = Math.floor((Date.now() - lastTime.getTime()) / 60000);
        }
        catch (_) { }
    }
    const healthy = worker.status !== 'error' && (stalledTasks?.cnt || 0) < 3;
    json(res, {
        ok: true,
        worker,
        healthy,
        stalledTasks: stalledTasks?.cnt || 0,
        minutesSinceActive,
    });
}
/**
 * POST /api/software-house/worker/recover
 * Recover a stalled worker.
 */
export async function handleWorkerRecover(req, res) {
    const db = getDb();
    const body = await parseBody(req);
    const { workerId } = body;
    if (!workerId) {
        json(res, { error: "workerId required" }, 400);
        return;
    }
    // Reset worker status
    db.prepare("UPDATE workers SET status = 'idle' WHERE id = ?").run(workerId);
    // Requeue stalled tasks
    const result = db.prepare("UPDATE backlog_tasks SET worker_id = NULL, status = 'backlog' WHERE worker_id = ? AND status = 'in-progress'").run(workerId);
    json(res, { ok: true, tasksRequeued: result.changes });
}
/**
 * GET /api/software-house/models
 * List available agent-ready models from OpenClaw registry.
 */
export async function handleModels(req, res) {
    try {
        const models = listModels(true); // agent_ready only
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
        // Create directory / clone repo
        let cloned = false;
        if (repoUrl) {
            // Remove existing dir if present (e.g. from a previous failed attempt)
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
        // Store project config
        const config = { location };
        if (repoUrl)
            config.repo_url = repoUrl;
        setProjectConfig(name, config);
        // Forward to orchestrator API (skip when cloned — we already set up everything)
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
        // Remove existing content before cloning
        if (fs.existsSync(location)) {
            fs.rmSync(location, { recursive: true, force: true });
        }
        fs.mkdirSync(path.dirname(location), { recursive: true });
        execSync(`git clone "${repo_url}" "${location}"`, {
            encoding: "utf-8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"],
        });
        // Update project config
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
            json(res, { error: "No git repository at project location" }, 400);
            return;
        }
        let committed = false;
        let pushed = false;
        // Stage all
        execSync(`git add -A`, { cwd: location, encoding: "utf-8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
        // Check if there's something to commit
        const statusOut = execSync(`git status --porcelain`, { cwd: location, encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
        if (statusOut) {
            // Use temp file for commit message to avoid shell escaping issues
            const msgFile = path.join(location, ".git", "_commit_msg.txt");
            fs.writeFileSync(msgFile, message, "utf-8");
            execSync(`git commit -F "${msgFile}"`, {
                cwd: location, encoding: "utf-8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"],
            });
            fs.rmSync(msgFile, { force: true });
            committed = true;
        }
        // Push
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
            json(res, { error: "No git repository at project location" }, 400);
            return;
        }
        // Capture HEAD before pull
        let filesChanged = 0;
        let pullOutput = "";
        try {
            const beforeHead = gitExec(location, ["rev-parse", "HEAD"]);
            pullOutput = execSync(`git pull`, { cwd: location, encoding: "utf-8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] }).trim();
            // Count files changed by comparing tree after pull
            if (beforeHead) {
                const changed = gitExec(location, ["diff", "--name-only", `${beforeHead}...HEAD`]);
                filesChanged = changed ? changed.split("\n").filter(Boolean).length : 0;
            }
            // Fallback: count from pull output message
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
        const dataDir = getDataDir();
        const projectsDir = path.join(dataDir, "projects");
        const allConfigs = getAllProjectConfigs(500);
        const projects = [];
        for (const [name, cfg] of Object.entries(allConfigs)) {
            const location = cfg.location || path.join(projectsDir, name);
            const configJson = cfg.config ? JSON.parse(cfg.config) : {};
            const exists = fs.existsSync(location);
            let fileCount = 0;
            let repoUrl = configJson.repo_url || "";
            let hasGit = false;
            let branch = "";
            let lastCommit = "";
            if (exists) {
                try {
                    // Count files (non-recursive, skip .git)
                    const entries = fs.readdirSync(location, { withFileTypes: true });
                    fileCount = entries.filter(e => e.name !== ".git").length;
                    hasGit = fs.existsSync(path.join(location, ".git"));
                    if (hasGit) {
                        try {
                            branch = execSync("git branch --show-current", { cwd: location, encoding: "utf-8", timeout: 5000 }).trim();
                            lastCommit = execSync("git log -1 --format=%s", { cwd: location, encoding: "utf-8", timeout: 5000 }).trim();
                        }
                        catch { /* */ }
                    }
                }
                catch { /* */ }
            }
            // Count workers & tasks
            const db = getDb();
            const workerCount = db.prepare("SELECT COUNT(*) as c FROM workers WHERE project = ?").get(name)?.c || 0;
            const taskCount = db.prepare("SELECT COUNT(*) as c FROM backlog_tasks WHERE project = ?").get(name)?.c || 0;
            const sessionCount = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE project = ?").get(name)?.c || 0;
            projects.push({
                name,
                location,
                exists,
                fileCount,
                repoUrl,
                hasGit,
                branch,
                lastCommit,
                workerCount,
                taskCount,
                sessionCount,
            });
        }
        json(res, { ok: true, projects });
    }
    catch (e) {
        json(res, { error: e.message || "Failed to list projects" }, 500);
    }
}
/**
 * DELETE /api/software-house/projects/:name
 * Delete a project. Query param: ?deleteFiles=true to also remove directory.
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
        const db = getDb();
        const pc = getProjectConfig(projectName);
        const location = pc?.location || path.join(getDataDir(), "projects", projectName);
        // Remove from DB
        deleteProjectConfig(projectName);
        // Remove associated data
        db.prepare("DELETE FROM backlog_tasks WHERE project = ?").run(projectName);
        db.prepare("DELETE FROM workers WHERE project = ?").run(projectName);
        db.prepare("DELETE FROM rooms WHERE project = ?").run(projectName);
        db.prepare("DELETE FROM sessions WHERE project = ?").run(projectName);
        db.prepare("DELETE FROM pm_chat WHERE project = ?").run(projectName);
        db.prepare("DELETE FROM vault_docs WHERE project_id = ?").run(projectName);
        // Remove files if requested
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
    // Only handle /api/software-house/* routes (with or without /orchestrator prefix)
    const normalizedPathname = pathname.replace(/^\/orchestrator/, "");
    if (!normalizedPathname.startsWith("/api/software-house/")) {
        return false;
    }
    const method = req.method || "GET";
    try {
        // Bootstrap
        if (normalizedPathname === "/api/software-house/bootstrap" && method === "GET") {
            await handleBootstrap(req, res);
            return true;
        }
        // Models
        if (normalizedPathname === "/api/software-house/models" && method === "GET") {
            await handleModels(req, res);
            return true;
        }
        // Project management
        if (normalizedPathname === "/api/software-house/projects/create" && method === "POST") {
            await handleCreateProject(req, res);
            return true;
        }
        // Repo / Git endpoints
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
        // Workers
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
        // Rooms
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
        // Backlog
        if (normalizedPathname === "/api/software-house/backlog" && method === "POST") {
            await handleBacklogCreate(req, res);
            return true;
        }
        if (normalizedPathname === "/api/software-house/backlog" && method === "GET") {
            await handleBacklogGet(req, res);
            return true;
        }
        // Backlog assign
        if (normalizedPathname === "/api/software-house/backlog/assign" && method === "POST") {
            const db = getDb();
            const body = await parseBody(req);
            const { taskId, workerId } = body;
            if (!taskId || !workerId) {
                json(res, { error: "taskId and workerId required" }, 400);
                return true;
            }
            db.prepare("UPDATE backlog_tasks SET worker_id = ? WHERE id = ?").run(workerId, taskId);
            db.prepare("UPDATE workers SET status = 'working' WHERE id = ?").run(workerId);
            db.prepare("INSERT INTO worker_task_history (worker_id, task_id, action, details) VALUES (?, ?, 'assigned', ?)").run(workerId, taskId, JSON.stringify({ assignedAt: new Date().toISOString() }));
            json(res, { ok: true, taskId, workerId });
            return true;
        }
        // PM Chat
        if (normalizedPathname === "/api/software-house/pm/chat" && method === "GET") {
            await handlePmChatGet(req, res);
            return true;
        }
        if (normalizedPathname === "/api/software-house/pm/chat" && method === "POST") {
            await handlePmChatPost(req, res);
            return true;
        }
        // Vault
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
        // Worker operations
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
        // Project list
        if (normalizedPathname === "/api/software-house/projects/list" && method === "GET") {
            await handleProjectList(req, res);
            return true;
        }
        // Project delete
        if (normalizedPathname.match(/^\/api\/software-house\/projects\/[^/]+$/) && method === "DELETE") {
            await handleProjectDelete(req, res);
            return true;
        }
        // Unknown Software House route
        json(res, { error: "not found" }, 404);
        return true;
    }
    catch (e) {
        console.error("[software-house] Error:", e.message);
        json(res, { error: e.message }, 500);
        return true;
    }
}
