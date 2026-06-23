# 🏢 Genor Software House — Master Design Document

> **Status:** Design Phase  
> **Version:** 1.0  
> **Plugin:** genor-orchestrator-plugin  
> **Goal:** Turn the Orchestrator into a visual software house where you manage a team of AI agents, track projects, create documentation, and oversee work from a unified dashboard.

---

## 🎯 Vision

> *"You're not managing tasks. You're running a software house."*

Genor Software House is an **AI-native project management & execution environment** built on top of the OpenClaw plugin system. It combines:

- Visual **office canvas** — agents at desks, visible work status
- **PM Orchestrator** — always-available chat-based project manager
- **Kanban pipeline** — tasks flow automatically through phases
- **Document system** — Obsidian-style markdown vault per project
- **Grill-me validation** — in-depth interview flow to stress-test plans
- **Agent management** — hire, configure models/prompts, oversee work

You are the **client/owner**. The PM Orchestrator is your **software house director**. Agents are your **employees**.

---

## 🗺️ Complete User Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. CREATE PROJECT                                                │
│    /pm new project --name "MySaaS"                               │
│    → PM asks clarifying questions (grill-me style)               │
│    → PM generates: PRD, architecture doc, task breakdown         │
│    → Project vault created with docs                             │
├─────────────────────────────────────────────────────────────────┤
│ 2. BUILD THE TEAM                                                │
│    PM proposes agents based on project needs                     │
│    You can: accept, reject, modify, add your own                 │
│    Each agent gets:                                              │
│      • Model assignment (DeepSeek V4 Pro, MiniMax M3, etc.)     │
│      • System instructions (role, expertise, constraints)        │
│      • Icon/emoji and desk on the office canvas                  │
├─────────────────────────────────────────────────────────────────┤
│ 3. PLAN & VALIDATE                                               │
│    Grill-me session with PM:                                     │
│      "I'm the client. Grill me about this project."             │
│    PM interviews relentlessly about every aspect                 │
│    Decisions documented in the project vault                     │
│    Tasks refined based on interview results                      │
├─────────────────────────────────────────────────────────────────┤
│ 4. EXECUTE                                                       │
│    Orchestrator dispatches tasks to agents                       │
│    Pipeline: Backlog → In Progress → Review → Done              │
│    Office canvas shows real-time status                          │
│    Click agent → see context usage, progress, current task       │
│    PM chat available for course corrections                      │
├─────────────────────────────────────────────────────────────────┤
│ 5. REVIEW & ITERATE                                              │
│    Dedicated review agent checks completed work                  │
│    PM validates deliverables                                     │
│    Documents updated with decisions and history                  │
│    Project history maintained for future reference               │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🏗️ System Architecture

### Core Components

```
┌──────────────────────────────────────────────────────────────────┐
│                     GenorBoard Dashboard                          │
│                                                                   │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ Office View  │  │  PM Chat     │  │  Project Documents     │  │
│  │ (Canvas)     │  │  (Sidebar)   │  │  (Obsidian-style)      │  │
│  │              │  │              │  │                        │  │
│  │ 🦊👨‍💼 🐺👨‍💻  │  │ PM: "Let's   │  │ 📄 PRD.md               │  │
│  │ 🐉🎨 🦉💤   │  │  plan..."    │  │ 📄 Architecture.md     │  │
│  │ 🦅🔍 ✍️☕   │  │              │  │ 📄 Tasks.md            │  │
│  │              │  │ You: "..."   │  │ 📄 Decisions.md        │  │
│  └─────────────┘  └──────────────┘  └────────────────────────┘  │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Pipeline Bar: 📥 Backlog | ⚡ In Progress | 👁️ Review | ✅ Done │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Orchestrator Engine                            │
│                                                                   │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐ │
│  │ Task       │  │ Agent      │  │ Session    │  │ Document   │ │
│  │ Dispatcher │  │ Manager    │  │ Manager    │  │ Manager    │ │
│  │            │  │            │  │            │  │            │ │
│  │ Assigns    │  │ Configures │  │ Spawns     │  │ Creates    │ │
│  │ tasks to   │  │ models,    │  │ isolated   │  │ and syncs  │ │
│  │ agents     │  │ prompts,   │  │ sessions   │  │ markdown   │ │
│  │ based on   │  │ status     │  │ for agents │  │ docs       │ │
│  │ skills     │  │            │  │            │  │            │ │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘ │
└──────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌──────────────────────────────────────────────────────────────────┐
│                     Data Layer (SQLite)                            │
│                                                                   │
│  agents │ project_phases │ kanban_tasks │ task_activity           │
│  project_docs │ grill_sessions │ agent_sessions │ review_log     │
└──────────────────────────────────────────────────────────────────┘
```

