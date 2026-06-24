# OpenClaw Architecture Analysis: Plugin Session Spawning

> Honest assessment of what plugins can and cannot do.
> Based on actual OpenClaw documentation.

---

## The Core Problem

**Can a plugin spawn new sessions for workers?**

**Short answer:** Not directly. But there are workarounds.

---

## What Plugins CAN Do

### 1. Register Tools (Agent Calls)
```typescript
api.registerTool({
  name: "worker_assign_task",
  execute: async (id, params) => {
    // Plugin logic here
    // Returns result to agent
  }
});
```
**Limitation:** Tools are called BY agents, not BY plugins. The plugin can't trigger work.

### 2. Register Hooks (Observe/Intercept Events)
```typescript
api.on("subagent_spawned", async (event) => {
  // Track subagent creation
});

api.on("subagent_ended", async (event) => {
  // Track subagent completion
});

api.on("before_tool_call", async (event) => {
  // Intercept tool calls
});
```
**Limitation:** Hooks observe/intercept, they don't trigger work.

### 3. Schedule Session Turns (Bundled-Only)
```typescript
api.session.workflow.scheduleSessionTurn({
  sessionKey: "agent:main:dashboard:...",
  payload: { kind: "agentTurn", message: "Process worker queue" }
});
```
**Limitation:** Only for EXISTING sessions. Doesn't create new sessions.

### 4. Inject Context Into Next Turn
```typescript
api.session.workflow.enqueueNextTurnInjection({
  sessionKey: "agent:main:...",
  injection: { text: "Worker Alex has task X" }
});
```
**Limitation:** Only works if agent has a next turn scheduled.

### 5. Register Session Extensions (Persist State)
```typescript
api.session.state.registerSessionExtension({
  id: "worker-state",
  // Plugin-owned session state
});
```
**Limitation:** State management, not session creation.

### 6. Register HTTP Routes (API Endpoints)
```typescript
api.registerHttpRoute({
  path: "/api/software-house/assign",
  handler: async (req, res) => {
    // Handle UI requests
  }
});
```
**Limitation:** HTTP routes don't create sessions.

### 7. Register Gateway Methods (RPC)
```typescript
api.registerGatewayMethod("worker.assign", async (params) => {
  // Handle RPC calls
});
```
**Limitation:** RPC methods don't create sessions.

---

## What Plugins CANNOT Do

### ❌ Cannot Spawn Subagents Directly
The `sessions_spawn` tool is an AGENT tool, not a plugin API. Plugins can't call it.

### ❌ Cannot Create New Sessions Directly
Sessions are created by the Gateway, not plugins. There's no `createSession()` API.

### ❌ Cannot Own a Session
Plugins can't have their own sessions for executing work.

---

## Workaround Options

### Option 1: Plugin Triggers Agent (Recommended)
```
User assigns task in UI
  → Plugin saves to database
  → Plugin calls scheduleSessionTurn() (immediate)
  → Agent turn fires (wakes up if idle)
  → Agent sees injected context: "Worker Alex has task X"
  → Agent spawns subagent with worker's context
  → Subagent does work
  → Plugin tracks via hooks
  → If more work, schedule another turn
```

**Pros:**
- Fully automated
- Uses existing OpenClaw infrastructure
- Agent has full capabilities (tools, models, etc.)

**Cons:**
- Requires main agent to be the executor
- Agent needs to understand plugin's queue
- Indirect (plugin → agent → subagent)

### Option 2: External Script via Gateway RPC
```
User assigns task in UI
  → Plugin saves to database
  → Plugin spawns external script (Node.js)
  → Script connects to Gateway via WebSocket
  → Script calls Gateway RPC: agent.run()
  → Agent executes task
  → Script gets result
  → Plugin tracks via hooks
```

**Pros:**
- Direct session spawning
- Plugin doesn't need agent as middleman

**Cons:**
- Requires external process
- Complex deployment
- WebSocket connection management

### Option 3: Plugin Uses OpenAI Endpoints (Master Genor's Workaround)
```
User assigns task in UI
  → Plugin saves to database
  → Plugin sends HTTP request to OpenClaw's OpenAI endpoint
  → OpenClaw processes as chat completion
  → Plugin gets response
  → Plugin tracks via hooks
```

**Pros:**
- Direct execution
- No agent middleman

**Cons:**
- Roundabout (HTTP → OpenAI endpoint → Gateway → LLM)
- Requires enabling OpenAI endpoints in config
- Not using OpenClaw's session management

