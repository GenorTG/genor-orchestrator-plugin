# Software House — Worker System Design

> Based on Master Genor's vision + OpenClaw architecture constraints.
> This is the single source of truth for how workers should work.

---

## Executive Summary

Workers are **persistent AI personas** managed by the plugin. They don't spawn their own subagents directly — instead, the **orchestrator agent (Amy)** spawns subagents on behalf of workers, using worker-specific context. Workers communicate through a **message queue** stored in the database, enabling multi-step collaboration (e.g., dev → QA → dev → merge).

---

## OpenClaw Architecture Constraints

### What Plugins CAN Do
| Capability | API | Use Case |
|------------|-----|----------|
| Register agent tools | `api.registerTool()` | Worker management commands |
| Register hooks | `api.on()` | Track agent events, intercept tool calls |
| Register HTTP routes | `api.registerHttpRoute()` | Software House API |
| Register session extensions | `api.session.state.registerSessionExtension()` | Persist worker state |
| Schedule session turns | `api.session.workflow.scheduleSessionTurn()` | Trigger worker actions |
| Inject next-turn context | `api.session.workflow.enqueueNextTurnInjection()` | Add worker context to agent |
| Subscribe to agent events | `api.agent.events.registerAgentEventSubscription()` | Monitor subagent lifecycle |

### What Plugins CANNOT Do (Directly)
| Limitation | Workaround |
|------------|------------|
| Cannot spawn subagents directly | Agent calls tool → tool triggers scheduled turn |
| Cannot own a session directly | Use main agent session + worker context |
| Cannot bypass model limits | Respect OpenClaw's `maxConcurrent` settings |

### Key Insight
The plugin orchestrates through the **main agent session**. When a worker needs to do work:
1. Plugin injects worker context into the agent's next turn
2. Agent spawns a subagent with that context
3. Subagent does the work
4. Plugin tracks completion via hooks
5. Plugin updates worker status and triggers next step

---

## Core Concepts

### 1. Worker
A persistent persona with:
- **Identity**: name, role, sprite, model
- **Instructions**: system prompt for onboarding
- **State**: current task, status (idle/working/blocked/reviewing)
- **Session**: linked to a session key for tracking

### 2. Task
A unit of work from the backlog:
- **Title + Description**: what needs to be done
- **Assigned Worker**: who should do it
- **Status**: todo → in_progress → review → done
- **Output**: what was produced (files, docs, code)

### 3. Message
Inter-worker communication:
- **From/To**: worker IDs
- **Type**: task_assign, task_complete, review_request, review_feedback, chat
- **Content**: the message body
- **Context**: links to relevant files/commits/docs

### 4. Session
Each worker has a **session key** that tracks:
- All subagent spawns for that worker
- Transcript of work done
- Token usage and costs
- Health status (alive/stalled/failed)

---

## Architecture

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
│                      ORCHESTRATOR (Amy)                                     │
│                                                                             │
│  1. Receives task assignment from UI/PM                                     │
│  2. Loads worker context (role + instructions)                              │
│  3. Builds prompt: "You are {worker}. Task: {task}. Context: {vault docs}" │
│  4. Spawns subagent with worker's model + prompt                           │
│  5. Monitors via hooks (agent_start, agent_end, tool_call)                 │
│  6. On completion: updates worker status, processes next step              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      SUBAGENT (Child Session)                               │
│                                                                             │
│  - Inherits workspace from parent                                          │
│  - Has worker's model + context                                            │
│  - Executes task (codes, tests, writes)                                    │
│  - Returns result to parent session                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      DATABASE (SQLite)                                      │
│                                                                             │
│  workers          - Worker identities and state                            │
│  worker_sessions  - Session keys for tracking                              │
│  worker_messages  - Inter-worker communication                             │
│  worker_tasks     - Task assignments and status                            │
│  backlog_tasks    - Task definitions (existing)                            │
│  pm_chat          - PM ↔ User chat (existing)                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Worker Lifecycle

### Phase 1: Onboarding
```
User creates worker via UI
  → Plugin saves to DB (workers table)
  → Worker appears on office map
  → Worker is "idle" — no active task
```

