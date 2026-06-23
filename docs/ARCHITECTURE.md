# Architecture: Software House × Orchestrator Merger

> **Last Updated:** 2026-06-23
> **Purpose:** The orchestrator plugin manages AI agent sessions for software projects. The Software House UI is the single frontend. Every backend function must make sense in the new system.

---

## The Problem

Two separate systems exist today:

**Backend (what works):**
- 44 AI tools for session/project/backlog/model/workflow/QA management
- 8 hooks for lifecycle events
- 25 API routes for the classic dashboard
- 8 DB tables for persistence

**Frontend (what's pretty):**
- Software House UI — pixel-art office visualization
- Loads from mock JSON — nothing persists
- Every write action modifies local JS arrays only

**The gap:**
- Backend has 13 features with NO UI
- UI has 14 features with NO backend
- 5 features partially overlap (shown in classic dashboard only)

---

## The Solution

### Core Concept: Workers in Projects

The UI shows **workers** (agents with roles, models, sprites) doing **tasks** (backlog items with phases) in **projects** (with rooms, vault, chat).

| UI Concept | Backend Table | Purpose |
|------------|---------------|---------|
| Agent persona | `agents` | Persistent identity (name, role, sprite, model, prompt, room) |
| Room | `rooms` | Workspace grouping (purpose, task types) |
| Task | `backlog_tasks` | Work item (phase, agent assignment, priority) |
| Vault | `vault_docs` | Document storage (path, content) |
| PM Chat | `pm_chat` | Communication (messages, timestamps) |
| Session | `sessions` | Ephemeral execution (agent + task + status + context) |

### Key Insight: Agents Are Personas, Sessions Are Ephemeral

An agent is a persistent persona. It can have multiple sessions over time, each working on different tasks. The agent persona is persistent, but sessions are ephemeral.

---

## Data Model

### New Tables

```sql
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
  taskTypes TEXT,
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
  tags TEXT,
  status TEXT,
  links TEXT,
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
```

### Extended Tables

```sql
ALTER TABLE sessions ADD COLUMN agent_id TEXT;
ALTER TABLE sessions ADD COLUMN context_used TEXT;
ALTER TABLE backlog_tasks ADD COLUMN agent_id TEXT;
```

---

## API Layer

### Bootstrap Endpoint

`GET /api/software-house/bootstrap`

Returns full project state matching mock JSON shape exactly.

### Agent CRUD

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/software-house/agents` | GET | List agents |
| `/api/software-house/agents/hire` | POST | Create agent |
| `/api/software-house/agents/:id` | PATCH | Edit agent |
| `/api/software-house/agents/:id` | DELETE | Fire agent |

### Room CRUD

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/software-house/rooms` | GET | List rooms |
| `/api/software-house/rooms` | POST | Add room |
| `/api/software-house/rooms/:id` | PATCH | Edit room |
| `/api/software-house/rooms/:id` | DELETE | Delete room |
| `/api/software-house/layout/save` | POST | Save room positions |

### Kanban

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/software-house/backlog` | GET | List tasks |
| `/api/software-house/backlog/move` | POST | Move task phase |

### PM Chat

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/software-house/pm/chat` | GET | Load chat history |
| `/api/software-house/pm/chat` | POST | Send message |

### Vault

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/software-house/vault/tree` | GET | List documents |
| `/api/software-house/vault/doc` | GET | Get document |
| `/api/software-house/vault/doc` | PUT | Update document |
| `/api/software-house/vault/inject` | POST | Inject into AI context |

---

## How Backend Functions Map to UI

### Registration Flow
```
Agent persona (agents table)
  → genorch_session_register (creates session)
  → genorch_project_bind (loads project docs)
  → genorch_session_start_work (begins work)
```
**UI shows:** Agent desk with status "working", task assigned, progress bar.

### Project Management
```
genorch_project_create (creates project)
  → Add rooms (rooms table)
  → Add agents (agents table)
  → Manage vault (vault_docs table)
```
**UI shows:** Project switcher, rooms with agents, vault tree.

### Task Management
```
genorch_backlog_add (creates task)
  → Assign to agent (backlog_tasks.agent_id)
  → Move through phases (backlog_tasks.phase)
  → Dispatch to session (genorch_backlog_dispatch)
```
**UI shows:** Kanban board with tasks, drag to move phases, assign agents.

### Context Injection
```
Vault documents (vault_docs table)
  → before_prompt_build hook
  → Inject per task, per project
  → Agent receives proper context
```
**UI shows:** Vault tree, inject button, documents linked to tasks.

### Session Management
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

### Logging Work
```
genorch_session_log (logs completed session)
  → genorch_adr_log (generates ADR)
  → Store in vault_docs
```
**UI shows:** Completed tasks in kanban, ADRs in vault.

### Q&A Gate
```
genorch_qa_submit (submits for review)
  → genorch_qa_approve / genorch_qa_reject
  → Iterate if rejected
  → Advance to next phase if approved
```
**UI shows:** QA badge on task cards, approve/reject buttons.

### Model Selection
```
genorch_models_recommend (recommends model)
  → Route based on task type
  → Assign to agent (agents.model)
```
**UI shows:** Agent model display, routing config in settings.

### Subagent Spawning
```
genorch_task_delegate (delegates task)
  → Spawns subagent session
  → Tracks in live_agents
```
**UI shows:** Agent status changes, subagent appears in agents list.

### Workflow Enforcement
```
genorch_workflow_advance_phase (advances phase)
  → enforce_workflow_phases hook
  → Blocks work→log until QA approves
  → Blocks log→finish until handoff created
```
**UI shows:** Workflow phase indicator, QA status on tasks.

---

## Implementation Phases

| Phase | Goal | Key Tasks |
|-------|------|-----------|
| 1 | Database schema | 4 new tables + 2 extended |
| 2 | Bootstrap API | Serve full project state |
| 3 | Agent CRUD | Hire, edit, fire via UI |
| 4 | Room CRUD | Add, edit, delete rooms |
| 5 | Kanban integration | Real task management |
| 6 | PM chat & quick actions | Persistent chat |
| 7 | Vault system | Browse, edit, inject docs |
| 8 | Polish & cleanup | Delete classic dashboard |

---

## File Structure

```
src/
  index.ts              # Plugin entry + all tool definitions
  db.ts                 # SQLite database + migrations
  dashboard-handler.ts  # API routes + static file serving
  
dashboard/
  software-house.html   # Single frontend (SPA)
  data/
    software-house-mock.json  # API contract fixture

docs/
  ARCHITECTURE.md       # This file
  MERGER-PLAN.md        # Implementation plan
  UX-ANALYSIS.md        # Friend's design analysis (preserved)
  SOFTWARE-HOUSE-UI.md  # UI documentation (preserved)
```

---

*This document is the single source of truth for the Software House × Orchestrator architecture.*