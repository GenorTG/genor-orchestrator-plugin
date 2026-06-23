# ✨ Features — Genor's Orchestrator Plugin

> **Comprehensive reference of every feature in the orchestrator plugin,**
> organized by the version they were introduced in, with current status.

---

## v0.9.0 — OpenAI Endpoint Session Spawn *(2026-06)*

### 🔄 All features in this version are **Active**

### OpenAI Endpoint Session Spawn
| Property | Value |
|----------|-------|
| **Introduced** | v0.9.0 |
| **Status** | ✅ Active |
| **Tools** | Dashboard API: `/api/spawn-project-session` |

**What it does:** The dashboard's ➕ New Session button creates persistent project sessions by POSTing directly to the gateway's own OpenAI-compatible endpoint. No queue files, no cron, no subagent.run() bridging.

**How it works:**
1. Handler reads gateway auth token from `~/.openclaw/openclaw.json` (or `OPENCLAW_GATEWAY_TOKEN` env var)
2. Generates a unique session key
3. POSTs to `http://127.0.0.1:18789/v1/chat/completions` with:
   - `Authorization: Bearer {gatewayToken}` — authenticates as trusted client
   - `x-openclaw-session-key: {custom key}` — deterministic session key assignment
   - `x-openclaw-model: {model}` — optional model selection
   - Task message telling the session to auto-register
4. Returns session key immediately
5. Spawned session's `session_start` hook handles auto-registration

**What was removed:**
- ❌ Queue-based spawn (`pending-spawns.json` → `before_prompt_build` → `subagent.run()`)
- ❌ `trusted-operator` approach
- ❌ Self-API fetch approach
- ❌ `requestHeartbeat` approach
- ❌ Cron-based spawn approach

---

## v0.8.0 — Dashboard Redesign & QA Workflow *(2026-05)*

### 🔄 All features in this version are **Active**

### Dashboard Redesign
| Property | Value |
|----------|-------|
| **Introduced** | v0.8.0 |
| **Status** | ✅ Active |
| **Files** | `dashboard/index.html` (1428 lines), `src/dashboard-handler.ts` |

**What it does:** Complete single-file SPA dashboard with 7-tab left sidebar navigation (Dashboard, Projects, Agents, Models, Logs, Settings, Safeguards). Features StateManager reactive state, lazy panel rendering, toast notifications, and accessible ARIA roles. Replaced old top-tab-bar layout (was 3506 lines).

**Tabs:**
| # | Tab | Purpose |
|---|-----|---------|
| 1 | 📊 Dashboard | Metric cards, quick actions, activity feed |
| 2 | 📁 Projects | Per-project deep dive, session history, docs, model routing |
| 3 | 🤖 Agents | Live agent cards, Stop/Recover/Details buttons |
| 4 | 🧠 Models | Full CRUD model inventory |
| 5 | 📜 Logs | Filterable orchestration event log |
| 6 | ⚙️ Settings | Dashboard config toggles |
| 7 | 🌐 Gateway | Live OpenClaw gateway sessions |
| 8 | 📋 Sessions | Per-project session tree with spawn modal |
| 9 | 🛡️ Safeguards | Idle/stuck agent detection dashboard |

---

### Sessions Tab
| Property | Value |
|----------|-------|
| **Introduced** | v0.8.0 |
| **Status** | ✅ Active |
| **API routes** | `/api/sessions/*`, `/api/spawn-project-session` |

**What it does:** Per-project session manager. Select a project from the dropdown, load session history, click any row to expand detail pane with full session info (agent, model, status, task, original prompt, notes, hierarchy). Sidebar shows project docs inline (BACKLOG.json, CONTEXT.md, RECOVERY.md, etc.).

---

### QA Workflow (3 tools)
| Property | Value |
|----------|-------|
| **Introduced** | v0.8.0 |
| **Status** | ✅ Active |
| **Tools** | `genorch_qa_submit`, `genorch_qa_approve`, `genorch_qa_reject` |

**What it does:** When `workflow.include_qa` is enabled, QA gate blocks the work→log phase transition. Submitting a finding via `qa_submit` auto-spawns an independent QA review subagent. `qa_approve` unblocks the transition; `qa_reject` returns to work phase with a reason.

---

### Handoff & Deep-Dive (2 tools)
| Property | Value |
|----------|-------|
| **Introduced** | v0.8.0 |
| **Status** | ✅ Active |
| **Tools** | `genorch_handoff_create`, `genorch_knowledge_quiz` |

