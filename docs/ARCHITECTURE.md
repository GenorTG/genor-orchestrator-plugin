# Genor Orchestrator Plugin — Architecture

> Complete visual reference for the plugin's structure, data flow, and capabilities.

---

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          OPENCLAW GATEWAY                                   │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                     PLUGIN: genorch                                   │  │
│  │                                                                       │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │  │
│  │  │   index.ts   │  │   db.ts     │  │software-    │  │dashboard-   │  │  │
│  │  │  (main)      │  │ (database)  │  │house.ts     │  │handler.ts   │  │  │
│  │  │             │  │             │  │ (API)       │  │ (HTTP)      │  │  │
│  │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  │  │
│  │         │                │                │                │          │  │
│  │         └────────────────┼────────────────┼────────────────┘          │  │
│  │                          │                │                           │  │
│  │                    ┌─────▼─────┐    ┌─────▼─────┐                     │  │
│  │                    │  SQLite   │    │  Static   │                     │  │
│  │                    │  Database │    │  Files    │                     │  │
│  │                    └───────────┘    └───────────┘                     │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                     SOFTWARE HOUSE UI                                 │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐    │  │
│  │  │ Office  │  │ Kanban  │  │  Vault  │  │  Chat   │  │ Settings│    │  │
│  │  │  View   │  │  Board  │  │  Docs   │  │  PM AI  │  │  Config │    │  │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘  └─────────┘    │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Database Schema

```mermaid
erDiagram
    sessions ||--o{ sessions_v2 : "v1 → v2 migration"
    backlog_tasks ||--o{ backlog_tasks_v2 : "v1 → v2 migration"
    
    sessions {
        text session_key PK
        text project
        text task
        text model
        text agent
        text status
        datetime started_at
        datetime ended_at
        text worker_id FK
        text context_used
    }
    
    backlog_tasks {
        integer id PK
        text title
        text description
        text status
        text priority
        text labels
        text project
        datetime created_at
        text worker_id FK
    }
    
    workers {
        text id PK
        text name
        text role
        text sprite
        text model
        text status
        text room
        text prompt
        text project
        datetime created_at
    }
    
    rooms {
        text id PK
        text name
        text purpose
        text taskTypes
        text project
        integer isCommand
        real x
        real y
        real w
        real h
    }
    
    vault_docs {
        text path PK
        text title
        text content
        text folder
        text project
        text status
        text tags
        text links
        text icon
        datetime updated_at
    }
    
    pm_chat {
        integer id PK
        text message
        text sender
        text project
        datetime created_at
    }
    
    models {
        text id PK
        text provider
        text display_name
        integer context_window
        real cost_per_1k_input
        real cost_per_1k_output
        text grade
        text status
        text project_routing
        boolean agent_ready
    }
    
    state_events {
        integer id PK
        text project
        text event_type
        text data
        datetime created_at
    }
    
    logs {
        integer id PK
        text level
        text source
        text message
        text data
        datetime created_at
    }
```

---

## 3. API Endpoints (Software House)

```mermaid
flowchart TB
    subgraph "Software House API"
        direction TB
        
        subgraph "Bootstrap"
            BS[GET /api/software-house/bootstrap]
        end
        
        subgraph "Workers"
            WG[GET /api/software-house/workers]
            WH[POST /api/software-house/workers/hire]
            WU[PATCH /api/software-house/workers/:id]
            WD[DELETE /api/software-house/workers/:id]
        end
        
        subgraph "Rooms"
            RG[GET /api/software-house/rooms]
            RP[POST /api/software-house/rooms]
            RU[PATCH /api/software-house/rooms/:id]
            RDD[DELETE /api/software-house/rooms/:id]
            RL[POST /api/software-house/layout/save]
        end
        
        subgraph "Backlog"
            BG[GET /api/software-house/backlog]
            BM[POST /api/software-house/backlog/move]
        end
        
        subgraph "PM Chat"
            CG[GET /api/software-house/pm/chat]
            CP[POST /api/software-house/pm/chat]
        end
        
        subgraph "Vault"
            VT[GET /api/software-house/vault/tree]
            VD[GET /api/software-house/vault/doc]
            VU[PUT /api/software-house/vault/doc]
            VI[POST /api/software-house/vault/inject]
        end
    end
    
    BS --> WG
    BS --> RG
    BS --> BG
    BS --> VT
    
    WG --> WH
    WG --> WU
    WG --> WD
    
    RG --> RP
    RG --> RU
    RG --> RDD
    RG --> RL
    
    BG --> BM
    
    CG --> CP
    
    VT --> VD
    VT --> VU
    VT --> VI
```

---

## 4. Registered Tools (52 total)