---

## 🖥️ Dashboard Views

### 1. Office Canvas (Main View)

**Purpose:** Visual representation of your software house. You "walk through" the office and see agents working.

**Features:**
- **Agent desks** — SVG-rendered workstations with monitors, keyboards, personal items
- **Status indicators** — working (orange pulse), reviewing (purple), idle (gray), blocked (red)
- **Task indicator** — floating badge showing current task name
- **Click agent** → detail modal:
  - Current task + progress bar
  - Model, context usage (`42k/977k tokens`)
  - System instructions (editable)
  - Assigned tasks list
  - Option to reassign, pause, or change instructions
- **Empty desks** — click to hire new agent
- **Desk arrangements** — agents can be grouped by project, role, or team

**Desk SVG Design:**
```
┌──────────────────────────────┐
│  [Monitor with code/status]  │  ← Shows real work (code for dev,
│  ⌨️ [Keyboard]                │     design preview for designer,
│                              │     document for analyst)
│  ☕ [Coffee cup]              │  ← Status-dependent: steam when working
│                              │
│  ┌──────┐                    │
│  │ NAME │  Nameplate         │
│  └──────┘                    │
│  [Avatar circle]             │  ← Agent emoji/SVG
│  ● Status dot                │  ← Color-coded + animated when busy
└──────────────────────────────┘
```

### 2. PM Chat (Right Sidebar — Always Visible)

**Purpose:** Your always-available project manager. The PM drives the workflow, creates tasks, validates plans, and coordinates the team.

**PM Persona:**
- Name: PM Orchestrator (configurable)
- Role: Software house director / project manager
- Model: `opencode-go/deepseek-v4-pro` (configurable)
- Always online, always in context

**PM Capabilities:**
- **Project creation** — interviews you (grill-me style), generates PRD
- **Task creation** — breaks down project into tasks, assigns to agents
- **Status reports** — team-wide overview, per-agent progress
- **Document generation** — PRD, ADR, sprint plans, test plans, risk registers
- **Review coordination** — routes completed work to review agent
- **Course correction** — reassigns tasks, changes priorities
- **Context awareness** — knows the full project state, agent statuses, pipeline

**Chat Commands (PM understands):**
| Command | Action |
|---------|--------|
| `new project X` | Start project creation flow |
| `status` | Team + pipeline status report |
| `plan next` | Recommend next steps |
| `create tasks for X` | Generate task breakdown |
| `review Y` | Trigger review of completed work |
| `grill me about Z` | Start grill-me validation |
| `document X` | Generate specific document |
| `assign T to A` | Task assignment |
| `change A's model` | Modify agent configuration |

### 3. Project Documents (Obsidian-Style Vault)

**Purpose:** Each project gets its own markdown document vault. All planning, decisions, and deliverables are stored as interlinked `.md` files.

**Vault Structure (per project):**
```
orchestrator-data/projects/my-saas/docs/
├── 📄 INDEX.md              ← Master index linking all docs
├── 📄 PRD.md                ← Product Requirements Document
├── 📄 ARCHITECTURE.md       ← Architecture Decision Records
├── 📄 DECISIONS.md          ← Decision log with rationale
├── 📄 TASKS.md              ← Task registry (auto-generated)
├── 📄 TEAM.md               ← Team roster with agent configs
├── 📄 SPRINTS.md            ← Sprint planning and retrospectives
├── 📄 GRILL-SESSIONS.md     ← Grill-me interview transcripts
├── 📄 REVIEW-LOG.md         ← Code/design review history
├── 📄 CHANGELOG.md          ← Project changes timeline
├── 📁 designs/              ← Design documents
│   ├── 📄 UI-SPEC.md
│   └── 📄 UX-FLOW.md
├── 📁 api/                  ← API documentation
│   └── 📄 ENDPOINTS.md
└── 📁 research/             ← Research findings
    ├── 📄 MARKET-ANALYSIS.md
    └── 📄 COMPETITORS.md
```