**What it does:** `generate_handoff` creates a compact RECOVERY.md document for agent switching — captures state, decisions, open questions, and next steps. `grill_with_docs` spawns a subagent that reads all project documentation and quizzes you to sharpen understanding.

---

### Doc Maintenance Tools (3 tools)
| Property | Value |
|----------|-------|
| **Introduced** | v0.8.0 |
| **Status** | ✅ Active |
| **Tools** | `genorch_project_sync_docs`, `genorch_project_rebuild_state`, `genorch_project_tidy_docs` |

**What they do:**
- `fix_docs_drift` — Scans STATE.md, CONTEXT.md, ROADMAP.md, README.md for stale version numbers, tool counts, test counts
- `regenerate_state` — Regenerates STATE.md from state-events.jsonl (no LLM involved, computed from events)
- `cleanup_docs` — Spawns a subagent to fix broken links, stale content, fill gaps

---

### Test Infrastructure Tools (4 tools)
| Property | Value |
|----------|-------|
| **Introduced** | v0.8.0 |
| **Status** | ✅ Active |
| **Tools** | `genorch_test_create_unit`, `genorch_test_create_e2e`, `genorch_issue_debug`, `genorch_feature_design` |

**What they do:**
- `setup_unit_tests` — Spawns subagent to set up test framework (vitest/jest/mocha/pytest) + initial tests
- `setup_e2e_tests` — Spawns subagent to set up E2E framework (playwright/cypress/puppeteer) + scenarios
- `debug_issue` — Spawns subagent to investigate and fix a specific bug
- `create_functionality` — Spawns subagent to design and implement new features

---

### PM2 Bridge Removed
| Property | Value |
|----------|-------|
| **Introduced** | v0.8.0 |
| **Status** | ✅ Complete (removed) |

**What happened:** The old Python PM2 sidecar was removed. The dashboard is now served natively via OpenClaw's `/orchestrator` HTTP route, registered via `api.registerHttpRoute(...)`. No separate process needed.

---

## v0.7.0 — Routing Presets & Backlog Management *(2026-04)*

### 🔄 All features in this version are **Active**

### Routing Presets (5 presets)
| Property | Value |
|----------|-------|
| **Introduced** | v0.7.0 |
| **Status** | ✅ Active |
| **Hooks** | `before_model_resolve` (preset-aware) |

| Preset | Description |
|--------|-------------|
| **Custom Chains** | Manual per-category routing chains (editable in dashboard) |
| **No Steering** | Pass-through — let OpenClaw resolve models naturally |
| **Free Only** | Force all projects to only use `:free` models |
| **Single Provider** | Use only models from a single provider (configurable) |
| **Custom Fallbacks Only** | Use only fallback chains (no primary routing) |

**What it does:** Per-task-type (coding/fixing/research/q&a/documentation) model preference lists with fallback chain. Dashboard-editable, persisted to `dashboard-config.json`. `before_model_resolve` hook applies routing with chain fallthrough logic (chain → tier-based → OpenClaw resolved).

---

### Backlog Management (6 tools)
| Property | Value |
|----------|-------|
| **Introduced** | v0.7.0 |
| **Status** | ✅ Active |
| **Tools** | `genorch_backlog_add`, `genorch_backlog_list`, `genorch_backlog_update`, `genorch_backlog_dispatch`, `genorch_backlog_dispatch_all`, `genorch_project_create` |
| **Data file** | `projects/{name}/BACKLOG.json` |

**What it does:** Full project backlog CRUD with priority levels (p0-p3), labels, dependency resolution, and parallel dispatch. Tasks are auto-assigned IDs (TASK-001, TASK-002, etc.). Dispatch picks highest-priority available tasks respecting dependencies.

---

### Enhanced Routing Brain
| Property | Value |
|----------|-------|
| **Introduced** | v0.7.0 |
| **Status** | ✅ Active |
| **Tool** | `genorch_models_recommend` |

**What it does:** Returns model quality metadata (tier: S/A/B/C, speed: fast/medium/slow, context window, status). Task category auto-inferred from task description. Blocked chain detection and reporting. Preset-aware routing with enriched output.

---

### Safeguards Dashboard
| Property | Value |
|----------|-------|
| **Introduced** | v0.7.0 |
| **Status** | ✅ Active |
| **Tab** | 🛡️ Safeguards (9th tab) |

**What it does:** Idle/stuck agent detection dashboard. Configuration card, workflow enforcement per project, agent phase display, phase timeline, safeguard event log viewer, agent health indicators (healthy/warning/stale).

