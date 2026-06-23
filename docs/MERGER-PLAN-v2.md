# 🏢 Genor Software House — Implementation-Ready Merger Plan

> **Version:** 2.0 (final, QA-verified)  
> **Status:** Ready for implementation  
> **Total surface area:** 6335 lines `index.ts` + 1218 lines `dashboard-handler.ts` + 1122 lines `db.ts` + 1695 lines `software-house.html` + docs

---

## 📋 COMPLETE INVENTORY AUDIT

### 1️⃣ KEEP — Core infrastructure (no changes)

| File | Lines | Why |
|------|-------|-----|
| `src/shared.ts` | 26 | Tiny helper `getDataDir()` |
| `src/db.ts` | 1122 | SQLite singleton, migration system, all CRUD functions |
| `src/index.ts` — SessionTracker | ~300 | Per-session state, key adoption (no synthetic), getters/setters |
| `src/index.ts` — WorkflowTracker | ~150 | Phase engine, QA gate, auto-commit |
| `src/index.ts` — 8 hooks | ~600 | session_start, session_end, subagent_*, before_model_resolve, before_prompt_build, agent_end, gateway_stop |
| `src/index.ts` — Helper functions | ~400 | `logSession()`, `logDecision()`, `setContext()`, `clearContextFn()`, `countModels()`, etc. |
| `dashboard/index.html` | ~241 | Classic dashboard — stays as operator UI |
| `dashboard/assets/pixel-agents/` | 40 files | The 4 sprite sets (blue, orange, violet, hacker) |
| `DESIGN.md`, `SOFTWARE-HOUSE-UI.md` | ~700 | Documentation |

**Total kept: ~3700 lines**

### 2️⃣ KEEP — AI tools (43 registered, ~2000 lines total)

All stay as-is. These are the AI agent's API. Grouped by category:

**Lifecycle (4):** `genorch_session_register`, `genorch_session_unregister`, `genorch_session_start_work`, `genorch_session_clear_work`

**Status/Config (11):** `genorch_status`, `genorch_config_show_routing`, `genorch_models_list`, `genorch_models_check_routing`, `genorch_models_auto_discover`, `genorch_models_recommend`, `genorch_session_log`, `genorch_session_list`, `genorch_adr_log`, `genorch_logs_query`, `genorch_system_diagnose`

**Project (8):** `genorch_project_bind`, `genorch_project_join`, `genorch_project_leave`, `genorch_project_create`, `genorch_project_list_active`, `genorch_project_sync_files`, `genorch_project_sync_docs`, `genorch_project_docs_list`, `genorch_project_rebuild_state`

**Backlog (5):** `genorch_backlog_add`, `genorch_backlog_list`, `genorch_backlog_update`, `genorch_backlog_dispatch`, `genorch_backlog_dispatch_all`

**Execution (3):** `genorch_task_delegate`, `genorch_issue_debug`, `genorch_feature_design`

**QA (3):** `genorch_qa_submit`, `genorch_qa_approve`, `genorch_qa_reject`

**Workflow (2):** `genorch_workflow_advance_phase`, `genorch_handoff_create`

**Test (2):** `genorch_test_create_unit`, `genorch_test_create_e2e`

**Pipeline (3):** `genorch_verify_pipeline_start`, `genorch_verify_pipeline_check`, `genorch_verify_pipeline_guide`

**Knowledge (1):** `genorch_knowledge_quiz`

**Docs (1):** `genorch_project_tidy_docs`

### 3️⃣ REFACTOR — Existing tables (V4 migration)

**`backlog_tasks` — extend with 3 new columns:**
```sql
ALTER TABLE backlog_tasks ADD COLUMN phase TEXT DEFAULT 'backlog';
ALTER TABLE backlog_tasks ADD COLUMN agent_id TEXT;
ALTER TABLE backlog_tasks ADD COLUMN task_type TEXT DEFAULT 'dev';
```

**Why:** The kanban UI uses `phase: backlog|in-progress|review|done`. The existing `status` column is for the backlog system. Adding `phase` gives a parallel view for the pipeline without breaking existing backlog operations (`genorch_backlog_add` uses `status`, kanban uses `phase`).

**`sessions` — extend with 3 new columns:**
```sql
ALTER TABLE sessions ADD COLUMN progress INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN context_used TEXT;
ALTER TABLE sessions ADD COLUMN output_summary TEXT;
```

**Why:** Agent desks in the UI show progress and context usage. Adding these to existing sessions avoids a parallel `agent_sessions` table while enabling the visual features.

### 4️⃣ ADD — New tables (V4 migration)

