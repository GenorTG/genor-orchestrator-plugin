# Implementation Plan: Software House × Orchestrator Merger

> **Last Updated:** 2026-06-23
> **Architecture:** See `docs/ARCHITECTURE.md` for complete system overview
> **Source:** `/home/genorbox1/projects/genor-orchestrator-plugin`

## Overview

The Software House UI (pixel-art office visualization) needs to connect to the Orchestrator backend. Currently it loads from mock JSON. This plan wires every UI function to real API endpoints.

## Key Numbers

- **44 backend tools** → **13 have NO UI** (session/project/backlog/workflow/QA/tests/pipeline/delegation/knowledge/ADR/logs/diagnostics/config)
- **14 UI features** → **have NO backend** (agent personas/rooms/visual states/context/chat/vault/layout)
- **5 backend features** → **partially in UI** (sessions/backlog/models/logs/config shown in classic dashboard only)

## Architecture Decisions

| Decision | Solution |
|----------|----------|
| Agent abstraction | New `agents` table — persistent personas reference ephemeral sessions |
| Room persistence | New `rooms` table — group agents by task type |
| Visual state mapping | Backend status → UI states: idle→sleep, running→working, done→success, failed→error |
| PM chat persistence | New `pm_chat` table — store messages with timestamps |
| Quick actions | Wire to existing `handleQuickAction()` infrastructure |
| Vault system | New `vault_docs` table + `before_prompt_build` injection |
| Layout persistence | Store in `project_configs` table |
| Bootstrap API | Match mock JSON shape exactly — zero frontend changes needed |

## Implementation Phases

### Phase 1: Database Schema
**Goal:** Add all missing tables and columns.

| Table | Columns | Purpose |
|-------|---------|---------|
| `agents` | id, name, role, sprite, model, prompt, room, status, project, created_at | Persistent agent personas |
| `rooms` | id, name, purpose, taskTypes, project, x, y, w, h, created_at | Workspace groupings |
| `vault_docs` | id, path, content, project, created_at, updated_at | Document storage |
| `pm_chat` | id, message, sender, project, created_at | Chat persistence |

Extend existing:
- `sessions` → add `agent_id`, `context_used`
- `backlog_tasks` → add `agent_id`

### Phase 2: Bootstrap API
**Goal:** Backend serves full project state matching mock JSON shape.

Endpoint: `GET /api/software-house/bootstrap`

Response shape (must match mock JSON EXACTLY):
```json
{
  "defaultProjectId": "genor-orchestrator-plugin",
  "projects": {
    "genor-orchestrator-plugin": {
      "id": "genor-orchestrator-plugin",
      "name": "GenorBoard v2",
      "rooms": [...],
      "agents": [...],
      "tasks": [...],
      "vault": {
        "STATE.md": { "folder": "...", "icon": "...", "title": "...", ... }
      }
    }
  }
}
```

### Phase 3: Agent CRUD
**Goal:** Hire, edit, fire agents via UI.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/software-house/agents/hire` | POST | Create agent persona |
| `/api/software-house/agents/:id` | PATCH | Edit agent |
| `/api/software-house/agents/:id` | DELETE | Fire agent |

### Phase 4: Room CRUD
**Goal:** Add, edit, delete rooms via UI.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/software-house/rooms` | POST | Add room |
| `/api/software-house/rooms/:id` | PATCH | Edit room |
| `/api/software-house/rooms/:id` | DELETE | Delete room |
| `/api/software-house/layout/save` | POST | Persist drag/resize positions |

### Phase 5: Kanban Integration
**Goal:** Real task management with phase advancement.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/software-house/backlog/move` | POST | Move task between phases |

Must sync: `phase` column ↔ `status` column in `backlog_tasks`.

### Phase 6: PM Chat & Quick Actions
**Goal:** Persistent chat and real quick actions.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/software-house/pm/chat` | GET | Load chat history |
| `/api/software-house/pm/chat` | POST | Send message |

Quick actions route through existing `handleQuickAction()` + `quickActionSpawn()`.

### Phase 7: Vault System
**Goal:** Browse, edit, inject documents.

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/software-house/vault/tree` | GET | List documents |
| `/api/software-house/vault/doc` | GET | Get document content |
| `/api/software-house/vault/doc` | PUT | Update document |
| `/api/software-house/vault/inject` | POST | Inject into AI context |
| `/api/software-house/vault/sync` | POST | Sync from filesystem |

Vault injection: `sessionTracker.injectedDocs` → consumed by `before_prompt_build` hook.

### Phase 8: Polish & Cleanup
**Goal:** Remove all mock references, ensure everything works.

- Remove all `toast('...mockup')` calls
- Remove `loadMockData()` function
- Wire `loadData()` to bootstrap endpoint
- Add loading spinners
- Add proper error handling
- Test all UI functions
- Gateway restart (manual)

## Backend Feature → UI Mapping

| Backend Feature | UI Location | Implementation |
|-----------------|-------------|----------------|
| Session status | Agent desk state | Map session.status → agent.status |
| Workflow phase | Kanban column | Map phase → kanban column |
| QA status | Task badge | Show QA status on task cards |
| Model routing | Agent model display | Show which model each agent uses |
| Pipeline status | Status bar | Show pipeline progress |
| Logs | Logs panel | Add logs panel to Software House |
| Config | Settings panel | Wire settings to real config |
| ADR | Vault docs | Show ADRs in vault |

## Files to Modify

| File | Change |
|------|--------|
| `src/db.ts` | V4 migration: 4 new tables + 2 extended |
| `src/dashboard-handler.ts` | 18 new API endpoints |
| `src/index.ts` | Vault injection in `before_prompt_build` hook |
| `dashboard/software-house.html` | Wire `loadData()` to bootstrap, remove mock functions |

## Preserved Files

- `UX-ANALYSIS.md` — Friend's design analysis
- `SOFTWARE-HOUSE-UI.md` — UI documentation
- `software-house-mock.json` — API contract fixture
- All pixel sprites in `assets/pixel-agents/`
- All CSS and visual styling in `software-house.html`

## Deployment

1. Edit source in `~/projects/genor-orchestrator-plugin/`
2. Run `npm run build`
3. Deploy: `rsync -a dist/ ~/.openclaw/extensions/genorch/dist/`
4. Gateway restart (manual, requires Master Genor approval)

---

*This plan references `docs/ARCHITECTURE.md` for complete system overview.*