# Genor's Orchestrator — Architecture

> **Read this first. Maintain this. Drifts here break the whole product.**

## What This Plugin Is

A **plugin + dashboard** for OpenClaw that lets a user run **AI coding teams** on real software projects. You start/import a project, hire a team of AI workers (developer, QA, designer, reviewer, project manager), and the PM worker plans the work, delegates to coding workers, watches QA + reviews, and ships deliverables. Same shape as Cursor, Copilot Workspace, or any agentic coding tool — but for **whole teams** instead of a single assistant.

The user is the **product owner**. The plugin is the **delivery vehicle**. AI workers are the **team**.

## What This Plugin Is NOT

- ❌ A general-purpose task tracker (use Jira, Linear, etc.)
- ❌ A chatbot framework (use OpenClaw directly)
- ❌ A code reviewer (use dedicated tools — workers are best when paired with existing ones)
- ❌ A drop-in Cursor replacement (different abstraction: projects + teams vs single repo + chat)
- ❌ Hard-coded to any LLM provider (LM Studio, OpenAI, etc. — all generic OpenAI-compatible chat completions)
- ❌ A monolithic index.ts that does everything (modular slices only)

## Core Concepts

| Concept | Definition | Storage |
|---|---|---|
| **Project** | A software project with a git repo, kanban board, worker team, and memory trail | `projects` table, git repo on disk |
| **Worker** | A persistent AI persona with a role, model, system prompt, and current task | `workers` table |
| **Task** | A unit of work on the kanban board (todo → in_progress → review → done) | `backlog` table |
| **Worklog** | Audit trail of who did what, when, with what result | `worker_task_history`, `vault_docs/reports/` |
| **Connection** | A link between a task and the workers who touched it (author / QA / approver / tester) | `worker_task_history.action` enum |
| **Memory** | Cross-session knowledge that survives compaction (project docs, decisions, reports) | `vault_docs` table |

## Worker Roles (canonical)

- **Project Manager (PM)** — owns the backlog. Plans work, breaks down requirements, assigns tasks, watches blockers, ships. Has a tool to assign tasks, a tool to query worker status, a tool to escalate, a tool to read project docs.
- **Full-stack Developer** — implements features and fixes. Tools: read/write files, run shell, git operations, run tests.
- **QA Engineer** — reviews code, runs tests, finds bugs, reports findings. Tools: read files, run tests, file bugs (creates tasks).
- **Designer** — produces UI/UX, generates assets, writes specs. Tools: image generation, write files, read project docs.
- **Reviewer** — final pass before merge. Tools: read files, run tests, git diff.
- **DevOps** — manages CI, deploys, monitors. Tools: shell, git, cloud APIs.

Workers can be hired/fired, multiple of each role allowed, each has its own session in OpenClaw.

## The Lifecycle (this is the whole product)

```
┌──────────┐
│ Project  │  user creates/imports (git repo URL or local folder)
└────┬─────┘
     │
     ▼
┌──────────┐
│  Hire    │  user hires a team: PM + 2 devs + QA + reviewer
└────┬─────┘
     │
     ▼
┌──────────┐
│  Plan    │  PM worker reads the project, breaks work into tasks
└────┬─────┘  user approves the plan
     │
     ▼
┌──────────┐
│  Build   │  PM delegates tasks to dev workers
│          │  devs use tools: read files, edit, run tests, commit
└────┬─────┘  dev reports back with worklog + commits
     │
     ▼
┌──────────┐
│   QA     │  QA worker reviews code, runs tests
│          │  creates bug tasks if issues found
└────┬─────┘
     │
     ▼
┌──────────┐
│ Review   │  reviewer approves or rejects
│          │  approval = task moves to done
└────┬─────┘
     │
     ▼
┌──────────┐
│  Ship    │  PM creates PR, watches CI, merges
└──────────┘  worklog persisted, reports saved to vault
```

## How Workers Actually Work

Workers are **OpenClaw sessions** (one per worker, persistent). When a worker needs to act, the orchestrator spawns/continues that session with:

- A system prompt encoding the worker's role + project context + recent history
- A user message describing the current task
- Full tool-calling support (file ops, shell, git, project queries)

The session does the work, returns the result, the orchestrator records it. The session key is stable per worker (`agent:main:worker:<id>`) so OpenClaw tracks context across calls.

**Default LLM endpoint = OpenClaw's `/v1/chat/completions`**. Custom endpoints (LM Studio, vLLM, OpenRouter) configurable in plugin settings — must support OpenAI tool calling format.

## Memory & Documentation

- **Per-project vault** — markdown docs, decision logs, reports, indexed in `vault_docs`
- **Worklog** — every worker action recorded with timestamp, role, task, result
- **Project memory** — survives across sessions, queryable
- **PM has tools to read/write vault** — workers can leave notes for each other
- **Daily notes** — important decisions captured in the vault for posterity

## GitHub Integration

- Per-project git repo (clone or init from local)
- Branch per task or feature
- Workers create commits with conventional message format
- PM creates PRs, watches CI, merges
- Tests run automatically (workers can use shell)
- Status reported in worklog

## Dashboard (frontend)

