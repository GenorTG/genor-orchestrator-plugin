# Versioning — Genor's Orchestrator Plugin

**Current: 0.6.0**

## Scheme

We follow a simplified semver: `MAJOR.MINOR.PATCH`

| Part | What changes it | Example |
|------|----------------|---------|
| **MAJOR** | Rare. Complete rewrite or breaking API changes. | `0.x.x` → `1.0.0` |
| **MINOR** | Feature release. New tools, new hooks, major architecture changes. | `0.5.x` → `0.6.0` |
| **PATCH** | Bug fixes, doc updates, small tweaks, daily dev commits. Auto-incremented by `/genor-git-commit`. | `0.6.0` → `0.6.1` |

## History

| Version | Date | What |
|---------|------|------|
| **0.6.0** | 2026-06-17 | 22 tools, session-project binding, hook scoping, orphaned project cleanup, active project discovery + joining, project health enforcement, subagent spawning, dashboard migration |
| 0.5.29 | 2026-06-17 | Pre-0.6.0 dev builds (22 builds from 0.5.0) |
| 0.5.0 | 2026-06-14 | Slash commands restructured, `/genor-git-commit` added |
| 0.4.x | 2026-06-13 | Session key fixes, live agent tracking, SDK compat |
| 0.3.x | 2026-06-12 | Initial plugin + dashboard |

## Rules

1. **PATCH bumps are automatic.** The `/genor-git-commit` slash command increments PATCH on every commit.
2. **MINOR bumps are manual.** When a feature milestone is reached (like adding 10 new tools), bump MINOR and reset PATCH to 0.
3. **MAJOR bumps are rare.** Breaking API changes only.
4. **All docs must agree.** The version in `README.md`, `AGENTS.md`, `STATE.md`, and `ROADMAP.md` should always match `package.json`.
