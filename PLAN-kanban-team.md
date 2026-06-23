# 🎯 PLAN: Kanban Board + Agent Team Management

## TL;DR
Dodajemy do GenorBoard wizualny Kanban z zarządzaniem zespołem agentów.
Użytkownik tworzy projekt → definiuje fazy (kolumny) → tworzy taski (kafelki) →
przydziela agentów z konkretnymi modelami i instrukcjami → orchestrator rozdziela zadania.

---

## 🗺️ Architektura

```
┌──────────────────────────────────────────────────────────────┐
│                      GenorBoard Dashboard                     │
│  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌──────┐  │
│  │Dashboard│Projects│  Team  │Kanban│Models│ Logs │Settings│  │
│  │  📊   │  📁  │  👥  │ 📋  │ 🧠  │ 📜  │ ⚙️   │        │  │
│  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └──────┘  │
│                          ↑ NEW     ↑ NEW                       │
└──────────────────────────────────────────────────────────────┘
```

---

## 📊 NOWY WIDOK: Kanban Board `📋`

### Layout

```
┌──────────────────────────────────────────────────────────────┐
│ Project: [my-saas ▼]  ────  ────  ────  ────  ────  ────   │
│                                                               │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────┐ │
│ │📋 Backlog│ │🔍 Research│ │🎨 Design │ │⚙️ Develop│ │✅ Done│ │
│ │          │ │          │ │          │ │          │ │       │ │
│ │ ┌──────┐ │ │ ┌──────┐ │ │ ┌──────┐ │ │ ┌──────┐ │ │┌─────┐│ │
│ │ │Biz   │ │ │ │Market│ │ │ │UI    │ │ │ │API   │ │ ││Docs ││ │
│ │ │Plan  │ │ │ │Analy-│ │ │ │Mockup│ │ │ │Design│ │ ││Done ││ │
│ │ │P0 👤 │ │ │ │sis 📊│ │ │ │Figma │ │ │ │REST  │ │ ││✅   ││ │
│ │ │      │ │ │ │      │ │ │ │      │ │ │ │      │ │ ││     ││ │
│ │ └──────┘ │ │ └──────┘ │ │ └──────┘ │ │ └──────┘ │ │└─────┘│ │
│ │ ┌──────┐ │ │ ┌──────┐ │ │ ┌──────┐ │ │ ┌──────┐ │ │┌─────┐│ │
│ │ │UX    │ │ │ │Compe-│ │ │ │Compo-│ │ │ │DB    │ │ ││Depl-││ │
│ │ │Plan  │ │ │ │titor │ │ │ │nent  │ │ │ │Schema│ │ ││oyed ││ │
│ │ │P1    │ │ │ │Review│ │ │ │Lib   │ │ │ │      │ │ ││🚀   ││ │
│ │ │      │ │ │ │      │ │ │ │      │ │ │ │      │ │ ││     ││ │
│ │ └──────┘ │ │ └──────┘ │ │ └──────┘ │ │ └──────┘ │ │└─────┘│ │
│ │          │ │          │ │          │ │          │ │       │ │
│ │ + Add    │ │ + Add    │ │ + Add    │ │ + Add    │ │       │ │
│ └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────┘ │
│  4 tasks      2 tasks      2 tasks      2 tasks      2 tasks  │
└──────────────────────────────────────────────────────────────┘
```

### Cechy Kanbana:
- **Drag & drop** kart między kolumnami → zmiana fazy
- **Kolumny konfigurowalne** per projekt (nie sztywne "todo/in progress/done")
- **Karta zadania** pokazuje: tytuł, priorytet (P0-P3), przypisanego agenta (awatar), typ (📊 research, 🎨 design, ⚙️ dev, 📝 docs), deadline, tagi
- **Kliknięcie karty** → modal z pełnym opisem, historią, komentarzami
- **Kolorowanie** priorytetów: P0-czerwony, P1-pomarańczowy, P2-żółty, P3-szary
- **Filtry**: po agencie, priorytecie, typie, tagu
- **Widok alternatywny**: lista (dla małych ekranów)

### Karta zadania (szczegóły):
```
┌─────────────────────────────────────┐
│ Task: Business Plan          [✕]   │
│ ─────────────────────────────────── │
│ 📋 Faza: Backlog                    │
│ 🎯 Priorytet: P0 (krytyczny)       │
│ 👤 Agent: Alice (DeepSeek V4 Pro)   │
│ 🏷️ Typ: Research / Strategy         │
│ ⏰ Deadline: 2026-06-30             │
│ ─────────────────────────────────── │
│ Description:                        │
│ Stwórz kompleksowy biznesplan dla   │
│ SaaS-a. Uwzględnij analizę rynku,   │
│ model przychodowy, strategię GTM.   │
│ ─────────────────────────────────── │
│ 📎 Pliki: bizplan-draft.md          │
│ 🕐 Historia:                        │
│   10:23 → assigned to Alice         │
│   10:45 → moved to Research         │
│   11:02 → Alice: draft ready        │
│ ─────────────────────────────────── │
│ [Zamknij] [Edytuj] [Przypisz agenta]│
└─────────────────────────────────────┘
```