---

### Agent Card Controls
| Property | Value |
|----------|-------|
| **Introduced** | v0.7.0 |
| **Status** | ✅ Active |

**What it does:** Stop and Recover buttons on agent cards in the dashboard. Stop kills a stuck agent's registration; Recover restarts it with `set_context` action.

---

## v0.6.0 — Core Features & Foundation *(2026-03)*

### 🔄 All features in this version are **Active**

### Model Routing
| Property | Value |
|----------|-------|
| **Introduced** | v0.6.0 |
| **Status** | ✅ Active |
| **Tools** | `genorch_models_list`, `genorch_models_check_routing`, `genorch_models_recommend` |
| **Hook** | `before_model_resolve` — auto-routing per project |

**What it does:** Per-project model allowlists with routing chains. The `before_model_resolve` hook picks the best available model for each project+task combination. 5 routing modes via presets (expanded in v0.7.0). Models tracked in `models.json` with tier, speed, and agent-ready ratings.

---

### Session Tracking
| Property | Value |
|----------|-------|
| **Introduced** | v0.6.0 |
| **Status** | ✅ Active |
| **Tools** | `genorch_session_register`, `genorch_session_unregister`, `genorch_session_list` |
| **Hooks** | All 8 hooks guard for registered-only access |

**What it does:** Sessions opt in via `genorch_session_register`. Until then, the plugin is completely invisible — no context injection, no routing, no tracking. Registration + session-project binding enables accurate logging and isolation.

**Session lifecycle:** Register → Set Context → Work → Auto-log on session_end → Unregister.

---

### Project Context Injection
| Property | Value |
|----------|-------|
| **Introduced** | v0.6.0 |
| **Status** | ✅ Active |
| **Tool** | `genorch_session_start_work`, `genorch_session_clear_work`, `genorch_project_leave` |
| **Hook** | `before_prompt_build` — injects STATE.md + ROADMAP.md |

**What it does:** When a session calls `set_context(project, task)`, it locks to that project. Every subsequent `before_prompt_build` hook injects the project's STATE.md and ROADMAP.md into the agent's context. The session is bound to one project until `release_project` is called.

**Binding rules:**
- One session = one project
- `clear_context` clears context but keeps binding
- `release_project` unbinds entirely
- `join_project` handles register + bind + context in one call

---

### Dashboard (Native Route)
| Property | Value |
|----------|-------|
| **Introduced** | v0.6.0 |
| **Status** | ✅ Active |
| **Route** | `/orchestrator` via `api.registerHttpRoute(...)` |
| **Handler** | `src/dashboard-handler.ts` |

**What it does:** Single-file SPA served directly by OpenClaw at the `/orchestrator` gateway route. Expanded from 6 tabs (v0.6.0) to 9 tabs (v0.8.0), later consolidated to 7 tabs (v0.9.0, Chat Console and Sessions moved to OpenClaw WebUI). Uses StateManager reactive state, Tailwind CSS. No separate server or PM2 bridge.

---

### Auto-Populate Models
| Property | Value |
|----------|-------|
| **Introduced** | v0.6.0 |
| **Status** | ✅ Active |
| **Tool** | `genorch_models_auto_discover` |

**What it does:** Syncs model inventory from OpenClaw gateway config on every plugin boot. Scrapes the gateway for all configured models, merges into `models.json`. Models removed from the gateway config are pruned (not preserved as orphans). Uses atomic writes (`.tmp` → `renameSync`). Can also be triggered manually via `genorch_models_auto_discover` tool.

---

### Session-Project Binding
| Property | Value |
|----------|-------|
| **Introduced** | v0.6.0 |
| **Status** | ✅ Active |

**What it does:** The orchestrator's most important design concept. One session locks to one project. Prevents cross-project contamination. Each project has isolated model routing, allowlist, and session logs. `release_project` is the only way to unbind and switch projects.

---

### Hook Scoping
| Property | Value |
|----------|-------|
| **Introduced** | v0.6.0 |
| **Status** | ✅ Active |
| **Hooks** | All 8 lifecycle hooks |

**What it does:** Unregistered sessions are completely invisible to the plugin. No live-agents bleed, no context injection, no routing noise. Only sessions that called `genorch_session_register` trigger any hook behavior. Background/dreaming/cron/subagent sessions are filtered out.

---

### Subagent Spawning
| Property | Value |
|----------|-------|
| **Introduced** | v0.6.0 |
| **Status** | ✅ Active |
| **Tool** | `genorch_task_delegate` |
| **Hook** | `subagent_spawned`, `subagent_ended` |

