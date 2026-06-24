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
import { getDb } from "./db.js";
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
// ── BOOTSTRAP ────────────────────────────────────────────────
/**
 * GET /api/software-house/bootstrap
 * Returns full project state matching mock JSON shape exactly.
 */
export async function handleBootstrap(req, res) {
    const db = getDb();
    const project = getProject(req) || "genor-orchestrator-plugin";
    // Query workers
    const workers = db.prepare("SELECT * FROM workers WHERE project = ?").all(project);
    // Query rooms
    const rooms = db.prepare("SELECT * FROM rooms WHERE project = ?").all(project);
    // Query tasks
    const tasks = db.prepare("SELECT * FROM backlog_tasks WHERE project = ?").all(project);
    // Query vault docs
    const vaultDocs = db.prepare("SELECT * FROM vault_docs WHERE project = ?").all(project);
    // Format response to match mock JSON shape
    const response = {
        defaultProjectId: "genor-orchestrator-plugin",
        projects: {
            [project]: {
                id: project,
                name: project,
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
                    task: null, // Will be filled from backlog_tasks
                    progress: 0,
                    room: w.room,
                    isOrchestrator: w.role.toLowerCase().includes("project manager"),
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
            },
        },
    };
    json(res, { ok: true, ...response });
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
    const { id: providedId, name, role, sprite, model, prompt, room, project } = body;
    if (!name) {
        json(res, { error: "name required" }, 400);
        return;
    }
    // Generate ID if not provided
    const id = providedId || `w${Date.now()}`;
    db.prepare(`
    INSERT OR REPLACE INTO workers (id, name, role, sprite, model, prompt, room, project)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, role || "", sprite || "blue", model || "", prompt || "", room || "", project || "genor-orchestrator-plugin");
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
        if (["name", "role", "sprite", "model", "prompt", "room", "status"].includes(key)) {
            updates.push(`${key} = ?`);
            values.push(value);
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
 * Send a message.
 */
export async function handlePmChatPost(req, res) {
    const db = getDb();
    const body = await parseBody(req);
    const { message, sender, project } = body;
    if (!message) {
        json(res, { error: "message required" }, 400);
        return;
    }
    const result = db.prepare(`
    INSERT INTO pm_chat (message, sender, project)
    VALUES (?, ?, ?)
  `).run(message, sender || "pm", project || "genor-orchestrator-plugin");
    json(res, { ok: true, id: result.lastInsertRowid });
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
