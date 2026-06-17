# Autonomous Orchestration Pipeline — Architecture Plan

**Goal:** A plugin where Master Genor just prompts ideas/requests, and the
orchestrator + OpenClaw + agents handle everything — breaks down, assigns,
executes, QAs, commits, documents, hands off. Zero micro-management.

---

## Current State (what already exists)

| Feature | Status | Where |
|---------|--------|-------|
| Project creation | ✅ | `orchestrator_create_project` tool + dashboard form |
| Session registration | ✅ | `orchestrator_register` / hooks |
| Context injection | ✅ | `before_prompt_build` hook injects project CONTEXT.md |
| Model routing | ✅ | `before_model_resolve` hook auto-routes by category |
| Session logging | ✅ | `session_end` hook auto-logs + recovery doc |
| ADR logging | ✅ | `orchestrator_log_decision` tool |
| Phase enforcement | 🟡 | `orchestrator_advance_phase` tool exists but NOT enforced in hooks |
| Task logging enforcement | ✅ | `clear_context`/`unregister`/`release_project` block if no log |
| Auto-commit | ✅ | `session_end` hook auto-commits if `workflow.autoCommit` enabled |
| Sync project | ✅ | `orchestrator_sync_project` — generates CONTEXT.md + KEY_FILES.md |

## Missing Pieces (what to build)

### 1. Phase Enforcement in Hooks (`before_prompt_build` + `agent_end`)

Currently `advance_phase` is a manual tool with no teeth. The phases should be
**enforced at the hook level** so the AI physically cannot skip phases.

**Phases:**
```
Request → Analyze → Plan → Design Doc → Implement → Q&A → Log → Handoff → Done
```

**Enforcement in `before_prompt_build`:**
- Inject current phase into the prompt header
- If phase < "Implement", inject phase-specific instructions:
  - **Analyze**: "Analyze the request. Do NOT code. Output findings only."
  - **Plan**: "Create a plan. List files to change, approach, risks."
  - **Design Doc**: "Write an ADR or design doc. Get approval before coding."
  - **Implement**: "Code now. Follow the plan."
  - **Q&A**: "Review your own output. Run tests. Verify build."
  - **Log**: "Log the session with `orchestrator_log_session`."
  - **Handoff**: "Generate HANDOFF.md for next agent. Update RECOVERY.md."
  - **Done**: "All phases complete."

**`advance_phase` behavior change:**
- Must be called with a quality gate check before advancing
- Block advance if: no session logged (Log phase), no ADR (Design phase),
  build failing (Q&A phase), no test output (Q&A phase)

### 2. Auto-Q&A Sub-agent (`session_end` hook)

When a session ends with completed work, the `session_end` hook should
automatically spawn a **verification sub-agent** that:

1. Checks git status (are there uncommitted changes?)
2. Runs the build command (npm run build, npm test, etc.)
3. Reviews the diff for obvious issues
4. Checks that RECOVERY.md was updated
5. Reports results back

**When it runs:**
- After `orchestrator_log_session` with `status=complete`
- After a sub-agent completes and returns
- Results written to `QA_REPORT.md` in project dir

**Timing:** Deferred (non-blocking), so the user gets the session back while
QA runs in the background.

### 3. Work Decomposition Engine (`orchestrator_decompose` tool)

When the user says "I want feature X", the orchestrator should:
1. Spawn a **planning sub-agent** that analyzes the request against the project
2. The planning agent outputs a set of tasks (decomposition)
3. Each task gets an `orchestrator_set_context` call in a dedicated session
4. Work proceeds in parallel or sequentially based on dependency graph

**Tool: `orchestrator_decompose`**
```
Input:  project, request
Process: 1. Fetch project context (CONTEXT.md, TOC, BACKLOG.json)
          2. Spawn planning sub-agent with context
          3. Parse sub-agent output into task list
          4. Create backlog entries
          5. Optionally spawn worker sessions
Output: task list, dependency graph, estimated order
```

### 4. Backlog Management (BACKLOG.json)

Currently referenced in code but no tool to manage it.

**New tools:**
- `orchestrator_backlog_add` — add task to backlog
- `orchestrator_backlog_list` — list backlog with filters
- `orchestrator_backlog_update` — update task status/priority

**Schema:**
```json
{
  "tasks": [
    {
      "id": "task_xxx",
      "title": "Add delete-story MCP tool",
      "description": "...",
      "status": "todo" | "in_progress" | "done" | "blocked",
      "priority": "p0" | "p1" | "p2" | "p3",
      "created": "ISO timestamp",
      "assigned_to": null,
      "depends_on": ["task_yyy"],
      "labels": ["backend", "mcp"],
      "session_key": null
    }
  ]
}
```

### 5. Auto-session Spawn After Decomposition

When `orchestrator_decompose` creates tasks, it should spawn a dedicated
session for each task (up to `maxConcurrent`).

**Flow:**
```
Request → decompose → task_1 → session_1 → work_logged → auto-QA → done
                        task_2 → session_2 → work_logged → auto-QA → done
                        task_3 → blocked (depends on task_1)
```

### 6. Handoff Generation

