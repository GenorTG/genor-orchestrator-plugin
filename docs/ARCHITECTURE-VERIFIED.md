# OpenClaw Architecture: Verified Capabilities

> What plugins can actually do, based on real documentation.

---

## The Problem

Plugins cannot spawn sessions directly. But there's a clean solution.

---

## Solution: OpenAI HTTP API Endpoint

OpenClaw Gateway exposes an OpenAI-compatible `/v1/chat/completions` endpoint.

**Disabled by default.** Enable in config:
```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true }
      }
    }
  }
}
```

### What This Endpoint Supports

| Feature | How | Example |
|---------|-----|---------|
| **Persistent sessions** | `user` field | `"user": "worker:alex:task:123"` |
| **Custom session keys** | `x-openclaw-session-key` header | `worker:alex:session` |
| **Agent selection** | `model` field | `"model": "openclaw/alex-worker"` |
| **Model override** | `x-openclaw-model` header | `x-openclaw-model: deepseek-v4-flash` |
| **Tool support** | `tools` array | Pass function definitions |
| **Tool calls** | Response includes `tool_calls` | Execute and send back |
| **Streaming** | `stream: true` | SSE response |
| **Conversation continuity** | Same `user` value | Multiple requests, same session |

---

## Architecture: Plugin → OpenAI Endpoint → Agent

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         SOFTWARE HOUSE UI                                   │
│                                                                             │
│  User assigns task to worker "Alex"                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
        │
        │ HTTP POST
        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      PLUGIN (Software House)                                │
│                                                                             │
│  1. Save task to database                                                   │
│  2. Build prompt: worker context + task + vault docs                        │
│  3. Send to OpenAI endpoint:                                                │
│     POST http://localhost:18789/v1/chat/completions                         │
│     Headers:                                                                │
│       Authorization: Bearer <token>                                         │
│       x-openclaw-session-key: worker:alex:session                           │
│       x-openclaw-model: deepseek-v4-flash                                   │
│     Body:                                                                   │
│       model: "openclaw/alex-worker"                                         │
│       user: "worker:alex:task:123"                                          │
│       messages: [{role: "user", content: "You are Alex..."}]                │
│       tools: [...]                                                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
        │
        │ HTTP Response
        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      GATEWAY (OpenClaw)                                     │
│                                                                             │
│  1. Receives request                                                        │
│  2. Routes to agent (alex-worker or default)                                │
│  3. Creates/reuses session based on x-openclaw-session-key                  │
│  4. Agent processes task                                                    │
│  5. Returns response (with tool_calls if needed)                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
        │
        │ Tool calls in response
        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      PLUGIN (Tool Execution)                                │
│                                                                             │
│  1. Receive response with tool_calls                                        │
│  2. Execute tool (e.g., read file, run command)                             │
│  3. Send follow-up with tool results                                        │
│  4. Continue until agent produces final answer                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Session Management

### Persistent Sessions Per Worker

Each worker gets a persistent session via `x-openclaw-session-key`:

```
Worker Alex:  session key = "worker:alex:session"
Worker Maya:  session key = "worker:may:session"
Worker Sam:   session key = "worker:sam:session"
```

### Conversation Continuity

Multiple requests to same session = same conversation:

```
Request 1: "You are Alex. Task: Implement login form."
Response 1: "I'll analyze the codebase..."

Request 2: "Continue with the implementation."
Response 2: "I've created the login component..."
```

### Task Isolation

Use `user` field for task-specific sessions:

```
Task 123: user = "worker:alex:task:123"
Task 456: user = "worker:alex:task:456"
```

---

## Tool Execution Loop

The plugin handles tool calls from the agent:

```
1. Send initial request
2. Receive response with tool_calls
3. For each tool_call:
   a. Execute the tool (read file, run command, etc.)
   b. Build tool result message
4. Send follow-up with tool results
5. Repeat until no more tool_calls
6. Return final answer
```

---

## Benefits of This Approach

| Benefit | Description |
|---------|-------------|
| **Fully automated** | Plugin triggers work without agent needing to be told |
| **Persistent sessions** | Workers remember context across tasks |
| **Tool support** | Agents can use all OpenClaw tools |
| **Model selection** | Override model per worker/task |
| **No external processes** | Everything runs in Gateway process |
| **Standard protocol** | OpenAI-compatible, widely supported |

---

## Implementation Plan

### Phase 1: Enable Endpoint
1. Add config to enable chatCompletions endpoint
2. Test with curl

### Phase 2: Plugin Integration
1. Plugin sends requests to OpenAI endpoint
2. Plugin maintains session keys per worker
3. Plugin handles tool call loop

### Phase 3: Worker Execution
1. Worker gets assigned task
2. Plugin builds prompt with context
3. Plugin sends to endpoint
4. Agent executes task
5. Plugin tracks completion

---

## Comparison: Previous vs Current

### Previous (Broken)
```
User assigns task → Plugin schedules agent turn → Agent needs to be told to check
```
**Problem:** Agent doesn't know to check the queue.

### Current (Working)
```
User assigns task → Plugin sends to OpenAI endpoint → Agent executes immediately
```
**Solution:** Plugin triggers work directly via HTTP.

---

*Created: 2026-06-24 | Author: Amy*
*Status: Architecture verified and ready for implementation*
