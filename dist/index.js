import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { toolPluginMetadataSymbol } from "openclaw/plugin-sdk/tool-plugin";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDashboardHandler } from "./dashboard-handler.js";
import { getDataDir } from "./shared.js";
// ═══════════════════════════════════════════════════════════════
//  PLUGIN ROOT — all paths resolve from here (no skill dir dependency!)
// ═══════════════════════════════════════════════════════════════
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, "..");
// ── Tool result helper ─────────────────────────────────────────
function txt(data) {
    return {
        content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
        details: data,
    };
}
// ═══════════════════════════════════════════════════════════════
//  DATA DIRECTORY RESOLUTION
// ═══════════════════════════════════════════════════════════════
function getDashboardDir() {
    // Dashboard is bundled INSIDE the plugin package — no skill dir needed!
    const pluginDashboard = path.join(PLUGIN_ROOT, "dashboard");
    if (fs.existsSync(pluginDashboard))
        return pluginDashboard;
    // fallback for development
    const devPath = process.env.DASHBOARD_DIR;
    if (devPath && fs.existsSync(devPath))
        return devPath;
    return pluginDashboard;
}
// ═══════════════════════════════════════════════════════════════
//  JSON FILE HELPERS
// ═══════════════════════════════════════════════════════════════
function readJSON(filePath) {
    if (!fs.existsSync(filePath))
        return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
    catch {
        return null;
    }
}
function writeJSON(filePath, data) {
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
}
/** Extract tags from a task slug and notes text. Used for session entry tags. */
function extractTags(task, notes) {
    const tags = [];
    const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "have", "has"]);
    const t = (task || "").toLowerCase();
    for (const part of t.split(/[-_]/)) {
        if (part.length > 2 && !stop.has(part) && !/^v?\d/.test(part) && !tags.includes(part)) {
            tags.push(part);
        }
    }
    const n = (notes || "").toLowerCase();
    for (const kw of ["design", "implement", "fix", "test", "refactor", "debug", "audit", "review"]) {
        if (n.includes(kw) && !tags.includes(kw))
            tags.push(kw);
    }
    return tags.slice(0, 8);
}
function readFileContent(p) {
    if (!fs.existsSync(p))
        return null;
    return fs.readFileSync(p, "utf-8");
}
// ═══════════════════════════════════════════════════════════════
//  LOGGER — JSONL-based, level-filtered, auto-cleanup
// ═══════════════════════════════════════════════════════════════
class OrchestratorLogger {
    logFile;
    level;
    retentionDays;
    cleanupTimer = null;
    static LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
    constructor(dataDir, level = "info", retentionDays = 30) {
        const logDir = path.join(dataDir, "logs");
        fs.mkdirSync(logDir, { recursive: true });
        this.logFile = path.join(logDir, "orchestrator.jsonl");
        this.level = level;
        this.retentionDays = retentionDays;
        this.cleanupTimer = setInterval(() => this.cleanup(), 6 * 3600_000);
        setTimeout(() => this.cleanup(), 60_000);
    }
    shouldLog(lvl) {
        return (OrchestratorLogger.LEVELS[lvl.toLowerCase()] ?? 1) >= (OrchestratorLogger.LEVELS[this.level] ?? 1);
    }
    write(level, source, msg, data) {
        if (!this.shouldLog(level))
            return;
        try {
            const entry = { ts: new Date().toISOString(), level, source, msg };
            if (data && Object.keys(data).length > 0)
                entry.data = data;
            fs.appendFileSync(this.logFile, JSON.stringify(entry) + "\n", "utf-8");
        }
        catch { /* logging never crashes */ }
    }
    debug = (source, msg, data) => this.write("debug", source, msg, data);
    info = (source, msg, data) => this.write("info", source, msg, data);
    warn = (source, msg, data) => this.write("warn", source, msg, data);
    error = (source, msg, data) => this.write("error", source, msg, data);
    logRouting(modelId, project, eligible, total, filters) {
        this.info("routing", `Model check for ${project ?? "global"}: ${eligible}/${total} eligible`, { project, eligible, total, filters });
    }
    logSession(project, task, model, agent, status) {
        this.info("session", `${project}/${task} → ${status}`, { project, task, model, agent, status });
    }
    logConfigChange(key, value) {
        this.info("config", `Config changed: ${key}`, { key, value });
    }
    query(limit = 50, opts) {
        if (!fs.existsSync(this.logFile))
            return [];
        try {
            const content = fs.readFileSync(this.logFile, "utf-8");
            const entries = [];
            for (const line of content.trim().split("\n").filter(Boolean)) {
                try {
                    const e = JSON.parse(line);
                    if (opts?.level && !this.shouldLog(opts.level))
                        continue;
                    if (opts?.source && !e.source.includes(opts.source))
                        continue;
                    if (opts?.since && e.ts < opts.since)
                        continue;
                    entries.push(e);
                }
                catch { /* skip malformed */ }
            }
            return entries.slice(-limit);
        }
        catch {
            return [];
        }
    }
    cleanup() {
        if (!fs.existsSync(this.logFile))
            return;
        const cutoff = Date.now() - this.retentionDays * 86400_000;
        try {
            const content = fs.readFileSync(this.logFile, "utf-8");
            const kept = content.trim().split("\n").filter(line => {
                try {
                    return new Date(JSON.parse(line).ts).getTime() > cutoff;
                }
                catch {
                    return false;
                }
            });
            fs.writeFileSync(this.logFile, kept.join("\n") + (kept.length ? "\n" : ""), "utf-8");
        }
        catch { /* fail silently */ }
    }
    stop() {
        if (this.cleanupTimer)
            clearInterval(this.cleanupTimer);
    }
}
const WORKFLOW_ORDER = ["analyze", "plan", "document", "work", "log", "finish"];
class WorkflowTracker {
    enabled = false;
    currentPhase = "analyze";
    phaseHistory = [];
    currentPhaseStartedAt = Date.now();
    qaRetries = 0;
    qaMaxRetries = 3;
    qaResults = [];
    isQARunning = false;
    includeQa = false;
    autoCommit = false;
    skipPhases = [];
    reset(projectWorkflowConfig) {
        this.enabled = projectWorkflowConfig?.enabled ?? false;
        this.includeQa = projectWorkflowConfig?.include_qa ?? false;
        this.currentPhase = "analyze";
        this.phaseHistory = [];
        this.currentPhaseStartedAt = Date.now();
        this.qaRetries = 0;
        this.qaResults = [];
        this.isQARunning = false;
        this.autoCommit = projectWorkflowConfig?.auto_commit ?? false;
        this.skipPhases = (projectWorkflowConfig?.skip_phases ?? []).filter((p) => WORKFLOW_ORDER.includes(p));
        this.qaMaxRetries = projectWorkflowConfig?.qa_retries ?? 3;
        this.enterPhase("analyze");
    }
    enterPhase(phase) {
        this.currentPhase = phase;
        this.currentPhaseStartedAt = Date.now();
        const existing = this.phaseHistory.find(p => p.phase === phase);
        if (existing) {
            existing.enteredAt = new Date().toISOString();
            existing.completedAt = undefined;
        }
        else {
            this.phaseHistory.push({ phase, enteredAt: new Date().toISOString() });
        }
    }
    completePhase(phase, skipped) {
        const entry = this.phaseHistory.find(p => p.phase === phase);
        if (entry) {
            entry.completedAt = new Date().toISOString();
            entry.skipped = skipped ?? false;
        }
    }
    nextPhase() {
        const idx = WORKFLOW_ORDER.indexOf(this.currentPhase);
        if (idx < 0 || idx >= WORKFLOW_ORDER.length - 1)
            return null;
        // Skip configured phases
        for (let i = idx + 1; i < WORKFLOW_ORDER.length; i++) {
            if (!this.skipPhases.includes(WORKFLOW_ORDER[i])) {
                return WORKFLOW_ORDER[i];
            }
        }
        return null;
    }
    advance() {
        this.completePhase(this.currentPhase);
        const next = this.nextPhase();
        if (next)
            this.enterPhase(next);
        return next;
    }
    canTransitionTo(target) {
        if (!this.enabled)
            return true;
        const currentIdx = WORKFLOW_ORDER.indexOf(this.currentPhase);
        const targetIdx = WORKFLOW_ORDER.indexOf(target);
        if (currentIdx < 0 || targetIdx < 0)
            return true;
        // Allow transitions forward or to same phase (re-entry ok)
        return targetIdx >= currentIdx;
    }
    getPhaseElapsed() {
        const elapsed = Date.now() - this.currentPhaseStartedAt;
        const mins = Math.floor(elapsed / 60000);
        const secs = Math.floor((elapsed % 60000) / 1000);
        return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
    }
    getProgress() {
        const completed = this.phaseHistory.filter(p => p.completedAt).length;
        const total = WORKFLOW_ORDER.filter(p => !this.skipPhases.includes(p)).length;
        return `${completed}/${total}`;
    }
    toJSON() {
        return {
            enabled: this.enabled,
            current_phase: this.currentPhase,
            phase_history: this.phaseHistory,
            phase_elapsed: this.getPhaseElapsed(),
            progress: this.getProgress(),
            qa_retries: this.qaRetries,
            qa_max_retries: this.qaMaxRetries,
            is_qa_running: this.isQARunning,
            auto_commit: this.autoCommit,
            skip_phases: this.skipPhases,
        };
    }
}
class SessionTracker {
    currentProject = null;
    currentTask = null;
    currentModel = null;
    currentModelProvider = null;
    currentModelTier = 0;
    currentAgent = "Amy";
    sessionStartTimestamp = Date.now();
    sessionKey = null;
    subagentDepth = 0;
    currentAction = null;
    currentFile = null;
    agentStatus = "idle";
    touchedFiles = [];
    actionHistory = [];
    tokenUsage = { input: 0, output: 0, total: 0 };
    lastError = null;
    lastActivityTimestamp = Date.now();
    errorCount = 0;
    loggedTaskCompletion = false;
    // ── QA GATE TRACKING ────────────────────────────────────────
    // When workflow.include_qa is enabled, advancing from work→log
    // requires QA approval. The gate is enforced in orchestrator_advance_phase.
    qaStatus = "none";
    qaFindings = [];
    qaApprovedAt = null;
    // ── HANDOFF DOC TRACKING ─────────────────────────────────────
    // Required before finishing a task. Generated by orchestrator_generate_handoff.
    handoffGenerated = false;
    handoffPath = null;
    workflow = new WorkflowTracker();
    // Per-session project contexts — keyed by sessionKey.
    // A session only gets project context injected if it explicitly
    // registered via orchestrator_set_context. This prevents project
    // context from bleeding between unrelated sessions.
    sessionContexts = new Map();
    // Subagent session registry — tracks which subagent keys belong to which parent
    // and what project/task they were spawned under. Used at session_end to log
    // the subagent with its real session key, not the parent's.
    subagentRegistry = new Map();
    // Explicitly registered sessions — only these get orchestrator tracking.
    // A session must call orchestrator_register before using any orchestrator
    // features. This ensures no chat/logging session accidentally gets project
    // context injected into its prompts.
    registeredSessions = new Set();
    // Session-to-project binding: once a session registers to a project,
    // it's locked to that project until explicitly released. This prevents
    // cross-project contamination and ensures 1 session = 1 project.
    sessionProjectBinding = new Map();
    // Track which projects have at least one active session.
    // A project must have at least one session to be considered "active".
    projectActiveSessions = new Map();
    trackModel(model, provider, tier) {
        this.currentModel = model;
        if (provider)
            this.currentModelProvider = provider;
        if (tier !== undefined)
            this.currentModelTier = tier;
    }
    trackAction(action, file) {
        this.currentAction = action;
        this.lastActivityTimestamp = Date.now();
        if (file)
            this.currentFile = file;
        if (file && !this.touchedFiles.includes(file)) {
            this.touchedFiles.push(file);
        }
        // Dedup: skip consecutive identical actions (e.g., repeated "building_prompt")
        const last = this.actionHistory[this.actionHistory.length - 1];
        if (last && last.action === action && last.file === file) {
            // Just update timestamp on the existing entry
            last.ts = new Date().toISOString();
        }
        else {
            this.actionHistory.push({ action, file, ts: new Date().toISOString() });
        }
        if (this.actionHistory.length > 100)
            this.actionHistory = this.actionHistory.slice(-100);
    }
    trackTokenUsage(input, output) {
        this.tokenUsage.input += input;
        this.tokenUsage.output += output;
        this.tokenUsage.total += input + output;
        this.lastActivityTimestamp = Date.now();
    }
    trackError(error) {
        this.lastError = error;
        this.agentStatus = "blocked";
        this.errorCount++;
        this.lastActivityTimestamp = Date.now();
    }
    setStatus(status) {
        this.agentStatus = status;
    }
    markLoggedCompletion() {
        this.loggedTaskCompletion = true;
    }
    // ── QA GATE METHODS ──
    setQaStatus(status) {
        this.qaStatus = status;
        if (status === "approved")
            this.qaApprovedAt = new Date().toISOString();
        if (status === "none") {
            this.qaFindings = [];
            this.qaApprovedAt = null;
        }
    }
    addQaFinding(finding) {
        this.qaFindings.push({ finding, timestamp: new Date().toISOString() });
        this.qaStatus = "pending";
    }
    canAdvanceFromWork() {
        // If QA is not required, always can advance
        if (!this.workflow.enabled || !this.workflow.includeQa)
            return true;
        // QA must be approved
        return this.qaStatus === "approved";
    }
    getQaSummary() {
        if (this.qaStatus === "none" && this.workflow.includeQa)
            return "❓ QA required — submit findings with orchestrator_qa_submit";
        if (this.qaStatus === "pending")
            return "⏳ QA pending — waiting for approval";
        if (this.qaStatus === "approved")
            return `✅ QA approved (${this.qaApprovedAt || "unknown"})`;
        if (this.qaStatus === "rejected")
            return "❌ QA rejected — fix issues and resubmit";
        return "";
    }
    // ── HANDOFF METHODS ──
    markHandoffGenerated(path) {
        this.handoffGenerated = true;
        this.handoffPath = path;
    }
    canFinish() {
        // Handoff doc is always required before finish
        return this.handoffGenerated;
    }
    start(key, reason) {
        this.sessionKey = key;
        this.sessionStartTimestamp = Date.now();
        this.subagentDepth = 0;
        this.currentAction = null;
        this.currentFile = null;
        this.touchedFiles = [];
        this.actionHistory = [];
        this.agentStatus = "working";
        this.lastError = null;
        this.errorCount = 0;
        this.qaStatus = "none";
        this.qaFindings = [];
        this.qaApprovedAt = null;
        this.handoffGenerated = false;
        this.handoffPath = null;
        this.lastActivityTimestamp = Date.now();
        // Always reset project context on session start — never carry over
        // stale project/task/model from a previous session.
        this.currentProject = null;
        this.currentTask = null;
        this.currentModel = null;
        this.currentModelProvider = null;
        this.currentModelTier = 0;
        this.tokenUsage = { input: 0, output: 0, total: 0 };
    }
    end() {
        if (!this.currentProject)
            return null;
        const ms = Date.now() - this.sessionStartTimestamp;
        const dur = ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}min`;
        this.agentStatus = "complete";
        return {
            project: this.currentProject,
            task: this.currentTask || "auto-task",
            duration: dur,
            model: this.currentModel || "auto",
        };
    }
    formatElapsed(ms) {
        if (ms < 1000)
            return "0s";
        if (ms < 60000)
            return `${Math.round(ms / 1000)}s`;
        const m = Math.floor(ms / 60000);
        const s = Math.round((ms % 60000) / 1000);
        return `${m}m ${s}s`;
    }
    toLiveState(reason) {
        const elapsed = Date.now() - this.sessionStartTimestamp;
        return {
            agent: this.currentAgent,
            project: this.currentProject,
            task: this.currentTask,
            model: this.currentModel,
            model_provider: this.currentModelProvider,
            model_tier: this.currentModelTier,
            subagent_depth: this.subagentDepth,
            action: this.currentAction,
            current_file: this.currentFile,
            agent_status: this.agentStatus,
            touched_files: this.touchedFiles.slice(-20),
            action_history: this.actionHistory.slice(-20),
            token_usage: this.tokenUsage,
            last_error: this.lastError,
            error_count: this.errorCount,
            last_activity_at: new Date(this.lastActivityTimestamp).toISOString(),
            timestamp: new Date().toISOString(),
            session_key: this.sessionKey,
            workflow: this.workflow.toJSON(),
            uptime_ms: elapsed,
            elapsed: this.formatElapsed(elapsed),
            session_started_at: new Date(this.sessionStartTimestamp).toISOString(),
            reason,
        };
    }
    setContext(project, task, workflowConfig) {
        // ═══ ENFORCE SESSION-PROJECT BINDING ═══
        // Once a session registers to a project, it's locked to that project.
        // This prevents cross-project contamination from a single session.
        if (this.sessionKey && this.sessionProjectBinding.has(this.sessionKey)) {
            const boundProject = this.sessionProjectBinding.get(this.sessionKey);
            if (boundProject !== project) {
                throw new Error(`❌ Binding violation: This session is already locked to project "${boundProject}". ` +
                    `Cannot set context to "${project}". To work on a different project, start a completely ` +
                    `new session (not a subagent — a fresh session). If you're done with "${boundProject}", ` +
                    `call orchestrator_release_project first to unbind this session.`);
            }
        }
        // Reset completion log flag — new task starts fresh
        this.loggedTaskCompletion = false;
        this.currentProject = project;
        this.currentTask = task;
        this.trackAction("Setting context");
        this.agentStatus = "working";
        // Reset workflow tracker with project config
        this.workflow.reset(workflowConfig);
        // Store per-session so before_prompt_build can scope injection
        if (this.sessionKey) {
            this.sessionContexts.set(this.sessionKey, {
                project, task, model: this.currentModel, modelProvider: this.currentModelProvider,
                modelTier: this.currentModelTier, timestamp: Date.now(), workflowConfig
            });
            // Bind session to project (if not already bound — first set_context creates the binding)
            if (!this.sessionProjectBinding.has(this.sessionKey)) {
                this.sessionProjectBinding.set(this.sessionKey, project);
                // Track this session as active on the project
                if (!this.projectActiveSessions.has(project)) {
                    this.projectActiveSessions.set(project, new Set());
                }
                this.projectActiveSessions.get(project).add(this.sessionKey);
            }
        }
    }
    clearContext() {
        const prev = this.currentProject;
        const prevKey = this.sessionKey;
        this.currentProject = null;
        this.currentTask = null;
        this.currentModel = null;
        this.currentModelProvider = null;
        this.currentModelTier = 0;
        this.currentAction = null;
        this.currentFile = null;
        this.workflow.reset({ enabled: false });
        this.agentStatus = "idle";
        this.lastError = null;
        // Remove per-session context for this session
        // NOTE: Does NOT release session-project binding. The binding persists
        // so that clearContext + setContext (different project) still fails.
        // Use releaseProjectBinding() to fully unbind.
        if (this.sessionKey)
            this.sessionContexts.delete(this.sessionKey);
        if (prev)
            this.trackAction("Clearing context");
    }
    /** Get project context for a specific session key. */
    getSessionContext(sessionKey) {
        const ctx = this.sessionContexts.get(sessionKey);
        if (!ctx)
            return null;
        return { project: ctx.project, task: ctx.task, model: ctx.model, workflowConfig: ctx.workflowConfig };
    }
    /** Clean up session context for a given key. Call on session_end. */
    removeSessionContext(sessionKey) {
        this.sessionContexts.delete(sessionKey);
    }
    /** Track a subagent session's metadata so we can log it with the right key. */
    trackSubagent(subKey, info) {
        this.subagentRegistry.set(subKey, info);
    }
    /** Remove subagent tracking when subagent_ended fires. */
    untrackSubagent(subKey) {
        this.subagentRegistry.delete(subKey);
    }
    /** Get subagent info by key, or undefined. */
    getSubagent(subKey) {
        return this.subagentRegistry.get(subKey);
    }
    /** Register a session for orchestrator tracking. Returns true if newly registered. */
    registerSession(sessionKey) {
        if (this.registeredSessions.has(sessionKey))
            return false;
        this.registeredSessions.add(sessionKey);
        return true;
    }
    /** Unregister a session from orchestrator tracking. Also releases project binding. */
    unregisterSession(sessionKey) {
        if (!this.registeredSessions.has(sessionKey))
            return false;
        this.registeredSessions.delete(sessionKey);
        this.sessionContexts.delete(sessionKey);
        // Also release project binding
        this.releaseProjectBinding(sessionKey);
        return true;
    }
    /** Check if a session is registered for orchestrator tracking. */
    isSessionRegistered(sessionKey) {
        return this.registeredSessions.has(sessionKey);
    }
    /** Get list of all registered session keys. */
    getRegisteredSessions() {
        return Array.from(this.registeredSessions);
    }
    /** Release this session's project binding. Returns the previously bound project or null. */
    releaseProjectBinding(sessionKey) {
        const sk = sessionKey || this.sessionKey;
        if (!sk || !this.sessionProjectBinding.has(sk))
            return null;
        const prevProject = this.sessionProjectBinding.get(sk);
        this.sessionProjectBinding.delete(sk);
        // Remove from project active sessions
        if (this.projectActiveSessions.has(prevProject)) {
            this.projectActiveSessions.get(prevProject).delete(sk);
            if (this.projectActiveSessions.get(prevProject).size === 0) {
                this.projectActiveSessions.delete(prevProject);
            }
        }
        // Also clear context if it matches
        if (this.currentProject === prevProject) {
            this.currentProject = null;
            this.currentTask = null;
            this.workflow.reset({ enabled: false });
            this.agentStatus = "idle";
        }
        if (sk === this.sessionKey) {
            this.sessionContexts.delete(sk);
        }
        return prevProject;
    }
    /** Get the project a session is bound to, or null. */
    getBoundProject(sessionKey) {
        const sk = sessionKey || this.sessionKey;
        return sk ? this.sessionProjectBinding.get(sk) || null : null;
    }
    /** Get projects that have at least one active session. */
    getActiveProjects() {
        const result = [];
        for (const [project, sessions] of this.projectActiveSessions.entries()) {
            if (sessions.size > 0) {
                result.push({
                    project,
                    active_sessions: sessions.size,
                    session_keys: Array.from(sessions).filter(s => this.registeredSessions.has(s))
                });
            }
        }
        return result.sort((a, b) => b.active_sessions - a.active_sessions);
    }
    /** Check if a project has any active sessions. */
    hasActiveSessionsFor(project) {
        return this.projectActiveSessions.has(project) && this.projectActiveSessions.get(project).size > 0;
    }
}
// ═══════════════════════════════════════════════════════════════
//  LIVE AGENTS FILE
// ═══════════════════════════════════════════════════════════════
const LIVE_AGENTS_FILE = "live-agents.json";
function writeLiveAgents(reason, tracker, logger) {
    // Debounced: queues write to disk, coalesces rapid sequential calls
    queueLiveAgents(reason, tracker);
}
// Debounce: coalesce rapid sequential writes into one disk write every 500ms
let _liveAgentsTimer = null;
let _pendingData = null;
let _pendingState = null;
function flushLiveAgents() {
    _liveAgentsTimer = null;
    try {
        const dataDir = getDataDir();
        if (_pendingData) {
            const d = _pendingData;
            _pendingData = null;
            writeJSON(path.join(dataDir, LIVE_AGENTS_FILE), d);
        }
        if (_pendingState) {
            const s = _pendingState;
            _pendingState = null;
            writeJSON(path.join(dataDir, "state.json"), s);
        }
    }
    catch (e) {
        try {
            fs.appendFileSync('/tmp/live-agents-errors.log', `${new Date().toISOString()} flushLiveAgents: ${e.message}\n`, 'utf-8');
        }
        catch { }
    }
}
function queueLiveAgents(reason, tracker) {
    // ═══ SCOPE: Only track registered sessions ═══
    // The plugin should be invisible to unregistered sessions.
    // No live agents data, no tracking, no context injection for sessions
    // that haven't explicitly opted in via orchestrator_register.
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
            model_tier: tracker.currentModelTier,
            subagent_depth: 0,
            action: "working",
            current_file: null,
            agent_status: "working",
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
function flushLiveAgentsNow(reason, tracker) {
    // Only track registered sessions
    if (tracker.sessionKey && !tracker.isSessionRegistered(tracker.sessionKey))
        return;
    if (_liveAgentsTimer) {
        clearTimeout(_liveAgentsTimer);
        _liveAgentsTimer = null;
    }
    _pendingData = null;
    _pendingState = null;
    try {
        const dataDir = getDataDir();
        const main = tracker.toLiveState(reason);
        const agents = [];
        if (main.project || main.agent)
            agents.push(main);
        writeJSON(path.join(dataDir, LIVE_AGENTS_FILE), {
            agents,
            agent_count: agents.length,
            active_count: agents.filter(a => a.project).length,
            last_updated: new Date().toISOString(),
            reason,
        });
        if (tracker.currentProject) {
            writeJSON(path.join(dataDir, "state.json"), {
                project: tracker.currentProject,
                task: tracker.currentTask,
                model: tracker.currentModel,
                agent: tracker.currentAgent,
                timestamp: new Date().toISOString(),
                subagent_depth: tracker.subagentDepth,
                action: tracker.currentAction,
            });
        }
    }
    catch (e) {
        try {
            fs.appendFileSync('/tmp/live-agents-errors.log', `${new Date().toISOString()} flushLiveAgentsNow(${reason}): ${e.message}\n`, 'utf-8');
        }
        catch { }
    }
}
const sessionTracker = new SessionTracker();
/** Generate a stable default session key when hooks have not provided one yet.
 *  Used as fallback for orchestrator_register when session_start has not
 *  fired (e.g. sessions that existed before a gateway restart). */
function agentDefaultSessionKey() {
    if (sessionTracker.sessionKey)
        return sessionTracker.sessionKey;
    return `agent:main:auto:${sessionTracker.currentAgent}:${sessionTracker.sessionStartTimestamp}`;
}
// ═══════════════════════════════════════════════════════════════
//  PROJECT HELPERS
// ═══════════════════════════════════════════════════════════════
function getProjectLocation(project, dataDir) {
    const cfg = readJSON(path.join(dataDir, "dashboard-config.json")) || {};
    return cfg.projects?.[project]?.location || null;
}
function buildProjectToc(location) {
    try {
        const result = execSync(`find "${location}" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -maxdepth 4 -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" -o -name "*.md" -o -name "*.json" -o -name "*.yaml" -o -name "*.yml" -o -name "*.css" -o -name "*.html" \\) 2>/dev/null | head -300`, { encoding: "utf-8", timeout: 5000 });
        return result.trim().split("\n").filter(Boolean);
    }
    catch {
        return [];
    }
}
function syncProjectToOrchestrator(project, dataDir, logger) {
    const pd = projDir(project, dataDir);
    const loc = getProjectLocation(project, dataDir);
    if (!loc || !fs.existsSync(loc)) {
        logger.warn("sync", `No valid location for ${project}`);
        return;
    }
    const readme = readFileContent(path.join(loc, "README.md")) || "No README.md";
    const toc = buildProjectToc(loc);
    const keyFiles = toc.filter(f => !f.includes("node_modules") && (f.endsWith(".md") || f.endsWith("package.json") ||
        f.endsWith("package-lock.json") || f.endsWith(".ts") || f.endsWith(".tsx") ||
        f.endsWith(".py") || f.endsWith(".css") || f.endsWith(".html") ||
        f.includes("tsconfig") || f.includes("next.config") ||
        f.includes("tailwind") || f.endsWith(".env.example")));
    let context = `# ${project}\n\n## Location\n\`${loc}\`\n\n## README\n\n${readme.slice(0, 3000)}\n`;
    try {
        const pkg = readJSON(path.join(loc, "package.json"));
        if (pkg)
            context += `\n## Package\n- Name: ${pkg.name || "N/A"}\n- Version: ${pkg.version || "N/A"}\n`;
    }
    catch { /* */ }
    const tocDisplay = toc.filter(f => !f.includes("node_modules") && !f.includes("/."));
    context += `\n## File Index (${tocDisplay.length} files)\n\n${tocDisplay.map(f => `- ${path.relative(loc, f)}`).join("\n")}\n`;
    fs.writeFileSync(path.join(pd, "CONTEXT.md"), context, "utf-8");
    let tocMd = `# ${project} — File Index\n\n**Location:** \`${loc}\`\n\n### Key Files (${keyFiles.length})\n\n`;
    for (const f of keyFiles) {
        tocMd += `- \`${path.relative(loc, f)}\`\n`;
    }
    tocMd += `\n### Full TOC (first 80 of ${toc.length})\n\n`;
    for (const f of toc.slice(0, 80)) {
        tocMd += `- \`${path.relative(loc, f)}\`\n`;
    }
    if (toc.length > 80)
        tocMd += `\n*... and ${toc.length - 80} more*\n`;
    fs.writeFileSync(path.join(pd, "KEY_FILES.md"), tocMd, "utf-8");
    logger.info("sync", `Synced ${project} from ${loc}: ${toc.length} files`);
}
function normalizeSessionsJson(project, dataDir) {
    const p = getProjDir(project, dataDir);
    if (!p)
        return;
    const sf = path.join(p, "sessions.json");
    if (!fs.existsSync(sf))
        return;
    try {
        const raw = JSON.parse(fs.readFileSync(sf, "utf-8"));
        let sessions = Array.isArray(raw) ? raw : (raw.sessions || []);
        let changed = false;
        sessions = sessions.map(s => {
            const ns = { ...s };
            const now = new Date().toISOString();
            // Phase 4b: Per-entry schema version tracking
            if (!ns.schema_version) {
                ns.schema_version = 2;
                changed = true;
            }
            // Legacy: timestamp → date
            if (ns.timestamp && !ns.date) {
                ns.date = ns.timestamp.split("T")[0];
                changed = true;
            }
            // Phase 3d: Ensure all timestamp fields
            if (!ns.start_time) {
                ns.start_time = ns.timestamp || ns.logged_at || now;
                changed = true;
            }
            if (!ns.started_at) {
                ns.started_at = ns.start_time;
                changed = true;
            }
            if (!ns.ended_at && ns.end_time) {
                ns.ended_at = ns.end_time;
                changed = true;
            }
            if (!ns.updated_at) {
                ns.updated_at = ns.logged_at || now;
                changed = true;
            }
            if (!ns.logged_at) {
                ns.logged_at = now;
                changed = true;
            }
            return ns;
        });
        if (changed)
            writeJSON(sf, { schema_version: 2, sessions });
    }
    catch { /* */ }
}
function generateRecoveryDoc(project, dataDir, logger) {
    const pd = getProjDir(project, dataDir);
    if (!pd)
        return; // Skip if project dir doesn't exist (archived/cleaned up)
    const loc = getProjectLocation(project, dataDir);
    const context = readFileContent(path.join(pd, "CONTEXT.md")) || "";
    const blPath = path.join(pd, "BACKLOG.json");
    let backlog = [];
    if (fs.existsSync(blPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(blPath, "utf-8"));
            backlog = Array.isArray(parsed) ? parsed : (parsed.tasks || []);
        }
        catch { /* */ }
    }
    const openTasks = backlog.filter(t => t.status === "todo" || t.status === "in_progress");
    const sessions = readRecentSessions(project, dataDir, 10);
    let md = `# ⚡ Recovery Doc: ${project}\n\n*Generated: ${new Date().toISOString()}*\n\nThis is a self-contained project state. If resuming after session loss,\nread this to catch up on context, decisions, and open work.\n\n## 1. Location\n\n${loc || "Not configured"}\n\n## 2. Context (first KB)\n\n${context.slice(0, 1000)}\n\n## 3. Open Backlog\n\n`;
    if (openTasks.length === 0) {
        md += `No open tasks.\n`;
    }
    else {
        md += `| Title | Priority | Status | Created |\n|------|----------|--------|---------|\n`;
        for (const t of openTasks) {
            md += `| ${t.title} | ${t.priority} | ${t.status} | ${t.created} |\n`;
        }
    }
    md += `\n## 4. Recent Sessions\n\n`;
    if (sessions.length === 0) {
        md += `No sessions recorded.\n`;
    }
    else {
        md += `| Date | Task | Model | Agent | Status | Duration |\n|------|------|-------|-------|--------|----------|\n`;
        for (const s of sessions) {
            md += `| ${s.date || "?"} | ${s.task} | ${s.model} | ${s.agent} | ${s.status} | ${s.duration || ""} |\n`;
        }
    }
    md += `\n---\n*End Recovery Doc*\n`;
    fs.writeFileSync(path.join(pd, "RECOVERY.md"), md, "utf-8");
    logger.debug("recovery", `Generated RECOVERY.md for ${project}`);
}
function readRecentSessions(project, dataDir, n) {
    const p = getProjDir(project, dataDir);
    if (!p)
        return [];
    const sf = path.join(p, "sessions.json");
    if (!fs.existsSync(sf))
        return [];
    try {
        const raw = JSON.parse(fs.readFileSync(sf, "utf-8"));
        const sessions = Array.isArray(raw) ? raw : (raw.sessions || []);
        return sessions.slice(-n);
    }
    catch {
        return [];
    }
}
// ═══════════════════════════════════════════════════════════════
//  STATE EVENT LOG — append-only JSONL for project state
//  Multiple sessions can write concurrently (no overwrites).
//  STATE.md is generated FROM this log, not LLM-written.
// ═══════════════════════════════════════════════════════════════
function stateEventLogPath(project, dataDir) {
    return path.join(projDir(project, dataDir), "state-events.jsonl");
}
function writeStateEvent(project, dataDir, event) {
    try {
        const p = stateEventLogPath(project, dataDir);
        const dir = path.dirname(p);
        if (!fs.existsSync(dir))
            fs.mkdirSync(dir, { recursive: true });
        const line = JSON.stringify({
            ...event,
            _ts: new Date().toISOString(),
            _id: crypto.randomUUID(),
        }) + "\n";
        // Append-only — safe for concurrent writers (atomic per write)
        fs.appendFileSync(p, line, "utf-8");
    }
    catch { /* best-effort */ }
}
function readStateEvents(project, dataDir) {
    try {
        const p = stateEventLogPath(project, dataDir);
        if (!fs.existsSync(p))
            return [];
        const raw = fs.readFileSync(p, "utf-8");
        return raw.split("\n").filter(Boolean).map(line => {
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        }).filter(Boolean);
    }
    catch {
        return [];
    }
}
/**
 * Generate STATE.md from the event log. No LLM involved — pure data → template.
 * Returns { generated: boolean, stats: {...} }.
 */
