# 🏢 Genor Software House — Merger Plan: Backend × Frontend

> **Status:** Plan Proposal  
> **Version:** 1.0  
> **Branch:** `main` (merged `feat/software-house`)  
> **Plugin:** genor-orchestrator-plugin  

---

## 1. 🧠 Core Architecture

### Current State (Before)
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  AI Tools   │────▶│ Orchestrator│────▶│  SQLite DB  │
│  (40 tools) │     │  Engine     │     │             │
└─────────────┘     └──────┬──────┘     └─────────────┘
                           │
                    ┌──────▼──────┐
                    │  Dashboard  │
                    │  (classic)  │
                    └─────────────┘
```

### Target State (After)
```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  AI Tools   │────▶│ Orchestrator│────▶│  SQLite DB  │
│  (40 tools) │     │  Engine     │     │  (extended) │
└─────────────┘     └──────┬──────┘     └──────┬──────┘
                           │                    │
                    ┌──────▼──────┐    ┌────────▼────────┐
                    │  Dashboard  │    │ Software House  │
                    │  (classic)  │    │ UI (new SPA)    │
                    └─────────────┘    └────────┬────────┘
                                                │
                    ┌───────────────────────────────┐
                    │ New API Endpoints (REST + SSE)│
                    │ • bootstrap  • live-agents    │
                    │ • vault      • rooms          │
                    │ • agents     • pm/chat        │
                    │ • kanban     • hire           │
                    └───────────────────────────────┘
```

**Key principle:** UI is a consumer of the backend. The 40 existing AI tools stay as the "API for agents". The Software House UI gets a new set of REST endpoints that are the "API for humans".

---

## 2. 🗃️ Data Model (QA: Extend existing, avoid parallel tables)

**Instead of 4 new tables, extend 2 existing + 2 new:**
- Extend `backlog_tasks`: add `phase`, `agent_id`, `task_type` columns (replaces proposed `backlog_tasks (extended)`)
- Extend `sessions`: add `progress`, `context_used`, `output_summary` (replaces proposed `agent_sessions`)
- New: `rooms`, `agents`, `vault_docs`, `pm_chat`

### V4 Migration (in existing `db.ts` pattern)

```typescript
case 4:
  // Extend existing tables
  db.exec(`ALTER TABLE backlog_tasks ADD COLUMN phase TEXT DEFAULT 'backlog'`);
  db.exec(`ALTER TABLE backlog_tasks ADD COLUMN agent_id TEXT`);
  db.exec(`ALTER TABLE backlog_tasks ADD COLUMN task_type TEXT DEFAULT 'dev'`);
  db.exec(`ALTER TABLE sessions ADD COLUMN progress INTEGER DEFAULT 0`);
  db.exec(`ALTER TABLE sessions ADD COLUMN context_used TEXT`);
  db.exec(`ALTER TABLE sessions ADD COLUMN output_summary TEXT`);
  // New tables
  db.exec(`CREATE TABLE IF NOT EXISTS agents (...)`);
  db.exec(`CREATE TABLE IF NOT EXISTS rooms (...)`);
  db.exec(`CREATE TABLE IF NOT EXISTS vault_docs (...)`);
  db.exec(`CREATE TABLE IF NOT EXISTS pm_chat (...)`);
  break;