---

## 👥 NOWY WIDOK: Team / Agents `👥`

### Layout

```
┌──────────────────────────────────────────────────────────────┐
│ 🏢 Agent Team                              [+ Add Agent]     │
│                                                               │
│ ┌─────────────────────┐ ┌─────────────────────┐              │
│ │ 🦊 Alice             │ │ 🐺 Bob               │              │
│ │ DeepSeek V4 Pro     │ │ MiniMax M3            │              │
│ │ ─────────────────── │ │ ───────────────────  │              │
│ │ 📋 Active tasks: 2  │ │ 📋 Active tasks: 3   │              │
│ │ 🟢 Online           │ │ 🟡 Busy              │              │
│ │ ─────────────────── │ │ ───────────────────  │              │
│ │ System prompt:      │ │ System prompt:       │              │
│ │ You are a strategic │ │ You are a backend    │              │
│ │ business analyst.   │ │ architect focused    │              │
│ │ Focus on market     │ │ on scalable systems. │              │
│ │ research and GTM.   │ │                      │              │
│ │ ─────────────────── │ │ ───────────────────  │              │
│ │ 📁 Projects:        │ │ 📁 Projects:         │              │
│ │  • my-saas          │ │  • my-saas           │              │
│ │  • internal-tool    │ │  • internal-tool     │              │
│ │ ─────────────────── │ │ ───────────────────  │              │
│ │ [Edit] [Disable]    │ │ [Edit] [Disable]     │              │
│ └─────────────────────┘ └─────────────────────┘              │
│                                                               │
│ ┌─────────────────────┐ ┌─────────────────────┐              │
│ │ 🦉 Charlie           │ │ 🐉 Diana             │              │
│ │ GLM 5.1             │ │ Qwen 3.7 Max         │              │
│ │ 📋 Active tasks: 0  │ │ 📋 Active tasks: 1   │              │
│ │ ⚪ Idle             │ │ 🟢 Online            │              │
│ │ ...                  │ │ ...                  │              │
│ └─────────────────────┘ └─────────────────────┘              │
└──────────────────────────────────────────────────────────────┘
```

### Cechy Team View:
- **Karty agentów** z awatarami SVG (emoji zwierzęta na start)
- **Status**: Online 🟢 / Busy 🟡 / Idle ⚪ / Offline 🔴
- **Model + system prompt** widoczne od razu
- **Aktywne zadania** zliczane
- **Przypisanie do projektów**
- **Dodawanie agenta** = formularz: nazwa, model, system prompt, ikona (emoji/SVG)

### Formularz dodawania agenta:
```
┌─────────────────────────────────────┐
│ Add Agent                   [✕]    │
│ ─────────────────────────────────── │
│ Name: [________________]            │
│ Icon: [🦊 ▼] (emoji picker)         │
│ Model: [DeepSeek V4 Pro ▼]         │
│ ─────────────────────────────────── │
│ System Instructions:               │
│ ┌────────────────────────────────┐  │
│ │ You are a strategic business   │  │
│ │ analyst. Focus on creating     │  │
│ │ comprehensive business plans   │  │
│ │ with market analysis, revenue  │  │
│ │ models, and GTM strategies.    │  │
│ │                                │  │
│ └────────────────────────────────┘  │
│ ─────────────────────────────────── │
│ Projects: [my-saas ▼] [+add]       │
│ ─────────────────────────────────── │
│ [Cancel]  [Save Agent]             │
└─────────────────────────────────────┘
```

---

## 🗄️ Data Model (SQLite — extends existing DB)

```sql
-- NEW: Configured agents (team members)
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT DEFAULT '🤖',
  model TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  status TEXT DEFAULT 'idle',  -- idle, busy, online, offline
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- NEW: Projects (extends existing project concept with workflow)
CREATE TABLE IF NOT EXISTS project_phases (
  id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  phase_name TEXT NOT NULL,      -- np. "Backlog", "Research", "Design", "Develop", "Done"
  sort_order INTEGER DEFAULT 0,
  color TEXT DEFAULT '#58a6ff',
  created_at TEXT DEFAULT (datetime('now'))
);

-- NEW: Kanban tasks
CREATE TABLE IF NOT EXISTS kanban_tasks (
  id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  phase_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  priority TEXT DEFAULT 'P2',   -- P0, P1, P2, P3
  task_type TEXT DEFAULT 'dev',  -- research, design, dev, docs, review, other
  assigned_agent_id TEXT,
  deadline TEXT,
  tags TEXT DEFAULT '[]',        -- JSON array
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (phase_id) REFERENCES project_phases(id),
  FOREIGN KEY (assigned_agent_id) REFERENCES agents(id)
);

-- NEW: Task history / activity log
CREATE TABLE IF NOT EXISTS task_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL,          -- created, moved, assigned, completed, commented
  agent_id TEXT,
  old_value TEXT,
  new_value TEXT,
  message TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES kanban_tasks(id)
);
```

---

## 🔌 API Endpoints (nowe)