```sql
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT DEFAULT '',
  sprite TEXT DEFAULT 'blue',
  model TEXT DEFAULT '',
  status TEXT DEFAULT 'idle',
  room_id TEXT,
  system_prompt TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#5e9cff',
  purpose TEXT DEFAULT '',
  task_types TEXT DEFAULT '[]',
  layout TEXT DEFAULT 'auto',
  pos_x INTEGER DEFAULT 0,
  pos_y INTEGER DEFAULT 0,
  pos_w INTEGER DEFAULT 0,
  pos_h INTEGER DEFAULT 0,
  is_command INTEGER DEFAULT 0,
  is_openfloor INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vault_docs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  title TEXT DEFAULT '',
  icon TEXT DEFAULT '📄',
  folder TEXT,
  doc_type TEXT DEFAULT 'note',
  content TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  status TEXT DEFAULT 'active',
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pm_chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

### 5️⃣ ADD — 13 new API endpoints in `dashboard-handler.ts`

All go in `createDashboardHandler()` following the existing pattern. Read-only first, then mutable.

**Phase 1 — Read endpoints (implement first, zero visual diff):**
```
GET  /api/software-house/bootstrap          → full state matching mock JSON shape
GET  /api/software-house/vault/tree         → vault file listing
GET  /api/software-house/vault/doc          → vault document content
GET  /api/software-house/pm/chat            → chat history
```

**Phase 2 — Write endpoints:**
```
POST /api/software-house/agents/hire        → create agent record
PATCH /api/software-house/agents            → update agent config
DELETE /api/software-house/agents/:id       → remove agent
PATCH /api/software-house/rooms             → save room layout
POST /api/software-house/backlog/move       → move task between phases
POST /api/software-house/pm/chat            → send PM message
PUT  /api/software-house/vault/doc          → save vault document
POST /api/software-house/vault/inject       → inject doc into session context
```

### 6️⃣ ADD — Vault context injection in `before_prompt_build`

Add a section to the existing `before_prompt_build` hook (after project docs, before phase enforcement):

```typescript
// ═══ VAULT INJECTION ═══
// If the user injected vault docs into this session, append their content.
const injectedDocs = getInjectedDocs(project, sessionKey);
if (injectedDocs.length > 0) {
  ctx += `\n\n📄 Injected vault documents (selected by operator):\n────────────────────────────────────`;
  for (const doc of injectedDocs) {
    ctx += `\n\n### ${doc.title}\n${doc.content.slice(0, 3000)}`;
  }
  ctx += `\n────────────────────────────────────`;
}
```

**Storage:** Use a new simple KV in `project_configs.config` or a dedicated `session_injected_docs` table (whichever is simpler). For alpha, store as JSON string on the session's `extra` column.

### 7️⃣ DELETE — Dead code and stale files

| File | Reason |
|------|--------|
| `src/index.test.ts` | Single test file, useless after test deletion |
| `PLAN-autonomous-pipeline.md` | Superseded by new Software House vision |
| `session-lock-fix-plan.md` | Stale, issue fixed |
| `AUDIT.md` | Dev artifact |
| `CHANGELOG.md` | DRY — git log is the changelog |
| `SETUP.md` | Stale instructions |
| `TEST_COVERAGE_PLAN.md` | Tests deleted |
| `VERSIONING.md` | Overengineered, git handles this |
| `workflow-enforcement-design.md` | ~40k of old design docs, superseded by DESIGN.md |
| `PROTOTYPE-kanban-team.md` | Was in root, kept for reference, can remove |
| `dashboard/UX-ANALYSIS.md` | Dev artifact |
| `dashboard/fix-ui.py` | Dev artifact |

**Total removed: ~120k of stale docs**

### 8️⃣ FIX — TOC in index.ts (quick fix)

Lines 23-72 have a stale table of contents with wrong line numbers. Replace with a short auto-generated one or remove it entirely. It's not used by any code and will drift again.

**Fix:** Replace the manual TOC with a 10-line overview of the major sections (line ranges approximate):
```
// Sections (approximate):
//   17-94     Imports, TOC, housekeeping
//   97-815    Types, helpers, SessionTracker, WorkflowTracker
//   817-1510  Tool logic (pure functions)
//   1511-2082  Maintenance, model helpers, session validation, backlog
//   2083-2779  Additional tool logic
//   2782-3477  Hooks (8 registered)
//   3479-6303  Tools (43 registered) + slash commands
//   6305-6335  Export + metadata
```

---

## 🧩 FRONTEND MERGER — Step by Step

### Step 1: Replace mock URL with live bootstrap

In `software-house.html`, change the `loadData(projectId)` function:

```javascript
// BEFORE:
async function loadData(projectId) {
  const resp = await fetch('/orchestrator/data/software-house-mock.json');
  const data = await resp.json();
  return data.projects[projectId];
}

