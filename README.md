# Genor's Orchestrator — OpenClaw Plugin

[![ClawHub](https://img.shields.io/badge/ClawHub-genor--orchestrator--plugin-blue)](https://clawhub.com/packages/genor-orchestrator-plugin)
[![License: MIT-0](https://img.shields.io/badge/License-MIT--0-brightgreen)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/GenorTG/genor-orchestrator-plugin)](https://github.com/GenorTG/genor-orchestrator-plugin/releases)

**12 tools + 8 lifecycle hooks for AI project orchestration in OpenClaw.** Model routing, automated session logging, project context injection, architecture decision records, and background maintenance — all running inside OpenClaw with no separate process.

Companion skill package provides a dashboard web UI (PM2 sidecar, port 8766), a structured coding workflow, and operational scripts.

---

## Quick Install

> **If you're an AI agent:** Clone this repo, read `SETUP.md`, and execute every step. The file contains the complete install procedure.
>
> **If you're a human:** Give your AI agent this URL and say: **"Install and set up Genor's Orchestrator."**

```bash
# Full setup in one command (agent-friendly):
git clone --recurse-submodules https://github.com/GenorTG/genor-orchestrator-plugin.git
cd genor-orchestrator-plugin
# Follow the steps in SETUP.md
```

> **Already on ClawHub?** `openclaw plugins install genor-orchestrator-plugin` — but you'll also need the companion skill repo for the dashboard and scripts.

---

## What You Get

| When you need to... | You use... |
|---------------------|-----------|
| Start a project session | `orchestrator_set_context(project="my-project", task="fix-bug")` |
| Check routing before spawning | `orchestrator_check_models(project="my-project")` |
| Record a design decision | `orchestrator_log_decision(project, title, context, decision)` |
| Sync project files to orchestrator | `orchestrator_sync_project(project="my-project")` |
| View everything at a glance | `http://localhost:8766` (dashboard) |
| Edit model tiers or routing | Dashboard → Models / Config tabs |
| Populate models from OpenClaw config | `orchestrator_auto_populate` |
| Query orchestration history | `orchestrator_get_logs` |

The hooks automate everything else: session auto-logging, model routing enforcement, project context injection, background data maintenance.

**Data on filesystem survives OpenClaw session wipes.** Full manual at [SETUP.md](./SETUP.md).

---

## One-Line Agent Instruction

> **"Install and set up Genor's Orchestrator. The repo is at https://github.com/GenorTG/genor-orchestrator-plugin.git. Clone with --recurse-submodules, read SETUP.md, follow every step, and verify everything works."**

---

## License

MIT-0 — Free to use, modify, redistribute. No attribution required.
