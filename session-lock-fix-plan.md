# Session Lock Fix Plan

## Root Cause
The plugin uses synchronous file I/O (`writeFileSync`, `appendFileSync`, `renameSync`)
and synchronous subprocess calls (`execSync`) in hooks that fire on every agent lifecycle event.
These block Node.js event loop, preventing session file writes from completing within 60s timeout.

## Affected Code Paths

### 1. `writeLiveAgents()` — called from EVERY hook (8+ times per turn)
- `writeJSON()` → `writeFileSync` + `renameSync` (live-agents.json + state.json)
- Sync disk I/O, 2-20ms each

### 2. `session_end` hook — auto-commit
- `execSync("git status --porcelain", timeout: 5000)` 
- `execSync("git add -A", timeout: 30000)`
- `execSync("git commit", timeout: 30000)`
- **Up to 65 seconds of blocking**

### 3. Logger (`appendFileSync`) — every log call blocks
- Called from every hook, tool, and logSession

### 4. Other `execSync` calls
- crontab management
- Python script execution (120s timeout)
- Hostname / tailscale detection

## Fix Strategy

### Phase 1: Debounce file writes (critical, immediate)
- Keep `writeLiveAgents` synchronous for simplicity but add **debouncing**
- Only write to disk every N ms (e.g. 500ms), not on every hook call
- Queue the latest state and flush coalesced

### Phase 2: Make auto-commit async (critical)
- Replace `execSync` in session_end with `exec` from `child_process` (async)
- Fire-and-forget with a promise — don't block session_end

### Phase 3: Async file I/O (nice to have)
- Replace `writeFileSync` → `fs.promises.writeFile`
- Replace `appendFileSync` → `fs.promises.appendFile`
- Add error handling + catch

### Phase 4: Remove sync log writes (optimization)
- Buffer log writes and flush every 1-2 seconds
- Critical path (hooks/tools) uses buffered logger

## Implementation Order
1. Debounce writeLiveAgents → instant fix for session lock
2. Move auto-commit to fire-and-forget → remove biggest blocking call
3. Async I/O for all file writes → clean solution
4. Buffered logger → reduce disk pressure
