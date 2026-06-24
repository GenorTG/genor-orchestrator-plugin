# Genor Orchestrator Software House — Full Implementation Plan

> Single source of truth for the entire plugin architecture.
> Ready for coding.

---

## Plugin Rename

**Old Name:** `genor-orchestrator-plugin`
**New Name:** `genor-orchestrator-software-house`

**Files to update:**
- `package.json` — name field
- `openclaw.plugin.json` — id, name, description
- `README.md` — title, description
- `src/index.ts` — plugin id, name, description
- All imports and references

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SOFTWARE HOUSE UI                                   │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐          │
│  │ Worker  │  │ Worker  │  │ Worker  │  │ Worker  │  │   PM    │          │
│  │ "Alex"  │  │ "Maya"  │  │ "Sam"   │  │ "Pat"   │  │  (you)  │          │
│  │ (Dev)   │  │ (Front) │  │ (QA)    │  │ (Design)│  │         │          │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘          │
│       │            │            │            │            │                 │
└───────┼────────────┼────────────┼────────────┼────────────┼─────────────────┘
        │            │            │            │            │
        ▼            ▼            ▼            ▼            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      PLUGIN (Genor Orchestrator Software House)             │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        HTTP API Layer                               │   │
│  │  POST /api/software-house/worker/assign                            │   │
│  │  POST /api/software-house/worker/start                             │   │
│  │  POST /api/software-house/worker/complete                          │   │
│  │  GET  /api/software-house/worker/status/:id                        │   │
│  │  ... (18 endpoints)                                                │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      Worker Engine                                  │   │
│  │  - Build prompts with worker context                                │   │
│  │  - Send to OpenAI HTTP API endpoint                                 │   │
│  │  - Handle tool calls in response                                    │   │
│  │  - Track session state per worker                                   │   │
│  │  - Process completion and trigger next task                         │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              │                                              │
│                              ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      Database Layer                                 │   │
│  │  workers          - Worker identities and state                     │   │
│  │  worker_sessions  - Session keys for tracking                       │   │
│  │  worker_tasks     - Task assignments and status                     │   │
│  │  worker_messages  - Inter-worker communication                      │   │
│  │  backlog_tasks    - Task definitions (existing)                     │   │
│  │  vault_docs       - Project documentation (existing)                │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
        │
        │ HTTP POST (with gateway token)
        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      GATEWAY (OpenClaw)                                     │
│                                                                             │
│  POST http://localhost:18789/v1/chat/completions                            │
│  Headers:                                                                   │
│    Authorization: Bearer <gateway_token>                                    │
│    x-openclaw-session-key: worker:alex:session                              │
│    x-openclaw-model: deepseek-v4-flash                                      │
│  Body:                                                                      │
│    model: "openclaw/alex-worker"                                            │
│    user: "worker:alex:task:123"                                             │
│    messages: [...]                                                          │
│    tools: [...]                                                             │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      AGENT SESSION (in OpenClaw)                            │
│                                                                             │
│  - Has access to all tools (exec, read, write, etc.)                        │
│  - Can modify files in workspace                                            │
│  - Can run shell commands                                                    │
│  - Returns tool_calls for plugin to execute                                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## File Structure

```
genor-orchestrator-software-house/
├── package.json                    # Plugin package (renamed)
├── openclaw.plugin.json            # Plugin manifest (renamed)
├── README.md                       # Documentation (updated)
├── tsconfig.json                   # TypeScript config
├── src/
│   ├── index.ts                    # Main plugin entry (52 tools)
│   ├── db.ts                       # Database schema & migrations
│   ├── software-house.ts           # Software House API endpoints
│   ├── worker-engine.ts            # Worker execution engine (NEW)
│   ├── dashboard-handler.ts        # HTTP/static file serving
│   └── shared.ts                   # Shared utilities
├── dashboard/
│   ├── software-house.html         # Main UI (~1900 lines)
│   └── data/
│       └── software-house-mock.json # Mock data (for reference)
├── docs/
│   ├── ARCHITECTURE.md             # System architecture
│   ├── ARCHITECTURE-VERIFIED.md    # Verified capabilities
│   ├── WORKER-DESIGN.md            # Worker system design
│   ├── MERGER-PLAN.md              # Implementation plan
│   └── decisions/                  # Decision log
│       └── 2026-06-24_worker-system-design.md
└── dist/                           # Built output
    └── index.js
```

---

## Implementation Phases

