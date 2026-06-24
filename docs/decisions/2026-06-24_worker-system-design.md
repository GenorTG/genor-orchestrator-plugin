# Decision: Worker System Architecture

**Date:** 2026-06-24
**Participants:** Master Genor, Amy
**Status:** Approved

---

## Context

We need to make Software House workers functional — not just visual representations, but actual AI agents that can execute tasks, collaborate, and report progress.

## Decision

### 1. Worker Trigger Model
**Chose:** Option A (manual) with goal of Option B (auto), gated properly.

Workers are manually assigned tasks by PM/User, but the system is designed to eventually support automatic task picking from backlog. Manual gating ensures we can control and debug the system before enabling automation.

### 2. Execution Model
**Chose:** Persistent sessions per worker, subagent spawns for task execution.

Each worker has a persistent session key for tracking. When work needs to be done, the orchestrator spawns a subagent with the worker's context. This gives us:
- Session history for debugging
- Ability to recover from failures
- Token usage tracking
- Clean separation between workers

### 3. Context Model
**Chose:** Worker system prompt + task description + relevant vault docs.

Workers have a base "onboarding" prompt that defines their role and behavior. When assigned a task, they receive:
- Their identity and instructions
- The specific task to complete
- Relevant project documentation from vault

### 4. Output Model
**Chose:** Context-dependent output with inter-worker messaging.

- Developer finishes → sends to QA with context
- QA reviews → sends feedback or approval
- Developer fixes if needed → cycles until pass
- Final: updates docs, merges branch, notifies user

### 5. Relation to Existing Tools
**Chose:** New system that reuses existing tools internally.

The worker system is a new layer that:
- Uses `sessions_spawn` for task execution
- Uses `backlog_*` tools for task management
- Uses `qa_*` tools for review workflow
- Adds new `worker_*` tools for worker-specific operations

### 6. Concurrency Model
**Chose:** Respect OpenClaw limits, soft/hard file conflict prevention.

- Plugin reads OpenClaw's `maxConcurrent` settings
- Workers in different rooms = no conflict
- Workers in same room = soft lock (stay in lane)
- Workers needing same files = hard lock (separate branches)

### 7. PM Role
**Chose:** Coordinator + final responsible for delivery.

PM is a special worker (`isOrchestrator: true`) that:
- Talks to the user (CEO)
- Assigns tasks to workers
- Reviews results
- Updates project documentation
- Reports completion to user

## Consequences

### Positive
- Clean separation of concerns
- Works within OpenClaw's architecture
- Enables multi-worker collaboration
- Supports failure recovery
- Tracks costs and history

### Negative
- More complex than simple subagent spawning
- Requires database schema changes
- Needs careful session management
- Recovery logic is non-trivial

### Risks
- Session staleness detection may have false positives
- Inter-worker messaging could create complex workflows
- Cost tracking may be inaccurate if models don't report usage

## Action Items

1. Create `worker_sessions` table
2. Create `worker_messages` table
3. Implement worker session tracking
4. Implement task assignment tools
5. Implement inter-worker messaging
6. Implement failure recovery
7. Update UI for real-time status

---

*Next review: After Phase 2 completion*
