# ⛔ SUPERSEDED — Dashboard redesign completed in v0.8.0. This planning doc kept for historical reference.
# UI Redesign Plan — GenorBoard Dashboard

## A. Current State Analysis

### Existing Tabs (in sidebar order)

| # | Tab | Type | What it Shows |
|---|-----|------|---------------|
| 1 | Dashboard (📊) | **Global** | Metric cards, recent activity feed, system info |
| 2 | Projects (📁) | **Global list** | Project table; click a row → modal/overlay with project detail |
| 3 | Agents (🤖) | **Global** | All live agents across all projects |
| 4 | Models (🧠) | **Global** | Model inventory table with search/filter |
| 5 | Logs (📜) | **Global** | Flat list of ALL logs (last 100 entries), filterable by level/source |
| 6 | Settings (⚙️) | **Global** | Config toggles, quick actions, system info |
| 7 | Gateway (🌐) | **Global** | Gateway sessions table |
| 8 | Sessions (📋) | **Ambiguous** | Project dropdown + "Load Sessions" button. Shows per-project sessions but as a standalone tab |
| 9 | Safeguards (🛡️) | **Global** | Safeguard config + event log |

### Confusion Hotspots

1. **Sessions tab is neither fully global nor fully per-project.**
   - It has a project dropdown to pick a project, but lives as its own top-level nav item.
   - The project detail overlay (clicking a project in the Projects table) also shows a sessions table. Users have two different session views: one in the Sessions tab with a tree, one in the project detail overlay with a flat table.
   - No clear "this session view belongs to Project X" indicator — the tab doesn't change title to reflect the selected project.

2. **Logs are entirely global.**
   - No project filter at all.
   - If a user wants to see logs for just "kotw", they have to eyeball the source column.
   - No separation between "all logs" and "project-scoped logs."

3. **No persistent project context.**
   - The project detail in the Projects tab is an overlay that replaces the panel content, not a navigation state.
   - Clicking "Sessions" loses the project context.
   - There's no way to be "inside" a project and see all its related info (sessions, logs, backlog, docs) without re-selecting it.

4. **Flat sidebar with no section grouping.**
   - All tabs are peers; no visual distinction between global views and project-scoped views.
   - Hard to discover which views are scoped vs global.

### What Works Well (Keep/Refine)

- **Session tree view**: The `renderSessionTree()` function already has a proper parent-child hierarchy with expandable detail rows. This should be preserved as the per-project sessions view.
- **Project detail overlay**: Shows sessions, workflow status, model routing — good content; just in the wrong navigation spot.
- **Existing API endpoints**: `/api/project-state?name=X` already returns per-project sessions and docs. `/api/project-backlog?project=X` exists. An API for per-project logs would be needed.
- **Header stats**: Already shows model/agent/session/project counts — keep.
- **Hash routing**: Already in place; can be extended for project-scoped routes.

---

## B. Proposed Tab Structure

### GLOBAL tabs (visible always)

```
┌─────────────────────────────┐
│  ⚡ General                  │  ← Section header
│  📊 Dashboard                │  ← Global overview (keep as-is, enhance)
│  ⚙️ Settings                 │  ← Global config (move safeguard toggles here)
│  🌐 Gateway                  │  ← Global gateway sessions (keep)
│  🛡️ Safeguards               │  ← Global safeguard log (keep)
└─────────────────────────────┘
```

### PER-PROJECT tabs (visible only when a project is selected)

```
┌─────────────────────────────┐
│  📁 Project: kotw           │  ← Section header + project name
│  📋 Sessions                │  ← Project-scoped sessions tree
│  📜 Logs                    │  ← Project-scoped logs
│  📝 Backlog                 │  ← Project-scoped backlog
│  📄 Docs                    │  ← Project-scoped documentation
└─────────────────────────────┘
```

### Edge state — No Project Selected

When no project is selected, the sidebar should show:
- General section (always visible)
- A prompt/empty state in the per-project section:
  ```
  ┌─────────────────────────────┐
  │  📁 Project                  │  ← Section header
  │  (Select a project to       │  ← Info text, not clickable links
  │   see sessions, logs,       │
  │   backlog, and docs)        │
  └─────────────────────────────┘
  ```

