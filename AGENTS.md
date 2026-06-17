# AGENTS.md — Genor's Orchestrator Plugin

## What It Does
A full-featured OpenClaw plugin for project-aware AI agent orchestration. Provides model routing, session tracking, project context injection, a live dashboard, and subagent management — turning OpenClaw into a coordinated agent workspace.

## Key Files
| File | Purpose |
|------|---------|
| `src/index.ts` | Main plugin entry — all 21 tools, 5 slash commands, hooks, cron, SessionTracker |
| `src/dashboard-handler.ts` | HTTP handler serving the dashboard at the `/orchestrator` gateway route |
| `dashboard/index.html` | Single-file SPA frontend (Tailwind CSS, no build step) |
| `openclaw.plugin.json` | Plugin manifest |

## Build & Test
```bash
npm install
npm run build            # tsc -p tsconfig.json
npm test                 # npx vitest run
```

## Deployment
```bash
openclaw plugins install --force .
openclaw plugins enable genor-orchestrator
openclaw gateway restart
```

> **HARD RULE:** Never restart the OpenClaw gateway without explicit approval from Master Genor.

## Version
Current: **0.5.29** (package.json)

## Tool & Command Count
- **21 tools** — model inventory management, project routing, session registration, context injection, doctor/health checks, log queries, subagent spawning
- **5 slash commands** — `genor`, `genor-dashboard`, `genor-status`, `genor-help`, `genor-git-commit`

## Data Directory
`~/.openclaw/workspace/orchestrator-data/`

Contains: `models.json`, `state.json`, `session_log.md`, `config.json`, `live-agents.json`, `projects/*/` (per-project STATE.md, CONTEXT.md, sessions.json, ROADMAP.md, RECOVERY.md, ADRs), `logs/` (orchestrator.jsonl), `.archived/` (orphaned project dirs).

## New Features (0.5.29)
1. **Session-Project Binding** 🔒 — Sessions lock to one project; `orchestrator_release_project` unbinds before switching.
2. **Orphaned Project Prevention** 🧹 — Doctor auto-detects and archives empty/unused project dirs.
3. **Active Project Discovery** 🔍 — `orchestrator_list_active_projects` + `orchestrator_join_project` for ad-hoc session joining.
4. **Plugin Scoping** 🚫 — Invisible to unregistered sessions; all hooks skip non-registered sessions.
5. **Project Documentation Enforcement** 📋 — Doctor checks/auto-creates required STATE.md docs.
6. **Subagent Spawning Tool** 🤖 — `orchestrator_spawn_subagent` with model routing recommendations.

## Architecture Notes
- **No Python sidecar** — the dashboard was migrated from a Python PM2 server (port 8766/8767) to a native OpenClaw HTTP route.
- **Router:** OpenClaw's `registerHttpRoute()` at `/orchestrator` — serves static dashboard and REST API endpoints (status, models, config, sessions, projects, logs, agents).
- **SSE:** Real-time dashboard updates via Server-Sent Events at `/orchestrator/api/activity/stream`.
- **Hooks:** 8 gateway hooks (`session_start`, `session_end`, `subagent_spawned`, `subagent_ended`, `before_model_resolve`, `before_prompt_build`, `agent_end`, `gateway_stop`).
- **Cron:** Nightly model auto-populate at 3 AM; maintenance tick every 30 min.
- **Models JSONL:** All routing/activity logged to `orchestrator-data/logs/orchestrator.jsonl`.
- **TypeScript SDK:** Built on `openclaw/plugin-sdk` using `definePluginEntry`.
