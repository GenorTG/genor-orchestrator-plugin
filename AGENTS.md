# 📋 AGENTS.md — Genor's Orchestrator Plugin

## 🧠 What It Does
A full-featured OpenClaw plugin that turns your gateway into a coordinated agent workspace. **28 tools** for model routing, session tracking, project context injection, a live dashboard, subagent management, backlog management, and automated project health — all without a separate process.

---

## 📁 Key Files

| File | What It Does |
|------|-------------|
| `src/index.ts` | 🧩 Main plugin — 28 tools, 5 slash commands, 8 hooks, SessionTracker, MaintenanceService |
| `src/dashboard-handler.ts` | 🖥️ HTTP handler serving the dashboard at `/orchestrator` |
| `src/index.test.ts` | 🧪 Test suite (116 tests) |
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
| **Version** | 0.7.0 |
| **Tools** | 28 tools + 5 slash commands |
| **Hooks** | 8 lifecycle hooks |
| **Models tracked** | 24 total, 11 agent-ready |
| **Providers** | google, lmstudio, ollama, opencode-go, openrouter |
| **Projects** | 2 active |
| **Data dir** | `~/.openclaw/workspace/orchestrator-data/` |

---

## 🔬 v0.7.0 Features

1. **🧠 Routing Presets** — 5 presets: Custom Chains, No Steering, Free Only, Single Provider, Custom Fallbacks Only. Dashboard preset selector with live descriptions.
2. **📋 Backlog Tools** — 6 new tools: `backlog_add`, `backlog_list`, `backlog_update`, `backlog_dispatch`, `backlog_dispatch_all`, `create_project`. Full project backlog management.
3. **🔗 Routing Chains** — Per-task-type model preference lists with fallback chain. Dashboard-editable, persisted to config.
4. **🧠 Enhanced Routing Brain** — `get_routing` returns model quality metadata (tier, speed, context). Task category auto-inferred. Blocked chain detection. Preset-aware hook resolution.
5. **🖥️ Agent Cards** — Stop and Recover buttons on agent cards in home tab.
6. **🛡️ Safeguards Tab** — Dashboard safeguards viewer with config, event log, and agent health.

---

## 🔬 v0.6.0 Features

1. **🔒 Session-Project Binding** — One session locks to one project. `release_project` to unbind before switching.
2. **🚫 Hook Scoping** — Unregistered sessions = invisible. No live-agents bleed, no context injection, no routing noise.
3. **🧹 Orphaned Project Cleanup** — Doctor detects empty projects, auto-archives to `.archived/`. No clutter.
4. **🔍 Active Project Discovery** — `list_active_projects` + `join_project` for ad-hoc session contributions.
5. **📋 Project Health Enforcement** — STATE.md required. Doctor reports gaps, auto-creates, flags stale sessions.
6. **🤖 Subagent Spawning** — `spawn_subagent` routes models, injects context, auto-logs under parent project.