Or simpler: hide the per-project section entirely and show a prompt in the main content area when a project-scoped tab is somehow activated: *"Select a project from the Projects tab to access its sessions, logs, backlog, and docs."*

### Tab Consolidation — Removals & Changes

| Current Tab | Action |
|-------------|--------|
| Dashboard | Keep as global, tweak |
| Projects | **Replaced** by Project selector in sidebar + per-project tabs |
| Agents | Move to global "General" section, keep as-is |
| Models | Move to global "General" section, keep as-is |
| **Logs** | **Remove global Logs tab.** Logs become per-project only. |
| Settings | Keep as global, enhanced |
| Gateway | Keep as global, keep as-is |
| **Sessions** | **Remove global Sessions tab.** Sessions become per-project only. |
| Safeguards | Keep as global, keep as-is |

---

## C. Navigation Design

### Sidebar Layout

```
┌───────────────────────────────────────┐
│  ⚡ GenoBoard                         │  ← Header (unchanged)
├───────────────────────────────────────┤
│  GENERAL                              │  ← Section label (small, dimmed, uppercase)
│  📊 Dashboard                         │
│  🤖 Agents                            │
│  🧠 Models                            │
│  ⚙️ Settings                          │
│  🌐 Gateway                           │
│  🛡️ Safeguards                        │
│                                       │
│  ─── PROJECT ───                      │  ← Separator + section header
│  [▼] Select project…                  │  ← Dropdown, when expanded shows project list
│                                       │  OR when selected:
│  📁 Project: kotw                     │  ← Active project name (header/dimmed label)
│  📋 Sessions                          │
│  📜 Logs                              │
│  📝 Backlog                           │
│  📄 Docs                              │
├───────────────────────────────────────┤
│  GenorBoard v2                        │  ← Footer (unchanged)
└───────────────────────────────────────┘
```

### Behavior Flow

1. **User opens dashboard** → General section shows, project section shows "Select project…" prompt.
2. **User navigates to Projects view (or uses dropdown)** → Clicks a project → sidebar animates to show project section with project name and tabs.
3. **Per-project tabs light up** → Sessions defaults to showing the project's session tree; Logs shows project-scoped logs.
4. **User switches to a global tab** → Project sidebar section remains visible (preserving context).
5. **User changes project** → Sidebar updates the project name; all per-project tabs refresh to show new project data.
6. **User deselects project** → Per-project section reverts to "Select project…" state.

### URL Hash Routing

```
#dashboard          → Global dashboard
#settings           → Global settings
#gateway            → Global gateway
#safeguards         → Global safeguards
#agents             → Global agents
#models             → Global models

#project/kotw       → Project context, default Sessions view
#project/kotw/sessions  → Project sessions
#project/kotw/logs      → Project logs
#project/kotw/backlog   → Project backlog
#project/kotw/docs      → Project docs
```

The hash routing function `routeFromHash()` needs to be extended to parse `#project/<name>/<subtab>` patterns.

---

## D. Sessions Tab Redesign

### Current Behavior
- `renderProjectSessions()` in the Sessions tab already loads sessions per-project via `/api/project-state`.
- The session tree view (`renderSessionTree()`) has proper parent-child hierarchy, expandable detail rows, and a docs panel.
- BUT: the select-project dropdown is embedded in the tab content, not in navigation.

### New Behavior
1. Sessions tab only appears under the per-project section.
2. No project selector dropdown needed inside the tab — the project is already selected in the sidebar.
3. The session tree loads automatically when the tab activates, using the sidebar's selected project.
4. **Optional enhancement**: A "🌐 Show all sessions" toggle within the session view that calls `/api/all` to show sessions across all projects in the same tree format, with a project badge on each root node.

### Enhancement Ideas
- Add count badges to each session based on status:
  - `Sessions (12) ⚠️ 3 running`