**What it does:** Spawns subagents with orchestrator-managed project context. Routes model choice, injects full project context, and logs the subagent session under the current project. Supports taskName for stable handles and timeoutSeconds for budget control.

---

### Session Logging
| Property | Value |
|----------|-------|
| **Introduced** | v0.6.0 |
| **Status** | ✅ Active |
| **Tool** | `genorch_session_log` |
| **Hook** | `session_end` — auto-logs |

**What it does:** Every session end writes a structured entry to the per-project `sessions.json` (schema v2). Includes agent, model, status, task, duration, notes, project binding. Also logged to flat `session_log.md` for quick scanning. Automatic via hooks; manual available for retroactive entries.

---

### ADR Management
| Property | Value |
|----------|-------|
| **Introduced** | v0.6.0 |
| **Status** | ✅ Active |
| **Tool** | `genorch_adr_log` |
| **Data** | `adrs/` directory, auto-numbered markdown files |

**What it does:** Logs Architecture Decision Records (ADRs) as auto-numbered markdown files. Captures context, decision, alternatives considered, and consequences. Stored in global `adrs/` and per-project `adr/` directories. Permanent, searchable record of design decisions.

---

### Doctor Diagnostics
| Property | Value |
|----------|-------|
| **Introduced** | v0.6.0 |
| **Status** | ✅ Active |
| **Tool** | `genorch_system_diagnose` |

**What it does:** Diagnoses and auto-fixes 4 categories of issues:
1. **Sessions** — missing registration, synthetic key bridging
2. **Context** — missing project context, mismatched keys
3. **Data** — corrupt models.json, missing config, stale logs
4. **Projects** — orphaned 0-session projects, missing STATE.md

---

### Project Sync
| Property | Value |
|----------|-------|
| **Introduced** | v0.6.0 |
| **Status** | ✅ Active |
| **Tool** | `genorch_project_sync_files` |

**What it does:** Regenerates CONTEXT.md and KEY_FILES.md from the project source code on disk. Scans for all files, generates a structured index. Also runs automatically during maintenance ticks.

---

### Active Project Discovery & Joining
| Property | Value |
|----------|-------|
| **Introduced** | v0.6.0 |
| **Status** | ✅ Active |
| **Tools** | `genorch_project_list_active`, `genorch_project_join` |

**What it does:** Discover projects with active sessions, then join them in one step. `join_project` handles registration + binding + context setting in a single call. Ideal for ad-hoc sessions and subagents contributing to existing projects.

---

### Live Agent Tracking
| Property | Value |
|----------|-------|
| **Introduced** | v0.6.0 |
| **Status** | ✅ Active |
| **Data file** | `live-agents.json` |

**What it does:** Real-time agent state written to `live-agents.json` on every hook event. Debounced and coalesced at 500ms intervals to prevent disk thrashing. Dashboard consumes this for live monitoring: agent name, project, task, model, workflow phase, elapsed time, action history, token usage.

---

### Maintenance Service
| Property | Value |
|----------|-------|
| **Introduced** | v0.6.0 |
| **Status** | ✅ Active |
| **Interval** | Every 30 minutes |

**What it does:** Background service that handles:
- 📋 Log rotation (30-day retention, auto-cleanup)
- 🔄 Session JSON normalization (schema v2 compatibility)
- 📝 Recovery doc generation (RECOVERY.md) for each active project
- 🔗 Project sync (CONTEXT.md, KEY_FILES.md regeneration)
- 🎮 Control action processing (dashboard → plugin commands)
- 🛡️ Stale agent detection + auto-recovery
- 🔍 Hidden-directory filter (`.archived`, `.` prefixed dirs excluded)

---

### Workflow Enforcement
| Property | Value |
|----------|-------|
| **Introduced** | v0.6.0 |
| **Status** | ✅ Active |
| **Tool** | `genorch_workflow_advance_phase` |

**What it does:** 6-phase coding workflow enforcement: **Analyze → Plan → Document → Work → Log → Finish**. Phases configured per-project in `dashboard-config.json`. Supports skip-phase, QA gate (v0.8.0), and auto-commit on session end.

---

### Safeguard System
| Property | Value |
|----------|-------|
| **Introduced** | v0.6.0 |
| **Status** | ✅ Active |
| **Data file** | `safeguard-log.md` |

