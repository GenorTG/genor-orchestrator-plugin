# Software House Merger: Final Plan

> **Last Updated:** 2026-06-23
> **Purpose:** Refactor the entire orchestrator plugin to work with the Software House UI as the single frontend. Delete classic dashboard. Every backend function must make sense in the new system.

---

## The Problem

Two separate systems exist today:

**Backend (what works):**
- 44 AI tools for session/project/backlog/model/workflow/QA management
- 8 hooks for lifecycle events
- 25 API routes for the classic dashboard
- 8 DB tables for persistence
- Session lifecycle, project management, backlog, models, workflow, QA, tests, pipeline, delegation, knowledge, ADR, logs, config

**Frontend (what's pretty):**
- Software House UI — pixel-art office visualization
- Loads from mock JSON — nothing persists
- Every write action modifies local JS arrays only
- 3 buttons literally say `toast('...mockup')` — they do nothing real

**The gap:**
- Backend has 13 features with NO UI
- UI has 14 features with NO backend
- 5 features partially overlap (shown in classic dashboard only)
- Classic dashboard has features Software House doesn't (models, logs, settings)

**The goal:**
Delete classic dashboard. Make Software House the single frontend. Refactor backend so every function works in the new system. The concept: workers (agents) with task types doing things in projects.

---

## The Solution

### Core Concept: Workers in Projects

The UI shows a concept of **workers** (agents with roles, models, sprites) doing **tasks** (backlog items with phases) in **projects** (with rooms, vault, chat).

The backend needs to support this concept:

| UI Concept | Backend Table | Purpose |
|------------|---------------|---------|
| Agent persona | `agents` | Persistent identity (name, role, sprite, model, prompt, room) |
| Room | `rooms` | Workspace grouping (purpose, task types) |
| Task | `backlog_tasks` | Work item (phase, agent assignment, priority) |
| Vault | `vault_docs` | Document storage (path, content) |
| PM Chat | `pm_chat` | Communication (messages, timestamps) |
| Session | `sessions` | Ephemeral execution (agent + task + status + context) |

### Key Insight: Agents Are Personas, Sessions Are Ephemeral

An agent (like "Alex - Backend Dev") is a persistent persona. It can have multiple sessions over time, each working on different tasks. The agent persona is persistent, but sessions are ephemeral.

This maps cleanly to the orchestrator's existing model:
- **Agent persona** = persistent configuration (name, role, model, prompt, room)
- **Session** = ephemeral execution (agent + task + status + context)
- **Task** = work item (backlog task with phase, agent assignment)

---

## What Changes vs What Stays

### What STAYS (all 44 tools work as-is)

All existing tools remain unchanged. They operate on the existing data model:

| Category | Tools | Why They Stay |
|----------|-------|---------------|
| Session lifecycle | register, unregister, start_work, clear_work, log, status | Core functionality |
| Project management | bind, join, create, list_active, sync_files, sync_docs, docs_list, docs_get, docs_update, rebuild_state, tidy_docs | Core functionality |
| Backlog management | add, list, update, dispatch, dispatch_all | Core functionality |
| Model management | list, check_routing, auto_discover, recommend | Core functionality |
| Workflow | advance_phase, handoff_create | Core functionality |
| QA gate | submit, approve, reject | Core functionality |
| Tests | create_unit, create_e2e | Core functionality |
| Pipeline | verify_start, check, guide | Core functionality |
| Delegation | task_delegate, issue_debug, feature_design | Core functionality |
| Knowledge | quiz | Core functionality |
| Logs & diagnostics | logs_query, system_diagnose, config_show_routing | Core functionality |
| ADR | adr_log | Core functionality |

### What CHANGES (new tables, new API, UI wiring)

| Change | What | Why |
|--------|------|-----|
| New table: `agents` | Persistent agent personas | UI needs to show agents with roles, sprites, models |
| New table: `rooms` | Workspace groupings | UI needs to show rooms with purposes, task types |
| New table: `vault_docs` | Document storage | UI needs to browse, edit, inject documents |
| New table: `pm_chat` | Chat persistence | UI needs persistent PM chat |
| Extend `sessions` | Add agent_id, context_used | Link sessions to agents, track context |
| Extend `backlog_tasks` | Add agent_id | Assign tasks to agents |
| New API endpoints | 18 endpoints for UI | Connect UI to backend |
| Delete classic dashboard | Remove index.html | Software House is the single frontend |
| Wire Software House | Replace mock data with real API | UI connects to backend |

---

## Architecture

### Data Model

```sql
-- New tables
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,
  sprite TEXT,
  model TEXT,
  prompt TEXT,
  room TEXT,
  status TEXT DEFAULT 'sleep',
  project TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT,
  taskTypes TEXT,  -- JSON array
  project TEXT,
  x INTEGER DEFAULT 0,
  y INTEGER DEFAULT 0,
  w INTEGER DEFAULT 0,
  h INTEGER DEFAULT 0,
  isCommand INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE vault_docs (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  content TEXT,
  project TEXT,
  folder TEXT,
  icon TEXT,
  title TEXT,
  tags TEXT,  -- JSON array
  status TEXT,
  links TEXT,  -- JSON array
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE pm_chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  sender TEXT,
  project TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Extended tables
ALTER TABLE sessions ADD COLUMN agent_id TEXT;
ALTER TABLE sessions ADD COLUMN context_used TEXT;
ALTER TABLE backlog_tasks ADD COLUMN agent_id TEXT;
```

### API Endpoints (18 new)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/software-house/bootstrap` | GET | Full project state (replaces mock JSON) |
| `/api/software-house/agents` | GET | List agents |
| `/api/software-house/agents/hire` | POST | Create agent |
| `/api/software-house/agents/:id` | PATCH | Edit agent |
| `/api/software-house/agents/:id` | DELETE | Fire agent |
| `/api/software-house/rooms` | GET | List rooms |
| `/api/software-house/rooms` | POST | Add room |
| `/api/software-house/rooms/:id` | PATCH | Edit room |
| `/api/software-house/rooms/:id` | DELETE | Delete room |
| `/api/software-house/layout/save` | POST | Save room positions |
| `/api/software-house/backlog` | GET | List tasks |
| `/api/software-house/backlog/move` | POST | Move task phase |
| `/api/software-house/pm/chat` | GET | Load chat history |
| `/api/software-house/pm/chat` | POST | Send message |
| `/api/software-house/vault/tree` | GET | List documents |
| `/api/software-house/vault/doc` | GET | Get document |
| `/api/software-house/vault/doc` | PUT | Update document |
| `/api/software-house/vault/inject` | POST | Inject into AI context |

### Bootstrap Response Shape (matches mock JSON exactly)

```json
{
  "defaultProjectId": "genor-orchestrator-plugin",
  "projects": {
    "genor-orchestrator-plugin": {
      "id": "genor-orchestrator-plugin",
      "name": "GenorBoard v2",
      "rooms": [
        {
          "id": "command",
          "name": "Command Center",
          "tag": "pm",
          "color": "#a78bfa",
          "isCommand": true,
          "purpose": "Project Manager plans sprints, assigns tasks, coordinates team.",
          "taskTypes": ["docs"],
          "layout": "auto",
          "x": 0, "y": 0, "w": 0, "h": 0
        }
      ],
      "agents": [
        {
          "id": "pm",
          "name": "Project Manager",
          "role": "Project Manager",
          "sprite": "blue",
          "model": "orchestrator-brain",
          "status": "thinking",
          "task": "Plan sprint",
          "progress": 0,
          "room": "command",
          "isOrchestrator": true,
          "prompt": "Project manager.",
          "ctx": "—"
        }
      ],
      "tasks": [
        {
          "id": "t1",
          "title": "API Gateway",
          "desc": "API Gateway with rate limiting.",
          "agent": "alex",
          "phase": "in-progress",
          "pri": "P0",
          "type": "dev"
        }
      ],
      "vault": {
        "STATE.md": {
          "folder": "📁 root",
          "icon": "📊",
          "title": "STATE.md",
          "updated": "2026-06-22 22:00",
          "tags": ["status"],
          "status": "ok",
          "links": [],
          "html": "..."
        }
      }
    }
  }
}
```

---

## How Every Backend Function Works in the New System

### 1. Registration Flow
```
Agent persona (agents table)
  → genorch_session_register (creates session)
  → genorch_project_bind (loads project docs)
  → genorch_session_start_work (begins work)
```

**UI shows:** Agent desk with status "working", task assigned, progress bar.

### 2. Project Management
```
genorch_project_create (creates project)
  → Add rooms (rooms table)
  → Add agents (agents table)
  → Manage vault (vault_docs table)
```

**UI shows:** Project switcher, rooms with agents, vault tree.

### 3. Task Management
```
genorch_backlog_add (creates task)
  → Assign to agent (backlog_tasks.agent_id)
  → Move through phases (backlog_tasks.phase)
  → Dispatch to session (genorch_backlog_dispatch)
```

**UI shows:** Kanban board with tasks, drag to move phases, assign agents.

### 4. Context Injection
```
Vault documents (vault_docs table)
  → before_prompt_build hook
  → Inject per task, per project
  → Agent receives proper context
```

**UI shows:** Vault tree, inject button, documents linked to tasks.

### 5. Session Management
```
Sessions (sessions table)
  → Track agent_id, progress, context_used
  → Map status to visual states:
    - idle → sleep
    - running → working
    - done → success
    - failed → error
```

**UI shows:** Agent desks with visual states, progress bars, context usage.

### 6. Logging Work
```
genorch_session_log (logs completed session)
  → genorch_adr_log (generates ADR)
  → Store in vault_docs
```

**UI shows:** Completed tasks in kanban, ADRs in vault.

### 7. Q&A Gate
```
genorch_qa_submit (submits for review)
  → genorch_qa_approve / genorch_qa_reject
  → Iterate if rejected
  → Advance to next phase if approved
```

**UI shows:** QA badge on task cards, approve/reject buttons.

### 8. Model Selection
```
genorch_models_recommend (recommends model)
  → Route based on task type
  → Assign to agent (agents.model)
```

**UI shows:** Agent model display, routing config in settings.

### 9. Subagent Spawning
```
genorch_task_delegate (delegates task)
  → Spawns subagent session
  → Tracks in live_agents
```

**UI shows:** Agent status changes, subagent appears in agents list.

### 10. Workflow Enforcement
```
genorch_workflow_advance_phase (advances phase)
  → enforce_workflow_phases hook
  → Blocks work→log until QA approves
  → Blocks log→finish until handoff created
```

**UI shows:** Workflow phase indicator, QA status on tasks.

---

## Implementation Phases

### Phase 1: Database Schema
**Goal:** Add all missing tables and columns.

| Task | File | Change |
|------|------|--------|
| Create `agents` table | `src/db.ts` | V4 migration |
| Create `rooms` table | `src/db.ts` | V4 migration |
| Create `vault_docs` table | `src/db.ts` | V4 migration |
| Create `pm_chat` table | `src/db.ts` | V4 migration |
| Extend `sessions` | `src/db.ts` | Add agent_id, context_used |
| Extend `backlog_tasks` | `src/db.ts` | Add agent_id |

### Phase 2: Bootstrap API
**Goal:** Backend serves full project state.

| Task | File | Change |
|------|------|--------|
| Create bootstrap endpoint | `src/dashboard-handler.ts` | `GET /api/software-house/bootstrap` |
| Query agents, rooms, tasks, vault | `src/dashboard-handler.ts` | Join across tables |
| Match mock JSON shape exactly | `src/dashboard-handler.ts` | Field-by-field mapping |

### Phase 3: Agent CRUD
**Goal:** Hire, edit, fire agents via UI.

| Task | File | Change |
|------|------|--------|
| Create hire endpoint | `src/dashboard-handler.ts` | `POST /api/software-house/agents/hire` |
| Create edit endpoint | `src/dashboard-handler.ts` | `PATCH /api/software-house/agents/:id` |
| Create fire endpoint | `src/dashboard-handler.ts` | `DELETE /api/software-house/agents/:id` |
| Wire UI buttons | `dashboard/software-house.html` | Replace mock functions |

### Phase 4: Room CRUD
**Goal:** Add, edit, delete rooms via UI.

| Task | File | Change |
|------|------|--------|
| Create add endpoint | `src/dashboard-handler.ts` | `POST /api/software-house/rooms` |
| Create edit endpoint | `src/dashboard-handler.ts` | `PATCH /api/software-house/rooms/:id` |
| Create delete endpoint | `src/dashboard-handler.ts` | `DELETE /api/software-house/rooms/:id` |
| Create layout save | `src/dashboard-handler.ts` | `POST /api/software-house/layout/save` |
| Wire UI drag/resize | `dashboard/software-house.html` | Save positions |

### Phase 5: Kanban Integration
**Goal:** Real task management with phase advancement.

| Task | File | Change |
|------|------|--------|
| Create move endpoint | `src/dashboard-handler.ts` | `POST /api/software-house/backlog/move` |
| Wire kanban drag | `dashboard/software-house.html` | Real API calls |
| Sync phase/status | `src/dashboard-handler.ts` | Keep columns consistent |

### Phase 6: PM Chat & Quick Actions
**Goal:** Persistent chat and real quick actions.

| Task | File | Change |
|------|------|--------|
| Create chat GET | `src/dashboard-handler.ts` | `GET /api/software-house/pm/chat` |
| Create chat POST | `src/dashboard-handler.ts` | `POST /api/software-house/pm/chat` |
| Wire quick actions | `src/dashboard-handler.ts` | Route to `handleQuickAction()` |
| Wire UI | `dashboard/software-house.html` | Real messages |

### Phase 7: Vault System
**Goal:** Browse, edit, inject documents.

| Task | File | Change |
|------|------|--------|
| Create vault tree | `src/dashboard-handler.ts` | `GET /api/software-house/vault/tree` |
| Create vault doc GET | `src/dashboard-handler.ts` | `GET /api/software-house/vault/doc` |
| Create vault doc PUT | `src/dashboard-handler.ts` | `PUT /api/software-house/vault/doc` |
| Create vault inject | `src/dashboard-handler.ts` | `POST /api/software-house/vault/inject` |
| Add injection hook | `src/index.ts` | `before_prompt_build` consumes vault |

### Phase 8: Polish & Cleanup
**Goal:** Remove classic dashboard, ensure everything works.

| Task | File | Change |
|------|------|--------|
| Delete classic dashboard | `dashboard/index.html` | Remove |
| Remove mock data | `dashboard/software-house.html` | Replace with API |
| Remove mockup toasts | `dashboard/software-house.html` | Real functions |
| Add loading spinners | `dashboard/software-house.html` | UX improvement |
| Test all functions | Manual | Verify every button works |
| Update documentation | `docs/` | Reflect new architecture |

---

## Files to Modify

| File | Change |
|------|--------|
| `src/db.ts` | V4 migration: 4 new tables + 2 extended |
| `src/dashboard-handler.ts` | 18 new API endpoints |
| `src/index.ts` | Vault injection in `before_prompt_build` hook |
| `dashboard/software-house.html` | Wire `loadData()` to bootstrap, remove mock functions |
| `dashboard/index.html` | DELETE (classic dashboard removed) |
| `docs/ARCHITECTURE.md` | Update with final architecture |
| `docs/MERGER-PLAN.md` | Update with final plan |

## Preserved Files

| File | Why |
|------|-----|
| `UX-ANALYSIS.md` | Friend's design analysis |
| `SOFTWARE-HOUSE-UI.md` | UI documentation |
| `software-house-mock.json` | API contract fixture |
| `assets/pixel-agents/` | All 40 sprites |
| `software-house.html` | Friend's SPA (modified, not replaced) |

---

## Deployment

1. Edit source in `~/projects/genor-orchestrator-plugin/`
2. Run `npm run build`
3. Deploy: `rsync -a dist/ ~/.openclaw/extensions/genorch/dist/`
4. Gateway restart (manual, requires Master Genor approval)

---

## Risk Assessment

| Risk | Mitigation |
|------|------------|
| Bootstrap API shape mismatch | Match mock JSON field-by-field, test with UI |
| Session-agent linking breaks | Test registration flow end-to-end |
| Vault injection fails | Test `before_prompt_build` hook |
| Kanban phase/status desync | Sync columns in move endpoint |
| Classic dashboard removal breaks operator access | Software House includes all operator features |
| Mock data removal breaks UI | Wire all functions before removing mock |

---

*This plan is the single source of truth for the Software House × Orchestrator merger.*