**Features:**
- Documents are **live** — agents update them as they work
- **Wikilinks** between documents (`[[PRD]]`, `[[ARCHITECTURE]]`)
- **Index auto-generation** — PM maintains the INDEX
- **Version history** — git-tracked changes
- **Export** — can be exported as static site or PDF
- **Dashboard viewer** — read/edit docs right in GenorBoard

### 4. Pipeline Bar (Bottom)

**Purpose:** At-a-glance view of all project tasks and their flow.

**Phases (configurable per project):**
| Phase | Description | Auto-transition? |
|-------|-------------|------------------|
| 📥 Backlog | Awaiting assignment | Manual |
| ⚡ In Progress | Agent is working | Auto when started |
| 👁️ Review | Under review by reviewer agent | Auto when agent completes |
| 🔄 Rework | Needs changes | Auto if review fails |
| ✅ Done | Completed and approved | Auto when review passes |

**Pipeline Features:**
- Horizontal scrollable lanes
- Drag & drop tasks between phases
- Click task → expand detail
- Filter by agent, priority, type
- Color-coded by priority (P0=red, P1=orange, P2=yellow, P3=gray)

---

## 🤖 Agent Management

### Agent Lifecycle

```
[Hire] → [Configure Model+Prompt] → [Assign to Project]
   → [Receive Tasks] → [Execute in Isolated Session]
   → [Submit for Review] → [Complete or Rework]
```

### Agent Configuration

Each agent is defined by:
```json
{
  "id": "alice",
  "name": "Alice",
  "emoji": "🦊",
  "role": "Business Analyst",
  "model": "opencode-go/deepseek-v4-pro",
  "systemPrompt": "You are a strategic business analyst...",
  "projects": ["my-saas"],
  "skills": ["research", "strategy", "docs"],
  "status": "working",
  "currentTask": "Market Analysis",
  "contextUsed": "42k/977k",
  "progress": 64,
  "avatar": "svg/fox-analyst.svg"  // future: custom SVG avatar
}
```

### Agent Types (Pre-configured templates)

| Role | Icon | Default Model | Skills |
|------|------|---------------|--------|
| Business Analyst | 🦊 | DeepSeek V4 Pro | research, strategy, docs |
| Backend Architect | 🐺 | MiniMax M3 | api-design, database, infra |
| UI/UX Designer | 🐉 | Qwen 3.7 Max | design-systems, figma, ux |
| Full-Stack Dev | 🦉 | GLM 5.1 | react, typescript, nodejs |
| Code Reviewer | 🦅 | Mimo V2.5 | review, standards, security |
| Copywriter | ✍️ | DeepSeek V4 Flash | copy, content, marketing |
| QA Engineer | 🐞 | DeepSeek V4 Flash | testing, e2e, unit-tests |
| DevOps Engineer | 🐳 | MiniMax M3 | ci-cd, docker, aws |
| Security Auditor | 🛡️ | DeepSeek V4 Pro | security, audit, compliance |
| Data Scientist | 🐝 | GLM 5.1 | analytics, ml, statistics |

### Agent Model Selection

Available models configured through OpenClaw (already done):
- `opencode-go/deepseek-v4-flash` (195k ctx) — fast, cost-effective
- `opencode-go/deepseek-v4-pro` (977k ctx) — deep thinking, large context
- `opencode-go/minimax-m3` (200k ctx) — balanced
- `opencode-go/glm-5.1` (198k ctx) — strong generalist
- `opencode-go/qwen3.7-max` (977k ctx) — powerful, large context
- `opencode-go/mimo-v2.5` (977k ctx) — fast large-context
- `opencode-go/kimi-k2.6` (195k ctx) — Kimi Code

**Selection guidelines:**
- **Research/docs** → DeepSeek V4 Pro (deep thinking for complex analysis)
- **Development** → GLM 5.1 / Mimo V2.5 (balanced speed/quality)
- **Review** → Mimo V2.5 (fast, thorough)
- **Design** → Qwen 3.7 Max (creative, visual thinking)
- **Quick tasks** → DeepSeek V4 Flash (fast, cheap)

---

## 🔄 Orchestrator Engine

### Task Dispatch Flow

```
PM creates task → Backlog
     │
     ▼
Orchestrator evaluates: which agent has matching skills + capacity?
     │
     ▼
Task assigned → Agent notified → Isolated session spawned
     │
     ▼
Agent executes: models are loaded, system prompt injected, task sent
     │
     ▼
Agent completes → Output saved → Task moves to Review
     │
     ▼
Reviewer agent checks → Pass/Fail
     │
     ├── Pass → Done (document updated, PM notified)
     └── Fail → Rework (back to agent with feedback)
```

