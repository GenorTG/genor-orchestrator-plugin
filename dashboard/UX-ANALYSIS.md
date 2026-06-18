# GenorBoard UX Analysis & Design Rationale

## Current State Audit

### Layout
- **Top tab bar** — flat, non-hierarchical, works for ≤5 tabs but we now have 8
- **Single page** — all HTML/CSS/JS in one 3506-line file
- **Terminal aesthetic** — JetBrains Mono, dark theme, green/blue accent
- **Status bar** — fixed bottom with basic info

### Issues Identified

1. **Navigation overload**: 8 tabs compete for space. No grouping.
2. **No information hierarchy**: Every tab is equal priority. The "Home" tab should be a proper dashboard, not just an activity feed.
3. **Accessibility gaps**: No ARIA landmarks or roles. Buttons lack accessible names in many places. No focus management for modals or dynamic content.
4. **CSS specificity issues**: Heavy use of shorthand (`flex:1;gap:12px` on everything), no component abstraction.
5. **Responsive**: Some mobile support but too wide for small screens.
6. **Visual density**: 393 `div`s, 61 `button`s in 3506 lines — high element count for what it does.

## Redesign Goals

### 1. Navigation → Left Sidebar
```
[Header: logo | status | stats | theme toggle]
[Sidebar: icon+label tabs] | [Main Content]
[Footer/Status Bar]         |
```
- **Why**: Sidebar is the modern standard for tools with >5 sections. Allows icon-only collapse for narrow screens.
- **Scales**: Adding new sections doesn't crowd the interface.
- **Grouping**: Related sections can be visually grouped with dividers.

### 2. Dashboard Home (first-class)
- **Metric cards**: 4 summary cards at top (Models, Agents, Projects, Sessions) with trend context
- **Activity feed**: Recent events column
- **Quick actions**: One-click buttons for common tasks (doctor, populate models, fix docs)
- **Health widget**: Plugin gateway status, last check time

### 3. Component Abstraction
Extract reusable patterns:
- `.card` — titled content container with padding
- `.metric` — stat display (number + label + delta)
- `.btn` with variants — primary, secondary, ghost, danger
- `.badge` — status indicators (success, warning, error, info)
- `.table` — consistent data presentation
- `.modal` — accessible overlay with focus trap

### 4. Accessibility Checklist
- [x] ARIA roles: `navigation`, `main`, `region`, `tabpanel`
- [x] Focus management: trap within modals, restore on close
- [x] Keyboard nav: Enter/Space activate, Tab through controls, Escape close modals
- [x] Color contrast: WCAG AA minimum (4.5:1 text, 3:1 large)
- [x] Reduced motion: `@media (prefers-reduced-motion)`
- [x] Screen reader: proper labels on icon buttons, status announcements

### 5. Visual Polish
- **Card elevation**: Subtle shadow + hover lift instead of flat borders
- **Consistent spacing**: 8px grid system (8, 16, 24, 32 tokens)
- **Focus indicators**: 2px outline with offset, visible in both themes
- **Transitions**: Only 150-200ms, only for interactive elements
- **Skeleton loading**: Shimmer placeholders during data fetch

## Tab Restructuring

| Position | Tab | Priority | Notes |
|----------|-----|----------|-------|
| 1 | **Dashboard** 🔥 | Core | New — metric overview + recent activity |
| 2 | **Projects** 📁 | Core | Backlog, sessions, docs per project |
| 3 | **Agents** 🤖 | Core | Live agents, health, actions |
| 4 | **Models** 🧠 | Core | Inventory, routing, tier management |
| 5 | **Logs** 📋 | Secondary | Filtered log viewer |
| 6 | **Gateway** 🌐 | Secondary | Gateway session list |
| 7 | **Safeguards** 🛡️ | Secondary | Workflow phase, health checks |
| 8 | **Settings** ⚙️ | Utility | Config editor |
| 9 | **Chat** 💬 | Utility | SSE debug console |

## Interaction Flow (Optimal)

1. User arrives at **Dashboard** — sees health overview, acts on problems via quick-actions
2. Clicks a project → lands on Project detail with sessions, backlog, docs
3. Backlog tasks → click to view details, dispatch to sub-agent
4. Agent status → shows live session, model assignment, health
5. Model routing → dropdown to change per-project routing (Phase 3b)
6. Settings → global config toggles (free-only mode, model disables)

Every action provides visual feedback (toast/snackbar) within 200ms.

## Technical Implementation

### File structure (within dashboard/)
```
index.html          — Main entry (served by plugin)
dashboard.css       — Extracted styles
dashboard.js        — Extracted logic
icons.svg           — Inline SVG sprite
UX-ANALYSIS.md      — This document
```

### State Management
- Global `StateManager` class with reactive subscribers
- Auto-refresh via SSE for live data
- URL hash routing preserved

### Performance
- CSS will be in `<style>` in index.html for single-file deployment
- Lazy tab rendering (only render content when tab is first activated)
- Debounce rapid API calls (model list, session list refresh)