### Phase 1: Foundation (Current State)
**Status:** ✅ Complete

- [x] Database schema (V4 migration)
- [x] Software House API endpoints (18 endpoints)
- [x] UI rendering (workers, rooms, tasks, vault, chat)
- [x] Basic CRUD operations
- [x] Visual office map

### Phase 2: Plugin Rename & Config
**Status:** 🔄 In Progress

- [ ] Rename plugin to `genor-orchestrator-software-house`
- [ ] Update package.json, openclaw.plugin.json
- [ ] Update all imports and references
- [ ] Add OpenAI endpoint detection
- [ ] Add gateway token access
- [ ] Add documentation warnings

### Phase 3: Worker Engine
**Status:** ⏳ Pending

- [ ] Create `worker-engine.ts`
- [ ] Implement OpenAI HTTP API client
- [ ] Implement prompt building (worker context + task + vault docs)
- [ ] Implement tool call loop
- [ ] Implement session management per worker
- [ ] Implement completion handling

### Phase 4: Task Execution Flow
**Status:** ⏳ Pending

- [ ] Worker assign → build prompt → send to endpoint
- [ ] Handle tool calls in response
- [ ] Execute tools and send follow-up
- [ ] Track task progress
- [ ] Handle completion/failure

### Phase 5: Inter-Worker Communication
**Status:** ⏳ Pending

- [ ] Message queue (worker_messages table)
- [ ] Task handoff (dev → QA → dev)
- [ ] Review cycle
- [ ] Status updates between workers

### Phase 6: Failure Recovery
**Status:** ⏳ Pending

- [ ] Session health monitoring
- [ ] Timeout detection
- [ ] Auto-recovery (reset + requeue)
- [ ] Error logging and notification

### Phase 7: UI Enhancements
**Status:** ⏳ Pending

- [ ] Real-time worker status updates
- [ ] Task progress indicators
- [ ] Message notifications
- [ ] Cost tracking display

---

## Key Components

### 1. Worker Engine (`worker-engine.ts`)

```typescript
// Core worker execution engine
export class WorkerEngine {
  private gatewayToken: string;
  private gatewayUrl: string;
  
  constructor() {
    this.gatewayToken = this.getGatewayToken();
    this.gatewayUrl = "http://localhost:18789";
  }
  
  // Get gateway token from environment or config
  private getGatewayToken(): string {
    if (process.env.OPENCLAW_GATEWAY_TOKEN) {
      return process.env.OPENCLAW_GATEWAY_TOKEN;
    }
    // Read from gateway config
    const config = getGatewayConfig();
    return config.gateway?.auth?.token;
  }
  
  // Execute task for worker
  async executeTask(workerId: string, taskId: number): Promise<TaskResult> {
    // 1. Load worker from DB
    const worker = await this.loadWorker(workerId);
    
    // 2. Load task from DB
    const task = await this.loadTask(taskId);
    
    // 3. Load relevant vault docs
    const context = await this.loadContext(worker, task);
    
    // 4. Build prompt
    const prompt = this.buildPrompt(worker, task, context);
    
    // 5. Send to OpenAI endpoint
    const response = await this.sendToEndpoint(worker, prompt);
    
    // 6. Handle tool calls
    const result = await this.handleToolCalls(response);
    
    // 7. Return result
    return result;
  }
  
  // Send request to OpenAI HTTP API
  private async sendToEndpoint(
    worker: Worker,
    prompt: string
  ): Promise<OpenAIResponse> {
    const response = await fetch(
      `${this.gatewayUrl}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.gatewayToken}`,
          "Content-Type": "application/json",
          "x-openclaw-session-key": `worker:${worker.id}:session`,
          "x-openclaw-model": worker.model,
        },
        body: JSON.stringify({
          model: `openclaw/${worker.id}`,
          user: `worker:${worker.id}:task:${Date.now()}`,
          messages: [{ role: "user", content: prompt }],
          tools: this.getAvailableTools(),
        }),
      }
    );
    
    return response.json();
  }
  
  // Handle tool calls in response
  private async handleToolCalls(
    response: OpenAIResponse
  ): Promise<TaskResult> {
    const toolCalls = response.choices[0]?.message?.tool_calls;
    
    if (!toolCalls || toolCalls.length === 0) {
      // No tool calls - task complete
      return {
        success: true,
        output: response.choices[0]?.message?.content,
      };
    }
    
    // Execute each tool call
    const toolResults = [];
    for (const toolCall of toolCalls) {
      const result = await this.executeTool(toolCall);
      toolResults.push({
        tool_call_id: toolCall.id,
        role: "tool",
        content: JSON.stringify(result),
      });
    }
    
    // Send follow-up with tool results
    const followUpResponse = await this.sendFollowUp(toolResults);
    
    // Recursively handle more tool calls
    return this.handleToolCalls(followUpResponse);
  }
  
  // Execute a single tool call
  private async executeTool(toolCall: ToolCall): Promise<any> {
    const { name, arguments: args } = toolCall.function;
    const params = JSON.parse(args);
    
    switch (name) {
      case "exec":
        return await this.execCommand(params.command);
      case "read":
        return await this.readFile(params.path);
      case "write":
        return await this.writeFile(params.path, params.content);
      case "edit":
        return await this.editFile(params.path, params.edits);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
}
```

