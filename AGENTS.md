# 📋 AGENTS.md — Genor's Orchestrator Plugin

## 🧠 What It Does
A full-featured OpenClaw plugin that turns your gateway into a coordinated agent workspace. **40 tools** for model routing, session tracking, project context injection, a live dashboard (9 tabs), subagent management, backlog management, QA workflow, test infrastructure, and automated project health — all without a separate process.

---

## 📁 Key Files

| File | What It Does |
|------|-------------|
| `src/index.ts` | 🧩 Main plugin — 40 tools, 8 hooks (via `api.on`), SessionTracker, MaintenanceService |
| `src/dashboard-handler.ts` | 🖥️ HTTP handler serving the dashboard at `/orchestrator` |
| `src/shared.ts` | 🔧 Shared types, utilities, constants |
| `src/index.test.ts` | 🧪 Test suite (3 tests) |
| `dashboard/index.html` | 🎨 Single-file SPA frontend (1428 lines, Tailwind, zero build) |
| `openclaw.plugin.json` | 📄 Plugin manifest |

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
| **Version** | 0.8.0 |
| **Tools** | 40 tools (0 slash commands — all migrated to proper tools) |
| **Hooks** | 8 lifecycle hooks |
| **Models tracked** | 24 total, 11 agent-ready |
| **Providers** | google, lmstudio, ollama, opencode-go, openrouter |
| **Projects** | 2 active |
| **Data dir** | `~/.openclaw/workspace/orchestrator-data/` |
| **Dashboard** | 1428-line SPA with left sidebar nav (9 tabs) |
| **Plugin location** | `~/.openclaw/extensions/genor-orchestrator/` (native extension) |

---

## 🔬 v0.8.0 Features

1. **🖥️ Dashboard Redesign** — 1428-line single-file SPA with 9-tab left sidebar nav. StateManager reactive state, lazy rendering, toast notifications, accessible ARIA roles. Replaced old top-tab-bar layout.
2. **📋 Sessions Tab** — Per-project session tree with parent-child hierarchy, clickable detail pane, spawn sub-agent modal. Replaces old Chat Console (SSE/chat functionality removed — that's OpenClaw WebUI's job).
3. **✅ QA Workflow** — 3 new tools: `qa_submit` (spawns independent QA review subagent), `qa_approve` (unblocks work→log transition), `qa_reject` (returns to work phase).
4. **🤝 Handoff** — `generate_handoff` creates compact recovery docs for agent switching.
5. **🔥 Deep-Dive** — `grill_with_docs` spawns subagent that quizzes you on project docs.
6. **🧹 Doc Tools** — `fix_docs_drift` (stale version/tool counts), `regenerate_state` (from event log), `cleanup_docs` (spawns subagent to fix links/gaps).
7. **🧪 Test Infrastructure** — `setup_unit_tests`, `setup_e2e_tests`, `debug_issue`, `create_functionality` — spawn subagents for targeted work.
8. **🏭 PM2 Removed** — No PM2 bridge. Plugin runs as native OpenClaw extension.

## 🔬 v0.7.0 Features

1. **🧠 Routing Presets** — 5 presets: Custom Chains, No Steering, Free Only, Single Provider, Custom Fallbacks Only. Dashboard preset selector with live descriptions.
2. **📋 Backlog Tools** — 6 tools: `backlog_add`, `backlog_list`, `backlog_update`, `backlog_dispatch`, `backlog_dispatch_all`, `create_project`. Full project backlog management.
3. **🔗 Routing Chains** — Per-task-type model preference lists with fallback chain. Dashboard-editable, persisted to config.
4. **🧠 Enhanced Routing Brain** — `get_routing` returns model quality metadata (tier, speed, context). Task category auto-inferred. Blocked chain detection. Preset-aware hook resolution.
5. **🖥️ Agent Cards** — Stop and Recover buttons on agent cards in home tab.
6. **🛡️ Safeguards Tab** — Dashboard safeguards viewer with config, event log, and agent health.

## 🔬 v0.6.0 Features

1. **🔒 Session-Project Binding** — One session locks to one project. `release_project` to unbind before switching.
2. **🚫 Hook Scoping** — Unregistered sessions = invisible. No live-agents bleed, no context injection, no routing noise.
3. **🧹 Orphaned Project Cleanup** — Doctor detects empty projects, auto-archives to `.archived/`. No clutter.
4. **🔍 Active Project Discovery** — `list_active_projects` + `join_project` for ad-hoc session contributions.
5. **📋 Project Health Enforcement** — STATE.md required. Doctor reports gaps, auto-creates, flags stale sessions.
6. **🤖 Subagent Spawning** — `spawn_subagent` routes models, injects context, auto-logs under parent project.
