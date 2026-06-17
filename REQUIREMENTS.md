# Genor's Orchestrator — Requirements & Feature Specifications

> **Version:** 0.7.0-draft
> **Owner:** Master Genor
> **Last Updated:** 2026-06-17

---

## 📋 Core Philosophy

The orchestrator should manage project lifecycle (analyze → plan → implement → QA → log → handoff) with zero micro-management. The user prompts ideas/requests; the orchestrator + agents decompose, assign, execute, QA, commit, document, and hand off work autonomously.

**Resilience by Design:** Every automated step must have defensive timing, graceful degradation (fallback chains), structured error logging, escalation tiers, and stuck detection.

---

## ✅ Phase 1 — Complete (v0.7.0)

### 1a. Phase Enforcement
- `before_prompt_build` hook injects phase-specific instructions (analyze/plan/document/work/log/finish)
- Quality gates on `advance_phase`: warns if no ADR, dirty git, missing log
- `agent_end` auto-advances timed-out phases (defaults: 5/10/10/30/5/2 min)

### 1b. Backlog Management
- 3 tools: `orchestrator_backlog_add`, `orchestrator_backlog_list`, `orchestrator_backlog_update`
- Structured task schema: id, title, description, status, priority (p0-p3), labels, dependencies, assignment
- BACKLOG.json stored per project in orchestrator-data

### 1c. Error Logging Service
- Structured JSONL errors written per project to `errors.log`
- API endpoints: `/api/project-errors`, `/api/global-errors`
- Dashboard page: `error-feed.html` with auto-refresh, project filter, severity badges

### 1d. Auto-Q&A (Inline Verification)
- After completed sessions: git status check + npm build check
- `QA_REPORT.md` written per project session
- Graceful fallback via error logging on failure

---

## 🔜 Phase 2 — Pipeline Automation

### 2a. Auto-Decomposition
- When a high-level task is added to backlog, auto-decompose into sub-tasks
- Sub-agents analyze the task and propose a breakdown
- User reviews and approves decomposition (or it auto-approves after timeout)

### 2b. Sub-Agent Dispatch
- Assign backlog tasks to spawned sub-agents with project context
- Monitor sub-agent progress, detect stuck agents, auto-retry on failure
- Collect results and update backlog status

### 2c. Parallel Execution
- Multiple backlog tasks execute in parallel via sub-agents
- Dependency resolution: blocked tasks wait for dependencies to complete
- Resource-aware dispatch (respect maxConcurrent limits)

### 2d. Automatic PR Creation
- After QA passes, create a branch and PR automatically
- PR body includes summary of changes, QA results, and related backlog tasks
- CI check monitoring: wait for green, then notify user

---

## 🔜 Phase 3 — Dashboard Evolution

### 3a. Active Model Display (NEW — Added 2026-06-17)
**Requirement:** Show which model is active/routing for each project in the WebUI.

**Spec:**
- Dashboard shows the current model being used per active project session
- Display format: `Model Name (Provider)` with quality badge
- Should show fallback chain when primary model fails
- Update in real-time via SSE or poll

**Acceptance:**
- [ ] Dashboard project card shows active model
- [ ] Model changes reflected within 5 seconds
- [ ] Tooltip shows full fallback chain

### 3b. In-WebUI Model Assignment (NEW — Added 2026-06-17)
**Requirement:** Assign/change project models directly from the dashboard without editing config files.

**Spec:**
- Dropdown or selector in dashboard project view
- Lists all active models from inventory
- Saves to project routing config
- Validates model is reachable before applying

**Acceptance:**
- [ ] Model selector in project detail view
- [ ] `POST /api/set-project-model` endpoint
- [ ] Validation pings the model before applying
- [ ] Error shown if model unreachable

### 3c. Dashboard Backlog Widget (NEW — Added 2026-06-17)
**Requirement:** Show backlog tasks with status badges on the orchestrator dashboard.

