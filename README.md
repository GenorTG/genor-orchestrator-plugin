# Genor Orchestrator — Software House

> **v0.1.0-alpha** — AI-powered software house with persistent worker sessions, task execution, inter-worker collaboration, and full project lifecycle management.

An OpenClaw plugin that turns your AI agent into a software house manager with:
- **Project management** — create, bind, track projects with full context injection
- **Backlog & dispatch** — task queues with priority, labels, dependencies, and auto-dispatch
- **Worker personas** — persistent AI worker sessions that execute tasks via OpenAI HTTP API
- **Model routing** — automatic model selection per task category (coding, fixing, research, QA)
- **Session lifecycle** — register, track, log, and review agent sessions
- **Dashboard** — real-time web UI at `http://localhost:18789/orchestrator`
- **Verification pipelines** — multi-agent work → review → fix loops
- **Architecture decisions** — ADR logging and knowledge management
- **Workflow enforcement** — Analyze → Plan → Document → Work → Log → Finish phase gating
- **QA gates** — mandatory QA approval before advancing from work phase
- **Slash commands** — `/genor-dashboard`, `/genor-status`, `/genor-help`, `/genor-git-commit`, `/genor-doctor`

---

## Table of Contents

- [Quick Start](#quick-start)
- [Configuration Reference](#configuration-reference)
- [Available Tools (61)](#available-tools-61)
- [Dashboard](#dashboard)
- [Commands](#commands)
- [Architecture Overview](#architecture-overview)
- [What's New in Alpha](#whats-new-in-alpha)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Quick Start

### 1. Install the plugin

Clone or link the plugin into OpenClaw's load path:

```bash
# Option A: Symlink into extensions
ln -s ~/projects/genor-orchestrator-plugin ~/.openclaw/extensions/genor-orchestrator-software-house

# Option B: Add to config load paths (already done if cloned to ~/projects/)
```

### 2. Build

```bash
cd ~/projects/genor-orchestrator-plugin
npm install
npm run build
```

### 3. Configure

Add to `~/.openclaw/openclaw.json` under `plugins.entries`:

```json
{
  "plugins": {
    "entries": {
      "genor-orchestrator-software-house": {
        "enabled": true,
        "config": {
          "logLevel": "info",
          "logRetentionDays": 30,
          "dashboardPort": 8766,
          "maxConcurrentWorkers": 3,
          "taskTimeout": 1800000,
          "recoveryInterval": 60000,
          "maintenanceIntervalMs": 1800000
        },
        "hooks": {
          "allowConversationAccess": true
        }
      }
    }
  }
}
```

**Required config fields:**
| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Must be `true` to load the plugin |
| `hooks.allowConversationAccess` | `false` | **Required** for `before_model_resolve` and `agent_end` hooks (project context injection) |

**Optional config fields:**
| Field | Default | Description |
|-------|---------|-------------|
| `config.logLevel` | `"info"` | Log verbosity: `debug`, `info`, `warn`, `error` |
| `config.logRetentionDays` | `30` | Days to keep orchestration logs |
| `config.dashboardPort` | `8766` | Dashboard web UI port (served through gateway at `/orchestrator`) |
| `config.maxConcurrentWorkers` | `3` | Max parallel worker sessions |
| `config.taskTimeout` | `1800000` | Worker task timeout (ms, default 30min) |
| `config.recoveryInterval` | `60000` | Stale worker recovery check interval (ms) |
| `config.maintenanceIntervalMs` | `1800000` | Background maintenance interval (ms) |
| `config.orchestratorDataDir` | `~/.openclaw/orchestrator-data` | Override data directory |

### 4. Restart Gateway

```bash
openclaw gateway restart
```

### 5. Verify

```bash
openclaw plugins inspect genor-orchestrator-software-house
# Should show: Status: loaded

openclaw plugins inspect genor-orchestrator-software-house --runtime
# Should show 61 tools, 6 hooks, 5 commands
```

---

## Configuration Reference

### Hooks

The plugin registers these hooks (require `hooks.allowConversationAccess: true`):

| Hook | Purpose |
|------|---------|
| `before_model_resolve` | Selects optimal model per task category (coding → Claude, research → DeepSeek, etc.) |
| `before_prompt_build` | Injects project context (README, STATE, architecture) into prompts |
| `session_start` | Registers session with orchestrator tracking |
| `session_end` | Logs session completion |
| `subagent_spawned` | Tracks subagent lifecycle |
| `subagent_ended` | Cleans up subagent tracking |
| `agent_end` | Logs final session state |
| `gateway_stop` | Graceful shutdown cleanup |

### OpenAI HTTP API (Required for Workers)

The plugin uses OpenClaw's built-in OpenAI-compatible HTTP API to execute worker tasks. Ensure this is enabled:

```json
{
  "gateway": {
    "openai": {
      "enabled": true
    }
  }
}
```

Workers send HTTP POST requests to `http://localhost:18789/v1/chat/completions` to trigger task execution.

### Data Directory

Default: `~/.openclaw/orchestrator-data/`

Contains:
- `orchestrator.db` — SQLite database (sessions, backlog, projects, logs)
- `logs/` — structured orchestration logs
- `projects/` — per-project state files
- `adrs/` — architecture decision records

---

## Available Tools (61)

### Core & Status
| Tool | Description |
|------|-------------|
| `genorch_status` | Quick orchestration status overview |
| `genorch_system_diagnose` | Diagnose and auto-fix common orchestrator issues |
| `genorch_config_show_routing` | Show full routing configuration |

### Session Management
| Tool | Description |
|------|-------------|
| `genorch_session_register` | Register session for orchestrator tracking |
| `genorch_session_start_work` | Start working on a bound project task |
| `genorch_session_log` | Log completed session with summary |
| `genorch_session_list` | List all registered sessions |
| `genorch_session_clear_work` | Clear active project context |
| `genorch_session_unregister` | Unregister from orchestrator tracking |

### Project Management
| Tool | Description |
|------|-------------|
| `genorch_project_create` | Create a new project |
| `genorch_project_bind` | Bind session to project (loads context) |
| `genorch_project_join` | Register + bind + start work in one step |
| `genorch_project_leave` | Release project binding |
| `genorch_project_list_active` | List projects with active sessions |
| `genorch_project_docs_list` | List managed project documents |
| `genorch_project_sync_docs` | Sync docs to match current project state |
| `genorch_project_sync_files` | Sync project files from disk into orchestrator-data |
| `genorch_project_tidy_docs` | Auto-clean and organize project documentation |
| `genorch_project_rebuild_state` | Regenerate STATE.md from project event log |

### Backlog & Dispatch
| Tool | Description |
|------|-------------|
| `genorch_backlog_add` | Add task with priority, labels, and dependencies |
| `genorch_backlog_list` | List tasks with filters by status, priority, label |
| `genorch_backlog_update` | Update task status, priority, assignment, labels |
| `genorch_backlog_dispatch` | Pick and dispatch highest-priority available task |
| `genorch_backlog_dispatch_all` | Dispatch multiple available tasks in parallel |

### Worker System
| Tool | Description |
|------|-------------|
| `genorch_worker_hire` | Create a new worker persona |
| `genorch_worker_fire` | Remove a worker |
| `genorch_worker_edit` | Edit worker details (name, role, model, sprite) |
| `genorch_worker_start` | Execute a task via worker session |
| `genorch_worker_status` | Check worker status and recent activity |
| `genorch_worker_health` | Check worker session health |
| `genorch_worker_recover` | Recover a stalled worker session |
| `genorch_worker_messages` | Get messages for a worker |
| `genorch_worker_message` | Send a message between workers |
| `genorch_worker_assign` | Assign a backlog task to a worker |
| `genorch_worker_sessions` | List active worker sessions |

### Model & Routing
| Tool | Description |
|------|-------------|
| `genorch_models_list` | List model inventory with filters |
| `genorch_models_recommend` | Get recommended model for a task category |
| `genorch_models_check_routing` | Check model eligibility per project |
| `genorch_models_auto_discover` | Auto-populate model inventory from gateway config |

### QA & Verification
| Tool | Description |
|------|-------------|
| `genorch_qa_submit` | Submit QA finding (auto-spawns independent reviewer) |
| `genorch_qa_approve` | Approve work and unblock workflow |
| `genorch_qa_reject` | Reject with reason (returns to work phase) |
| `genorch_verify_pipeline_start` | Start multi-agent verification pipeline |
| `genorch_verify_pipeline_check` | Advance verification pipeline state |
| `genorch_verify_pipeline_guide` | Give guidance to a stalled pipeline |

### Workflow & Task Orchestration
| Tool | Description |
|------|-------------|
| `genorch_workflow_advance_phase` | Advance workflow phase (Analyze → Plan → Document → Work → Log → Finish) |
| `genorch_task_delegate` | Spawn subagent with orchestrator-managed project context |
| `genorch_task_create` | Create a backlog task |
| `genorch_task_move` | Move task to a different phase (todo → in_progress → review → done) |
| `genorch_task_assign` | Assign a task to a worker |
| `genorch_handoff_create` | Generate handoff/recovery document |
| `genorch_feature_design` | Spawn feature design subagent |
| `genorch_issue_debug` | Spawn debugging/investigation subagent |

### Knowledge & Documentation
| Tool | Description |
|------|-------------|
| `genorch_adr_log` | Log an architecture decision record |
| `genorch_knowledge_quiz` | Quiz on project documentation to catch knowledge gaps |
| `genorch_logs_query` | Query orchestration logs with filters |

### Rooms (Collaboration Spaces)
| Tool | Description |
|------|-------------|
| `genorch_room_create` | Create a new collaboration room |
| `genorch_room_edit` | Edit room details |
| `genorch_room_delete` | Remove a room |

### Testing
| Tool | Description |
|------|-------------|
| `genorch_test_create_e2e` | Set up end-to-end test infrastructure |
| `genorch_test_create_unit` | Set up unit test infrastructure |

---

## Dashboard

Access at `http://localhost:18789/orchestrator` (served through the OpenClaw gateway).

Features:
- Real-time session monitoring with live agent status
- Backlog task board with priority and status
- Worker status and activity view
- Model routing visualization
- Project context inspector
- Software House sub-UI at `/orchestrator/software-house`

---

## Commands

| Command | Description |
|---------|-------------|
| `/genor-dashboard` | Open the orchestrator dashboard URL |
| `/genor-status` | Quick status check |
| `/genor-help` | Show available commands and usage |
| `/genor-git-commit` | Commit with orchestrator context |
| `/genor-doctor` | Run diagnostics and auto-fix |

---

## Architecture Overview

```
┌───────────────────────────────────────────────────────────────────┐
│                      OpenClaw Gateway                             │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │              genor-orchestrator-software-house                │  │
│  │                                                               │  │
│  │  ┌──────────────┐  ┌──────────┐  ┌──────────────────────┐   │  │
│  │  │ Session       │  │ Backlog  │  │  Model Router        │   │  │
│  │  │ Registry      │  │ Manager  │  │  (per category)      │   │  │
│  │  └──────┬───────┘  └────┬─────┘  └─────────┬────────────┘   │  │
│  │         │               │                   │                 │  │
│  │  ┌──────┴───────────────┴───────────────────┴──────────────┐ │  │
│  │  │              Plugin Core (SQLite)                        │ │  │
│  │  │  orchestrator.db — sessions, backlog, models, logs      │ │  │
│  │  └──────────────────────┬──────────────────────────────────┘ │  │
│  │                         │                                     │  │
│  │  ┌──────────────────────┴──────────────────────────────────┐ │  │
│  │  │         Worker Engine (OpenAI HTTP API)                  │ │  │
│  │  │    http://localhost:18789/v1/chat/completions            │ │  │
│  │  └──────────────────────┬──────────────────────────────────┘ │  │
│  │                         │                                     │  │
│  │  ┌──────────────────────┴──────────────────────────────────┐ │  │
│  │  │              Worker Sessions                              │ │  │
│  │  │   dev-1   │   dev-2   │   qa-1   │   dev-3    │  pm-1  │ │  │
│  │  └─────────────────────────────────────────────────────────┘ │  │
│  │                                                               │  │
│  │  ┌─────────────────────────────────────────────────────────┐ │  │
│  │  │  Dashboard (HTTP handler at /orchestrator)               │ │  │
│  │  │  → Real-time UI → live agents, backlog, workers          │ │  │
│  │  └─────────────────────────────────────────────────────────┘ │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Hooks (before_model_resolve, before_prompt_build, ...)      │  │
│  │  → Context injection, model selection, session lifecycle     │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Plugin-native dashboard** — no separate process, served through OpenClaw gateway's built-in HTTP server
- **SQLite persistence** — all state in `orchestrator.db`, no external database required
- **Session isolation** — each agent session gets its own state; cross-project contamination prevented by strict binding
- **Model routing** — automatic model selection per task category based on quality tiers
- **Workflow enforcement** — optional phase gating with QA checks between work and log
- **Worker engine** — persistent AI worker personas communicate via the gateway's OpenAI-compatible HTTP API

---

## What's New in Alpha (v0.1.0-alpha)

This is the first alpha release. Key features:

- **61 registered tools** — comprehensive project management, backlog, workers, QA, and system tools
- **Dashboard UI** — real-time web dashboard at `/orchestrator` with live agent status, backlog board, and worker view
- **Software House sub-UI** — dedicated worker management interface at `/orchestrator/software-house`
- **Session lifecycle** — full register → bind → work → log → unregister flow
- **Project context injection** — auto-injects README, STATE, architecture, and project docs into prompts
- **Model routing** — quality-tier-based model selection per task type
- **Backlog with dispatch** — priority/label/dependency system with auto-dispatch
- **Worker system** — persistent personas, inter-worker messaging, task execution via OpenAI HTTP
- **QA gates** — mandatory QA submission before workflow advancement (configurable)
- **Verification pipelines** — multi-agent work → review → fix loops
- **ADR logging** — architecture decision records stored in `adrs/`
- **Workflow enforcement** — optional Analyze → Plan → Document → Work → Log → Finish gating
- **5 slash commands** — dashboard, status, help, git-commit, doctor
- **8 hooks** — full session lifecycle and context injection
- **13 passing tests** — mock-based test suite covering workers, tasks, messaging, and end-to-end

---

## Troubleshooting

### Plugin not loading

```bash
# Check status
openclaw plugins inspect genor-orchestrator-software-house

# Check for errors
openclaw plugins inspect genor-orchestrator-software-house --runtime --json

# Force rebuild
cd ~/projects/genor-orchestrator-plugin
npm run build
openclaw gateway restart
```

### "must declare contracts.tools" errors

The `openclaw.plugin.json` manifest must list every tool the plugin registers. If you add new tools, update `contracts.tools` in the manifest and rebuild.

### Hooks blocked

Ensure `hooks.allowConversationAccess: true` is set in the plugin entry config. Without this, `before_model_resolve` and `agent_end` hooks are blocked.

### Workers not executing

1. Ensure OpenAI HTTP API is enabled in gateway config
2. Check gateway token is available (set `OPENCLAW_GATEWAY_TOKEN` env var)
3. Check worker status: `genorch_worker_status`
4. Check logs: `genorch_logs_query`

### Dashboard not accessible

1. The dashboard is served through the gateway at `http://localhost:18789/orchestrator`
2. Ensure the plugin loaded: `openclaw plugins inspect genor-orchestrator-software-house`
3. Check gateway is running: `openclaw gateway status`
4. Try accessing directly: `curl http://localhost:18789/orchestrator/`

---

## License

MIT — See LICENSE file for details.