### Phase 2: Task Assignment
```
PM/User assigns task to worker
  → Plugin creates worker_tasks entry
  → Plugin updates worker status → "assigned"
  → UI shows worker has a task
  → Plugin schedules next turn for orchestrator
```

### Phase 3: Task Execution
```
Orchestrator's turn fires
  → Plugin injects worker context + task into prompt
  → Orchestrator spawns subagent with:
      - Worker's model
      - Worker's system prompt
      - Task description
      - Relevant vault docs
  → Subagent starts working
  → Plugin updates worker status → "working"
  → UI shows worker is active
```

### Phase 4: Completion / Handoff
```
Subagent completes work
  → Hook catches agent_end event
  → Plugin captures output (files changed, docs written)
  → Plugin updates task status
  → If task type requires review:
      → Plugin creates message to QA worker
      → Plugin updates worker status → "waiting_review"
  → If task is final:
      → Plugin updates worker status → "idle"
      → Plugin notifies PM/User
```

### Phase 5: Review Cycle (Dev → QA → Dev)
```
QA worker receives review request
  → Plugin spawns QA subagent
  → QA tests the work
  → If issues found:
      → QA sends feedback to dev
      → Dev gets new task: "Fix issues: [list]"
      → Cycle repeats
  → If passes:
      → QA approves
      → Dev merges/docs
      → Task marked complete
```

---

## Database Schema (New Tables)

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

---

## Tool Design

### Worker Management Tools
| Tool | Purpose | Called By |
|------|---------|-----------|
| `genorch_worker_assign` | Assign task to worker | PM/User |
| `genorch_worker_status` | Get worker status | UI/PM |
| `genorch_worker_message` | Send message to worker | Other workers/PM |
| `genorch_worker_start` | Start working on task | Orchestrator |
| `genorch_worker_complete` | Mark task done | Orchestrator |
| `genorch_worker_review` | Submit for review | Worker |
| `genorch_worker_approve` | Approve work | Reviewer |

### Session Tracking Tools
| Tool | Purpose | Called By |
|------|---------|-----------|
| `genorch_worker_sessions` | List all worker sessions | UI |
| `genorch_worker_health` | Check session health | Monitor |
| `genorch_worker_recover` | Recover stalled session | Monitor |

---

## Failure Recovery

### Known Failure Modes (from Master Genor's experience)
1. **LLM timeouts** — session stalls without notification
2. **Tool call errors** — session stalls
3. **Compaction memory flush** — model loops on wrong calls
4. **Post-compaction stall** — doesn't resume work
5. **File lock corruption** — session destroyed
6. **Gateway restart** — session doesn't auto-resume
7. **API errors/rate limits** — session stalls
8. **Budget exhaustion** — session stops mid-task

### Recovery Strategy
```
Every 60 seconds:
  1. Query worker_sessions for status = 'working'
  2. For each working worker:
      a. Check session health via OpenClaw API
      b. If session is alive but stalled > 5 min:
          → Log warning
          → Notify PM
          → Offer recovery options
      c. If session is dead/missing:
          → Log error
          → Reset worker status to 'idle'
          → Requeue task
          → Notify PM
      d. If session is healthy:
          → Update last_active timestamp
```

### Recovery Actions
| Condition | Action |
|-----------|--------|
| Stalled < 5 min | Log only |
| Stalled 5-15 min | Notify PM, suggest restart |
| Stalled > 15 min | Auto-recover: reset worker, requeue task |
| Session dead | Auto-recover: reset worker, requeue task |
| Budget exhausted | Notify PM, pause worker |

---

## Concurrency Model

### OpenClaw Limits
The plugin must respect OpenClaw's `maxConcurrent` settings:
- `agent.maxConcurrent` — max simultaneous agent runs
- `subagent.maxConcurrent` — max simultaneous subagents

### Plugin Limits (configurable)
```json
{
  "softwareHouse": {
    "maxConcurrentWorkers": 3,
    "maxTasksPerWorker": 1,
    "taskTimeout": 1800000,
    "recoveryInterval": 60000
  }
}
```