function generateStateFromEvents(project, dataDir, logger) {
    try {
        const events = readStateEvents(project, dataDir);
        const projDataDir = projDir(project, dataDir);
        // ── Compute state from events ──
        let version = "0.0.1";
        let toolCount = 0;
        let testCount = 0;
        let hooksCount = 0;
        let sessionCount = 0;
        let projectCreated = null;
        let projectDescription = null;
        let projectLocation = null;
        const completedPhases = [];
        const backlog = { total: 0, done: 0, todo: 0 };
        const recentSessions = [];
        for (const ev of events) {
            switch (ev.type) {
                case "project_created":
                    projectCreated = ev._ts;
                    version = ev.version || version;
                    projectDescription = ev.description || null;
                    projectLocation = ev.location || null;
                    break;
                case "version_changed":
                    version = ev.version || version;
                    break;
                case "tool_count_changed":
                    toolCount = ev.count ?? toolCount;
                    break;
                case "test_count_changed":
                    testCount = ev.count ?? testCount;
                    break;
                case "hooks_count_changed":
                    hooksCount = ev.count ?? hooksCount;
                    break;
                case "session_logged":
                    sessionCount++;
                    if (recentSessions.length < 10) {
                        recentSessions.push({
                            ts: ev._ts,
                            task: ev.task || "",
                            status: ev.status || "",
                            model: ev.model || "",
                            duration: ev.duration || "",
                        });
                    }
                    break;
                case "phase_completed":
                    if (ev.phase && !completedPhases.includes(ev.phase)) {
                        completedPhases.push(ev.phase);
                    }
                    break;
                case "backlog_updated":
                    if (typeof ev.total === "number")
                        backlog.total = ev.total;
                    if (typeof ev.done === "number")
                        backlog.done = ev.done;
                    if (typeof ev.todo === "number")
                        backlog.todo = ev.todo;
                    break;
            }
        }
        // Also try to read actual counts from source
        const srcDir = getProjectLocation(project, dataDir);
        if (srcDir && fs.existsSync(srcDir)) {
            if (!toolCount) {
                try {
                    const content = fs.readFileSync(path.join(srcDir, "src", "index.ts"), "utf-8");
                    toolCount = countRegisteredTools(content);
                }
                catch { /* */ }
            }
            if (!testCount) {
                try {
                    const tDir = path.join(srcDir, "tests");
                    if (fs.existsSync(tDir)) {
                        testCount = fs.readdirSync(tDir).filter(f => f.endsWith(".test.ts") || f.endsWith(".test.js")).length;
                    }
                }
                catch { /* */ }
            }
            if (!version || version === "0.0.1") {
                try {
                    const pkg = JSON.parse(fs.readFileSync(path.join(srcDir, "package.json"), "utf-8"));
                    if (pkg.version)
                        version = pkg.version;
                }
                catch { /* */ }
            }
        }
        const stats = { version, toolCount, testCount, hooksCount, sessionCount, backlog, completedPhases };
        // ── Build STATE.md ──
        const lines = [];
        lines.push(`# STATE: ${project} — v${version}`);
        lines.push("");
        lines.push("> _Auto-generated from state-events.jsonl — edit events, not STATE.md._");
        lines.push("");
        lines.push("## Overview");
        lines.push("");
        if (projectCreated) {
            lines.push(`- **Created:** ${new Date(projectCreated).toLocaleDateString()}`);
        }
        lines.push(`- **Version:** v${version}`);
        if (projectDescription) {
            lines.push(`- **Description:** ${projectDescription}`);
        }
        lines.push(`- **Tools:** ${toolCount}`);
        lines.push(`- **Unit Tests:** ${testCount}`);
        if (hooksCount)
            lines.push(`- **Hooks:** ${hooksCount}`);
        if (srcDir)
            lines.push(`- **Location:** \`${srcDir}\``);
        lines.push("");
        lines.push("## Status");
        lines.push("");
        lines.push("🟢 Active");
        lines.push("");
        if (completedPhases.length > 0) {
            lines.push("### Workflow Progress");
            lines.push("");
            const allPhases = ["analyze", "plan", "document", "work", "log", "finish"];
            for (const ph of allPhases) {
                const done = completedPhases.includes(ph);
                lines.push(`- ${done ? "✅" : "⬜"} **${ph.charAt(0).toUpperCase() + ph.slice(1)}**`);
            }
            lines.push("");
        }
        if (backlog.total > 0) {
            lines.push("### Backlog");
            lines.push("");
            lines.push(`- **Total:** ${backlog.total}`);
            lines.push(`- **Done:** ${backlog.done}`);
            lines.push(`- **Todo:** ${backlog.todo}`);
            lines.push("");
        }
        lines.push("### Recent Sessions");
        lines.push("");
        if (recentSessions.length > 0) {
            lines.push("| # | Task | Status | Model | Duration |");
            lines.push("|---|------|--------|-------|----------|");
            let idx = 1;
            for (const s of recentSessions.reverse()) {
                const taskShort = (s.task || "").substring(0, 40);
                const statusEmoji = s.status === "complete" ? "✅" : s.status === "blocked" ? "🔴" : s.status === "failed" ? "❌" : "🟡";
                lines.push(`| ${idx++} | ${taskShort} | ${statusEmoji} ${s.status || ""} | ${s.model ? s.model.substring(0, 20) : "-"} | ${s.duration || "-"} |`);
            }
        }
        else {
            lines.push("*No sessions logged yet.*");
        }
        lines.push("");
        lines.push("---");
        lines.push(`_Last regenerated: ${new Date().toISOString()}_`);
        lines.push(`_Total events in log: ${events.length}_`);
        lines.push("");
        const md = lines.join("\n");
        fs.writeFileSync(path.join(projDataDir, "STATE.md"), md, "utf-8");
        logger.info("state", `Generated STATE.md for ${project} from ${events.length} events`);
        return { generated: true, stats };
    }
    catch (e) {
        logger.error("state", `Failed to generate STATE.md for ${project}: ${e.message}`);
        return { generated: false, stats: {} };
    }
}
/**
 * Snapshot current project state into the event log.
 * Reads actual source, writes diff events, regenerates STATE.md.
 */
function snapshotState(project, dataDir, logger) {
    if (!project)
        return;
    try {
        const srcDir = getProjectLocation(project, dataDir);
        if (!srcDir || !fs.existsSync(srcDir))
            return;
        let toolCount = 0;
        let testCount = 0;
        let version = "";
        const srcPath = path.join(srcDir, "src", "index.ts");
        if (fs.existsSync(srcPath)) {
            const content = fs.readFileSync(srcPath, "utf-8");
            // Only count actual registerTool calls in the register(api) section
            // (not comment references like "// Each entry matches an api.registerTool")
            toolCount = countRegisteredTools(content);
        }
        const testDir = path.join(srcDir, "tests");
        if (fs.existsSync(testDir)) {
            testCount = fs.readdirSync(testDir).filter(f => f.endsWith(".test.ts") || f.endsWith(".test.js")).length;
        }
        const pkgPath = path.join(srcDir, "package.json");
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
                version = pkg.version || "";
            }
            catch { /* */ }
        }
        // Write snapshot events only if changed vs latest in log
        const events = readStateEvents(project, dataDir);
        let latestVersion = "";
        let latestToolCount = 0;
        let latestTestCount = 0;
        for (const ev of events) {
            if (ev.type === "version_changed")
                latestVersion = ev.version || "";
            if (ev.type === "tool_count_changed")
                latestToolCount = ev.count ?? 0;
            if (ev.type === "test_count_changed")
                latestTestCount = ev.count ?? 0;
        }
        if (version && version !== latestVersion) {
            writeStateEvent(project, dataDir, { type: "version_changed", version });
            logger.info("state", `Snapshot: version ${version} for ${project}`);
        }
        if (toolCount > 0 && toolCount !== latestToolCount) {
            writeStateEvent(project, dataDir, { type: "tool_count_changed", count: toolCount });
            logger.info("state", `Snapshot: ${toolCount} tools for ${project}`);
        }
        if (testCount > 0 && testCount !== latestTestCount) {
            writeStateEvent(project, dataDir, { type: "test_count_changed", count: testCount });
            logger.info("state", `Snapshot: ${testCount} tests for ${project}`);
        }
        // Regenerate STATE.md
        generateStateFromEvents(project, dataDir, logger);
    }
    catch { /* best-effort */ }
}
/**
 * Legacy alias: tryFixDocsDrift now uses state event log + regeneration.
 */
