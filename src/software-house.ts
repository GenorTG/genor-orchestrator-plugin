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

import { IncomingMessage, ServerResponse } from "node:http";
import { getDb, listModels, WorkerRow, RoomRow, VaultDocRow, PmChatRow, BacklogRow } from "./db.js";
import { getDataDir } from "./shared.js";

// ── HELPERS ──────────────────────────────────────────────────

function json(res: ServerResponse, data: any, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function getProject(req: IncomingMessage): string | null {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  return url.searchParams.get("project") || null;
}

// ── BOOTSTRAP ────────────────────────────────────────────────

/**
 * GET /api/software-house/bootstrap
 * Returns full project state matching mock JSON shape exactly.
 */
export async function handleBootstrap(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const db = getDb();
  const project = getProject(req) || "genor-orchestrator-plugin";

  // Fetch all projects from orchestrator
  let allProjects: string[] = [];
  try {
    const host = req.headers.host || "localhost:18789";
    const proto = "http";
    const prRes = await fetch(`${proto}://${host}/orchestrator/api/projects`);
    if (prRes.ok) {
      const prData = await prRes.json() as any;
      allProjects = (prData.projects || []).map((p: any) => p.name);
    }
  } catch {}

  // Query workers
  const workers = db.prepare("SELECT * FROM workers WHERE project = ?").all(project) as unknown as WorkerRow[];
  
  // Query rooms
  const rooms = db.prepare("SELECT * FROM rooms WHERE project = ?").all(project) as unknown as RoomRow[];
  
  // Query tasks
  const tasks = db.prepare("SELECT * FROM backlog_tasks WHERE project = ?").all(project) as unknown as BacklogRow[];
  
  // Query vault docs
  const vaultDocs = db.prepare("SELECT * FROM vault_docs WHERE project = ?").all(project) as unknown as VaultDocRow[];

  // Build project list — all orchestrator projects + any from software house DB
  const dbProjects = db.prepare("SELECT DISTINCT project FROM workers UNION SELECT DISTINCT project FROM rooms").all() as any[];
  const extraProjects = [...new Set([...allProjects, ...dbProjects.map((r: any) => r.project)])].filter(Boolean);

  const projects: Record<string, any> = {};
  for (const pId of extraProjects) {
    projects[pId] = {
      id: pId,
      name: pId,
      hasWorkers: (db.prepare("SELECT COUNT(*) as c FROM workers WHERE project = ?").get(pId) as any).c > 0,
    };
  }

  // Fill current project with full detail
  projects[project] = {
    id: project,
    name: project,
    hasWorkers: workers.length > 0,
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
    vault: Object.fromEntries(
      vaultDocs.map(d => [
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
      ])
    ),
  };

  json(res, { ok: true, defaultProjectId: project, projects });
}

// ── WORKERS ──────────────────────────────────────────────────

/**
 * GET /api/software-house/workers
 * List all workers for a project.
 */
export async function handleWorkersGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const db = getDb();
  const project = getProject(req) || "genor-orchestrator-plugin";
  const workers = db.prepare("SELECT * FROM workers WHERE project = ?").all(project);
  json(res, workers);
}

/**
 * POST /api/software-house/workers/hire
 * Create a new worker.
 */
