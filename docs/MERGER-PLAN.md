# 🏢 Genor Software House — Implementation-Ready Merger Plan (v3)

> **Version:** 3.0 (QA-corrected, every UI function wired)  
> **Status:** Ready for implementation  
> **Total surface area:** 6335 lines `index.ts` + 1218 lines `dashboard-handler.ts` + 1122 lines `db.ts` + **1695 lines `software-house.html`** (every function audited)

---

## 📋 COMPLETE AUDIT

### 1️⃣ KEEP — Core infrastructure (no changes)

| Item | Why |
|------|-----|
| `src/shared.ts` | Tiny helper |
| `src/db.ts` | SQLite singleton + migration system |
| `src/index.ts` — SessionTracker, WorkflowTracker, 8 hooks, helpers | All core infrastructure |
| `src/index.ts` — 43 AI tools | The AI agent's API |
| `dashboard/index.html` | Classic dashboard |
| **`dashboard/software-house.html`** | **Friend's full SPA — preserved entirely, only URL swaps** |
| **`dashboard/assets/pixel-agents/`** | **40 pixel-art sprite files — preserved** |
| **`dashboard/data/software-house-mock.json`** | **Preserved as API contract fixture (UI stops loading it)** |
| `DESIGN.md`, `SOFTWARE-HOUSE-UI.md` | Documentation |
| **`dashboard/UX-ANALYSIS.md`** | **Friend's design doc — kept, not deleted** |

### 2️⃣ REFACTOR — V4 Migration (backlog_tasks, sessions, new tables)

Unchanged from v2. Extend `backlog_tasks` (add `phase`, `agent_id`, `task_type`), `sessions` (add `progress`, `context_used`, `output_summary`), create `agents`, `rooms`, `vault_docs`, `pm_chat` tables.

**🔴 CRITICAL: Phase/status sync rule**
`POST /api/software-house/backlog/move` MUST also sync `status` from `phase`:
```
phase=backlog      → status=todo
phase=in-progress  → status=in_progress  
phase=review       → status=in_progress
phase=done         → status=done
```
Without this, `genorch_backlog_dispatch` (which reads `status === "todo"`) re-dispatches tasks already in kanban pipeline.

### 3️⃣ CORRECTED: API Endpoints — 18 routes (was 13)

All go in `createDashboardHandler()` using `switch (pathname)` + regex for path params:

| # | Method | Route | Wires UI function(s) |
|---|--------|-------|---------------------|
| 1 | `GET` | `/api/software-house/bootstrap` | `loadMockData()`, `switchProject()` |
| 2 | `GET` | `/api/software-house/rooms/:id` | `openRoomPanel()` detail load |
| 3 | `PATCH` | `/api/software-house/rooms/:id` | `saveRoomPanel()`, `toggleRoomTaskType()`, `setRoomLayout()` |
| 4 | `DELETE` | `/api/software-house/rooms/:id` | `deleteRoom()` |
| 5 | `POST` | `/api/software-house/rooms` | `addRoom()` |
| 6 | `POST` | `/api/software-house/agents/hire` | `confirmHire()` |
| 7 | `PATCH` | `/api/software-house/agents/:id` | `saveAgent()`, `fireAgent()` (fire = PATCH status=inactive) |
| 8 | `GET` | `/api/software-house/agents/:id` | `renderAgentPanel()` detail load |
| 9 | `POST` | `/api/software-house/backlog/move` | Kanban drag + `→ Następna faza` button |
| 10 | `POST` | `/api/software-house/pm/chat` | `sendChat()`, `sendPmBubble()` |
| 11 | `GET` | `/api/software-house/pm/chat` | `renderPmBubbleMsgs()` |
| 12 | `POST` | `/api/software-house/quick-action` | `pmQuick('plan')`, `orchPlan()` — wraps existing `/api/quick-action` |
| 13 | `GET` | `/api/software-house/vault/tree` | `renderVault()` folder tree |
| 14 | `GET` | `/api/software-house/vault/doc` | `openVaultFile()` |
| 15 | `PUT` | `/api/software-house/vault/doc` | Save vault document |
| 16 | `POST` | `/api/software-house/vault/inject` | `📥 Wstrzyknij do sesji` button |
| 17 | `POST` | `/api/software-house/vault/sync` | `🔄 Sync` button (disk → vault_docs) |
| 18 | `POST` | `/api/software-house/layout/save` | Auto-save room positions after drag/resize |

