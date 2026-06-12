# Genor's Orchestrator — OpenClaw Plugin

OpenClaw plugin for AI project orchestration: model routing, session logging, project context automation, and lifecycle hooks.

[![ClawHub](https://clawhub.com/badge/genor-orchestrator)](https://clawhub.com/packages/genor-orchestrator)
[![License: MIT-0](https://img.shields.io/badge/License-MIT--0-blue.svg)](LICENSE)

## Features

- **12 Tools** — project context, model inventory, session logging, ADR tracking, project sync, data exploration
- **8 Hooks** — auto-log sessions, enforce model routing rules, inject project context, track sub-agent trees
- **No Embedded Server** — Dashboard web UI runs as a separate PM2 sidecar
- **JSONL Logging** — structured, level-filtered, auto-rotated logs
- **Background Maintenance** — session normalization, recovery doc generation, log cleanup
- **Survives Wipes** — all data stored on filesystem, not in OpenClaw session storage

## Quick Start

```bash
openclaw plugins install genor-orchestrator
openclaw plugins enable genor-orchestrator
# Restart gateway to load
```

Requires OpenClaw >= 2026.5.17.

## Usage

```typescript
// Set project context (MANDATORY before project work)
orchestrator_set_context(project="my-project", task="fix-bug")

// Plugin hooks automatically handle:
// - Session logging on completion
// - Model routing (respects project allowlists)
// - Context injection into prompts
// - Recovery doc generation
```

## Tools

| Tool | Purpose |
|------|---------|
| `orchestrator_set_context` | Set project + task, enable automation |
| `orchestrator_clear_context` | Clear active project context |
| `orchestrator_get_status` | Quick overview: models, sessions, projects |
| `orchestrator_get_models` | List models with filters |
| `orchestrator_check_models` | Check eligible models for a project |
| `orchestrator_auto_populate` | Auto-populate models from gateway config |
| `orchestrator_log_session` | Log a session (manual use) |
| `orchestrator_log_decision` | Log architecture decision (ADR) |
| `orchestrator_get_logs` | Query structured JSONL logs |
| `orchestrator_sync_project` | Sync project from disk |
| `orchestrator_get_project_docs` | List project documents |

## Hooks

| Hook | Automates |
|------|-----------|
| `session_start` | Track start time, reset depth |
| `session_end` | Auto-log session, generate recovery doc |
| `subagent_spawned/ended` | Track sub-agent tree depth |
| `before_model_resolve` | Apply project routing filters |
| `before_prompt_build` | Inject project context into prompts |
| `agent_end` | Observe session state |
| `gateway_stop` | Clean up maintenance timers |

## Configuration

Configured via OpenClaw config (`openclaw.json`):

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `orchestratorDataDir` | string | `workspace/orchestrator-data/` | Data directory override |
| `logLevel` | string | `info` | Logging level |
| `logRetentionDays` | number | `30` | Log retention period |
| `maintenanceIntervalMs` | number | `1800000` | Background maintenance interval |

## Dashboard (Sidecar)

The web UI is a separate Python server managed by PM2:

```bash
pm2 start skills/genor-orchestrator/dashboard/server.py \
  --name orchestration-dashboard \
  --interpreter python3 -- 8766
```

Open http://localhost:8766 to manage models, routing, and sessions.

## Development

```bash
git clone git@github.com:GenorTG/genor-orchestrator-plugin.git
cd genor-orchestrator-plugin
npm install
npm run build
openclaw plugins install --force .
```

## License

MIT-0 — Free to use, modify, and redistribute. No attribution required.

