// ═══════════════════════════════════════════════════════════════
//  WORKER TOOLS — Registered tools for Software House workers
// ═══════════════════════════════════════════════════════════════
import { Type } from "typebox";
import { getWorker, getBacklogTask, updateBacklogTask, updateWorker, addWorkerTaskHistory, listWorkerTaskHistory, getWorkerCurrentTask, getStalledTasksForWorker, getWorkerLastActivity, addWorkerMessage, listWorkerMessages } from "./db.js";
import { getWorkerEngine } from "./worker-engine.js";
function txt(data) {
    return {
        content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
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
    async execute(_id, _params) {
        const args = _params;
        const worker = getWorker(args.workerId);
        if (!worker)
            return txt({ error: `Worker not found: ${args.workerId}` });
        const task = getBacklogTask(args.taskId.toString());
        if (!task)
            return txt({ error: `Task not found: ${args.taskId}` });
        updateBacklogTask(args.taskId.toString(), { worker_id: args.workerId });
        updateWorker(args.workerId, { status: 'working' });
        addWorkerTaskHistory(args.workerId, args.taskId, 'assigned', JSON.stringify({ assignedAt: new Date().toISOString() }));
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
    async execute(_id, _params) {
        const args = _params;
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
    async execute(_id, _params) {
        const args = _params;
        const worker = getWorker(args.workerId);
        if (!worker)
            return txt({ error: `Worker not found: ${args.workerId}` });
        const recentTasks = listWorkerTaskHistory(args.workerId, 5);
        const currentTask = getWorkerCurrentTask(args.workerId);
        return txt({
            worker: { id: worker.id, name: worker.name, role: worker.role, status: worker.status, model: worker.model },
            currentTask: currentTask || null,
            recentTasks: recentTasks.map((t) => ({ taskId: t.task_id, action: t.action, details: t.details, timestamp: t.created_at })),
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
    async execute(_id, _params) {
        const args = _params;
        const from = getWorker(args.fromWorker);
        const to = getWorker(args.toWorker);
        if (!from)
            return txt({ error: `Sender not found: ${args.fromWorker}` });
        if (!to)
            return txt({ error: `Recipient not found: ${args.toWorker}` });
        addWorkerMessage(args.fromWorker, args.toWorker, args.type, args.content, args.taskId);
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
    async execute(_id, _params) {
        const args = _params;
        const messages = listWorkerMessages(args.workerId, args.unreadOnly);
        return txt({
            workerId: args.workerId,
            messageCount: messages.length,
            messages: messages.map((m) => ({ id: m.id, from: m.from_worker, type: m.type, content: m.content, taskId: m.task_id, timestamp: m.created_at })),
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
    async execute(_id, _params) {
        const args = _params;
        const worker = getWorker(args.workerId);
        if (!worker)
            return txt({ error: `Worker not found: ${args.workerId}` });
        const stalledTasks = getStalledTasksForWorker(args.workerId);
        const lastActivity = getWorkerLastActivity(args.workerId);
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
    async execute(_id, _params) {
        const args = _params;
        const worker = getWorker(args.workerId);
        if (!worker)
            return txt({ error: `Worker not found: ${args.workerId}` });
        updateWorker(args.workerId, { status: 'sleep' });
        const stalledTasks = getStalledTasksForWorker(args.workerId);
        for (const task of stalledTasks) {
            updateBacklogTask(task.id, { worker_id: null });
        }
        addWorkerTaskHistory(args.workerId, null, 'recovered', JSON.stringify({ recoveredAt: new Date().toISOString() }));
        return txt({ ok: true, message: `Worker ${args.workerId} recovered`, tasksRequeued: stalledTasks.length });
    },
};
export const WORKER_TOOLS = [assignTaskTool, startTaskTool, workerStatusTool, sendMessageTool, getMessagesTool, workerHealthTool, recoverWorkerTool];
