# 📜 Changelog

All notable changes to **Genor's Orchestrator Plugin** are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.0-alpha] — 2026-06-26

### Added
- **PM jako wymagany pracownik** — PM (Project Manager) is now a required worker role
- **PM avatar to chat messages** — bubble UI shows PM avatar in messages
- **CI improvements** — removed openclaw plugins validate (not available in CI), trigger tests on main pushes

### Fixed
- **Unregistered tools removed from manifest** — CI build now passes
- **Version mismatch** — synced openclaw.plugin.json and README.md badge to match package.json (1.1.0-alpha)

## [1.0.0-alpha] — 2026-06-24

### Added
- **Software House Merger** — full integration of worker system with V4 database schema
- **Dashboard redesign** — 1428-line SPA with 9 tabs and left sidebar navigation
- **QA Workflow** — 3 tools for quality assurance (submit, approve, reject)
- **Handoff system** — generate recovery documents for session continuity
- **Deep-dive analysis** — project documentation analysis tools
- **Doc maintenance tools** — auto-clean and organize project documentation
- **Test infrastructure** — 4 tools for unit and E2E test creation

### Changed
- **Migrated to SQLite** — replaced flat JSON files with orchestrator.db
- **Project model routing** — per-project allowlist and category-based routing chains
- **Free-only routing preset** — automatic fallback to free models

### Removed
- **PM2 bridge** — no longer needed for process management

## [Unreleased]

### Fixed
- **Version mismatch** — synced `openclaw.plugin.json` and `README.md` badge to match `package.json` (0.9.3)
- **Tool count badge** — corrected from 47 to 43 (actual count from `_staticToolNames`)
- **Dead tier/speed_rating references** — removed all references to deleted fields from `ModelEntry` interface, `genorch_models_list`, `genorch_models_check_routing`, and routing preset fallbacks
- **Dead cron scheduling code** — removed nightly cron installer (boot-time sync supersedes it)
- **Invalid `test_cat` routing category** — removed leftover from `dashboard-config.json` (valid categories: `coding`, `fixing`, `research`, `qa`, `documentation`, `test`)

## [0.9.3] — 2026-06-23

### Added
- **Project Document Structure (decision tree)** — six new files auto-created per project: `PROJECT_PLAN.md`, `FEATURES.md`, `BUGS.md`, `CHANGELOG.md`, `STYLE_GUIDE.md`, `ARCHITECTURE.md`. Backed by templates in `scripts/project-templates/`. Applied to existing `genor-orchestrator-plugin` project.
- **Project docs auto-injection (anti-drift)** — `before_prompt_build` hook now reads project docs on every prompt build and prepends them to the context for registered sessions. Sections injected: PROJECT PLAN, CODE & STYLE RULES, ARCHITECTURE & DESIGN DECISIONS, ACTIVE FEATURES, OPEN BUGS. Truncation: 25 lines / 1500 chars per doc.
- **Dashboard Docs tab** — grouped into 📋 Planning → 🐛 Issues → 🏛️ Architecture → ⚙️ Orchestrator
- **New MCP tools for project docs** — `project_plan`, `features`, `bugs`, `changelog`, `style_guide`, `architecture` served via `/api/project-state`

### Changed
- **Model inventory boot-time sync** — auto-populate from gateway config now runs on every boot (not just first-run). Drops models absent from all 4 config sources.
- **Dashboard column resizing** — uses `table-layout: fixed` with explicit widths for reliable resize
- **Dashboard column sorting** — click-to-sort on all table headers with ▲/▼ indicators
- **Routing tab** — displays actual per-category routing, preset, allowlist from `/api/project-state` (no more "coming soon")
- **Agents tab** — human-readable action labels (`building_prompt` → 🧠 Building prompt…), relative time since last activity
- **Vision flags** — strictly from gateway config `input: ["text", "image"]` field. Removed all AI-guessed vision flags.
- **Cost/pricing corrections** — `opencode-go/deepseek-v4-flash` is now `subscription` (not `local_free`); updated context windows and architectures for 8 models based on actual provider data

### Removed
- **`tier` and `speed_rating` fields** — entirely from `models.json` schema, dashboard columns, edit modal, and `genorch_models_list` output. No more subjective opinion ratings.
- **`run-model-discovery.sh`** — superseded by boot-time sync
- **Cron job for nightly model discovery** — `openclaw cron delete` of the `genor-model-discovery` cron (boot sync handles it)
- **TTS rate limit warning** — passive (silent) when generating notifications

### Fixed
- **dashboard-config.json** — clean entry per project (test_cat removed in 0.9.4)
- **Cross-tab stale status** — agents display now shows real-time data
- **Empty project dir handling** — doctor auto-archives empty projects

## [0.9.0] — 2026-06-16

### Added
- **OpenAI endpoint session spawn** — sessions can now be spawned via OpenAI-compatible endpoint
- **Session lifecycle hooks** — `session_end` integration
- **Dashboard for orchestrator state** — column resize, sorting, agents display, routing tab
- **Workboard MCP integration** — full coordination workflow

### Changed
- Migrated to **SQLite** for session and backlog persistence (replaces flat JSON files)
- **Project model routing** — per-project allowlist and category-based routing chains
- **Free-only routing preset** — automatic fallback to free models

## Earlier

### [0.8.x] — 2026-05
- Initial OpenClaw plugin structure
- Basic model inventory and routing
- Sub-agent delegation helpers
- ADR logging

---

[unreleased]: https://github.com/GenorTG/genor-orchestrator-plugin/compare/v0.9.3...HEAD
[0.9.3]: https://github.com/GenorTG/genor-orchestrator-plugin/releases/tag/v0.9.3
[0.9.0]: https://github.com/GenorTG/genor-orchestrator-plugin/releases/tag/v0.9.0
