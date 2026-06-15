# Plugin-Enforced Workflow Engine — Design Document

> **Date:** 2026-06-15
> **Status:** Draft
> **Project:** genor-orchestrator-plugin
> **Version target:** 0.6.0

---

## Table of Contents

1. [State Machine](#1-state-machine)
2. [Plugin Hooks](#2-plugin-hooks-to-use)
3. [Enforcement Mechanism](#3-enforcement-mechanism)
4. [QA Subagent](#4-qa-subagent)
5. [Git Commit Integration](#5-git-commit-integration)
6. [Per-Project Config](#6-per-project-config)
7. [Dashboard Integration](#7-dashboard-integration)
8. [Failure Modes](#8-failure-modes)
9. [Implementation Plan](#9-implementation-plan)

---

## 1. State Machine

### The Core Cycle: 6 Phases + QA Loop

```
┌──────────────────────────────────────────────────────┐
│                    TASK ACTIVE                        │
│                                                        │
│   ┌─────────┐    ┌──────┐    ┌──────────┐            │
│   │ ANALYZE ├───►│ PLAN ├───►│ DOCUMENT │            │
│   └────┬────┘    └───┬──┘    └────┬─────┘            │
│        │             │            │                    │
│        ▼             ▼            ▼                    │
│   Understand      update_plan   Write docs             │
│   codebase +      + design      (ADR, CONTEXT,        │
│   memory search   decisions     STATE.md)             │
│        │             │            │                    │
│        └─────────────┴────────────┘                    │
│                                  │                      │
│                                  ▼                      │
│                            ┌──────────┐                │
│                            │  WORK    │                │
│                            └────┬─────┘                │
│                                 │                       │
│                                 ▼                       │
│                            ┌──────────┐                │
│                            │   LOG    │                │
│                            └────┬─────┘                │
│                                 │                       │
│                                 ▼                       │
│                            ┌──────────┐                │
│                            │  FINISH  │                │
│                            └────┬─────┘                │
│                                 │                       │
│                                 ▼                       │
│                      ┌─────────────────┐               │
│                      │  QA SUBAGENT    │◄── Loop ──┐  │
│                      │  (auto-spawned) │           │  │
│                      └────────┬────────┘           │  │
│                               │                    │  │
│                     ┌─────────┴─────────┐          │  │
│                     ▼                   ▼          │  │
│                 QA PASS            QA FAIL         │  │
│                     │                   │           │  │
│                     ▼                   └──────────┘  │
│              ┌─────────────────┐                      │
│              │ GIT COMMIT      │                      │
│              │ (auto-version)  │                      │
│              └────────┬────────┘                      │
│                       │                                │
│                       ▼                                │
│                  TASK COMPLETE                         │
│                                                        │
└──────────────────────────────────────────────────────┘
```

### Phase Transitions (FSM)

Each phase is a string enum value. Transitions are:

| From | To | Trigger |
|------|----|---------|
| `null` (unstarted) | `analyze` | Task starts after `session_start` + `set_context` |
| `analyze` | `plan` | Agent calls `update_plan` or explicit `workflow_advance(plan)` |
| `plan` | `document` | Agent logs first ADR or calls `workflow_advance(document)` |
| `document` | `work` | Agent makes first edit/code change |
| `work` | `log` | Agent calls `orchestrator_log_session` |
| `log` | `finish` | Agent calls `orchestrator_clear_context` or `session_end` fires |
| `finish` | `qa` | Automatically: `session_end` hook spawns QA subagent |
| `qa` | `complete` | QA subagent returns PASS |
| `qa` | `qa` (loop) | QA subagent returns FAIL (< 3 retries) |
| `qa` | `escalated` | QA subagent returns FAIL (3rd retry exhausted) |

### State Persistence

Stored in `orchestrator-data/live-agents.json` under a new `workflow_phase` field per agent:

```json
{
  "agents": [
    {
      "agent": "Amy",
      "project": "genor-orchestrator-plugin",
      "workflow_phase": "work",
      "workflow_enabled": true,
      "qa_retries": 0,
      "qa_max_retries": 3,
      "qa_result": null,
      "phase_history": [
        { "phase": "analyze", "entered_at": "2026-06-15T09:00:00Z" },
        { "phase": "plan", "entered_at": "2026-06-15T09:05:00Z" },
        { "phase": "work", "entered_at": "2026-06-15T09:15:00Z" }
      ]
    }
  ]
}
```

Also persisted as `orchestrator-data/projects/<name>/WORKFLOW.json` for durable cross-session tracking.

---

## 2. Plugin Hooks to Use

The existing plugin already has 8 hooks. The workflow engine adds logic to **6 of them**, plus 1 new hook (`orchestrator_workflow_tick` via maintenance) and 2 new tools.

### Hook: `session_start`

**Current behavior:** Starts session tracker, filters out background sessions.

**Added:** Initialize workflow phase to `analyze` if the project has workflow enforcement enabled.

```typescript
api.on("session_start", async (event) => {
  // ... existing code ...
  if (!isBackground && shouldEnforceWorkflow(sessionTracker.currentProject, dataDir)) {
    sessionTracker.workflowPhase = "analyze";
    sessionTracker.phaseHistory = [{ phase: "analyze", entered_at: new Date().toISOString() }];
    writeWorkflowState(dataDir, sessionTracker);
    logger.info("workflow", `Workflow started: ${sessionTracker.currentProject} → analyze`);
  }
});
```

### Hook: `session_end`

**Current behavior:** Auto-logs session, generates recovery doc.

**Added:** Instead of directly completing, intercept to check if workflow enforcement is on:

- If workflow is **disabled**: behave exactly as today (immediate complete)
- If workflow is **enabled** and phase is NOT `finish` or `qa`:
  - If phase is `log`: auto-advance to `finish`, then spawn QA subagent
  - If phase is earlier than `log`: log a warning about incomplete workflow, still advance to finish
  - Spawn QA subagent via subagent engine (see §4)
  - **Do NOT** log the session as "complete" until QA passes

```typescript
api.on("session_end", async (event) => {
  if (shouldEnforceWorkflow(sessionTracker.currentProject, dataDir)) {
    // Intercept: advance to finish if possible, spawn QA, defer completion
    if (!["finish", "qa", "complete"].includes(sessionTracker.workflowPhase)) {
      advancePhase(sessionTracker, "finish", logger);
      await spawnQASubagent(dataDir, sessionTracker, logger);
      return; // Don't log as complete yet — QA result will do that
    }
  }
  // ... existing log + recovery behavior for non-enforced or already-qa'd ...
});
```

### Hook: `before_prompt_build`

**Current behavior:** Injects project context into prompt.

**Added:** If workflow enforcement is active, inject the **current workflow phase** and a **phase checklist** into the prompt context:

```
⚡ Project: genor-orchestrator-plugin | Task: test-plugin-workflow
Location: /home/... | Sub-agents: 0 | Data: orchestrator-data/...
🔄 Workflow Phase: work (enforced)
📋 Next required: log → finish → qa
```

The injected context tells the LLM which phase it should be in and what to do next.

### Hook: `subagent_ended`

**Current behavior:** Decrements subagent depth.

**Added:** If the subagent was a **QA subagent** (detected via session key marker `:qa:`), process its result:

- Read QA result from designated temp file
- PASS → advance phase to `complete`, trigger git commit, log session as complete
- FAIL + retries remaining → increment retry counter, re-spawn QA subagent
- FAIL + retries exhausted → set phase to `escalated`, log warning, still complete (with QA failure note)

```typescript
api.on("subagent_ended", async () => {
  sessionTracker.subagentDepth = Math.max(0, sessionTracker.subagentDepth - 1);
  if (sessionTracker.isQARunning) {
    const result = readQAResult(dataDir, sessionTracker);
    if (result.passed) {
      sessionTracker.workflowPhase = "complete";
      writeWorkflowState(dataDir, sessionTracker);
      // Trigger git commit automatically
      execGitCommit(sessionTracker.currentProject, dataDir, logger);
      // Now log session as complete
      logCompleteSession(dataDir, sessionTracker, logger);
    } else if (sessionTracker.qaRetries < sessionTracker.qaMaxRetries) {
      sessionTracker.qaRetries++;
      await spawnQASubagent(dataDir, sessionTracker, logger);
    } else {
      sessionTracker.workflowPhase = "escalated";
      logger.warn("workflow", `QA failed after ${sessionTracker.qaMaxRetries} retries for ${sessionTracker.currentProject}`);
      // Still complete with a QA-failed flag
      logCompleteSession(dataDir, sessionTracker, logger, { qa_passed: false });
    }
    sessionTracker.isQARunning = false;
  }
  writeLiveAgents("subagent_ended", sessionTracker, logger);
});
```

### Hook: `agent_end`

**Current behavior:** Sets status to "stopped", writes live agents.

**Added:** If workflow is active and phase is not `complete` or `escalated`, log a warning about incomplete workflow.

### Maintenance Hook: `workflow_tick` (new tick in `MaintenanceService.tick()`)

The maintenance tick (every 30 min) already processes control actions and detects stale agents. Add a new workflow-specific check:

- Find agents stuck in a phase for > 30 minutes
- If still `analyze` after 30 min → auto-skip to `plan` with a warning
- If still `qa` after 60 min → mark QA as timed out, complete with note

---

## 3. Enforcement Mechanism

### How Enforcement Works

Enforcement is **not** a hard block — the OpenClaw plugin SDK does not provide a way to abort an agent's execution mid-turn. Instead, enforcement works through **three layers**:

#### Layer 1: Prompt Injection (Soft Enforcement)

Every `before_prompt_build` hook injects the current workflow phase and a "next action" hint. The LLM sees:

```
🔄 Workflow Phase: analyze (enforced)
📋 Checklist:
  [ ] Analyze codebase and search memory
  [ ] Call update_plan with design decisions
  [ ] Write docs (ADR, CONTEXT updates)
  [ ] Implement changes
  [ ] Log the session
  [ ] Pass QA gate
```

This is the primary mechanism: the agent **sees** the phase and is guided through it.

#### Layer 2: Tool Guards (Soft Block)

Create a `workflow_advance` tool that the agent must call to transition phases. The `orchestrator_log_session` tool is modified to check workflow phase:

- If workflow is enforced and phase is not `work` or `log`, the tool returns a warning:
  ```
  ⚠️ Workflow enforcement: You are in phase "analyze", but "log" 
  requires advancing through plan → document → work first.
  Run orchestrator_set_context(workflow_advance="plan") to advance.
  ```
  The tool **still executes** (soft block), but the warning is prominent.

#### Layer 3: Session End Gate (Semi-Hard)

On `session_end` with enforcement enabled, if the phase is `analyze`, `plan`, or `document` (i.e., the agent never started working), the plugin:

1. Logs a yellow-flagged session with `workflow_skipped: true`
2. Still spawns QA (which will likely fail fast)
3. Marks the session as "incomplete workflow" in the session log

This creates accountability without being a hard crash.

### Phase Advancement: `workflow_advance` Tool

A new plugin tool:

```typescript
api.registerTool({
  name: "orchestrator_workflow_advance",
  label: "Workflow Advance",
  description: "Advance the workflow phase. Call this when you complete a phase's requirements.",
  parameters: Type.Object({
    to: Type.String({
      enum: ["analyze", "plan", "document", "work", "log", "finish"],
      description: "Phase to advance to. Must follow the sequence order."
    }),
    note: Type.Optional(Type.String({ description: "Optional note about what was accomplished." })),
  }),
  async execute(_id: string, params: any) {
    if (!shouldEnforceWorkflow(sessionTracker.currentProject, dataDir)) {
      return txt({ ok: true, message: "Workflow enforcement is disabled for this project. Phase tracking skipped." });
    }
    const result = advancePhase(sessionTracker, params.to, logger);
    writeWorkflowState(dataDir, sessionTracker);
    writeLiveAgents("workflow_advance", sessionTracker, logger);
    return txt(result);
  },
});
```

The `advancePhase` function:

```typescript
const PHASE_ORDER = ["analyze", "plan", "document", "work", "log", "finish"];

function advancePhase(tracker: SessionTracker, to: string, logger: OrchestratorLogger) {
  const current = tracker.workflowPhase || "analyze";
  const currentIdx = PHASE_ORDER.indexOf(current);
  const toIdx = PHASE_ORDER.indexOf(to);

  if (toIdx < currentIdx) {
    logger.warn("workflow", `Phase regression: ${current} → ${to} (backwards move)`);
    // Allow it, but warn
    // A backwards move might be legitimate (e.g., "go back to analyze after realizing you missed something")
  }

  tracker.workflowPhase = to;
  tracker.phaseHistory.push({ phase: to, entered_at: new Date().toISOString() });
  logger.info("workflow", `Phase advanced: ${current} → ${to}`);
  return { ok: true, from: current, to, phase_index: toIdx + 1, total_phases: PHASE_ORDER.length };
}
```

---

## 4. QA Subagent

### Design

The QA subagent is spawned by the `session_end` hook (when workflow enforcement is active). It is a **standard OpenClaw subagent** with:

- A dedicated `:qa:` marker in its session key so hooks can identify it
- A structured prompt that includes:
  - The project name, location, and task
  - A short description of what was done in this session
  - A QA checklist to evaluate against
  - A defined pass/fail output format

### Spawning

```typescript
async function spawnQASubagent(
  dataDir: string,
  tracker: SessionTracker,
  logger: OrchestratorLogger
): Promise<void> {
  const project = tracker.currentProject;
  const task = tracker.currentTask;
  const loc = getProjectLocation(project, dataDir);

  // Build QA context from recent session logs
  const sessions = readRecentSessions(project, dataDir, 1);
  const lastSession = sessions.length > 0 ? sessions[sessions.length - 1] : null;

  const qaPrompt = `
[Subagent Task]
## QA Verification: ${project} / ${task}

You are a QA subagent spawned to verify the completed work for **${project}** (${task}).

### Location
\`${loc}\`

### What was done
Task: ${task}
${lastSession ? `Session info: ${lastSession.task} — ${lastSession.notes || "No notes"}` : ""}

### QA Checklist
1. **Does the code build/compile without errors?** — Run \`npm run build\` or equivalent
2. **Do tests pass?** — Run \`npm test\` or equivalent
3. **Are there any linting issues?** — Run lint command
4. **Does the implementation match the task description?** — Review changed files
5. **Are docs consistent with the changes?** — Check README, CONTEXT.md, ADRs
6. **(Optional) Did a visual/smoke check pass?** — If UI changed

### Instructions
1. Run the verification commands in order
2. If a step fails, collect the error output
3. Decide: **PASS** or **FAIL**
4. If FAIL, provide specific, actionable feedback on what to fix

### Output Format (LAST LINE ONLY — one of these two):
QA_RESULT: PASS
QA_RESULT: FAIL: <specific reason>

Keep your full analysis in the message body for audit. The LAST LINE is what the orchestrator reads.
  `;

  // Write QA request file (control mechanism)
  const qaDir = path.join(dataDir, "qa");
  fs.mkdirSync(qaDir, { recursive: true });

  const retry = tracker.qaRetries || 0;
  const attemptFile = path.join(qaDir, `${project}-${Date.now()}-attempt-${retry}.json`);

  // Track that QA is running
  tracker.isQARunning = true;
  tracker.workflowPhase = "qa";
  writeWorkflowState(dataDir, tracker);

  // Spawn the subagent
  // The subagent key uses ":qa:" tag so hooks can identify it
  await sessions_spawn({
    task: qaPrompt,
    taskName: `qa-${project}-${task}`,
    // Use isolated context for clean QA run
    context: "isolated",
    // Tag with :qa: for identification
  });
}
```

### Pass/Fail Criteria

| Criterion | Pass | Fail |
|-----------|------|------|
| Build | Compiles without errors | Compilation errors |
| Tests | All tests pass | Any test fails |
| Lint | No linting errors | Linting errors |
| Implementation | Matches task description | Doesn't match |
| Docs | Docs updated or N/A | Docs outdated |

### Retry Loop

```
QA spawn → [agent runs checks]
         → PASS? → Complete task, git commit
         → FAIL? → retries < 3?
                    → YES: Increment retry counter, re-spawn QA with extra context
                    → NO:  Mark as escalated (3rd failure), complete with QA_failed flag
```

Each retry includes the **previous QA output** so the second pass knows what failed and can target the verification:

```typescript
const previousAttempts = getPreviousQAAttempts(dataDir, project, sessionTracker.sessionKey);
if (previousAttempts.length > 0) {
  qaPrompt += `\n\n### Previous QA Attempts (FAILED)\n${previousAttempts.map(a => `- Attempt ${a.attempt}: ${a.reason}`).join("\n")}\n\nVerify these specific issues are fixed.`;
}
```

### QA Result File

Written by the QA subagent detection mechanism. The `subagent_ended` hook reads this:

```json
{
  "project": "genor-orchestrator-plugin",
  "task": "test-plugin-workflow",
  "attempt": 1,
  "result": "PASS",
  "reason": null,
  "timestamp": "2026-06-15T09:45:00Z",
  "details": {
    "build": "passed",
    "tests": "passed",
    "lint": "passed",
    "implementation": "matched",
    "docs": "updated"
  }
}
```

---

## 5. Git Commit Integration

### When /genor-git-commit Fires

The existing `/genor-git-commit` slash command is **not replaced**. Instead, the workflow engine **automatically triggers** git commit at two points:

#### 1. After QA Passes (Primary)

When the QA subagent returns PASS, the `subagent_ended` hook automatically calls the same logic as `/genor-git-commit`:

```typescript
function autoGitCommit(project: string, dataDir: string, logger: OrchestratorLogger): void {
  const loc = getProjectLocation(project, dataDir);
  if (!loc || !fs.existsSync(path.join(loc, ".git"))) return;

  try {
    const statusRaw = execSync("git status --porcelain", { cwd: loc, encoding: "utf-8", timeout: 10000 });
    const changed = statusRaw.trim().split("\n").filter(Boolean);
    if (changed.length === 0) return; // Nothing to commit

    // Read current version, bump patch
    let currentVersion = "0.0.0";
    const pj = path.join(loc, "package.json");
    if (fs.existsSync(pj)) {
      currentVersion = JSON.parse(fs.readFileSync(pj, "utf-8")).version || "0.0.0";
    }
    const parts = currentVersion.split(".").map(Number);
    parts[2] = (parts[2] || 0) + 1;
    const newVersion = parts.join(".");

    // Bump version + commit
    if (fs.existsSync(pj)) {
      const pkg = JSON.parse(fs.readFileSync(pj, "utf-8"));
      pkg.version = newVersion;
      fs.writeFileSync(pj, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
    }

    const modCount = changed.filter(l => l.startsWith(" M") || l.startsWith("M ")).length;
    const addCount = changed.filter(l => l.startsWith("?")).length;
    const summary = [modCount > 0 ? `${modCount} modified` : "", addCount > 0 ? `${addCount} added` : ""].filter(Boolean).join(", ");
    const commitMsg = `v${newVersion}: auto-commit (${summary || "changes"})`;

    execSync("git add -A", { cwd: loc, encoding: "utf-8", timeout: 30000 });
    execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: loc, encoding: "utf-8", timeout: 30000 });
    execSync(`git tag v${newVersion}`, { cwd: loc, encoding: "utf-8", timeout: 10000 });

    logger.info("workflow", `Auto-commit: v${newVersion} for ${project} (QA passed)`);
  } catch (err: any) {
    logger.warn("workflow", `Auto-commit failed for ${project}: ${err.message}`);
  }
}
```

#### 2. Manual via /genor-git-commit (Unchanged)

The existing slash command stays exactly as-is for manual use during active development. The workflow engine **does not preempt** manual commits — it only auto-commits after QA verification.

### Git Flow Within the Workflow

```
analyze → plan → document → work → log → finish → QA pass → auto-git-commit
```

The commit message includes the workflow context:

```
v1.2.5: auto-commit (QA passed — implement user auth)
```

---

## 6. Per-Project Config

### Config Schema Extension

Add a `workflow` section to `dashboard-config.json`:

```json
{
  "free_only_mode": false,
  "disabled_models": [],
  "projects": {
    "genor-orchestrator-plugin": {
      "location": "/home/genorbox1/projects/genor-orchestrator-plugin",
      "model_allowlist": [],
      "enforce_workflow": true,
      "qa_retries": 3,
      "qa_timeout_minutes": 30,
      "auto_commit": true,
      "skip_phases": ["document"]
    },
    "kotw": {
      "location": "/home/genorbox1/projects/kotw",
      "enforce_workflow": false
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enforce_workflow` | boolean | `false` | Enable workflow enforcement for this project |
| `qa_retries` | number | `3` | Max QA retry attempts before escalation |
| `qa_timeout_minutes` | number | `30` | Max minutes QA subagent can run |
| `auto_commit` | boolean | `true` | Auto git commit after QA passes |
| `skip_phases` | string[] | `[]` | Phases to automatically skip (e.g., `["document"]`) |

### Global Workflow Defaults

```json
{
  "workflow_defaults": {
    "enforce_workflow": false,
    "qa_retries": 3,
    "qa_timeout_minutes": 30,
    "auto_commit": true
  }
}
```

### Detection Helper

```typescript
function shouldEnforceWorkflow(project: string | null, dataDir: string): boolean {
  if (!project) return false;
  const cfg: DashboardConfig = readJSON(path.join(dataDir, "dashboard-config.json")) || {};
  return cfg.projects?.[project]?.enforce_workflow === true;
}

function getWorkflowConfig(project: string | null, dataDir: string): WorkflowConfig {
  const defaults = { enforce_workflow: false, qa_retries: 3, qa_timeout_minutes: 30, auto_commit: true, skip_phases: [] as string[] };
  if (!project) return defaults;
  const cfg: DashboardConfig = readJSON(path.join(dataDir, "dashboard-config.json")) || {};
  return { ...defaults, ...cfg.workflow_defaults, ...cfg.projects?.[project] };
}
```

### Toggle Tool

```typescript
api.registerTool({
  name: "orchestrator_workflow_config",
  label: "Workflow Config",
  description: "Enable or disable workflow enforcement for a project.",
  parameters: Type.Object({
    project: Type.String({ description: "Project name." }),
    enforce: Type.Boolean({ description: "Enable workflow enforcement." }),
    qa_retries: Type.Optional(Type.Number({ description: "Max QA retries (default: 3)." })),
    auto_commit: Type.Optional(Type.Boolean({ description: "Auto git commit after QA (default: true)." })),
    skip_phases: Type.Optional(Type.Array(Type.String(), { description: "Phases to auto-skip." })),
  }),
  async execute(_id: string, params: any) {
    const cfg: DashboardConfig = readJSON(path.join(dataDir, "dashboard-config.json")) || {};
    cfg.projects = cfg.projects || {};
    cfg.projects[params.project] = cfg.projects[params.project] || {};
    cfg.projects[params.project].enforce_workflow = params.enforce;
    if (params.qa_retries !== undefined) cfg.projects[params.project].qa_retries = params.qa_retries;
    if (params.auto_commit !== undefined) cfg.projects[params.project].auto_commit = params.auto_commit;
    if (params.skip_phases !== undefined) cfg.projects[params.project].skip_phases = params.skip_phases;
    writeJSON(path.join(dataDir, "dashboard-config.json"), cfg);
    logger.info("config", `Workflow ${params.enforce ? "enabled" : "disabled"} for ${params.project}`);
    return txt({ ok: true, project: params.project, enforce_workflow: params.enforce });
  },
});
```

---

## 7. Dashboard Integration

### Live Agents JSON Extension

The `live-agents.json` file (already written by plugin hooks) gains workflow fields:

```json
{
  "agents": [
    {
      "agent": "Amy",
      "project": "genor-orchestrator-plugin",
      "task": "test-plugin-workflow",
      "model": "deepseek-v4-flash",
      "agent_status": "working",
      "action": "editing source",
      "workflow_phase": "work",
      "workflow_phase_index": 3,
      "workflow_total_phases": 6,
      "workflow_enabled": true,
      "qa_retries": 0,
      "qa_status": null
    }
  ]
}
```

### Dashboard UI (Python Sidecar)

The dashboard API at `http://localhost:8766` gets:

1. **`GET /api/workflow`** — Show workflow status for all projects
2. **`GET /api/workflow?project=<name>`** — Detailed workflow state for one project
3. **`POST /api/workflow/config`** — Toggle workflow enforcement

Dashboard UI additions:

```
┌─────────────────────────────────────────────────┐
│  🚧 Workflow Dashboard                          │
├─────────────────────────────────────────────────┤
│  Project           │ Phase    │ QA  │ Status    │
│────────────────────┼──────────┼─────┼───────────│
│ genor-orchestrator │ work     │ 0/3 │ 🟢 Active │
│ kotw               │ disabled │ —   │ ⚪ Off    │
│ kfinance           │ complete │ ✓   │ ✅ Done   │
└─────────────────────────────────────────────────┘
```

Each line shows:
- Project name (link to project page)
- Current workflow phase (color-coded)
- QA retry count (0/3, 3/3 → red)
- Overall status indicator

### Phase Timeline Visualization

For a completed workflow, the dashboard shows a timeline:

```
analyze ── plan ── document ── work ── log ── finish ── QA (PASS) ── ✅
  09:00     09:05    09:10       09:20   09:25   09:30       09:35       09:36
```

---

## 8. Failure Modes

### Failure Mode 1: QA Fails 3 Times

```
Trigger: QA subagent returns FAIL for the 3rd time
Behavior:
  - Phase set to "escalated"
  - Session logged with qa_passed: false, qa_retries: 3
  - Task still marked complete (doesn't block the agent forever)
  - A prominent ⚠️ is added to the session log
  - The session note says: "QA FAILED after 3 retries. Manual review needed."
  - Git auto-commit is SKIPPED
  - The development process continues; no hard block

Recovery:
  - A human can run QA manually and use /genor-git-commit to commit
  - The workflow_advance tool can restart QA: workflow_advance(to="finish", restart_qa=true)
```

### Failure Mode 2: Phase Order Broken

```
Trigger: Agent goes directly to "work" without "analyze" → "plan" → "document"
         Or: Agent skips "log" and goes straight to session end

Behavior:
  - Soft enforcement: prompt injection always shows the current (incorrect) phase
  - On session_end: if phase < "work", the session is logged with workflow_skipped: true
  - QA subagent still runs, but gets a warning: "Incomplete workflow: analyze/plan/document phase was started but not completed"
  - The session log shows: "⚠️ Workflow phases skipped. analyze→work was automatic."
  - No hard block — the agent still completes.

Mitigation:
  - The LLM-sees-its-phase design means future prompts remind the agent of the gap
  - Phase history in live-agents.json reveals skipped phases for audit
```

### Failure Mode 3: Agent Ignores Workflow Entirely

```
Trigger: Agent doesn't call workflow_advance, doesn't respond to prompt injections

Behavior:
  - Phase stays at "analyze" (or wherever it was initialized)
  - On session_end: the gate detects phase < "finish" and:
    1. Auto-advances to "log" → "finish" (filling with timestamps)
    2. Spawns QA (which will likely fail due to minimal/absent verification)
    3. Logs as "workflow_ignored: true"
  - Future sessions for the same project will re-start the workflow from analyze

Mitigation:
  - Phase auto-advance prevents infinite loops
  - The prompt injection makes it hard to ignore — it's in the context every turn
```

### Failure Mode 4: QA Subagent Fails to Start

```
Trigger: sessions_spawn fails, or QA subagent crashes

Behavior:
  - Error caught in the hook
  - Phase stays at "finish" (never transitions to "qa")
  - Session completes without QA verification
  - Session logged with qa_errored: true
  - A control action is written: `qa_retry: <project>` so the next maintenance tick retries

Recovery:
  - Next maintenance tick detects qa_errored entries and re-attempts
  - Human can run `/genor-git-commit` to manually complete
```

### Failure Mode 5: Phase Backwards Move

```
Trigger: Agent calls workflow_advance(to="analyze") while in "work"

Behavior:
  - Allowed, but logged as a warning: "Phase regression: work → analyze"
  - The phase history records the regression:
    [{phase:"analyze", entered_at:"09:00"}, {phase:"plan",...}, 
     {phase:"work",...}, {phase:"analyze", entered_at:"09:30"}]
  - No limits on regression — it's a legitimate pattern for re-analysis

Mitigation:
  - QA will catch if this regression was unnecessary
  - Phase history provides full audit trail
```

### Summary Table

| Failure Mode | Severity | Blocking? | Recovery |
|-------------|----------|-----------|----------|
| QA fails 3x | Medium | No | Manual review + commit |
| Phase order broken | Low | No | Auto-logged, audit trail |
| Agent ignores workflow | Low | No | Auto-advance + audit |
| QA subagent crash | Medium | No | Next maintenance tick retries |
| Phase regression | Low | No | Phase history documents it |

---

## 9. Implementation Plan

### Files to Change

| File | Changes |
|------|---------|
| `src/index.ts` | Add workflow state machine, phase tracking, QA spawning logic, new tools, modify existing hooks |
| `openclaw.plugin.json` | Add new tool names to `contracts.tools` |
| `README.md` | Document workflow enforcement feature |
| `skill/SKILL.md` | Update orchestration documentation with workflow phase instructions |

### Files to Create

| File | Purpose |
|------|---------|
| `src/workflow.ts` | Workflow state machine, phase logic, config helpers (extracted from index.ts for manageability) |
| `src/qa-subagent.ts` | QA subagent spawn, result parsing, retry logic |
| `src/git-integration.ts` | Git commit auto-trigger after QA pass (reuses existing logic) |

### Order of Changes

```
Phase 1: Foundation (single PR)
├── Step 1: Add types + interfaces for workflow state
│   - WorkflowPhase enum, PhaseHistoryEntry, WorkflowConfig
│   - Add workflow fields to SessionTracker class
│
├── Step 2: Implement core state machine
│   - advancePhase(), getWorkflowConfig(), shouldEnforceWorkflow()
│   - writeWorkflowState(), readWorkflowState()
│   - PHASE_ORDER constant
│
├── Step 3: Modify existing hooks
│   - session_start: Initialize phase to "analyze"
│   - before_prompt_build: Inject phase + checklist into prompt
│   - session_end: Gate with QA spawn
│   - subagent_ended: Process QA result, trigger commit
│   - agent_end: Warning if phase incomplete
│
└── Step 4: Add per-project config support
    - Extend DashboardConfig interface
    - Add workflow fields to dashboard-config.json schema
    - Create orchestrator_workflow_config tool

Phase 2: QA Subagent (separate PR)
├── Step 1: Build QA subagent spawning logic
│   - qa-subagent.ts with spawnQASubagent()
│   - QA prompt template
│   - Result file reading
│
├── Step 2: Implement retry loop
│   - qaRetries counter on SessionTracker
│   - Previous attempt context injection
│   - 3-retry cap with escalation
│
└── Step 3: Hook integration (subagent_ended handler)

Phase 3: Auto-Git-Commit (separate PR)
├── Step 1: Extract git commit logic from slash command handler
│   - Move to git-integration.ts as reusable function
│   - autoGitCommit() called from QA success path
│
└── Step 2: Wire into QA pass handler in subagent_ended hook

Phase 4: Dashboard + Polish (separate PR)
├── Step 1: Add workflow fields to live-agents.json
├── Step 2: Dashboard API endpoints (/api/workflow, /api/workflow/config)
├── Step 3: Dashboard UI widgets (phase bar, timeline)
├── Step 4: Maintenance tick: workflow phase timeout checks
└── Step 5: Update docs (README, SKILL.md)
```

### Testing Strategy

| Test Type | What | How |
|-----------|------|-----|
| Unit tests | Phase transitions, config parsing, sequence validation | `vitest` in `index.test.ts` |
| Hook integration | session_start phase init, session_end QA gate | Mock plugin API, verify hook behavior |
| QA subagent flow | Spawn, pass/fail detection, retry loop | Spawn real subagent, verify result file |
| Git commit flow | Auto-commit fires after QA pass, skip on QA fail | Controlled test repo, verify git log |
| Config toggle | Enable/disable per project, verify behavior change | Write/modify dashboard-config.json, test hooks |
| Edge cases | Phase regression, backwards move, skips, double-advance | Direct state manipulation + advance calls |

### Implementation Notes

- **No breaking changes**: All existing behavior is preserved when `enforce_workflow` is `false` (the default)
- **TypeScript first**: All new types go at the top of the file, near existing interfaces
- **Extract when large**: If `workflow.ts` + `qa-subagent.ts` + `git-integration.ts` exceed 300 lines total, keep in `index.ts` for simplicity; extract only if the plugin grows significantly
- **QA subagent isolation**: QA subagents use `context: "isolated"` to avoid contaminating the main agent's context
- **Git commit extraction**: The existing `/genor-git-commit` command handler's logic should be extracted into `git-integration.ts` as a pure function, then re-imported by the command handler and the QA pass handler

---

## Appendix A: Phase Advancement Flow (Sequence Diagram)

```
Agent                    Plugin Hooks                    QA Subagent
  │                          │                              │
  │── orchestrator_set_context ──►│                          │
  │                          │── starts phase: analyze       │
  │                          │                              │
  │── [thinks/reads code]    │                              │
  │                          │── before_prompt_build:        │
  │                          │   "Phase: analyze"           │
  │                          │                              │
  │── update_plan()          │                              │
  │                          │── [auto-detect or workflow_advance] │
  │                          │   Phase: analyze → plan      │
  │                          │                              │
  │── orchestrator_log_decision  ──►│                       │
  │                          │   Phase: plan → document     │
  │                          │                              │
  │── edit/write files       │                              │
  │                          │   Phase: document → work     │
  │                          │                              │
  │── orchestrator_log_session ──►│                         │
  │                          │   Phase: work → log          │
  │                          │                              │
  │── [session ends]         │                              │
  │                          │── Phase: log → finish        │
  │                          │── spawning QA subagent...    │
  │                          │                              │
  │                          │                              │── runs checks
  │                          │                              │── PASS or FAIL
  │                          │                              │
  │                          │◄──── QA result ─────────────│
  │                          │                              │
  │                          │── PASS? → auto-git-commit   │
  │                          │          → Phase: complete  │
  │                          │          → Log session      │
  │                          │                              │
  │                          │── FAIL? + retries < 3?      │
  │                          │   → Re-spawn QA             │
  │                          │                              │
  │                          │── FAIL? + retries = 3?      │
  │                          │   → Phase: escalated         │
  │                          │   → Complete (with QA fail) │
  │                          │                              │
```

## Appendix B: Data Types

```typescript
// ── Workflow Types ──────────────────────────────────────

type WorkflowPhase = "analyze" | "plan" | "document" | "work" | "log" | "finish" | "qa" | "complete" | "escalated";

const WORKFLOW_PHASE_ORDER: ReadonlyArray<WorkflowPhase> = [
  "analyze", "plan", "document", "work", "log", "finish"
];

interface PhaseHistoryEntry {
  phase: string;
  entered_at: string;  // ISO timestamp
  note?: string;
}

interface WorkflowState {
  phase: WorkflowPhase;
  enabled: boolean;
  phase_history: PhaseHistoryEntry[];
  qa_retries: number;
  qa_max_retries: number;
  qa_status: "pending" | "running" | "passed" | "failed" | "escalated" | null;
  qa_result: QAResult | null;
  auto_commit: boolean;
  session_workflow_skipped: boolean;
}

interface QAResult {
  passed: boolean;
  attempt: number;
  reason: string | null;
  details: Record<string, string>;  // e.g., { build: "passed", tests: "failed: 2 tests" }
  timestamp: string;
}

interface WorkflowConfig {
  enforce_workflow: boolean;
  qa_retries: number;
  qa_timeout_minutes: number;
  auto_commit: boolean;
  skip_phases: string[];
}

// Extended SessionTracker additions:
//   workflowPhase: WorkflowPhase = "analyze"
//   phaseHistory: PhaseHistoryEntry[] = []
//   qaRetries: number = 0
//   qaMaxRetries: number = 3
//   isQARunning: boolean = false
//   qaResult: QAResult | null = null
//   workflowEnabled: boolean = false
```

---

*End of design document. Draft for review before implementation.*