When a session ends without completing its goal (user switches context, session
times out, etc.), auto-generate a HANDOFF.md so the next session can pick up.

**Content:**
```markdown
# Handoff: project/task

## State
- Phase: Implement (50% done)
- Files changed: src/foo.ts, src/bar.ts
- Uncommitted: true

## What was done
- [x] Created Foo class
- [ ] Tests for Foo
- [ ] Integration with Bar

## Next steps
1. Write tests
2. Run build
3. QA

## Decisions
- Used X over Y because Z (see adrs/ADR-003.md)
```

### 7. Dashboard Pipeline View

The dashboard should show:
- Project pipeline (which phase each project is in)
- Active sessions
- Recent completions + QA results
- Blocked tasks
- Backlog queue

---

## Resilience Requirements (cross-cutting)

Every automation step MUST have the following safeguards to prevent the
orchestrator from getting stuck requiring hacky/manual intervention.

### R1. Defensive timing

- All sub-agent spawns have a timeout (default 300s, configurable per task)
- If sub-agent doesn't respond in time → log error → transition to fallback
- Fallback state: retry once, then skip the step and log why

### R2. Structured error logging

- Every step writes to `{project}/errors.log` with: timestamp, step name, error
  message, trace context, action taken
- Errors surfaced on the dashboard error feed
- Format:
  ```json
  {
    "phase": "analyze",
    "step": "orchestrator_decompose",
    "error": "sub-agent timed out after 300s",
    "action_taken": "retried once, then skipped decomposition. Request logged for manual review.",
    "timestamp": "2026-06-17T11:30:00Z"
  }
  ```

### R3. Graceful degradation (fallback chain)

Every non-trivial operation follows:
```
Primary path → First fallback → Second fallback → Skip + log + dashboard notify
```

**Auto-Q&A fallback example:**
1. Primary: spawn QA sub-agent → completes → report written ✅
2. Fallback 1: sub-agent spawn fails → run inline verification (git status, build) ✅
3. Fallback 2: inline verification fails too → log "QA skipped — manual review needed"
4. Never: block the pipeline because QA couldn't run

### R4. Escalation tiers

| Tier | What happens | Example |
|------|-------------|---------|
| **Info** | Logged only | Routing model not found, used fallback |
| **Warn** | Logged + dashboard indicator | Auto-populate skipped (no network), data is stale |
| **Error** | Logged + step skipped + dashboard alert | Sub-agent timeout, phase skipped to next |
| **Critical** | Pipeline paused + dashboard alarm + DM to Master Genor | Multiple retries failed, data corruption, manual intervention essential |

### R5. Phase timeout enforcement

- Each phase has a max wall-clock time (defaults: Analyze=5min, Plan=10min,
  Implement=30min, QA=10min)
- Time exceeded → auto-log "phase timed out" → advance to next phase
- Configurable per project in `dashboard-config.json`

### R6. Stuck detection

- Same phase retried 3+ times without advancing → **stuck**
- Mark stuck → log error (tier: Error) → pause pipeline
- Recovery: `orchestrator_unblock` tool to force-advance
- Never: infinite retry loop without logging

### R7. Data integrity

- All writes use atomic file pattern: write to `.tmp` → rename over target
- `dashboard-config.json` backups before mutation (`.bak` — already done)
- `models.json` preserves manual ratings on auto-populate (already done)
- Never: leave half-written files

### R8. Circuit breaker for external calls

- Hook calls, git operations, sub-agent spawns use a circuit breaker pattern
- 3 failures in 60s → break for 120s → half-open → full recovery
- Prevents cascading failures (e.g., git push fails → don't spam retry)
- Never: hammer a failing service

---

## Updated Implementation Order

```
Phase 1 — Immediate (foundation)
├── 1a. Phase enforcement in hooks (before_prompt_build injection)
│   └── Resilience: default to Analyze if phase missing. Must not block agent startup.
├── 1b. Backlog management tools (add/list/update)
│   └── Resilience: file missing → create empty. Parse error → recreate.
├── 1c. Error logging service (errors.log per project, dashboard surfacing)
│   └── Prerequisite for all other steps to report failures properly.
└── 1d. Auto-Q&A sub-agent in session_end
    └── Resilience: spawn fail → inline verify. Inline fail → log + skip.

Phase 2 — Core automation
├── 2a. Timeout enforcement per phase
├── 2b. Decomposition engine (orchestrator_decompose)
│   └── Resilience: planning sub-agent timeout → simple decomposition fallback.
│       Still fails → single "undifferentiated" task + log.
├── 2c. Auto-session spawn (connect decompose → spawn)
│   └── Resilience: spawn fail → retry once with backoff. Still fail → log + unassigned.
├── 2d. Handoff generation
│   └── Resilience: git unavailable → generate from memory. Empty → basic template.

Phase 3 — UI + hardening
├── 3a. Dashboard pipeline view + error feed
├── 3b. Stuck detection + circuit breakers
├── 3c. Self-healing (detect stale sessions, auto-reclaim)
│   └── Resilience: reclaim fails → log critical. Never loop.
└── 3d. Escalation conduit (critical errors → DM to Master Genor)
```
