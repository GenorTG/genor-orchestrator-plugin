# Test Coverage Expansion Plan

**Goal:** Take coverage from ~40% → ~90% by adding tests for hooks, dashboard API, safeguards, maintenance, routing presets, and backlog_dispatch_all.

## Priority Tiers

### P0 — Core Behavioral Hooks (critical path)
These hooks fire on every session. Zero coverage is a risk.

| # | Area | Existing | Target | Files |
|---|------|----------|--------|-------|
| 1 | **`before_model_resolve` hook** | 0 tests | 10-12 tests | `tests/10-before-model-resolve.test.ts` |
| 2 | **`before_prompt_build` hook** | 0 tests | 6-8 tests | `tests/11-before-prompt-build.test.ts` |
| 3 | **`session_start` / `session_end` hooks** | 0 tests | 8-10 tests | `tests/12-session-hooks.test.ts` |

### P1 — Infrastructure (safeguards, maintenance, dashboard)

| # | Area | Existing | Target | Files |
|---|------|----------|--------|-------|
| 4 | **Safeguards** (idle/stuck/auto-recover/log) | 0 tests | 10-12 tests | `tests/13-safeguards.test.ts` |
| 5 | **MaintenanceService** (tick, stale cleanup, project sync) | 0 tests | 6-8 tests | `tests/14-maintenance.test.ts` |
| 6 | **Dashboard API endpoints** | 0 tests | 15-20 tests | `tests/15-dashboard-api.test.ts` |
| 7 | **Dashboard SSE streaming** | 0 tests | 3-4 tests | (included in 15) |

### P2 — Remaining Tool Gaps

| # | Area | Existing | Target | Files |
|---|------|----------|--------|-------|
| 8 | **`backlog_dispatch_all`** | 0 tests | 4-5 tests | `tests/16-backlog-dispatch-all.test.ts` |
| 9 | **Routing presets deep tests** (5 presets, model_quality) | 3 shallow | 8-10 tests | `tests/17-routing-presets.test.ts` |
| 10 | **Subagent hooks** (`subagent_spawned`, `subagent_ended`) | 0 tests | 4-6 tests | `tests/18-subagent-hooks.test.ts` |
| 11 | **`agent_end` / `gateway_stop` hooks** | 0 tests | 3-4 tests | `tests/19-cleanup-hooks.test.ts` |

### P3 — Dashboard Frontend (future)

| # | Area | Existing | Target | Notes |
|---|------|----------|--------|-------|
| 12 | Dashboard HTML/JS | 0 tests | N/A | Requires headless browser (Playwright). Separate effort. |

---

## Implementation Order

```
Phase 1 (NOW):  P0 hooks → before_model_resolve, before_prompt_build, session_start/end
Phase 2 (NOW):  P1 → Safeguards, MaintenanceService
Phase 3 (NOW):  P2 → backlog_dispatch_all, routing presets deep, subagent hooks, cleanup hooks
Phase 4 (NEXT): P1 → Dashboard API endpoints + SSE
Phase 5 (FUTURE): P3 → Frontend browser tests
```

## Detailed Test Plans

### Phase 1a — `before_model_resolve` hook (tests/10)

**Test setup:** Need to simulate hookCtx with sessionKey. Hook is registered via `api.on("before_model_resolve", handler)`. Can trigger by calling the stored handler from `api.hooks.get("before_model_resolve")`.

**Test list:**
1. Skip routing for unregistered sessions (no synthetic keys)
2. Use chain primary for matched category (coding → chain[0])
3. Chain fallthrough when primary is disabled globally
4. Tier-based fallback when chain is empty
5. Task category inference from task description ("fix bug" → fixing)
6. Preset: `no-steering` — skip all overrides
7. Preset: `free-only` — filter paid models from event
8. Preset: `single-provider` — restrict to openrouter
9. Preset: `custom-fallbacks-only` — primary from event, chain as fallback
10. Synthetic-to-real key bridge
11. Logging enrichment (hook logs routing decision)
12. Project-level model_allowlist enforcement

### Phase 1b — `before_prompt_build` hook (tests/11)

1. Context injection for registered session with project binding
2. Skip context injection for unregistered sessions
3. Session isolation — second session doesn't pollute first
4. Hook fires, sets status to "prompting", tracks action
5. Live-agents.json written on hook fire
6. Synthetic key scenario (no injection without bridge)

### Phase 1c — `session_start` / `session_end` hooks (tests/12)