**Spec:**
- List of backlog tasks per project
- Status badges: todo/in_progress/done/blocked
- Priority coloring: p0=red, p1=orange, p2=blue, p3=gray
- Click to view task details

### 3d. Session Timestamps (NEW — Added 2026-06-17)
**Requirement:** All session entries in storage must have proper timestamps.

**Spec:**
- Every session log entry includes `started_at`, `updated_at`, `ended_at`
- Sessions table shows human-readable timestamps with timezone
- Sessions sortable by start time

**Acceptance:**
- [ ] No session entry without timestamps
- [ ] Dashboard sessions view shows dates
- [ ] Timestamps in local timezone

---

## 🔜 Phase 4 — Data Integrity & Anti-Corruption

### 4a. Fake Session Detection (NEW — Added 2026-06-17)
**Requirement:** Detect and flag fake/broken session entries in storage.

**Spec:**
- Background validation on session list load
- Checks each session for:
  - Valid `session_key` format
  - Non-empty `project` and `task` fields
  - Valid timestamps (not future, not null)
  - Real duration (not absurd values > 24h)
  - Non-duplicate `id` (no hash collisions)
- Invalid entries flagged (not auto-deleted without user approval)
- Dashboard shows warning badge with count of suspicious entries
- "Clean" button with confirm dialog to remove flagged entries

**Acceptance:**
- [ ] Validation runs on session load
- [ ] Invalid entries flagged with reason
- [ ] Dashboard warning when suspicious entries exist
- [ ] Manual clean action available
- [ ] No auto-delete without user confirmation

### 4b. Session Schema Enforcement
- All session entries must conform to `SessionSchema v2`
- Missing fields filled with defaults on write
- Schema version tracked per entry
- Migration path for legacy entries

---

## 🗺️ Phase 5 — Self-Healing & Monitoring

### 5a. Agent Heartbeat Monitoring
- Detect stuck agents via heartbeat checks
- Auto-restart stalled sessions
- Webhook notifications on agent failure

### 5b. Fallback Model Routing
- When primary model fails, try fallbacks automatically
- Log model failures to errors.log
- Dashboard shows model health status

### 5c. Automated Recovery
- RECOVERY.md auto-generated on agent crash
- Recovery instructions based on failure context
- Optional auto-recovery via sub-agent

---

## 🐛 Known Bugs

1. ~~**backlogAdd param order:** backlogAdd called with (dataDir, project, opts) instead of (project, dataDir, opts). Fixed in PR #14.~~ ✅
2. **backlog_list label filter:** Legacy tasks have `tags` not `labels`, causing `.includes()` on undefined. Fixed in PR pending.

---

## Architecture Decisions

### ADR-001: JSONL for Error Logging
**Context:** Needed append-only, streaming-friendly error storage.
**Decision:** Use JSONL (newline-delimited JSON) — one JSON object per line, append-only writes.
**Consequences:** Easy to tail, no locking, simple parsing. Downside: no random access.

### ADR-002: Inline Q&A Over Sub-Agent
**Context:** After session completion, should we spawn a sub-agent for verification?
**Decision:** Use inline checks (git status + npm build) instead of sub-agent spawn.
**Consequences:** Simpler, faster, no context overhead. Downside: limited to checks available from node runtime.

### ADR-003: Backlog as JSON File
**Context:** Needed lightweight task storage without database dependency.
**Decision:** Store as `BACKLOG.json` per project in orchestrator-data.
**Consequences:** Simple, portable, no DB setup. Downside: no concurrency safety for simultaneous writes.

---

## Glossary

| Term | Definition |
|------|------------|
| ADR | Architecture Decision Record — markdown doc in `adrs/` directory |
| Backlog | Task queue stored as `BACKLOG.json` per project |
| Data Dir | `~/.openclaw/workspace/orchestrator-data/` |
| Phase | One step in the analyze→plan→document→work→log→finish workflow |
| QA Report | `QA_REPORT.md` generated after session completion |
| Session | A single agent conversation, tracked in `sessions.json` |