```mermaid
flowchart LR
    subgraph "Session Management"
        S1[session_register]
        S2[session_start_work]
        S3[session_clear_work]
        S4[session_unregister]
        S5[session_list]
        S6[session_log]
    end
    
    subgraph "Project Management"
        P1[project_create]
        P2[project_join]
        P3[project_leave]
        P4[project_list_active]
        P5[project_sync_files]
        P6[project_sync_docs]
        P7[project_docs_list]
        P8[project_rebuild_state]
        P9[project_tidy_docs]
    end
    
    subgraph "Backlog"
        B1[backlog_add]
        B2[backlog_list]
        B3[backlog_update]
        B4[backlog_dispatch]
        B5[backlog_dispatch_all]
    end
    
    subgraph "Models"
        M1[models_list]
        M2[models_check_routing]
        M3[models_auto_discover]
        M4[models_recommend]
    end
    
    subgraph "QA & Verification"
        Q1[qa_submit]
        Q2[qa_approve]
        Q3[qa_reject]
        V1[verify_pipeline_start]
        V2[verify_pipeline_check]
        V3[verify_pipeline_guide]
    end
    
    subgraph "Delegation"
        D1[task_delegate]
        D2[feature_design]
        D3[issue_debug]
        D4[knowledge_quiz]
    end
    
    subgraph "Workflow"
        W1[workflow_advance_phase]
        W2[handoff_create]
        W3[adr_log]
    end
    
    subgraph "Testing"
        T1[test_create_unit]
        T2[test_create_e2e]
    end
    
    subgraph "System"
        SY1[status]
        SY2[config_show_routing]
        SY3[logs_query]
        SY4[system_diagnose]
    end
```

---

## 5. Data Flow: Worker Lifecycle

```mermaid
sequenceDiagram
    participant User as User/AI
    participant UI as Software House UI
    participant API as API Endpoint
    participant DB as SQLite DB
    participant Worker as Worker Agent

    Note over User,Worker: HIRE PHASE
    
    User->>UI: Click "Zatrudnij"
    UI->>UI: Open hire dialog
    User->>UI: Fill form (name, role, model)
    UI->>API: POST /workers/hire
    API->>DB: INSERT INTO workers
    DB-->>API: Worker ID
    API-->>UI: { ok: true, worker }
    UI->>UI: Add to agents array
    UI->>UI: Render desk on office map
    
    Note over User,Worker: WORK PHASE
    
    User->>UI: Click worker desk
    UI->>UI: Open edit panel
    User->>UI: Change model/status/task
    UI->>API: PATCH /workers/:id
    API->>DB: UPDATE workers SET ...
    DB-->>API: OK
    API-->>UI: { ok: true }
    UI->>UI: Update agent in array
    UI->>UI: Re-render desk
    
    Note over User,Worker: FIRE PHASE
    
    User->>UI: Click "Zwolnij"
    UI->>UI: Confirm dialog
    User->>UI: Confirm
    UI->>API: DELETE /workers/:id
    API->>DB: DELETE FROM workers
    DB-->>API: OK
    API-->>UI: { ok: true }
    UI->>UI: Remove from agents array
    UI->>UI: Remove desk from office
```

---

## 6. Data Flow: Chat & Vault

```mermaid
sequenceDiagram
    participant User as User
    participant UI as Software House UI
    participant API as API Endpoint
    participant DB as SQLite DB

    Note over User,DB: CHAT FLOW
    
    User->>UI: Type message + Enter
    UI->>API: POST /pm/chat { message, sender: "user" }
    API->>DB: INSERT INTO pm_chat
    DB-->>API: Message ID
    API-->>UI: { ok: true, id }
    UI->>UI: Add message bubble
    
    UI->>API: GET /pm/chat (history)
    API->>DB: SELECT * FROM pm_chat
    DB-->>API: Messages array
    API-->>UI: { ok: true, messages }
    UI->>UI: Render chat history
    
    Note over User,DB: VAULT FLOW
    
    UI->>API: GET /vault/tree
    API->>DB: SELECT * FROM vault_docs
    DB-->>API: Documents array
    API-->>UI: { ok: true, vault }
    UI->>UI: Render tree sidebar
    
    User->>UI: Click document
    UI->>API: GET /vault/doc?path=X
    API->>DB: SELECT * FROM vault_docs WHERE path=?
    DB-->>API: Document
    API-->>UI: { ok: true, doc }
    UI->>UI: Render content
    
    User->>UI: Edit + Save
    UI->>API: PUT /vault/doc { path, content }
    API->>DB: INSERT OR REPLACE INTO vault_docs
    DB-->>API: OK
    API-->>UI: { ok: true }
```

---

## 7. Worker Capabilities

### Current State: **Visual Management Only**

Workers in the Software House UI are **visual representations** with metadata:

| Capability | Status | Description |
|------------|--------|-------------|
| **Visual rendering** | ✅ Working | Sprites on office map with status indicators |
| **Metadata management** | ✅ Working | Name, role, model, status, room assignment |
| **Hire/Edit/Fire** | ✅ Working | Full CRUD via API to database |
| **Room assignment** | ✅ Working | Workers belong to rooms |
| **Status tracking** | ✅ Working | sleep/working/thinking/error states |
| **Task assignment** | ⚠️ Partial | Can assign task text, but no execution |
| **AI model selection** | ✅ Working | Each worker has a configured model |
| **Actual work execution** | ❌ Not implemented | Workers don't run tasks autonomously |
| **Subagent spawning** | ❌ Not connected | No link to OpenClaw subagent system |
| **Context injection** | ❌ Not connected | No link to vault docs for prompts |

