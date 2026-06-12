# Genor's Orchestrator — OpenClaw Plugin

[![ClawHub](https://img.shields.io/badge/ClawHub-genor--orchestrator--plugin-blue)](https://clawhub.com/packages/genor-orchestrator-plugin)
[![License: MIT-0](https://img.shields.io/badge/License-MIT--0-brightgreen)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/GenorTG/genor-orchestrator-plugin)](https://github.com/GenorTG/genor-orchestrator-plugin/releases)
[![Maintained](https://img.shields.io/badge/Maintained-yes-brightgreen)](https://github.com/GenorTG/genor-orchestrator-plugin)

**Production-grade OpenClaw plugin for AI project orchestration.** Model routing, automated session logging, project context injection, architecture decision records, and background maintenance — all through plugin tools and lifecycle hooks.

Works alongside the [Genor's Orchestration Skill](https://github.com/GenorTG/genor-orchestrator-skill) which provides the coding workflow reference, dashboard web UI, and supporting scripts.

---

## Features

### 🧰 12 Plugin Tools

| Tool | Purpose |
|------|---------|
| `orchestrator_set_context` | **MANDATORY** — Declare project + task, returns full context document with location, file tree, open tasks, ADRs, and recent sessions |
| `orchestrator_clear_context` | Clear active project context, disable automation hooks |
| `orchestrator_get_status` | Quick overview — model counts, session statistics, active project |
| `orchestrator_get_models` | List models with filters by status, provider, search, or project routing |
| `orchestrator_check_models` | Inspect which models are eligible for a project through the routing filter chain |
| `orchestrator_auto_populate` | Auto-populate model inventory from OpenClaw gateway configuration |
| `orchestrator_log_session` | Log a completed session (automatic via hooks; use manually for retroactive entries) |
| `orchestrator_log_decision` | Create an auto-numbered Architecture Decision Record (ADR) |
| `orchestrator_get_logs` | Query structured JSONL logs with level, source, and time filters |
| `orchestrator_sync_project` | Sync a project from disk into orchestrator-data — generates CONTEXT.md, KEY_FILES.md |
| `orchestrator_get_project_docs` | List all orchestrator-managed documents for a project |
| `orchestrator_get_config` | Read the current routing configuration |

### ⚡ 8 Lifecycle Hooks (Zero Configuration)

| Hook | Automates |
|------|-----------|
| `session_start` | Track start time, reset sub-agent depth counter |
| `session_end` | **Auto-log session** to session_log.md, per-project sessions.json, detail files, and regenerate recovery doc |
| `subagent_spawned` | Increment sub-agent tree depth counter |
| `subagent_ended` | Decrement sub-agent tree depth counter |
| `before_model_resolve` | **Enforce project routing rules** — applies free-only, disabled, and allowlist filters |
| `before_prompt_build` | **Inject project context** — open tasks, location, recent sessions prepended to every prompt |
| `agent_end` | Observe session state for quality tracking |
| `gateway_stop` | Clean up maintenance timers on graceful shutdown |

### 🔧 Background Maintenance

- Session JSON normalization (handles legacy Python dashboard schema drift)
- Recovery document generation per project (self-contained restart point)
- JSONL log auto-rotation (configurable retention, default 30 days)
- Project sync from configured disk locations (CONTEXT.md, KEY_FILES.md, PROJECT_SUMMARY.md)

### 📂 Survives Wipes

All data stored on the filesystem at `orchestrator-data/` — not in OpenClaw session storage. Survives full OpenClaw data loss.

---

## Quick Start

### Prerequisites

- OpenClaw `>= 2026.5.17`
- Python 3 for the dashboard sidecar (optional)

### Installation

```bash
# From ClawHub (recommended)
openclaw plugins install genor-orchestrator-plugin

# Or from source
git clone https://github.com/GenorTG/genor-orchestrator-plugin.git
cd genor-orchestrator-plugin
npm install
npm run build
openclaw plugins install --force .
```

Enable and restart the gateway:

```bash
openclaw plugins enable genor-orchestrator-plugin
# Restart OpenClaw gateway to load the plugin
```

### Usage

```typescript
// Step 1: Set project context (one call per session)
orchestrator_set_context(project="my-project", task="fix-bug")

// Step 2: Work normally — hooks handle:
//   - Session auto-logging on completion
//   - Model routing (project allowlists enforced)
//   - Context injection into every prompt
//   - Recovery doc generation
```

### Optional: Dashboard Web UI

The orchestration dashboard is a separate PM2-managed Python server (part of the [skill companion](https://github.com/GenorTG/genor-orchestrator-skill)):

```bash
pm2 start dashboard/server.py --name orchestration-dashboard --interpreter python3 -- 8766
```

Open [http://localhost:8766](http://localhost:8766) to manage models, routing, and sessions.

---

## Configuration

Configured via OpenClaw's `openclaw.json` under the plugin's config section:

```json
{
  "plugins": {
    "genor-orchestrator": {
      "orchestratorDataDir": "/path/to/orchestrator-data",
      "logLevel": "info",
      "logRetentionDays": 30,
      "maintenanceIntervalMs": 1800000
    }
  }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `orchestratorDataDir` | `string` | `workspace/orchestrator-data/` | Override data directory path |
| `logLevel` | `"debug" | "info" | "warn" | "error"` |
| `logRetentionDays` | `number` | `30` | Days to retain JSONL log entries |
| `maintenanceIntervalMs` | `number` | `1800000` | Background maintenance interval (30 min) |

---

## Data Layout

```
orchestrator-data/
├── models.json               — Model inventory (auto-populated + curated)
├── dashboard-config.json     — Routing configuration
├── session_log.md            — Flat session history table
├── logs/orchestrator.jsonl   — Structured JSONL logs (auto-rotated)
├── adrs/                     — Architecture Decision Records (auto-numbered)
│   ├── 0001-use-postgres.md
│   └── ...
├── sessions/                 — Detailed session markdown files
│   └── YYYY-MM-DD-HHMM-<project>-<task>.md
└── projects/                 — Per-project data (survives wipes)
    └── <name>/
        ├── CONTEXT.md        — Auto-generated from project source
        ├── KEY_FILES.md      — File tree index
        ├── RECOVERY.md       — Self-contained restart document
        ├── BACKLOG.json      — Structured task backlog
        ├── sessions.json     — Per-project session history
        └── ...
```

---

## Model Routing

The plugin implements a layered routing filter chain that enforces safe model selection:

```
1. Global free-only mode → removes all paid models
2. Global disabled list   → removes explicitly blocked models
3. Project allowlist      → restricts to whitelisted models only
4. Project free-only      → removes paid models from allowlist
```

This chain is applied automatically in the `before_model_resolve` hook. Manual inspection via `orchestrator_check_models(project="name")`.

---

## Architecture

```
┌─────────────────────────────────────┐
│         Genor's Orchestrator        │
│                                     │
│  ┌─────────────────────────────┐   │
│  │  Plugin (this repo)         │   │
│  │  ├── 12 tools              │   │
│  │  └── 8 hooks               │   │
│  │      (runs in OpenClaw)     │   │
│  └─────────────────────────────┘   │
│                                     │
│  ┌─────────────────────────────┐   │
│  │  Skill (companion repo)     │   │
│  │  ├── dashboard web UI      │   │
│  │  ├── coding workflow docs  │   │
│  │  └── supporting scripts    │   │
│  │      (PM2 sidecar + files)  │   │
│  └─────────────────────────────┘   │
└─────────────────────────────────────┘
```

The **plugin** provides the runtime backbone (tools + hooks). The [**skill**](https://github.com/GenorTG/genor-orchestrator-skill) provides the documentation, dashboard, and scripts. Both are required for the full experience.

---

## Development

```bash
git clone https://github.com/GenorTG/genor-orchestrator-plugin.git
cd genor-orchestrator-plugin
npm install

# Build
npm run build

# Validate with Plugin Inspector
clawhub package validate .

# Test locally
openclaw plugins install --force .
openclaw plugins enable genor-orchestrator-plugin
```

### Project Structure

```
genor-orchestrator-plugin/
├── src/
│   ├── index.ts              — Plugin entry and all tool/hook implementations
│   └── index.test.ts         — Test scaffold
├── dist/                     — Compiled output
├── openclaw.plugin.json      — Plugin manifest
├── package.json              — Dependencies and build config
├── tsconfig.json             — TypeScript configuration
└── LICENSE                   — MIT-0
```

---

## Related

- [Genor's Orchestration Skill](https://github.com/GenorTG/genor-orchestrator-skill) — Dashboard web UI, coding workflow, scripts companion
- [OpenClaw Plugins Documentation](https://docs.openclaw.ai/plugins) — Official plugin development guide
- [ClawHub Registry](https://clawhub.com) — Browse and publish OpenClaw skills and plugins

---

## License

MIT-0 — Free to use, modify, and redistribute. No attribution required.
