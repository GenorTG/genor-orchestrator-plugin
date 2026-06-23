# Architecture: Software House × Orchestrator Merger

> **Last Updated:** 2026-06-23
> **Purpose:** Comprehensive plan to align the Software House UI with the Orchestrator backend, ensuring every feature in the UI has real backend support and every backend capability is visible in the UI.

## System Overview

The Orchestrator plugin manages AI agent sessions for software projects. It has:
- **44 AI tools** for session/project/backlog/model/workflow/QA management
- **8 hooks** for lifecycle events
- **25 API routes** for dashboard communication
- **8 DB tables** for persistence

The Software House UI is a pixel-art visualization layer that currently loads from mock data. It needs to connect to the real backend.

---

## Complete Feature Inventory

### Backend Features (44 Tools + 8 Hooks)

#### Session Management
| Tool | Purpose | UI Mapping |
|------|---------|------------|
| genorch_session_register | Register session with orchestrator | Not shown |
| genorch_session_unregister | Unregister session | Not shown |
| genorch_session_start_work | Begin work on bound project | Not shown |
| genorch_session_clear_work | Clear work context | Not shown |
| genorch_session_log | Log session to ADR | Not shown |
| genorch_status | Show orchestrator status | Partial (classic dashboard) |

#### Project Management
| Tool | Purpose | UI Mapping |
|------|---------|------------|
| genorch_project_bind | Bind to project | Not shown |
| genorch_project_join | Join project | Not shown |
| genorch_project_create | Create new project | Not shown |
| genorch_project_list_active | List active projects | Not shown |
| genorch_project_sync_files | Sync project files | Not shown |
| genorch_project_sync_docs | Sync project docs | Not shown |
| genorch_project_docs_list | List project docs | Not shown |
| genorch_project_docs_get | Get doc content | Not shown |
| genorch_project_docs_update | Update doc content | Not shown |
| genorch_project_rebuild_state | Rebuild project state | Not shown |
| genorch_project_tidy_docs | Tidy project docs | Not shown |

#### Backlog Management
| Tool | Purpose | UI Mapping |
|------|---------|------------|
| genorch_backlog_add | Add task to backlog | Not shown |
| genorch_backlog_list | List backlog tasks | Not shown |
| genorch_backlog_update | Update task status | Not shown |
| genorch_backlog_dispatch | Dispatch next task | Not shown |
| genorch_backlog_dispatch_all | Dispatch all ready tasks | Not shown |

#### Model Management
| Tool | Purpose | UI Mapping |
|------|---------|------------|
| genorch_models_list | List available models | Not shown |
| genorch_models_check_routing | Check model routing | Not shown |
| genorch_models_auto_discover | Auto-discover models | Not shown |
| genorch_models_recommend | Recommend model | Not shown |

#### Workflow Management
| Tool | Purpose | UI Mapping |
|------|---------|------------|
| genorch_workflow_advance_phase | Advance workflow phase | Not shown |
| genorch_workflow_handoff_create | Create handoff doc | Not shown |

#### QA Gate
| Tool | Purpose | UI Mapping |
|------|---------|------------|
| genorch_qa_submit | Submit for QA | Not shown |
| genorch_qa_approve | Approve QA | Not shown |
| genorch_qa_reject | Reject with feedback | Not shown |

#### Testing
| Tool | Purpose | UI Mapping |
|------|---------|------------|
| genorch_test_create_unit | Create unit test | Not shown |
| genorch_test_create_e2e | Create E2E test | Not shown |

#### Pipeline
| Tool | Purpose | UI Mapping |
|------|---------|------------|
| genorch_pipeline_verify_start | Start verification | Not shown |
| genorch_pipeline_check | Check pipeline status | Not shown |
| genorch_pipeline_guide | Guide pipeline | Not shown |

#### Delegation
| Tool | Purpose | UI Mapping |
|------|---------|------------|
| genorch_task_delegate | Delegate task | Not shown |
| genorch_issue_debug | Debug issue | Not shown |
| genorch_feature_design | Design feature | Not shown |

#### Knowledge
| Tool | Purpose | UI Mapping |
|------|---------|------------|
| genorch_knowledge_quiz | Test knowledge | Not shown |

#### Logs & Diagnostics
| Tool | Purpose | UI Mapping |
|------|---------|------------|
| genorch_logs_query | Query logs | Partial (classic dashboard) |
| genorch_system_diagnose | System health check | Not shown |
| genorch_config_show_routing | Show routing config | Not shown |

#### ADR
| Tool | Purpose | UI Mapping |
|------|---------|------------|
| genorch_adr_log | Log architecture decision | Not shown |

---

### UI Features (Software House)

#### Canvas & Visualization
| Feature | Purpose | Backend Support |
|---------|---------|-----------------|
| Office canvas with rooms | Visual workspace | None |
| Agent desks with sprites | Agent visualization | None |
| Agent visual states | sleep/working/thinking/error | None |
| Room drag/resize | Layout customization | None |