| Endpoint | Metoda | Opis |
|----------|--------|------|
| `/api/kanban/:project` | GET | Pobiera fazy + taski dla projektu |
| `/api/kanban/:project/phases` | GET/POST/PATCH/DELETE | CRUD dla faz/kolumn |
| `/api/kanban/:project/tasks` | GET/POST | Lista / tworzenie tasków |
| `/api/kanban/tasks/:id` | PATCH/DELETE | Update / usuwanie taska |
| `/api/kanban/tasks/:id/move` | POST | Przenosi task do innej fazy |
| `/api/agents` | GET/POST | Lista / tworzenie agentów |
| `/api/agents/:id` | PATCH/DELETE | Update / usuwanie agenta |
| `/api/agents/:id/dispatch` | POST | Wysyła zadanie do agenta przez orchestrator |

---

## 🧠 Orchestrator: Jak to działa pod spodem

```
User tworzy task → przypisuje agenta → klika "▶ Dispatch"
        │
        ▼
Orchestrator pobiera:
  • Task: tytuł, opis, kontekst projektu
  • Agent: model, system prompt
        │
        ▼
Tworzy NOWĄ sesję OpenClaw przez /v1/chat/completions:
  • Model = agent.model
  • System = agent.system_prompt
  • User message = task.description + project context
  • x-openclaw-session-key = unique task session
        │
        ▼
Agent wykonuje zadanie w izolowanej sesji
  → output zapisywany w tasku
  → status aktualizowany na dashboardzie
        │
        ▼
Task move: Backlog → Research → Design → Develop → Done
  (automatycznie lub manualnie przez drag & drop)
```

---

## 🚀 Plan implementacji

### Faza 1: Backend (DB + API + Orchestrator) — ~2h
- [ ] Rozszerz `db.ts` o tabele: `agents`, `project_phases`, `kanban_tasks`, `task_activity`
- [ ] Dodaj nowe API routes w `dashboard-handler.ts`:
  - [ ] `GET/POST /api/agents`
  - [ ] `PATCH/DELETE /api/agents/:id`  
  - [ ] `GET/POST /api/kanban/:project/phases`
  - [ ] `GET/POST /api/kanban/:project/tasks`
  - [ ] `PATCH/DELETE /api/kanban/tasks/:id`
  - [ ] `POST /api/kanban/tasks/:id/move`
  - [ ] `POST /api/agents/:id/dispatch`
- [ ] Orchestrator dispatch: tworzenie sesji dla agenta przez OpenAI endpoint
- [ ] Auto-advance: gdy agent kończy, task przechodzi do następnej fazy (opcjonalnie)

### Faza 2: Frontend — Kanban Board ~2h
- [ ] Nowa zakładka "Kanban" w sidebarze (`data-tab="kanban"`)
- [ ] Renderowanie kolumn (faz) + kart (tasków)
- [ ] Drag & drop (native HTML5 Drag and Drop API)
- [ ] Modal tworzenia/edycji taska
- [ ] Modal szczegółów taska (historia, komentarze)
- [ ] Filtrowanie i wyszukiwanie
- [ ] Kolory priorytetów, awatary agentów na kartach

### Faza 3: Frontend — Team Management ~1h
- [ ] Nowa zakładka "Team" (`data-tab="team"`)
- [ ] Grid kart agentów
- [ ] Formularz dodawania/edycji agenta (modal)
- [ ] Status agentów: idle/busy/online
- [ ] Szybkie akcje: dispatch, edit, disable

### Faza 4: Integracja ~1h
- [ ] Połączenie Team → Kanban (przypisywanie agentów do tasków)
- [ ] Project selector na górze Kanbana
- [ ] Automatyczne tworzenie domyślnych faz przy nowym projekcie
- [ ] Testy integracyjne
- [ ] Dokumentacja w AGENTS.md

---

## 🎨 SVG Avatary (później)
- Na start: emoji (🦊 🐺 🦉 🐉 🐱 🦅 🐻 🦈)
- Docelowo: generowanie unikalnych SVG per agent (kolor + ikona + inicjały)
- Możliwość uploadu własnego awatara

---

## ⚡ Quick Wins (najpierw to)

1. **Dodaj zakładkę "Kanban"** — nawet z hardcodowanymi kolumnami, żeby zobaczyć jak to wygląda
2. **Dodaj mock agenta** — jeden agent z system promptem widoczny w sidebarze
3. **Połącz z istniejącym systemem projektów** — Kanban per projekt
4. **Dodaj drag & drop** — najbardziej satysfakcjonująca część wizualna

---

## ❓ Pytania do Ciebie

1. **Domyślne fazy** — jakie kolumny Kanban chcesz mieć domyślnie? 
   Proponuję: `Backlog → Research → Design → Development → Review → Done`
   
2. **Automatyczne przechodzenie?** — Czy gdy agent skończy zadanie, task ma automatycznie przejść do następnej fazy, czy zawsze manualnie?

3. **Jeden agent = jedna sesja na raz?** — Czy agent może pracować nad wieloma taskami równolegle?

4. **Czy chcesz zacząć od razu, czy najpierw chcesz zobaczyć mockup/prototyp w dashboardzie?**