**Path-param routing pattern** (dashboard-handler uses `switch (pathname)`):
```typescript
// Path params require manual parsing:
const match = pathname.match(/^\/api\/software-house\/rooms\/([^\/]+)$/);
if (match) { const roomId = match[1]; ... }
// Order: more specific routes before parameterized ones
case "/api/software-house/rooms": return handleRoomsList(req, res);
// match for /api/software-house/rooms/:id goes BEFORE general fallthrough
```

### 4️⃣ COMPLETE UI FUNCTION-TO-ENDPOINT MAPPING

Every function that currently uses local mock data replaced with API call. Pattern:

```javascript
// BEFORE (mock):
function saveAgent() {
  const a = agents.find(x => x.id === selectedAgent);
  a.status = document.getElementById('mStatus').value;
  // ... local array mutation ...
  renderAll();
  toast(`💾 ${a.name} zaktualizowany`);
}

// AFTER (API):
async function saveAgent() {
  const resp = await fetch('/api/software-house/agents/' + selectedAgent, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: document.getElementById('mStatus').value,
      model: document.getElementById('mModel').value,
      room: document.getElementById('mRoom').value,
      sprite: document.getElementById('mSprite').value,
      task: document.getElementById('mTask').value,
      prompt: document.getElementById('mPrompt').value,
    }),
  });
  if (!resp.ok) { toast('❌ Błąd zapisu: ' + resp.status); return; }
  const updated = await resp.json();
  // Replace in local array from API response
  const idx = agents.findIndex(x => x.id === selectedAgent);
  if (idx >= 0) agents[idx] = updated;
  renderAll();
  toast(`💾 ${updated.name} zaktualizowany`);
}
```

#### Complete wire-up table:

| UI Function | Current behavior | New behavior | API call |
|------------|-----------------|-------------|----------|
| `loadMockData()` (line 658) | Fetches `MOCK_DATA_URL` | Fetches bootstrap endpoint | `GET /api/software-house/bootstrap?project=ID` |
| `switchProject(id)` (line 702) | Loads from `projectsCatalog` | Fetches bootstrap for new project | `GET /api/software-house/bootstrap?project=ID` |
| `confirmHire()` (line 1433) | `agents.push()` + toast | `POST /api/software-house/agents/hire` → replace from response | POST |
| `saveAgent()` (line 1267) | Local mutation + toast | `PATCH /api/software-house/agents/:id` → replace from response | PATCH |
| `fireAgent()` (line 1282) | `agents.filter()` + toast | `PATCH /api/software-house/agents/:id { status: "inactive" }` | PATCH |
| `saveRoomPanel()` (line 1384) | Local mutation + toast | `PATCH /api/software-house/rooms/:id` → replace from response | PATCH |
| `deleteRoom()` (line 1396) | `rooms.filter()` + toast | `DELETE /api/software-house/rooms/:id` → re-fetch rooms or remove | DELETE |
| `addRoom()` (line 1410) | `rooms.push()` + toast | `POST /api/software-house/rooms` → push response entity | POST |
| `setRoomLayout()` (line 831) | Local mutation only | `PATCH /api/software-house/rooms/:id { layout: "row" }` | PATCH |
| `renderTaskPanel()` advance button (line 1312) | `toast('Task przesunięty')` | `POST /api/software-house/backlog/move { taskId, newPhase }` | POST |
| Kanban board (no function — inline drag) | Renders from `tasks` array | Same structure, data from bootstrap + refetch on move | GET+POST |
| `sendChat()` (line 1471) | Client-side canned replies | `POST /api/software-house/pm/chat` → real API response | POST |
| `sendPmBubble()` (line 1587) | Client-side canned replies | `POST /api/software-house/pm/chat` | POST |
| `pmQuick('plan')` (line 1548) | Client-side canned HTML | `POST /api/software-house/quick-action { action: "plan" }` | POST |
| `pmQuick('status')` (line 1548) | Client-side draft from local arrays | `POST /api/software-house/quick-action { action: "status" }` | POST |
| `orchSay()` (line 1460) | Client-side canned | Routes through same PM chat endpoint | POST |
| `renderVault()` (line 1611) | Reads from `project.vault` object | `GET /api/software-house/vault/tree` | GET |
| `openVaultFile()` (line 1639) | Reads from `project.vault[path]` | `GET /api/software-house/vault/doc?path=...` | GET |
| Sync button (line 482) | `toast('Sync — mockup')` | `POST /api/software-house/vault/sync` | POST |
| Inject button (line 1657) | `toast('Context injection — mockup')` | `POST /api/software-house/vault/inject` | POST |
| Room drag/resize (lines 1048-1062) | DOM-only, not persisted | Auto-save on mouseup via `POST /api/software-house/layout/save` | POST |