### 2. Database Schema (New Tables)

```sql
-- Worker sessions: tracks which session belongs to which worker
CREATE TABLE IF NOT EXISTS worker_sessions (
    worker_id TEXT PRIMARY KEY,
    session_key TEXT,
    last_active DATETIME,
    status TEXT DEFAULT 'idle',  -- idle, working, blocked, reviewing
    current_task_id INTEGER,
    FOREIGN KEY (worker_id) REFERENCES workers(id),
    FOREIGN KEY (current_task_id) REFERENCES backlog_tasks(id)
);

-- Worker messages: inter-worker communication
CREATE TABLE IF NOT EXISTS worker_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_worker TEXT NOT NULL,
    to_worker TEXT NOT NULL,
    type TEXT NOT NULL,  -- task_assign, task_complete, review_request, review_feedback, chat
    content TEXT,
    task_id INTEGER,
    context TEXT,  -- JSON: files, commits, docs referenced
    read_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (from_worker) REFERENCES workers(id),
    FOREIGN KEY (to_worker) REFERENCES workers(id),
    FOREIGN KEY (task_id) REFERENCES backlog_tasks(id)
);

-- Worker task history: audit trail of all work done
CREATE TABLE IF NOT EXISTS worker_task_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id TEXT NOT NULL,
    task_id INTEGER NOT NULL,
    action TEXT NOT NULL,  -- started, progress, completed, failed, review_sent, review_received
    details TEXT,  -- JSON: what was done, files changed, etc.
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (worker_id) REFERENCES workers(id),
    FOREIGN KEY (task_id) REFERENCES backlog_tasks(id)
);
```

### 3. API Endpoints (New)

```typescript
// Worker execution endpoints
POST /api/software-house/worker/assign    // Assign task to worker
POST /api/software-house/worker/start     // Start working on task
POST /api/software-house/worker/complete  // Mark task done
POST /api/software-house/worker/review    // Submit for review
POST /api/software-house/worker/approve   // Approve work

// Worker session endpoints
GET  /api/software-house/worker/sessions          // List all worker sessions
GET  /api/software-house/worker/health/:id        // Check session health
POST /api/software-house/worker/recover/:id       // Recover stalled session

// Worker message endpoints
POST /api/software-house/worker/message           // Send message to worker
GET  /api/software-house/worker/messages/:id      // Get messages for worker
```

### 4. Tool Definitions

```typescript
// Tools available to workers
const WORKER_TOOLS = [
  {
    type: "function",
    function: {
      name: "exec",
      description: "Run shell command",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command" },
          workdir: { type: "string", description: "Working directory" },
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
          path: { type: "string", description: "File path" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write",
      description: "Write file contents",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
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
      description: "Edit file with precise replacements",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                oldText: { type: "string" },
                newText: { type: "string" },
              },
            },
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
```

---

## Configuration

### Plugin Config (openclaw.plugin.json)

```json
{
  "id": "genor-orchestrator-software-house",
  "name": "Genor Orchestrator Software House",
  "description": "AI-powered software house with persistent worker sessions",
  "version": "1.0.0",
  "contracts": {
    "tools": [
      "genorch_worker_assign",
      "genorch_worker_status",
      "genorch_worker_message",
      "genorch_worker_sessions",
      "genorch_worker_health",
      "genorch_worker_recover"
    ]
  },
  "activation": {
    "onStartup": true
  },
  "configSchema": {
    "type": "object",
    "properties": {
      "maxConcurrentWorkers": {
        "type": "number",
        "default": 3,
        "description": "Maximum concurrent worker sessions"
      },
      "taskTimeout": {
        "type": "number",
        "default": 1800000,
        "description": "Task timeout in milliseconds (30 min)"
      },
      "recoveryInterval": {
        "type": "number",
        "default": 60000,
        "description": "Recovery check interval in milliseconds"
      }
    }
  }
}
```

