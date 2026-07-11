// ═══════════════════════════════════════════════════════════════
//  LIVE AGENTS — Debounced file writes for live-agents.json and
//  state.json. Extracted from src/index.ts as part of the slice
//  refactor.
//
//  Self-contained: only depends on session-tracker (SessionTracker),
//  utils (writeJSON), shared (getDataDir), db (setLiveAgents,
//  setGlobalConfig), and stdlib.
// ═══════════════════════════════════════════════════════════════
import * as path from "node:path";
import { writeJSON } from "./utils.js";
import { getDataDir } from "./shared.js";
import { sessionTracker } from "./session-tracker.js";
import { setLiveAgents, setGlobalConfig } from "./db.js";
export const LIVE_AGENTS_FILE = "live-agents.json";
// Debounce: coalesce rapid sequential writes into one disk write every 500ms
let _liveAgentsTimer = null;
let _pendingData = null;
let _pendingState = null;
export function flushLiveAgents() {
    _liveAgentsTimer = null;
    // Atomic swap: grab pending data and reset in one operation
    const data = _pendingData;
    const state = _pendingState;
    _pendingData = null;
    _pendingState = null;
    if (!data && !state)
        return;
    try {
        const dataDir = getDataDir();
        if (data) {
            writeJSON(path.join(dataDir, LIVE_AGENTS_FILE), data);
            try {
                setLiveAgents(data.agents || []);
            }
            catch {
                console.error("[orchestrator] flushLiveAgents: setLiveAgents failed");
            }
        }
        if (state) {
            writeJSON(path.join(dataDir, "state.json"), state);
            try {
                setGlobalConfig("state", state);
            }
            catch {
                console.error("[orchestrator] flushLiveAgents: setGlobalConfig failed");
            }
        }
    }
    catch (e) {
        try {
            console.error("[orchestrator] flushLiveAgents:", e.message);
        }
        catch { /* final fallback */ }
    }
    // If more data was queued during flush, schedule another pass
    if (_pendingData || _pendingState) {
        _liveAgentsTimer = setTimeout(flushLiveAgents, 500);
    }
}
export function queueLiveAgents(reason, tracker) {
    // ═══ SCOPE: Only track registered sessions ═══
    // The plugin should be invisible to unregistered sessions.
    // No live agents data, no tracking, no context injection for sessions
    // that haven't explicitly opted in via genorch_session_register.
    if (tracker.sessionKey && !tracker.isSessionRegistered(tracker.sessionKey))
        return;
    const main = tracker.toLiveState(reason);
    const agents = [];
    if (main.project || main.agent)
        agents.push(main);
    for (let i = 0; i < tracker.subagentDepth; i++) {
        agents.push({
            agent: `${tracker.currentAgent}::sub-${i + 1}`,
            project: tracker.currentProject,
            task: tracker.currentTask,
            model: tracker.currentModel,
            model_provider: tracker.currentModelProvider,
            subagent_depth: 0,
            action: "running",
            current_file: null,
            agent_status: "running",
            touched_files: [],
            action_history: [],
            token_usage: { input: 0, output: 0, total: 0 },
            last_error: null,
            timestamp: new Date().toISOString(),
            session_key: null,
            uptime_ms: 0,
            elapsed: "—",
            session_started_at: new Date(tracker.sessionStartTimestamp).toISOString(),
            parent_depth: i + 1,
        });
    }
    _pendingData = {
        agents,
        agent_count: agents.length,
        active_count: agents.filter(a => a.project).length,
        last_updated: new Date().toISOString(),
        reason,
    };
    if (tracker.currentProject) {
        _pendingState = {
            project: tracker.currentProject,
            task: tracker.currentTask,
            model: tracker.currentModel,
            agent: tracker.currentAgent,
            timestamp: new Date().toISOString(),
            subagent_depth: tracker.subagentDepth,
            action: tracker.currentAction,
        };
    }
    if (!_liveAgentsTimer) {
        _liveAgentsTimer = setTimeout(flushLiveAgents, 500);
    }
}
export function flushLiveAgentsNow(reason, tracker) {
    // Only track registered sessions
    if (tracker.sessionKey && !tracker.isSessionRegistered(tracker.sessionKey))
        return;
    if (_liveAgentsTimer) {
        clearTimeout(_liveAgentsTimer);
        _liveAgentsTimer = null;
    }
    // Don't clear _pendingData/_pendingState — they may have pending writes from concurrent queueLiveAgents() calls
    try {
        const dataDir = getDataDir();
        const main = tracker.toLiveState(reason);
        const agents = [];
        if (main.project || main.agent)
            agents.push(main);
        const liveData = {
            agents,
            agent_count: agents.length,
            active_count: agents.filter(a => a.project).length,
            last_updated: new Date().toISOString(),
            reason,
        };
        writeJSON(path.join(dataDir, LIVE_AGENTS_FILE), liveData);
        try {
            setLiveAgents(agents);
        }
        catch (e) {
            console.error("[orchestrator] flushLiveAgentsNow: setLiveAgents failed:", e.message);
        }
        if (tracker.currentProject) {
            const stateData = {
                project: tracker.currentProject,
                task: tracker.currentTask,
                model: tracker.currentModel,
                agent: tracker.currentAgent,
                timestamp: new Date().toISOString(),
                subagent_depth: tracker.subagentDepth,
                action: tracker.currentAction,
            };
            writeJSON(path.join(dataDir, "state.json"), stateData);
            try {
                setGlobalConfig("state", stateData);
            }
            catch (e) {
                console.error("[orchestrator] flushLiveAgentsNow: state failed:", e.message);
            }
        }
    }
    catch (e) {
        try {
            console.error("[orchestrator] flushLiveAgentsNow:", e.message);
        }
        catch { /* final fallback */ }
    }
}
/** Session key is the real OpenClaw gateway session ID, set by hooks.
 *  We never generate synthetic keys — orchestrator uses the exact same
 *  session ID that OpenClaw uses, ensuring 1:1 alignment. */
export function realSessionKey() {
    return sessionTracker.sessionKey;
}