### 5️⃣ CORRECTIONS FROM QA

#### ❌ v2 Error: `loadData()` function doesn't exist
**Fixed:** Real function is `loadMockData()` at line 658. Mock fetch at lines 660-670 already has try/catch + toast. Swap URL and error message only.

#### ❌ v2 Error: quick-action infrastructure doesn't exist
**Fixed:** `/api/quick-action` at line 1114 of dashboard-handler.ts already exists. Uses `fetch` to gateway's `/v1/chat/completions` to spawn agent sessions. Dashboard handler functions `handleQuickAction()` + `quickActionSpawn()` all exist. PM Chat plan button can call this directly.

#### ❌ v2 Error: Vault injection stored in SQLite
**Fixed:** Use in-memory `sessionTracker.injectedDocs: Map<string, string[]>` instead. The HTTP handler sets it, `before_prompt_build` consumes and clears it. They share the Node.js process and sessionTracker singleton.

#### ❌ v2 Missing: Phase/status sync
**Fixed:** Added in §2 above. Kanban move handler must sync `status` from `phase`.

#### ⚠️ v2 "Restart gateway" → manual step
**Fixed:** Phase 7 changed to manual user step only.

#### ❌ v2 Missing: Path-param routing docs
**Fixed:** Added regex matching pattern in §3.

#### ❌ v2 Missing: Loading/error states
**Fixed:** `loadMockData()` already has try/catch with toast error. Add loading spinner:
```javascript
// In loadMockData() before fetch:
document.getElementById('loadingSpinner').style.display = 'block';
// Or show in toast:  
toast('⏳ Ładowanie danych projektu...');
```

