# Autonomous Pipeline Architecture Plan

**Last Updated:** 2026-06-17
**Status:** Phase 1 Complete, Phase 2-5 Documented

## Phase 1 ✅ — Foundation (COMPLETE)
- 1a: Phase enforcement in `before_prompt_build` ✅
- 1b: Backlog management tools ✅
- 1c: Structured error logging ✅
- 1d: Auto-Q&A (inline verification) ✅

## Phase 2 — Pipeline Automation
**Priority: HIGH (p1)**
- **2a: Auto-decomposition** — Backlog tasks auto-decomposed by sub-agent analysis
- **2b: Sub-agent dispatch** — Assign tasks to spawned sub-agents with context
- **2c: Parallel execution + dependency resolution** — Blocked tasks wait for deps
- **2d: Auto PR creation** — Branch/PR after QA passes

## Phase 3 — Dashboard Evolution
**Priority: HIGH (p1)**
- **3a: Active model display** — Show which model per project session in WebUI
- **3b: In-WebUI model assignment** — Model selector dropdown, validation, API endpoint
- **3c: Dashboard backlog widget** — Task list with status badges + priority colors
- **3d: Session timestamps** — Every entry has started_at/updated_at/ended_at

## Phase 4 — Data Integrity
**Priority: HIGH (p1)**
- **4a: Fake session detection** — Validate session entries, flag suspicious, dashboard warning
- **4b: Schema enforcement** — All entries conform to v2 schema, migration path

## Phase 5 — Self-Healing & Monitoring
- **5a: Agent heartbeat** — Detect stuck agents, auto-restart
- **5b: Fallback model routing** — Display fallback chain in dashboard
- **5c: Automated recovery** — RECOVERY.md generation on crash

---

## Implementation Strategy

### High Priority (Now)
1. Phase 3d: Session timestamps — foundational for 4a
2. Phase 4a: Fake session detection — relies on 3d
3. Phase 3a: Active model display in dashboard
4. Phase 3b: In-WebUI model assignment

### Medium Priority (Next)
5. Phase 3c: Backlog widget in dashboard
6. Phase 4b: Schema enforcement
7. Phase 2a: Auto-decomposition
8. Phase 2b: Sub-agent dispatch

### Future
9. Phase 2c: Parallel execution
10. Phase 2d: Auto PR
11. Phase 5a-c: Self-healing
