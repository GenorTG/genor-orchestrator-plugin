# Genor's Orchestrator — OpenClaw Plugin

[![ClawHub](https://img.shields.io/badge/ClawHub-genor--orchestrator--plugin-blue)](https://clawhub.com/packages/genor-orchestrator-plugin)
[![License: MIT-0](https://img.shields.io/badge/License-MIT--0-brightgreen)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/GenorTG/genor-orchestrator-plugin)](https://github.com/GenorTG/genor-orchestrator-plugin/releases)

> **⚠️ Alpha Software** — This plugin is actively vibing its way to full functionality. It works, it's stable, and we use it daily, but edges are still being kissed. Expect steady improvements, not chaos.

**12 tools + 8 lifecycle hooks for AI project orchestration in OpenClaw.** Model routing, automated session logging, project context injection, real-time live agent tracking, ADR tracking, and background maintenance — all inside OpenClaw with no separate process.

---

## Installation for AI Agents

> **Copy-paste to any AI agent:** *"Install Genor's Orchestrator from https://github.com/GenorTG/genor-orchestrator-plugin.git"*

The agent should:
1. `git clone --recurse-submodules` the repo
2. Read `SETUP.md`
3. Execute the 7-step procedure

That's it. The plugin auto-creates data dirs, schedules nightly model sync, and runs maintenance on a timer. The PM2 dashboard starts separately.

### Via ClawHub

```bash
clawhub package install genor-orchestrator-plugin
```

---

## What you get

**12 tools** — `set_context`, `clear_context`, `get_status`, `get_config`, `get_models`, `check_models`, `auto_populate`, `log_session`, `log_decision`, `get_logs`, `sync_project`, `get_project_docs`

**8 hooks** — `session_start`, `session_end`, `subagent_spawned`, `subagent_ended`, `before_model_resolve`, `before_prompt_build`, `agent_end`, `gateway_stop`

**Live agent tracking** — Real-time agent state written to `live-agents.json` on every hook event, consumed by dashboard SSE for live monitoring

**Session key filtering** — The plugin filters out background/dreaming/cron/subagent sessions from session tracking, ensuring auto-logged session entries always carry the correct interactive session key

**Dashboard** — PM2 sidecar on port 8766: model CRUD, routing config, session viewer, live agent tree

**Auto-maintenance** — nightly model sync, log rotation, recovery doc generation, session normalization

**Data survives wipes** — all on filesystem at `orchestrator-data/`

---

## Quick reference

```typescript
orchestrator_set_context(project="my-project", task="fix-bug")   // start a session
orchestrator_log_decision(project, title, context, decision)    // log an ADR
orchestrator_get_status()                                        // overview
orchestrator_check_models(project="my-project")                  // check routing
```

Dashboard: `http://localhost:8766`

---

## Alpha Details

This is **v0.4.3** — we're iterating fast:

| Version | Highlights |
|---------|-----------|
| v0.4.3 | ToolPluginMetadata compat (OpenClaw 2026.6.6), live agent tracking, function name cleanup, double-cron fix, dead code removal |
| v0.4.2 | SessionTracker with live agents file, error logging to `/tmp/live-agents-errors.log` |
| v0.4.1 | 12 tools verified working, `plugins.load.paths` fix, gateway restart, dashboard v4 SSE |
| v0.4.0 | Phase 1 complete: tool audit, 9 bugs fixed |
| v0.3.x | Initial dashboard, server refactors |

**Current state:** All 12 tools operational. Hooks running. Live agent SSE streaming. Dashboard with 7 tabs. Production-safe for daily use.

---

## Companion

[Genor's Orchestration Skill](https://github.com/GenorTG/genor-orchestrator-skill) — dashboard web UI, coding workflow docs, and operational scripts. Installed via:

```bash
clawhub install genor-orchestrator
```

---

## License

MIT-0 — Free to use, modify, redistribute. No attribution required.
