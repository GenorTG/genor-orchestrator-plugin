# Genor's Orchestrator — OpenClaw Plugin

[![ClawHub](https://img.shields.io/badge/ClawHub-genor--orchestrator--plugin-blue)](https://clawhub.com/packages/genor-orchestrator-plugin)
[![License: MIT-0](https://img.shields.io/badge/License-MIT--0-brightgreen)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/GenorTG/genor-orchestrator-plugin)](https://github.com/GenorTG/genor-orchestrator-plugin/releases)
![Version](https://img.shields.io/badge/version-0.6.1-blue)
![Tools](https://img.shields.io/badge/tools-22-success)
![Hooks](https://img.shields.io/badge/hooks-8-ff69b4)

> **✨ 22 tools + 8 lifecycle hooks that turn OpenClaw into an AI-powered project orchestration powerhouse.** Model routing, session logging, live agent tracking, active-project binding, context injection, ADR management, workflow phase enforcement, a built-in dashboard — all inside OpenClaw with zero external processes.

The orchestrator doesn't take over your thinking. It handles the scaffolding so your LLM can focus on what matters: **coding, solving problems, and building cool stuff.** 🚀

---

## 🚀 What's New in v0.6.0

The jump from 12 → 22 tools brings **six major features** that make the orchestrator smarter about *who* is working on *what* and *why*:

| # | Feature | What It Does |
|---|---------|-------------|
| 🔒 | **Session-Project Binding** | Once a session sets context on project X, it's **locked**. Switch projects? Call `release_project` first. One session, one project. No cross-contamination. |
| 🚫 | **Hook Scoping** | Unregistered sessions are *invisible* to the plugin — no live-agent bleed, no unwanted context injection, no routing noise. |
| 🧹 | **Orphaned Project Cleanup** | `orchestrator_doctor` detects dead/empty projects (0 sessions) and archives them to `.archived/` automatically. |
| 🔍 | **Active Project Discovery** | `list_active_projects` + `join_project` let ad-hoc sessions discover and contribute to running work. |
| 📋 | **Project Health Enforcement** | Every project needs `STATE.md`. Doctor reports gaps, auto-creates with metadata, flags stale sessions. |
| 🤖 | **Subagent Spawning** | `spawn_subagent` routes model choice, injects full project context, and logs subagent sessions under the parent project. |

---

## 📋 Quick Start

### For AI Agents

> **Copy-paste to any AI agent:** *"Install Genor's Orchestrator from https://github.com/GenorTG/genor-orchestrator-plugin.git"*

The agent will:
1. `git clone --recurse-submodules` the repo
2. Read `SETUP.md`
3. Execute the 7-step installation procedure

Done. The plugin auto-creates data dirs, schedules nightly model sync, and runs background maintenance every 30 minutes. ⏰

### Via ClawHub

```bash
clawhub package install genor-orchestrator-plugin
```

### From Source

```bash
git clone --recurse-submodules https://github.com/GenorTG/genor-orchestrator-plugin.git
cd genor-orchestrator-plugin
npm install
npm run plugin:build
```

Then add `genor-orchestrator-plugin` to your OpenClaw `plugins.load.paths` config and restart.

### Sanity Check

```bash
# Check the dashboard is live
openclaw curl /orchestrator/status

# Verify the plugin loaded
openclaw plugins list | grep orchestrator
```

---

## 🔧 Tool Reference

Every tool is registered with full metadata for OpenClaw agent injection — AI agents see these as first-class tools in their tool belt. Here they all are, all **22** of them:

### 📋 Registration & Lifecycle

#### `orchestrator_register`
> 🎟️ **Opt in to orchestrator tracking.** Required first step before anything else.

```typescript
orchestrator_register()
// → "registered" | "already registered"
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| *(none)* | | | Just call it. |

**When to use:** Every time you start a new session that will do project work. No registration = the orchestrator is invisible to you.

---

#### `orchestrator_unregister`
> 🚪 **Remove this session from orchestrator tracking.** Clears project binding, context, and stops all tracking.

```typescript
orchestrator_unregister()
// → "unregistered"
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| *(none)* | | | Just call it. |

**When to use:** When project work is complete or the session should no longer be tracked. Also cleans up stale registrations.

---

### 🎯 Context Management

#### `orchestrator_set_context`
> ⭐ **THE most important tool. Mandatory before starting project work.** Sets the active project and task, enabling auto-routing, auto-logging, and context injection. Once called, this session is **locked** to this project until `orchestrator_release_project`.

```typescript
orchestrator_set_context(
  project: "my-project",
  task: "Add delete button to settings page. Currently the settings page has no delete functionality. Requires: new DELETE route in settings.ts, confirmation dialog component, backend endpoint."
)
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `project` | `string` | ✅ | Project name (e.g., `kfinance`, `kotw`). |
| `task` | `string` | ✅ | What you're about to do — concise bullet list. Include what, why, and scope. |
| `original_prompt` | `string` | ❌ | The user's original request. Captured for traceability. Truncated to 500 chars. |

**When to use:** Before starting ANY project work. Calling this is the moment the orchestrator starts helping you — routing models, logging sessions, injecting project context.

---

#### `orchestrator_clear_context`
> 🧹 **Clear active project context.** Disables auto-routing and auto-logging. Note: **does NOT release the session-project binding** — use `orchestrator_release_project` for that.

```typescript
orchestrator_clear_context()
// → { ok: true, previous_project: "my-project" }
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| *(none)* | | | Just call it. |

**When to use:** You want to stop working for now. Context is cleared but binding persists — you can `set_context` back to the same project without issues.

---

#### `orchestrator_release_project`
> 🔓 **Unlock the session-project binding.** Once released, you can `set_context` to a different project.

```typescript
orchestrator_release_project()
// → { ok: true, released_project: "my-project", message: "..." }
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `force` | `boolean` | ❌ | Force release even if migration in progress (default: `false`). |

**When to use:** You're done with project A and need to switch to project B. **This is the only way to unbind.**

---

### 📊 Status & Configuration

#### `orchestrator_get_status`
> 📈 **Quick overview pulse.** Model counts, session count, project list, free-only mode state.

```typescript
orchestrator_get_status()
// → { total_models: 24, active_models: 24, agent_ready_models: 11, sessions_logged: 42, projects: [...], free_only_mode: false }
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| *(none)* | | | Just call it. |

**When to use:** Whenever you want to know the state of things at a glance.

---

#### `orchestrator_get_config`
> ⚙️ **Read the full routing configuration.** Free-only mode, disabled models, per-project allowlists, provider breakdown.

```typescript
orchestrator_get_config()
// → { free_only_mode: false, disabled_models: [], projects: [...], total_models: 24, providers: {...}, project_count: 3 }
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| *(none)* | | | Just call it. |

**When to use:** Check what's configured before investigating model routing issues.

---

### 🤖 Model Management (5 tools)

#### `orchestrator_get_models`
> 🎯 **List and filter the model inventory.** Powerful filtering by status, provider, search, project routing, and agent-ready flag.

```typescript
orchestrator_get_models(status: "active", agent_ready: true)
// → { total: 24, filtered: 11, models: [...] }
orchestrator_get_models(project: "my-project", provider: "openai")
// → { ... filtered by project routing + provider }
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `status` | `string` | ❌ | Filter: `active`, `discovered`, `offline`, `removed`. Comma-separated. |
| `provider` | `string` | ❌ | Partial match on provider name. |
| `search` | `string` | ❌ | Search model ID or name. |
| `agent_ready` | `boolean` | ❌ | Filter by the agent_ready flag. |
| `project` | `string` | ❌ | Apply project routing filters to the results. |

**When to use:** Discovering what models are available, checking which are agent-ready, inspecting project-specific eligibility.

---

#### `orchestrator_check_models`
> 🔍 **Preview model eligibility** for a specific project with all routing filters applied.

```typescript
orchestrator_check_models(project: "my-project")
// → { project: "my-project", filters_applied: [...], eligible_count: 11, total_available: 24, eligible_models: [...] }
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `project` | `string` | ❌ | Project name for per-project routing rules. Omit for global-only check. |

**When to use:** Debug model routing — see exactly which models are eligible for a project and which filters are being applied.

---

#### `orchestrator_auto_populate`
> 🔄 **Sync model inventory from OpenClaw gateway.** Scrapes the gateway config and merges into `models.json`, preserving any manual ratings you've set.

```typescript
orchestrator_auto_populate()
// → { success: true, total_models: 24, output: "..." }
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| *(none)* | | | Just call it. |

**When to use:** After installing new models or providers, or if the model inventory seems out of date. Also runs automatically nightly at 3 AM via cron. 🌙

---

#### `orchestrator_get_routing`
> 🧭 **Get the recommended model for a task category.** Returns ordered model list + best available model for the project + category combo.

```typescript
orchestrator_get_routing(category: "coding", project: "my-project")
// → { ok: true, recommended: "opencode-go/deepseek-v4-flash", fallbacks: [...], all: [...] }
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `category` | `string` | ✅ | `coding`, `fixing`, `research`, `q&a`, `documentation` |
| `project` | `string` | ❌ | Omit to use current project context. |

**When to use:** You want to pick a model explicitly based on task category rather than relying on auto-routing.

---

---

### 📝 Session & Decision Logging

#### `orchestrator_log_session`
> 📓 **Log a completed session.** Normally handled automatically by hooks, but available for manual logging or retroactive entries.

```typescript
orchestrator_log_session(
  project: "my-project",
  task: "Add delete button",
  model: "opencode-go/deepseek-v4-flash",
  agent: "Amy",
  status: "complete",
  notes: "• **Completed:** Added DELETE endpoint and confirmation dialog\n• **Decisions:** Used optimistic delete for better UX\n• **Blockers:** None"
)
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `project` | `string` | ✅ | Project name. |
| `task` | `string` | ✅ | Task description. |
| `model` | `string` | ✅ | Model ID used. |
| `agent` | `string` | ❌ | Agent name. |
| `status` | `string` | ❌ | `complete`, `blocked`, `in_progress`, `failed`. |
| `duration` | `string` | ❌ | e.g., `30min`. |
| `notes` | `string` | ❌ | Structured summary (Completed / Decisions / Blockers / Next). |
| `qa` | `boolean` | ❌ | QA checked flag. |
| `checked` | `boolean` | ❌ | Reviewed flag. |

**When to use:** Automatic hooks handle this 99% of the time. Use manually to log sessions that were missed or retroactively.

---

#### `orchestrator_log_decision`
> 📜 **Log an Architecture Decision Record (ADR).** Auto-numbered, stored as markdown. Keeps a permanent record of *why* you chose what you chose.

```typescript
orchestrator_log_decision(
  project: "my-project",
  title: "Chose optimistic delete over confirmation modal",
  context: "Users were complaining about the extra click",
  decision: "We chose optimistic delete with undo toast because it's faster and users prefer it",
  alternatives: "Modal with confirm (pro: safe, con: slow), Immediate delete (pro: simple, con: irreversible)",
  consequences: "• **Good:** Much faster UX, fewer clicks\n• **Risks:** Accidental deletes without undo? No — we show undo toast for 5s\n• **Requires:** Toast notification component"
)
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `project` | `string` | ✅ | Project name. |
| `title` | `string` | ✅ | Decision title. |
| `context` | `string` | ✅ | Why this decision was needed (2-3 sentences). |
| `decision` | `string` | ✅ | What was decided and why. |
| `alternatives` | `string` | ❌ | Options considered. |
| `consequences` | `string` | ❌ | Good/Risks/Requires format. |

**When to use:** After making any non-trivial decision. ADRs are auto-numbered and become a permanent, searchable record. Your future self will thank you. 🙏

---

#### `orchestrator_get_logs`
> 📋 **Query orchestration logs.** See routing decisions, model choices, session activity, config changes.

```typescript
orchestrator_get_logs(limit: 20, level: "info", source: "routing")
// → { entries: [...], total: 20, sources: ["routing"], levels: ["info"] }
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `limit` | `number` | ❌ | Max entries (default: 50). |
| `level` | `string` | ❌ | Minimum level: `debug`, `info`, `warn`, `error`. |
| `source` | `string` | ❌ | Filter by source (e.g., `routing`, `session`, `models`). |
| `since` | `string` | ❌ | ISO timestamp filter. |

**When to use:** Debugging what happened — why a certain model was chosen, when a session ended, what config changed.

---

### 📁 Project Management

#### `orchestrator_sync_project`
> 🔗 **Sync a project's files from disk into orchestrator-data.** Regenerates `CONTEXT.md` and `KEY_FILES.md` from the project source. Requires project location to be configured in `dashboard-config.json`.

```typescript
orchestrator_sync_project(project: "my-project")
// → { ok: true, project: "my-project", location: "/home/user/projects/my-project" }
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `project` | `string` | ✅ | Project name to sync. |

**When to use:** After major project changes, or when you want the orchestrator to regenerate its understanding of the codebase. Also runs automatically during maintenance ticks.

---

#### `orchestrator_get_project_docs`
> 📂 **List all orchestrator-managed documents** for a project: `CONTEXT.md`, `STATE.md`, `ROADMAP.md`, `RECOVERY.md`, `sessions.json`, `BACKLOG.json`, and more.

```typescript
orchestrator_get_project_docs(project: "my-project")
// → { project: "my-project", doc_count: 7, docs: ["CONTEXT.md", "STATE.md", "RECOVERY.md", ...] }
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `project` | `string` | ✅ | Project name. |

**When to use:** Check what documentation exists for a project, or confirm that the required docs are generated.

---

### 🏃 Workflow Enforcement

#### `orchestrator_advance_phase`
> 🏁 **Step through the coding workflow.** The orchestrator enforces a 6-phase workflow:
>
> **Analyze** → **Plan** → **Document** → **Work** → **Log** → **Finish**

```typescript
orchestrator_advance_phase()
// → { ok: true, phase: "plan", progress: "1/5", elapsed: "2m 30s" }

// Jump to a specific phase:
orchestrator_advance_phase(phase: "work")
// → { ok: true, phase: "work", ... }

// Skip the current phase:
orchestrator_advance_phase(skip: true)
// → { ok: true, phase: "document", ... }
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `phase` | `string` | ❌ | Target phase. Omit to auto-advance to next. |
| `skip` | `boolean` | ❌ | Mark current phase as skipped. |

**When to use:** After completing a phase of your coding workflow. Advance to keep the tracker in sync. Phases can be configured per-project via `dashboard-config.json`.

---

### 👥 Session Operations

#### `orchestrator_get_registered_sessions`
> 📋 **List all currently registered orchestrator sessions** with their project context, status, and activity.

```typescript
orchestrator_get_registered_sessions()
// → { ok: true, count: 3, registered_sessions: [...] }
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| *(none)* | | | Just call it. |

**When to use:** See who's registered, what projects they're working on, and which is the current session.

---

#### `orchestrator_list_active_projects`
> 🔍 **Discover projects with active sessions.** Shows project names, active session count, session keys, and doc health.

```typescript
orchestrator_list_active_projects()
// → { ok: true, active_project_count: 2, active_projects: [...], all_projects: [...] }
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| *(none)* | | | Just call it. |

**When to use:** See what's being worked on right now. Before joining a project, check what's active.

---

#### `orchestrator_join_project`
> 🏃 **Register + set context in one step** for ad-hoc sessions contributing to existing projects.

```typescript
orchestrator_join_project(
  project: "my-project",
  task: "Help with bug fix — the login form crashes on empty input"
)
// → { ok: true, joined_project: "my-project", registered: true, ... }
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `project` | `string` | ✅ | Project name. Use `list_active_projects` first. |
| `task` | `string` | ✅ | What you're joining to do. |

**When to use:** New ad-hoc sessions, subagents, or anyone who needs to jump into existing project work quickly.

---

### 🤖 Subagent Operations

#### `orchestrator_spawn_subagent`
> 🧠 **Spawn a subagent with orchestrator-managed project context.** Routes model choice, injects full project context, and logs the subagent session under the current project.

```typescript
orchestrator_spawn_subagent(
  task: "Refactor the auth module to use JWT",
  taskName: "auth_jwt_refactor",
  model: "opencode-go/deepseek-v4-flash",
  timeoutSeconds: 600
)
// → { ok: true, project: "my-project", task_name: "auth_jwt_refactor", spawn_instructions: "..." }
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `task` | `string` | ✅ | Task description for the subagent. |
| `taskName` | `string` | ❌ | Stable name (`lowercase_underscores`). |
| `model` | `string` | ❌ | Model override. Omit for auto-routing. |
| `timeoutSeconds` | `number` | ❌ | Timeout (default: 300, max: 1800). |

**When to use:** Delegate sidecar work — parallel tasks, isolated research, anything that benefits from its own session.

---

### 🩺 Diagnostics

#### `orchestrator_doctor`
> 🩺 **Diagnose and auto-fix common orchestrator issues.** Checks session keys, registration, stale data, context inconsistencies, orphaned projects, missing STATE.md docs, and project health. Includes auto-fix for most issues.

```typescript
// Quick check — what's wrong?
orchestrator_doctor()
// → { ok: false, issues_found: 3, issues: [...], ... }

// Auto-fix everything
orchestrator_doctor(fix: true)
// → { ok: true, issues_found: 3, fixes_applied: 3, fixes: [...], ... }

// Scope to a specific check
orchestrator_doctor(check: "sessions")
orchestrator_doctor(check: "data")
```

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `check` | `string` | ❌ | Check scope: `all` (default), `sessions`, `context`, `data`, `pm2` (legacy). |
| `fix` | `boolean` | ❌ | Auto-fix issues when possible (default: `false`). |

**When to use:** Things feel off — registration fails, context injection isn't firing, models aren't updating. Doctor covers **5 areas**:
| Check | What It Diagnoses | Auto-Fix |
|-------|------------------|----------|
| **sessions** | Missing/lost registration, synthetic key bridge issues | Registers sessions, bridges synthetic → real keys |
| **context** | Missing project context, mismatched session keys | Copies context from other sessions |
| **data** | Corrupt `models.json`, missing config, stale logs | Deletes corrupt files, removes stale live-agents |
| **pm2** | *(Legacy)* Bridge process for old dashboard | Auto-starts if bridge script still present |
| **projects** | Orphaned 0-session projects, missing STATE.md | Archives orphans, auto-creates STATE.md |

---

### 🎮 Slash Commands

Available in Discord and chat channels:

| Command | Description |
|---------|-------------|
| `/genor-help` | List all available commands |
| `/genor-dashboard` | Show dashboard URL |
| `/genor-status` | Quick orchestrator overview |
| `/genor-git-commit` | Auto-commit current project with version bump |
| `/genor-doctor` | Diagnose and fix issues |

---

## 🖥️ Dashboard — Built In

No PM2 process. No separate server. The dashboard is served directly by OpenClaw at the `/orchestrator` gateway route:

```
https://your-gateway/orchestrator
```

The dashboard handler is registered via `api.registerHttpRoute({ path: "/orchestrator", auth: "plugin", match: "prefix" })` — same pattern as built-in plugins like canvas and webhooks.

### 6 Tabs

| Tab | What You See |
|-----|-------------|
| **🏠 Home** | Model stats (24 total, 11 agent-ready), active projects, recent sessions, routable models, quick glance at everything |
| **📁 Projects** | Per-project deep dive: session history, generated docs (`CONTEXT.md`, `STATE.md`, `RECOVERY.md`, `KEY_FILES.md`), health status, active session list |
| **🧠 Models** | Full CRUD model inventory. Edit tier ratings, speed ratings, status, agent-ready flags. All changes persist to `models.json` |
| **🌐 Gateway** | Live OpenClaw gateway sessions — see every active session on the gateway |
| **📜 Logs** | Orchestration log with level filtering. Drill into routing decisions, session events, config changes |
| **🛡️ Safeguards** | Idle/stuck agent detection dashboard, error tracking, auto-recovery controls. All driven by the safeguard config |

### Live Agent Monitoring

Real-time agent state is written to `live-agents.json` on every hook event (debounced, coalesced at 500ms intervals). The dashboard consumes this for live monitoring — you see active agents with their project, task, model, action history, token usage, workflow phase, and elapsed time.

---

## ⚙️ Configuration

### `dashboard-config.json`

All project routing, workflow, and safeguard settings live in `~/.openclaw/workspace/orchestrator-data/dashboard-config.json`.

```json
{
  "free_only_mode": false,
  "disabled_models": [],
  "theme": "dark",
  "auto_refresh_seconds": 30,
  "projects": {
    "my-project": {
      "location": "/home/user/projects/my-project",
      "model_allowlist": ["opencode-go/deepseek-v4-flash", "openrouter/openai/gpt-oss-120b:free"],
      "free_only": false,
      "workflow": {
        "enabled": true,
        "include_qa": true,
        "auto_commit": true,
        "qa_retries": 3,
        "skip_phases": []
      },
      "model_routing": {
        "coding": ["opencode-go/deepseek-v4-flash", "openrouter/deepseek/deepseek-v4-flash"],
        "fixing": ["opencode-go/deepseek-v4-flash"],
        "research": ["openrouter/auto"],
        "q&a": ["opencode-go/deepseek-v4-flash", "openrouter/free"],
        "documentation": ["opencode-go/deepseek-v4-flash"]
      }
    }
  },
  "safeguards": {
    "enabled": true,
    "idle_timeout_ms": 300000,
    "stuck_timeout_ms": 600000,
    "max_errors_before_escalation": 5,
    "auto_recover": true,
    "tick_interval_ms": 60000
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `free_only_mode` | `boolean` | Force all projects to only use free models. |
| `disabled_models` | `string[]` | Globally disabled model IDs. |
| `theme` | `string` | Dashboard theme: `dark` or `light`. |
| `auto_refresh_seconds` | `number` | Dashboard auto-refresh interval. |
| `projects.{name}.location` | `string` | Absolute path to project source code. |
| `projects.{name}.model_allowlist` | `string[]` | Only these models are eligible for this project. |
| `projects.{name}.free_only` | `boolean` | Free models only for this project. |
| `projects.{name}.workflow.enabled` | `boolean` | Enable 6-phase workflow enforcement for this project. |
| `projects.{name}.workflow.include_qa` | `boolean` | Add QA step in workflow. |
| `projects.{name}.workflow.auto_commit` | `boolean` | Auto-commit + version bump on session end. |
| `projects.{name}.workflow.qa_retries` | `number` | Max QA attempts before escalation. |
| `projects.{name}.workflow.skip_phases` | `string[]` | Phases to skip in the workflow. |
| `projects.{name}.model_routing` | `object` | Per-category model routing. Keys: `coding`, `fixing`, `research`, `q&a`, `documentation`. |
| `safeguards.enabled` | `boolean` | Enable idle/stuck agent detection. |
| `safeguards.idle_timeout_ms` | `number` | Mark agent idle after this long without activity. |
| `safeguards.stuck_timeout_ms` | `number` | Mark agent stuck if no update for this long. |
| `safeguards.max_errors_before_escalation` | `number` | Error count before escalation. |
| `safeguards.auto_recover` | `boolean` | Auto-recover idle agents by writing `set_context` actions. |
| `safeguards.tick_interval_ms` | `number` | Safeguard check interval. |

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `ORCHESTRATOR_DATA_DIR` | Override orchestrator data directory path |
| `DASHBOARD_DIR` | Override dashboard static file directory |

### Plugin Config (in `openclaw.plugin.json`)

```json
{
  "orchestratorDataDir": "",
  "logLevel": "info",
  "logRetentionDays": 30,
  "dashboardPort": 8766,
  "maintenanceIntervalMs": 1800000
}
```

---

## 🔒 Session-Project Binding

This is the orchestrator's most important design concept. **One session = one project.** Period. Here's how it works:

### Flow Diagram

```
Session A ──register()──►  registered
     │
     ├──set_context("alpha", "fix bug")──►  ✅ Locked to "alpha"
     │                                      Binding: alpha
     │                                      Context: alpha / fix bug
     │
     ├──set_context("beta", "new feature")──►  ❌ Binding violation!
     │    "This session is already locked to alpha.
     │     Call release_project first."
     │
     ├──release_project()──►  🔓 Unbound
     │
     ├──set_context("beta", "new feature")──►  ✅ Now locked to "beta"
     │
     └──clear_context()──►  🔓 Context cleared, but binding to "beta" persists

Session B ──register()──►  registered
     │
     └──set_context("alpha", "different task")──►  ✅ Separate binding
        Session B is bound to "alpha".
        Session A is bound to "beta".
        No conflict!
```

### Why It Exists

| Problem | Solution |
|---------|----------|
| 🔀 Cross-project contamination | One session can only ever touch one project. No leaking state. |
| 🧩 Ad-hoc joiners | `join_project` handles registration + binding + context in one call — no ceremony |
| 🔄 Model routing isolation | Each project has its own `model_routing` and `model_allowlist`. Your routing rules don't mix. |
| 📊 Accurate logging | Every session log entry knows exactly which project it belongs to. |
| 🧹 Cleanup | `release_project` + `unregister` = clean slate. No orphaned state. |

### Key Distinctions

| Action | Clears Context? | Releases Binding? |
|--------|:-:|:-:|
| `clear_context` | ✅ Yes | ❌ No |
| `release_project` | ✅ Yes | ✅ Yes |
| `unregister` | ✅ Yes | ✅ Yes |

---

## 🧹 Doctor & Health

### orchestrator_doctor — The Swiss Army Knife 🛠️

The `orchestrator_doctor` tool runs **5 categories** of health checks:

1. **Session Health** — Is the session key set? Is it registered? Are there synthetic keys that need bridging to real gateway keys?
2. **Context Health** — Is there an active project? Do other sessions have context that should be copied?
3. **Data Health** — Is `models.json` valid? Is `dashboard-config.json` present? Are logs fresh? Is `live-agents.json` stale?
4. **Project Health** — Are there orphaned projects with 0 sessions? Are required docs (`STATE.md`) present? Track stale running sessions >24h.
5. **PM2 Health** — Is the bridge process running? (Legacy check — dashboard now runs via gateway route.)

### Background Maintenance

A `MaintenanceService` runs every 30 minutes and handles:
- 📋 Log rotation (30-day retention, auto-cleanup of expired entries)
- 🔄 Session JSON normalization (ensures schema v2 compatibility)
- 📝 Recovery doc generation (`RECOVERY.md`) for every active project
- 🔗 Project sync (`CONTEXT.md`, `KEY_FILES.md` regeneration)
- 🎮 Control action processing (dashboard → plugin commands via the `control/` directory)
- 🛡️ Stale agent detection + auto-recovery (idle timeout, stuck detection, error storms)
- 🔍 Hidden-directory filter (`.archived`, `.startsWith(".")` dirs excluded from all listings)

### Safeguards

The safeguard system runs on every maintenance tick:

| Condition | What Happens |
|-----------|-------------|
| Agent idle >10min | Warning logged, auto-recovery action written |
| Agent stuck >30min (no update) | Warning logged with elapsed time |
| Error storm ≥max_errors | Escalation alert logged |
| Auto-recovery enabled | Writes a `set_context` action for the idle project |

All events are logged to `safeguard-log.md` in the data directory.

---

## 🐛 Common Issues & Fixes

### Auto-populate Temp File Rename

**Issue:** If the auto-populate script crashes mid-write, a `.tmp` file may be left behind in `orchestrator-data/`.

**Fix:** The plugin uses atomic writes (`writeJSON`: write to `.tmp`, then `renameSync` to final). If you see a `.tmp` file, just delete it. The next write will succeed.

### Stale Sessions

**Issue:** Sessions show as "running" but the gateway restarted long ago.

**Fix:** Run `orchestrator_doctor(fix: true)` — it detects sessions with `status: "running"` aged >24h and flags them. Manually clear with `orchestrator_unregister()` followed by a fresh `orchestrator_register()`.

### `.archived` Directory Recreated

**Issue:** You archived a project but it keeps reappearing.

**Fix:** This is by design — the `projDir()` function creates project dirs when `set_context` is called. If you archive an active project, `set_context` recreates it. Solution: release the project binding first, then archive.

### Synthetic Key → Real Key Bridge

**Issue:** Context injection isn't working. You register but hooks don't see the registration.

**Cause:** The gateway generates real session keys on hook events, but `orchestrator_register` may fall back to a synthetic fallback key (`agent:main:auto:...`). The bridge logic in `before_model_resolve` and `before_prompt_build` handles this by copying context from the synthetic key to the real gateway key.

**Fix:** Run `orchestrator_doctor(fix: true)` — the session health check bridges synthetic keys automatically.

### Dashboard Not Loading

**Issue:** Dashboard shows blank or 404 at `/orchestrator`.

**Check:**
1. Is the plugin loaded? → `openclaw plugins list | grep orchestrator`
2. Is the route registered? → Check the gateway's routing table
3. Is the dashboard handler building correctly? → Check plugin logs for "Dashboard handler registered" or errors

### Models Showing 0

**Issue:** `orchestrator_get_status` shows 0 models.

**Fix:** Run `orchestrator_auto_populate()` to sync from the gateway. If that fails, check that `models.json` exists in `orchestrator-data/`.

---

## 🗂️ Data Structure

All data lives on the filesystem at `~/.openclaw/workspace/orchestrator-data/` — **survives gateway restarts, plugin reinstalls, and even wipes.** 🔒

```
orchestrator-data/
├── models.json              # Model inventory (24 entries)
├── dashboard-config.json    # Routing config, projects, safeguards
├── live-agents.json         # Real-time agent state (debounced)
├── state.json               # Quick state snapshot
├── session_log.md           # Legacy flat session log
├── price_changes.log        # Decision log (ADR index)
├── safeguard-log.md         # Safeguard recovery events
├── .archived/               # Archived empty projects
├── logs/
│   └── orchestrator.jsonl   # JSONL orchestrator log
├── sessions/                # Individual session detail files
├── adrs/                    # Architecture Decision Records (markdown)
├── projects/
│   ├── my-project/
│   │   ├── CONTEXT.md       # Auto-generated from source
│   │   ├── STATE.md         # Project state (required)
│   │   ├── KEY_FILES.md     # File index
│   │   ├── RECOVERY.md      # Auto-generated recovery doc
│   │   ├── ROADMAP.md       # Roadmap (manual)
│   │   ├── BACKLOG.json     # Backlog (manual)
│   │   ├── sessions.json    # Per-project session log (schema v2)
│   │   └── adr/             # Per-project ADRs
│   ├── other-project/
│   └── .archived/           # Orphaned/archived projects
└── control/                 # Dashboard → plugin action queue
    ├── action_xxx.action.json
    └── action_xxx.result.json
```

---

## 📜 Full Changelog

| Version | Highlights |
|---------|-----------|
| **v0.6.1** | 🛠️ **Process & infrastructure.** GitFlow branching (`dev`/`main`), GitHub Actions CI (build + type-check + tests on every PR), branch protection rules, VERSIONING.md with MAJOR.MINOR.PATCH scheme, all versions normalized to 0.6.1. `openclaw.plugin.json` contracts rebuilt. |
| **v0.6.0** | 🎯 **22 tools, 8 hooks, 6 new features.** Session-project binding, hook scoping, orphaned project cleanup, active project discovery + joining, project health enforcement (`STATE.md`), subagent spawning. Dashboard migrated to native `/orchestrator` route — **no PM2 needed**. `orchestrator_doctor` with 5 check categories + auto-fix. Safeguard auto-recovery writes recovery actions. Hidden-dir filter across all listings (`.archived` excluded). All 8 hooks fully operational: `session_start`, `session_end`, `subagent_spawned`, `subagent_ended`, `before_model_resolve`, `before_prompt_build`, `agent_end`, `gateway_stop`. |
| **v0.5.0** | 🗺️ Slash commands restructured — monolithic `/genor` replaced with `/genor-COMMAND` pattern. Added `/genor-git-commit` (auto-commit + version bump). Session key filter for background/dreaming/cron sessions. |
| **v0.4.4** | 🔧 Session key fix — filter background/dreaming/cron/subagent sessions from `session_start` hook. Prevents key overwrites. |
| **v0.4.3** | 🏗️ ToolPluginMetadata compat (OpenClaw 2026.6.6+), live agent tracking via `live-agents.json`, function name cleanup, double-cron scheduling fix. |
| **v0.4.2** | 📊 SessionTracker with `live-agents.json` file writer, debounced at 500ms. Error logging improvements. |
| **v0.4.1** | ✅ 12 tools verified working. `plugins.load.paths` fix. Dashboard v4 with SSE streaming. |
| **v0.4.0** | 🚀 Phase 1 complete: full tool audit, 9 bugs fixed. Model routing, session logging, ADR management, project sync all operational. |
| **v0.3.x** | 🏁 Initial dashboard implementation, server architecture refactors, basic model inventory. |

---

## 🏗️ Architecture

### High-Level Design

The orchestrator uses a **scoped, permission-based model** — sessions opt in, projects are bound, hooks are invisible to unregistered sessions.

```
                    ┌─────────────────────────────────────────┐
                    │          OpenClaw Gateway               │
                    │   /orchestrator (dashboard — built in)   │
                    └──────────────┬──────────────────────────┘
                                   │ hooks (8 total)
                    ┌──────────────▼──────────────────────────┐
                    │        Orchestrator Plugin               │
                    │                                          │
                    │  ┌─ SessionTracker (per-session) ──────┐ │
                    │  │  ├─ sessionProjectBinding  🔒        │ │
                    │  │  ├─ registeredSessions     🎟️        │ │
                    │  │  ├─ sessionContexts        📦        │ │
                    │  │  ├─ subagentRegistry       🤖        │ │
                    │  │  └─ projectActiveSessions  🔍        │ │
                    │  └──────────────────────────────────────┘ │
                    │                                          │
                    │  ┌─ WorkflowTracker (per-project) ─────┐ │
                    │  │  ├─ 6-phase workflow (Analyze→Finish)│ │
                    │  │  ├─ QA retries                      │ │
                    │  │  ├─ Auto-commit + version bump      │ │
                    │  │  └─ Skip-phase support              │ │
                    │  └──────────────────────────────────────┘ │
                    │                                          │
                    │  ┌─ MaintenanceService ────────────────┐ │
                    │  │  ├─ Log rotation (30-day retention) │ │
                    │  │  ├─ Safeguard detection + recovery  │ │
                    │  │  ├─ Control action processor        │ │
                    │  │  ├─ Project health checks           │ │
                    │  │  └─ Background sync (30min tick)    │ │
                    │  └──────────────────────────────────────┘ │
                    └──────────────┬──────────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────────┐
                    │     orchestrator-data/                   │
                    │  ├─ models.json          (24 models)    │
                    │  ├─ dashboard-config.json               │
                    │  ├─ live-agents.json     (debounced)    │
                    │  ├─ state.json                           │
                    │  ├─ safeguard-log.md                    │
                    │  ├─ logs/orchestrator.jsonl              │
                    │  ├─ projects/{project}/                 │
                    │  │   ├─ CONTEXT.md                      │
                    │  │   ├─ STATE.md      (required ✅)     │
                    │  │   ├─ KEY_FILES.md                    │
                    │  │   ├─ RECOVERY.md                     │
                    │  │   ├─ ROADMAP.md                      │
                    │  │   ├─ sessions.json (schema v2)       │
                    │  │   ├─ BACKLOG.json                    │
                    │  │   └─ adr/                            │
                    │  ├─ projects/.archived/                 │
                    │  └─ control/                            │
                    └──────────────────────────────────────────┘
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Session-Project Binding** 🔒 | Prevents cross-project contamination. One session = one project. Period. |
| **Registration Required** 🎟️ | Plugin is invisible until a session opts in via `orchestrator_register`. No leak, no noise. |
| **Binding > Context** 📐 | `clear_context` releases context but not binding. `release_project` unbinds. Two-stage for safety. |
| **Per-Session Context** 🧩 | Each session key has its own project context. No sharing, no cross-talk. |
| **Read-Only Project Dirs** 📁 | `getProjDir()` (returns null) replaces `projDir()` (creates dir) in maintenance paths to prevent orphan restoration. |
| **Hidden Dir Filter** 🕵️ | `.archived`, `.startsWith(".")` dirs excluded from dashboard, status, and maintenance ticks. |
| **Atomic Writes** 💾 | `writeJSON` uses `.tmp` → `renameSync` pattern. Crash-safe data writes. |
| **Debounced Live State** ⏱️ | All `writeLiveAgents` calls coalesce at 500ms intervals. Prevents disk thrashing on rapid hook events. |

### Hook Flow

```
                    session_start
                         │
                    orchestrator_register()
                         │
                    orchestrator_set_context()
                         │
                    ┌────▼────────────────────────────────────┐
                    │     before_model_resolve (auto-routing) │
                    │     🧠 Picks best model for project     │
                    └────┬────────────────────────────────────┘
                         │
                    ┌────▼────────────────────────────────────┐
                    │     before_prompt_build (context inj.)  │
                    │     📦 Injects project context + task    │
                    └────┬────────────────────────────────────┘
                         │
                         ▼    Agent works... 🏗️
                         │
                    subagent_spawned (depth +1) 🤖
                         │
                    subagent_ended (depth -1)
                         │
                    ┌────▼────────────────────────────────────┐
                    │     session_end                         │
                    │     📝 Auto-logs session                 │
                    │     🚀 Auto-commits (if enabled)         │
                    │     ⚡ Generates RECOVERY.md              │
                    └────┬────────────────────────────────────┘
                         │
                    orchestrator_unregister()
```

---

## 🤝 Contributing

This is a personal project by GenorTG, but contributions, issues, and ideas are welcome!

### Development

```bash
# Clone
git clone https://github.com/GenorTG/genor-orchestrator-plugin.git
cd genor-orchestrator-plugin

# Install deps
npm install

# Build
npm run build

# Build + validate as OpenClaw plugin
npm run plugin:build
npm run plugin:validate

# Test
npm test
```

### Project Structure

```
genor-orchestrator-plugin/
├── src/
│   ├── index.ts                    # Main plugin — 22 tools, 8 hooks, all logic
│   ├── dashboard-handler.ts        # Dashboard HTTP handler
│   └── index.test.ts              # Tests
├── dashboard/
│   └── index.html                  # Dashboard single-page HTML
├── openclaw.plugin.json           # Plugin metadata + config schema
├── SETUP.md                       # Step-by-step installation guide
├── README.md                      # You are here 📍
└── package.json                   # v0.6.1
```

---

## 📜 License

**MIT-0** — Free to use, modify, redistribute. No attribution required. Go build something awesome. 🚀

---

*Built with ❤️ by GenorTG for the OpenClaw ecosystem.*