- Live session polling: auto-refresh the tree every 10 seconds when sessions are in "running" or "in_progress" state.
- Quick actions per session: "Kill session", "Show logs for this session" (filter log view to this session key).
- Search/filter within sessions.

### Code Areas to Change
- Remove `renderProjectSessions()` as a top-level tab renderer.
- Repurpose it as `renderProjectSessions(projectName)`, taking the project name from sidebar state.
- Move `loadProjectSessions()` to auto-fire on tab activation instead of requiring a button click.

---

## E. Logs Tab Redesign

### Current Behavior
- `renderLogs()` fetches `/api/logs?limit=100` — a global flat list.
- Filter bar has search, level filter, and source filter.
- No project filter.
- The Logs tab is a top-level (global) nav item.

### New Behavior
1. **Remove global Logs tab.** Logs become a per-project view.
2. A `renderProjectLogs(projectName)` function fetches `/api/logs?project=X&limit=100`.
   - This requires a new API endpoint or query parameter support on the existing logs endpoint.
3. **Optional toggle**: A "🌐 All Logs" toggle button in the per-project Logs view header to show global logs (still within the project-scoped tab, but labeled "All Logs — Global").
4. Filter bar remains (search, level, source) and adds project-relative context.
5. Clear labeling in the header: `📜 Logs: kotw` vs `📜 All Logs` when toggled.

### API Requirement
The existing `/api/logs` endpoint likely needs a `?project=X` parameter added to the backend. Verify if the orchestrator logs already store a project field. If source field contains project info, client-side filtering is also an option (though not ideal for large datasets).

### Code Areas to Change
- `renderLogs()` changes from a standalone global tab renderer to a project-scoped renderer `renderProjectLogs(projectName)`.
- The API call changes from `/api/logs?limit=100` to `/api/logs?project=NAME&limit=100`.
- If no per-project endpoint exists yet, a fallback could filter client-side by matching the `source` field against the project name pattern.

---

## F. Implementation Approach

### Order of Implementation

```
Phase 1: Sidebar Restructure
├── 1.1 Add section labels ("GENERAL", "PROJECT") to sidebar HTML
├── 1.2 Add project selector dropdown in the PROJECT section
├── 1.3 Add per-project nav items (Sessions, Logs, Backlog, Docs) — initially disabled
├── 1.4 Wire up project selection → activate per-project tabs
└── 1.5 Add project context state to `store` (StateManager)

Phase 2: Remove Global Tabs
├── 2.1 Remove "Sessions" from global nav
├── 2.2 Remove "Logs" from global nav
├── 2.3 Move "Agents" and "Models" into general section (they already are, just re-label)
├── 2.4 Update `routeFromHash()` — remove 'sessions' and 'logs' from valid hash list
└── 2.5 Remove `renderSessions()` and `renderLogs()` from `activateTab()` switch

Phase 3: Per-Project Sessions
├── 3.1 Create `renderProjectSessions(projectName)` — adapted from current function
├── 3.2 Auto-load sessions on tab activation (remove "Load Sessions" button)
├── 3.3 Add "Show All Sessions" global toggle
└── 3.4 Wire up the Session tree to project state store

Phase 4: Per-Project Logs
├── 4.1 Create `renderProjectLogs(projectName)` — adapted from current renderLogs
├── 4.2 Create/update backend endpoint for per-project logs if needed
├── 4.3 Add global/all toggle
└── 4.4 Wire up to project state store

Phase 5: Backlog Tab
├── 5.1 Create `renderProjectBacklog(projectName)` using existing `/api/project-backlog`
├── 5.2 Add task creation inline modal
└── 5.3 Wire up to project state store

Phase 6: Docs Tab
├── 6.1 Create `renderProjectDocs(projectName)` using existing `/api/project-state` docs array
├── 6.2 Use existing `loadProjectDoc()` modal for viewing
└── 6.3 Wire up to project state store

Phase 7: Polish
├── 7.1 Add project name badge to session/log entries
├── 7.2 Auto-refresh per-project tabs when data changes
├── 7.3 Transition animations for sidebar sections
└── 7.4 Responsive testing
```