### What Would Make Workers "Work"

To enable actual task execution, the plugin would need:

1. **Subagent Integration**: Connect worker → OpenClaw subagent session
2. **Task Queue**: Worker picks tasks from backlog, executes via subagent
3. **Context Pipeline**: Vault docs → worker prompt → subagent context
4. **Status Updates**: Subagent completion → worker status → UI update
5. **Result Capture**: Subagent output → backlog task status → vault doc

---

## 8. Component Architecture

```mermaid
flowchart TB
    subgraph "Frontend (Software House UI)"
        direction TB
        
        subgraph "Views"
            OV[Office View<br/>🗺️ Visual workspace with desks]
            KV[Kanban View<br/>📊 Task board by phase]
            VV[Vault View<br/>📚 Project documentation]
            SV[Settings View<br/>⚙️ Project configuration]
        end
        
        subgraph "Panels"
            AP[Agent Panel<br/>👤 Worker details/edit]
            RP[Room Panel<br/>🏢 Room settings]
            CP[Chat Panel<br/>💬 PM AI assistant]
        end
        
        subgraph "Components"
            DS[Desk Slots<br/>🖱️ Clickable worker sprites]
            RM[Room Map<br/>📐 Draggable room areas]
            CB[Chat Bubbles<br/>💭 Message display]
            VT[Vault Tree<br/>🌳 Document navigator]
        end
    end
    
    subgraph "Backend (Plugin)"
        direction TB
        
        subgraph "API Layer"
            SH[Software House Router<br/>🔀 18 endpoints]
            DH[Dashboard Handler<br/>🌐 Static files + proxy]
        end
        
        subgraph "Data Layer"
            DB[(SQLite Database<br/>💾 15+ tables)]
            FS[File System<br/>📁 Dashboard assets]
        end
        
        subgraph "Tools (52)"
            TM[Tool Metadata<br/>📋 Auto-collected]
            TR[Tool Registration<br/>🔧 api.registerTool]
        end
    end
    
    subgraph "External"
        OC[OpenClaw Gateway<br/>🚀 Plugin host]
        AI[AI Models<br/>🤖 LLM inference]
        SUB[Subagents<br/>👶 Child sessions]
    end
    
    OV --> DS
    OV --> RM
    KV --> CB
    VV --> VT
    
    DS --> SH
    RM --> SH
    CB --> SH
    VT --> SH
    
    SH --> DB
    DH --> FS
    DH --> SH
    
    TR --> OC
    OC --> AI
    OC --> SUB
```

---

## 9. Complete File Structure

```
genor-orchestrator-plugin/
├── src/
│   ├── index.ts              # Main plugin (52 tools, session management, hooks)
│   ├── db.ts                 # Database schema, migrations, helpers
│   ├── software-house.ts     # Software House API (18 endpoints)
│   ├── dashboard-handler.ts  # HTTP server, static files, proxy
│   └── shared.ts             # Shared utilities
│
├── dashboard/
│   ├── software-house.html   # Main UI (single-page app)
│   ├── data/
│   │   └── software-house-mock.json  # Mock data reference
│   └── assets/
│       └── pixel-agents/     # Worker sprites
│           ├── blue/
│           ├── orange/
│           ├── purple/
│           └── hacker/
│
├── docs/
│   ├── MERGER-PLAN.md        # Feature roadmap
│   └── ARCHITECTURE.md       # This file
│
├── dist/                     # Compiled JavaScript
├── orchestrator-data/        # Runtime data (models, projects)
└── package.json
```

---

## 10. Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Single HTML file** | No build step, easy to edit, self-contained |
| **SQLite database** | Zero-config, portable, sufficient for plugin data |
| **Separate software-house.ts** | Isolates new feature, keeps index.ts manageable |
| **Mock-compatible API shape** | Frontend was built against mock JSON, API matches it |
| **Visual-first workers** | UI works immediately, execution can be added later |
| **Room-based organization** | Natural grouping for workers and tasks |
| **Vault as file system** | Familiar mental model, easy to extend |
| **PM Chat as AI interface** | Natural language control for orchestrator |

---

## 11. Future Architecture (When Workers Execute)

```mermaid
flowchart TB
    subgraph "Current"
        U[User] --> UI[Software House UI]
        UI --> API[API Endpoints]
        API --> DB[(SQLite)]
    end
    
    subgraph "Future: Worker Execution"
        API --> WQ[Worker Queue]
        WQ --> WK[Worker Runtime]
        WK --> SA[Subagent Spawner]
        SA --> CH[Child Session]
        CH --> LLM[AI Model]
        LLM --> |completion| WK
        WK --> |status update| DB
        WK --> |result| VT[Vault Docs]
        DB --> |notify| UI
    end
    
    subgraph "Context Pipeline"
        VT --> |inject| WK
        WK --> |prompt build| LLM
        LLM --> |output| WK
        WK --> |save| VT
    end
```

---

*Generated: 2026-06-24 | Version: 0.9.4 | Branch: feat/software-house-merger*