### Environment Variables

```bash
# Gateway token (read from environment, never copied)
OPENCLAW_GATEWAY_TOKEN=your_token_here

# Or gateway password
OPENCLAW_GATEWAY_PASSWORD=your_password_here
```

---

## Prompt Template

```typescript
function buildWorkerPrompt(
  worker: Worker,
  task: Task,
  context: string
): string {
  return `
You are ${worker.name}, a ${worker.role} at a software house.

## Your Instructions
${worker.prompt}

## Current Task
Title: ${task.title}
Description: ${task.description}

## Project Context
${context}

## Instructions
1. Analyze the task carefully
2. Plan your approach
3. Implement the solution using available tools
4. Test your work
5. Document what you did
6. When complete, summarize your changes

## Available Tools
- exec: Run shell commands
- read: Read file contents
- write: Create/overwrite files
- edit: Make precise edits
- apply_patch: Multi-file patches

Work in the workspace directory. Make real changes to files.
Return a summary of what you did when complete.
  `.trim();
}
```

---

## Error Handling

```typescript
// Error types
enum WorkerError {
  TIMEOUT = "TIMEOUT",
  TOOL_FAILURE = "TOOL_FAILURE",
  SESSION_DEAD = "SESSION_DEAD",
  RATE_LIMIT = "RATE_LIMIT",
  BUDGET_EXHAUSTED = "BUDGET_EXHAUSTED",
  UNKNOWN = "UNKNOWN",
}

// Recovery actions
const RECOVERY_ACTIONS = {
  [WorkerError.TIMEOUT]: "reset_and_requeue",
  [WorkerError.TOOL_FAILURE]: "retry_with_fallback",
  [WorkerError.SESSION_DEAD]: "reset_and_requeue",
  [WorkerError.RATE_LIMIT]: "wait_and_retry",
  [WorkerError.BUDGET_EXHAUSTED]: "notify_user",
  [WorkerError.UNKNOWN]: "notify_user",
};
```

---

## Testing Plan

### Unit Tests
- [ ] Worker engine prompt building
- [ ] Tool call handling
- [ ] Database operations
- [ ] API endpoint validation

### Integration Tests
- [ ] End-to-end task execution
- [ ] Tool call loop
- [ ] Session persistence
- [ ] Error recovery

### Manual Testing
- [ ] Hire worker via UI
- [ ] Assign task via UI
- [ ] Worker executes task
- [ ] Worker modifies files
- [ ] Worker completes task
- [ ] Review cycle works

---

## Documentation

### README.md Updates
- [ ] Plugin description and features
- [ ] Prerequisites (OpenAI endpoints)
- [ ] Installation instructions
- [ ] Configuration guide
- [ ] Usage examples
- [ ] Troubleshooting

### API Documentation
- [ ] Endpoint reference
- [ ] Request/response examples
- [ ] Error codes
- [ ] Rate limits

---

## Timeline

| Phase | Estimated Time | Dependencies |
|-------|----------------|--------------|
| Phase 1: Foundation | ✅ Complete | None |
| Phase 2: Rename & Config | 2 hours | None |
| Phase 3: Worker Engine | 8 hours | Phase 2 |
| Phase 4: Task Execution | 6 hours | Phase 3 |
| Phase 5: Inter-Worker Comms | 4 hours | Phase 4 |
| Phase 6: Failure Recovery | 4 hours | Phase 4 |
| Phase 7: UI Enhancements | 4 hours | Phase 5 |

**Total Estimated Time:** ~28 hours

---

## Success Criteria

- [ ] Plugin renamed to `genor-orchestrator-software-house`
- [ ] OpenAI endpoint detection and warnings
- [ ] Gateway token access without copying
- [ ] Worker can execute tasks via OpenAI endpoint
- [ ] Worker can modify files in workspace
- [ ] Worker can run shell commands
- [ ] Task completion tracking
- [ ] Inter-worker messaging
- [ ] Failure recovery
- [ ] All tests passing

---

*Created: 2026-06-24 | Author: Amy*
*Status: Ready for implementation*
