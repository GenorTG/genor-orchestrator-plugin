# Genor's Orchestrator — OpenClaw Plugin

[![ClawHub](https://img.shields.io/badge/ClawHub-genor--orchestrator--plugin-blue)](https://clawhub.com/packages/genor-orchestrator-plugin)
[![License: MIT-0](https://img.shields.io/badge/License-MIT--0-brightgreen)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/GenorTG/genor-orchestrator-plugin)](https://github.com/GenorTG/genor-orchestrator-plugin/releases)

> **22 tools + 8 lifecycle hooks for AI project orchestration in OpenClaw.** Model routing, session logging, project context injection, live agent tracking, ADR management, workflow enforcement, session-project binding, orphaned project cleanup, and dashboard — all inside OpenClaw with no separate process.

The orchestrator doesn't take over your thinking — it handles the scaffolding so your LLM can focus on what matters: coding, solving problems, and building cool stuff.

---

## What's New in v0.6.0 🚀

The jump from 12→22 tools brings six major features that make the orchestrator smarter about *who* is working on *what* and *why*:

| Feature | What It Does |
|---------|-------------|
| **🔒 Session-Project Binding** | Once a session sets context on project X, it's **locked**. Switch to Y? Nope — call `release_project` first. One session, one project. |
| **🚫 Hook Scoping** | Unregistered sessions are *invisible* to the plugin — no live-agents bleed, no context injection, no routing noise. |
| **🧹 Orphaned Project Cleanup** | `orchestrator_doctor` detects dead/empty projects and archives them to `.archived/` automatically. |
| **🔍 Active Project Discovery** | `list_active_projects` + `join_project` let ad-hoc sessions discover and contribute to running work. |
| **📋 Project Health Enforcement** | Every project needs `STATE.md`. Doctor reports gaps, auto-creates with metadata, flags stale sessions. |
| **🤖 Subagent Spawning** | `spawn_subagent` routes model choice, injects context, and logs subagent sessions under the parent project. |

---

## Installation for AI Agents

> **Copy-paste to any AI agent:** *"Install Genor's Orchestrator from https://github.com/GenorTG/genor-orchestrator-plugin.git"*

The agent should:
1. `git clone --recurse-submodules` the repo
2. Read `SETUP.md`
3. Execute the 7-step procedure

Done. The plugin auto-creates data dirs, schedules nightly model sync, and runs background maintenance every 30 minutes.

### Via ClawHub

```bash
clawhub package install genor-orchestrator-plugin
```

---

## What You Get

### 22 Tools

| Tool | Purpose |
|------|---------|
| `orchestrator_register` | Opt in to orchestrator tracking — required first step |
| `orchestrator_unregister` | Remove session from tracking, release project binding |
| `orchestrator_set_context` | ⭐ **Mandatory** — set active project + task, enables routing, logging, injection |
| `orchestrator_clear_context` | Clear active context (binding *persists* — use `release_project` to unbind) |
| `orchestrator_get_status` | Quick overview: model counts, sessions logged, project list |
| `orchestrator_get_config` | Full routing config: free-only mode, disabled models, per-project allowlists |
| `orchestrator_get_models` | Filtered model inventory by status, provider, search, project routing |
| `orchestrator_check_models` | Preview which models are eligible for a project |
| `orchestrator_auto_populate` | Sync model inventory from OpenClaw gateway, preserving manual ratings |
| `orchestrator_log_session` | Write a structured session entry to the project log |
| `orchestrator_log_decision` | Log an Architecture Decision Record (ADR) to the project |
| `orchestrator_get_logs` | Query orchestration log: routing decisions, config changes, session activity |
| `orchestrator_sync_project` | Regenerate CONTEXT.md + KEY_FILES.md from project source |
| `orchestrator_get_project_docs` | List all managed documents for a project |
| `orchestrator_advance_phase` | Step through the coding workflow: Analyze → Plan → Document → Work → Log → Finish |
| `orchestrator_get_routing` | Best model recommendation for a task category (coding, fixing, research, etc.) |
| `orchestrator_get_registered_sessions` | List all sessions that opted in to orchestrator tracking |
| `orchestrator_release_project` | 🔓 Unlock session-project binding to switch projects |
| `orchestrator_list_active_projects` | Discover projects with active sessions + doc health |
| `orchestrator_join_project` | 🏃 Register + set context in one step for ad-hoc sessions |
| `orchestrator_spawn_subagent` | 🤖 Spawn a subagent with model routing + auto-logging |
| `orchestrator_doctor` | 🩺 Diagnose & auto-fix: session keys, registration, stale data, orphaned projects, missing STATE.md |

### 8 Lifecycle Hooks

- `session_start` — Tracks session begin, bypasses background/dreaming/cron
- `session_end` — Auto-logs session, generates recovery doc, triggers git commit (if enabled)
- `subagent_spawned` — Registers subagent in session tracker with parent context
- `subagent_ended` — Cleanup subagent tracking
- `before_model_resolve` — **Auto-routing**: picks the best available model for the active project
- `before_prompt_build` — **Context injection**: injects project context, STATE.md, ROADMAP.md into prompts
- `agent_end` — Final flush of live-agents state
- `gateway_stop` — Clean shutdown

### Dashboard — Built In 🖥️

No PM2 process needed. The dashboard is served directly by OpenClaw at the `/orchestrator` gateway route:

```
https://your-gateway/orchestrator
```

**6 tabs:**
| Tab | What You See |
|-----|-------------|
| **Home** | Model stats, active projects, recent sessions, routable models |
| **Projects** | Per-project view: sessions, docs, health, active sessions |
| **Models** | CRUD model inventory, tier/speed/status editing |
| **Gateway** | Live OpenClaw gateway sessions |
| **Logs** | Orchestration log with level filtering |
| **Safeguards** | Idle/stuck agent detection, auto-recovery, error tracking |

### Live Agent Monitoring

Real-time agent state written to `live-agents.json` on every hook event, consumed by the dashboard for live monitoring. The dashboard shows active agents with their project, task, model, action history, token usage, and workflow phase.

### Auto-Maintenance

Background tick every 30 minutes:
- Log rotation (30-day retention)
- Session normalization
- Recovery doc generation
- Project sync from source
- Control action processing (dashboard → plugin commands)
- Stale agent detection + auto-recovery

### Data Survives Wipes

All data lives on the filesystem at `orchestrator-data/` — model inventory, session logs, ADRs, project docs, live agent state. Gateway restarts? Plugin reinstalls? Your data's fine.

---

## Quick Reference

### Essential Workflow

```typescript
// 1. Register (opt in)
orchestrator_register()

// 2. Set context — starts everything
orchestrator_set_context(project="my-project", task="Add delete button")

// 3. Work happens — hooks auto-route and inject context

// 4. Log decisions as you go
orchestrator_log_decision(project="my-project", title="Chose X over Y",
  context="Why we needed a decision", decision="We chose X because Z")

// 5. Check status anytime
orchestrator_get_status()

// 6. Switch projects? Release first
orchestrator_release_project()
orchestrator_set_context(project="other-project", task="Something else")

// 7. Done? Unregister
orchestrator_unregister()
```

### Session-Project Binding Flow

```
Session A → register → set_context("alpha") → ✅ locked to alpha
Session A → set_context("beta")  → ❌ Binding violation error
Session A → release_project      → 🔓 unbound
Session A → set_context("beta")  → ✅ now locked to beta
Session B → register → set_context("alpha") → ✅ separate binding
```

### Active Project Discovery

```typescript
// See what's being worked on right now
orchestrator_list_active_projects()
// → [{ project: "alpha", active_sessions: 2, ... }]

// Join an active project from a new session
orchestrator_join_project(project="alpha", task="Help with bug fix")
// → registers + sets context in one call
```

### Subagent Spawning

```typescript
orchestrator_spawn_subagent(task="Refactor the auth module",
  taskName="auth_refactor",
  model="claude-sonnet-4",         // optional — omit for auto-routing
  timeoutSeconds=600)
// → spawns with project context injected, logged under current project
```

### Slash Commands

| Command | Description |
|---------|-------------|
| `/genor` | Orchestrator help + dashboard link + status |
| `/genor-help` | List all available commands |
| `/genor-dashboard` | Show dashboard URL |
| `/genor-status` | Quick orchestrator overview |
| `/genor-git-commit` | Auto-commit current project with version bump |

---

## Architecture

The orchestrator uses a **scoped, permission-based model**:

```
                    ┌─────────────────────────────────┐
                    │         OpenClaw Gateway         │
                    │   /orchestrator (dashboard)      │
                    └──────────┬──────────────────────┘
                               │ hooks
                    ┌──────────▼──────────────────────┐
                    │     Orchestrator Plugin          │
                    │                                  │
                    │  SessionTracker (per-session)    │
                    │  ├─ sessionProjectBinding        │
                    │  ├─ registeredSessions           │
                    │  ├─ sessionContexts               │
                    │  ├─ subagentRegistry              │
                    │  └─ projectActiveSessions         │
                    │                                  │
                    │  WorkflowTracker (per-project)   │
                    │  ├─ 6-phase workflow             │
                    │  ├─ QA retries                   │
                    │  └─ auto-commit                  │
                    │                                  │
                    │  MaintenanceService              │
                    │  ├─ log rotation                 │
                    │  ├─ safeguard detection          │
                    │  ├─ control action processor     │
                    │  └─ project health checks        │
                    └──────────┬──────────────────────┘
                               │
                    ┌──────────▼──────────────────────┐
                    │     orchestrator-data/           │
                    │  ├─ models.json                  │
                    │  ├─ dashboard-config.json        │
                    │  ├─ live-agents.json             │
                    │  ├─ state.json                   │
                    │  ├─ safeguard-log.md             │
                    │  ├─ logs/                        │
                    │  ├─ projects/                    │
                    │  │   ├─ my-project/              │
                    │  │   │   ├─ CONTEXT.md           │
                    │  │   │   ├─ STATE.md             │
                    │  │   │   ├─ KEY_FILES.md         │
                    │  │   │   ├─ RECOVERY.md          │
                    │  │   │   ├─ ROADMAP.md           │
                    │  │   │   ├─ sessions.json        │
                    │  │   │   ├─ BACKLOG.json         │
                    │  │   │   └─ adr/                 │
                    │  │   └─ .archived/               │
                    │  └─ control/                     │
                    └──────────────────────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Session-Project Binding** | Prevents cross-project contamination. One session = one project. |
| **Registration Required** | Plugin is invisible until a session opts in via `orchestrator_register`. |
| **Binding > Context** | `clear_context` releases context but not binding. Use `release_project` to unbind. |
| **Per-Session Context** | Each session key has its own project context — no sharing. |
| **Read-Only Project Dirs** | `getProjDir()` (returns null) replaces `projDir()` (creates dir) in maintenance paths to prevent orphan restoration. |
| **Hidden Dir Filter** | `.archived`, `.startsWith(".")` dirs excluded from dashboard, status, and maintenance ticks. |

---

## Configuration

### Dashboard Config (`dashboard-config.json`)

```json
{
  "free_only_mode": false,
  "disabled_models": [],
  "theme": "dark",
  "auto_refresh_seconds": 30,
  "safeguards": {
    "enabled": true,
    "idle_timeout_ms": 600000,
    "stuck_timeout_ms": 1800000,
    "max_errors_before_escalation": 3,
    "auto_recover": true
  },
  "projects": {
    "my-project": {
      "location": "/home/user/projects/my-project",
      "model_allowlist": ["gpt-4", "claude-sonnet-4"],
      "free_only": false,
      "workflow": {
        "enabled": true,
        "include_qa": true,
        "auto_commit": true,
        "qa_retries": 3,
        "skip_phases": []
      }
    }
  }
}
```

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `ORCHESTRATOR_DATA_DIR` | Override orchestrator data directory |
| `DASHBOARD_DIR` | Override dashboard static file directory |

---

## Changelog

| Version | Highlights |
|---------|-----------|
| **v0.6.0** | **+10 tools (22 total), 6 new features.** Session-project binding, hook scoping, orphaned project cleanup, active project discovery + joining, project health enforcement (STATE.md), subagent spawning tool. Dashboard migrated to native `/orchestrator` route (no PM2). Doctor tool with auto-fix. Safeguard auto-recovery. Hidden-dir filter across all listings. All 8 hooks operational. |
| **v0.5.0** | Slash commands restructured — monolithic `/genor` removed, replaced with `/genor-COMMAND` pattern. Added `/genor-git-commit` (auto-commit + version bump). Session key filter for background sessions. |
| v0.4.4 | Session key fix — filter background/dreaming/cron/subagent sessions from `session_start` hook |
| v0.4.3 | ToolPluginMetadata compat (OpenClaw 2026.6.6), live agent tracking, function name cleanup, double-cron fix |
| v0.4.2 | SessionTracker with live agents file, error logging |
| v0.4.1 | 12 tools verified working, `plugins.load.paths` fix, dashboard v4 SSE |
| v0.4.0 | Phase 1 complete: tool audit, 9 bugs fixed |
| v0.3.x | Initial dashboard, server refactors |

---

## Companion

[Genor's Orchestration Skill](https://github.com/GenorTG/genor-orchestrator-plugin) — dashboard web UI, coding workflow docs, and operational scripts. Installed via:

```bash
clawhub install genor-orchestrator
```

The skill (`SKILL.md`) is the LLM-facing side of the orchestrator — it tells agents how to use the tools, what the workflow phases mean, and how to recover from session loss.

---

## License

MIT-0 — Free to use, modify, redistribute. No attribution required.