// AFTER:
async function loadData(projectId) {
  const resp = await fetch(`/orchestrator/api/software-house/bootstrap?project=${projectId}`);
  const data = await resp.json();
  // data shape matches mock JSON: { defaultProjectId, projects: { [id]: { rooms, agents, tasks, vault } } }
  return data.projects[projectId];
}
```

**Impact:** Zero visual changes. The UI keeps accessing `project.rooms`, `project.agents`, `project.tasks`, `project.vault["STATE.md"]` — same shape, real data.

### Step 2: Replace write actions (one at a time)

| UI function | Line in .html | Replace with |
|------------|--------------|-------------|
| `confirmHire()` | 1433 | `POST /api/software-house/agents/hire` |
| `saveAgent()` | 1267 | `PATCH /api/software-house/agents` |
| `fireAgent()` | 1282 | `DELETE /api/software-house/agents/:id` |
| `saveRoomPanel()` | 1384 | `PATCH /api/software-house/rooms` |
| `toggleRoomTaskType()` | 1377 | `PATCH /api/software-house/rooms` |
| `addRoom()` | 1410 | `PATCH /api/software-house/rooms` |
| `sendChat()` | 1471 | `POST /api/software-house/pm/chat` |
| `sendPmBubble()` | 1587 | `POST /api/software-house/pm/chat` |
| `moveTask()` (kanban drag) | ~900 | `POST /api/software-house/backlog/move` |
| `injectVaultDoc()` | ~900 | `POST /api/software-house/vault/inject` |

Each is a single URL swap + parse JSON response.

### Step 3: Model name mapping

The bootstrap endpoint must translate model IDs:
- `opencode-go/deepseek-v4-pro` → `deepseek-v4-pro` (strip `opencode-go/` prefix)
- `opencode-go/qwen3.7-max` → `qwen3.7-max`

Add a mapping function in `dashboard-handler.ts`:
```typescript
function shortenModelId(id: string): string {
  return id.replace(/^opencode-go\//, '').replace(/^openrouter\//, '');
}
```

Apply to `agents[].model` and `tasks[].type` in the bootstrap response.

### Step 4: Font scale (already client-side localStorage)

No changes needed — `changeFontScale()` uses `localStorage` which is browser-side.

---

## 📐 DATA FLOW DIAGRAM

```
User opens /orchestrator/software-house
  │
  ▼
GET /api/software-house/bootstrap?project=X
  │
  ▼
dashboard-handler.ts:
  1. Query rooms table → rooms[]
  2. Query agents table → agents[]
  3. Query backlog_tasks (phase not null) → tasks[]
  4. Query vault_docs table → vault object
  5. Enrich agents with live session data from sessions table
  6. Shorten model IDs
  7. Return mock-compatible JSON
  │
  ▼
software-house.html renders:
  - Office canvas with rooms + agent desks
  - Kanban board with tasks
  - Vault panel with doc tree + content
  - Chat panel (client-side for now)
  │
  ▼
User action (e.g., move kanban card):
  POST /api/software-house/backlog/move
    body: { taskId: "t1", newPhase: "in-progress" }
  → Updates backlog_tasks.phase
  → Returns updated task
  → UI re-renders kanban column
```

---

## 📦 IMPLEMENTATION ORDER

### Phase 0 — Prep (5 min)
- [ ] Remove stale doc files (AUDIT.md, CHANGELOG.md, SETUP.md, TEST_COVERAGE_PLAN.md, VERSIONING.md, workflow-enforcement-design.md, PLAN-autonomous-pipeline.md, session-lock-fix-plan.md)
- [ ] Delete `src/index.test.ts`
- [ ] Update TOC in `src/index.ts` (lines 23-72) with correct approximate ranges
- [ ] Push cleanup

### Phase 1 — V4 Migration (30 min)
- [ ] Add V4 migration in `src/db.ts` `MIGRATIONS` array
- [ ] Extend `backlog_tasks`: `phase`, `agent_id`, `task_type`
- [ ] Extend `sessions`: `progress`, `context_used`, `output_summary`
- [ ] Create `agents`, `rooms`, `vault_docs`, `pm_chat` tables
- [ ] Add export functions for new tables (pattern-matching existing functions)
- [ ] Build + test

### Phase 2 — Read API (1 hr)
- [ ] Implement `GET /api/software-house/bootstrap` — aggregates rooms, agents, tasks, vault
- [ ] Implement model ID shortening helper
- [ ] Implement `GET /api/software-house/vault/tree`
- [ ] Implement `GET /api/software-house/vault/doc`
- [ ] Build + test with curl

### Phase 3 — Frontend swap (30 min)
- [ ] Change `loadData()` URL from mock JSON to bootstrap endpoint
- [ ] Test: office canvas shows real data from DB
- [ ] Test: vault panel shows real docs
- [ ] Test: kanban shows backlog tasks

### Phase 4 — Write API (1 hr)
- [ ] Implement `POST /api/software-house/agents/hire`
- [ ] Implement `PATCH /api/software-house/agents`
- [ ] Implement `DELETE /api/software-house/agents/:id`
- [ ] Implement `PATCH /api/software-house/rooms`
- [ ] Implement `POST /api/software-house/backlog/move`
- [ ] Implement `POST /api/software-house/vault/inject`
- [ ] Wire each to the corresponding frontend function

### Phase 5 — PM Chat (2 hr)
- [ ] Implement `POST /api/software-house/pm/chat` — stores message, routes to quick-action endpoint
- [ ] Implement `GET /api/software-house/pm/chat` — returns history
- [ ] Wire `sendChat()` and `sendPmBubble()` to real endpoint
- [ ] PM quick actions: `/api/quick-action` with project context

### Phase 6 — Vault CRUD (1 hr)
- [ ] Implement `PUT /api/software-house/vault/doc` — save document to disk + update index
- [ ] Add before_prompt_build vault injection section
- [ ] Wire inject button

### Phase 7 — Polish (1 hr)
- [ ] Remove mock JSON dependency (keep as test fixture)
- [ ] Add portal for software-house in main dashboard (done in PR)
- [ ] Remove stale docs from Step 0
- [ ] Final build + test
- [ ] Restart gateway

---

## 🚨 IMPLEMENTATION PITFALLS

1. **Bootstrap response must be EXACT mock JSON shape** — `{ defaultProjectId, projects: { [id]: { rooms, agents, tasks, vault: { [path]: VaultDoc } } } }`. Not flattened. Not arrays. The UI does `project.vault["STATE.md"]`, not `project.vault[0]`.

2. **Model IDs mismatch** — Always strip `opencode-go/` prefix in bootstrap. The UI mock uses `"deepseek-v4-pro"` while the DB stores `"opencode-go/deepseek-v4-pro"`.

3. **`backlog_tasks.phase` vs `backlog_tasks.status`** — Keep `status` for backlog operations (`genorch_backlog_add` sets `status: "todo"`). Add separate `phase` column for kanban. They coexist. When the AI creates a task, `status="todo"`, `phase="backlog"`.

4. **SSE already exists** — Don't create a new SSE endpoint. The existing `/orchestrator/api/sse/live-sessions` already pushes session updates. The UI can subscribe to it directly for real-time agent status changes.

5. **PM Chat deferred** — Don't make the plugin call `/v1/chat/completions` from inside an HTTP handler. Just store messages and route to existing `/api/quick-action`. The LLM orchestration pattern doesn't exist in the codebase yet.

6. **`genorch_project_bind` returns project context** — When the user binds to a project via `genorch_project_bind`, the next `before_prompt_build` should inject ROADMAP.md, vault index, and agent roster. This is how the orchestrator "knows" the project state.

7. **Don't override `__setTestSessionKey`** — It still exists at line ~6329 as a test utility. Keep it for dev testing but don't use it in production flow.

---

## ✅ ACCEPTANCE CRITERIA

Before declaring Phase X done:

| Phase | Check |
|-------|-------|
| 0 | `git status` clean, no stale doc files, TOC updated |
| 1 | `V4` migration runs on fresh DB and existing DB, `GET /api/projects` shows rooms count |
| 2 | `curl GET /api/software-house/bootstrap` returns mock-compatible JSON with real data |
| 3 | Open `http://genorbox1:18789/orchestrator/software-house` — office canvas shows agents, kanban shows tasks, vault shows docs |
| 4 | Click "Hire" → POST returns 200; Move kanban card → phase updates in DB |
| 5 | Type in PM chat → message stored; "Plan sprint" quick action → response in chat |
| 6 | "Inject" button → next prompt includes vault doc content |
| 7 | Remove mock JSON file; classic dashboard still works at `/orchestrator/` |

---

*Ready for implementation. Branch: `refactor/software-house-integration`*