### Option 4: Plugin Registers Agent Harness (Experimental)
```typescript
api.registerAgentHarness({
  id: "worker-harness",
  execute: async (session, prompt) => {
    // Direct agent execution
    // Plugin controls everything
  }
});
```

**Pros:**
- Direct execution
- Full control

**Cons:**
- Experimental API
- Low-level
- Lots of work to implement

---

## Recommended Architecture

Based on the analysis, **Option 1 (Plugin Triggers Agent)** is the best approach:

### Why Option 1?

1. **Fully Automated** - Plugin triggers agent turns automatically
2. **Uses Existing Infrastructure** - No external processes needed
3. **Agent Has Full Capabilities** - Can use all tools, models, etc.
4. **Plugin is Queue Manager** - Manages workers, tasks, messages
5. **Agent is Executor** - Spawns subagents for actual work

### Implementation Details

#### Step 1: Plugin Manages Queue
- Workers table (identity, status, model)
- Tasks table (title, description, assigned worker)
- Messages table (inter-worker communication)

#### Step 2: Plugin Triggers Agent
When task assigned:
```typescript
// 1. Save task to database
await db.insert("worker_tasks", { worker_id, task_id, status: "assigned" });

// 2. Inject context into agent's next turn
await api.session.workflow.enqueueNextTurnInjection({
  sessionKey: mainSessionKey,
  injection: {
    text: `Worker ${worker.name} has been assigned task: ${task.title}. ` +
          `Task ID: ${task.id}. Worker ID: ${worker.id}. ` +
          `Please spawn a subagent to complete this task.`
  }
});

// 3. Schedule immediate turn (wakes agent if idle)
await api.session.workflow.scheduleSessionTurn({
  sessionKey: mainSessionKey,
  payload: { kind: "agentTurn", message: "Process worker queue" }
});
```

#### Step 3: Agent Processes Queue
When turn fires:
1. Agent sees injected context
2. Agent calls plugin tool: `worker_get_task_details`
3. Plugin returns task + worker context
4. Agent spawns subagent with worker's model + context
5. Subagent does work

#### Step 4: Plugin Tracks Completion
Via hooks:
```typescript
api.on("subagent_ended", async (event) => {
  // Update worker status
  // Check for more tasks
  // Schedule next turn if needed
});
```

---

## Key Insight

The plugin doesn't need to spawn sessions directly. It needs to:

1. **Manage the queue** (workers, tasks, messages)
2. **Trigger the agent** (via scheduled turns + context injection)
3. **Track completion** (via hooks)

The agent does the actual work (spawning subagents). The plugin orchestrates.

---

## Verification: Is This Actually Possible?

Let's verify each component:

### ✅ Plugin Can Save to Database
- Plugin has access to SQLite via `getDb()`
- Can create/update/query tables

### ✅ Plugin Can Inject Context
- `api.session.workflow.enqueueNextTurnInjection()` is documented
- Injects into next agent turn

### ✅ Plugin Can Trigger Agent Turn
- `api.session.workflow.scheduleSessionTurn()` is documented
- Schedules immediate turn
- Wakes agent if idle

### ✅ Plugin Can Track Completion
- `api.on("subagent_ended", ...)` hook is documented
- Fires when subagent completes

### ✅ Agent Can Spawn Subagents
- `sessions_spawn` tool is available to agents
- Agent can spawn subagents with custom context

### ✅ Subagent Can Do Work
- Subagent inherits workspace
- Subagent has access to tools
- Subagent can write files, run commands, etc.

---

## Conclusion

**Yes, this architecture is possible within OpenClaw's constraints.**

The plugin:
- Manages the queue (workers, tasks, messages)
- Triggers agent turns (via scheduled turns + context injection)
- Tracks completion (via hooks)

The agent:
- Processes the queue
- Spawns subagents for each task
- Reports results back

The user:
- Assigns tasks in UI
- Everything else is automated

This is the recommended approach.

---

## Reference: Master Genor's Workaround

The OpenAI endpoints workaround is still valid as an alternative:
1. Enable OpenAI endpoints in OpenClaw config
2. Plugin sends requests to OpenClaw's OpenAI endpoint
3. OpenClaw processes as chat completion

But the recommended approach (Option 1) is cleaner and uses OpenClaw's native session management.

---

*Created: 2026-06-24 | Author: Amy*
*Status: Analysis complete*