function tryFixDocsDrift(project, dataDir, logger) {
    if (!project)
        return;
    try {
        writeStateEvent(project, dataDir, { type: "doc_synced", auto: true });
        snapshotState(project, dataDir, logger);
    }
    catch { /* best-effort */ }
}
function controlDir(dataDir) {
    return path.join(dataDir, "control");
}
function writeActionResult(dataDir, actionId, ok, result, error) {
    try {
        const cd = controlDir(dataDir);
        if (!fs.existsSync(cd))
            fs.mkdirSync(cd, { recursive: true });
        fs.writeFileSync(path.join(cd, `${actionId}.result.json`), JSON.stringify({
            id: actionId,
            ok,
            result,
            error,
            processed_at: new Date().toISOString(),
        }, null, 2));
    }
    catch { /* silent */ }
}
function processSetContext(dataDir, params, logger) {
    const project = params.project;
    const task = params.task;
    if (!project)
        throw new Error("Missing project");
    sessionTracker.setContext(project, task || "");
    writeLiveAgents("control_set_context", sessionTracker, logger);
    return { project, task, ok: true };
}
function processClearContext(dataDir, _params, logger) {
    const prev = sessionTracker.currentProject;
    sessionTracker.clearContext();
    writeLiveAgents("control_clear_context", sessionTracker, logger);
    return { previous_project: prev, ok: true };
}
function processUpdateRouting(dataDir, params, logger) {
    const cfg = readJSON(path.join(dataDir, "dashboard-config.json")) || {
        free_only_mode: false, disabled_models: [], projects: {}
    };
    if (typeof params.free_only_mode === "boolean")
        cfg.free_only_mode = params.free_only_mode;
    if (Array.isArray(params.disabled_models))
        cfg.disabled_models = params.disabled_models;
    if (typeof params.project === "string" && params.project_allowlist) {
        cfg.projects = cfg.projects || {};
        cfg.projects[params.project] = cfg.projects[params.project] || {};
        cfg.projects[params.project].model_allowlist = params.project_allowlist;
    }
    if (typeof params.project === "string" && typeof params.project_free_only === "boolean") {
        cfg.projects = cfg.projects || {};
        cfg.projects[params.project] = cfg.projects[params.project] || {};
        cfg.projects[params.project].free_only = params.project_free_only;
    }
    writeJSON(path.join(dataDir, "dashboard-config.json"), cfg);
    logger.info("control", `Routing updated: free_only=${cfg.free_only_mode}`);
    return { ok: true, config: cfg };
}
function processControlAction(dataDir, action, logger) {
    try {
        logger.info("control", `Processing action ${action.id}: ${action.action}`);
        let result;
        switch (action.action) {
            case "set_context":
                result = processSetContext(dataDir, action.params, logger);
                break;
            case "clear_context":
                result = processClearContext(dataDir, action.params, logger);
                break;
            case "update_routing":
                result = processUpdateRouting(dataDir, action.params, logger);
                break;
            case "spawn_agent":
                result = { message: "Spawn request received", action: action.params };
                break;
            case "stop_agent":
                result = { message: "Stop request received", action: action.params };
                break;
            default:
                throw new Error(`Unknown action: ${action.action}`);
        }
        writeActionResult(dataDir, action.id, true, result, null);
    }
    catch (err) {
        logger.warn("control", `Action ${action.id} failed: ${err.message}`);
        writeActionResult(dataDir, action.id, false, null, err.message);
    }
}
class MaintenanceService {
    timer = null;
    started = false;
    dataDir;
    logger;
    safeguardLog = [];
    constructor(dataDir, logger) {
        this.dataDir = dataDir;
        this.logger = logger;
    }
    start(intervalMs = 30 * 60_000) {
        if (this.started)
            return;
        this.started = true;
        // First tick sooner for safeguards
        setTimeout(() => this.tick(), 15_000);
        this.timer = setInterval(() => this.tick(), intervalMs);
        this.logger.info("maintenance", `Started (every ${Math.round(intervalMs / 60000)}min)`);
    }
    tick() {
        try {
            this.logger.cleanup();
            const popLog = path.join(this.dataDir, "logs", "auto-populate.log");
            if (fs.existsSync(popLog)) {
                const stat = fs.statSync(popLog);
                if (Date.now() - stat.mtimeMs > 90 * 24 * 60 * 60_000) {
                    fs.truncateSync(popLog, 0);
                    this.logger.debug("maintenance", "Rotated auto-populate.log");
                }
            }
            // Process control actions (dashboard → plugin commands)
            this.processControlActions();
            // Check agent health (safeguards)
            this.detectStaleAgents();
            // Process projects
            const projDirPath = path.join(this.dataDir, "projects");
            if (!fs.existsSync(projDirPath))
                return;
            const projects = fs.readdirSync(projDirPath).filter(f => !f.startsWith(".") && fs.statSync(path.join(projDirPath, f)).isDirectory());
            for (const p of projects) {
                try {
                    normalizeSessionsJson(p, this.dataDir);
                    generateRecoveryDoc(p, this.dataDir, this.logger);
                    if (getProjectLocation(p, this.dataDir)) {
                        syncProjectToOrchestrator(p, this.dataDir, this.logger);
                    }
                    // Auto-generate state from event log on every tick
                    const stateLogPath = path.join(projDir(p, this.dataDir), "state-events.jsonl");
                    if (fs.existsSync(stateLogPath)) {
                        generateStateFromEvents(p, this.dataDir, this.logger);
                    }
                }
                catch (err) {
                    this.logger.warn("maintenance", `Error processing ${p}: ${err.message}`);
                }
            }
            this.logger.debug("maintenance", `Tick: ${projects.length} projects processed, control actions checked`);
        }
        catch (err) {
            this.logger.warn("maintenance", `Tick error: ${err.message}`);
        }
    }
    processControlActions() {
        try {
            const cd = controlDir(this.dataDir);
            if (!fs.existsSync(cd))
                return;
            const files = fs.readdirSync(cd)
                .filter(f => f.endsWith(".action.json"))
                .sort()
                .slice(0, 5); // Max 5 per tick
            for (const f of files) {
                const fp = path.join(cd, f);
                try {
                    const raw = fs.readFileSync(fp, "utf-8");
                    const action = JSON.parse(raw);
                    if (!action.id || !action.action) {
                        this.logger.warn("control", `Invalid action file: ${f}`);
                        fs.unlinkSync(fp);
                        continue;
                    }
                    // Check TTL
                    if (action.ttl_seconds && action.created_at) {
                        const age = Date.now() - new Date(action.created_at).getTime();
                        if (age > action.ttl_seconds * 1000) {
                            writeActionResult(this.dataDir, action.id, false, null, "Action timed out");
                            fs.unlinkSync(fp);
                            continue;
                        }
                    }
                    processControlAction(this.dataDir, action, this.logger);
                    fs.unlinkSync(fp);
                }
                catch (err) {
                    this.logger.warn("control", `Error processing ${f}: ${err.message}`);
                    // Remove malformed actions to avoid re-processing
                    try {
                        fs.unlinkSync(fp);
                    }
                    catch { /* */ }
                }
            }
        }
        catch (err) {
            this.logger.warn("control", `processControlActions error: ${err.message}`);
        }
    }
    detectStaleAgents() {
        try {
            const laPath = path.join(this.dataDir, "live-agents.json");
            if (!fs.existsSync(laPath))
                return;
            const cfg = readJSON(path.join(this.dataDir, "dashboard-config.json")) || {};
            const safeguards = cfg.safeguards || {};
            if (safeguards.enabled === false)
                return;
            const idleTimeout = safeguards.idle_timeout_ms || 10 * 60 * 1000; // 10 min
            const stuckTimeout = safeguards.stuck_timeout_ms || 30 * 60 * 1000; // 30 min
            const maxErrors = safeguards.max_errors_before_escalation || 3;
            const now = Date.now();
            const live = JSON.parse(fs.readFileSync(laPath, "utf-8"));
            const agents = live.agents || [];
            let recoveryNeeded = false;
            for (const a of agents) {
                if (!a.project)
                    continue; // Skip agents without active project
                const status = a.agent_status || "";
                const lastActivity = a.last_activity_at ? new Date(a.last_activity_at).getTime() : 0;
                const lastUpdate = a.timestamp ? new Date(a.timestamp).getTime() : 0;
                const elapsedSinceActivity = lastActivity ? now - lastActivity : 0;
                const elapsedSinceUpdate = lastUpdate ? now - lastUpdate : 0;
                const elapsedHuman = a.elapsed || "?";
                const errorCount = a.error_count || 0;
                const agentName = a.agent || "?";
                // Check 1: Agent is idle with active project for too long
                if (status === "idle" && elapsedSinceActivity > idleTimeout) {
                    this.logger.warn("safeguard", `Agent ${agentName} idle for ${Math.round(elapsedSinceActivity / 1000)}s (project: ${a.project})`);
                    this.safeguardLog.push(`[${new Date().toISOString()}] IDLE: ${agentName} idle ${Math.round(elapsedSinceActivity / 60000)}m on ${a.project}`);
                    if (safeguards.auto_recover !== false && a.project) {
                        // Auto-recover: write a set_context action for the same project
                        const actionId = `recover_${agentName}_${Date.now()}`;
                        const action = {
                            id: actionId,
                            action: "set_context",
                            params: { project: a.project, task: a.task || "auto-recovery" },
                            created_at: new Date().toISOString(),
                            ttl_seconds: 30,
                        };
                        try {
                            const cd = controlDir(this.dataDir);
                            if (!fs.existsSync(cd))
                                fs.mkdirSync(cd, { recursive: true });
                            fs.writeFileSync(path.join(cd, `${actionId}.action.json`), JSON.stringify(action, null, 2));
                            this.logger.info("safeguard", `Auto-recovery triggered for ${agentName} on ${a.project}`);
                            this.safeguardLog.push(`[${new Date().toISOString()}] RECOVER: ${agentName} → set_context ${a.project}`);
                            recoveryNeeded = true;
                        }
                        catch (err) {
                            this.logger.warn("safeguard", `Auto-recovery write failed: ${err.message}`);
                        }
                    }
                }
                // Check 2: Agent hasn't updated in too long despite having project context
                if (status !== "idle" && status !== "complete" && status !== "shutdown" && elapsedSinceUpdate > stuckTimeout) {
                    this.logger.warn("safeguard", `Agent ${agentName} stuck (no update ${Math.round(elapsedSinceUpdate / 60000)}m, status: ${status})`);
                    this.safeguardLog.push(`[${new Date().toISOString()}] STUCK: ${agentName} no update ${Math.round(elapsedSinceUpdate / 60000)}m (${status})`);
                }
                // Check 3: Error storm
                if (errorCount >= maxErrors) {
                    this.logger.warn("safeguard", `Agent ${agentName} hit ${errorCount} errors — escalation needed`);
                    this.safeguardLog.push(`[${new Date().toISOString()}] ESCALATE: ${agentName} ${errorCount} errors`);
                }
            }
            // Write safeguard log if anything was detected
            if (this.safeguardLog.length > 0) {
                const logPath = path.join(this.dataDir, "safeguard-log.md");
                const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "# Safeguard Recovery Log\n\n| Timestamp | Event | Details |\n|-----------|-------|---------|\n";
                const lines = this.safeguardLog.map(s => {
                    const parts = s.match(/\[(.*?)\] (\w+): (.*)/);
                    if (parts)
                        return `| ${parts[1]} | ${parts[2]} | ${parts[3]} |`;
                    return `| ${new Date().toISOString()} | INFO | ${s} |`;
                });
                fs.writeFileSync(logPath, existing + lines.join("\n") + "\n");
                this.safeguardLog = [];
            }
            if (recoveryNeeded) {
                this.logger.info("safeguard", "Recovery actions written — next tick will process them");
            }
        }
        catch (err) {
            this.logger.warn("safeguard", `detectStaleAgents error: ${err.message}`);
        }
    }
    stop() {
        if (this.timer)
            clearInterval(this.timer);
    }
}
// ═══════════════════════════════════════════════════════════════
//  MODEL / DASHBOARD HELPERS
// ═══════════════════════════════════════════════════════════════
function isPaid(m) {
    return ["subscription", "payg", "pay_per_token"].includes(m.cost?.type || "");
}
function parseSessionLog(dd) {
    const c = readFileContent(path.join(dd, "session_log.md"));
    if (!c)
        return { sessions: [], count: 0, projects: [] };
    const sessions = [];
    for (const l of c.split("\n")) {
        const t = l.trim();
        if (t.startsWith("|") && !t.startsWith("|---") && !t.startsWith("| Date")) {
            const p = t.split("|").slice(1, -1).map(x => x.trim());
            if (p.length >= 5)
                sessions.push({ date: p[0], project: p[1], task: p[2], model: p[3], agent: p[4] || "shell", status: p[5] || "", duration: p[6] || "", qa_done: p[7]?.includes("✓") || false, checked: p[8]?.includes("✓") || false, notes: p[9] || "" });
        }
    }
    return { sessions, count: sessions.length, projects: [...new Set(sessions.map(s => s.project))] };
}
function parsePriceLog(dd) {
    const c = readFileContent(path.join(dd, "price_changes.log"));
    if (!c)
        return { entries: [], count: 0 };
    const entries = c.split("\n").filter(l => l.trim() && !l.startsWith("#")).map(l => ({ text: l.trim() }));
    return { entries, count: entries.length };
}
function projDir(name, dd) {
    const p = path.join(dd, "projects", name);
    fs.mkdirSync(p, { recursive: true });
    return p;
}
/** Get the project data dir WITHOUT creating it. Returns null if it doesn't exist. */
function getProjDir(name, dd) {
    const p = path.join(dd, "projects", name);
    if (fs.existsSync(p))
        return p;
    return null;
}
// ═══════════════════════════════════════════════════════════════
//  ERROR LOGGING
// ═══════════════════════════════════════════════════════════════
function logOrchestratorError(project, dataDir, entry) {
    const pd = projDir(project, dataDir);
    fs.mkdirSync(pd, { recursive: true });
    const errLog = path.join(pd, "errors.log");
    const timestamp = new Date().toISOString();
    const line = JSON.stringify({ ...entry, timestamp }) + "\n";
    try {
        fs.appendFileSync(errLog, line, "utf-8");
    }
    catch { /* errors never crash */ }
}
/** Validate session entries for integrity. Flags suspicious/fake entries without deleting. */
function validateSessions(dataDir, project) {
    const issues = [];
    let total = 0;
    const projectsChecked = [];
    const checkProject = (projName) => {
        const pd = getProjDir(projName, dataDir);
        if (!pd)
            return;
        const sf = path.join(pd, "sessions.json");
        if (!fs.existsSync(sf))
            return;
        let sessions = [];
        try {
            const raw = JSON.parse(fs.readFileSync(sf, "utf-8"));
            sessions = Array.isArray(raw) ? raw : (raw.sessions || []);
        }
        catch {
            return;
        }
        projectsChecked.push(projName);
        const seenIds = new Map();
        for (let i = 0; i < sessions.length; i++) {
            const s = sessions[i];
            total++;
            const id = s.id || `index_${i}`;
            const sk = s.session_key || "";
            // 1. Valid session_key format
            if (!sk || typeof sk !== "string") {
                issues.push({ id, session_key: sk, issue: "Missing or invalid session_key", field: "session_key", severity: "error" });
            }
            else if (!sk.startsWith("agent:")) {
                issues.push({ id, session_key: sk, issue: "session_key does not start with 'agent:'", field: "session_key", severity: "error" });
            }
            // 2. Non-empty project and task
            if (!s.project || typeof s.project !== "string" || !s.project.trim()) {
                issues.push({ id, session_key: sk, issue: "Missing or empty project field", field: "project", severity: "error" });
            }
            if (!s.task || typeof s.task !== "string" || !s.task.trim()) {
                issues.push({ id, session_key: sk, issue: "Missing or empty task field", field: "task", severity: "error" });
            }
            // 3. Valid timestamps
            if (!s.start_time && !s.started_at && !s.logged_at) {
                issues.push({ id, session_key: sk, issue: "No timestamp fields at all (start_time/started_at/logged_at all missing)", field: "start_time", severity: "error" });
            }
            if (s.start_time && s.end_time && new Date(s.start_time).getTime() > new Date(s.end_time).getTime()) {
                issues.push({ id, session_key: sk, issue: "start_time is after end_time", field: "start_time/end_time", severity: "error" });
            }
            // 4. Duration sanity check
            if (s.duration) {
                const durStr = String(s.duration);
                // Check for absurd durations (e.g. > 24h as numeric)
                const numMatch = durStr.match(/^(\d+)\s*(min|h|hr)/i);
                if (numMatch) {
                    const val = parseInt(numMatch[1], 10);
                    const unit = numMatch[2].toLowerCase();
                    if ((unit === "h" || unit === "hr") && val > 24) {
                        issues.push({ id, session_key: sk, issue: `Suspicious duration: ${durStr} (>24h)`, field: "duration", severity: "warn" });
                    }
                    if (unit === "min" && val > 1440) {
                        issues.push({ id, session_key: sk, issue: `Suspicious duration: ${durStr} (>24h in minutes)`, field: "duration", severity: "warn" });
                    }
                }
            }
            // 5. Duplicate ID check
            if (seenIds.has(id)) {
                issues.push({ id, session_key: sk, issue: `Duplicate id: "${id}" appears at indices ${seenIds.get(id)} and ${i}`, field: "id", severity: "error" });
            }
            seenIds.set(id, i);
            // 6. Check for obviously fake/synthetic entries
            if (sk && sk.includes("synthetic")) {
                // Synthetic keys are sometimes legitimate (migration), but flag if also missing other fields
                if (!s.project || !s.task) {
                    issues.push({ id, session_key: sk, issue: "Synthetic key with missing project/task — likely a broken entry", field: "session_key", severity: "warn" });
                }
            }
        }
    };
    if (project) {
        checkProject(project);
    }
    else {
        const projectsDir = path.join(dataDir, "projects");
        if (fs.existsSync(projectsDir)) {
            for (const p of fs.readdirSync(projectsDir).sort()) {
                if (p.startsWith("."))
                    continue;
                const pp = path.join(projectsDir, p);
                if (!fs.statSync(pp).isDirectory())
                    continue;
                checkProject(p);
            }
        }
    }
    return { ok: true, total, issues, projects_checked: projectsChecked };
}
function getBacklogPath(project, dataDir) {
    return path.join(projDir(project, dataDir), "BACKLOG.json");
}
function readBacklog(project, dataDir) {
    const bp = getBacklogPath(project, dataDir);
    if (!fs.existsSync(bp))
        return [];
    try {
        const raw = JSON.parse(fs.readFileSync(bp, "utf-8"));
        return Array.isArray(raw) ? raw : (raw.tasks || []);
    }
    catch {
        return [];
    }
}
function writeBacklog(project, dataDir, tasks) {
    writeJSON(getBacklogPath(project, dataDir), { tasks });
}
function backlogAdd(project, dataDir, opts) {
    const tasks = readBacklog(project, dataDir);
    const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const task = {
        id,
        title: opts.title,
        description: opts.description || "",
        status: "todo",
        priority: (["p0", "p1", "p2", "p3"].includes(opts.priority || "") ? opts.priority : "p2"),
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        assigned_to: null,
        depends_on: opts.depends_on || [],
        labels: opts.labels || [],
        session_key: null,
    };
    tasks.push(task);
    writeBacklog(project, dataDir, tasks);
    return { ok: true, id };
}
function backlogList(project, dataDir, opts) {
    let tasks = readBacklog(project, dataDir);
    if (opts?.status)
        tasks = tasks.filter(t => t.status === opts.status);
    if (opts?.priority)
        tasks = tasks.filter(t => t.priority === opts.priority);
    if (opts?.label)
        tasks = tasks.filter(t => (t.labels || []).includes(opts.label));
    return { ok: true, tasks };
}
function backlogUpdate(project, dataDir, opts) {
    const tasks = readBacklog(project, dataDir);
    const idx = tasks.findIndex(t => t.id === opts.id);
    if (idx === -1)
        return { ok: false, error: `Task ${opts.id} not found. Use orchestrator_backlog_list to see available tasks.` };
    const task = tasks[idx];
    if (opts.status && ["todo", "in_progress", "done", "blocked"].includes(opts.status))
        task.status = opts.status;
    if (opts.priority && ["p0", "p1", "p2", "p3"].includes(opts.priority))
        task.priority = opts.priority;
    if (opts.assigned_to !== undefined)
        task.assigned_to = opts.assigned_to || null;
    if (opts.labels !== undefined)
        task.labels = opts.labels;
    if (opts.session_key !== undefined)
        task.session_key = opts.session_key || null;
    task.updated = new Date().toISOString();
    tasks[idx] = task;
    writeBacklog(project, dataDir, tasks);
    return { ok: true };
}
// ═══════════════════════════════════════════════════════════════
//  TOOL LOGIC
// ═══════════════════════════════════════════════════════════════
function getStatus(dataDir, logger) {
    const cfg = readJSON(path.join(dataDir, "dashboard-config.json")) || {};
    const md = readJSON(path.join(dataDir, "models.json"));
    const models = md?.models || [];
    const pd = path.join(dataDir, "projects");
    const projects = [];
    if (fs.existsSync(pd)) {
        for (const e of fs.readdirSync(pd)) {
            if (e.startsWith("."))
                continue; // Skip hidden dirs (.archived)
            if (fs.statSync(path.join(pd, e)).isDirectory())
                projects.push(e);
        }
    }
    logger.debug("status", "Status requested");
    const sl = parseSessionLog(dataDir);
    return {
        total_models: models.length,
        active_models: models.filter(m => m.status === "active").length,
        agent_ready_models: models.filter(m => m.agent_ready).length,
        sessions_logged: sl.count,
        projects,
        free_only_mode: cfg.free_only_mode || false,
        data_dir: dataDir,
    };
}
function getConfig(dataDir, logger) {
    const cfg = readJSON(path.join(dataDir, "dashboard-config.json"));
    if (!cfg)
        return { error: "No config found — run orchestrator_auto_populate first", data_dir: dataDir };
    const models = readJSON(path.join(dataDir, "models.json"))?.models || [];
    const pc = {};
    for (const m of models) {
        const p = m.provider || "unknown";
        pc[p] = (pc[p] || 0) + 1;
    }
    logger.debug("config", "Config requested");
    return {
        free_only_mode: cfg.free_only_mode || false,
        disabled_models: cfg.disabled_models || [],
        projects: Object.entries(cfg.projects || {}).map(([n, c]) => ({
            name: n,
            model_allowlist: c.model_allowlist || [],
            free_only: c.free_only || false,
            whitelist_count: c.model_allowlist?.length || 0,
        })),
        total_models: models.length,
        providers: pc,
        project_count: Object.keys(cfg.projects || {}).length,
    };
}
function filterModelsForProject(models, project, dataDir) {
    if (!project)
        return [...models];
    const cfg = readJSON(path.join(dataDir, "dashboard-config.json")) || {};
    let f = [...models];
    if (cfg.free_only_mode)
        f = f.filter(m => !isPaid(m));
    const d = cfg.disabled_models || [];
    if (d.length)
        f = f.filter(m => !d.includes(m.id));
    const pc = cfg.projects?.[project];
    if (pc) {
        if (pc.model_allowlist?.length)
            f = f.filter(m => pc.model_allowlist.includes(m.id));
        if (pc.free_only)
            f = f.filter(m => !isPaid(m));
    }
    return f;
}
function getModels(dataDir, opts, logger) {
    const md = readJSON(path.join(dataDir, "models.json"));
    let all = md?.models || [];
    let f = filterModelsForProject(all, opts.project, dataDir);
    if (opts.status) {
        const ss = opts.status.split(",").map((s) => s.trim().toLowerCase());
        f = f.filter(m => ss.includes((m.status || "").toLowerCase()));
    }
    if (opts.provider)
        f = f.filter(m => (m.provider || "").toLowerCase().includes(opts.provider.toLowerCase()));
    if (opts.search) {
        const q = opts.search.toLowerCase();
        f = f.filter(m => m.id.toLowerCase().includes(q) || (m.name || "").toLowerCase().includes(q));
    }
    if (opts.agent_ready !== undefined)
        f = f.filter(m => m.agent_ready === opts.agent_ready);
    logger.debug("models", `Listed ${f.length}/${all.length}`);
    return {
        total: all.length,
        filtered: f.length,
        models: f.map(m => ({
            id: m.id, provider: m.provider, name: m.name, tier: m.tier,
            speed_rating: m.speed_rating, status: m.status, agent_ready: m.agent_ready,
            cost_type: m.cost?.type || "unknown", context_window: m.context_window || 0,
            capabilities: m.capabilities || {}, notes: m.notes || "",
        })),
    };
}
function checkModels(dataDir, project, logger) {
    const cfg = readJSON(path.join(dataDir, "dashboard-config.json")) || {};
    const md = readJSON(path.join(dataDir, "models.json"));
    let eligible = md?.models || [];
    const filters = [];
    if (cfg.free_only_mode) {
        eligible = eligible.filter(m => !isPaid(m));
        filters.push("global_free_only");
    }
    const d = cfg.disabled_models || [];
    if (d.length) {
        eligible = eligible.filter(m => !d.includes(m.id));
        filters.push("global_disabled");
    }
    const pc = project ? cfg.projects?.[project] : undefined;
    if (pc) {
        if (pc.model_allowlist?.length) {
            eligible = eligible.filter(m => pc.model_allowlist.includes(m.id));
            filters.push("project_allowlist");
        }
        if (pc.free_only) {
            eligible = eligible.filter(m => !isPaid(m));
            filters.push("project_free_only");
        }
    }
    const all = md?.models?.length || 0;
    logger.logRouting(eligible[0]?.id || "none", project || null, eligible.length, all, filters);
    return {
        project: project || null, free_only_mode: cfg.free_only_mode || false,
        disabled_models: d, filters_applied: filters, total_available: all,
        eligible_count: eligible.length,
        eligible_models: eligible.map(m => ({
            id: m.id, provider: m.provider, name: m.name, tier: m.tier,
            speed_rating: m.speed_rating, status: m.status, agent_ready: m.agent_ready,
            cost_type: m.cost?.type || "unknown",
        })),
    };
}
function autoPopulate(dataDir, logger) {
    // Script is bundled in the plugin package — no skill dir needed!
    const script = path.join(PLUGIN_ROOT, "scripts", "auto-populate-models.py");
    if (!fs.existsSync(script))
        return { error: `Script not found at ${script} — ensure the plugin package includes scripts/auto-populate-models.py` };
    try {
        logger.debug("populate", "Running...");
        const r = execSync(`python3 "${script}" 2>&1`, { cwd: path.dirname(script), encoding: "utf-8", timeout: 120_000 });
        const md = readJSON(path.join(dataDir, "models.json"));
        const t = md?.models?.length || 0;
        logger.info("populate", `Done: ${t} models`);
        return { success: true, total_models: t, output: r.trim() };
    }
    catch (err) {
        logger.error("populate", `Failed: ${err.message}`);
        return { success: false, error: err.message };
    }
}
function logSession(dataDir, opts, logger) {
    const date = new Date().toISOString().split("T")[0];
    const sp = opts.project.replace(/[^a-zA-Z0-9_-]/g, "-");
    const st = opts.task.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
    const slp = path.join(dataDir, "session_log.md");
    if (!fs.existsSync(slp)) {
        fs.writeFileSync(slp, "# Session Log\n\n| Date | Project | Task | Model | Agent | Status | Duration | QA | Checked | Notes |\n|------|---------|------|-------|-------|--------|----------|----|---------|-------|\n", "utf-8");
    }
    fs.appendFileSync(slp, `| ${date} | ${opts.project} | ${opts.task} | ${opts.model} | ${opts.agent} | ${opts.status} | ${opts.duration || ""} | ${opts.qa ? "true" : "false"} | ${opts.checked ? "true" : "false"} | ${opts.notes || ""} |\n`, "utf-8");
    // Write rich session detail file
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const sessionDir = path.join(dataDir, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const logDir2 = path.join(dataDir, "logs");
    fs.mkdirSync(logDir2, { recursive: true });
    const df = path.join(sessionDir, `${ts}-${sp}-${st}.md`);
    fs.writeFileSync(df, [
        `# Session: ${opts.project} / ${opts.task}`,
        ``,
        `**Date:** ${date}`,
        `**Agent:** ${opts.agent}`,
        `**Model:** ${opts.model}`,
        `**Status:** ${opts.status}`,
        `**Goal:** ${opts.goal || opts.task || "N/A"}`,
        `**Session Key:** ${opts.session_key || "N/A"}`,
        `**Duration:** ${opts.duration || "N/A"}`,
        `**QA:** ${opts.qa ? "true" : "false"} | **Checked:** ${opts.checked ? "true" : "false"}`,
        ``,
        `## Notes`,
        ``,
        `${opts.notes || "None"}`,
        ``,
        `---`,
        `*Auto-logged by Genor's Orchestrator plugin v0.4.3*`,
    ].join("\n"), "utf-8");
    // Append to project sessions.json (per-project session log)
    const pd = path.join(dataDir, "projects", sp);
    fs.mkdirSync(pd, { recursive: true });
    const psf = path.join(pd, "sessions.json");
    let ps = [];
    if (fs.existsSync(psf)) {
        try {
            const raw = JSON.parse(fs.readFileSync(psf, "utf-8"));
            if (Array.isArray(raw))
                ps = raw;
            else if (raw?.sessions && Array.isArray(raw.sessions))
                ps = raw.sessions;
        }
        catch { /* */ }
    }
    // Build entry in new canonical schema v2
    const sessId = `sess_${(opts.id || (Math.random().toString(36).slice(2) + Date.now().toString(36))).replace(/[^a-zA-Z0-9_]/g, "").slice(0, 14)}`;
    // GUARANTEE session_key — generate synthetic stable key if missing
    let sessionKey = opts.session_key || "";
    let syntheticKey = false;
    if (!sessionKey) {
        syntheticKey = true;
        const safeProj = (opts.project || "unknown").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 30);
        const safeTask = (opts.task || "unknown").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
        const startTime = opts.start_time || new Date().toISOString();
        const hash = crypto.createHash("sha256").update(`${opts.project}|${opts.task}|${startTime}`).digest("hex").slice(0, 12);
        sessionKey = `agent:main:synthetic:${safeProj}:${safeTask}:${hash}`;
    }
    const parentSessionKey = opts.parent_session_key || (sessionKey.includes(":subagent:") ? sessionKey.split(":subagent:")[0] : null);
    const agentNorm = (() => {
        const a = (opts.agent || "system").toString().toLowerCase();
        const m = a.match(/subagent[-_]?([0-9a-f]+)/);
        if (m)
            return `sub-${m[1].slice(0, 8)}`;
        if (a === "amy" || a === "spice")
            return a[0].toUpperCase() + a.slice(1);
        return a || "system";
    })();
    const tags = Array.isArray(opts.tags) ? opts.tags : extractTags(opts.task || "", opts.notes || "");
    const now = new Date().toISOString();
    const newEntry = {
        id: sessId,
        session_key: sessionKey,
        parent_session_key: parentSessionKey,
        agent: agentNorm,
        project: opts.project,
        task: opts.task,
        goal: opts.goal || opts.task || "",
        original_prompt: opts.original_prompt || null,
        model: opts.model,
        status: opts.status,
        // ═══ Timestamps (Phase 3d) ═══
        start_time: opts.start_time || now,
        started_at: opts.start_time || now,
        end_time: opts.end_time || (opts.status === "running" ? null : now),
        ended_at: opts.end_time || (opts.status === "running" ? null : now),
        updated_at: now,
        logged_at: now,
        duration: opts.duration || "",
        tags,
        links: opts.links || { session_file: path.basename(df), recovery_doc: null, parent_recovery: null, synthetic_key: syntheticKey },
        notes: opts.notes || "",
        qa: opts.qa || false,
        checked: opts.checked || false,
    };
    // Check for duplicate by (session_key, task, status) — avoid log noise
    const isDup = ps.some(e => e.session_key && e.session_key === newEntry.session_key
        && e.task === newEntry.task && e.status === newEntry.status);
    if (!isDup) {
        ps.push(newEntry);
        writeJSON(psf, { schema_version: 2, sessions: ps });
    }
    logger.logSession(opts.project, opts.task, opts.model, opts.agent, opts.status);
    return { success: true, date, project: opts.project, task: opts.task, session_file: path.basename(df), total_project_sessions: ps.length };
}
function logDecision(dataDir, opts, logger) {
    const date = new Date().toISOString().split("T")[0];
    const slug = opts.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    const ad = path.join(dataDir, "adrs");
    fs.mkdirSync(ad, { recursive: true });
    let num = 1;
    const ex = fs.existsSync(ad) ? fs.readdirSync(ad).filter(f => /^\d{4}-.*\.md$/.test(f)) : [];
    if (ex.length > 0)
        num = Math.max(...ex.map(f => parseInt(f.split("-")[0], 10))) + 1;
    const p = String(num).padStart(4, "0");
    const af = path.join(ad, `${p}-${slug}.md`);
    fs.writeFileSync(af, `# ADR-${p}: ${opts.title}\n\n**Status:** Accepted\n**Date:** ${date}\n**Project:** ${opts.project}\n\n## Context\n\n${opts.context}\n\n## Decision\n\n${opts.decision}\n\n## Alternatives Considered\n\n${opts.alternatives || "N/A"}\n\n## Consequences\n\n${opts.consequences || "TBD"}\n`, "utf-8");
    const dl = path.join(dataDir, "price_changes.log");
    if (!fs.existsSync(dl)) {
        fs.writeFileSync(dl, "# Decision Log\n\n| Date | Project | Decision | ADR |\n|------|---------|----------|-----|\n", "utf-8");
    }
    fs.appendFileSync(dl, `| ${date} | ${opts.project} | ${opts.title} | adrs/${p}-${slug}.md |\n`, "utf-8");
    logger.info("decisions", `ADR #${num}: ${opts.title}`, { file: `adrs/${p}-${slug}.md` });
    return { success: true, adr_number: num, adr_file: `adrs/${p}-${slug}.md`, title: opts.title, project: opts.project };
}
function getLogs(dataDir, opts, logger) {
    const entries = logger.query(opts.limit || 50, { level: opts.level, source: opts.source, since: opts.since });
    return {
        entries: entries.map(e => ({ ts: e.ts, level: e.level, source: e.source, msg: e.msg, data: e.data || {} })),
        total: entries.length,
        sources: [...new Set(entries.map(e => e.source))],
        levels: [...new Set(entries.map(e => e.level))],
    };
}
function requireRegistration() {
    const sk = sessionTracker.sessionKey;
    if (sk && sessionTracker.isSessionRegistered(sk))
        return null;
    return "This session is not registered with the orchestrator. Call orchestrator_register first to opt in to orchestrator tracking and project context injection.";
}
function setContext(dataDir, project, task, logger, originalPrompt) {
    projDir(project, dataDir);
    // Read per-project workflow config from dashboard-config.json
    const cfg = readJSON(path.join(dataDir, "dashboard-config.json")) || {};
    const projCfg = cfg.projects?.[project] || {};
    sessionTracker.setContext(project, task, projCfg.workflow);
    writeLiveAgents("context", sessionTracker);
    const loc = getProjectLocation(project, dataDir);
    const toc = loc ? buildProjectToc(loc) : [];
    // Warn if this project has NO sessions logged yet (brand new / never worked on)
    const pd = projDir(project, dataDir);
    const psf = path.join(pd, "sessions.json");
    let sessionCount = 0;
    if (fs.existsSync(psf)) {
        try {
            const raw = JSON.parse(fs.readFileSync(psf, "utf-8"));
            sessionCount = (Array.isArray(raw) ? raw : (raw.sessions || [])).length;
        }
        catch { /* */ }
    }
    const isFresh = sessionCount === 0;
    // Auto-log session only when a model is actually assigned (skip phantom 'pending' entries)
    const sessionModel = sessionTracker.currentModel;
    if (sessionModel && sessionModel !== "pending") {
        const truncatedPrompt = originalPrompt ? String(originalPrompt).slice(0, 500) : null;
        logSession(dataDir, {
            project,
            task,
            model: sessionModel,
            agent: sessionTracker.currentAgent || sessionTracker.sessionKey || "system",
            status: "running",
            duration: "",
            session_key: sessionTracker.sessionKey || "",
            goal: task,
            original_prompt: truncatedPrompt,
            notes: `Goal: ${task} | Agent: ${sessionTracker.currentAgent || "?"} | Key: ${sessionTracker.sessionKey || "?"} | Workflow: ${projCfg.workflow?.enabled ? "ON" : "OFF"}`,
        }, logger);
    }
    logger.info("context", `Context set: ${project}/${task} [session=${sessionTracker.sessionKey}]`);
    return {
        ok: true, project, task, location: loc || "not configured",
        location_configured: loc !== undefined && loc !== null,
        toc_file_count: toc.length,
        workflow_enabled: sessionTracker.workflow.enabled,
        warning: isFresh ? `This project (${project}) has no sessions logged yet. ` +
            `Orphaned/empty projects with no sessions are clutter. ` +
            `Start working on the project to log the first session.` : undefined,
    };
}
function clearContextFn(dataDir, logger) {
    // ═══ ENFORCE TASK COMPLETION LOGGING ═══
    // Before clearing context, require the session to have logged
    // its completion via orchestrator_log_session.
    if (sessionTracker.currentProject && !sessionTracker.loggedTaskCompletion) {
        return {
            ok: false,
            error: `❌ Task not logged. Session has active context on project "${sessionTracker.currentProject}" ` +
                `but hasn't logged completion. Call orchestrator_log_session with status="complete" (or "blocked"/"failed") ` +
                `first to document what was done. This ensures no work falls through the cracks.`,
        };
    }
    const prev = sessionTracker.currentProject;
    sessionTracker.clearContext();
    if (prev) {
        logger.info("context", `Context cleared: ${prev}`);
        writeLiveAgents("clear_context", sessionTracker);
    }
    return { ok: true, previous_project: prev };
}
function syncProject(dataDir, project, logger) {
    const loc = getProjectLocation(project, dataDir);
    if (!loc || !fs.existsSync(loc)) {
        return { error: `No valid location for ${project}`, project };
    }
    sessionTracker.trackAction(`syncing_project: ${project}`);
    writeLiveAgents("sync_project", sessionTracker);
    syncProjectToOrchestrator(project, dataDir, logger);
    return { ok: true, project, location: loc };
}
function getProjectDocsFn(dataDir, project, logger) {
    const pd = getProjDir(project, dataDir) || projDir(project, dataDir);
    // GetProjDir first (no create), fall back to projDir if we need to create for new projects
    const docs = [];
    if (pd && fs.existsSync(pd)) {
        for (const f of fs.readdirSync(pd)) {
            if (f.endsWith(".md") || f.endsWith(".json"))
                docs.push(f);
        }
    }
    logger.debug("projects", `Docs for ${project}: ${docs.length}`);
    return { project, doc_count: docs.length, docs };
}
// ═══════════════════════════════════════════════════════════════
//  PLUGIN ENTRY
// ═══════════════════════════════════════════════════════════════
let maintenanceSvc = null;
const TOOL_NAMES = [
    "orchestrator_set_context", "orchestrator_clear_context", "orchestrator_get_status",
    "orchestrator_get_config", "orchestrator_get_models", "orchestrator_check_models",
    "orchestrator_auto_populate", "orchestrator_log_session", "orchestrator_log_decision",
    "orchestrator_get_logs", "orchestrator_sync_project", "orchestrator_get_project_docs",
    "orchestrator_advance_phase", "orchestrator_get_routing",
    "orchestrator_register", "orchestrator_unregister", "orchestrator_get_registered_sessions",
    "orchestrator_release_project",
    "orchestrator_list_active_projects",
    "orchestrator_join_project",
    "orchestrator_spawn_subagent",
    "orchestrator_create_project",
    "orchestrator_backlog_add",
    "orchestrator_backlog_list",
    "orchestrator_backlog_update",
    "orchestrator_backlog_dispatch",
    "orchestrator_backlog_dispatch_all",
    "orchestrator_qa_submit",
    "orchestrator_qa_approve",
    "orchestrator_qa_reject",
    "orchestrator_generate_handoff",
];
// Proper tool metadata for agent session exposure (OpenClaw agent tool injection).
// Each entry matches an api.registerTool({...}) call in register() below.
// Parameters use OpenClaw's TypeBox schema compiled to JSON Schema.
const TOOL_METADATA = [
    { name: "orchestrator_set_context", label: "Orchestrator Set Context", description: "MANDATORY before starting project work. Sets active project and task context, enabling auto-routing, auto-logging, and context injection.", parameters: { type: "object", properties: { project: { type: "string", description: "Project name (e.g., kfinance, kotw)." }, task: { type: "string", description: "Describe the task you are about to do." }, original_prompt: { type: "string", description: "OPTIONAL: The original user request that triggered this task." } }, required: ["project", "task"] } },
    { name: "orchestrator_clear_context", label: "Orchestrator Clear Context", description: "Clear active project context. Disables auto-routing and auto-logging.", parameters: { type: "object", properties: {} } },
    { name: "orchestrator_register", label: "Orchestrator Register", description: "Register this session for orchestrator tracking. Must be called BEFORE orchestrator_set_context.", parameters: { type: "object", properties: {} } },
    { name: "orchestrator_unregister", label: "Orchestrator Unregister", description: "Unregister this session from orchestrator tracking. Clears project context and stops all tracking.", parameters: { type: "object", properties: {} } },
    { name: "orchestrator_get_status", label: "Status", description: "Get quick orchestration status: model counts, session count, project list, free-only mode state.", parameters: { type: "object", properties: {} } },
    { name: "orchestrator_get_config", label: "Config", description: "Read the full routing configuration: free-only mode, disabled models, per-project allowlists.", parameters: { type: "object", properties: {} } },
    { name: "orchestrator_get_models", label: "Models", description: "List models from the model inventory with optional filters (status, provider, search, project routing).", parameters: { type: "object", properties: { status: { type: "string", description: "Filter by status: active, discovered, offline, removed. Comma-separated." }, provider: { type: "string", description: "Filter by provider name (partial match)." }, search: { type: "string", description: "Search by model ID or name (partial match)." }, agent_ready: { type: "boolean", description: "Filter by agent_ready flag." }, project: { type: "string", description: "Apply project routing filters to results." } } } },
    { name: "orchestrator_check_models", label: "Check Models (routing)", description: "Check which models are eligible for a project, applying all routing filters.", parameters: { type: "object", properties: { project: { type: "string", description: "Project name for per-project routing rules. Omit for global-only check." } } } },
    { name: "orchestrator_auto_populate", label: "Auto-Populate", description: "Auto-populate model inventory from OpenClaw gateway config. Merges into orchestrator-data/models.json, preserving manual ratings.", parameters: { type: "object", properties: {} } },
    { name: "orchestrator_log_session", label: "Log Session", description: "Log a completed session to the per-project session log. Writes a structured session entry with full metadata.", parameters: { type: "object", properties: { project: { type: "string", description: "Project name." }, task: { type: "string", description: "Task description." }, model: { type: "string", description: "Model used." }, agent: { type: "string", description: "Agent name." }, status: { type: "string", description: "Session status." } }, required: ["project", "task", "model"] } },
    { name: "orchestrator_log_decision", label: "Log Decision", description: "Log an architecture decision record (ADR) to the project.", parameters: { type: "object", properties: { project: { type: "string", description: "Project name." }, title: { type: "string", description: "Decision title." }, context: { type: "string", description: "Why this decision was needed." }, decision: { type: "string", description: "What was decided." } }, required: ["project", "title", "context", "decision"] } },
    { name: "orchestrator_get_logs", label: "Logs", description: "Query orchestration logs: routing decisions, model choices, session activity, config changes.", parameters: { type: "object", properties: { limit: { type: "number", description: "Max entries (default: 50)." }, level: { type: "string", description: "Minimum level: debug, info, warn, error." }, source: { type: "string", description: "Filter by source (e.g., routing, session, models)." }, since: { type: "string", description: "ISO timestamp filter." } } } },
    { name: "orchestrator_sync_project", label: "Sync Project", description: "Sync a registered project with the orchestrator: regenerates CONTEXT.md and KEY_FILES.md from the project source.", parameters: { type: "object", properties: { project: { type: "string", description: "Project name." }, commit: { type: "boolean", description: "Auto-commit changes to the project repo." } }, required: ["project"] } },
    { name: "orchestrator_get_project_docs", label: "Project Docs", description: "Get project documentation files (CONTEXT.md, KEY_FILES.md, RECOVERY.md) from the orchestrator data directory.", parameters: { type: "object", properties: { project: { type: "string", description: "Project name." } }, required: ["project"] } },
    { name: "orchestrator_advance_phase", label: "Advance Workflow Phase", description: "Advance the workflow enforcement to the next phase (Analyze → Plan → Document → Work → Log → Finish).", parameters: { type: "object", properties: { phase: { type: "string", description: "Target phase to transition to. Omit to auto-advance." }, skip: { type: "boolean", description: "Mark current phase as skipped." } } } },
    { name: "orchestrator_get_routing", label: "Get Model Routing", description: "Get the recommended model for a task category (coding, fixing, research, q&a, documentation).", parameters: { type: "object", properties: { category: { type: "string", description: "Task category: coding, fixing, research, q&a, documentation" }, project: { type: "string", description: "Project name. Omit to use current project context." } }, required: ["category"] } },
    { name: "orchestrator_get_registered_sessions", label: "Get Registered Sessions", description: "List all registered session keys for orchestrator tracking.", parameters: { type: "object", properties: {} } },
    { name: "orchestrator_doctor", label: "Doctor", description: "Diagnose and auto-fix common orchestrator issues: session key mismatches, broken registration, stale data, context inconsistencies, orphaned projects, and missing STATE.md docs.", parameters: { type: "object", properties: { check: { type: "string", description: "Specific check: 'all', 'sessions', 'context', 'data'" }, fix: { type: "boolean", description: "Auto-fix issues when possible" } } } },
    { name: "orchestrator_release_project", label: "Release Project Binding", description: "Release the current session's project binding so it can work on a different project. Use when you're done with the current project and need to switch contexts with a fresh start.", parameters: { type: "object", properties: { force: { type: "boolean", description: "Force release even if migration in progress (default: false)" } } } },
    { name: "orchestrator_list_active_projects", label: "List Active Projects", description: "List projects that currently have active sessions working on them. Shows project names, active session count, and session keys.", parameters: { type: "object", properties: {} } },
    { name: "orchestrator_join_project", label: "Join Active Project", description: "Non-registered sessions can discover and join an active project. Handles registration + context setting in one step. Use for new/ad-hoc sessions contributing to existing projects.", parameters: { type: "object", properties: { project: { type: "string", description: "Project name to join. Use orchestrator_list_active_projects first." }, task: { type: "string", description: "Task description for what you're joining to do." } }, required: ["project", "task"] } },
    { name: "orchestrator_spawn_subagent", label: "Spawn Subagent", description: "Spawn a subagent using orchestrator-managed project context, with model routing and auto-logging. Logged as subagent session under current project. Returns session key for tracking.", parameters: { type: "object", properties: { task: { type: "string", description: "Task description for the subagent." }, model: { type: "string", description: "Optional model override. Omit to use project routing rules." }, taskName: { type: "string", description: "Optional stable name for subagent (lowercase_underscores)." }, timeoutSeconds: { type: "number", description: "Optional timeout in seconds (default: 300, max: 1800)." } }, required: ["task"] } },
    { name: "orchestrator_create_project", label: "Create Project", description: "Create a new project in orchestrator-data. Sets up project directory, STATE.md, and dashboard-config.json entry. Optionally spawns a dedicated session.", parameters: { type: "object", properties: { name: { type: "string", description: "Project name." }, directory: { type: "string", description: "Absolute path to project directory." }, description: { type: "string", description: "Short project description." }, spawn: { type: "boolean", description: "Schedule an immediate session." }, spawn_task: { type: "string", description: "Initial task description." } }, required: ["name"] } },
    { name: "orchestrator_backlog_add", label: "Add Backlog Task", description: "Add a task to a project's backlog.", parameters: { type: "object", properties: { project: { type: "string", description: "Project name." }, title: { type: "string", description: "Task title." }, description: { type: "string", description: "Task description." }, priority: { type: "string", description: "Priority: p0 (urgent), p1 (high), p2 (normal), p3 (low). Default: p2." }, labels: { type: "array", items: { type: "string" }, description: "Labels/tags." }, depends_on: { type: "array", items: { type: "string" }, description: "Task IDs this depends on." } }, required: ["project", "title"] } },
    { name: "orchestrator_backlog_list", label: "List Backlog", description: "List backlog tasks with optional filters.", parameters: { type: "object", properties: { project: { type: "string", description: "Project name." }, status: { type: "string", description: "Filter by status: todo, in_progress, done, blocked." }, priority: { type: "string", description: "Filter by priority: p0, p1, p2, p3." }, label: { type: "string", description: "Filter by label." } }, required: ["project"] } },
    { name: "orchestrator_backlog_update", label: "Update Backlog Task", description: "Update a backlog task's status, priority, assignment, or labels.", parameters: { type: "object", properties: { project: { type: "string", description: "Project name." }, id: { type: "string", description: "Task ID." }, status: { type: "string", description: "New status: todo, in_progress, done, blocked." }, priority: { type: "string", description: "New priority: p0, p1, p2, p3." }, assigned_to: { type: "string", description: "Assign to agent or user." }, labels: { type: "array", items: { type: "string" }, description: "Replace labels." } }, required: ["project", "id"] } },
    { name: "orchestrator_backlog_dispatch", label: "Backlog Dispatch", description: "Pick highest-priority backlog task(s) and return dispatch instructions. Supports parallel dispatch (max_dispatch). Respects dependencies, labels, auto-claim.", parameters: { type: "object", properties: { project: { type: "string" }, task_id: { type: "string" }, auto_claim: { type: "boolean" }, filter_labels: { type: "string" }, max_dispatch: { type: "number" } } } },
    { name: "orchestrator_backlog_dispatch_all", label: "Backlog Dispatch All", description: "Dispatch ALL currently available backlog tasks up to max_dispatch for parallel sub-agent execution. Auto-claims by default.", parameters: { type: "object", properties: { project: { type: "string" }, max_dispatch: { type: "number" }, auto_claim: { type: "boolean" }, filter_labels: { type: "string" } } } },
    { name: "orchestrator_qa_submit", label: "QA Submit Finding", description: "Submit a QA finding for review. When workflow.include_qa is enabled, this is required before advancing from work to log. ENFORCED: auto-spawns an independent QA review subagent.", parameters: { type: "object", properties: { finding: { type: "string", description: "Describe the QA finding, issue, or observation." }, review_model: { type: "string", description: "Optional model for the QA review subagent." } }, required: ["finding"] } },
    { name: "orchestrator_qa_approve", label: "QA Approve", description: "Approve the current work. Unblocks the work→log transition when QA gate is active.", parameters: { type: "object", properties: {} } },
    { name: "orchestrator_qa_reject", label: "QA Reject", description: "Reject the current work and return to work phase for fixes. Provide a reason for the rejection.", parameters: { type: "object", properties: { reason: { type: "string", description: "Why the work was rejected. Describe what needs to be fixed." } }, required: ["reason"] } },
    { name: "orchestrator_generate_handoff", label: "Generate Handoff", description: "Generate a handoff/recovery document for the current task. Required before advancing to the finish phase.", parameters: { type: "object", properties: {} } },
    // ── Quick Action Tools ────────────────────────────────────
    { name: "orchestrator_grill_with_docs", label: "Grill Me With Docs", description: "Spawns a subagent that reads all project documentation and quizzes you on it — sharpens project understanding and catches knowledge gaps.", parameters: { type: "object", properties: { topic: { type: "string", description: "Optional focus topic." }, model: { type: "string", description: "Optional model override." } } } },
    { name: "orchestrator_fix_docs_drift", label: "Fix Docs Drift", description: "Scans project docs for stale version numbers, tool counts, test counts, and other drift. Updates STATE.md, CONTEXT.md, ROADMAP.md, and README.md to match current state.", parameters: { type: "object", properties: { project: { type: "string", description: "Project name. Omit to use current context." } } } },
    { name: "orchestrator_regenerate_state", label: "Regenerate State", description: "Regenerate STATE.md from the project state event log (state-events.jsonl). No LLM involved — computed from actual events, safe for concurrent writers.", parameters: { type: "object", properties: { project: { type: "string", description: "Project name. Omit to use current context." } } } },
    { name: "orchestrator_cleanup_docs", label: "Clean Up & Organize Docs", description: "Spawns a subagent that reads, cleans up, organizes, and updates project documentation — fixing broken links, stale content, and filling gaps.", parameters: { type: "object", properties: { scope: { type: "string", description: "Scope: all, readme, adrs, docs, tests." }, model: { type: "string", description: "Optional model override." } } } },
    { name: "orchestrator_setup_unit_tests", label: "Set Up Unit Tests", description: "Spawns a subagent that sets up unit test infrastructure (framework, config, CI) and creates initial tests for existing code.", parameters: { type: "object", properties: { framework: { type: "string", description: "Test framework: vitest, jest, mocha, pytest, etc." }, model: { type: "string", description: "Optional model override." } } } },
    { name: "orchestrator_setup_e2e_tests", label: "Set Up E2E Tests", description: "Spawns a subagent that sets up E2E test infrastructure and creates initial test scenarios.", parameters: { type: "object", properties: { framework: { type: "string", description: "Framework: playwright, cypress, puppeteer, etc." }, model: { type: "string", description: "Optional model override." } } } },
    { name: "orchestrator_debug_issue", label: "Debug Issue", description: "Spawns a subagent to investigate and help fix a specific bug or issue in the project.", parameters: { type: "object", properties: { issue_description: { type: "string", description: "Describe the bug or issue in detail." }, model: { type: "string", description: "Optional model override." } }, required: ["issue_description"] } },
    { name: "orchestrator_create_functionality", label: "Create New Functionality", description: "Spawns a subagent to design and implement new features or functionality in the project.", parameters: { type: "object", properties: { description: { type: "string", description: "Describe the new functionality — requirements and constraints." }, model: { type: "string", description: "Optional model override." } }, required: ["description"] } },
];
// ── REGISTERED TOOL COUNTER ────────────────────────────────────
/** Count registerTool calls, excluding those inside line comments. */
function countRegisteredTools(sourceText) {
    const prefix = "api.";
    const suffix = "registerTool({";
    const target = prefix + suffix;
    let count = 0, pos = 0;
    while (pos < sourceText.length) {
        const idx = sourceText.indexOf(target, pos);
        if (idx === -1)
            break;
        const lineStart = sourceText.lastIndexOf("\n", idx) + 1;
        if (lineStart === 0) {
            pos = idx + 1;
            continue;
        }
        const lineBefore = sourceText.slice(lineStart, idx).trimStart();
        if (!lineBefore.startsWith("//"))
            count++;
        pos = idx + 1;
    }
    return count;
}
const PLUGIN_ID = "genor-orchestrator";
const _plugin = definePluginEntry({
    id: PLUGIN_ID,
    name: "Genor's Orchestrator",
    description: "Model routing, session logging, project management, dashboard, hooks, and context injection. Plugin-driven: orchestrator drives the workflow, LLM focuses on thinking.",
    register(api) {
        const cfg = api.pluginConfig || {};
        const dataDir = getDataDir(cfg.orchestratorDataDir);
        const logLevel = cfg.logLevel || "info";
        const logRetention = cfg.logRetentionDays || 30;
        const logger = new OrchestratorLogger(dataDir, logLevel, logRetention);
        for (const sub of ["logs", "sessions", "adrs", "projects"]) {
            const p = path.join(dataDir, sub);
            if (!fs.existsSync(p)) {
                fs.mkdirSync(p, { recursive: true });
                logger.info("boot", `Created dir: ${sub}`);
            }
        }
        // ═══════════════════════════════════════════════════════════
        //  FIRST-RUN ONBOARDING
        // ═══════════════════════════════════════════════════════════
        // On first load, run all initialization tasks:
        //   1. Ensure all data directories exist
        //   2. Auto-populate model inventory from gateway config
        //   3. Create default dashboard-config.json if missing
        //   4. Create STATE.md for any existing project dirs that lack one
        //   5. Run orchestrator_doctor checks to surface issues early
        //   6. Write .FIRST_RUN marker so this only runs once
        const firstRunMarker = path.join(dataDir, ".FIRST_RUN");
        if (!fs.existsSync(firstRunMarker)) {
            logger.info("boot", "═══════════ First run detected — running onboarding... ═══════════");
            // Auto-populate model inventory
            try {
                const modelsPath = path.join(dataDir, "models.json");
                if (!fs.existsSync(modelsPath)) {
                    autoPopulate(dataDir, logger);
                    logger.info("boot", "First-run: models auto-populated");
                }
            }
            catch (e) {
                logger.warn("boot", `First-run: model population skipped — ${e.message}`);
            }
            // Create default dashboard config if missing
            try {
                const configPath = path.join(dataDir, "dashboard-config.json");
                if (!fs.existsSync(configPath)) {
                    writeJSON(configPath, {
                        dashboard: { title: "Orchestrator Dashboard", refreshInterval: 5000, theme: "dark" },
                        projects: {},
                    });
                    logger.info("boot", "First-run: default dashboard config created");
                }
            }
            catch (e) {
                logger.warn("boot", `First-run: dashboard config creation skipped — ${e.message}`);
            }
            // Create STATE.md for any orphaned project dirs
            try {
                const projectsDir = path.join(dataDir, "projects");
                if (fs.existsSync(projectsDir)) {
                    for (const e of fs.readdirSync(projectsDir)) {
                        const pp = path.join(projectsDir, e);
                        if (!fs.statSync(pp).isDirectory() || e.startsWith("."))
                            continue;
                        const statePath = path.join(pp, "STATE.md");
                        if (!fs.existsSync(statePath)) {
                            const sf = path.join(pp, "sessions.json");
                            let sessCount = 0;
                            if (fs.existsSync(sf)) {
                                try {
                                    const d = JSON.parse(fs.readFileSync(sf, "utf-8"));
                                    sessCount = (Array.isArray(d) ? d : (d.sessions || [])).length;
                                }
                                catch { /* */ }
                            }
                            const loc = getProjectLocation(e, dataDir);
                            const repoNote = loc ? `**Location:** \`${loc}\`` : "*(not configured — run orchestrator_sync_project)";
                            const stateContent = [
                                `# STATE: ${e} — v0.0.0`,
                                "",
                                "## Auto-Initialized",
                                "",
                                `Created automatically during first-run onboarding. Update this file as the project evolves.`,
                                "",
                                `**Sessions logged:** ${sessCount}`,
                                repoNote,
                                "",
                                "## Quick Start",
                                "",
                                "1. Install the plugin in OpenClaw plugins config",
                                "2. Ensure 'orchestratorDataDir' points here",
                                "3. Call `orchestrator_register` to opt in",
                                "4. Call `orchestrator_set_context` to start work",
                                "5. Log sessions via `orchestrator_log_session`",
                            ].join("\n");
                            fs.writeFileSync(statePath, stateContent, "utf-8");
                            logger.info("boot", `First-run: created STATE.md for project "${e}"`);
                        }
                    }
                }
            }
            catch (e) {
                logger.warn("boot", `First-run: STATE.md creation skipped — ${e.message}`);
            }
            fs.writeFileSync(firstRunMarker, new Date().toISOString(), "utf-8");
            logger.info("boot", `═══════════ First-run onboarding complete ═══════════`);
        }
        // Schedule nightly model population
        try {
            const scriptDir = path.join(PLUGIN_ROOT, "scripts", "auto-populate-models.py");
            if (fs.existsSync(scriptDir)) {
                const cronCmd = `python3 "${scriptDir}" 2>&1 >> "${path.join(dataDir, "logs", "auto-populate.log")}"`;
                const existing = execSync("crontab -l 2>/dev/null || true", { encoding: "utf-8", timeout: 5000 });
                if (!existing.includes("auto-populate-models.py")) {
                    execSync(`(crontab -l 2>/dev/null; echo "0 3 * * * ${cronCmd} # genor-orchestrator auto-populate") | crontab -`, { timeout: 5000 });
                    logger.info("boot", "Scheduled nightly model population (3 AM)");
                }
            }
        }
        catch {
            logger.debug("boot", "Cron scheduling skipped (no crontab access)");
        }
        logger.info("plugin", "Plugin loaded", { dataDir, logLevel, logRetention });
        // ═══════════════════════════════════════════════════════════
        //  HOOKS
        // ═══════════════════════════════════════════════════════════
        api.on("session_start", async (event) => {
            try {
                const sk = (event.sessionKey || "").toString();
                // Filter out background/dreaming/cron/subagent/acp sessions — their
                // session keys would overwrite the interactive session key and cause
                // mismatched session_key in auto-logged entries.
                const isBackground = sk.includes("dreaming") || sk.includes(":cron:") || sk.includes(":subagent:") || sk.includes(":acp:");
                if (isBackground) {
                    logger.debug("hooks", `session_start (skipped background): ${sk}`);
                    return;
                }
                // ═══ SESSION ISOLATION: Don't reset tracker for unregistered sessions ═══
                // Calling start() on an unregistered session would nuke the registered
                // session's context (project, task, model) from the singleton tracker.
                // Only start() if this session is explicitly registered, or if there
                // are ZERO registered sessions (first-time setup).
                const hasRegisteredSessions = sessionTracker.getRegisteredSessions().length > 0;
                if (sessionTracker.isSessionRegistered(sk) || !hasRegisteredSessions) {
                    sessionTracker.start(sk || "unknown", event.reason || "new");
                }
                else {
                    // Unregistered session starting alongside an active registered session.
                    // Don't touch the tracker state — just log it.
                    sessionTracker.trackAction("session_started");
                    logger.debug("hooks", `session_start (unregistered, skipped tracker reset): ${sk}`);
                }
                // ═══ AUTO-REGISTER PROJECT SESSIONS spawned from dashboard ═══
                // When the dashboard's handleSpawnProjectSession spawns a session, it
                // writes a pending-project-sessions.json entry BEFORE calling
                // subagent.run(). This hook picks it up and auto-registers + sets
                // project context — so the spawned agent starts ready to work.
                try {
                    const pendingPath = path.join(dataDir, "pending-project-sessions.json");
                    if (fs.existsSync(pendingPath)) {
                        const pending = JSON.parse(fs.readFileSync(pendingPath, "utf-8"));
                        const entry = pending[sk];
                        if (entry) {
                            // MUST call start() FIRST to set sessionTracker.sessionKey, otherwise
                            // registerSession/setContext will bind to the old session's key.
                            sessionTracker.start(sk || "unknown", "project-session-auto-register");
                            sessionTracker.registerSession(sk);
                            sessionTracker.setContext(entry.project, entry.task);
                            delete pending[sk];
                            // Clean up: remove file if empty, otherwise update
                            if (Object.keys(pending).length === 0) {
                                try {
                                    fs.unlinkSync(pendingPath);
                                }
                                catch { /* */ }
                            }
                            else {
                                fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2));
                            }
                            logger.info("hooks", `Auto-registered project session: ${sk} → ${entry.project}/${entry.task}`);
                        }
                    }
                }
                catch (e) {
                    logger.warn("hooks", `Pending project-session auto-register failed: ${e.message}`);
                }
                sessionTracker.trackAction("session_started");
                writeLiveAgents("session_start", sessionTracker, logger);
                logger.debug("hooks", `session_start: ${event.reason} key=${sk}`);
            }
            catch (err) {
                logger.error("hooks", `session_start error: ${err.message}`);
            }
        });
        api.on("session_end", async (event) => {
            try {
                const sk_end = (event.sessionKey || "").toString();
                // ═══ SCOPE: Only process registered sessions ═══
                // Plugin is invisible to unregistered sessions.
                // Skip all logging, auto-commit, and file writes.
                if (!sk_end || !sessionTracker.isSessionRegistered(sk_end)) {
                    // Still clean up if somehow registered
                    if (sk_end)
                        sessionTracker.unregisterSession(sk_end);
                    return;
                }
                // Clean up per-session project context
                if (sk_end)
                    sessionTracker.unregisterSession(sk_end);
                // Detect if this is a subagent session ending
                const subInfo = sk_end ? sessionTracker.getSubagent(sk_end) : undefined;
                const isSubagent = !!subInfo;
                const isMain = sk_end && sk_end === sessionTracker.sessionKey;
                if (isMain) {
                    sessionTracker.setStatus("complete");
                    sessionTracker.trackAction("session_ending");
                    writeLiveAgents("session_end", sessionTracker, logger);
                }
                const info = sessionTracker.end();
                if (info && (isMain || isSubagent)) {
                    // Check if workflow enforcement needs auto-commit
                    if (sessionTracker.workflow.enabled && sessionTracker.workflow.autoCommit && info.project) {
                        try {
                            const loc = getProjectLocation(info.project, dataDir);
                            if (loc && fs.existsSync(path.join(loc, ".git"))) {
                                // Non-blocking: spawn async child process for git operations
                                const doAutoCommit = () => {
                                    try {
                                        const statusRaw = execSync("git status --porcelain", { cwd: loc, encoding: "utf-8", timeout: 10000 });
                                        const changed = statusRaw.trim().split("\n").filter(Boolean);
                                        if (changed.length === 0)
                                            return;
                                        // Bump patch version
                                        let version = "0.0.0";
                                        const pj = path.join(loc, "package.json");
                                        if (fs.existsSync(pj)) {
                                            try {
                                                version = JSON.parse(fs.readFileSync(pj, "utf-8")).version || "0.0.0";
                                            }
                                            catch { }
                                        }
                                        const parts = version.split(".").map(Number);
                                        parts[2] = (parts[2] || 0) + 1;
                                        const newVersion = parts.join(".");
                                        if (fs.existsSync(pj)) {
                                            const pkg = JSON.parse(fs.readFileSync(pj, "utf-8"));
                                            pkg.version = newVersion;
                                            fs.writeFileSync(pj, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
                                        }
                                        // Use spawn for async git operations to avoid blocking event loop
                                        const child = spawn("git", ["add", "-A"], { cwd: loc, stdio: "ignore" });
                                        child.on("close", (code) => {
                                            if (code !== 0)
                                                return;
                                            const child2 = spawn("git", ["commit", "-m", `v${newVersion}: session ${info.task} [auto-commit]`], { cwd: loc, stdio: "ignore" });
                                            child2.on("close", (code2) => {
                                                if (code2 !== 0)
                                                    return;
                                                spawn("git", ["tag", `v${newVersion}`], { cwd: loc, stdio: "ignore" });
                                                spawn("git", ["push", "--tags"], { cwd: loc, stdio: "ignore" });
                                                logger.info("hooks", `Auto-committed v${newVersion} for ${info.project}`);
                                            });
                                        });
                                    }
                                    catch (e) {
                                        logger.warn("hooks", `Auto-commit status check failed: ${e.message}`);
                                    }
                                };
                                doAutoCommit();
                            }
                        }
                        catch (e) {
                            logger.warn("hooks", `Auto-commit failed: ${e.message}`);
                        }
                    }
                    logSession(dataDir, {
                        project: info.project, task: info.task, model: info.model,
                        agent: sessionTracker.currentAgent || "system",
                        status: event.reason === "shutdown" ? "interrupted" : event.reason === "error" ? "failed" : "complete",
                        duration: info.duration,
                        session_key: sk_end || sessionTracker.sessionKey || "",
                        parent_session_key: isSubagent && subInfo ? subInfo.parentKey || null : (sk_end && sk_end !== sessionTracker.sessionKey ? sessionTracker.sessionKey || null : null),
                        goal: info.task,
                        notes: `Completed: ${info.task} | Agent: ${sessionTracker.currentAgent || "?"} | Status: ${event.reason} | Workflow: ${sessionTracker.workflow.enabled ? sessionTracker.workflow.currentPhase : "OFF"}`,
                    }, logger);
                    generateRecoveryDoc(info.project, dataDir, logger);
                    // ═══ AUTO-Q&A ═══
                    // After a completed session, run inline verification checks.
                    if (info && info.project && event.reason !== "error" && event.reason !== "shutdown") {
                        const qaLoc = getProjectLocation(info.project, dataDir);
                        if (qaLoc) {
                            try {
                                const qaReportPath = path.join(projDir(info.project, dataDir), "QA_REPORT.md");
                                let qaLines = [
                                    `# QA Report: ${info.project}/${info.task || "unknown"}`,
                                    `*Generated: ${new Date().toISOString()}*`,
                                    ``,
                                    `## Checks`,
                                ];
                                // Check 1: git status
                                try {
                                    const gitStatus = execSync("git status --porcelain 2>/dev/null || echo 'NOT_A_GIT_REPO'", { cwd: qaLoc, encoding: "utf-8", timeout: 5000 }).trim();
                                    if (gitStatus === "NOT_A_GIT_REPO") {
                                        qaLines.push(`- ❓ **Git**: Not a git repository`);
                                    }
                                    else if (gitStatus) {
                                        const files = gitStatus.split("\n").length;
                                        qaLines.push(`- ⚠️ **Git**: ${files} uncommitted file(s)`);
                                        qaLines.push(`  \`\`\`\n  ${gitStatus.slice(0, 500)}\n  \`\`\``);
                                    }
                                    else {
                                        qaLines.push(`- ✅ **Git**: Clean working tree`);
                                    }
                                }
                                catch (e) {
                                    qaLines.push(`- ❓ **Git**: Check failed — ${e.message}`);
                                }
                                // Check 2: npm run build (if package.json exists)
                                try {
                                    if (fs.existsSync(path.join(qaLoc, "package.json"))) {
                                        const buildOut = execSync("npm run build 2>&1 || true", { cwd: qaLoc, encoding: "utf-8", timeout: 30000 }).trim();
                                        const lastLine = buildOut.split("\n").pop() || "";
                                        if (lastLine.includes("error") || lastLine.includes("Error") || lastLine.includes("Failed")) {
                                            qaLines.push(`- ❌ **Build**: Failed — ${lastLine.slice(0, 200)}`);
                                            qaLines.push(`  <details><summary>Full output</summary>\n  \`\`\`\n  ${buildOut.slice(0, 1000)}\n  \`\`\`\n  </details>`);
                                        }
                                        else {
                                            qaLines.push(`- ✅ **Build**: Passed`);
                                        }
                                    }
                                }
                                catch {
                                    qaLines.push(`- ❓ **Build**: Skipped (no package.json or build script)`);
                                }
                                qaLines.push(``, `## Summary`, `- **Project**: ${info.project}`, `- **Task**: ${info.task}`, `- **Duration**: ${info.duration || "N/A"}`, `- **QA Timestamp**: ${new Date().toISOString()}`);
                                fs.writeFileSync(qaReportPath, qaLines.join("\n"), "utf-8");
                                logger.info("qa", `QA report written for ${info.project}/${info.task}`);
                            }
                            catch (e) {
                                logOrchestratorError(info.project, dataDir, {
                                    phase: "log",
                                    step: "auto_qa",
                                    error: e.message,
                                    action_taken: "QA report generation failed — continuing without it",
                                });
                                logger.warn("hooks", `Auto-QA failed: ${e.message}`);
                            }
                        }
                    }
                    sessionTracker.currentAction = "session_complete";
                    writeLiveAgents("session_complete", sessionTracker, logger);
                    logger.info("hooks", `Session auto-logged: ${info.project}/${info.task} (${info.duration})`);
                }
                logger.debug("hooks", `session_end: ${event.reason}`);
            }
            catch (err) {
                if (sessionTracker.currentProject) {
                    logOrchestratorError(sessionTracker.currentProject, dataDir, {
                        phase: "log",
                        step: "session_end",
                        error: err.message,
                        action_taken: "Session end handling failed — recovery doc may not have been generated",
                    });
                }
                logger.error("hooks", `session_end error: ${err.message}`);
            }
        });
        api.on("subagent_spawned", async (event) => {
            // ═══ SCOPE: Only track registered parent sessions ═══
            if (!sessionTracker.sessionKey || !sessionTracker.isSessionRegistered(sessionTracker.sessionKey))
                return;
            const subKey = (event?.sessionKey || event?.subagentKey || "").toString();
            sessionTracker.subagentDepth++;
            sessionTracker.setStatus("working");
            if (sessionTracker.currentProject) {
                logger.debug("subagent", `Depth ${sessionTracker.subagentDepth} for ${sessionTracker.currentProject} key=${subKey}`);
            }
            // Track subagent session info for accurate logging later
            if (subKey) {
                sessionTracker.trackSubagent(subKey, {
                    parentKey: sessionTracker.sessionKey,
                    project: sessionTracker.currentProject,
                    task: sessionTracker.currentTask,
                    startedAt: new Date().toISOString(),
                });
            }
            writeLiveAgents("subagent_spawned", sessionTracker, logger);
        });
        api.on("subagent_ended", async (event) => {
            // ═══ SCOPE: Only track registered parent sessions ═══
            if (!sessionTracker.sessionKey || !sessionTracker.isSessionRegistered(sessionTracker.sessionKey))
                return;
            const subKey = (event?.sessionKey || event?.subagentKey || "").toString();
            sessionTracker.subagentDepth = Math.max(0, sessionTracker.subagentDepth - 1);
            if (subKey)
                sessionTracker.untrackSubagent(subKey);
            if (sessionTracker.currentProject) {
                writeLiveAgents("subagent_ended", sessionTracker, logger);
            }
        });
        api.on("before_model_resolve", async (event, hookCtx) => {
            try {
                const ctxSessionKey = hookCtx?.sessionKey || "";
                // ═══ SCOPE: Skip routing for unregistered sessions ═══
                // But still let bridge logic run for synthetic-to-real key migration
                const isUnregistered = !ctxSessionKey || !sessionTracker.isSessionRegistered(ctxSessionKey);
                const allRegistered = sessionTracker.getRegisteredSessions();
                const hasSynthetic = allRegistered.some(k => k.startsWith("agent:main:auto:"));
                // If this session isn't registered AND there are no synthetic keys to bridge,
                // skip all the heavy logic
                if (isUnregistered && !hasSynthetic) {
                    return;
                }
                // ═══ SESSION ISOLATION: Resolve session key from hook context NOT tracker singleton ═══
                // The hookCtx.sessionKey is the REAL gateway-provided key for THIS session.
                // sessionTracker.sessionKey is a singleton and may have been overwritten by
                // another session's hooks. Always use ctxSessionKey for lookups.
                //
                // Bridge synthetic fallback keys (from orchestrator_register) with the real
                // key so before_prompt_build injection works. CRITICAL: Only bridge from
                // synthetic fallback keys (agent:main:auto:...) to real keys. NEVER bridge
                // from one real key to another — that would cross-contaminate sessions.
                if (ctxSessionKey) {
                    const isBackground = ctxSessionKey.includes("dreaming") || ctxSessionKey.includes(":cron:") || ctxSessionKey.includes(":subagent:") || ctxSessionKey.includes(":acp:");
                    if (!isBackground) {
                        // ── Synthetic-to-real bridge ──
                        // If the tracker was given a synthetic fallback key (agent:main:auto:...)
                        // by a prior tool call, bridge it to the real gateway key now.
                        const regSk = sessionTracker.sessionKey;
                        const isSyntheticToReal = regSk && regSk !== ctxSessionKey && regSk.startsWith("agent:main:auto:");
                        if (isSyntheticToReal) {
                            sessionTracker.registerSession(ctxSessionKey);
                            const existingCtx = sessionTracker.getSessionContext(regSk);
                            if (existingCtx) {
                                const { project, task } = existingCtx;
                                sessionTracker.sessionKey = ctxSessionKey;
                                sessionTracker.setContext(project, task || "");
                                sessionTracker.setStatus("prompting");
                            }
                            logger.info("hooks", `before_model_resolve: bridged synthetic→real: ${regSk} → ${ctxSessionKey}`);
                        }
                        // ── Session-scoped primary key adoption ──
                        // ONLY set sessionTracker.sessionKey and start() for the session that
                        // is actually registered. If a different session's hooks fire here,
                        // don't overwrite the tracker — use ctxSessionKey locally instead.
                        const isRegisteredForThisSession = sessionTracker.isSessionRegistered(ctxSessionKey);
                        if (isRegisteredForThisSession) {
                            if (!sessionTracker.sessionKey || sessionTracker.sessionKey !== ctxSessionKey) {
                                sessionTracker.start(ctxSessionKey, "resumed");
                            }
                            logger.info("hooks", "before_model_resolve: active key=" + ctxSessionKey);
                        }
                        else {
                            // Unregistered session — still update status but don't pollute tracker key
                            logger.debug("hooks", `before_model_resolve: skippping tracker adoption for unregistered session: ${ctxSessionKey}`);
                        }
                    }
                }
                // Always update status but scope to the actual hook session
                sessionTracker.setStatus("resolving");
                sessionTracker.trackAction("resolving_model");
                writeLiveAgents("before_model_resolve", sessionTracker, logger);
                // ═══ SESSION-GATED: Only resolve models for the registered session ═══
                // Don't enter model resolution if this session isn't registered.
                if (!ctxSessionKey || !sessionTracker.isSessionRegistered(ctxSessionKey)) {
                    return;
                }
                if (!sessionTracker.currentProject)
                    return;
                const md = readJSON(path.join(dataDir, "models.json"));
                const allModels = md?.models || [];
                const cfg2 = readJSON(path.join(dataDir, "dashboard-config.json")) || {};
                const pc = cfg2.projects?.[sessionTracker.currentProject];
                // ── Resolve routing preset ──
                const routingPreset = pc?.routing_preset || "custom";
                // Preset: "no-steering" — skip entirely, let OpenClaw's default resolution run
                if (routingPreset === "no-steering") {
                    logger.debug("routing", `no-steering preset for ${sessionTracker.currentProject} — skipping model override`);
                    sessionTracker.trackModel(event?.resolvedModel || "default", "default", 0);
                    return;
                }
                let eligible = [...allModels];
                const filters = [];
                const globalDisabled = cfg2.disabled_models || [];
                // ── Preset: "free-only" — force free models ──
                if (routingPreset === "free-only") {
                    eligible = eligible.filter(m => !isPaid(m));
                    filters.push("preset_free_only");
                }
                // ── Preset: "single-provider" — filter to one provider ──
                const singleProvider = pc?.routing_single_provider;
                if (routingPreset === "single-provider" && singleProvider) {
                    eligible = eligible.filter(m => m.provider === singleProvider);
                    filters.push(`preset_single_provider:${singleProvider}`);
                }
                // ── Global & project filters (apply to all presets except no-steering) ──
                if (globalDisabled.length) {
                    eligible = eligible.filter(m => !globalDisabled.includes(m.id));
                    filters.push("global_disabled");
                }
                if (cfg2.free_only_mode || (pc?.free_only && routingPreset !== "free-only")) {
                    eligible = eligible.filter(m => !isPaid(m));
                    filters.push(cfg2.free_only_mode ? "global_free_only" : "project_free_only");
                }
                if (pc) {
                    if (pc.model_allowlist?.length) {
                        eligible = eligible.filter(m => pc.model_allowlist.includes(m.id));
                        filters.push("project_allowlist");
                    }
                }
                // ── Preset: "custom" or "custom-fallbacks-only" — try model_routing chains ──
                // Determine the task category (infer from task name when possible)
                const ctx2 = sessionTracker.getSessionContext(ctxSessionKey);
                const taskStr = ctx2?.task || "";
                const taskLower = taskStr.toLowerCase();
                let taskCategory = "coding"; // default
                if (taskLower.includes("fix") || taskLower.includes("bug") || taskLower.includes("error") || taskLower.includes("broken"))
                    taskCategory = "fixing";
                else if (taskLower.includes("research") || taskLower.includes("investigat") || taskLower.includes("explore") || taskLower.includes("learn") || taskLower.includes("find out"))
                    taskCategory = "research";
                else if (taskLower.includes("q&a") || taskLower.includes("question") || taskLower.includes("answer") || taskLower.includes("what is") || taskLower.includes("how do"))
                    taskCategory = "qa";
                else if (taskLower.includes("doc") || taskLower.includes("readme") || taskLower.includes("adr") || taskLower.includes("manual") || taskLower.includes("write up"))
                    taskCategory = "documentation";
                const modelRouting = pc?.model_routing || {};
                const chain = modelRouting[taskCategory];
                if (chain && Array.isArray(chain) && chain.length > 0) {
                    // Try models in chain order until we find an active one
                    let selected = null;
                    for (const chainModelId of chain) {
                        // Expand known shorthand prefixes
                        const expandedId = chainModelId.startsWith("openrouter/")
                            ? chainModelId
                            : chainModelId.startsWith("opencode-go/")
                                ? chainModelId
                                : !chainModelId.includes("/")
                                    ? `openrouter/${chainModelId}` // bare name → openrouter namespace
                                    : chainModelId;
                        const found = eligible.find(m => m.id === expandedId || m.id === chainModelId);
                        if (found && found.agent_ready !== false && found.status === "active") {
                            selected = found;
                            break;
                        }
                    }
                    if (selected) {
                        sessionTracker.trackModel(selected.id, selected.provider, selected.tier);
                        logger.info("routing", `[${routingPreset}] Routed ${sessionTracker.currentProject}/${taskCategory} → ${selected.id} (${selected.provider})`);
                        // For custom-fallbacks-only: still let OpenClaw resolve primary,
                        // but set modelOverride so it uses our chain if primary resolution fails
                        if (routingPreset === "custom-fallbacks-only" && event?.resolvedModel && !eligible.find(m => m.id === event.resolvedModel)) {
                            // Primary resolved model is blocked — use fallback
                            return { modelOverride: selected.id };
                        }
                        return { modelOverride: selected.id };
                    }
                    // All chain models unavailable — log warning and fall through to tier-based
                    const chainInfo = chain.map(id => {
                        const m = eligible.find(e => e.id === id);
                        return m ? `${id}(${m.status})` : `${id}(not-found)`;
                    }).join(", ");
                    logger.warn("routing", `Chain for ${taskCategory} unavailable: ${chainInfo} — falling back to tier-based`);
                }
                // ── Fallback: tier-based model selection ──
                if (eligible.length > 0) {
                    const best = eligible
                        .filter(m => m.agent_ready !== false && m.status === "active")
                        .sort((a, b) => (b.tier || 0) - (a.tier || 0))[0];
                    if (best) {
                        sessionTracker.trackModel(best.id, best.provider, best.tier);
                        logger.info("routing", `[tier-fallback] Routed ${sessionTracker.currentProject} → ${best.id} (T${best.tier})`);
                        return { modelOverride: best.id };
                    }
                }
                // ── Last resort: track whatever OpenClaw resolved ──
                if (event?.resolvedModel) {
                    const resolvedInfo = allModels.find((m) => m.id === event.resolvedModel);
                    sessionTracker.trackModel(event.resolvedModel, resolvedInfo?.provider, resolvedInfo?.tier);
                    logger.info("routing", `[pass-through] No eligible models for ${sessionTracker.currentProject}, using resolved: ${event.resolvedModel}`);
                }
            }
            catch (err) {
                logger.error("hooks", `before_model_resolve error: ${err.message}`);
            }
        });
        api.on("before_prompt_build", async (event, hookCtx) => {
            try {
                // ═══ SAVE & RESTORE tracker around spawn drain ═══
                // subagent.run() triggers session_start hook synchronously, which calls
                // sessionTracker.start() on the spawned session — overwriting our current
                // session's sessionKey. We save and restore to prevent tracker corruption.
                // CRITICAL: Only save/restore when there is actually a spawn queue to
                // drain. The restore calls sessionTracker.start() which resets workflow
                // state (phase progress, etc.), so we must avoid it when no draining occurs.
                let _didDrain = false;
                const spawnQueuePath = path.join(dataDir, "pending-spawns.json");
                if (fs.existsSync(spawnQueuePath)) {
                    _didDrain = true;
                    const _savedKey = sessionTracker.sessionKey || "";
                    const _savedCtx = _savedKey ? sessionTracker.getSessionContext(_savedKey) : null;
                    // Save subagent depth so restore doesn't lose it
                    const _savedDepth = sessionTracker.subagentDepth;
                    // Save workflow state (phase history, QA results, handoff status)
                    // so it can be restored after subagent.run() resets the tracker
                    const _savedWorkflow = sessionTracker.workflow.toJSON();
                    const _savedQaStatus = sessionTracker.qaStatus;
                    const _savedQaFindings = [...sessionTracker.qaFindings];
                    const _savedHandoffGenerated = sessionTracker.handoffGenerated;
                    const _savedHandoffPath = sessionTracker.handoffPath;
                    try {
                        let spawnQueue = [];
                        try {
                            spawnQueue = JSON.parse(fs.readFileSync(spawnQueuePath, "utf-8"));
                        }
                        catch { /* */ }
                        while (spawnQueue.length > 0) {
                            const entry = spawnQueue[0];
                            try {
                                const result = await api.runtime.subagent.run({
                                    sessionKey: entry.sessionKey,
                                    message: entry.message,
                                    model: entry.model || undefined,
                                });
                                const pendingPath = path.join(dataDir, "pending-project-sessions.json");
                                let pending = {};
                                try {
                                    if (fs.existsSync(pendingPath)) {
                                        pending = JSON.parse(fs.readFileSync(pendingPath, "utf-8"));
                                    }
                                }
                                catch { /* */ }
                                pending[entry.sessionKey] = { project: entry.project, task: entry.task, spawnedAt: new Date().toISOString() };
                                fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2));
                                logger.info("spawn", `Drained: ${entry.sessionKey.slice(0, 50)} → ${entry.project} (runId: ${result.runId})`);
                                spawnQueue.shift();
                            }
                            catch (e) {
                                logger.warn("spawn", `Spawn drain failed: ${e.message}`);
                                spawnQueue.shift();
                            }
                        }
                        if (spawnQueue.length === 0) {
                            try {
                                fs.unlinkSync(spawnQueuePath);
                            }
                            catch { /* */ }
                        }
                        else {
                            fs.writeFileSync(spawnQueuePath, JSON.stringify(spawnQueue, null, 2));
                        }
                    }
                    finally {
                        // Restore tracker state
                        if (_savedKey) {
                            sessionTracker.start(_savedKey, "restored-from-spawn-drain");
                            if (_savedCtx) {
                                sessionTracker.setContext(_savedCtx.project, _savedCtx.task || "", _savedCtx.workflowConfig);
                            }
                            // Restore subagent depth (lost by sessionTracker.start())
                            sessionTracker.subagentDepth = _savedDepth;
                            // Restore workflow state (phase history, QA results, handoff status)
                            // setContext.workflow.reset() already created a fresh WorkflowTracker.
                            // We need to re-apply the saved state on top.
                            if (_savedWorkflow) {
                                const wt = sessionTracker.workflow;
                                wt.currentPhase = _savedWorkflow.current_phase || wt.currentPhase;
                                wt.phaseHistory = _savedWorkflow.phase_history || wt.phaseHistory;
                                wt.currentPhaseStartedAt = Date.now();
                                wt.qaResults = _savedWorkflow.qa_results || [];
                                wt.qaRetries = _savedWorkflow.qa_retries || 0;
                                wt.qaMaxRetries = _savedWorkflow.qa_max_retries || 3;
                                wt.isQARunning = _savedWorkflow.is_qa_running || false;
                                wt.includeQa = _savedWorkflow.include_qa || false;
                                wt.autoCommit = _savedWorkflow.auto_commit || false;
                                wt.skipPhases = _savedWorkflow.skip_phases || [];
                            }
                            // Restore QA gate state
                            sessionTracker.qaStatus = _savedQaStatus;
                            sessionTracker.qaFindings = _savedQaFindings;
                            // Restore handoff state
                            sessionTracker.handoffGenerated = _savedHandoffGenerated;
                            sessionTracker.handoffPath = _savedHandoffPath;
                        }
                    }
                }
                // ═══ SESSION ISOLATION: Use hook context key, NOT tracker singleton ═══
                // sessionTracker.sessionKey is shared across all sessions and may have
                // been set by a different session's hooks. Always use hookCtx.sessionKey.
                const hk = hookCtx?.sessionKey || "";
                sessionTracker.setStatus("prompting");
                sessionTracker.trackAction("building_prompt");
                writeLiveAgents("before_prompt_build", sessionTracker, logger);
                // ═══ NO MUTATION: This hook NEVER modifies sessionTracker.sessionKey ═══
                // Previous code had a "safety net" that mutated sessionTracker.sessionKey
                // when a real key appeared alongside a synthetic fallback. This caused
                // cross-session pollution: if Session A registered with a synthetic key
                // and Session B fired before_prompt_build, Session B's real key would
                // overwrite Session A's registered key+context in the tracker singleton.
                // 
                // The synthetic-to-real bridge now ONLY happens in before_model_resolve,
                // which reliably fires before this hook. If the bridge didn't happen,
                // the registered synthetic key still works correctly for context lookup
                // via isSessionRegistered() + getSessionContext().
                // NEVER use sessionTracker.sessionKey as fallback — it's singletons-tainted.
                // If hk (hook context key) is empty or not registered, NO injection.
                if (!hk)
                    return;
                const sk = hk;
                if (!sessionTracker.isSessionRegistered(sk))
                    return;
                const pc = sessionTracker.getSessionContext(sk);
                if (!pc)
                    return;
                const loc = getProjectLocation(pc.project, dataDir);
                // ═══ ORCHESTRATOR OPERATING CONTEXT (system prompt) ═══
                // This is the first thing injected — concise LLM-facing instructions
                // about how to use the orchestrator naturally.
                let ctx = `## Orchestrator Operating Context
You are working within Genor's Orchestrator plugin. Follow these rules automatically.

`;
                ctx += `**Workflow phases** (advance in order via \`orchestrator_advance_phase\`):
   analyze → plan → document → work → log → finish
`;
                ctx += `**Enforced gates** (code blocks these if violated):
• Must call \`orchestrator_register\` then \`orchestrator_set_context\` before project work
• work→log: BLOCKED until QA approves (run \`orchestrator_qa_submit\` → \`orchestrator_qa_approve\`)\n• log→finish: BLOCKED until \`orchestrator_log_session\` AND \`orchestrator_generate_handoff\` complete
`;
                ctx += `**Model routing**: Orchestrator auto-selects the best model per task category.
  Use \`orchestrator_get_routing\` to see recommendations. Don't override unless necessary.
`;
                ctx += `**Phase tools**:
  • Analyze: study context, output findings
  • Plan: create step-by-step plan, ADR (\`orchestrator_log_decision\`)
  • Document: \`orchestrator_log_decision\` for architecture decisions
  • Work: implement, then submit QA if enabled
  • Log: \`orchestrator_log_session\` with status=complete
  • Finish: \`orchestrator_generate_handoff\` before advancing

`;
                let pcl = `⚡ Project: ${pc.project}`;
                if (pc.task)
                    pcl += ` | Task: ${pc.task}`;
                pcl += `\nLocation: ${loc || "not set"}`;
                pcl += ` | Sub-agents: ${sessionTracker.subagentDepth}`;
                pcl += ` | Data: orchestrator-data/projects/${pc.project}/`;
                ctx += pcl;
                // ═══ PHASE ENFORCEMENT ═══
                // Inject current workflow phase instructions so the AI knows what phase
                // it's in and what to do.
                if (sk && sessionTracker.isSessionRegistered(sk) && pc && sessionTracker.workflow.enabled) {
                    const phase = sessionTracker.workflow.currentPhase;
                    const phaseElapsed = sessionTracker.workflow.getPhaseElapsed();
                    const progress = sessionTracker.workflow.getProgress();
                    // Phase timeout config
                    const phaseTimeouts = {
                        analyze: 5 * 60 * 1000,
                        plan: 10 * 60 * 1000,
                        document: 10 * 60 * 1000,
                        work: 30 * 60 * 1000,
                        log: 5 * 60 * 1000,
                        finish: 2 * 60 * 1000,
                    };
                    const phaseInstructions = {
                        analyze: "🔍 PHASE: ANALYZE — Study the request and project context. Output findings, questions, and scope. Do NOT write code yet. Call orchestrator_advance_phase when analysis is complete.",
                        plan: "📋 PHASE: PLAN — Create a step-by-step plan. List files to change, approach, risks, and dependencies. Do NOT code yet. Call orchestrator_advance_phase when plan is approved.",
                        document: "📝 PHASE: DOCUMENT — Write an ADR (orchestrator_log_decision) or design doc covering the architecture, trade-offs, and key decisions. Call orchestrator_advance_phase when design is documented.",
                        work: `⚡ PHASE: IMPLEMENT — Execute the plan. Write code. Make changes.${sessionTracker.workflow.includeQa ? " After implementation, submit for QA review with orchestrator_qa_submit (enforced: auto-spawns an independent QA review subagent). The work→log transition is BLOCKED until QA approves." : ""} Call orchestrator_advance_phase when implementation is complete.`,
                        log: "📊 PHASE: LOG — Log the session via orchestrator_log_session with status=complete. Include a summary of what was done, decisions made, and next steps. After logging, generate a handoff document with orchestrator_generate_handoff (REQUIRED before finish). Then call orchestrator_advance_phase. (Docs are auto-synced when advancing to finish.)",
                        finish: "✅ PHASE: FINISH — All phases complete. Verifying git status and ensuring everything is committed.",
                    };
                    // Check for phase timeout
                    const phaseStarted = sessionTracker.workflow.currentPhaseStartedAt;
                    const timeout = phaseTimeouts[phase] || 30 * 60 * 1000;
                    const isTimedOut = (Date.now() - phaseStarted) > timeout;
                    let phaseNote = phaseInstructions[phase] || `Phase: ${phase}`;
                    if (isTimedOut) {
                        phaseNote += `\n⚠️ This phase has exceeded its time limit (${Math.floor(timeout / 60000)}min). Auto-advancing is recommended.`;
                    }
                    ctx += `\n━━━ WORKFLOW ━━━\n${phaseNote}\nProgress: ${progress} phases complete\nElapsed: ${phaseElapsed}\n━━━━━━━━━━━━━`;
                    // ═══ QA STATUS INJECTION ═══
                    if (sessionTracker.workflow.includeQa) {
                        ctx += `\n📋 QA STATUS: ${sessionTracker.getQaSummary()}`;
                        if (sessionTracker.qaFindings.length > 0) {
                            ctx += `\n📎 Findings (${sessionTracker.qaFindings.length}):`;
                            for (const f of sessionTracker.qaFindings.slice(-3)) {
                                ctx += `\n  • ${f.finding.substring(0, 200)}`;
                            }
                        }
                    }
                    // ═══ HANDOFF STATUS ═══
                    if (sessionTracker.handoffGenerated) {
                        ctx += `\n📄 Handoff: ✅ Generated (${sessionTracker.handoffPath || "unknown"})`;
                    }
                    else if (phase === "log" || phase === "finish") {
                        ctx += `\n📄 Handoff: ❌ Not generated — run orchestrator_generate_handoff`;
                    }
                }
                return { prependContext: ctx };
            }
            catch { /* */ }
        });
        api.on("agent_end", async () => {
            sessionTracker.trackAction("agent_stopped");
            writeLiveAgents("agent_end", sessionTracker, logger);
            // ═══ AUTO-LOG UNREPORTED TASKS ═══
            // If the session has active project context but never logged completion,
            // auto-generate a log entry so the work isn't lost entirely.
            if (sessionTracker.currentProject && !sessionTracker.loggedTaskCompletion) {
                try {
                    logSession(dataDir, {
                        project: sessionTracker.currentProject,
                        task: sessionTracker.currentTask || "auto-task",
                        model: sessionTracker.currentModel || "unknown",
                        agent: sessionTracker.currentAgent || "system",
                        status: "interrupted",
                        duration: "",
                        session_key: sessionTracker.sessionKey || "",
                        notes: `⚠️ Auto-logged at agent_end — session ended without explicit completion log.\nTask: ${sessionTracker.currentTask || "N/A"}`,
                    }, logger);
                    sessionTracker.markLoggedCompletion();
                    logger.info("hooks", `Auto-logged uncompleted task for ${sessionTracker.currentProject}`);
                }
                catch (e) {
                    logger.warn("hooks", `Auto-log failed: ${e.message}`);
                }
            }
            // ═══ PHASE TIMEOUT ENFORCEMENT ═══
            if (sessionTracker.workflow.enabled && sessionTracker.currentProject) {
                const phase = sessionTracker.workflow.currentPhase;
                const phaseTimeouts = {
                    analyze: 5 * 60 * 1000,
                    plan: 10 * 60 * 1000,
                    document: 10 * 60 * 1000,
                    work: 30 * 60 * 1000,
                    log: 5 * 60 * 1000,
                    finish: 2 * 60 * 1000,
                };
                const timeout = phaseTimeouts[phase] || 30 * 60 * 1000;
                if ((Date.now() - sessionTracker.workflow.currentPhaseStartedAt) > timeout) {
                    try {
                        const next = sessionTracker.workflow.advance();
                        if (next) {
                            logger.warn("workflow", `Phase "${phase}" timed out — auto-advanced to "${next}"`);
                        }
                    }
                    catch (e) {
                        logger.warn("workflow", `Phase timeout advance failed: ${e.message}`);
                    }
                }
            }
            logger.debug("hooks", `agent_end for ${sessionTracker.currentProject || "no-project"}`);
        });
        api.on("gateway_stop", async () => {
            sessionTracker.setStatus("shutdown");
            maintenanceSvc?.stop();
            logger.stop();
        });
        // ═══════════════════════════════════════════════════════════
        //  TOOLS
        // ═══════════════════════════════════════════════════════════
        api.registerTool({
            name: "orchestrator_set_context",
            label: "Orchestrator Set Context",
            description: "MANDATORY before starting project work. Sets active project and task context, enabling auto-routing, auto-logging, and context injection.",
            parameters: Type.Object({
                project: Type.String({ description: "Project name (e.g., kfinance, kotw)." }),
                task: Type.String({ description: "Describe the task you are about to do, as a concise bullet list. Format:\n• What needs to be done\n• Why (context / motivation)\n• Scope (what files or systems are involved)\nExample: 'Add delete-story MCP tool to story-vault server. Currently story-vault has create/list/get but no delete. Requires: new delete_story tool in mcp_server.py, rebuild and restart gateway.'" }),
                original_prompt: Type.Optional(Type.String({ description: "OPTIONAL: The original user request that triggered this task. Captured in the session log for traceability — so we can see WHY the work was started, not just WHAT was done. Recommended: include the user's full request verbatim. Truncated to 500 chars." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                try {
                    return txt(setContext(dataDir, params.project, params.task, logger, params.original_prompt));
                }
                catch (err) {
                    return txt({ ok: false, error: err.message });
                }
            },
        });
        api.registerTool({
            name: "orchestrator_clear_context",
            label: "Orchestrator Clear Context",
            description: "Clear active project context. Disables auto-routing and auto-logging.",
            parameters: Type.Object({}),
            async execute(_id, _params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                return txt(clearContextFn(dataDir, logger));
            },
        });
        api.registerTool({
            name: "orchestrator_register",
            label: "Orchestrator Register",
            description: "Register this session for orchestrator tracking. Must be called BEFORE orchestrator_set_context. Once registered, the orchestrator tracks the session lifecycle (start → context → work → end) and injects project context into prompts. Only call this when you intend to do project work in this session.",
            parameters: Type.Object({}),
            async execute(_id, _params) {
                // Resolve the session key: prefer the hook-populated key, fall back
                // to a synthetic stable key derived from agent identity + timestamp.
                // session_start may not fire for sessions that existed before a
                // gateway restart, so we can't depend on it for existing sessions.
                const sk = sessionTracker.sessionKey || agentDefaultSessionKey();
                if (!sk)
                    return txt("error: no session key available");
                // ═══ REGISTRATION GUARD: Detect stray/hallucinated registrations ═══
                // If this session key doesn't match tracker's current key and there's
                // already an active registration with a different project context,
                // warn prominently to surface unintended LLM tool calls.
                const existingSessions = sessionTracker.getRegisteredSessions();
                const hasActiveRegistration = existingSessions.length > 0 && !existingSessions.includes(sk);
                if (hasActiveRegistration) {
                    const otherCtxs = existingSessions
                        .map(s => ({ key: s, ctx: sessionTracker.getSessionContext(s) }))
                        .filter(s => s.ctx && s.ctx.project);
                    if (otherCtxs.length > 0) {
                        logger.warn("registration", `Session "${sk}" registering while other sessions active: ${otherCtxs.map(s => s.key).join(", ")}. Possible hallucinated registration.`);
                    }
                }
                const newly = sessionTracker.registerSession(sk);
                if (newly) {
                    if (!sessionTracker.sessionKey)
                        sessionTracker.sessionKey = sk;
                    sessionTracker.trackAction("session_registered");
                    writeLiveAgents("register", sessionTracker, logger);
                    logger.info("registration", `session registered: ${sk} (total: ${existingSessions.length + 1})`);
                    // Return descriptive message so LLM + user can see what happened
                    return txt({
                        ok: true,
                        message: "registered",
                        session_key: sk,
                        total_registered: existingSessions.length + 1,
                        warning: hasActiveRegistration ? "Other sessions already registered with different context. Verify this was intentional." : undefined,
                    });
                }
                return txt("already registered");
            },
        });
        api.registerTool({
            name: "orchestrator_unregister",
            label: "Orchestrator Unregister",
            description: "Unregister this session from orchestrator tracking. Clears project context and stops all tracking. The session will no longer receive project context injection. Call this when project work is complete or the session should no longer be tracked.",
            parameters: Type.Object({}),
            async execute(_id, _params) {
                const sk = sessionTracker.sessionKey || agentDefaultSessionKey();
                if (!sk)
                    return txt("error: no session key available");
                // ═══ ENFORCE TASK COMPLETION LOGGING ═══
                if (sessionTracker.currentProject && !sessionTracker.loggedTaskCompletion) {
                    return txt({
                        ok: false,
                        error: `❌ Task not logged. Session has active context on project "${sessionTracker.currentProject}" ` +
                            `but hasn't logged completion. Call orchestrator_log_session with status="complete" first ` +
                            `to document what was done before unregistering.`,
                    });
                }
                sessionTracker.unregisterSession(sk);
                sessionTracker.clearContext();
                sessionTracker.trackAction("session_unregistered");
                writeLiveAgents("unregister", sessionTracker, logger);
                logger.info("hooks", `session unregistered: ${sk}`);
                return txt("unregistered");
            },
        });
        api.registerTool({
            name: "orchestrator_get_status",
            label: "Status",
            description: "Get quick orchestration status: model counts, session count, project list, free-only mode state.",
            parameters: Type.Object({}),
            async execute() {
                return txt(getStatus(dataDir, logger));
            },
        });
        api.registerTool({
            name: "orchestrator_get_config",
            label: "Config",
            description: "Read the full routing configuration: free-only mode, disabled models, per-project allowlists.",
            parameters: Type.Object({}),
            async execute() {
                return txt(getConfig(dataDir, logger));
            },
        });
        api.registerTool({
            name: "orchestrator_get_models",
            label: "Models",
            description: "List models from the model inventory with optional filters (status, provider, search, project routing).",
            parameters: Type.Object({
                status: Type.Optional(Type.String({ description: "Filter by status: active, discovered, offline, removed. Comma-separated." })),
                provider: Type.Optional(Type.String({ description: "Filter by provider name (partial match)." })),
                search: Type.Optional(Type.String({ description: "Search by model ID or name (partial match)." })),
                agent_ready: Type.Optional(Type.Boolean({ description: "Filter by agent_ready flag." })),
                project: Type.Optional(Type.String({ description: "Apply project routing filters to results." })),
            }),
            async execute(_id, params) {
                return txt(getModels(dataDir, params, logger));
            },
        });
        api.registerTool({
            name: "orchestrator_check_models",
            label: "Check Models (routing)",
            description: "Check which models are eligible for a project, applying all routing filters. Typically handled by hooks; use for explicit inspection.",
            parameters: Type.Object({
                project: Type.Optional(Type.String({ description: "Project name for per-project routing rules. Omit for global-only check." })),
            }),
            async execute(_id, params) {
                return txt(checkModels(dataDir, params.project, logger));
            },
        });
        api.registerTool({
            name: "orchestrator_auto_populate",
            label: "Auto-Populate",
            description: "Auto-populate model inventory from OpenClaw gateway config. Merges into orchestrator-data/models.json, preserving manual ratings.",
            parameters: Type.Object({}),
            async execute(_id, _params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                return txt(autoPopulate(dataDir, logger));
            },
        });
        api.registerTool({
            name: "orchestrator_log_session",
            label: "Log Session",
            description: "Log a completed session. Normally handled automatically by hooks; use for manual logging or retroactive entries.",
            parameters: Type.Object({
                project: Type.String({ description: "Project name." }),
                task: Type.String({ description: "Task description — the same concise bullet list used when setting context." }),
                model: Type.String({ description: "Model ID used." }),
                agent: Type.String({ description: "Agent name." }),
                status: Type.String({ description: "Status: complete, blocked, in_progress, failed." }),
                notes: Type.Optional(Type.String({ description: "Write a structured summary of what was done, in this format:\n• **Completed:** bullet list of what was accomplished\n• **Decisions:** key choices made and why\n• **Blockers:** anything that stopped progress (+ why)\n• **Next:** what should be done next" })),
                duration: Type.Optional(Type.String({ description: "Duration (e.g., 30min)." })),
                qa: Type.Optional(Type.Boolean({ description: "QA checked flag." })),
                checked: Type.Optional(Type.Boolean({ description: "Reviewed flag." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                sessionTracker.trackAction(`log: ${params.task}`);
                writeLiveAgents("tool_log_session", sessionTracker, logger);
                // Mark completion logged so clearContext/unregister know work is documented
                const terminal = ["complete", "blocked", "failed", "interrupted"].includes((params.status || "").toLowerCase());
                if (terminal)
                    sessionTracker.markLoggedCompletion();
                // Write state event for this session
                writeStateEvent(params.project, dataDir, {
                    type: "session_logged",
                    status: params.status,
                    model: params.model,
                    task: params.task,
                    agent: params.agent,
                    duration: params.duration,
                });
                return txt(logSession(dataDir, params, logger));
            },
        });
        api.registerTool({
            name: "orchestrator_log_decision",
            label: "Log Decision",
            description: "Log an architecture decision as an auto-numbered ADR file.",
            parameters: Type.Object({
                project: Type.String({ description: "Project name." }),
                title: Type.String({ description: "Decision title." }),
                context: Type.String({ description: "Why this decision was made. Describe the problem, constraints, and trade-offs. Write in 2-3 clear sentences." }),
                decision: Type.String({ description: "What was decided. State the chosen approach clearly: 'We chose X over Y because Z.'" }),
                alternatives: Type.Optional(Type.String({ description: "What else was considered. List briefly: 'Option A (pros/cons), Option B (pros/cons).'" })),
                consequences: Type.Optional(Type.String({ description: "Impact of this decision. Format:\n• **Good:** benefits this unlocks\n• **Risks:** things to watch for\n• **Requires:** follow-up work or migrations needed" })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                return txt(logDecision(dataDir, params, logger));
            },
        });
        api.registerTool({
            name: "orchestrator_get_logs",
            label: "Logs",
            description: "Query orchestration logs: routing decisions, model choices, session activity, config changes.",
            parameters: Type.Object({
                limit: Type.Optional(Type.Number({ description: "Max entries (default: 50)." })),
                level: Type.Optional(Type.String({ description: "Minimum level: debug, info, warn, error." })),
                source: Type.Optional(Type.String({ description: "Filter by source (e.g., routing, session, models)." })),
                since: Type.Optional(Type.String({ description: "ISO timestamp filter." })),
            }),
            async execute(_id, params) {
                return txt(getLogs(dataDir, params, logger));
            },
        });
        api.registerTool({
            name: "orchestrator_sync_project",
            label: "Orchestrator Sync Project",
            description: "Sync a project's files from disk into orchestrator-data. Generates CONTEXT.md, KEY_FILES.md. Requires project location to be configured.",
            parameters: Type.Object({
                project: Type.String({ description: "Project name to sync." }),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                sessionTracker.trackAction(`sync: ${params.project}`);
                writeLiveAgents("tool_sync_project", sessionTracker, logger);
                return txt(syncProject(dataDir, params.project, logger));
            },
        });
        api.registerTool({
            name: "orchestrator_get_project_docs",
            label: "Orchestrator Get Project Docs",
            description: "List all orchestrator-managed documents for a project (CONTEXT.md, STATE.md, ROADMAP.md, RECOVERY.md, sessions.json, BACKLOG.json, etc.)",
            parameters: Type.Object({
                project: Type.String({ description: "Project name." }),
            }),
            async execute(_id, params) {
                return txt(getProjectDocsFn(dataDir, params.project, logger));
            },
        });
        api.registerTool({
            name: "orchestrator_advance_phase",
            label: "Advance Workflow Phase",
            description: "Advance the workflow enforcement to the next phase (Analyze → Plan → Document → Work → Log → Finish). Use this after completing each step of the coding workflow.",
            parameters: Type.Object({
                phase: Type.Optional(Type.String({ description: "Target phase to transition to. Omit to auto-advance to next phase." })),
                skip: Type.Optional(Type.Boolean({ description: "Mark current phase as skipped." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                const wf = sessionTracker.workflow;
                if (!wf.enabled) {
                    return txt({ ok: false, error: "Workflow enforcement is not enabled for this project. Set workflow.enabled in dashboard-config.json" });
                }
                const currentPhase = wf.currentPhase;
                if (params.phase) {
                    // Check transition is valid
                    if (!wf.canTransitionTo(params.phase.toLowerCase())) {
                        return txt({ ok: false, error: `Cannot transition to '${params.phase}' from current phase '${currentPhase}'. Workflow must go forward: ${WORKFLOW_ORDER.join(" → ")}` });
                    }
                    // ═══ QUALITY GATES — Enforced ═══
                    const target = params.phase.toLowerCase();
                    // work → log: QA GATE (when include_qa is enabled)
                    if (currentPhase === "work" && target === "log" && wf.includeQa) {
                        if (!sessionTracker.canAdvanceFromWork()) {
                            const qaStatus = sessionTracker.qaStatus;
                            if (qaStatus === "none") {
                                return txt({ ok: false, error: "QA review required before advancing. Run orchestrator_qa_submit with your findings first.", qa_required: true });
                            }
                            if (qaStatus === "pending") {
                                return txt({ ok: false, error: "QA review is pending approval. A reviewer must call orchestrator_qa_approve or orchestrator_qa_reject.", qa_pending: true });
                            }
                            if (qaStatus === "rejected") {
                                return txt({ ok: false, error: "QA review rejected the previous submission. Fix the reported issues and call orchestrator_qa_submit again.", qa_rejected: true });
                            }
                            return txt({ ok: false, error: "QA gate not passed. Submit findings with orchestrator_qa_submit." });
                        }
                    }
                    // log → finish: HANDOFF GATE
                    if (currentPhase === "log" && target === "finish") {
                        if (!sessionTracker.canFinish()) {
                            return txt({ ok: false, error: "Handoff document required before finishing. Run orchestrator_generate_handoff to create one.", handoff_required: true });
                        }
                        if (!sessionTracker.loggedTaskCompletion) {
                            return txt({ ok: false, error: "Task must be explicitly logged before finishing. Call orchestrator_log_session with status=complete first.", log_required: true });
                        }
                        // Auto-fix docs drift before finalizing
                        tryFixDocsDrift(sessionTracker.currentProject, dataDir, logger);
                    }
                    // work → log: GIT CHECK (soft warning, non-blocking)
                    if (currentPhase === "work" && target === "log") {
                        const project = sessionTracker.currentProject;
                        if (project) {
                            const loc = getProjectLocation(project, dataDir);
                            if (loc && fs.existsSync(path.join(loc, ".git"))) {
                                try {
                                    const statusRaw = execSync("git status --porcelain", { cwd: loc, encoding: "utf-8", timeout: 5000 });
                                    const changed = statusRaw.trim().split("\n").filter(Boolean);
                                    if (changed.length > 0) {
                                        logger.warn("workflow", `${changed.length} uncommitted file(s) before logging phase. Consider committing or stashing first.`);
                                    }
                                }
                                catch { /* git check non-fatal */ }
                            }
                        }
                    }
                    // document → work: ADR CHECK (soft warning, non-blocking)
                    if (currentPhase === "document" && target === "work") {
                        const project = sessionTracker.currentProject;
                        if (project) {
                            const adrsDir = path.join(dataDir, "adrs");
                            let adrCount = 0;
                            if (fs.existsSync(adrsDir)) {
                                adrCount = fs.readdirSync(adrsDir).filter(f => f.endsWith(".md") && f.includes(project.replace(/[^a-zA-Z0-9_-]/g, "-"))).length;
                            }
                            if (adrCount === 0) {
                                const projAdrsDir2 = path.join(projDir(project, dataDir), "adrs");
                                if (fs.existsSync(projAdrsDir2)) {
                                    adrCount = fs.readdirSync(projAdrsDir2).filter(f => f.endsWith(".md")).length;
                                }
                            }
                            if (adrCount === 0) {
                                logger.warn("workflow", "No ADR found. Consider documenting decisions with orchestrator_log_decision before implementing.");
                            }
                        }
                    }
                    wf.completePhase(currentPhase, params.skip);
                    wf.enterPhase(target);
                }
                else {
                    // Auto-advance with quality gates
                    // work → next: QA GATE CHECK (when include_qa)
                    if (currentPhase === "work" && wf.includeQa) {
                        if (!sessionTracker.canAdvanceFromWork()) {
                            const qaSummary = sessionTracker.getQaSummary();
                            return txt({ ok: false, error: `QA review required. ${qaSummary}`, qa_required: true, qa_status: sessionTracker.qaStatus });
                        }
                    }
                    // log → finish: LOG CHECK
                    if (currentPhase === "log" && !sessionTracker.loggedTaskCompletion) {
                        return txt({ ok: false, error: "Task must be logged before finishing. Call orchestrator_log_session with status=complete.", log_required: true });
                    }
                    // log → finish: HANDOFF GATE
                    if (currentPhase === "log" && !sessionTracker.canFinish()) {
                        return txt({ ok: false, error: "Handoff document required before finishing. Run orchestrator_generate_handoff.", handoff_required: true });
                    }
                    // Auto-fix docs drift before finalizing
                    tryFixDocsDrift(sessionTracker.currentProject, dataDir, logger);
                    // document → next: ADR CHECK (soft warning)
                    if (currentPhase === "document") {
                        const project = sessionTracker.currentProject;
                        if (project) {
                            const adrsDir = path.join(dataDir, "adrs");
                            let adrCount = 0;
                            if (fs.existsSync(adrsDir)) {
                                adrCount = fs.readdirSync(adrsDir).filter(f => f.endsWith(".md") && f.includes(project.replace(/[^a-zA-Z0-9_-]/g, "-"))).length;
                            }
                            if (adrCount === 0) {
                                const projAdrsDir2 = path.join(projDir(project, dataDir), "adrs");
                                if (fs.existsSync(projAdrsDir2)) {
                                    adrCount = fs.readdirSync(projAdrsDir2).filter(f => f.endsWith(".md")).length;
                                }
                            }
                            if (adrCount === 0) {
                                logger.warn("workflow", "No ADR found. Suggest documenting with orchestrator_log_decision before coding.");
                            }
                        }
                    }
                    // work → next: GIT CHECK (soft warning)
                    if (currentPhase === "work") {
                        const project = sessionTracker.currentProject;
                        if (project) {
                            const loc = getProjectLocation(project, dataDir);
                            if (loc && fs.existsSync(path.join(loc, ".git"))) {
                                try {
                                    const statusRaw = execSync("git status --porcelain", { cwd: loc, encoding: "utf-8", timeout: 5000 });
                                    const changed = statusRaw.trim().split("\n").filter(Boolean);
                                    if (changed.length > 0) {
                                        logger.warn("workflow", `${changed.length} uncommitted file(s) before logging phase.`);
                                    }
                                }
                                catch { /* git check non-fatal */ }
                            }
                        }
                    }
                    const next = wf.advance();
                    if (!next) {
                        return txt({ ok: true, warning: "Already at last phase. No more phases to advance.", phase: wf.currentPhase, progress: wf.getProgress() });
                    }
                }
                // Write state event for phase completion
                const curProject = sessionTracker.currentProject;
                if (curProject) {
                    writeStateEvent(curProject, dataDir, {
                        type: "phase_completed",
                        phase: currentPhase,
                        skipped: !!params.skip,
                    });
                }
                sessionTracker.trackAction(`workflow: ${wf.currentPhase}`);
                writeLiveAgents("workflow_advance", sessionTracker, logger);
                logger.info("workflow", `Phase advanced: ${wf.currentPhase} (${wf.getProgress()})`);
                return txt({ ok: true, phase: wf.currentPhase, progress: wf.getProgress(), elapsed: wf.getPhaseElapsed(), phase_history: wf.phaseHistory });
            },
        });
        // ═══════════════════════════════════════════════════════════
        //  BACKLOG TOOLS
        // ═══════════════════════════════════════════════════════════
        api.registerTool({
            name: "orchestrator_backlog_add",
            label: "Add Backlog Task",
            description: "Add a task to a project's backlog.",
            parameters: Type.Object({
                project: Type.String({ description: "Project name." }),
                title: Type.String({ description: "Task title." }),
                description: Type.Optional(Type.String({ description: "Task description." })),
                priority: Type.Optional(Type.String({ description: "Priority: p0 (urgent), p1 (high), p2 (normal), p3 (low). Default: p2." })),
                labels: Type.Optional(Type.Array(Type.String(), { description: "Labels/tags." })),
                depends_on: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this depends on." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                return txt(backlogAdd(params.project, dataDir, params));
            },
        });
        api.registerTool({
            name: "orchestrator_backlog_list",
            label: "List Backlog",
            description: "List backlog tasks with optional filters.",
            parameters: Type.Object({
                project: Type.String({ description: "Project name." }),
                status: Type.Optional(Type.String({ description: "Filter by status: todo, in_progress, done, blocked." })),
                priority: Type.Optional(Type.String({ description: "Filter by priority: p0, p1, p2, p3." })),
                label: Type.Optional(Type.String({ description: "Filter by label." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                return txt(backlogList(params.project, dataDir, params));
            },
        });
        api.registerTool({
            name: "orchestrator_backlog_update",
            label: "Update Backlog Task",
            description: "Update a backlog task's status, priority, assignment, or labels.",
            parameters: Type.Object({
                project: Type.String({ description: "Project name." }),
                id: Type.String({ description: "Task ID." }),
                status: Type.Optional(Type.String({ description: "New status: todo, in_progress, done, blocked." })),
                priority: Type.Optional(Type.String({ description: "New priority: p0, p1, p2, p3." })),
                assigned_to: Type.Optional(Type.String({ description: "Assign to agent or user." })),
                labels: Type.Optional(Type.Array(Type.String(), { description: "Replace labels." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                return txt(backlogUpdate(params.project, dataDir, params));
            },
        });
        // ═══════════════════════════════════════════════════════════
        //  MODEL ROUTING
        // ═══════════════════════════════════════════════════════════
        api.registerTool({
            name: "orchestrator_get_routing",
            label: "Get Model Routing",
            description: "Get the recommended model for a task category (coding, fixing, research, q&a, documentation). Returns the ordered model list and best available model for the given project and category.",
            parameters: Type.Object({
                category: Type.String({ description: "Task category: coding, fixing, research, q&a, documentation" }),
                project: Type.Optional(Type.String({ description: "Project name. Omit to use current project context." })),
            }),
            async execute(_id, params) {
                const cfg = readJSON(path.join(dataDir, "dashboard-config.json")) || {};
                const proj = params.project || sessionTracker.currentProject;
                if (!proj) {
                    return txt({ ok: false, error: "No project specified and no project context set. Use orchestrator_set_context first or pass a project name." });
                }
                const pc = cfg.projects?.[proj];
                if (!pc) {
                    return txt({ ok: false, error: `Project '${proj}' not found in dashboard-config.json` });
                }
                // Load model inventory for quality data
                const md = readJSON(path.join(dataDir, "models.json"));
                const allModels = md?.models || [];
                const preset = pc.routing_preset || "custom";
                const singleProvider = pc.routing_single_provider || null;
                const routing = pc.model_routing;
                const cat = params.category.toLowerCase().trim();
                // ── Preset: no-steering ──
                if (preset === "no-steering") {
                    return txt({
                        ok: true,
                        project: proj,
                        category: cat,
                        preset: "no-steering",
                        note: "Routing disabled for this project — OpenClaw will use default model resolution.",
                    });
                }
                // ── Preset: free-only ──
                if (preset === "free-only") {
                    const freeModels = allModels
                        .filter(m => !isPaid(m) && m.agent_ready !== false && m.status === "active")
                        .sort((a, b) => (b.tier || 0) - (a.tier || 0));
                    return txt({
                        ok: true,
                        project: proj,
                        category: cat,
                        preset: "free-only",
                        recommended: freeModels[0]?.id || null,
                        fallbacks: freeModels.slice(1, 5).map(m => m.id),
                        all: freeModels.map(m => m.id),
                        source: "free-only preset",
                        model_quality: freeModels.slice(0, 5).map(m => ({
                            id: m.id,
                            provider: m.provider,
                            tier: m.tier,
                            speed: m.speed_rating || 0,
                            context: m.context_window || 0,
                            cost_type: m.cost_type || null,
                        })),
                    });
                }
                // ── Preset: single-provider ──
                if (preset === "single-provider" && singleProvider) {
                    const provModels = allModels
                        .filter(m => m.provider === singleProvider && m.agent_ready !== false && m.status === "active")
                        .sort((a, b) => (b.tier || 0) - (a.tier || 0));
                    return txt({
                        ok: true,
                        project: proj,
                        category: cat,
                        preset: "single-provider",
                        provider: singleProvider,
                        recommended: provModels[0]?.id || null,
                        fallbacks: provModels.slice(1, 5).map(m => m.id),
                        all: provModels.map(m => m.id),
                        source: `single-provider: ${singleProvider}`,
                        model_quality: provModels.slice(0, 5).map(m => ({
                            id: m.id,
                            provider: m.provider,
                            tier: m.tier,
                            speed: m.speed_rating || 0,
                            context: m.context_window || 0,
                        })),
                    });
                }
                // ── Custom routing chains ──
                if (!routing) {
                    return txt({ ok: false, error: `No model_routing configured for project '${proj}'.` });
                }
                const models = routing[cat];
                if (!models || models.length === 0) {
                    return txt({ ok: false, error: `No models routed for category '${cat}' in project '${proj}'. Available categories: ${Object.keys(routing).join(", ")}` });
                }
                // Enrich with model quality data
                const enriched = models.map(id => {
                    const found = allModels.find(m => m.id === id);
                    return found ? {
                        id: found.id,
                        provider: found.provider,
                        tier: found.tier,
                        speed: found.speed_rating || 0,
                        context: found.context_window || 0,
                        status: found.status || "unknown",
                        agent_ready: found.agent_ready !== false,
                    } : { id, provider: "?", tier: 0, speed: 0, context: 0, status: "unknown", agent_ready: false };
                });
                const available = enriched.filter(m => m.status === "active" && m.agent_ready);
                const blocked = enriched.filter(m => m.status !== "active" || !m.agent_ready);
                return txt({
                    ok: true,
                    project: proj,
                    category: cat,
                    preset,
                    routing_preset: preset,
                    recommended: available[0]?.id || enriched[0]?.id || models[0],
                    fallbacks: available.slice(1).map(m => m.id),
                    blocked_chain: blocked.length > 0 ? blocked.map(m => m.id) : undefined,
                    all: models,
                    model_quality: enriched,
                    source: "dashboard-config.json projects." + proj + ".model_routing",
                });
            },
        });
        api.registerTool({
            name: "orchestrator_get_registered_sessions",
            label: "Get Registered Sessions",
            description: "List all currently registered orchestrator sessions with their project context, status, and activity. Only sessions that explicitly called orchestrator_register are tracked.",
            parameters: Type.Object({}),
            async execute(_id, _params) {
                const keys = sessionTracker.getRegisteredSessions();
                const sessions = keys.map(k => {
                    const ctx = sessionTracker.getSessionContext(k);
                    return {
                        session_key: k,
                        has_context: !!ctx,
                        project: ctx?.project || null,
                        task: ctx?.task || null,
                        is_current: k === sessionTracker.sessionKey,
                    };
                });
                return txt({
                    ok: true,
                    count: sessions.length,
                    registered_sessions: sessions,
                });
            },
        });
        api.registerTool({
            name: "orchestrator_doctor",
            label: "Orchestrator Doctor",
            description: "Diagnose and auto-fix common orchestrator issues: session key mismatches, broken registration, stale data, context inconsistencies, orphaned projects, and missing STATE.md docs.",
            parameters: Type.Object({
                check: Type.Optional(Type.String({ description: "Specific check to run: 'all' (default), 'sessions', 'context', 'data'" })),
                fix: Type.Optional(Type.Boolean({ description: "Auto-fix discovered issues when possible (default: false)" })),
            }),
            async execute(_id, params) {
                const checks = (params.check || "all");
                const autoFix = !!params.fix;
                const issues = [];
                const fixes = [];
                let ok = true;
                function addIssue(msg) { issues.push(msg); ok = false; }
                function addFix(msg) { fixes.push(msg); }
                // -- 1. SESSION HEALTH --
                if (checks === "all" || checks === "sessions") {
                    const hk = sessionTracker.sessionKey;
                    if (!hk) {
                        addIssue("No session key set. orchestrator_register will use synthetic fallback.");
                        if (autoFix) {
                            const sk = agentDefaultSessionKey();
                            sessionTracker.registerSession(sk);
                            sessionTracker.sessionKey = sk;
                            addFix("Registered synthetic key: " + sk);
                        }
                    }
                    else {
                        if (!sessionTracker.isSessionRegistered(hk)) {
                            addIssue("Session key " + hk + " is not registered. Call orchestrator_register.");
                            if (autoFix) {
                                sessionTracker.registerSession(hk);
                                addFix("Registered session: " + hk);
                            }
                        }
                    }
                    const allRegSessions = sessionTracker.getRegisteredSessions();
                    const syntheticKeys = allRegSessions.filter(k => k.startsWith("agent:main:auto:"));
                    const realKeys = allRegSessions.filter(k => !k.startsWith("agent:main:auto:"));
                    if (syntheticKeys.length > 0 && realKeys.length === 0) {
                        addIssue("Only synthetic keys registered - project context injection may not fire because the gateway uses real session keys in hooks.");
                    }
                    if (autoFix && syntheticKeys.length > 0 && realKeys.length === 0 && hk && !hk.startsWith("agent:main:auto:")) {
                        for (const sk of syntheticKeys) {
                            const ctx = sessionTracker.getSessionContext(sk);
                            sessionTracker.registerSession(hk);
                            if (ctx) {
                                sessionTracker.sessionKey = hk;
                                sessionTracker.setContext(ctx.project, ctx.task || "");
                                sessionTracker.setStatus("resolving");
                                addFix("Copied context \"" + ctx.project + "\" from " + sk + " to real key " + hk);
                            }
                            else {
                                addFix("Registered real key " + hk + " (no context to transfer)");
                            }
                        }
                    }
                }
                // -- 2. CONTEXT HEALTH --
                if (checks === "all" || checks === "context") {
                    const hk = sessionTracker.sessionKey;
                    const ctx = hk ? sessionTracker.getSessionContext(hk) : null;
                    const allCtxRaw = sessionTracker.getRegisteredSessions()
                        .map(k => ({ key: k, ctx: sessionTracker.getSessionContext(k) }))
                        .filter((x) => !!x.ctx);
                    if (!ctx && allCtxRaw.length === 0) {
                        addIssue("No project context set. Use orchestrator_set_context to activate a project.");
                    }
                    else if (!ctx && allCtxRaw.length > 0) {
                        addIssue("Context is set for other sessions but NOT the current one. Session key may differ.");
                        if (autoFix && allCtxRaw[0].ctx) {
                            const best = allCtxRaw[0];
                            sessionTracker.sessionKey = hk || best.key;
                            sessionTracker.setContext(best.ctx.project, best.ctx.task || "");
                            addFix("Copied context \"" + best.ctx.project + "\" to current session");
                        }
                    }
                    for (const x of allCtxRaw) {
                        const loc = getProjectLocation(x.ctx.project, dataDir);
                        if (loc && !fs.existsSync(loc)) {
                            addIssue("Project \"" + x.ctx.project + "\" location missing: " + loc);
                        }
                    }
                }
                // -- 3. DATA HEALTH --
                if (checks === "all" || checks === "data") {
                    const modelsPath = path.join(dataDir, "models.json");
                    if (fs.existsSync(modelsPath)) {
                        try {
                            const md = JSON.parse(fs.readFileSync(modelsPath, "utf-8"));
                            const activeModels = (md.models || []).filter((m) => m.status === "active").length;
                            if (activeModels === 0)
                                addIssue("models.json has 0 active models. Run orchestrator_auto_populate.");
                        }
                        catch (e) {
                            addIssue("models.json is corrupt: " + e.message + ". Run orchestrator_auto_populate.");
                            if (autoFix) {
                                try {
                                    fs.unlinkSync(modelsPath);
                                    addFix("Deleted corrupt models.json");
                                }
                                catch { }
                            }
                        }
                    }
                    const cfgPath = path.join(dataDir, "dashboard-config.json");
                    if (!fs.existsSync(cfgPath))
                        addIssue("dashboard-config.json not found.");
                    const logPath = path.join(dataDir, "logs", "orchestrator.jsonl");
                    if (fs.existsSync(logPath)) {
                        const stat = fs.statSync(logPath);
                        const ageHrs = (Date.now() - stat.mtimeMs) / 3600000;
                        if (ageHrs > 24)
                            addIssue("orchestrator.jsonl last modified " + ageHrs.toFixed(1) + " hours ago.");
                    }
                    else {
                        addIssue("orchestrator.jsonl missing.");
                    }
                    const livePath = path.join(dataDir, LIVE_AGENTS_FILE);
                    if (fs.existsSync(livePath)) {
                        const stat = fs.statSync(livePath);
                        const ageSec = (Date.now() - stat.mtimeMs) / 1000;
                        if (ageSec > 300)
                            addIssue("live-agents.json stale (" + Math.round(ageSec) + "s old).");
                        if (autoFix && ageSec > 600) {
                            try {
                                fs.unlinkSync(livePath);
                                addFix("Removed stale live-agents.json");
                            }
                            catch { }
                        }
                    }
                }
                // -- 4. GATEWAY HEALTH (plugin deployment — no PM2 bridge needed) --
                if (checks === "all" || checks === "pm2") {
                    try {
                        const pm2Out = execSync("pm2 jlist 2>/dev/null", { encoding: "utf-8", timeout: 3000 });
                        const processes = JSON.parse(pm2Out);
                        const bridgeProc = processes.find((p) => p.name === "genor-bridge" || p.name === "gateway-ws-bridge" || p.name === "gw-ws-bridge" || (p.pm2_env?.name?.includes("bridge")));
                        if (!bridgeProc) {
                            // PM2 bridge missing is NORMAL for plugin deployments — ignore
                        }
                        else if (bridgeProc.pm2_env?.status !== "online") {
                            addIssue("Legacy PM2 bridge is " + (bridgeProc.pm2_env?.status || "unknown") + " (ignore if running as OpenClaw plugin).");
                        }
                    }
                    catch { /* PM2 not available — expected for plugin deployments */ }
                }
                // -- 5. PROJECT HEALTH (requires required docs, no orphaned projects) --
                if (checks === "all" || checks === "data") {
                    const REQUIRED_PROJECT_DOCS = ["STATE.md"];
                    const pd = path.join(dataDir, "projects");
                    if (fs.existsSync(pd)) {
                        for (const e of fs.readdirSync(pd)) {
                            const pp = path.join(pd, e);
                            if (!fs.statSync(pp).isDirectory())
                                continue;
                            // Check if project has any sessions
                            const sf = path.join(pp, "sessions.json");
                            let sessCount = 0;
                            if (fs.existsSync(sf)) {
                                try {
                                    const d = JSON.parse(fs.readFileSync(sf, "utf-8"));
                                    sessCount = (Array.isArray(d) ? d : (d.sessions || [])).length;
                                }
                                catch { }
                            }
                            // Check required docs
                            const missingDocs = REQUIRED_PROJECT_DOCS.filter(doc => !fs.existsSync(path.join(pp, doc)));
                            // Check for stale sessions (running entries older than 24h)
                            let staleSessions = 0;
                            if (sessCount > 0) {
                                try {
                                    const d = JSON.parse(fs.readFileSync(sf, "utf-8"));
                                    const sessList = Array.isArray(d) ? d : (d.sessions || []);
                                    staleSessions = sessList.filter((s) => s.status === "running" && s.start_time &&
                                        (Date.now() - new Date(s.start_time).getTime()) > 86400000).length;
                                }
                                catch { }
                            }
                            if (sessCount === 0) {
                                // Orphaned project
                                addIssue(`Project "${e}" has 0 sessions — it was scaffolded but never worked on. This is an incomplete project producing clutter.`);
                                if (autoFix) {
                                    addFix(`Removing empty project "${e}" — no sessions means no data to lose.`);
                                    try {
                                        // Move to archive instead of delete
                                        const archiveDir = path.join(dataDir, "projects", ".archived");
                                        fs.mkdirSync(archiveDir, { recursive: true });
                                        fs.renameSync(pp, path.join(archiveDir, e));
                                        addFix(`Archived empty project "${e}" to projects/.archived/`);
                                    }
                                    catch (archErr) {
                                        addFix(`Failed to archive "${e}": ${archErr.message}`);
                                    }
                                }
                            }
                            else if (missingDocs.length > 0) {
                                addIssue(`Project "${e}" (${sessCount} sessions) is missing required docs: ${missingDocs.join(", ")}. Every project needs STATE.md to track its current status.`);
                                if (autoFix) {
                                    // Auto-initialize missing STATE.md
                                    if (missingDocs.includes("STATE.md")) {
                                        const loc = getProjectLocation(e, dataDir);
                                        const stateContent = [
                                            `# STATE: ${e}`,
                                            ``,
                                            `**Status:** Active`,
                                            `**Last Updated:** ${new Date().toISOString().split("T")[0]}`,
                                            `**Location:** ${loc || "Not configured"}`,
                                            ``,
                                            `## Sessions`,
                                            ``,
                                            `Total sessions logged: ${sessCount}`,
                                            ``,
                                            `## Current State`,
                                            ``,
                                            `_(Auto-generated by orchestrator_doctor. Update this file as the project evolves to keep docs in sync with reality.)_`,
                                        ].join("\n");
                                        fs.writeFileSync(path.join(pp, "STATE.md"), stateContent, "utf-8");
                                        addFix(`Auto-created STATE.md for project "${e}"`);
                                    }
                                }
                            }
                            // Check stale sessions
                            if (staleSessions > 0) {
                                addIssue(`Project "${e}" has ${staleSessions} stale "running" session(s) aged >24h — these should be closed or marked as interrupted.`);
                            }
                        }
                    }
                }
                // ── Recompute ok: if all discovered issues were fixed, the system is healthy ──
                // The result should reflect the current state, not the initial scan. A doctor
                // that successfully fixes everything returns ok=true.
                const finalOk = autoFix && issues.length > 0 && fixes.length >= issues.length;
                const result = { ok: finalOk || ok, checks: checks, auto_fix: autoFix, issues_found: issues.length, fixes_applied: fixes.length, session_key: sessionTracker.sessionKey || "(none)", registered: sessionTracker.sessionKey ? sessionTracker.isSessionRegistered(sessionTracker.sessionKey) : false, project_context: sessionTracker.currentProject || "(none)" };
                if (issues.length > 0)
                    result.issues = issues;
                if (fixes.length > 0)
                    result.fixes = fixes;
                return txt(result);
            },
        });
        // ═══════════════════════════════════════════════════════════
        //  NEW TOOLS — Release Project, Active Projects, Join, Spawn Subagent
        // ═══════════════════════════════════════════════════════════
        api.registerTool({
            name: "orchestrator_release_project",
            label: "Orchestrator Release Project",
            description: "Release the current session's project binding so it can work on a different project. Use when you're done with the current project.",
            parameters: Type.Object({
                force: Type.Optional(Type.Boolean({ description: "Force release (default: false)" })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                const sk = sessionTracker.sessionKey || agentDefaultSessionKey();
                const bound = sessionTracker.getBoundProject(sk);
                if (!bound)
                    return txt({ ok: false, error: "No project binding to release." });
                // ═══ ENFORCE TASK COMPLETION LOGGING ═══
                if (!sessionTracker.loggedTaskCompletion) {
                    return txt({
                        ok: false,
                        error: `❌ Task not logged. Session is bound to project "${bound}" but hasn't logged completion. ` +
                            `Call orchestrator_log_session with status="complete" first to document what was done ` +
                            `before releasing the binding. Use force=true to override this check.`,
                    });
                }
                const released = sessionTracker.releaseProjectBinding(sk);
                sessionTracker.trackAction(`released_project: ${released}`);
                writeLiveAgents("release_project", sessionTracker, logger);
                logger.info("sessions", `Released project binding: ${released} (session=${sk})`);
                return txt({
                    ok: true,
                    released_project: released,
                    message: `Released from project "${released}". You can now set context to a different project.`,
                });
            },
        });
        api.registerTool({
            name: "orchestrator_list_active_projects",
            label: "Orchestrator List Active Projects",
            description: "List projects that currently have active sessions working on them. Shows project names, active session count, and session keys.",
            parameters: Type.Object({}),
            async execute(_id, _params) {
                const active = sessionTracker.getActiveProjects();
                // Also supplement with projects from orchestrator-data that have sessions logged
                const pd = path.join(dataDir, "projects");
                const allProjects = [];
                if (fs.existsSync(pd)) {
                    for (const e of fs.readdirSync(pd)) {
                        const pp = path.join(pd, e);
                        if (!fs.statSync(pp).isDirectory())
                            continue;
                        const sf = path.join(pp, "sessions.json");
                        let sessCount = 0;
                        if (fs.existsSync(sf)) {
                            try {
                                const d = JSON.parse(fs.readFileSync(sf, "utf-8"));
                                sessCount = (Array.isArray(d) ? d : (d.sessions || [])).length;
                            }
                            catch { /* */ }
                        }
                        const loc = getProjectLocation(e, dataDir);
                        const hasState = fs.existsSync(path.join(pp, "STATE.md"));
                        allProjects.push({
                            project: e,
                            sessions_logged: sessCount,
                            location: loc,
                            healthy_docs: hasState,
                            active_sessions: active.find(a => a.project === e)?.active_sessions || 0,
                        });
                    }
                }
                return txt({
                    ok: true,
                    active_project_count: active.length,
                    active_projects: active.map(a => ({
                        project: a.project,
                        active_sessions: a.active_sessions,
                        session_keys: a.session_keys,
                    })),
                    all_projects: allProjects.sort((a, b) => b.sessions_logged - a.sessions_logged),
                });
            },
        });
        api.registerTool({
            name: "orchestrator_join_project",
            label: "Orchestrator Join Project",
            description: "Non-registered sessions can discover and join an active project. Handles registration + context setting in one step. Use for new/ad-hoc sessions contributing to existing projects.",
            parameters: Type.Object({
                project: Type.String({ description: "Project name to join. Use orchestrator_list_active_projects first to see active projects." }),
                task: Type.String({ description: "Task description for what you're joining to do." }),
            }),
            async execute(_id, params) {
                const sk = sessionTracker.sessionKey || agentDefaultSessionKey();
                if (!sk)
                    return txt({ ok: false, error: "No session key available." });
                // Auto-register this session
                sessionTracker.registerSession(sk);
                if (!sessionTracker.sessionKey)
                    sessionTracker.sessionKey = sk;
                // Verify the project exists in data
                const pd = path.join(dataDir, "projects");
                const projExists = fs.existsSync(pd) && fs.existsSync(path.join(pd, params.project));
                if (!projExists) {
                    return txt({
                        ok: false,
                        error: `Project "${params.project}" not found in orchestrator data. Active projects: ${sessionTracker.getActiveProjects().map(a => a.project).join(", ")}`,
                    });
                }
                try {
                    const result = setContext(dataDir, params.project, params.task, logger);
                    logger.info("sessions", `Session joined project: ${params.project}/${params.task} (session=${sk})`);
                    return txt({
                        ok: true,
                        joined_project: params.project,
                        task: params.task,
                        registered: true,
                        message: `Joined project "${params.project}" — context set, task: "${params.task}"`,
                        details: result,
                    });
                }
                catch (err) {
                    return txt({
                        ok: false,
                        error: `Failed to join project "${params.project}": ${err.message}`,
                    });
                }
            },
        });
        api.registerTool({
            name: "orchestrator_spawn_subagent",
            label: "Orchestrator Spawn Subagent",
            description: "Spawn a subagent using orchestrator-managed project context, with model routing and auto-logging. Logged as subagent session under current project. Returns session key for tracking.",
            parameters: Type.Object({
                task: Type.String({ description: "Task description for the subagent." }),
                model: Type.Optional(Type.String({ description: "Optional model override. Omit to use project routing rules." })),
                taskName: Type.Optional(Type.String({ description: "Optional stable name for subagent (lowercase with underscores/hyphens)." })),
                timeoutSeconds: Type.Optional(Type.Number({ description: "Optional timeout in seconds (default: 300, max: 1800)." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: "Session not registered. Call orchestrator_register or orchestrator_join_project first." });
                if (!sessionTracker.currentProject) {
                    return txt({ ok: false, error: "No active project. Set project context first with orchestrator_set_context or orchestrator_join_project." });
                }
                const project = sessionTracker.currentProject;
                const task = params.task;
                const model = params.model || sessionTracker.currentModel || undefined;
                const taskName = params.taskName || `sub-${project}-${Date.now().toString(36)}`;
                const timeoutSeconds = Math.min(params.timeoutSeconds || 300, 1800);
                // Log the subagent spawn
                sessionTracker.trackSubagent(`pending-${taskName}`, {
                    parentKey: sessionTracker.sessionKey || "unknown",
                    project,
                    task,
                    startedAt: new Date().toISOString(),
                });
                sessionTracker.trackAction(`spawn_subagent: ${taskName}`);
                writeLiveAgents("spawn_subagent", sessionTracker, logger);
                // Build the spawn message with full context
                const spawnTask = [
                    `[Subagent Task - Spawned by Orchestrator Plugin]`,
                    `Project: ${project}`,
                    `Parent Session: ${sessionTracker.sessionKey || "unknown"}`,
                    `Task: ${task}`,
                    model ? `Model: ${model}` : "",
                    `Timeout: ${timeoutSeconds}s`,
                ].filter(Boolean).join("\n");
                try {
                    logger.info("subagent", `Spawning: ${taskName} (${project}/${task}) model=${model || "auto"}`);
                    // ── ACTUALLY SPAWN the subagent via OpenClaw runtime API ──
                    if (!sessionTracker.sessionKey) {
                        return txt({ ok: false, error: "No session key available. Cannot spawn subagent." });
                    }
                    // Generate a unique session key that incorporates the task name
                    const safeName = taskName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
                    const sessionKey = `agent:main:subagent:${safeName || 'sub'}-${Date.now().toString(36)}`;
                    const spawnResult = await api.runtime.subagent.run({
                        sessionKey,
                        message: spawnTask,
                        model: model || undefined,
                        lightContext: true,
                    });
                    logger.info("subagent", `Spawned ${taskName}: runId=${spawnResult.runId}`);
                    return txt({
                        ok: true,
                        project,
                        task,
                        task_name: taskName,
                        model: model || "auto-routed",
                        timeout_seconds: timeoutSeconds,
                        run_id: spawnResult.runId,
                        message: `Subagent "${taskName}" spawned successfully (runId: ${spawnResult.runId}). Use orchestrator_spawn_subagent to track completion.`,
                    });
                }
                catch (err) {
                    logger.error("subagent", `Spawn failed for ${taskName}: ${err.message}`);
                    return txt({ ok: false, error: `Failed to spawn subagent: ${err.message}` });
                }
            },
        });
        // ═══════════════════════════════════════════════════════════
        //  NEW TOOL — Backlog Dispatch (Phase 2b)
        // ═══════════════════════════════════════════════════════════
        api.registerTool({
            name: "orchestrator_backlog_dispatch",
            label: "Backlog Dispatch",
            description: "Pick the highest-priority available backlog task and return dispatch instructions for sub-agent execution. Use this to automate task assignment. Respects dependencies, labels, and priority ordering.",
            parameters: Type.Object({
                project: Type.Optional(Type.String({ description: "Override project. Default: current project from orchestrator context." })),
                task_id: Type.Optional(Type.String({ description: "Specific task ID to dispatch. If omitted, picks the highest-priority todo task with all dependencies resolved." })),
                auto_claim: Type.Optional(Type.Boolean({ description: "Auto-mark the task as in_progress (default: false)." })),
                filter_labels: Type.Optional(Type.String({ description: "Comma-separated label filter. Only dispatch tasks matching ANY of these labels." })),
                max_dispatch: Type.Optional(Type.Number({ description: "Max parallel tasks to dispatch (Phase 2c). Returns up to N dispatchable tasks. Default: 1." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                const project = params.project || sessionTracker.currentProject;
                if (!project)
                    return txt({ ok: false, error: "No project selected. Set context via orchestrator_set_context or pass project param." });
                const bp = path.join(dataDir, "projects", project, "BACKLOG.json");
                if (!fs.existsSync(bp))
                    return txt({ ok: false, error: `No BACKLOG.json found for project "${project}".` });
                let backlog;
                try {
                    backlog = JSON.parse(fs.readFileSync(bp, "utf-8"));
                }
                catch (e) {
                    return txt({ ok: false, error: `Failed to read backlog: ${e.message}` });
                }
                const tasks = backlog.tasks || [];
                let candidates = tasks.filter((t) => t.status === "todo" || t.status === "backlog");
                if (params.filter_labels) {
                    const fl = params.filter_labels.split(",").map((l) => l.trim().toLowerCase());
                    candidates = candidates.filter((t) => (t.labels || []).some((l) => fl.includes(l.toLowerCase())));
                }
                if (params.task_id) {
                    candidates = candidates.filter((t) => t.id === params.task_id);
                    if (!candidates.length)
                        return txt({ ok: false, error: `Task "${params.task_id}" not found or unavailable.` });
                }
                // Resolve dependencies — only tasks whose deps are done
                const doneIds = new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));
                candidates = candidates.filter((t) => (t.depends_on || []).every((d) => doneIds.has(d)));
                if (!candidates.length)
                    return txt({ ok: false, message: "No available tasks to dispatch (dependencies unresolved or backlog empty)." });
                // Sort: priority then creation time
                const priO = { p0: 0, p1: 1, high: 0.5, medium: 1.5, p2: 2, p3: 3, low: 3.5 };
                candidates.sort((a, b) => {
                    const pa = priO[a.priority] ?? 2, pb = priO[b.priority] ?? 2;
                    if (pa !== pb)
                        return pa - pb;
                    return (a.created || "").localeCompare(b.created || "");
                });
                // Phase 2c: Support parallel dispatch — take up to max_dispatch tasks
                const maxD = Math.max(1, Math.min(params.max_dispatch || 1, 10));
                const selected = candidates.slice(0, maxD);
                // Auto-claim selected tasks
                if (params.auto_claim) {
                    const claimedIds = [];
                    for (const task of selected) {
                        for (const t of tasks) {
                            if (t.id === task.id) {
                                t.status = "in_progress";
                                claimedIds.push(task.id);
                                break;
                            }
                        }
                    }
                    backlog.tasks = tasks;
                    fs.writeFileSync(bp, JSON.stringify(backlog, null, 2));
                    logger.info("dispatch", `Claimed ${claimedIds.length} tasks: ${claimedIds.join(", ")}`);
                }
                const loc = getProjectLocation(project, dataDir);
                const dispatchList = selected.map((task) => {
                    const labels = (task.labels || []).join(", ");
                    const deps = (task.depends_on || []).map((d) => {
                        const dt = tasks.find((t2) => t2.id === d);
                        return dt ? `${d} — ${dt.title}` : d;
                    });
                    return {
                        task_id: task.id,
                        title: task.title,
                        description: task.description || "",
                        priority: task.priority || "p2",
                        labels,
                        depends_on: deps,
                        spawn: [
                            `🎯 Task: ${task.title}`,
                            `ID: ${task.id}`,
                            task.description ? `Description: ${task.description}` : "",
                            `Priority: ${task.priority || "p2"}`,
                            labels ? `Labels: ${labels}` : "",
                            deps.length ? `Dependencies: ${deps.join("; ")}` : "",
                        ].filter(Boolean).join("\n"),
                    };
                });
                const result = {
                    ok: true,
                    project,
                    location: loc || "not configured",
                    dispatched_count: selected.length,
                    total_available: candidates.length,
                    total_backlog: tasks.length,
                    tasks: dispatchList,
                };
                // Single-task mode: backward-compatible top-level fields
                if (selected.length === 1) {
                    const task = selected[0];
                    const labels = (task.labels || []).join(", ");
                    const deps = (task.depends_on || []).map((d) => {
                        const dt = tasks.find((t2) => t2.id === d);
                        return dt ? `${d} — ${dt.title}` : d;
                    });
                    Object.assign(result, {
                        task_id: task.id,
                        title: task.title,
                        description: task.description || "",
                        priority: task.priority || "p2",
                        labels,
                        status: task.status,
                        depends_on: deps,
                        spawn_instructions: dispatchList[0].spawn + `\n\n📋 Use orchestrator_spawn_subagent or sessions_spawn to dispatch this task.`,
                    });
                }
                return txt(result);
            },
        });
        // ═══════════════════════════════════════════════════════════
        //  NEW TOOL — Backlog Dispatch All (Phase 2c: Parallel dispatch)
        // ═══════════════════════════════════════════════════════════
        api.registerTool({
            name: "orchestrator_backlog_dispatch_all",
            label: "Backlog Dispatch All",
            description: "Dispatch ALL currently available backlog tasks up to a max count, for parallel sub-agent execution. Returns spawn instructions for each task. Respects dependency resolution — only returns tasks whose dependencies are complete.",
            parameters: Type.Object({
                project: Type.Optional(Type.String({ description: "Override project. Default: current project." })),
                max_dispatch: Type.Optional(Type.Number({ description: "Maximum tasks to dispatch (default: 5, max: 20)." })),
                auto_claim: Type.Optional(Type.Boolean({ description: "Auto-mark tasks as in_progress (default: true)." })),
                filter_labels: Type.Optional(Type.String({ description: "Comma-separated label filter. Only dispatch tasks matching ANY label." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                const project = params.project || sessionTracker.currentProject;
                if (!project)
                    return txt({ ok: false, error: "No project selected." });
                const bp = path.join(dataDir, "projects", project, "BACKLOG.json");
                if (!fs.existsSync(bp))
                    return txt({ ok: false, error: `No BACKLOG.json for "${project}".` });
                let backlog;
                try {
                    backlog = JSON.parse(fs.readFileSync(bp, "utf-8"));
                }
                catch (e) {
                    return txt({ ok: false, error: `Failed to read backlog: ${e.message}` });
                }
                const tasks = backlog.tasks || [];
                let candidates = tasks.filter((t) => t.status === "todo" || t.status === "backlog");
                if (params.filter_labels) {
                    const fl = params.filter_labels.split(",").map((l) => l.trim().toLowerCase());
                    candidates = candidates.filter((t) => (t.labels || []).some((l) => fl.includes(l.toLowerCase())));
                }
                // Resolve dependencies
                const doneIds = new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));
                candidates = candidates.filter((t) => (t.depends_on || []).every((d) => doneIds.has(d)));
                if (!candidates.length)
                    return txt({ ok: false, message: "No available tasks to dispatch." });
                // Sort
                const priO = { p0: 0, p1: 1, high: 0.5, medium: 1.5, p2: 2, p3: 3, low: 3.5 };
                candidates.sort((a, b) => {
                    const pa = priO[a.priority] ?? 2, pb = priO[b.priority] ?? 2;
                    if (pa !== pb)
                        return pa - pb;
                    return (a.created || "").localeCompare(b.created || "");
                });
                const maxD = Math.max(1, Math.min(params.max_dispatch || 5, 20));
                const selected = candidates.slice(0, maxD);
                // Auto-claim
                const autoClaim = params.auto_claim !== false;
                if (autoClaim) {
                    for (const task of selected) {
                        for (const t of tasks) {
                            if (t.id === task.id) {
                                t.status = "in_progress";
                                break;
                            }
                        }
                    }
                    backlog.tasks = tasks;
                    fs.writeFileSync(bp, JSON.stringify(backlog, null, 2));
                }
                const loc = getProjectLocation(project, dataDir);
                const dispatchList = selected.map((task) => ({
                    task_id: task.id,
                    title: task.title,
                    description: task.description || "",
                    priority: task.priority || "p2",
                    labels: (task.labels || []).join(", "),
                    depends_on: (task.depends_on || []).map((d) => {
                        const dt = tasks.find((t2) => t2.id === d);
                        return dt ? `${d} — ${dt.title}` : d;
                    }),
                    spawn_key: `task_${task.id.replace(/[^a-z0-9]/gi, "_")}`,
                }));
                return txt({
                    ok: true,
                    project,
                    location: loc || "not configured",
                    dispatched_count: selected.length,
                    total_available: candidates.length,
                    total_backlog: tasks.length,
                    tasks: dispatchList,
                    instructions: `Use sessions_spawn for each task above. Spawn sub-agents with taskName=spawn_key for traceability.`,
                });
            },
        });
        // ═══════════════════════════════════════════════════════════
        //  TOOL — QA Submit
        // ═══════════════════════════════════════════════════════════
        api.registerTool({
            name: "orchestrator_qa_submit",
            label: "QA Submit Finding",
            description: "Submit a QA finding for review. When workflow.include_qa is enabled, this is required before advancing from work to log. ENFORCED: auto-spawns an independent QA review subagent.",
            parameters: Type.Object({
                finding: Type.String({ description: "Describe the QA finding, issue, or observation." }),
                review_model: Type.Optional(Type.String({ description: "Optional model override for the QA review subagent." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                if (!params.finding) {
                    return txt({ ok: false, error: "Finding description is required." });
                }
                sessionTracker.addQaFinding(params.finding);
                logger.info("qa", `QA finding submitted: ${params.finding.substring(0, 100)}`);
                // ── ENFORCED: Always spawn an independent QA review subagent ──
                // Uses a unique session key so each QA review gets its own isolated session
                let spawnResult = null;
                const project = sessionTracker.currentProject;
                const taskDesc = sessionTracker.currentTask || "Unknown task";
                const parentKey = sessionTracker.sessionKey;
                if (parentKey && project) {
                    try {
                        const reviewTask = [
                            `[QA Review - Auto-spawned by Orchestrator Plugin]`,
                            `Project: ${project}`,
                            `Parent Session: ${parentKey}`,
                            `Task under review: ${taskDesc}`,
                            ``,
                            `You are a QA reviewer. Independently review the work done for this task.`,
                            `Read the relevant files, check the planned changes (ADR), verify implementation`,
                            `matches requirements, and report your findings.`,
                            ``,
                            `QA finding from developer: ${params.finding}`,
                            ``,
                            `Return PASS or FAIL with specific findings.`,
                        ].filter(Boolean).join("\n");
                        // Generate a UNIQUE session key so each QA review is a separate subagent session
                        const qaSessionKey = `agent:main:subagent:orch-qa-${crypto.randomUUID()}`;
                        const reviewModel = params.review_model || undefined;
                        logger.info("qa", `Auto-spawning QA review subagent (${qaSessionKey}) for project=${project}`);
                        const result = await api.runtime.subagent.run({
                            sessionKey: qaSessionKey,
                            message: reviewTask,
                            model: reviewModel,
                            lightContext: true,
                        });
                        spawnResult = { runId: result.runId, sessionKey: qaSessionKey };
                        logger.info("qa", `QA review subagent spawned: runId=${result.runId}`);
                    }
                    catch (spawnErr) {
                        logger.warn("qa", `Auto-spawn QA review failed: ${spawnErr.message}`);
                        spawnResult = { runId: null };
                    }
                }
                return txt({
                    ok: true,
                    message: "QA finding submitted. Waiting for review (call orchestrator_qa_approve or orchestrator_qa_reject).",
                    qa_status: sessionTracker.qaStatus,
                    findings_count: sessionTracker.qaFindings.length,
                    review_spawned: spawnResult?.runId ? true : false,
                    review_run_id: spawnResult?.runId || null,
                    review_session_key: spawnResult?.sessionKey || null,
                });
            },
        });
        // ═══════════════════════════════════════════════════════════
        //  TOOL — QA Approve
        // ═══════════════════════════════════════════════════════════
        api.registerTool({
            name: "orchestrator_qa_approve",
            label: "QA Approve",
            description: "Approve the current work. Unblocks the work→log transition when QA gate is active.",
            parameters: Type.Object({}),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                if (sessionTracker.qaStatus !== "pending") {
                    return txt({ ok: false, error: "No pending QA review to approve. Submit findings with orchestrator_qa_submit first." });
                }
                sessionTracker.setQaStatus("approved");
                logger.info("qa", "QA approved — work→log transition unblocked");
                return txt({
                    ok: true,
                    message: "QA approved! You can now advance from work phase to log phase.",
                    qa_status: "approved",
                });
            },
        });
        // ═══════════════════════════════════════════════════════════
        //  TOOL — QA Reject
        // ═══════════════════════════════════════════════════════════
        api.registerTool({
            name: "orchestrator_qa_reject",
            label: "QA Reject",
            description: "Reject the current work and return to work phase for fixes. Provide a reason for the rejection.",
            parameters: Type.Object({
                reason: Type.String({ description: "Why the work was rejected. Describe what needs to be fixed." }),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                if (!params.reason) {
                    return txt({ ok: false, error: "Rejection reason is required." });
                }
                sessionTracker.setQaStatus("rejected");
                // Automatically return to work phase for fixes
                const wf = sessionTracker.workflow;
                if (wf.currentPhase !== "log") {
                    wf.completePhase(wf.currentPhase);
                    wf.enterPhase("work");
                    sessionTracker.trackAction("qa_rejected: returned to work");
                }
                logger.info("qa", `QA rejected: ${params.reason.substring(0, 200)}`);
                return txt({
                    ok: true,
                    message: `QA rejected: ${params.reason}. Returning to work phase for fixes.`,
                    qa_status: "rejected",
                    phase: "work",
                });
            },
        });
        // ═══════════════════════════════════════════════════════════
        //  TOOL — Generate Handoff
        // ═══════════════════════════════════════════════════════════
        api.registerTool({
            name: "orchestrator_generate_handoff",
            label: "Generate Handoff",
            description: "Generate a handoff/recovery document for the current task. Required before advancing to the finish phase.",
            parameters: Type.Object({}),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                const project = sessionTracker.currentProject;
                const task = sessionTracker.currentTask || "Unnamed task";
                if (!project) {
                    return txt({ ok: false, error: "No active project. Set context with orchestrator_set_context first." });
                }
                const projDir2 = projDir(project, dataDir);
                const loc = getProjectLocation(project, dataDir);
                const recPath = path.join(projDir2, "RECOVERY.md");
                const handoffContent = [
                    `# RECOVERY — ${project}`,
                    ``,
                    `**Generated:** ${new Date().toISOString()}`,
                    `**Session:** ${sessionTracker.sessionKey || "unknown"}`,
                    `**Agent:** ${sessionTracker.currentAgent}`,
                    `**Model:** ${sessionTracker.currentModel || "unknown"}`,
                    ``,
                    `## Task`,
                    ``,
                    task,
                    ``,
                    `## Workflow Progress`,
                    ``,
                    sessionTracker.workflow.getProgress(),
                    ``,
                    `## Files Touched`,
                    ``,
                    (sessionTracker.touchedFiles.length > 0 ? sessionTracker.touchedFiles.map(f => `- ${f}`).join("\n") : "(none)"),
                    ``,
                    `## QA Status`,
                    ``,
                    sessionTracker.getQaSummary() || "Not applicable",
                    ``,
                    `## Location`,
                    ``,
                    loc || "Not configured",
                    ``,
                    `## Data Directory`,
                    ``,
                    `\`${dataDir}\``,
                    ``,
                    `## Next Steps`,
                    ``,
                    `1. Verify the changes were applied correctly`,
                    `2. Run tests if applicable`,
                    `3. Commit changes to version control`,
                    `4. Update any relevant documentation`,
                ].join("\n");
                fs.writeFileSync(recPath, handoffContent, "utf-8");
                sessionTracker.markHandoffGenerated(recPath);
                logger.info("handoff", `Handoff document generated at ${recPath}`);
                return txt({
                    ok: true,
                    message: `Handoff document generated at ${recPath}`,
                    handoff_path: recPath,
                    handoff_generated: true,
                });
            },
        });
        // ═══════════════════════════════════════════════════════════
        //  NEXT TOOL — Create Project
        // ═══════════════════════════════════════════════════════════
        api.registerTool({
            name: "orchestrator_create_project",
            label: "Orchestrator Create Project",
            description: "Create a new project in orchestrator-data. Sets up the project directory, STATE.md, and dashboard-config.json entry. Returns the project info and a session spawn link.",
            parameters: Type.Object({
                name: Type.String({ description: "Project name (lowercase, hyphens/underscores only)." }),
                directory: Type.Optional(Type.String({ description: "Absolute path to the project directory on disk." })),
                description: Type.Optional(Type.String({ description: "Short description of what the project is for." })),
                spawn: Type.Optional(Type.Boolean({ description: "If true, also schedule an immediate isolated session for this project." })),
                spawn_task: Type.Optional(Type.String({ description: "Initial task description for the spawned session." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                const projectName = (params.name || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
                if (!projectName || projectName.length < 2) {
                    return txt({ ok: false, error: "Invalid project name. Use lowercase letters, numbers, hyphens, or underscores." });
                }
                const projDir2 = path.join(dataDir, "projects", projectName);
                if (fs.existsSync(projDir2)) {
                    return txt({ ok: false, error: `Project "${projectName}" already exists in orchestrator-data.` });
                }
                fs.mkdirSync(projDir2, { recursive: true });
                // Write project_created state event (append-only, no overwrites)
                writeStateEvent(projectName, dataDir, {
                    type: "project_created",
                    description: params.description || null,
                    version: "0.0.1",
                    location: params.directory || null,
                });
                // Generate initial STATE.md from event log
                generateStateFromEvents(projectName, dataDir, logger);
                // Create dashboard-config.json entry
                const configPath = path.join(dataDir, "dashboard-config.json");
                let cfg = {};
                try {
                    if (fs.existsSync(configPath)) {
                        cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
                    }
                }
                catch { /* */ }
                if (!cfg.projects)
                    cfg.projects = {};
                cfg.projects[projectName] = {
                    location: params.directory || null,
                    workflow: { enabled: true },
                };
                writeJSON(configPath, cfg);
                logger.info("project", `Created project: ${projectName}${params.directory ? " @ " + params.directory : ""}`);
                // If spawn requested, schedule an immediate isolated session
                let spawnInfo = null;
                if (params.spawn) {
                    const spawnTask = params.spawn_task || `Start working on project "${projectName}" — set up the environment, understand the codebase, and begin development.`;
                    try {
                        // Create an immediate cron job that spawns an isolated session
                        const spawnMarker = path.join(projDir2, ".SPAWN_PENDING");
                        fs.writeFileSync(spawnMarker, JSON.stringify({
                            project: projectName,
                            task: spawnTask,
                            created_at: new Date().toISOString(),
                            spawned: false,
                        }), "utf-8");
                        spawnInfo = {
                            scheduled: true,
                            task: spawnTask,
                            note: "Session spawn marker created. A dedicated session will be available shortly. Use orchestrator_join_project to start working.",
                        };
                    }
                    catch (e) {
                        logger.warn("project", `Spawn scheduling failed: ${e.message}`);
                    }
                }
                return txt({
                    ok: true,
                    project: projectName,
                    directory: params.directory || null,
                    description: params.description || null,
                    state_md: path.join(projDir2, "STATE.md"),
                    spawn: spawnInfo,
                    message: `Project "${projectName}" created. ${params.directory ? `Location: ${params.directory}` : ""} Call orchestrator_set_context to start working, or orchestrator_join_project if you're in a different session.`,
                });
            },
        });
        // ═══════════════════════════════════════════════════════════
        //  QUICK ACTION TOOLS — spawn isolated subagent sessions with
        //  preset prompts for common project tasks
        // ═══════════════════════════════════════════════════════════
        // ── Helper: spawn a quick-action subagent with a unique session key ──
        async function quickActionSpawn(taskName, prompt, model) {
            const project = sessionTracker.currentProject;
            const parentKey = sessionTracker.sessionKey;
            if (!parentKey || !project) {
                return { ok: false, error: "No active project context. Set project context first." };
            }
            try {
                const sessionKey = `agent:main:subagent:orch-${taskName}-${crypto.randomUUID()}`;
                const result = await api.runtime.subagent.run({
                    sessionKey,
                    message: prompt,
                    model: model || undefined,
                    lightContext: true,
                });
                logger.info("quickaction", `${taskName} spawned: runId=${result.runId}, sessionKey=${sessionKey}`);
                return { ok: true, runId: result.runId, sessionKey };
            }
            catch (err) {
                logger.error("quickaction", `${taskName} spawn failed: ${err.message}`);
                return { ok: false, error: err.message };
            }
        }
        // ── State event log functions are defined at module level ──
        // (These are available to both the register closure and MaintenanceService)
        // ── Quick Action: Grill Me With Docs ───────────────────────
        api.registerTool({
            name: "orchestrator_grill_with_docs",
            label: "Grill Me With Docs",
            description: "Spawns a subagent that reads all project documentation and quizzes you on it — sharpens project understanding and catches knowledge gaps.",
            parameters: Type.Object({
                topic: Type.Optional(Type.String({ description: "Optional specific topic or area to focus on." })),
                model: Type.Optional(Type.String({ description: "Optional model override for the subagent." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                if (!sessionTracker.currentProject) {
                    return txt({ ok: false, error: "No active project. Set project context first." });
                }
                const topic = params.topic ? `
Focus specifically on: ${params.topic}` : "";
                const prompt = [
                    `[Quick Action: Grill Me With Docs — Auto-spawned by Orchestrator Plugin]`,
                    `Project: ${sessionTracker.currentProject}`,
                    `Parent Session: ${sessionTracker.sessionKey}`,
                    ``,
                    `You are a project documentation examiner.`,
                    `1. Read ALL project documentation files (STATE.md, CONTEXT.md, ADRs, ROADMAP.md, README, tests, source code headers).`,
                    `2. Formulate 5-10 probing questions about the project's architecture, decisions, trade-offs, and blind spots.`,
                    `3. Present ONE question at a time, wait for the user's answer, then give feedback and move to the next.`,
                    `4. After all questions, provide a summary of what was well-understood and what needs attention.`,
                    `${topic}`,
                    ``,
                    `Be tough but fair. The goal is to catch knowledge gaps before they cause mistakes.`,
                ].filter(Boolean).join("\n");
                const result = await quickActionSpawn("grill", prompt, params.model);
                if (!result.ok)
                    return txt({ ok: false, error: result.error });
                return txt({
                    ok: true,
                    action: "grill_with_docs",
                    run_id: result.runId,
                    session_key: result.sessionKey,
                    message: "📚 Grill session spawned! The examiner is reading your project docs and will start quizzing you shortly. Reply in the spawned session.",
                });
            },
        });
        // ── Quick Action: Clean Up & Organize Docs ────────────────
        api.registerTool({
            name: "orchestrator_cleanup_docs",
            label: "Clean Up & Organize Docs",
            description: "Spawns a subagent that reads, cleans up, organizes, and updates project documentation — fixing broken links, stale content, and filling gaps.",
            parameters: Type.Object({
                scope: Type.Optional(Type.String({ description: "Optional scope: 'all' (default), 'readme', 'adrs', 'docs', 'tests'." })),
                model: Type.Optional(Type.String({ description: "Optional model override for the subagent." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                if (!sessionTracker.currentProject) {
                    return txt({ ok: false, error: "No active project. Set project context first." });
                }
                const scope = params.scope || "all";
                const prompt = [
                    `[Quick Action: Clean Up & Organize Docs — Auto-spawned by Orchestrator Plugin]`,
                    `Project: ${sessionTracker.currentProject}`,
                    `Parent Session: ${sessionTracker.sessionKey}`,
                    ``,
                    `You are a documentation specialist. Your job is to review, clean up, organize, and improve project documentation.`,
                    ``,
                    `Scope: ${scope}`,
                    ``,
                    `1. READ all existing documentation files and understand the current state.`,
                    `2. Identify: broken links, stale/outdated content, missing sections, inconsistent formatting.`,
                    `3. Fix issues and update files as needed.`,
                    `4. Create new documentation files if important gaps are found.`,
                    `5. Report a summary of what was changed and why.`,
                    ``,
                    `Focus on accuracy and clarity. Do NOT change technical content — only documentation quality.`,
                ].filter(Boolean).join("\n");
                const result = await quickActionSpawn("cleanup-docs", prompt, params.model);
                if (!result.ok)
                    return txt({ ok: false, error: result.error });
                return txt({
                    ok: true,
                    action: "cleanup_docs",
                    run_id: result.runId,
                    session_key: result.sessionKey,
                    message: "📝 Documentation cleanup spawned! The docs specialist is reviewing and improving your project docs.",
                });
            },
        });
        // ── Quick Action: Set Up Unit Tests ───────────────────────
        api.registerTool({
            name: "orchestrator_setup_unit_tests",
            label: "Set Up Unit Tests",
            description: "Spawns a subagent that sets up unit test infrastructure (framework, config, CI) and creates initial tests for existing code.",
            parameters: Type.Object({
                framework: Type.Optional(Type.String({ description: "Test framework: 'vitest' (default), 'jest', 'mocha', 'pytest', etc." })),
                model: Type.Optional(Type.String({ description: "Optional model override for the subagent." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                if (!sessionTracker.currentProject) {
                    return txt({ ok: false, error: "No active project. Set project context first." });
                }
                const framework = params.framework || "vitest";
                const prompt = [
                    `[Quick Action: Set Up Unit Tests — Auto-spawned by Orchestrator Plugin]`,
                    `Project: ${sessionTracker.currentProject}`,
                    `Parent Session: ${sessionTracker.sessionKey}`,
                    ``,
                    `You are a test infrastructure engineer. Set up unit testing for this project.`,
                    ``,
                    `Framework: ${framework}`,
                    ``,
                    `1. Check if ${framework} is already configured. If not, install and configure it.`,
                    `2. Set up the test configuration file (vitest.config.ts, jest.config.js, etc.).`,
                    `3. Examine the project's source code structure.`,
                    `4. Create initial unit tests for existing modules (focus on the most critical/logical parts of the codebase).`,
                    `5. Set up a test script in package.json.`,
                    `6. Run the test suite and fix any failures.`,
                    `7. Report: what was set up, what was tested, pass rate, and recommendations.`,
                ].filter(Boolean).join("\n");
                const result = await quickActionSpawn("setup-unit-tests", prompt, params.model);
                if (!result.ok)
                    return txt({ ok: false, error: result.error });
                return txt({
                    ok: true,
                    action: "setup_unit_tests",
                    run_id: result.runId,
                    session_key: result.sessionKey,
                    message: `🧪 Unit test setup spawned! Setting up ${framework} for your project.`,
                });
            },
        });
        // ── Quick Action: Set Up E2E Tests ────────────────────────
        api.registerTool({
            name: "orchestrator_setup_e2e_tests",
            label: "Set Up E2E Tests",
            description: "Spawns a subagent that sets up end-to-end test infrastructure and creates initial E2E test scenarios.",
            parameters: Type.Object({
                framework: Type.Optional(Type.String({ description: "Framework: 'playwright' (default), 'cypress', 'puppeteer', etc." })),
                model: Type.Optional(Type.String({ description: "Optional model override for the subagent." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                if (!sessionTracker.currentProject) {
                    return txt({ ok: false, error: "No active project. Set project context first." });
                }
                const framework = params.framework || "playwright";
                const prompt = [
                    `[Quick Action: Set Up E2E Tests — Auto-spawned by Orchestrator Plugin]`,
                    `Project: ${sessionTracker.currentProject}`,
                    `Parent Session: ${sessionTracker.sessionKey}`,
                    ``,
                    `You are a test infrastructure engineer. Set up E2E testing for this project.`,
                    ``,
                    `Framework: ${framework}`,
                    ``,
                    `1. Check if ${framework} is already configured. If not, install and configure it.`,
                    `2. Set up the test configuration file.`,
                    `3. Understand the project: what does it serve? What are the critical user journeys?`,
                    `4. Create E2E test scenarios covering the most important flows.`,
                    `5. Set up test scripts in package.json.`,
                    `6. Run the tests and fix any issues.`,
                    `7. Report: what was set up, test scenarios created, pass rate, and recommendations.`,
                ].filter(Boolean).join("\n");
                const result = await quickActionSpawn("setup-e2e-tests", prompt, params.model);
                if (!result.ok)
                    return txt({ ok: false, error: result.error });
                return txt({
                    ok: true,
                    action: "setup_e2e_tests",
                    run_id: result.runId,
                    session_key: result.sessionKey,
                    message: `🎭 E2E test setup spawned! Setting up ${framework} for your project.`,
                });
            },
        });
        // ── Quick Action: Debug Issue ─────────────────────────────
        api.registerTool({
            name: "orchestrator_debug_issue",
            label: "Debug Issue",
            description: "Spawns a subagent to investigate and help fix a specific bug or issue in the project.",
            parameters: Type.Object({
                issue_description: Type.String({ description: "Describe the bug or issue — what's happening, what should happen, reproduction steps." }),
                model: Type.Optional(Type.String({ description: "Optional model override for the subagent." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                if (!sessionTracker.currentProject) {
                    return txt({ ok: false, error: "No active project. Set project context first." });
                }
                if (!params.issue_description) {
                    return txt({ ok: false, error: "Issue description is required." });
                }
                const prompt = [
                    `[Quick Action: Debug Issue — Auto-spawned by Orchestrator Plugin]`,
                    `Project: ${sessionTracker.currentProject}`,
                    `Parent Session: ${sessionTracker.sessionKey}`,
                    ``,
                    `You are a debugging specialist. Investigate and fix the following issue:`,
                    ``,
                    `## Issue Description`,
                    params.issue_description,
                    ``,
                    `## Instructions`,
                    `1. Understand the project codebase and the reported issue.`,
                    `2. Reproduce the issue if possible (check logs, run the code, inspect state).`,
                    `3. Identify the root cause.`,
                    `4. Implement a fix.`,
                    `5. Verify the fix works.`,
                    `6. Report: root cause, fix applied, verification results, and any related concerns.`,
                ].filter(Boolean).join("\n");
                const result = await quickActionSpawn("debug-issue", prompt, params.model);
                if (!result.ok)
                    return txt({ ok: false, error: result.error });
                return txt({
                    ok: true,
                    action: "debug_issue",
                    run_id: result.runId,
                    session_key: result.sessionKey,
                    message: "🐛 Debug spawned! The debugging specialist is investigating your issue.",
                });
            },
        });
        // ── Quick Action: Create New Functionality ────────────────
        api.registerTool({
            name: "orchestrator_create_functionality",
            label: "Create New Functionality",
            description: "Spawns a subagent to design and implement new features or functionality in the project.",
            parameters: Type.Object({
                description: Type.String({ description: "Describe the new functionality — what it should do, requirements, constraints, and any relevant context." }),
                model: Type.Optional(Type.String({ description: "Optional model override for the subagent." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                if (!sessionTracker.currentProject) {
                    return txt({ ok: false, error: "No active project. Set project context first." });
                }
                if (!params.description) {
                    return txt({ ok: false, error: "Functionality description is required." });
                }
                const prompt = [
                    `[Quick Action: Create New Functionality — Auto-spawned by Orchestrator Plugin]`,
                    `Project: ${sessionTracker.currentProject}`,
                    `Parent Session: ${sessionTracker.sessionKey}`,
                    ``,
                    `You are a feature development engineer. Design and implement the following new functionality:`,
                    ``,
                    `## Requirements`,
                    params.description,
                    ``,
                    `## Instructions`,
                    `1. Understand the existing project architecture and codebase.`,
                    `2. Design a solution that fits the existing patterns and conventions.`,
                    `3. Implement the functionality following project coding standards.`,
                    `4. Add tests for the new code.`,
                    `5. Verify everything works (build, test, lint).`,
                    `6. Report: what was built, architecture decisions, test results, and any follow-up tasks.`,
                ].filter(Boolean).join("\n");
                const result = await quickActionSpawn("create-functionality", prompt, params.model);
                if (!result.ok)
                    return txt({ ok: false, error: result.error });
                return txt({
                    ok: true,
                    action: "create_functionality",
                    run_id: result.runId,
                    session_key: result.sessionKey,
                    message: "🚀 Feature development spawned! The engineer is designing and implementing your new functionality.",
                });
            },
        });
        // ═══════════════════════════════════════════════════════════
        //  DOC DRIFT FIXER — scans project docs and corrects stale
        //  tool counts, test numbers, version references, etc.
        // ═══════════════════════════════════════════════════════════
        api.registerTool({
            name: "orchestrator_fix_docs_drift",
            label: "Fix Docs Drift",
            description: "Scans project documentation for stale version numbers, tool counts, test counts, and other drift. Updates STATE.md, CONTEXT.md, ROADMAP.md, and README.md to match current project state.",
            parameters: Type.Object({
                project: Type.Optional(Type.String({ description: "Project name. Omit to use current project context." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                const project = params.project || sessionTracker.currentProject;
                if (!project) {
                    return txt({ ok: false, error: "No project specified and no active project context." });
                }
                const fixes = [];
                const projDataDir = projDir(project, dataDir);
                const srcDir = getProjectLocation(project, dataDir);
                // Write doc_synced event + update event log + regenerate STATE.md
                writeStateEvent(project, dataDir, { type: "doc_synced", auto: false, tool: "fix_docs_drift" });
                snapshotState(project, dataDir, logger);
                // Snapshot already regenerated STATE.md, now fix remaining files
                // (CONTEXT.md, README, ROADMAP are NOT event-generated — fix inline)
                let toolCount = 0;
                let testCount = 0;
                let version = "";
                if (srcDir && fs.existsSync(srcDir)) {
                    try {
                        const srcPath = path.join(srcDir, "src", "index.ts");
                        if (fs.existsSync(srcPath)) {
                            const content = fs.readFileSync(srcPath, "utf-8");
                            const toolMatches = content.match(/api\.registerTool\(\{/g);
                            if (toolMatches) {
                                // Subtract comment references (they contain "api.registerTool" in comments)
                                // Actual tool registrations start after the // ── line separating Metadata from register()
                                toolCount = countRegisteredTools(content);
                            }
                        }
                        const testDir = path.join(srcDir, "tests");
                        if (fs.existsSync(testDir)) {
                            testCount = fs.readdirSync(testDir).filter(f => f.endsWith(".test.ts") || f.endsWith(".test.js") || f.endsWith(".test.tsx")).length;
                        }
                        const pkgPath = path.join(srcDir, "package.json");
                        if (fs.existsSync(pkgPath)) {
                            try {
                                const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
                                version = pkg.version || "";
                            }
                            catch { /* */ }
                        }
                    }
                    catch { /* */ }
                }
                // Fix CONTEXT.md badges
                const contextPath = path.join(projDataDir, "CONTEXT.md");
                if (fs.existsSync(contextPath)) {
                    let ctx = fs.readFileSync(contextPath, "utf-8");
                    const originalCtx = ctx;
                    if (version) {
                        ctx = ctx.replace(/version-(\d+\.\d+\.\d+)/g, `version-${version}`);
                        ctx = ctx.replace(/version (\d+\.\d+\.\d+)/gi, `version ${version}`);
                    }
                    if (toolCount > 0)
                        ctx = ctx.replace(/(\d+)\s+tools/gi, `${toolCount} tools`);
                    if (ctx !== originalCtx) {
                        fs.writeFileSync(contextPath, ctx, "utf-8");
                        fixes.push(`CONTEXT.md: updated version/tool counts`);
                    }
                }
                // Fix README badges
                if (srcDir && fs.existsSync(srcDir)) {
                    const readmePath = path.join(srcDir, "README.md");
                    if (fs.existsSync(readmePath)) {
                        let readme = fs.readFileSync(readmePath, "utf-8");
                        const originalReadme = readme;
                        if (version) {
                            readme = readme.replace(/version-(\d+\.\d+\.\d+)/g, `version-${version}`);
                            readme = readme.replace(/badge\/version-(\d+\.\d+\.\d+)/g, `badge/version-${version}`);
                        }
                        if (toolCount > 0)
                            readme = readme.replace(/tools-(\d+)/g, `tools-${toolCount}`);
                        if (readme !== originalReadme) {
                            fs.writeFileSync(readmePath, readme, "utf-8");
                            fixes.push(`README.md: updated version/tool badges`);
                        }
                    }
                }
                // Fix ROADMAP.md
                const roadPath = path.join(projDataDir, "ROADMAP.md");
                if (fs.existsSync(roadPath)) {
                    let road = fs.readFileSync(roadPath, "utf-8");
                    const originalRoad = road;
                    let roadChanged = false;
                    if (version) {
                        const nr = road.replace(/v(\d+\.\d+\.\d+)/g, `v${version}`);
                        if (nr !== road)
                            roadChanged = true;
                        road = nr;
                    }
                    if (toolCount > 0) {
                        const nr = road.replace(/(\d+)\s+tools/gi, `${toolCount} tools`);
                        if (nr !== road)
                            roadChanged = true;
                        road = nr;
                    }
                    if (roadChanged) {
                        fs.writeFileSync(roadPath, road, "utf-8");
                        fixes.push(`ROADMAP.md: updated version/tool references`);
                    }
                }
                if (fixes.length === 0) {
                    return txt({ ok: true, project, message: "✅ No non-generated docs needed fixing.", fixes: [] });
                }
                logger.info("docs", `Drift fixed for ${project}: ${fixes.join(", ")}`);
                return txt({
                    ok: true,
                    project,
                    message: `📝 Fixed ${fixes.length} doc drift(s) for "${project}". (STATE.md auto-regenerated via event log.)`,
                    fixes,
                });
            },
        });
        // ═══════════════════════════════════════════════════════════
        //  GENERATE STATE — reads state-events.jsonl, produces STATE.md
        // ═══════════════════════════════════════════════════════════
        api.registerTool({
            name: "orchestrator_regenerate_state",
            label: "Regenerate State",
            description: "Regenerate STATE.md from the project state event log (state-events.jsonl). No LLM involved — computed from actual events. Safe for concurrent writers since events are append-only.",
            parameters: Type.Object({
                project: Type.Optional(Type.String({ description: "Project name. Omit to use current project context." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                const project = params.project || sessionTracker.currentProject;
                if (!project) {
                    return txt({ ok: false, error: "No project specified and no active project context." });
                }
                // Snapshot current state first
                snapshotState(project, dataDir, logger);
                const result = generateStateFromEvents(project, dataDir, logger);
                if (result.generated) {
                    return txt({
                        ok: true,
                        project,
                        message: `📊 Regenerated STATE.md for "${project}" from event log.`,
                        stats: result.stats,
                    });
                }
                return txt({ ok: false, error: `Failed to regenerate STATE.md for "${project}".` });
            },
        });
        // ═══════════════════════════════════════════════════════════
        //  BACKGROUND MAINTENANCE
        // ═══════════════════════════════════════════════════════════
        if (maintenanceSvc)
            maintenanceSvc.stop();
        maintenanceSvc = new MaintenanceService(dataDir, logger);
        maintenanceSvc.start(cfg.maintenanceIntervalMs || 30 * 60_000);
        const hostname = execSync("hostname", { encoding: "utf-8", timeout: 3000 }).trim();
        const dashPort = cfg.dashboardPort || 8767;
        let tailscaleHost = "";
        try {
            tailscaleHost = execSync("tailscale status 2>/dev/null | head -1 | awk '{print $2}'", { encoding: "utf-8", timeout: 3000 }).trim();
        }
        catch { /* tailscale not available */ }
        if (!tailscaleHost)
            tailscaleHost = hostname;
        // Shared: quick counts
        let modelCount = 0, sessionCount = 0;
        try {
            const mf = path.join(dataDir, "models.json");
            if (fs.existsSync(mf))
                modelCount = JSON.parse(fs.readFileSync(mf, "utf-8")).models?.length || 0;
            const sf = path.join(dataDir, "session_log.md");
            if (fs.existsSync(sf))
                sessionCount = fs.readFileSync(sf, "utf-8").split("\n").filter(l => l.startsWith("|") && !l.includes("Date") && !l.includes("---")).length;
        }
        catch { /* */ }
        //  SLASH COMMANDS
        //  Individually registered for Discord autocomplete:
        //    /genor-COMMAND — all orchestrator slash commands
        //    /genor-dashboard — dashboard URL
        //    /genor-status — quick status
        //    /genor-help — command reference
        //    /genor-git-commit — git commit + versioning
        //    /genor-doctor — diagnose and fix issues
        api.registerCommand({
            name: "genor-dashboard",
            description: "Show GenorBoard dashboard URL",
            requireAuth: false,
            handler: () => ({
                text: `**\U0001f3e0 GenorBoard**\n\n**URL:** http://${tailscaleHost}:${dashPort}\n**Port:** ${dashPort}\n**Data:** ${dataDir}`,
                continueAgent: false,
            }),
        });
        api.registerCommand({
            name: "genor-status",
            description: "Quick orchestrator status overview",
            requireAuth: false,
            handler: () => ({
                text: [
                    "**\U0001f4ca Genor's Orchestrator \u2014 Status**",
                    "**Dashboard:** https://${tailscaleHost}/orchestrator (via gateway)",
                    "**Host:** ${hostname} (Tailscale: ${tailscaleHost})",
                    "**Port:** ${dashPort}",
                    "**Models:** ${modelCount}  **Sessions:** ${sessionCount}",
                    "**Data:** ${dataDir}",
                ].join("\n"),
                continueAgent: false,
            }),
        });
        api.registerCommand({
            name: "genor-help",
            description: "List all /genor-* commands",
            requireAuth: false,
            handler: () => ({
                text: [
                    "**\U0001f3e0 GenorBoard \u2014 Available Commands**",
                    "",
                    "**/genor-help** \u2014 This list",
                    "**/genor-doctor** \u2014 Diagnose and fix orchestrator issues",
                    "**/genor-dashboard** \u2014 Dashboard URL",
                    "**/genor-status** \u2014 Quick status overview",
                    "**/genor-git-commit** \u2014 Commit project changes with versioning",
                    "",
                    "Dashboard: https://${tailscaleHost}/orchestrator (via gateway)",
                ].join("\n"),
                continueAgent: false,
            }),
        });
        api.registerCommand({
            name: "genor-git-commit",
            description: "Git commit + version bump for the current project",
            requireAuth: false,
            handler: () => {
                try {
                    const proj = sessionTracker.currentProject;
                    if (!proj) {
                        return { text: "**\u26a0 No project context.** Set context first with `/genor-set-context project=... task=...` or use `orchestrator_set_context`.", continueAgent: false };
                    }
                    const loc = getProjectLocation(proj, dataDir);
                    if (!loc || !fs.existsSync(path.join(loc, ".git"))) {
                        return { text: `**\u26a0 ${proj}** has no git repo at \`${loc}\`. Cannot commit.`, continueAgent: false };
                    }
                    // Check git status
                    const statusRaw = execSync("git status --porcelain", { cwd: loc, encoding: "utf-8", timeout: 10000 });
                    const changed = statusRaw.trim().split("\n").filter(Boolean);
                    if (changed.length === 0) {
                        return { text: `**\u2705 ${proj}** \u2014 nothing to commit, working tree clean.`, continueAgent: false };
                    }
                    // Read current version from package.json
                    let currentVersion = "0.0.0";
                    const pj = path.join(loc, "package.json");
                    if (fs.existsSync(pj)) {
                        try {
                            currentVersion = JSON.parse(fs.readFileSync(pj, "utf-8")).version || "0.0.0";
                        }
                        catch { }
                    }
                    // Bump patch version
                    const parts = currentVersion.split(".").map(Number);
                    parts[2] = (parts[2] || 0) + 1;
                    const newVersion = parts.join(".");
                    // Update package.json with new version
                    if (fs.existsSync(pj)) {
                        const pkg = JSON.parse(fs.readFileSync(pj, "utf-8"));
                        pkg.version = newVersion;
                        fs.writeFileSync(pj, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
                    }
                    // Generate commit message from status
                    const added = changed.filter(l => l.startsWith("?")).length;
                    const modified = changed.filter(l => l.startsWith(" M") || l.startsWith("M ")).length;
                    const deleted = changed.filter(l => l.startsWith(" D") || l.startsWith("D ")).length;
                    const summary = [
                        modified > 0 ? `${modified} modified` : "",
                        added > 0 ? `${added} added` : "",
                        deleted > 0 ? `${deleted} deleted` : "",
                    ].filter(Boolean).join(", ");
                    const commitMsg = `v${newVersion}: auto-commit (${summary || "changes"})`;
                    // Git operations
                    execSync("git add -A", { cwd: loc, encoding: "utf-8", timeout: 30000 });
                    execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { cwd: loc, encoding: "utf-8", timeout: 30000 });
                    execSync(`git tag v${newVersion}`, { cwd: loc, encoding: "utf-8", timeout: 10000 });
                    // Try push (may fail if no remote)
                    let pushResult = "";
                    try {
                        pushResult = execSync("git push --tags 2>&1", { cwd: loc, encoding: "utf-8", timeout: 30000 });
                    }
                    catch (e) {
                        pushResult = "Push skipped: " + (e.message || "no remote");
                    }
                    return {
                        text: [
                            `**\u2705 Committed v${newVersion} \u2014 ${proj}**`,
                            `**Repository:** \`${loc}\``,
                            `**Changes:** ${changed.length} files (${summary})`,
                            `**Message:** ${commitMsg}`,
                            `**Push:** ${pushResult.includes("*") ? "\u2705 pushed" : "\u26a0 " + pushResult}`,
                        ].join("\n"),
                        continueAgent: false,
                    };
                }
                catch (e) {
                    return { text: `**\u274c Git commit failed:** ${e.message}`, continueAgent: false };
                }
            },
        });
        api.registerCommand({
            name: "genor-doctor",
            description: "Diagnose and optionally fix orchestrator issues (session keys, registration, PM2, data health)",
            requireAuth: false,
            handler: () => {
                try {
                    const hk = sessionTracker.sessionKey;
                    const issues = [];
                    // Session key check
                    if (!hk)
                        issues.push("No session key set.");
                    else if (!sessionTracker.isSessionRegistered(hk))
                        issues.push("Session not registered. Call orchestrator_register.");
                    // Context check
                    const ctx = hk ? sessionTracker.getSessionContext(hk) : null;
                    if (!ctx)
                        issues.push("No project context set. Use orchestrator_set_context.");
                    // Log age check
                    const logPath = path.join(dataDir, "logs", "orchestrator.jsonl");
                    if (fs.existsSync(logPath)) {
                        const stat = fs.statSync(logPath);
                        const ageHrs = (Date.now() - stat.mtimeMs) / 3600000;
                        if (ageHrs > 24)
                            issues.push("Log file stale (" + ageHrs.toFixed(1) + "h).");
                    }
                    else
                        issues.push("Log file missing.");
                    // Gateway health — PM2 bridge is legacy, plugin runs inside OpenClaw
                    try {
                        const pm2Out = execSync("pm2 jlist 2>/dev/null", { encoding: "utf-8", timeout: 3000 });
                        const procs = JSON.parse(pm2Out);
                        const br = procs.find((p) => p.name === "genor-bridge" || p.name === "gateway-ws-bridge" || p.name === "gw-ws-bridge" || (p.pm2_env?.name?.includes("bridge")));
                        if (br && br.pm2_env?.status !== "online")
                            issues.push("Legacy PM2 bridge is " + (br.pm2_env?.status || "unknown") + " (expected for plugin deployments).");
                    }
                    catch { /* PM2 not available — expected */ }
                    const lines = ["**\uD83D\uDC8A Genor Orchestrator Doctor**"];
                    if (issues.length === 0) {
                        lines.push("", "**\u2705 All checks passed.**", "", "Session: " + hk);
                    }
                    else {
                        lines.push("", "**" + issues.length + " issue(s) found:**", "");
                        for (const iss of issues)
                            lines.push(iss);
                        lines.push("", "**Tip:** Use orchestrator_doctor (tool) with fix=true to auto-repair.");
                    }
                    return { text: lines.join("\n"), continueAgent: false };
                }
                catch (e) {
                    return { text: "**\u274c Doctor error:** " + e.message, continueAgent: false };
                }
            },
        });
        // ── Dashboard HTTP handler — serve dashboard through gateway ──
        // Follows the same pattern as built-in plugins (canvas, admin-http-rpc, webhooks)
        try {
            const dashHandler = createDashboardHandler(api);
            // Dashboard UI + API: auth:"plugin" for static serving, file ops
            api.registerHttpRoute({
                path: "/orchestrator",
                auth: "plugin",
                match: "prefix",
                handler: dashHandler,
            });
            logger.info("plugin", "Dashboard handler registered at /orchestrator");
            // Spawns are drained by the before_prompt_build hook (has operator.write scope)
        }
        catch (dhErr) {
            logger.warn("plugin", "Dashboard route registration failed: " + (dhErr?.message || String(dhErr)));
        }
        logger.info("plugin", `Orchestrator ready — ${logLevel} logging, maintenance active, ${Object.keys(TOOL_NAMES).length} tools, 5 slash commands`);
    },
});
// ═══════════════════════════════════════════════════════════════
//  EXPORT — with defineToolPlugin metadata for OpenClaw 2026.6.6+ compat
// ═══════════════════════════════════════════════════════════════
const pluginExport = Object.assign(_plugin, {
    __openclaw: {
        compat: { pluginApi: "0.1.0" },
        build: { openclawVersion: ">=2026.5.17" },
    },
});
Object.defineProperty(pluginExport, toolPluginMetadataSymbol, {
    value: {
        id: PLUGIN_ID,
        name: "Genor's Orchestrator",
        description: "Model routing, session logging, project management, dashboard, hooks, and context injection.",
        activation: { onStartup: true },
        configSchema: {
            type: "object",
            properties: {
                orchestratorDataDir: { type: "string", description: "Override data directory path" },
                logLevel: { type: "string", description: "Log level: debug, info, warn, error. (default: info)" },
                logRetentionDays: { type: "number", description: "Log retention in days. (default: 30)" },
                dashboardPort: { type: "number", description: "Dashboard web UI port (default: 8766)" },
                maintenanceIntervalMs: { type: "number", description: "Background maintenance interval in ms. (default: 1800000 = 30min)" },
            },
        },
        tools: TOOL_METADATA.map(t => ({
            name: t.name,
            label: t.label,
            description: t.description,
            parameters: t.parameters,
        })),
    },
    enumerable: false,
});
export default pluginExport;
