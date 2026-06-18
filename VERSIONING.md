# Versioning — Genor's Orchestrator Plugin

**Current: 0.8.0**

## Scheme

We follow a simplified semver: `MAJOR.MINOR.PATCH`

| Part | What changes it | Example |
|------|----------------|---------|
| **MAJOR** | Rare. Complete rewrite or breaking API changes. | `0.x.x` → `1.0.0` |
| **MINOR** | Feature release. New tools, new hooks, major architecture changes. | `0.7.x` → `0.8.0` |
| **PATCH** | Bug fixes, doc updates, process/infra changes, small tweaks, daily dev commits. Auto-incremented by `/genor-git-commit`. | `0.8.0` → `0.8.1` |

## History

| Version | Date | What |
|---------|------|------|
| **0.8.0** | 2026-06-18 | Dashboard complete redesign (3506→1428 lines, left sidebar nav, 9 tabs). New Sessions tab with per-project session tree & spawn sub-agent modal. 40 tools (+12 new: QA trilogy, Handoff, Deep-dive, Doc tools, Test infra, Debug, Feature creation). StateManager reactive state, lazy rendering, toast notifications, accessible ARIA roles. PM2 removed entirely. Bug fixes. |
| **0.7.0** | 2026-06-17 | Routing presets system (custom, no-steering, free-only, single-provider, custom-fallbacks-only), 28 tools (+6 backlog tools), set-project-routing API, enhanced routing brain with model quality metadata, preset selector UI, task category inference in hooks |
| **0.6.1** | 2026-06-17 | GitFlow branching (dev/main), GitHub Actions CI pipeline, VERSIONING.md, version normalization, branch protection |
| **0.6.0** | 2026-06-17 | 22 tools, session-project binding, hook scoping, orphaned project cleanup, active project discovery + joining, subagent spawning, dashboard migration |
| 0.5.29 | 2026-06-17 | Pre-0.6.0 dev builds (22 builds from 0.5.0) |
| 0.5.0 | 2026-06-14 | Slash commands restructured, `/genor-git-commit` added |
| 0.4.x | 2026-06-13 | Session key fixes, live agent tracking, SDK compat |
| 0.3.x | 2026-06-12 | Initial plugin + dashboard |

## Rules

1. **PATCH bumps are automatic.** The `/genor-git-commit` command increments PATCH on every commit.
2. **MINOR bumps are manual.** When a feature milestone is reached (like adding 10+ new tools), bump MINOR and reset PATCH to 0.
3. **MAJOR bumps are rare.** Breaking API changes only.
4. **All docs must agree.** The version in `README.md`, `AGENTS.md`, `STATE.md`, `CONTEXT.md`, `ROADMAP.md` should always match `package.json`.