### Specific Code Changes (By File)

**File: `dashboard/index.html`**

A. **Sidebar HTML** (~lines 70-95 in the nav section):
   - Add a `<div class="nav-section">General</div>` label before Dashboard
   - Add a `<hr class="nav-divider">` separator
   - Add `<div class="nav-section">Project</div>` section
   - Remove the Sessions and Logs buttons from the top-level nav
   - Add a project selector dropdown or display area
   - Add per-project nav items: Sessions, Logs, Backlog, Docs (with `data-tab="project-X"` attributes)
   - These items start with `display:none` or `disabled` class and become visible on project selection

B. **CSS additions** (add to `<style>` block, ~100 lines new max):
   ```css
   .nav-section {
     font-size: 9px; text-transform: uppercase;
     color: var(--text-dim); letter-spacing: .8px;
     padding: 12px 10px 4px; font-weight: 600;
   }
   .nav-divider {
     border: none; border-top: 1px solid var(--border);
     margin: 6px 10px;
   }
   .nav-item:disabled {
     opacity: .4; cursor: not-allowed;
   }
   .nav-item .project-badge {
     font-size: 9px; background: var(--accent-bg);
     color: var(--accent); padding: 0 5px;
     border-radius: 3px; margin-left: auto;
   }
   ```

C. **StateManager additions** (~10 lines):
   - Add store key `project.active` to track selected project
   - Add store key `project.data` to cache per-project data

D. **Tab Management update** (`activateTab` function):
   - Extend to accept `#project/kotw/sessions` format
   - Add case statements for `project-sessions`, `project-logs`, `project-backlog`, `project-docs`
   - Unload project state when switching away from project-scoped tabs

E. **New render functions** (~150 lines total):
   - `renderProjectSessions(project)` — adapted from current `renderProjectSessions` + `renderSessionTree`
   - `renderProjectLogs(project)` — adapted from current `renderLogs`
   - `renderProjectBacklog(project)` — new, uses existing `/api/project-backlog`
   - `renderProjectDocs(project)` — new, uses `/api/project-state` docs array
   - `renderProjectSelector()` — when no project, show "select a project" prompt

F. **Per-project API data loading** (~20 lines):
   - Add `loadProjectData(project)` that fetches state + backlog + logs in parallel
   - Cache with 10s TTL

G. **Remove dead code**:
   - Remove the global `renderLogs()` function (lines 420-445 in current file)
   - Remove `sessions` from the API maps in `loadTabData()` (line ~395)
   - Remove `showProject()` overlay replacement approach — the project detail is now spread across tabs

**Potential Backend Changes (orchestrator plugin):**

- Add `?project=NAME` filter support to the `/api/logs` endpoint
- Verify `/api/project-backlog` returns full backlog data (titles, status, priority, etc.)

---

## G. Mockups/Wireframes

### Sidebar — No Project Selected

```
┌──────────────────────┐
│ ⚡ GenoBoard         │
├──────────────────────┤
│ GENERAL              │
│ 📊 Dashboard         │
│ 🤖 Agents            │  ◄ active
│ 🧠 Models            │
│ ⚙️ Settings          │
│ 🌐 Gateway           │
│ 🛡️ Safeguards        │
├──────────────────────┤
│ PROJECT              │
│                      │
│ Select a project     │
│ from the Projects    │
│ tab to access its    │
│ sessions and logs.   │
│                      │
│ 📁 Go to Projects →  │  ◄ CTA button
├──────────────────────┤
│ GenorBoard v2        │
└──────────────────────┘
```

### Sidebar — Project Selected

```
┌──────────────────────┐
│ ⚡ GenoBoard         │
├──────────────────────┤
│ GENERAL              │
│ 📊 Dashboard         │
│ 🤖 Agents            │
│ 🧠 Models            │
│ ⚙️ Settings          │
│ 🌐 Gateway           │
│ 🛡️ Safeguards        │
├──────────────────────┤
│ PROJECT              │
│ [▼] kotw       ✕     │  ← dropdown + deselect
│                      │
│ 📋 Sessions     (12) │  ◄ active
│ 📜 Logs         (47) │
│ 📝 Backlog      (8)  │
│ 📄 Docs         (5)  │
├──────────────────────┤
│ GenorBoard v2        │
└──────────────────────┘
```