### Session Management

- Each agent task runs in an **isolated session** via `POST /v1/chat/completions` with custom `x-openclaw-session-key`
- Session key = `genorch-{project}-{agent}-{task}`
- Context tracked per session
- Sessions can be inspected via the dashboard
- No cross-contamination between agents

### Context & Progress Monitoring

Agents running on OpenClaw sessions expose:
- **Context usage** — `current_tokens / max_tokens` 
- **Progress** — based on task phases completed
- **Thinking level** — configurable per agent
- **Session history** — full transcript accessible for review

---

## 🔥 Grill-Me Validation Flow

### What it is

A structured interview process where the PM Orchestrator acts as the **software house owner** and you are the **client**. The PM interviews you relentlessly about every aspect of the project to ensure shared understanding before any work begins.

### Flow

```
1. Client: "Let's grill my project idea"
2. PM: "I'm the owner of Genor Software House. You're my client.
        Walk me through what you want to build."
3. PM asks questions one at a time, each building on the last:
   - "Who is this for? What problem does it solve?"
   - "What's the one feature that makes or breaks this?"
   - "What's your budget in terms of time?"
   - "What tech constraints do you have?"
   - "Who are the competitors? Why will you win?"
   - "What's the riskiest assumption you're making?"
   - ...
4. Each answer is documented in the project vault
5. After the interview, PM generates:
   - Refined PRD
   - Risk register
   - Task prioritization
   - Team recommendation
6. Client reviews and approves → work begins
```

**Grill-me integration with existing skill:**
The existing `grill-me` skill provides the interview methodology. The PM Orchestrator adopts this methodology as its standard project kickoff flow.

---

## 📊 Data Model (Extended)

### New Tables

```sql
-- Project documents registry
CREATE TABLE project_docs (
  id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  file_path TEXT NOT NULL,          -- relative to project docs dir
  title TEXT NOT NULL,
  doc_type TEXT DEFAULT 'note',     -- prd, adr, sprint, note, research, design
  content TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  linked_docs TEXT DEFAULT '[]',    -- wikilinks to other docs
  created_by TEXT,                  -- agent id or 'pm'
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Grill-me sessions
CREATE TABLE grill_sessions (
  id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  topic TEXT NOT NULL,
  questions TEXT DEFAULT '[]',      -- JSON array of Q&A pairs
  decisions TEXT DEFAULT '[]',      -- JSON array of decisions made
  status TEXT DEFAULT 'active',     -- active, completed, archived
  created_at TEXT DEFAULT (datetime('now'))
);

-- Agent session tracking
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  status TEXT DEFAULT 'pending',    -- pending, running, completed, failed
  context_used TEXT,
  progress INTEGER DEFAULT 0,
  output_summary TEXT,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (agent_id) REFERENCES agents(id),
  FOREIGN KEY (task_id) REFERENCES kanban_tasks(id)
);

-- Review log
CREATE TABLE review_log (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  reviewer_agent_id TEXT NOT NULL,
  verdict TEXT NOT NULL,            -- pass, fail, changes_requested
  feedback TEXT,
  issues_found TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES kanban_tasks(id)
);
```

---

## 🎨 SVG Avatar System (Future)

### Design

Each agent role has a unique SVG avatar — a stylized cartoon character sitting at a desk. The SVG encodes:
- Character silhouette (role-specific: fox=analyst, wolf=architect, etc.)
- Desk setup (monitor, keyboard, personal items)
- Status-dependent animations (typing, thinking, reviewing)

### Format

Standalone SVG files, ~200-400 bytes each, inlineable in HTML.
Example spec:
```svg
<svg viewBox="0 0 100 120">
  <!-- Character -->
  <circle cx="50" cy="40" r="20" fill="color"/>    <!-- head -->
  <rect x="30" y="60" width="40" height="40"/>     <!-- body -->
  <!-- Desk -->
  <rect x="10" y="100" width="80" height="10"/>    <!-- desk -->
  <!-- Monitor -->
  <rect x="25" y="70" width="50" height="30"/>     <!-- screen -->
  <!-- Status indicators -->
</svg>
```

### States

- **Idle**: Character sitting, occasional blink
- **Working**: Typing animation, screen shows code lines
- **Reviewing**: Magnifying glass, red pen marks on screen
- **Blocked**: Question mark, worried expression
- **Complete**: Green checkmark, satisfied pose