#### Agent Management
| Feature | Purpose | Backend Support |
|---------|---------|-----------------|
| Agent personas | Persistent identity | None |
| Agent roles | Task specialization | None |
| Agent models | Model assignment | Partial (models table) |
| Agent prompts | Custom prompts | None |
| Agent context usage | ctx: "0/195k" | None |
| Agent progress | Progress bar | None |
| Hire modal | Create agent | None |
| Fire agent | Delete agent | None |
| Agent status dropdown | Change status | None |

#### Room Management
| Feature | Purpose | Backend Support |
|---------|---------|-----------------|
| Room creation | Add workspace | None |
| Room editing | Modify room | None |
| Room deletion | Remove room | None |
| Room purpose | Task specialization | None |
| Room task types | Allowed task types | None |

#### Kanban Board
| Feature | Purpose | Backend Support |
|---------|---------|-----------------|
| Task visualization | Show tasks | None |
| Task phase advancement | Move tasks | None |
| Task detail panel | View/edit tasks | None |

#### Vault
| Feature | Purpose | Backend Support |
|---------|---------|-----------------|
| Document tree | Browse docs | None |
| Document viewing | Read docs | None |
| Document editing | Modify docs | None |
| Document injection | Inject into AI | None |
| Document sync | Sync changes | None |

#### PM Chat
| Feature | Purpose | Backend Support |
|---------|---------|-----------------|
| Chat interface | PM communication | None |
| Message history | Persistent messages | None |
| Quick actions | Automated tasks | None |

#### Settings
| Feature | Purpose | Backend Support |
|---------|---------|-----------------|
| Settings panel | Configuration | None |
| Settings save | Persist changes | None |

---

## Mismatch Analysis

### Backend Features with NO UI (13 gaps)
1. Session lifecycle (register/unregister/start_work)
2. Project lifecycle (bind/join/leave/create/sync)
3. Backlog management (add/list/update/dispatch)
4. Models management (list/auto_discover/recommend)
5. Workflow phases (advance_phase/handoff_create)
6. QA gate (submit/approve/reject)
7. Tests (create_unit/create_e2e)
8. Verification pipeline (start/check/guide)
9. Knowledge quiz
10. ADR logging
11. Logs query (partially in classic dashboard)
12. System diagnose (doctor)
13. Config show routing

### UI Features with NO Backend (14 gaps)
1. Agent personas (persistent identity, role, sprite)
2. Room concept (grouping, purpose, taskTypes)
3. Agent visual states (sleep/working/thinking/error)
4. Agent context usage (ctx: "0/195k")
5. Agent progress bar
6. PM chat (persistent messages)
7. Quick actions (plan sprint, spawn subagent)
8. Vault tree (browse, edit, inject)
9. Room drag/resize
10. Agent desk click-to-expand
11. Task detail panel
12. Hire modal
13. Fire agent
14. Agent status dropdown

### Backend Features Partially in UI (5 overlaps)
1. Sessions → shown in classic dashboard but not in Software House
2. Backlog → kanban board exists but no real dispatch
3. Models → shown in classic dashboard but not in Software House
4. Logs → shown in classic dashboard but not in Software House
5. Config → shown in classic dashboard but not in Software House

---

## Architecture Decisions

### 1. Agent Abstraction Layer
**Problem:** Backend has sessions (ephemeral), UI has persistent agents.
**Solution:** Create `agents` table that stores agent personas. Sessions reference agents via `agent_id`. UI reads from agents table, not sessions table.

### 2. Room Concept
**Problem:** Rooms are purely UI, no backend equivalent.
**Solution:** Create `rooms` table for persistence. Rooms group agents by task type or project phase. Backend validates room assignments.

### 3. Visual States
**Problem:** Backend tracks session status (idle/running/done/failed), UI needs visual states.
**Solution:** Map backend status to UI states: idle→sleep, running→working, done→success, failed→error. Add `thinking` state for QA/pipeline phases.

### 4. Context Tracking
**Problem:** No per-agent context usage tracking.
**Solution:** Add `context_used` column to sessions table. Track token usage per session. Approximate if real-time tracking not available.

### 5. PM Chat Persistence
**Problem:** Currently client-side only.
**Solution:** Create `pm_chat` table. Store messages with timestamps. Load history on page open.

### 6. Quick Actions
**Problem:** Backend has infrastructure but UI uses canned responses.
**Solution:** Wire UI to existing `/api/quick-action` endpoint. Route through `handleQuickAction()` and `quickActionSpawn()`.

### 7. Vault System
**Problem:** No vault concept in backend.
**Solution:** Create `vault_docs` table. Store document content with paths. Add injection mechanism via `before_prompt_build` hook.

### 8. Layout Persistence
**Problem:** Room positions lost on refresh.
**Solution:** Store layout in `project_configs` table. Save on drag/resize. Load on page open.

---

## Refactoring Plan