### Per-Project Sessions View

```
┌──────────────────────────────────────────────────────────────────┐
│ ← Projects                  📋 Sessions: kotw    [🌐 All] [🔄]  │
├──────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ Sessions (12)                                   3 running    │ │
│ ├──────────────────────────────────────────────────────────────┤ │
│ │ ▶ agent-a  running   Implement login flow   10:32 AM   12m  │ │
│ │   └── agent-b  complete  Add login form     10:35 AM    8m  │ │
│ │   └── agent-c  complete  Validate auth       10:38 AM    5m  │ │
│ │ ▶ agent-d  complete  Setup database         09:15 AM   20m  │ │
│ │   └── agent-e  complete  Create migrations  09:20 AM   10m  │ │
│ │   └── agent-f  failed   Seed data           09:45 AM    2m  │ │
│ │ ...                                                          │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                                                  │
│ [➕ New Session] [🩺 Doctor]                                     │
└──────────────────────────────────────────────────────────────────┘
```

### Per-Project Logs View

```
┌──────────────────────────────────────────────────────────────────┐
│ ← Projects                  📜 Logs: kotw         [🌐 All] [🔄] │
├──────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ 🔍 Search logs…   [All levels ▼]  [All sources ▼]           │ │
│ ├──────────────────────────────────────────────────────────────┤ │
│ │ 10:32:15  info  [sessions] Session agent-b completed         │ │
│ │ 10:35:22  info  [routing] Model selected: openrouter/free   │ │
│ │ 10:38:01  warn  [safeguards] Agent agent-f timed out         │ │
│ │ ...                                                          │ │
│ └──────────────────────────────────────────────────────────────┘ │
│ Showing 47 of 142 entries for kotw                               │
└──────────────────────────────────────────────────────────────────┘
```

### Per-Project Backlog View

```
┌──────────────────────────────────────────────────────────────────┐
│ ← Projects                  📝 Backlog: kotw        [➕ Add]     │
├──────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ Filter: [All statuses ▼]  [All priorities ▼]                │ │
│ ├──────────────────────────────────────────────────────────────┤ │
│ │ 🔴 P0 [todo]  Fix auth token refresh            ──────────  │ │
│ │ 🟡 P1 [in_progress]  Add user profile page      agent-b     │ │
│ │ 🟢 P2 [done]  Setup CI pipeline                 agent-a     │ │
│ │ 🟡 P1 [blocked]  Migrate to v2 API              Waiting on  │ │
│ │ 🟢 P3 [todo]  Add search bar                    ──────────  │ │
│ └──────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

---

## Summary of Benefits

| Before | After |
|--------|-------|
| Two conflicting session views (tab + modal) | Single per-project session view |
| Global logs with no project filter | Per-project logs with optional global toggle |
| Flat sidebar, no section organization | "General" + "Project [name]" clear sections |
| Sessions tab has its own project dropdown | Project is selected once in sidebar, shared by all per-project tabs |
| No per-project backlog or docs view | Dedicated Backlog and Docs tabs per project |
| Project detail is a modal/overlay | Project detail is a navigation context with multiple tabs |

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| **Breaking change to hash routing** | Add backward-compatible redirects: `#sessions` → `#project/last-used/sessions` |
| **API doesn't support per-project logs** | Add `?project=` param to logs endpoint; short-term fallback: client-side filtering by source field pattern-matching project name |
| **Large projects with many sessions/logs** | Pagination in the API calls; limit initial load to most recent 100 entries |
| **User muscle memory for old tab positions** | Keep same icons, add brief "moved to project view" tooltip if someone tries old hash routes |
| **SPA file grows beyond manageable size** | Phase 8 could split into modules (would need a bundler or ES modules — larger refactor, out of scope for this plan) |
