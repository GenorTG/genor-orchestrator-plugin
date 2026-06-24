// ═══════════════════════════════════════════════════════════════
//  WORKER TOOLS — Registered tools for Software House workers
// ═══════════════════════════════════════════════════════════════

import { Type } from "typebox";
import { getDb, WorkerRow } from "./db.js";
import { getWorkerEngine } from "./worker-engine.js";

function txt(data: any): { content: Array<{ type: "text"; text: string }>; details: any } {
  return {
    content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
    details: data,
  };
}

export const assignTaskTool = {
  name: "genorch_worker_assign",
  label: "Assign Task",
  description: "Assign a backlog task to a worker for execution",
  parameters: Type.Object({
    workerId: Type.String({ description: "Worker ID" }),
    taskId: Type.Number({ description: "Task ID from backlog" }),
  }),
  async execute(_id: string, _params: any) {
    const args = _params as { workerId: string; taskId: number };
    const db = getDb();
    const worker = db.prepare("SELECT * FROM workers WHERE id = ?").get(args.workerId) as WorkerRow | undefined;
    if (!worker) return txt({ error: `Worker not found: ${args.workerId}` });
    
    const task = db.prepare("SELECT * FROM backlog_tasks WHERE id = ?").get(args.taskId);
    if (!task) return txt({ error: `Task not found: ${args.taskId}` });
    
    db.prepare("UPDATE backlog_tasks SET worker_id = ? WHERE id = ?").run(args.workerId, args.taskId);
    db.prepare("UPDATE workers SET status = 'working' WHERE id = ?").run(args.workerId);
    db.prepare("INSERT INTO worker_task_history (worker_id, task_id, action, details) VALUES (?, ?, 'assigned', ?)").run(args.workerId, args.taskId, JSON.stringify({ assignedAt: new Date().toISOString() }));
    
    return txt({ ok: true, message: `Task ${args.taskId} assigned to ${args.workerId}`, worker: { id: worker.id, name: worker.name, status: "working" } });
  },
};

export const startTaskTool = {
  name: "genorch_worker_start",
  label: "Start Task",
  description: "Start executing an assigned task via OpenAI endpoint",
  parameters: Type.Object({
    workerId: Type.String({ description: "Worker ID" }),
    taskId: Type.Number({ description: "Task ID to execute" }),
  }),
  async execute(_id: string, _params: any) {
    const args = _params as { workerId: string; taskId: number };
    const engine = getWorkerEngine();
    const result = await engine.executeTask(args.workerId, args.taskId);
    return txt({ ok: result.success, output: result.output, error: result.error, filesChanged: result.filesChanged });
  },
};

export const workerStatusTool = {
  name: "genorch_worker_status",
  label: "Worker Status",
  description: "Get worker status and recent activity",
  parameters: Type.Object({
    workerId: Type.String({ description: "Worker ID" }),
  }),
  async execute(_id: string, _params: any) {
    const args = _params as { workerId: string };
    const db = getDb();
    const worker = db.prepare("SELECT * FROM workers WHERE id = ?").get(args.workerId) as WorkerRow | undefined;
    if (!worker) return txt({ error: `Worker not found: ${args.workerId}` });
    
    const recentTasks = db.prepare("SELECT * FROM worker_task_history WHERE worker_id = ? ORDER BY created_at DESC LIMIT 5").all(args.workerId) as any[];
    const currentTask = db.prepare("SELECT * FROM backlog_tasks WHERE worker_id = ? AND status != 'done' LIMIT 1").get(args.workerId);
    
    return txt({
      worker: { id: worker.id, name: worker.name, role: worker.role, status: worker.status, model: worker.model },
      currentTask: currentTask || null,
      recentTasks: recentTasks.map((t: any) => ({ taskId: t.task_id, action: t.action, details: t.details, timestamp: t.created_at })),
    });
  },
};

export const sendMessageTool = {
  name: "genorch_worker_message",
  label: "Send Message",
  description: "Send message to another worker",
  parameters: Type.Object({
    fromWorker: Type.String({ description: "Sender worker ID" }),
    toWorker: Type.String({ description: "Recipient worker ID" }),
    type: Type.String({ description: "Message type: task_assign, task_complete, review_request, chat" }),
    content: Type.String({ description: "Message content" }),
    taskId: Type.Optional(Type.Number({ description: "Related task ID" })),
  }),
  async execute(_id: string, _params: any) {
    const args = _params as { fromWorker: string; toWorker: string; type: string; content: string; taskId?: number };
    const db = getDb();
    const from = db.prepare("SELECT * FROM workers WHERE id = ?").get(args.fromWorker);
    const to = db.prepare("SELECT * FROM workers WHERE id = ?").get(args.toWorker);
    if (!from) return txt({ error: `Sender not found: ${args.fromWorker}` });
    if (!to) return txt({ error: `Recipient not found: ${args.toWorker}` });
    
    db.prepare("INSERT INTO worker_messages (from_worker, to_worker, type, content, task_id) VALUES (?, ?, ?, ?, ?)").run(args.fromWorker, args.toWorker, args.type, args.content, args.taskId || null);
    return txt({ ok: true, message: `Message sent from ${args.fromWorker} to ${args.toWorker}` });
  },
};