### File Conflict Prevention
| Scenario | Strategy |
|----------|----------|
| Workers in different rooms | No conflict — different file domains |
| Workers in same room, different tasks | Soft lock: instruct to stay in lane |
| Workers need same files | Hard lock: separate branches + merge worker |

---

## PM Role

The PM (Project Manager) is a **special worker** with:
- `isOrchestrator: true` flag
- Direct chat with the user (CEO)
- Authority to assign tasks to other workers
- Responsibility for project state (STATE.md, ROADMAP.md)
- Final sign-off on completed work

### PM Workflow
```
User (CEO) → PM: "Build feature X"
  PM analyzes task
  PM breaks into subtasks
  PM assigns to workers
  PM monitors progress
  PM reviews results
  PM reports back to User
  PM updates project docs
```

---

## Model Selection

Each worker has a configured model. The system should:

1. **Respect worker's model** — use what's configured
2. **Fallback chain** — if primary fails, try fallback
3. **Cost awareness** — track token usage per worker
4. **Task-appropriate routing** — PM can suggest model changes

### Example Model Assignment
| Worker | Role | Model | Reason |
|--------|------|-------|--------|
| Alex | Backend Dev | deepseek-v4-flash | Fast, good at code |
| Maya | Frontend Dev | minimax-m2.5 | Good at UI/React |
| Sam | QA | gemini-2.5-flash | Good at analysis |
| Pat | Designer | claude-sonnet-4 | Good at creative |

---

## Context Pipeline

When a worker starts a task:

```
1. Load worker's system prompt from DB
2. Load task description from backlog_tasks
3. Load relevant vault docs:
   - STATE.md (current project state)
   - ROADMAP.md (what's planned)
   - Any docs related to the task
4. Build context:
   "You are {name}, a {role} at a software house.
    Your instructions: {prompt}
    
    Current task: {task.title}
    Description: {task.description}
    
    Project context:
    {vault docs}
    
    Instructions:
    1. Analyze the task
    2. Plan your approach
    3. Implement the solution
    4. Document what you did
    5. When done, call genorch_worker_complete"
5. Spawn subagent with this context
```

---

## UI Requirements

### Real-time Updates
- Poll API every 5 seconds for worker status
- Show animated sprites for working workers
- Show task progress in sidebar
- Show inter-worker messages in chat

### Visual Indicators
| Status | Visual |
|--------|--------|
| idle | 💤 Sleeping sprite |
| working | ⚡ Animated sprite + progress bar |
| blocked | 🔴 Red indicator + blocker message |
| reviewing | 👀 Looking at something sprite |

### Notifications
- Toast when worker completes task
- Toast when worker needs help
- Toast when review is ready
- Badge count for pending messages

---

## Implementation Phases

### Phase 1: Foundation (Current)
- [x] Worker CRUD (hire/edit/fire)
- [x] Room management
- [x] Visual rendering
- [x] Basic API

### Phase 2: Session Tracking
- [ ] Add `worker_sessions` table
- [ ] Track session keys per worker
- [ ] Monitor session health
- [ ] Basic recovery (reset + requeue)

### Phase 3: Task Execution
- [ ] Add `worker_messages` table
- [ ] Worker assign/start/complete tools
- [ ] Orchestrator integration
- [ ] Subagent spawning with context

### Phase 4: Collaboration
- [ ] Inter-worker messaging
- [ ] Dev → QA workflow
- [ ] Review cycle
- [ ] Branch management

### Phase 5: Advanced
- [ ] Auto-recovery from failures
- [ ] Cost tracking per worker
- [ ] Skill assignment per worker
- [ ] Project templates (game, ecommerce, etc.)

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-24 | Workers don't spawn subagents directly | Plugin SDK limitation; orchestrator spawns on behalf |
| 2026-06-24 | Persistent session per worker | Need to track history and recover from failures |
| 2026-06-24 | Message queue for inter-worker comms | Enables dev → QA → dev workflow |
| 2026-06-24 | PM is special worker with isOrchestrator flag | PM coordinates, doesn't execute tasks |
| 2026-06-24 | Respect OpenClaw maxConcurrent limits | Plugin is subordinate to gateway config |

---

*Created: 2026-06-24 | Author: Amy + Master Genor*
*Status: Draft — awaiting review*