#### ✅ Friend's visuals preserved
- **All 1695 lines of `software-house.html`** — zero visual alterations, only URL swaps + function body swaps
- **All 40 pixel sprite files** — preserved
- **`UX-ANALYSIS.md`** — removed from delete list (friend's design artifact)
- **Mock JSON** — kept as API contract fixture (just no longer loaded by UI)
- **CSS, layout, animations, interactions** — untouched

### 6️⃣ EVERY TOAST-ONLY BUTTON REPLACED (no dead code)

| Current toast | Replacement |
|-------------|-------------|
| `toast('Sync z orchestratorem — mockup')` | `POST /api/software-house/vault/sync` → toast with real result |
| `toast('Context injection — mockup')` | `POST /api/software-house/vault/inject` → toast with inject status |
| `toast('Task przesunięty')` | `POST /api/software-house/backlog/move` → re-render kanban + toast |
| `toast('Plan OK')` (in orchSay plan) | Remove; planning goes through quick-action |
| `toast('⚠️ Nie wczytano danych mock')` (error) | Keep pattern, update message to '⚠️ Nie wczytano danych' |
| `toast('💾 ... zaktualizowany')` | Keep, fires after API success |
| `toast('👋 ... zwolniony')` | Keep, fires after API success |

### 7️⃣ UPDATED IMPLEMENTATION PHASES

### Phase 0 — Prep + Verification (10 min)
- [ ] Remove only truly stale docs (AUDIT.md, SETUP.md, TEST_COVERAGE_PLAN.md, VERSIONING.md, workflow-enforcement-design.md, PLAN-autonomous-pipeline.md, session-lock-fix-plan.md, PROTOTYPE-kanban-team.md)
- [ ] **Keep:** CHANGELOG.md (user decision), UX-ANALYSIS.md (friend's work)
- [ ] Delete `src/index.test.ts`
- [ ] Update TOC in `src/index.ts` (lines 23-72) with correct line ranges
- [ ] **Verify registration pipeline:** Call `genorch_session_register` → `genorch_project_bind` → `genorch_session_start_work` on the real gateway session key. Confirm no key errors. Then test `genorch_task_delegate` spawns correctly.
- [ ] Push cleanup

### Phase 1 — V4 Migration (30 min)
- [ ] Add V4 migration in `src/db.ts` — extend tables + create new tables
- [ ] Add `status` sync: kanban move handler must also update `status`
- [ ] Add export CRUD functions for new tables
- [ ] Build + test

### Phase 2 — Read API (1 hr)
- [ ] Implement `GET /api/software-house/bootstrap` — aggregates rooms, agents, tasks, vault
- [ ] Implement model ID shortening
- [ ] Implement `GET /api/software-house/vault/tree` + `GET /api/software-house/vault/doc`
- [ ] Implement `GET /api/software-house/rooms/:id` + `GET /api/software-house/agents/:id`
- [ ] Implement `GET /api/software-house/pm/chat`
- [ ] Build + test with curl against mock-compatible shape

### Phase 3 — Frontend bootstrap swap (1 hr)
- [ ] Rename `loadMockData()` in plan references (actual code: change `MOCK_DATA_URL` to bootstrap URL)
- [ ] Add loading spinner to `loadMockData()` before fetch
- [ ] Update error message from '— mock' to live error
- [ ] Wire `switchProject()` to re-fetch bootstrap
- [ ] Test: office canvas, kanban, vault all render from live DB
- [ ] Test: project switching works

### Phase 4 — Write API: Agents & Rooms (1.5 hr)
- [ ] `POST /api/software-house/agents/hire`
- [ ] `PATCH /api/software-house/agents/:id`
- [ ] `POST /api/software-house/rooms` + `PATCH /api/software-house/rooms/:id` + `DELETE /api/software-house/rooms/:id`
- [ ] `POST /api/software-house/layout/save`
- [ ] Wire each to corresponding UI function (see §4 above)
- [ ] Test: hire agent → appears on desk; edit → saves; delete → removes

### Phase 5 — Write API: Kanban + Tasks (1 hr)
- [ ] `POST /api/software-house/backlog/move` with phase→status sync
- [ ] Wire kanban drag handler + `→ Następna faza` button
- [ ] Wire task detail panel
- [ ] Test: move card through all 4 phases, verify status syncs, backlog dispatch doesn't re-dispatch

### Phase 6 — Write API: PM Chat + Quick Actions (2 hr)
- [ ] `POST /api/software-house/pm/chat` — stores message, returns AI response (quick action or canned)
- [ ] Wire `sendChat()`, `sendPmBubble()`, `orchSay()` to real endpoint
- [ ] Wire `pmQuick('plan')` → `POST /api/software-house/quick-action` → spawns subagent via existing `handleQuickAction()`
- [ ] Wire `pmQuick('status')` → reads real project stats from DB
- [ ] Wire `pmQuick('blockers')` → queries errored agents from DB
- [ ] Test: type message → appears in chat; press "Plan sprint" → subagent spawns

### Phase 7 — Write API: Vault + Inject (1 hr)
- [ ] `POST /api/software-house/vault/sync` — reads `orchestrator-data/projects/X/*.md` into vault_docs table
- [ ] `POST /api/software-house/vault/inject` — sets `sessionTracker.injectedDocs` for current session
- [ ] Add `before_prompt_build` vault injection section (consumes + clears from in-memory tracker)
- [ ] `PUT /api/software-house/vault/doc` — save document to disk
- [ ] Wire sync button, inject button, vault file tree
- [ ] Test: sync button → vault populates; inject button → next AI prompt includes doc content

### Phase 8 — Polish + Manual Gateway Restart (30 min, user step)
- [ ] Remove `MOCK_DATA_URL` constant from UI (file stays on disk as test fixture)
- [ ] Remove all `toast('...mockup')` calls — verify zero remain
- [ ] Remove `localStorage.getItem('mockup-fs-scale')` → `'sh-fs-scale'` (rename key)
- [ ] Final build + test all 18 UI interactions end-to-end
- [ ] **User: manually restart gateway** when ready: `pm2 restart genor-orchestrator-plugin` (or through OpenClaw)

### 8️⃣ VERIFICATION ACCEPTANCE CRITERIA

| Check | What to verify |
|-------|---------------|
| Registration | `genorch_session_register` → `genorch_project_bind` → `genorch_session_start_work` all succeed with real gateway key |
| Bootstrap | `curl` returns mock-compatible JSON shape from real DB |
| Office canvas | Rooms, agents, desks render from live bootstrap data |
| Hire agent | Button → modal → fill → confirm → agent appears on desk + in DB |
| Edit agent | Detail panel → edit fields → save → values persist in DB |
| Fire agent | Detail panel → fire → agent removed from desk + DB |
| Add room | Button → new room appears on canvas + in DB |
| Drag/resize room | Grab handle → move → layout saved in DB |
| Kanban | Cards render from backlog_tasks.phase |
| Kanban move | Drag card or click "→ Next phase" → phase updates in DB + kanban re-renders |
| Phase/status sync | Move to "in-progress" → `status = in_progress`, backlog dispatch won't pick it |
| Vault tree | File folders render from vault_docs table |
| Vault file | Click file → content renders from vault_docs |
| Sync button | Disk → vault_docs sync works |
| Inject button | Clicks → next AI turn includes doc content in prompt |
| PM Chat | Type message → stored in pm_chat table + shows in chat |
| Quick action "Plan sprint" | Button → subagent spawns → status shows in chat |
| Quick action "Status" | Returns real project stats (agent count, phase count) |
| Task advance button | Click → phase advances to next in sequence |
| Zero mockups | Search for "mockup" in HTML — none remain |
| Gateway restart | Manual step — all features work after restart |

### 9️⃣ FINAL PITFALL WARNINGS (corrected)

1. **Bootstrap response must be EXACT mock JSON shape** — `{ defaultProjectId, projects: { [id]: { rooms, agents, tasks, vault: { [path]: VaultDoc } } } }`. The UI does `project.vault["STATE.md"]`, not `project.vault[0]`.

2. **Model IDs mismatch** — Strip `opencode-go/` prefix in bootstrap output. The mock uses `"deepseek-v4-pro"`, DB stores `"opencode-go/deepseek-v4-pro"`.

3. **Quick-action infrastructure EXISTS** — `/api/quick-action` at dashboard-handler.ts line 1114 + `handleQuickAction()` + `quickActionSpawn()` all exist. PM Chat plan button CAN call this directly.

4. **Vault injection: in-memory, not SQLite** — Store on `sessionTracker.injectedDocs` (in-memory map, same Node.js process). `before_prompt_build` consumes and clears. NOT in session's `extra` column.

5. **Phase/status sync is MANDATORY** — Without it, `genorch_backlog_dispatch` re-dispatches kanban-in-progress tasks. Move handler must sync both columns.

6. **Room drag/resize auto-save** — On mouseup, call `POST /api/software-house/layout/save` with all room positions. Debounce by 500ms to avoid flooding.

7. **SSE already exists** — Don't create new SSE. `/orchestrator/api/sse/live-sessions` pushes session updates. UI can subscribe for real-time agent status.

8. **PM Chat is client-rendered** — `/api/software-house/pm/chat` stores + returns messages. Quick actions spawn subagents via `handleQuickAction()` which fires and forgets. No blocking LLM call inside the HTTP handler.

9. **Gateway restart — MANUAL** — Phase 8 requires user to run `pm2 restart genor-orchestrator-plugin` or through OpenClaw. Never auto-restart.

10. **`genorch_project_bind` returns project context** — The bootstrap endpoint is for the frontend. `genorch_project_bind` is for AI sessions. They serve different purposes and both feed from the same DB tables.