export const getMessagesTool = {
  name: "genorch_worker_messages",
  label: "Get Messages",
  description: "Get messages for a worker",
  parameters: Type.Object({
    workerId: Type.String({ description: "Worker ID" }),
    unreadOnly: Type.Optional(Type.Boolean({ description: "Only unread messages" })),
  }),
  async execute(_id: string, _params: any) {
    const args = _params as { workerId: string; unreadOnly?: boolean };
    const db = getDb();
    let query = "SELECT * FROM worker_messages WHERE to_worker = ?";
    if (args.unreadOnly) query += " AND read_at IS NULL";
    query += " ORDER BY created_at DESC LIMIT 50";
    
    const messages = db.prepare(query).all(args.workerId) as any[];
    return txt({
      workerId: args.workerId,
      messageCount: messages.length,
      messages: messages.map((m: any) => ({ id: m.id, from: m.from_worker, type: m.type, content: m.content, taskId: m.task_id, timestamp: m.created_at })),
    });
  },
};

export const workerHealthTool = {
  name: "genorch_worker_health",
  label: "Worker Health",
  description: "Check worker session health",
  parameters: Type.Object({
    workerId: Type.String({ description: "Worker ID" }),
  }),
  async execute(_id: string, _params: any) {
    const args = _params as { workerId: string };
    const db = getDb();
    const worker = db.prepare("SELECT * FROM workers WHERE id = ?").get(args.workerId) as WorkerRow | undefined;
    if (!worker) return txt({ error: `Worker not found: ${args.workerId}` });
    
    const stalledTasks = db.prepare("SELECT * FROM backlog_tasks WHERE worker_id = ? AND status IN ('in_progress', 'testing')").all(args.workerId) as any[];
    const lastActivity = db.prepare("SELECT created_at FROM worker_task_history WHERE worker_id = ? ORDER BY created_at DESC LIMIT 1").get(args.workerId) as any;
    
    const lastActive = lastActivity?.created_at ? new Date(lastActivity.created_at) : null;
    const minutesSinceActive = lastActive ? Math.floor((Date.now() - lastActive.getTime()) / 60000) : null;
    
    return txt({
      worker: { id: worker.id, name: worker.name, status: worker.status },
      stalledTasks: stalledTasks.length,
      lastActive: lastActive?.toISOString(),
      minutesSinceActive,
      healthy: !stalledTasks.length || (minutesSinceActive !== null && minutesSinceActive < 30),
    });
  },
};

export const recoverWorkerTool = {
  name: "genorch_worker_recover",
  label: "Recover Worker",
  description: "Recover a stalled worker session",
  parameters: Type.Object({
    workerId: Type.String({ description: "Worker ID" }),
  }),
  async execute(_id: string, _params: any) {
    const args = _params as { workerId: string };
    const db = getDb();
    const worker = db.prepare("SELECT * FROM workers WHERE id = ?").get(args.workerId) as WorkerRow | undefined;
    if (!worker) return txt({ error: `Worker not found: ${args.workerId}` });
    
    db.prepare("UPDATE workers SET status = 'sleep' WHERE id = ?").run(args.workerId);
    const stalledTasks = db.prepare("UPDATE backlog_tasks SET worker_id = NULL WHERE worker_id = ? AND status IN ('in_progress', 'testing')").run(args.workerId);
    db.prepare("INSERT INTO worker_task_history (worker_id, task_id, action, details) VALUES (?, NULL, 'recovered', ?)").run(args.workerId, JSON.stringify({ recoveredAt: new Date().toISOString() }));
    
    return txt({ ok: true, message: `Worker ${args.workerId} recovered`, tasksRequeued: stalledTasks.changes });
  },
};

export const WORKER_TOOLS = [assignTaskTool, startTaskTool, workerStatusTool, sendMessageTool, getMessagesTool, workerHealthTool, recoverWorkerTool];