export async function handleWorkerHire(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
export async function handleWorkerEdit(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const db = getDb();
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const id = url.pathname.split("/").pop();
  
  if (!id) {
    json(res, { error: "worker id required" }, 400);
    return;
  }

  const body = await parseBody(req);
  const updates: string[] = [];
  const values: any[] = [];

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
export async function handleWorkerFire(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
export async function handleRoomsGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const db = getDb();
  const project = getProject(req) || "genor-orchestrator-plugin";
  const rooms = db.prepare("SELECT * FROM rooms WHERE project = ?").all(project);
  json(res, rooms);
}

/**
 * POST /api/software-house/rooms
 * Add a new room.
 */
export async function handleRoomAdd(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
export async function handleRoomEdit(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const db = getDb();
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const id = url.pathname.split("/").pop();

  if (!id) {
    json(res, { error: "room id required" }, 400);
    return;
  }

  const body = await parseBody(req);
  const updates: string[] = [];
  const values: any[] = [];

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
export async function handleRoomDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
export async function handleLayoutSave(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
export async function handleBacklogGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const db = getDb();
  const project = getProject(req) || "genor-orchestrator-plugin";
  const tasks = db.prepare("SELECT * FROM backlog_tasks WHERE project = ?").all(project);
  json(res, tasks);
}

/**
 * POST /api/software-house/backlog
 * Create a new task.
 */
export async function handleBacklogCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
export async function handleBacklogMove(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const db = getDb();
  const body = await parseBody(req);
  const { id, phase, worker_id } = body;

  if (!id) {
    json(res, { error: "task id required" }, 400);
    return;
  }

  const updates: string[] = ["updated_ts = ?"];
  const values: any[] = [Math.floor(Date.now() / 1000)];

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
export async function handlePmChatGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const db = getDb();
  const project = getProject(req) || "genor-orchestrator-plugin";
  const messages = db.prepare("SELECT * FROM pm_chat WHERE project = ? ORDER BY created_at DESC LIMIT 100").all(project);
  json(res, { ok: true, messages: messages.reverse() });
}

/**
 * POST /api/software-house/pm/chat
 * Send a message. Generates a PM response based on keywords.
 */
export async function handlePmChatPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
  const workers = db.prepare("SELECT * FROM workers WHERE project = ?").all(proj) as any[];
  const tasks = db.prepare("SELECT * FROM backlog_tasks WHERE project = ?").all(proj) as any[];
  const rooms = db.prepare("SELECT * FROM rooms WHERE project = ?").all(proj) as any[];

  const workingCount = workers.filter(w => w.status === 'working').length;
  const sleepCount = workers.filter(w => w.status === 'idle' || w.status === 'sleep').length;
  const errorCount = workers.filter(w => w.status === 'error').length;
  const activeTasks = tasks.filter(t => t.status !== 'done').length;

  if (lower.includes('status') || lower.includes('raport')) {
    pmResponse = `📊 <b>Status projektu ${proj}</b><br>` +
      `• ${workers.length} workerów (${workingCount} pracuje, ${sleepCount} śpi, ${errorCount} błędów)<br>` +
      `• ${activeTasks} aktywnych tasków<br>` +
      workers.map(w => `• ${w.name}: ${w.status}${w.task ? ' — ' + w.task : ''}`).join('<br>');
  } else if (lower.includes('plan') || lower.includes('sprint')) {
    const backlog = tasks.filter(t => t.status === 'backlog').length;
    const inProgress = tasks.filter(t => t.status === 'in-progress').length;
    const review = tasks.filter(t => t.status === 'review').length;
    pmResponse = `📋 <b>Plan sprintu</b><br>` +
      `• Backlog: ${backlog} tasków<br>` +
      `• W toku: ${inProgress}<br>` +
      `• Review: ${review}<br>` +
      `• Zalecam priorytetyzację blokujących tasków.`;
  } else if (lower.includes('zatrud') || lower.includes('hire') || lower.includes('nowy')) {
    pmResponse = `👋 Otwieram formularz zatrudnienia. Kliknij <b>+ Zatrudnij</b> przy pokoju.`;
  } else if (lower.includes('błąd') || lower.includes('error') || lower.includes('problem')) {
    const errorWorkers = workers.filter(w => w.status === 'error');
    if (errorWorkers.length) {
      pmResponse = `🚧 <b>Blokery (${errorWorkers.length})</b><br>` +
        errorWorkers.map(w => `• ${w.name}: ${w.task || 'błąd agenta'}`).join('<br>') +
        '<br>Przywróć workery lub przydziel nowe zadania.';
    } else {
      pmResponse = '✅ Brak błędów — zespół działa płynnie.';
    }
  } else if (lower.includes('task') || lower.includes('zadani')) {
    const active = tasks.filter(t => t.status !== 'done');
    pmResponse = `📋 <b>Zadania (${active.length})</b><br>` +
      active.slice(0, 8).map(t => `• ${t.priority} ${t.title} (${t.status})`).join('<br>') +
      (active.length > 8 ? '<br>…' : '');
  } else if (lower.includes('help') || lower.includes('pomoc')) {
    pmResponse = `💡 Mogę pomóc z:<br>` +
      `• <b>status</b> — raport zespołu<br>` +
      `• <b>plan</b> — plan sprintu<br>` +
      `• <b>zatrudnij</b> — formularz hiringu<br>` +
      `• <b>błąd</b> — lista blokerów<br>` +
      `• <b>taski</b> — lista zadań`;
  } else {
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
export async function handleVaultTree(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const db = getDb();
  const project = getProject(req) || "genor-orchestrator-plugin";
  const docs = db.prepare("SELECT * FROM vault_docs WHERE project = ?").all(project);
  const vault: Record<string, any> = {};
  for (const doc of docs as any[]) {
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
export async function handleVaultDocGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
export async function handleVaultDocPut(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
  `).run(
    path.replace(/[^a-zA-Z0-9]/g, "_"),
    path,
    content || "",
    project || "genor-orchestrator-plugin",
    title || path,
    JSON.stringify(tags || []),
    status || "",
    JSON.stringify(links || []),
    now
  );

  json(res, { ok: true, path });
}

/**
 * POST /api/software-house/vault/inject
 * Inject a document into AI context.
 */
export async function handleVaultInject(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
export async function handleWorkerStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
export async function handleWorkerMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
export async function handleWorkerHealth(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const db = getDb();
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const parts = url.pathname.split('/');
  const workerId = parts[parts.length - 1];

  if (!workerId) {
    json(res, { error: "worker id required" }, 400);
    return;
  }

  const worker = db.prepare("SELECT * FROM workers WHERE id = ?").get(workerId) as any;
  if (!worker) {
    json(res, { error: "worker not found" }, 404);
    return;
  }

  // Check for stalled tasks
  const stalledTasks = db.prepare(
    "SELECT COUNT(*) as cnt FROM backlog_tasks WHERE worker_id = ? AND status = 'in-progress'"
  ).get(workerId) as any;

  // Check last activity
  const lastHistory = db.prepare(
    "SELECT * FROM worker_task_history WHERE worker_id = ? ORDER BY id DESC LIMIT 1"
  ).get(workerId) as any;

  let minutesSinceActive = null;
  if (lastHistory?.details) {
    try {
      const details = JSON.parse(lastHistory.details);
      const lastTime = new Date(details.startedAt || details.assignedAt);
      minutesSinceActive = Math.floor((Date.now() - lastTime.getTime()) / 60000);
    } catch (_) {}
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
export async function handleWorkerRecover(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
  const result = db.prepare(
    "UPDATE backlog_tasks SET worker_id = NULL, status = 'backlog' WHERE worker_id = ? AND status = 'in-progress'"
  ).run(workerId);

  json(res, { ok: true, tasksRequeued: result.changes });
}

/**
 * GET /api/software-house/models
 * List available agent-ready models from OpenClaw registry.
 */
export async function handleModels(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const models = listModels(true); // agent_ready only
    json(res, models.map((m: any) => ({
      id: m.id || m.name,
      name: m.name || m.id,
      provider: m.provider || "",
    })));
  } catch (e) {
    json(res, { error: "Failed to load models" }, 500);
  }
}

/**
 * POST /api/software-house/projects/create
 * Create a new project via the orchestrator.
 */
export async function handleCreateProject(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await parseBody(req);
  const name = body?.name?.trim();
  if (!name) {
    json(res, { error: "name required" }, 400);
    return;
  }

  try {
    const host = req.headers.host || "localhost:18789";
    const proto = "http";
    const createRes = await fetch(`${proto}://${host}/orchestrator/api/create-project`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await createRes.json();
    json(res, { ok: createRes.ok, ...data });
  } catch (e) {
    json(res, { error: "Failed to create project" }, 500);
  }
}

// ── ROUTER ───────────────────────────────────────────────────

/**
 * Route Software House API requests.
 * Returns true if handled, false if not a Software House route.
 */
export async function handleSoftwareHouseRoute(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
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

    // Unknown Software House route
    json(res, { error: "not found" }, 404);
    return true;
  } catch (e: any) {
    console.error("[software-house] Error:", e.message);
    json(res, { error: e.message }, 500);
    return true;
  }
}
