# ROADMAP — genor-orchestrator-plugin

> **Project-level roadmap.** See `~/.openclaw/workspace/orchestrator-data/projects/genor-orchestrator-plugin/ROADMAP.md` for the canonical version with full detail.

## ✅ v1.1.0-alpha — Current

- **PM Integration** — PM is now a required worker role
- **Avatar Messages** — PM avatar shown in chat bubble UI
- **CI Fixes** — removed openclaw plugins validate, trigger tests on main pushes

## ✅ v1.0.0-alpha — Completed

- **Software House Merger** — full integration with V4 database schema
- **Dashboard redesign** — 1428-line SPA, 9 tabs, left sidebar nav
- **QA Workflow** — 3 tools for quality assurance
- **Handoff system** — generate recovery documents
- **Test infrastructure** — 4 tools for unit and E2E test creation

## ✅ v0.9.0 — Completed

- **OpenAI Endpoint Session Spawn** — Dashboard spawns sessions via direct POST to `/v1/chat/completions` with `x-openclaw-session-key`
- **Queue Approach Removed** — Old `pending-spawns.json` → `before_prompt_build` → `subagent.run()` pipeline deleted
- **Simplified Architecture** — No trusted-operator, self-API, heartbeat, or cron approaches

## ✅ v0.8.0 — Completed

- Dashboard redesign (1428-line SPA, 9 tabs, left sidebar nav)
- QA Workflow (3 tools), Handoff, Deep-dive
- Doc maintenance tools, Test infrastructure (4 tools)
- PM2 bridge removed

## ✅ v0.7.0 — Completed

- 5 routing presets, backlog management (6 tools)
- Enhanced routing brain with model quality metadata
- Safeguards dashboard tab, agent card controls

## ✅ v0.6.0 — Completed

- Core: 22 tools, 8 hooks, model routing, session tracking
- Context injection, dashboard native route, subagent spawning
- ADR management, Doctor diagnostics, Maintenance Service

---

*See orchestrator-data version for upcoming roadmap items.*
