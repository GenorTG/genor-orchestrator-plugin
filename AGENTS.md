# 📋 AGENTS.md — Genor's Orchestrator Plugin

## 🧠 What It Does
A full-featured OpenClaw plugin that turns your gateway into a coordinated agent workspace. **22 tools** for model routing, session tracking, project context injection, a live dashboard, subagent management, and automated project health — all without a separate process.

---

## 📁 Key Files

| File | What It Does |
|------|-------------|
| `src/index.ts` | 🧩 Main plugin — 22 tools, 5 slash commands, 8 hooks, SessionTracker, MaintenanceService |
| `src/dashboard-handler.ts` | 🖥️ HTTP handler serving the dashboard at `/orchestrator` |
| `src/index.test.ts` | 🧪 Test suite |
| `dashboard/index.html` | 🎨 Single-file SPA frontend (Tailwind, zero build) |
| `openclaw.plugin.json` | 📄 Plugin manifest |
| `scripts/auto-populate-models.py` | 🤖 Nightly model discovery script |

---

## 🔨 Build & Test

```bash
npm install              # Install deps
npm run build            # tsc -p tsconfig.json → dist/
npm test                 # npx vitest run

# Deploy
openclaw plugins install --force .
openclaw plugins enable genor-orchestrator
# Then restart gateway (requires approval!)
```

> **⚠️ HARD RULE:** Never restart the OpenClaw gateway without explicit approval from Master Genor.

---

## 📊 Current State

| Metric | Value |
|--------|-------|
| **Version** | 0.6.1 |
| **Tools** | 22 tools + 5 slash commands |
| **Hooks** | 8 lifecycle hooks |
| **Models tracked** | 24 total, 11 agent-ready |
| **Providers** | google, lmstudio, ollama, opencode-go, openrouter |
| **Projects** | 1 active (genor-orchestrator-plugin) |
| **Data dir** | `~/.openclaw/workspace/orchestrator-data/` |

---

## 🔬 v0.6.0 Features

1. **🔒 Session-Project Binding** — One session locks to one project. `release_project` to unbind before switching.
2. **🚫 Hook Scoping** — Unregistered sessions = invisible. No live-agents bleed, no context injection, no routing noise.
3. **🧹 Orphaned Project Cleanup** — Doctor detects empty projects, auto-archives to `.archived/`. No clutter.
4. **🔍 Active Project Discovery** — `list_active_projects` + `join_project` for ad-hoc session contributions.
5. **📋 Project Health Enforcement** — STATE.md required. Doctor reports gaps, auto-creates, flags stale sessions.
6. **🤖 Subagent Spawning** — `spawn_subagent` routes models, injects context, auto-logs under parent project.

---

## 🏗️ Architecture

```
OpenClaw Gateway
  ├── /orchestrator (dashboard route)
  │
  ├── Plugin Hooks (8)
  │   ├── session_start        → Track begin, bypass background sessions
  │   ├── session_end          → Auto-log, recovery doc, binding release
  │   ├── subagent_spawned     → Register subagent with parent context
  │   ├── subagent_ended       → Cleanup tracking
  │   ├── before_model_resolve → Auto-route best model per project
  │   ├── before_prompt_build  → Inject project context into prompt
  │   ├── agent_end            → Final live-agent flush
  │   └── gateway_stop         → Clean shutdown
  │
  ├── Tools (22)
  │   ├── Core: register, unregister, set_context, clear_context
  │   ├── Status: get_status, get_config, get_models, check_models
  │   ├── Logging: log_session, log_decision, get_logs
  │   ├── Projects: sync_project, get_project_docs, advance_phase
  │   ├── Routing: get_routing, get_registered_sessions
  │   ├── New v0.6.0: release_project, list_active_projects, join_project, spawn_subagent
  │   └── Health: doctor, auto_populate
  │
  └── Data: ~/.openclaw/workspace/orchestrator-data/
      ├── models.json, dashboard-config.json, live-agents.json
      ├── logs/orchestrator.jsonl
      └── projects/{name}/{STATE.md, CONTEXT.md, sessions.json, ...}
```

---

## 🔗 Related

- Project repo: `https://github.com/GenorTG/genor-orchestrator-plugin`
- Workspace skill: `~/.openclaw/workspace/skills/genor-orchestrator/SKILL.md`
- Daily logs: `~/.openclaw/workspace/memory/2026-06-17.md`