### Phase 1: Database Schema (Foundation)
**Goal:** Add all missing tables and columns.
**Tasks:**
1. Create `agents` table (id, name, role, sprite, model, prompt, room, status, project, created_at)
2. Create `rooms` table (id, name, purpose, taskTypes, project, position, size, created_at)
3. Create `vault_docs` table (id, path, content, project, created_at, updated_at)
4. Create `pm_chat` table (id, message, sender, project, created_at)
5. Extend `sessions` table (add agent_id, context_used columns)
6. Extend `backlog_tasks` table (add agent_id column)
7. Run V4 migration

### Phase 2: Bootstrap API
**Goal:** Backend serves full project state matching mock JSON shape.
**Tasks:**
1. Create `GET /api/software-house/bootstrap` endpoint
2. Return `{ defaultProjectId, projects: { [id]: { rooms, agents, tasks, vault: { [path]: content } } } }`
3. Match mock JSON field names exactly
4. Add loading states for network latency

### Phase 3: Agent CRUD
**Goal:** Hire, edit, fire agents via UI.
**Tasks:**
1. Create `POST /api/software-house/agents/hire` endpoint
2. Create `PATCH /api/software-house/agents/:id` endpoint
3. Create `DELETE /api/software-house/agents/:id` endpoint
4. Wire UI buttons to real API calls
5. Remove mock data modifications

### Phase 4: Room CRUD
**Goal:** Add, edit, delete rooms via UI.
**Tasks:**
1. Create `POST /api/software-house/rooms` endpoint
2. Create `PATCH /api/software-house/rooms/:id` endpoint
3. Create `DELETE /api/software-house/rooms/:id` endpoint
4. Create `POST /api/software-house/layout/save` endpoint
5. Wire UI drag/resize to save layout

### Phase 5: Kanban Integration
**Goal:** Real task management with phase advancement.
**Tasks:**
1. Create `POST /api/software-house/backlog/move` endpoint
2. Wire kanban drag to real API calls
3. Sync phase/status columns
4. Update agent assignments when tasks move

### Phase 6: PM Chat & Quick Actions
**Goal:** Persistent chat and real quick actions.
**Tasks:**
1. Create `GET /api/software-house/pm/chat` endpoint
2. Create `POST /api/software-house/pm/chat` endpoint
3. Wire chat to real messages
4. Wire quick actions to `handleQuickAction()` infrastructure
5. Remove canned responses

### Phase 7: Vault System
**Goal:** Browse, edit, inject documents.
**Tasks:**
1. Create `GET /api/software-house/vault/tree` endpoint
2. Create `GET /api/software-house/vault/doc` endpoint
3. Create `PUT /api/software-house/vault/doc` endpoint
4. Create `POST /api/software-house/vault/inject` endpoint
5. Create `POST /api/software-house/vault/sync` endpoint
6. Add vault injection to `before_prompt_build` hook

### Phase 8: Polish & Cleanup
**Goal:** Remove all mock references, ensure everything works.
**Tasks:**
1. Remove all `toast('...mockup')` calls
2. Remove mock data loading
3. Add proper error handling
4. Add loading spinners
5. Test all UI functions
6. Update documentation

---

## Backend Feature → UI Mapping

### Features That Should Appear in UI
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

### UI Features That Need Backend Support
| UI Feature | Backend Addition | Priority |
|------------|------------------|----------|
| Agent personas | agents table | High |
| Room persistence | rooms table | High |
| PM chat persistence | pm_chat table | Medium |
| Vault system | vault_docs table | High |
| Layout save | project_configs | Medium |
| Context tracking | sessions.context_used | Low |
| Quick actions | Wire to existing infra | High |

---

## File Structure

```
src/
  index.ts              # Plugin entry + all tool definitions
  db.ts                 # SQLite database + migrations
  dashboard-handler.ts  # API routes + static file serving
  
dashboard/
  index.html            # Classic dashboard (operator UI)
  software-house.html   # New Software House UI (SPA)
  data/
    software-house-mock.json  # Mock data (kept as contract fixture)

docs/
  ARCHITECTURE.md       # This file
  MERGER-PLAN.md        # Implementation plan (this replaces)
  UX-ANALYSIS.md        # Friend's design analysis (preserved)
  SOFTWARE-HOUSE-UI.md  # UI documentation (preserved)
```

## Implementation Notes

### Deployment Flow
1. Edit source in `~/projects/genor-orchestrator-plugin/`
2. Run `npm run build`
3. Deploy: `rsync -a dist/ ~/.openclaw/extensions/genorch/dist/`
4. Gateway restart required (manual step)

### Preserved Files
- `UX-ANALYSIS.md` — Friend's design analysis
- `SOFTWARE-HOUSE-UI.md` — UI documentation
- `software-house-mock.json` — API contract fixture
- All pixel sprites in `assets/pixel-agents/`
- All CSS and visual styling in `software-house.html`

## Next Steps

1. Review this architecture document
2. Approve or suggest changes
3. Begin Phase 1: Database Schema
4. Implement incrementally
5. Test each phase before moving to next

---

*This document is the single source of truth for the Software House × Orchestrator merger.*