Single page (`/orchestrator/software-house`):
- Project switcher
- Worker team (cards: name, role, status, current task)
- Kanban board (todo / in_progress / review / done)
- PM chat (talk to the PM worker, the actual PM)
- Worklog stream (live updates)
- Reports panel
- Settings (LLM endpoint, model per role, worker prompts)

A second page (`/orchestrator/projects.html`) for project management (create, import, delete, bulk ops).

**No more giant `software-house.html` (currently 117KB).** Split into modules: `<kanban-board>`, `<worker-card>`, `<pm-chat>` etc. via web components or separate JS files.

## Code Structure (target, not current)

```
src/
  index.ts              register + routes wiring + plugin SDK
  config.ts             LLM endpoint, OpenClaw config, defaults
  llm.ts                generic OpenAI-compatible client (configureLLM, callLLM)
  tools/
    file-tools.ts       read, write, list, search
    shell-tools.ts      exec, run-tests
    git-tools.ts        branch, commit, push, pr, merge
    project-tools.ts    assign-task, query-workers, read-vault
    session-tools.ts    spawn-worker, message-worker
  workers/
    engine.ts           spawn/continue worker sessions, track state
    roles.ts            role definitions + system prompt templates
    prompts.ts          prompt templates (per role, per task type)
  projects/
    manager.ts          create/import/delete/list projects
    git.ts              git operations (clone, branch, commit, push, PR, merge)
    kanban.ts           task board logic
  memory/
    vault.ts            project docs, reports, decisions
    worklog.ts          per-task audit trail
  store.ts              data access layer (db.ts wrapper, single source of truth)
  routes/
    projects.ts         /api/software-house/projects/...
    workers.ts          /api/software-house/workers/...
    kanban.ts           /api/software-house/backlog/...
    chat.ts             /api/software-house/pm/chat
    health.ts           /api/software-house/backend/health
dashboard/
  index.html            entry, routes to pages
  projects.html         project management
  software-house.html   team + kanban + chat
  store.js              frontend DataStore client
  components/
    kanban-board.js
    worker-card.js
    pm-chat.js
    worklog.js
tests/
  *.test.ts             unit tests (vitest)
  *.spec.ts             e2e (playwright)
```

**No file over 30KB.** `index.ts` (currently 320KB) gets sliced into the above.

## LLM Layer (current generic client is correct)

`llm.ts`:
- `LLMConfig` interface (endpoint, token, defaultModel, defaultMessageChannel, timeoutMs)
- `configureLLM(patch)` — set once at plugin register
- `getLLMConfig()` — read-only snapshot
- `callLLM(opts): Promise<CallLLMResult>` — single client
- Returns `{ content, toolCalls?, raw }` so tool calls aren't lost
- Tool call support: `tools`, `toolChoice` (auto/none/required/function)
- `checkLLMHealth()` — generic health check (any /v1/models endpoint)

**Default endpoint = OpenClaw** at `http://127.0.0.1:18789/v1/chat/completions`. Auto-configured on plugin install (reads `api.config.gateway.port` + `auth.token`). Custom endpoints via plugin config or env vars.

**Workers are NOT called via `callLLM` directly.** Workers are OpenClaw sessions. `llm.ts` is a low-level utility for cases where direct chat completion is needed (e.g. PM chat UI previews, fallback when session broken). The real work goes through `workers/engine.ts` → `sessions_spawn` or chat completions with session-key headers.

## Plugin Settings (openclaw.plugin.json)

```json
{
  "llmEndpoint":      "http://127.0.0.1:18789/v1/chat/completions",
  "llmAuthToken":     "<auto: openclaw gateway token>",
  "llmDefaultModel":  "openclaw",
  "llmMessageChannel": "orchestrator-software-house",
  "defaultWorkerModel": "openclaw/main",
  "autoAssignTasks":   true,
  "autoRunTests":      true,
  "createPrOnDone":    true
}
```

## Anti-Patterns (do not reintroduce)

1. **Hardcoded LM Studio / provider strings** — always generic OpenAI-compatible
2. **Direct SQL outside `db.ts`** — all data access through `store.ts`
3. **Raw `fetch()` in frontend** — use `DataStore` class
4. **Monolithic `index.ts`** — keep files under 30KB
5. **Generic "AI agent" language** — use the canonical worker roles
6. **Bypassing the PM worker** — task assignment goes through PM, not user clicks
7. **Silent tool calls** — every tool call logged in worklog
8. **Drift from the lifecycle** — every new feature must fit the Plan → Build → QA → Review → Ship flow

## Definition of Done (worker task)

A task is done when:
1. All commits pushed to its branch
2. Tests pass (worker ran them)
3. QA worker approved (filed no unresolved bugs)
4. Reviewer worker approved
5. PM worker created a PR (if `createPrOnDone`)
6. Worklog captured: who, what, when, result, files changed
7. Report saved to `vault_docs/reports/task-<id>-report.md`

## Definition of Done (plugin release)

- All tests pass (`npm test`, `npm run test:playwright`)
- TypeScript builds clean (`npm run build`)
- Lint clean
- This ARCHITECTURE.md updated if anything changed
- `STATE.md` regenerated
- CHANGELOG entry added
