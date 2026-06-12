# Genor's Orchestrator — OpenClaw Plugin

[![ClawHub](https://img.shields.io/badge/ClawHub-genor--orchestrator--plugin-blue)](https://clawhub.com/packages/genor-orchestrator-plugin)
[![License: MIT-0](https://img.shields.io/badge/License-MIT--0-brightgreen)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/GenorTG/genor-orchestrator-plugin)](https://github.com/GenorTG/genor-orchestrator-plugin/releases)

**12 tools + 8 lifecycle hooks for AI project orchestration in OpenClaw.** Model routing, automated session logging, project context injection, ADR tracking, and background maintenance — all inside OpenClaw with no separate process.

---

## Installation for AI Agents

> **Copy-paste to any AI agent:** *"Install Genor's Orchestrator from https://github.com/GenorTG/genor-orchestrator-plugin.git"*

The agent should:
1. `git clone --recurse-submodules` the repo
2. Read `SETUP.md`
3. Execute the 7-step procedure

That's it. The plugin auto-creates data dirs, schedules nightly model sync, and runs maintenance on a timer. The PM2 dashboard starts separately.

---

## What you get

**12 tools** — set_context, clear_context, get_status, get_config, get_models, check_models, auto_populate, log_session, log_decision, get_logs, sync_project, get_project_docs

**8 hooks** — session_start/end, subagent_spawned/ended, before_model_resolve, before_prompt_build, agent_end, gateway_stop

**Dashboard** — PM2 sidecar on port 8766: model CRUD, routing config, session viewer

**Auto-maintenance** — nightly model sync, log rotation, recovery doc generation, session normalization

**Data survives wipes** — all on filesystem at orchestrator-data/

---

## Quick reference

```typescript
orchestrator_set_context(project="my-project", task="fix-bug")   // start a session
orchestrator_log_decision(project, title, context, decision)    // log an ADR
orchestrator_get_status()                                       // overview
orchestrator_check_models(project="my-project")                 // check routing
```

Dashboard: http://localhost:8766

---

## Companion

[Genor's Orchestration Skill](https://github.com/GenorTG/genor-orchestrator-skill) — dashboard web UI, coding workflow docs, and operational scripts. Installed automatically when you `clawhub install ./skill/` during setup.

---

## License

MIT-0 — Free to use, modify, redistribute. No attribution required.