1. `session_start` triggers session tracking
2. `session_start` with unregistered session — no tracking bleed
3. `session_end` cleans up tracking for registered sessions
4. `session_end` expires session key from tracker
5. `session_end` with unregistered session — no-op
6. Both hooks don't throw on missing event data
7. Session key isolation (multiple sessions don't collide)

### Phase 1d — Safeguards (tests/13)

**Test setup:** Need to control `Date.now()` or manipulate live-agents.json timestamps to trigger idle/stuck detection.

1. Idle detection — agent with old `last_activity_at` triggers IDLE log
2. Stuck detection — agent with old `timestamp` triggers STUCK log
3. Error escalation — agent with >maxErrors triggers ESCALATE log
4. Auto-recovery — idle agent with auto_recover=true writes recovery action
5. Auto-recovery skipped when auto_recover=false
6. Safeguard disabled — no detection when enabled=false
7. Safeguard log written to disk (safeguard-log.md)
8. Multiple agents — each checked independently
9. Threshold customization (idle_timeout_ms, stuck_timeout_ms)
10. No false positives for healthy agents

### Phase 1e — MaintenanceService (tests/14)

1. Tick processes all projects in projects dir
2. Tick skips hidden dirs (.archived, .dotdirs)
3. Tick handles missing STATE.md (logs warning, no crash)
4. Tick runs model sync (read/write models.json)
5. Tick respects interval timing
6. Stop cleans up interval
7. Error in one project doesn't crash remaining

### Phase 1f — Dashboard API (tests/15)

**Test setup:** `createDashboardHandler(api)` returns a handler function `(req, res) => Promise<boolean | void>`. Need to create mock IncomingMessage + ServerResponse. Or better, use the mock API's `registerHttpRoute` to capture the handler, then test it with direct calls.

1. `GET /api/status` returns status object with http 200
2. `GET /api/all` returns all data (models, sessions, agents, projects)
3. `GET /api/models` returns filtered model list
4. `GET /api/logs` returns log entries
5. `GET /api/live-agents` returns agent list
6. `GET /api/projects` returns project list
7. `GET /api/sessions` returns session list
8. `GET /api/prices` returns price data
9. `GET /api/gateway` returns gateway info
10. `GET /api/safeguard-log` returns safeguard log entries
11. `GET /api/project-state` returns project state
12. `GET /api/project-doc` returns project doc content
13. `GET /api/project-backlog` returns backlog data
14. `POST /api/create-project` creates project
15. `POST /api/set-project-model` sets project model
16. `POST /api/set-project-routing` saves routing preset
17. `POST /api/project-doc` saves project doc
18. `POST /api/config` updates dashboard config
19. `GET /api/project-errors` returns project errors
20. `GET /api/global-errors` returns global errors
21. `GET /api/validate-sessions` validates session entries
22. 404 returns error
23. CORS preflight returns correct headers
24. SSE stream sends data

### Phase 2a — `backlog_dispatch_all` (tests/16)

1. Dispatches all available tasks up to max_dispatch
2. Respects max_dispatch limit
3. Respects filter_labels
4. Auto-claims tasks (sets status = in_progress)
5. Skips tasks with unmet dependencies
6. Project with no backlog returns empty

### Phase 2b — Routing presets deep (tests/17)

1. `get_routing` returns `preset` field matching config
2. `model_quality` array includes tier/speed/context/status/agent_ready
3. `no-steering` preset: recommended is null/undefined
4. `free-only` preset: only free models returned
5. `single-provider` preset: only models from specified provider
6. `custom-fallbacks-only` preset: recommended from model_routing
7. Unknown preset falls back to default behavior
8. Project without model_routing gets empty chain
9. Blocked chain detection (chain model is disabled/offline)

### Phase 2c — Subagent & Cleanup hooks (tests/18-19)

1. `subagent_spawned` logs subagent under parent project
2. `subagent_ended` logs subagent completion
3. `agent_end` cleans up live agents
4. `gateway_stop` stops maintenance, writes final log
5. All hooks guard for registered-only

---

## Estimated Test Counts

| Phase | New Tests | New Files | New Lines (est) |
|-------|-----------|-----------|-----------------|
| Phase 1a (before_model_resolve) | 12 | 1 | ~400 |
| Phase 1b (before_prompt_build) | 6 | 1 | ~200 |
| Phase 1c (session_start/end) | 7 | 1 | ~250 |
| Phase 1d (safeguards) | 10 | 1 | ~350 |
| Phase 1e (maintenance) | 7 | 1 | ~250 |
| Phase 1f (dashboard API) | 24 | 1 | ~600 |
| Phase 2a (backlog_dispatch_all) | 6 | 1 | ~200 |
| Phase 2b (routing presets deep) | 9 | 1 | ~300 |
| Phase 2c (subagent/cleanup hooks) | 10 | 2 | ~300 |
| **Total** | **91** | **10** | **~2850** |

Current: 116 tests in 9 files (1913 lines)
Target: 207+ tests in 19 files (~4760 lines)

---

## How to Run

```bash
# Run all tests
npm test

# Run specific phase
npx vitest run tests/10-before-model-resolve.test.ts

# Run with UI
npx vitest --ui
```