**What it does:** Idle/stuck agent detection. Runs on every maintenance tick:
| Condition | Action |
|-----------|--------|
| Agent idle >10min | Warning logged, auto-recovery action written |
| Agent stuck >30min (no update) | Warning logged |
| Error storm ≥max_errors | Escalation alert |
| Auto-recovery enabled | Writes `set_context` action for idle project |

---

### Control Actions
| Property | Value |
|----------|-------|
| **Introduced** | v0.6.0 |
| **Status** | ✅ Active |
| **Data dir** | `control/` |

**What it does:** Dashboard → plugin action queue via filesystem. Supported actions: `set_context`, `clear_context`, `update_routing`, `spawn_agent`, `stop_agent`. Actions written as `.action.json` files, processed by MaintenanceService, results written as `.result.json` files. Allows the dashboard to control plugin behavior without real-time API calls.

---

## Deprecated / Removed Features

### Queue-Based Session Spawn
| Property | Value |
|----------|-------|
| **Introduced** | v0.8.x |
| **Status** | ❌ Removed in v0.9.0 |
| **Replaced by** | OpenAI Endpoint Session Spawn |

**What it was:** A pipeline where the dashboard HTTP handler wrote `pending-spawns.json`, the `before_prompt_build` hook drained it via `api.runtime.subagent.run()`, and the spawned session auto-registered. Removed due to complexity and race conditions.

### Trusted-Operator Runtime Scope
| Property | Value |
|----------|-------|
| **Introduced** | v0.8.x |
| **Status** | ❌ Removed in v0.9.0 |

**What it was:** Attempted to use `gatewayRuntimeScopeSurface: "trusted-operator"` to allow `subagent.run()` from HTTP handler context. Failed because the gateway ignores this for `auth: "plugin"` routes.

### Self-API Session Fetch
| Property | Value |
|----------|-------|
| **Introduced** | v0.8.x |
| **Status** | ❌ Removed in v0.9.0 |

**What it was:** Fetching `/v1/chat/completions` from within the plugin's own HTTP handler to create sessions. Blocked for 10-30s waiting for AI response, and `session_start` hook didn't fire reliably.

### Heartbeat-Based Wake
| Property | Value |
|----------|-------|
| **Introduced** | v0.8.x |
| **Status** | ❌ Removed in v0.9.0 |

**What it was:** Using `requestHeartbeat` to trigger `before_prompt_build` for draining spawn queue. Failed because heartbeats don't trigger hooks.

### Cron-Based Spawn
| Property | Value |
|----------|-------|
| **Introduced** | v0.8.x |
| **Status** | ❌ Removed in v0.9.0 |

**What it was:** Using cron jobs to periodically check and drain spawn queue. Rejected by user — too indirect and unreliable.

### PM2 Bridge (Python Sidecar)
| Property | Value |
|----------|-------|
| **Introduced** | v0.4.x |
| **Status** | ❌ Removed in v0.8.0 |
| **Replaced by** | Native `/orchestrator` HTTP route |

**What it was:** A Python FastAPI server running under PM2 that served the dashboard. Replaced by native OpenClaw HTTP route registration.

### Chat Console (SSE/WebSocket)
| Property | Value |
|----------|-------|
| **Introduced** | v0.4.x |
| **Status** | ❌ Removed in v0.8.0 |
| **Replaced by** | Sessions Tab |

**What it was:** A dashboard tab with SSE streaming chat functionality. Removed because real-time chat is OpenClaw WebUI's responsibility, not the orchestrator's.

### Slash Commands
| Property | Value |
|----------|-------|
| **Introduced** | v0.5.0 |
| **Status** | ❌ Removed in v0.8.0 |
| **Replaced by** | Proper tools (all 40 migrated) |

**What it was:`/genor-COMMAND` slash commands (e.g., `/genor-register`). All migrated to proper tool registrations with full metadata for agent injection.**

---

## Feature Summary

| Version | New Features | Cumulative Tools |
|---------|-------------|:----:|
| **v0.9.0** | OpenAI Endpoint Session Spawn, Queue Removed | 40 |
| **v0.8.0** | Dashboard Redesign, Sessions Tab, QA Workflow, Handoff, Doc Tools, Test Tools, PM2 Removed | 40 |
| **v0.7.0** | Routing Presets, Backlog, Enhanced Routing, Safeguards Dashboard | 28 |
| **v0.6.0** | Core: Model Routing, Session Tracking, Context Injection, Dashboard, Subagent Spawning, ADR, Doctor, Workflow, Live Agents, Maintenance | 22 |

---

*Generated: 2026-06-19 | Last updated: v0.9.0*
