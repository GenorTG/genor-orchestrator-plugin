// ═══════════════════════════════════════════════════════════════
//  WORKER ENGINE — Core execution engine for Software House workers
// ═══════════════════════════════════════════════════════════════
// Handles task execution via OpenAI HTTP API endpoint.
// Workers are persistent AI personas that execute tasks using
// OpenClaw's agent sessions with full tool access.
import { getDb } from "./db.js";
// ═══════════════════════════════════════════════════════════════
//  WORKER ENGINE CLASS
// ═══════════════════════════════════════════════════════════════
export class WorkerEngine {
    config;
    maxToolCallIterations = 20; // Safety limit
    constructor(config) {
        this.config = config;
    }
    // ═══════════════════════════════════════════════════════════════
    //  MAIN EXECUTION METHOD
    // ═══════════════════════════════════════════════════════════════
    /**
     * Execute a task for a worker
     * @param workerId Worker ID
     * @param taskId Task ID from backlog
     * @returns Task result
     */
    async executeTask(workerId, taskId) {
        // 1. Validate configuration
        if (!this.config.openaiEndpointEnabled) {
            return {
                success: false,
                error: "OpenAI HTTP API endpoint not enabled. See plugin documentation.",
            };
        }
        if (!this.config.gatewayToken) {
            return {
                success: false,
                error: "Gateway token not found. Set OPENCLAW_GATEWAY_TOKEN environment variable.",
            };
        }
        // 2. Load worker from database
        const db = getDb();
        const worker = db.prepare("SELECT * FROM workers WHERE id = ?").get(workerId);
        if (!worker) {
            return { success: false, error: `Worker not found: ${workerId}` };
        }
        // 3. Load task from database
        const task = db.prepare("SELECT * FROM backlog_tasks WHERE id = ?").get(taskId);
        if (!task) {
            return { success: false, error: `Task not found: ${taskId}` };
        }
        // 4. Load relevant context (vault docs, project state)
        const context = await this.loadContext(worker, task);
        // 5. Build prompt
        const prompt = this.buildPrompt(worker, task, context);
        // 6. Send to OpenAI endpoint and handle tool calls
        const result = await this.executeWithToolLoop(worker, prompt);
        // 7. Log result to database
        this.logTaskResult(workerId, taskId, result);
        return result;
    }
    // ═══════════════════════════════════════════════════════════════
    //  PROMPT BUILDING
    // ═══════════════════════════════════════════════════════════════
    buildPrompt(worker, task, context) {
        return `You are ${worker.name}, a ${worker.role} at a software house.

## Your Instructions
${worker.prompt || "You are a skilled professional. Complete your assigned tasks with care."}

## Current Task
Title: ${task.title}
Description: ${task.description || "No description provided."}

## Project Context
${context}

## Instructions
1. Analyze the task carefully
2. Plan your approach
3. Implement the solution using available tools
4. Test your work if possible
5. Document what you did
6. When complete, summarize your changes

## Available Tools
- exec: Run shell commands (create, edit, delete files)
- read: Read file contents
- write: Create or overwrite files
- edit: Make precise edits to files
- apply_patch: Apply multi-file patches

Work in the workspace directory. Make real changes to files.
Return a summary of what you did when complete.`;
    }
    // ═══════════════════════════════════════════════════════════════
    //  CONTEXT LOADING
    // ═══════════════════════════════════════════════════════════════
    async loadContext(worker, task) {
        const db = getDb();
        const contextParts = [];
        // Load vault docs for the project
        try {
            const vaultDocs = db.prepare("SELECT * FROM vault_docs WHERE project_id = ?").all(task.project || "genor-orchestrator-plugin");
            if (vaultDocs.length > 0) {
                contextParts.push("### Project Documentation");
                for (const doc of vaultDocs.slice(0, 5)) { // Limit to 5 docs
                    contextParts.push(`#### ${doc.title}`);
                    contextParts.push(doc.content || "No content");
                }
            }
        }
        catch (e) {
            // Vault docs table might not exist yet
        }
        // Load worker's previous tasks for context
        try {
            const previousTasks = db.prepare("SELECT * FROM worker_task_history WHERE worker_id = ? ORDER BY created_at DESC LIMIT 3").all(worker.id);
            if (previousTasks.length > 0) {
                contextParts.push("### Your Recent Work");
                for (const pt of previousTasks) {
                    contextParts.push(`- ${pt.action}: ${pt.details || "No details"}`);
                }
            }
        }
        catch (e) {
            // Worker task history table might not exist yet
        }
        return contextParts.length > 0 ? contextParts.join("\n\n") : "No additional context available.";
    }
    // ═══════════════════════════════════════════════════════════════
    //  TOOL CALL LOOP
    // ═══════════════════════════════════════════════════════════════
    async executeWithToolLoop(worker, initialPrompt) {
        const messages = [
            { role: "user", content: initialPrompt },
        ];
        const filesChanged = [];
        for (let iteration = 0; iteration < this.maxToolCallIterations; iteration++) {
            // Send to OpenAI endpoint
            const response = await this.sendToEndpoint(worker, messages);
            if (!response) {
                return { success: false, error: "No response from endpoint" };
            }
            const choice = response.choices?.[0];
            if (!choice) {
                return { success: false, error: "Empty response from endpoint" };
            }
            // Check for tool calls
            const toolCalls = choice.message?.tool_calls;
            if (!toolCalls || toolCalls.length === 0) {
                // No tool calls - task complete
                return {
                    success: true,
                    output: choice.message?.content,
                    filesChanged,
                };
            }
            // Add assistant message with tool calls
            messages.push({
                role: "assistant",
                content: choice.message?.content,
                tool_calls: toolCalls,
            });
            // Execute each tool call
            for (const toolCall of toolCalls) {
                const result = await this.executeTool(toolCall);
                // Track file changes
                if (toolCall.function.name === "write" || toolCall.function.name === "edit" || toolCall.function.name === "apply_patch") {
                    const args = JSON.parse(toolCall.function.arguments);
                    if (args.path)
                        filesChanged.push(args.path);
                    if (args.input) {
                        // Extract file paths from patch
                        const pathMatches = args.input.match(/\*\*\* (?:Add|Update|Delete) File: (.+)/g);
                        if (pathMatches) {
                            for (const match of pathMatches) {
                                const filePath = match.replace(/\*\*\* (?:Add|Update|Delete) File: /, "");
                                filesChanged.push(filePath);
                            }
                        }
                    }
                }
                // Add tool result to messages
                messages.push({
                    role: "tool",
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(result),
                });
            }
        }
        return {
            success: false,
            error: `Tool call limit exceeded (${this.maxToolCallIterations} iterations)`,
            filesChanged,
        };
    }
    // ═══════════════════════════════════════════════════════════════
    //  OPENAI ENDPOINT COMMUNICATION
    // ═══════════════════════════════════════════════════════════════
    async sendToEndpoint(worker, messages) {
        try {
            const response = await fetch(`${this.config.gatewayUrl}/v1/chat/completions`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.config.gatewayToken}`,
                    "Content-Type": "application/json",
                    "x-openclaw-session-key": `worker:${worker.id}:session`,
                    "x-openclaw-model": worker.model || "openclaw/default",
                },
                body: JSON.stringify({
                    model: `openclaw/${worker.id}`,
                    user: `worker:${worker.id}:task:${Date.now()}`,
                    messages,
                    tools: this.getAvailableTools(),
                }),
            });
            if (!response.ok) {
                const errorText = await response.text();
                console.error(`OpenAI endpoint error: ${response.status} - ${errorText}`);
                return null;
            }
            return await response.json();
        }
        catch (error) {
            console.error(`OpenAI endpoint request failed:`, error);
            return null;
        }
    }
    // ═══════════════════════════════════════════════════════════════
    //  TOOL DEFINITIONS
    // ═══════════════════════════════════════════════════════════════
    getAvailableTools() {
        return [
            {
                type: "function",
                function: {
                    name: "exec",
                    description: "Run shell command",
                    parameters: {
                        type: "object",
                        properties: {
                            command: { type: "string", description: "Shell command to run" },
                            workdir: { type: "string", description: "Working directory (optional)" },
                        },
                        required: ["command"],
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "read",
                    description: "Read file contents",
                    parameters: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "File path to read" },
                        },
                        required: ["path"],
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "write",
                    description: "Write file contents (creates or overwrites)",
                    parameters: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "File path to write" },
                            content: { type: "string", description: "File content" },
                        },
                        required: ["path", "content"],
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "edit",
                    description: "Edit file with precise text replacements",
                    parameters: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "File path to edit" },
                            edits: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        oldText: { type: "string", description: "Exact text to find" },
                                        newText: { type: "string", description: "Replacement text" },
                                    },
                                },
                                description: "Array of text replacements",
                            },
                        },
                        required: ["path", "edits"],
                    },
                },
            },
            {
                type: "function",
                function: {
                    name: "apply_patch",
                    description: "Apply multi-file patches",
                    parameters: {
                        type: "object",
                        properties: {
                            input: { type: "string", description: "Patch content" },
                        },
                        required: ["input"],
                    },
                },
            },
        ];
    }
    // ═══════════════════════════════════════════════════════════════
    //  TOOL EXECUTION
    // ═══════════════════════════════════════════════════════════════
    async executeTool(toolCall) {
        const { name, arguments: argsStr } = toolCall.function;
        const args = JSON.parse(argsStr);
        try {
            switch (name) {
                case "exec":
                    return await this.execCommand(args.command, args.workdir);
                case "read":
                    return await this.readFile(args.path);
                case "write":
                    return await this.writeFile(args.path, args.content);
                case "edit":
                    return await this.editFile(args.path, args.edits);
                case "apply_patch":
                    return await this.applyPatch(args.input);
                default:
                    return { error: `Unknown tool: ${name}` };
            }
        }
        catch (error) {
            return { error: error.message };
        }
    }
    async execCommand(command, workdir) {
        const { execSync } = await import("node:child_process");
        try {
            const result = execSync(command, {
                cwd: workdir || process.cwd(),
                encoding: "utf-8",
                timeout: 30000,
            });
            return result;
        }
        catch (error) {
            return error.stdout || error.stderr || error.message;
        }
    }
    async readFile(path) {
        const fs = await import("node:fs/promises");
        return await fs.readFile(path, "utf-8");
    }
    async writeFile(path, content) {
        const fs = await import("node:fs/promises");
        await fs.writeFile(path, content, "utf-8");
        return `File written: ${path}`;
    }
    async editFile(path, edits) {
        const fs = await import("node:fs/promises");
        let content = await fs.readFile(path, "utf-8");
        for (const edit of edits) {
            content = content.replace(edit.oldText, edit.newText);
        }
        await fs.writeFile(path, content, "utf-8");
        return `File edited: ${path}`;
    }
    async applyPatch(patchContent) {
        const { execSync } = await import("node:child_process");
        try {
            execSync(`echo '${patchContent.replace(/'/g, "'\\''")}' | patch -p1`, {
                cwd: process.cwd(),
                encoding: "utf-8",
            });
            return "Patch applied successfully";
        }
        catch (error) {
            return error.stdout || error.stderr || error.message;
        }
    }
    // ═══════════════════════════════════════════════════════════════
    //  RESULT LOGGING
    // ═══════════════════════════════════════════════════════════════
    logTaskResult(workerId, taskId, result) {
        try {
            const db = getDb();
            db.prepare(`
        INSERT INTO worker_task_history (worker_id, task_id, action, details)
        VALUES (?, ?, ?, ?)
      `).run(workerId, taskId, result.success ? "completed" : "failed", JSON.stringify({
                output: result.output,
                error: result.error,
                filesChanged: result.filesChanged,
            }));
        }
        catch (error) {
            console.error("Failed to log task result:", error);
        }
    }
}
// ═══════════════════════════════════════════════════════════════
//  SINGLETON INSTANCE
// ═══════════════════════════════════════════════════════════════
let _workerEngine = null;
export function getWorkerEngine() {
    if (!_workerEngine) {
        const config = global.__SOFTWARE_HOUSE_CONFIG__ || {
            gatewayToken: null,
            openaiEndpointEnabled: false,
            gatewayUrl: "http://localhost:18789",
        };
        _workerEngine = new WorkerEngine(config);
    }
    return _workerEngine;
}