---

## 🛠️ Implementation Roadmap

### Phase 0: Current State ✅
- [x] Plugin installed and loaded
- [x] Models configured (7 models via OpenCode Go)
- [x] Git repo set up with SSH (pc2 key)
- [x] Dashboard running at `/orchestrator`
- [x] Hook permissions configured

### Phase 1: Foundation (Next)
- [ ] **DB extension**: Add new tables (`agents`, `project_phases`, `kanban_tasks`, `task_activity`, `project_docs`, `grill_sessions`, `agent_sessions`, `review_log`)
- [ ] **API routes**: CRUD for agents, tasks, phases, docs
- [ ] **Orchestrator dispatch**: Task → isolated session creation
- [ ] **PM chat backend**: Session-based PM with context

### Phase 2: Office Canvas
- [ ] **SVG desk system**: Inline SVG rendering for agent workstations
- [ ] **Agent status animations**: Working/idle/reviewing states
- [ ] **Click-to-inspect**: Agent detail modal with context/progress
- [ ] **Hire agent flow**: Form-based agent creation
- [ ] **Status dots and task indicators**: Real-time updates

### Phase 3: Document System
- [ ] **Project vault**: Per-project markdown directory
- [ ] **Document CRUD**: Create, edit, view docs from dashboard
- [ ] **Wikilinks**: `[[link]]` syntax between documents
- [ ] **Auto-generation**: PM creates docs from grill sessions
- [ ] **Index maintenance**: Auto-updated project index

### Phase 4: PM Intelligence
- [ ] **Grill-me integration**: PM adopts interview methodology
- [ ] **Project kickoff flow**: Structured project creation interview
- [ ] **Status reporting**: Automated team + pipeline reports
- [ ] **Task generation**: Smart task breakdown from project docs
- [ ] **Review routing**: Automatic review assignment

### Phase 5: Polish
- [ ] **Custom SVG avatars**: Role-specific animated avatars
- [ ] **Document export**: Static site / PDF generation
- [ ] **Git integration**: Auto-commit document changes
- [ ] **Performance**: Canvas rendering optimization
- [ ] **Multi-project**: Seamless project switching

---

## 📝 Current File Structure

```
genor-orchestrator-plugin/
├── AGENTS.md                          ← Existing plugin docs
├── PLAN-kanban-team.md                ← Phase 1 plan (Kanban + Team)
├── PROTOTYPE-kanban-team.html         ← Prototype v1 (Kanban board)
├── PROTOTYPE-v2-software-house.html   ← Prototype v2 (Office + PM + Pipeline)
├── DESIGN.md                          ← THIS FILE — Master design
├── src/
│   ├── index.ts                       ← Main plugin entry
│   ├── dashboard-handler.ts           ← HTTP routes + dashboard API
│   ├── db.ts                          ← SQLite database
│   └── shared.ts                      ← Types and utilities
├── dashboard/
│   └── index.html                     ← Current dashboard (pre-v2)
├── dist/                              ← Compiled output
├── openclaw.plugin.json               ← Plugin manifest
└── package.json                       ← Dependencies
```

---

## 🎯 Success Criteria

1. **You can create a project** by talking to the PM in chat
2. **PM interviews you** (grill-me style) and generates comprehensive docs
3. **You hire and configure agents** with specific models and instructions
4. **Tasks flow automatically** from Backlog to Done via the pipeline
5. **Office canvas shows real-time status** — you see agents working
6. **Clicking an agent** reveals context usage, progress, current task
7. **Review system** catches issues before they reach Done
8. **Project vault** contains all decisions, docs, and history
9. **You can add custom agents** (copywriter, tester, devops) at any time
10. **The whole thing feels like running a software house** — not a task board

---

## 📞 Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| PM as always-visible chat | Keeps project context accessible without switching tabs |
| Office canvas + pipeline (not just kanban) | "Software house" feel vs "task manager" feel |
| Isolated agent sessions | No cross-contamination, clean context per task |
| Markdown vault (not database docs) | Git-friendly, portable, human-readable |
| Grill-me for project kickoff | Prevents scope creep and misalignment before work starts |
| SVG avatars (not emoji) | Customizable, professional, animated states |
| Per-agent model selection | Different tasks need different model strengths |
| Review agent as first-class citizen | Quality gate before Done, not an afterthought |

---

*Last updated: 2026-06-23 · Design by Adrian + OpenClaw*