```

### New Tables

```sql
-- ── Agent registry (employee records) ──
CREATE TABLE agents (
  id          TEXT PRIMARY KEY,        -- "alex", "maya"
  project_id  TEXT NOT NULL,           -- FK to project
  name        TEXT NOT NULL,           -- "Alex"
  role        TEXT NOT NULL,           -- "Backend Developer"
  sprite      TEXT DEFAULT 'blue',     -- "blue"|"orange"|"violet"|"hacker"
  model       TEXT NOT NULL,           -- model id to spawn
  status      TEXT DEFAULT 'idle',     -- working|reviewing|thinking|idle|error
  room_id     TEXT,                    -- FK to room
  last_task   TEXT,
  system_prompt TEXT DEFAULT '',
  created_at  TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- ── Room layout (office floorplan) ──
CREATE TABLE rooms (
  id          TEXT PRIMARY KEY,        -- "backend", "design"
  project_id  TEXT NOT NULL,
  name        TEXT NOT NULL,           -- "Backend Bay"
  color       TEXT DEFAULT '#5e9cff',
  purpose     TEXT DEFAULT '',
  task_types  TEXT DEFAULT '[]',       -- JSON: ["dev","devops"]
  layout      TEXT DEFAULT 'auto',     -- auto|row|column
  pos_x       INTEGER DEFAULT 0,
  pos_y       INTEGER DEFAULT 0,
  pos_w       INTEGER DEFAULT 0,
  pos_h       INTEGER DEFAULT 0,
  is_command  INTEGER DEFAULT 0,
  is_openfloor INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- (backlog_tasks (extended) DROPPED — extend existing backlog_tasks instead)
-- (agent_sessions DROPPED — extend existing sessions instead)

-- ── Project vault document index ──
CREATE TABLE vault_docs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  file_path   TEXT NOT NULL,           -- "STATE.md", "docs/ARCHITECTURE.md"
  title       TEXT,
  icon        TEXT DEFAULT '📄',
  folder      TEXT,                    -- null = root
  doc_type    TEXT DEFAULT 'note',
  content     TEXT DEFAULT '',
  tags        TEXT DEFAULT '[]',
  status      TEXT DEFAULT 'active',   -- active|stable|draft|archive
  updated_at  TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- ── PM chat messages ──
CREATE TABLE pm_chat (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL,
  role        TEXT NOT NULL,           -- user|pm|system
  message     TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
```

### Relationship Map

```
Project (existing)
  ├── Rooms (new)          — office floorplan, task routing
  ├── Agents (new)         — employee records
  │     └── sessions (extended) — running/finished sessions (+ progress, ctx)
  ├── backlog_tasks (extended) — pipeline cards (+ phase, agent_id, task_type)
  ├── VaultDocs (new)      — project document index
  ├── PMChat (new)         — conversation history
  └── session_log (existing) — raw logging
```

---

## 3. 🛠️ Backend Changes

### 3.0 Auth Model

All mutating endpoints (hire, fire, save vault, move task) MUST fail with 401 if no valid gateway token. Read-only endpoints may work unauthenticated for local dev.

**Alpha simplification:** Gateway binds to localhost:18789 by default. Skip token check until UI is exposed beyond localhost.

### 3.0b Bootstrap API Contract (must match mock JSON shape)

The UI accesses `data.projects[projectId]` and `project.vault["STATE.md"]`. The bootstrap endpoint must return the EXACT same nested structure:

```
GET /api/software-house/bootstrap?project=X
→ {
    defaultProjectId: string,
    projects: {
      [id: string]: {
        id, name,
        rooms: Room[],
        agents: Agent[],
        tasks: Task[],
        vault: { [path: string]: VaultDoc }  ← keyed by path, full content
      }
    }
  }
```

**Model name mapping:** Translate `opencode-go/deepseek-v4-flash` → `deepseek-v4-flash` in responses (strip prefix for UI display).

**Fat endpoint is intentional:** Alpha simplicity over restful purity. Mock JSON becomes the test fixture.

### 3.0c V4 Migration Strategy

Extend existing `db.ts` V1→V2→V3 pattern with:

```typescript
case 4:
  db.exec(`ALTER TABLE backlog_tasks ADD COLUMN phase TEXT DEFAULT 'backlog'`);
  db.exec(`ALTER TABLE backlog_tasks ADD COLUMN agent_id TEXT`);
  db.exec(`ALTER TABLE backlog_tasks ADD COLUMN task_type TEXT DEFAULT 'dev'`);
  db.exec(`ALTER TABLE sessions ADD COLUMN progress INTEGER DEFAULT 0`);
  db.exec(`ALTER TABLE sessions ADD COLUMN context_used TEXT`);
  db.exec(`ALTER TABLE sessions ADD COLUMN output_summary TEXT`);
  db.exec(`CREATE TABLE IF NOT EXISTS agents (...)`);
  db.exec(`CREATE TABLE IF NOT EXISTS rooms (...)`);
  db.exec(`CREATE TABLE IF NOT EXISTS vault_docs (...)`);
  db.exec(`CREATE TABLE IF NOT EXISTS pm_chat (...)`);
  db.exec(`PRAGMA user_version = 4`);
  break;
```

### 3.1 New API Endpoints (in `dashboard-handler.ts`)

| Method | Path | Purpose | Maps to Mock |
|--------|------|---------|-------------|
| `GET` | `/orchestrator/api/software-house/bootstrap?project=X` | One-shot state for UI | `software-house-mock.json` |
| `GET` | `/orchestrator/api/software-house/vault/doc?project=X&path=Y` | Markdown document content | `vault[].html` |
| `GET` | `/orchestrator/api/software-house/vault/tree?project=X` | Vault file tree | folder structure |
| `PUT` | `/orchestrator/api/software-house/vault/doc?project=X&path=Y` | Save document | — |
| `POST` | `/orchestrator/api/software-house/pm/chat?project=X` | PM chat message | — |
| `GET` | `/orchestrator/api/software-house/pm/chat?project=X` | Chat history | — |
| `PATCH` | `/orchestrator/api/software-house/rooms` | Save room layout | — |
| `POST` | `/orchestrator/api/software-house/agents/hire` | Create agent + spawn | hire modal |
| `PATCH` | `/orchestrator/api/software-house/agents/:id` | Update agent config | detail panel |
| `DELETE` | `/orchestrator/api/software-house/agents/:id` | Fire agent | — |
| `POST` | `/orchestrator/api/software-house/kanban/move` | Move task between phases | drag & drop |
| `POST` | `/orchestrator/api/software-house/vault/inject` | Inject vault doc into active session | "inject" button |
| `GET` | `/orchestrator/api/sse/live-sessions` (existing) | SSE endpoint for live status (existing SSE extended) | real-time UI |

### 3.2 Modified Existing Endpoints

| Endpoint | Change |
|----------|--------|
| `GET /api/project-state` | Include room/agent/task counts for project stats |
| `GET /api/live-agents` | Return agent session info mapped to `Agent` schema |
| `POST /api/spawn-project-session` | Also create `agent_sessions` row when spawning |
| `POST /api/quick-action` | Route PM quick-action requests to orchestration |
| `GET /api/config` | Include software-house settings (font scale, default view) |
| `POST /api/config` | Accept software-house config keys |

### 3.3 Internal Services (new files under `src/` or modularized)

| Service | Responsibility |
|---------|---------------|
| `src/software-house/agents.ts` | Agent CRUD, spawn logic, session mapping |
| `src/software-house/rooms.ts` | Room CRUD, auto-fit layout, task routing |
| `src/software-house/kanban.ts` | Task CRUD, phase transitions, pipeline logic |
| `src/software-house/vault.ts` | Document CRUD, markdown parsing, wikilink resolving |
| `src/software-house/pm-chat.ts` | PM chat session, LLM interaction, context building |
| `src/software-house/bootstrap.ts` | One-shot state aggregation for UI |
| `src/software-house/data-models.ts` | TypeScript interfaces for all new types |

**Alternative (simpler):** Keep everything in `src/index.ts` but organized in clear sections. For this alpha phase, single-file is fine. Only extract if file exceeds ~8k lines.

---

## 4. 🖥️ Frontend Merger Plan

### 4.1 Current Structure

`dashboard/software-house.html` is a single-file SPA (~1695 lines).

**Cleanup before Phase 1:** Remove  root copies (keep  as canonical). Remove prototype HTML files: , , .
- Inline CSS (~500 lines)
- Inline HTML (shell layout)
- Inline JS (~1200 lines) including:
  - Render functions (offices, desks, kanban, vault)
  - Event handlers
  - Mock data fetch/render

### 4.2 Replacement Strategy

**Phase A — Replace mock JSON with live bootstrap:**

```javascript
// Before:
async function loadData(projectId) {
  const resp = await fetch('/orchestrator/data/software-house-mock.json');
  const data = await resp.json();
  return data.projects[projectId];
}

// After:
async function loadData(projectId) {
  const resp = await fetch(`/orchestrator/api/software-house/bootstrap?project=${projectId}`);
  const data = await resp.json();
  return data;  // Same shape as mock JSON
}
```

**Key:** The mock JSON IS the API contract. The `bootstrap` endpoint returns the EXACT shape the UI already consumes. No frontend changes needed except the URL.

**Phase B — Replace write actions:**

Each interactive action in the UI maps to an API call:

| UI Action | Mock (current) | Live (target) |
|-----------|---------------|---------------|
| Move kanban task | Local state only | `POST /api/software-house/kanban/move` |
| Hire agent | Push to local agents[] | `POST /api/software-house/agents/hire` |
| Save room layout | `alert("not implemented")` | `PATCH /api/software-house/rooms` |
| PM chat message | `console.log(msg)` | `POST /api/software-house/pm/chat` |
| Vault inject | `alert("injected!")` | `POST /api/software-house/vault/inject` |
| Font scale | localStorage | localStorage (keep client-side) |
| Pan/zoom | Canvas state | Canvas state (keep client-side) |

**Phase C — Real-time via SSE:**

```javascript
const es = new EventSource('/orchestrator/api/sse/live-sessions');
es.onmessage = (e) => {
  const update = JSON.parse(e.data);
  updateAgentStatus(update);  // Update desk animations without page reload
};
```

### 4.3 No-Change Zones (frontend untouched)

- CSS theme (dark pixel-art aesthetic stays as-is)
- Layout components (header, sidebar, office canvas, chat panel)
- Pixel-agent sprite system (animations, status visuals)
- Pan/zoom canvas controls
- Font scale controls
- Modal UIs (hire agent, agent detail, room settings)

---

## 5. 🤖 Agent as Employee — Lifecycle

### 5.1 States

```
┌─────────┐   hire    ┌──────────┐   spawn session   ┌──────────┐
│  Idle   │──────────▶│  Pending │──────────────────▶│  Working  │
│         │           │          │                    │           │
│ No task │           │ Created  │                    │ Has task  │
└─────────┘           │ no spawn │                    │ session   │
      ▲               └──────────┘                    └─────┬─────┘
      │                                                    │
      │               ┌──────────┐                    ┌────▼─────┐
      │               │  Error   │◀───────────────────│  Review   │
      │               │          │    review failed    │           │
      │               └──────────┘                    └─────┬─────┘
      │                       │                             │
      │                       │                    ┌────▼─────┐
      └───────────────────────┴────────────────────│ Complete  │
                           session ends            │ Done      │
                                                   └──────────┘
```

### 5.2 Hire → Spawn Flow

```
1. User clicks "+ Hire" or PM creates agent
2. UI: Form — name, role, model, sprite, room, prompt
3. API: POST /api/software-house/agents/hire
4. Backend:
   a. INSERT INTO agents (...)
   b. POST /v1/chat/completions with x-openclaw-session-key → spawns isolated session
   c. INSERT INTO agent_sessions (session_key = returned key)
5. UI: New desk appears in room, agent is "pending" → "working"
```

### 5.3 Task → Agent Flow

```
1. PM or user creates task in kanban (backlog)
2. Orchestrator matches task.type to room.taskTypes → finds room
3. Room has agents → pick least-loaded agent
4. Task assigned: UPDATE backlog_tasks (extended) SET agent_id=X, phase='in-progress'
5. Agent's next before_prompt_build includes task context
6. Agent works in isolated session
7. Completion → phase='review'
```

---

## 6. 🧠 PM Orchestrator

**⚠️ Deferred to Phase 5 (QA-informed):** Building a full LLM orchestrator inside a plugin HTTP handler is heavy. No precedent in codebase. For Phases 1-3, PM chat stays client-side simulated or routes through existing . Plugin does NOT make its own  calls from inside an HTTP route handler.

### 6.1 What It Is

The PM is a **special orchestrator role** — not a spawned agent session, but the plugin itself acting as project manager. When the user types in the PM chat, the plugin:

1. Builds a system prompt with full project context (agents, tasks, vault, status)
2. Sends to a configurable model (default: deepseek-v4-pro)
3. Parses the response for tool calls or structured output
4. Executes the action (create task, assign agent, generate doc)
5. Returns the PM's reply to the chat

### 6.2 PM Tool Access

The PM orchestrator needs access to a subset of existing tools plus new ones:

| Tool | Purpose |
|------|---------|
| `genorch_backlog_add` | Create tasks from PM plan |
| `genorch_backlog_dispatch` | Assign tasks to agents |
| `genorch_task_delegate` | Spawn subagent for a task |
| `genorch_adr_log` | Document decisions |
| `genorch_project_bind` | Load project context |
| `genorch_session_start_work` | Begin work on task |
| `genorch_session_log` | Log completed work |
| *New:* `vault_write_doc` | Create/update vault document |
| *New:* `vault_read_doc` | Read vault document |
| *New:* `agent_get_status` | Get full agent status |
| *New:* `agent_update_config` | Change agent model/prompt |

### 6.3 PM Chat Architecture

```
User: "plan a sprint for the FinPay project"
  │
  ▼
POST /api/software-house/pm/chat
  │  project="fintech-mobile-app"
  │  message="plan a sprint for the FinPay project"
  ▼
Server builds PM system prompt:
  ┌──────────────────────────────────────────┐
  │ You are the PM Orchestrator for FinPay   │
  │ Mobile project.                          │
  │                                          │
  │ Project context:                         │
  │ • 6 agents (Kai, Zara, Omar, Ivy, ...)   │
  │ • 5 tasks (3 in-progress, 1 review, 1    │
  │   backlog)                               │
  │ • Last sprint velocity: 8 story points   │
  │ • Blockers: Marc waiting for PCI docs    │
  │                                          │
  │ User request: "plan a sprint"            │
  └──────────────────────────────────────────┘
  │
  ▼
Orchestrator mode: PM's LLM call
  │  (configured model, high reasoning)
  ▼
PM response: "Here's the sprint plan..."
  │  + tool calls (if needed):
  │    - genorch_backlog_add (new tasks)
  │    - genorch_adr_log (sprint goal ADR)
  │    - vault_write_doc (SPRINT-PLAN.md)
  ▼
Response streamed back to UI chat panel
```

---

## 7. 🚪 Rooms & Routing

### 7.1 Current Routing (from your backend)

The existing `model_routing` system maps **task_type → model chain**. The new room system maps **task_type → room → agents**. These work together:

```
Task created (type="design")
  → room routing: find room with taskTypes.includes("design") → "Design Studio"
  → agent in room: find least-busy agent → "Maya"
  → model routing: task_type="design" → effective chain → [qwen-3.7-max, minimax-m3]
  → spawn agent with that model
```

### 7.2 Room Visualization

The new `rooms` table stores the layout for the office canvas. The existing `taskTypes` array on each room IS the routing config. The UI shows a visual toggle for which task types each room handles:

```
┌─────────────────────────────┐
│ Design Studio               │
│ ┌───┐ ┌───┐ ┌───┐ ┌────┐  │
│ │DEV│ │DSN│ │QA │ │DOCS│  │  ← toggled chips
│ └───┘ └───┘ └───┘ └────┘  │
│ [Maya - working] -          │
│ (empty desk)  +             │
└─────────────────────────────┘
```

---

## 8. 📚 Vault System

### 8.1 File Storage

Vault documents live on disk at `orchestrator-data/projects/<project>/docs/` as markdown files. The `vault_docs` SQLite table is just an **index** — fast lookups, tags, wikilink resolution. The actual content is on disk.

```
orchestrator-data/projects/fintech-mobile-app/
├── STATE.md             ← auto-generated status
├── ROADMAP.md           ← milestones
├── docs/
│   ├── MOBILE-ARCH.md   ← architecture
│   └── RUNBOOK.md       ← ops
├── decisions/
│   ├── ADR-001.md
│   └── ADR-002.md
├── sprints/
│   └── SPRINT-2.4.md
├── compliance/
│   └── PCI-CHECKLIST.md
└── INDEX.md             ← auto-maintained
```

### 8.2 Context Injection

The existing `before_prompt_build` hook already injects project context. Extend it:

1. If project has a vault with docs, the hook lists the INDEX.md
2. User/PM selects docs to inject via UI button "Inject into session"
3. This calls `POST /api/software-house/vault/inject` which writes selected doc paths to `session_injected_docs` table
4. `before_prompt_build` reads injected docs and appends their markdown content to the prompt

```
User clicks "Inject STATE.md + ARCHITECTURE.md" in vault panel
  → POST /api/software-house/vault/inject
  → { project: "fintech-mobile-app", docs: ["STATE.md", "docs/MOBILE-ARCH.md"] }
  → Server saves to session_injected_docs table
  → Next before_prompt_build:
    "📄 Injected documents: STATE.md, docs/MOBILE-ARCH.md
     ────────────────────────────────────
     [content of STATE.md]
     ────────────────────────────────────
     [content of docs/MOBILE-ARCH.md]"
```

---

## 9. 📋 Implementation Phases

### Phase 0 — Foundation (now) ✅
- [x] PR#22 merged (UI proposal + static routes + pixel agents)
- [x] Registration lifecycle fixed (explicit, no auto-reg, no synthetic)
- [x] Session-project binding separated
- [x] All 40 tools operational

### Phase 1 — DB & API (backend core)
- [ ] Create all new SQLite tables (agents, rooms, backlog_tasks (extended), vault_docs, pm_chat, agent_sessions)
- [ ] Implement `GET /api/software-house/bootstrap` — returns full state in mock JSON shape
- [ ] Implement `GET /api/software-house/vault/tree` + `GET vault/doc` — vault read access
- [ ] Move pixel-agent sprites under dashboard asset routing (done)
- [ ] UI swaps mock URL for live bootstrap endpoint → zero visual diff, real data

### Phase 2 — Agent Lifecycle (hire + spawn)
- [ ] Implement `POST /api/software-house/agents/hire` — create agent record + spawn isolated session
- [ ] Implement `PATCH /api/software-house/agents/:id` — update config
- [ ] Implement `DELETE /api/software-house/agents/:id` — fire agent
- [ ] Implement `backlog_tasks (extended)` assignment: task → room → agent
- [ ] UI: hire modal now triggers real spawn
- [ ] UI: agent status reflects real session state

### Phase 3 — Kanban & Pipeline
- [ ] Implement `POST /api/software-house/kanban/move` — phase transitions
- [ ] Extend existing backlog system to sync with kanban tasks
- [ ] Implement PM quick actions: status report, sprint plan
- [ ] UI: drag-and-drop on kanban triggers real move
- [ ] Pipeline auto-advance: backlog → (when assigned) → in-progress → (when done) → review

### Phase 4 — PM Chat
- [ ] Implement PM session architecture (system prompt builder, context aggregator)
- [ ] Implement `POST /api/software-house/pm/chat` — LLM call with tool access
- [ ] Implement `GET /api/software-house/pm/chat` — history
- [ ] PM can: create tasks, assign agents, plan sprints, generate vault docs
- [ ] UI: chat input sends real messages to PM, gets streamed responses

### Phase 5 — Vault & Context Injection
- [ ] Implement full vault CRUD (create doc, edit, save markdown to disk)
- [ ] Implement wikilink resolver (`[[doc]]` → link)
- [ ] Implement `POST /api/software-house/vault/inject` — context injection hook
- [ ] Auto-generate INDEX.md per project
- [ ] UI: vault panel shows real docs, inject button works

### Phase 6 — Rooms & Layout
- [ ] Implement `PATCH /api/software-house/rooms` — persist canvas layout
- [ ] Auto-fit algorithm for room sizing
- [ ] Room ↔ task_routing integration (existing model_routing + new room routing)
- [ ] UI: save room position/size, restore on reload

### Phase 7 — Real-time & Polish
- [ ] SSE endpoint: live agent status updates on canvas
- [ ] SSE: kanban task movement notifications
- [ ] Remove mock JSON dependency entirely
- [ ] Performance optimization (canvas rendering for 50+ agents)
- [ ] Optional: make Software House the default view

---

## 10. ⚠️ Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| DB migration conflicts | Medium | High | Use idempotent migration (CREATE IF NOT EXISTS) |
| SSE overload with 50 agents | Low | Medium | Throttle SSE updates to 1s intervals |
| PM LLM latency in chat | High | Medium | Show typing indicator, use streaming |
| Agent session key collisions | Low | High | Namespace keys: `genorch-{project}-{agent}-{task}` |
| Frontend drift from mock contract | Medium | Medium | Keep mock JSON as fixture test |
| Room layout data loss | Medium | Low | Auto-save on every drag end + debounce |

---

## 11. 🗺️ File Structure (Target)

```
genor-orchestrator-plugin/
├── DESIGN.md                         ← Master design
├── docs/
│   ├── SOFTWARE-HOUSE-UI.md          ← Frontend proposal
│   ├── MERGER-PLAN.md                ← THIS FILE
│   └── PLANS.md                      ← Sprint plans
├── src/
│   ├── index.ts                      ← Plugin entry (existing + new)
│   ├── dashboard-handler.ts          ← HTTP routes (existing + new API)
│   ├── db.ts                         ← SQLite (extended with new tables)
│   ├── software-house/
│   │   ├── agents.ts                 ← Agent CRUD + spawn
│   │   ├── rooms.ts                  ← Room CRUD + layout
│   │   ├── kanban.ts                 ← Task pipeline
│   │   ├── vault.ts                  ← Document CRUD + context injection
│   │   ├── pm-chat.ts                ← PM orchestrator session
│   │   ├── bootstrap.ts              ← State aggregation
│   │   └── data-models.ts            ← TypeScript interfaces
│   └── shared.ts                     ← Types (extended)
├── dashboard/
│   ├── index.html                    ← Classic dashboard
│   ├── software-house.html           ← Software House SPA
│   ├── data/
│   │   └── software-house-mock.json  ← Mock data (eventually removed)
│   └── assets/
│       └── pixel-agents/             ← Sprite PNGs
├── proto/                            ← Prototype HTMLs (can remove)
├── assets/                           ← Root sprite copies (can remove)
├── dist/                             ← Compiled output
├── package.json
└── openclaw.plugin.json
```

---

## 12. 🎯 Success Criteria

1. User lands on Software House UI → sees real project data (not mock)
2. Click "Hire" → agent appears with real spawned session
3. Agent status updates live on the office canvas
4. PM chat → PM understands the project state and can create tasks
5. Kanban drag-and-drop → task actually moves phases
6. Vault panel → shows real orchestrator-data files
7. Inject button → selected docs appear in agent's next prompt
8. Can switch between 5+ projects seamlessly
9. All 40 existing AI tools still work
10. Classic dashboard still works at `/orchestrator/`

---

*Generated: 2026-06-23 · Plan for Genor Software House merger*
