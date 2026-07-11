// ═══════════════════════════════════════════════════════════════
//  SESSION TRACKER
// ═══════════════════════════════════════════════════════════════
import { WorkflowTracker } from "./workflow.js";
export function newSessionState() {
    return {
        currentProject: null,
        currentTask: null,
        currentModel: null,
        currentModelProvider: null,
        currentAgent: "Amy",
        sessionStartTimestamp: Date.now(),
        sessionKey: null,
        subagentDepth: 0,
        currentAction: null,
        currentFile: null,
        agentStatus: "idle",
        touchedFiles: [],
        actionHistory: [],
        tokenUsage: { input: 0, output: 0, total: 0 },
        lastError: null,
        lastActivityTimestamp: Date.now(),
        errorCount: 0,
        loggedTaskCompletion: false,
        qaStatus: "none",
        qaFindings: [],
        qaApprovedAt: null,
        qaRejectedAt: null,
        qaRejectReason: null,
        qaHistory: [],
        handoffGenerated: false,
        handoffPath: null,
        workflow: new WorkflowTracker(),
    };
}
export class SessionTracker {
    // Per-session state map — keyed by sessionKey
    _states = new Map();
    // Fallback for operations before a session key is assigned
    _fallback = newSessionState();
    // Active session key — stored separately to avoid circular getter/setter dependency
    _activeSessionKey = null;
    /** Resolve per-session state for the current active session key. */
    get _s() {
        if (this._activeSessionKey !== null && this._states.has(this._activeSessionKey)) {
            return this._states.get(this._activeSessionKey);
        }
        return this._fallback;
    }
    // ── Per-session scalar field delegates ──
    get currentProject() { return this._s.currentProject; }
    set currentProject(v) { this._s.currentProject = v; }
    get currentTask() { return this._s.currentTask; }
    set currentTask(v) { this._s.currentTask = v; }
    get currentModel() { return this._s.currentModel; }
    set currentModel(v) { this._s.currentModel = v; }
    get currentModelProvider() { return this._s.currentModelProvider; }
    set currentModelProvider(v) { this._s.currentModelProvider = v; }
    get currentAgent() { return this._s.currentAgent; }
    set currentAgent(v) { this._s.currentAgent = v; }
    get sessionStartTimestamp() { return this._s.sessionStartTimestamp; }
    set sessionStartTimestamp(v) { this._s.sessionStartTimestamp = v; }
    get sessionKey() { return this._activeSessionKey; }
    set sessionKey(v) { this._activeSessionKey = v; this._fallback.sessionKey = v; }
    get subagentDepth() { return this._s.subagentDepth; }
    set subagentDepth(v) { this._s.subagentDepth = v; }
    get currentAction() { return this._s.currentAction; }
    set currentAction(v) { this._s.currentAction = v; }
    get currentFile() { return this._s.currentFile; }
    set currentFile(v) { this._s.currentFile = v; }
    get agentStatus() { return this._s.agentStatus; }
    set agentStatus(v) { this._s.agentStatus = v; }
    get touchedFiles() { return this._s.touchedFiles; }
    set touchedFiles(v) { this._s.touchedFiles = v; }
    get actionHistory() { return this._s.actionHistory; }
    set actionHistory(v) { this._s.actionHistory = v; }
    get tokenUsage() { return this._s.tokenUsage; }
    set tokenUsage(v) { this._s.tokenUsage = v; }
    get lastError() { return this._s.lastError; }
    set lastError(v) { this._s.lastError = v; }
    get lastActivityTimestamp() { return this._s.lastActivityTimestamp; }
    set lastActivityTimestamp(v) { this._s.lastActivityTimestamp = v; }
    get errorCount() { return this._s.errorCount; }
    set errorCount(v) { this._s.errorCount = v; }
    get loggedTaskCompletion() { return this._s.loggedTaskCompletion; }
    set loggedTaskCompletion(v) { this._s.loggedTaskCompletion = v; }
    get qaStatus() { return this._s.qaStatus; }
    set qaStatus(v) { this._s.qaStatus = v; }
    get qaFindings() { return this._s.qaFindings; }
    set qaFindings(v) { this._s.qaFindings = v; }
    get qaApprovedAt() { return this._s.qaApprovedAt; }
    set qaApprovedAt(v) { this._s.qaApprovedAt = v; }
    get qaRejectedAt() { return this._s.qaRejectedAt; }
    set qaRejectedAt(v) { this._s.qaRejectedAt = v; }
    get qaRejectReason() { return this._s.qaRejectReason; }
    set qaRejectReason(v) { this._s.qaRejectReason = v; }
    get qaHistory() { return this._s.qaHistory; }
    set qaHistory(v) { this._s.qaHistory = v; }
    get handoffGenerated() { return this._s.handoffGenerated; }
    set handoffGenerated(v) { this._s.handoffGenerated = v; }
    get handoffPath() { return this._s.handoffPath; }
    set handoffPath(v) { this._s.handoffPath = v; }
    get workflow() { return this._s.workflow; }
    set workflow(v) { this._s.workflow = v; }
    // Per-session project contexts — keyed by sessionKey.
    // A session only gets project context injected if it explicitly
    // registered via genorch_session_start_work. This prevents project
    // context from bleeding between unrelated sessions.
    sessionContexts = new Map();
    // Subagent session registry — tracks which subagent keys belong to which parent
    // and what project/task they were spawned under. Used at session_end to log
    // the subagent with its real session key, not the parent's.
    subagentRegistry = new Map();
    // Explicitly registered sessions — only these get orchestrator tracking.
    // A session must call genorch_session_register before using any orchestrator
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
    trackModel(model, provider) {
        this.currentModel = model;
        if (provider)
            this.currentModelProvider = provider;
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
        if (status === "approved") {
            this.qaApprovedAt = new Date().toISOString();
            this.qaHistory.push({ event: "approve", timestamp: this.qaApprovedAt, detail: "QA approved" });
        }
        if (status === "rejected") {
            this.qaRejectedAt = new Date().toISOString();
        }
        if (status === "none") {
            this.qaFindings = [];
            this.qaApprovedAt = null;
            this.qaRejectedAt = null;
            this.qaRejectReason = null;
        }
    }
    addQaFinding(finding, reviewSessionKey) {
        this.qaFindings.push({ finding, timestamp: new Date().toISOString() });
        this.qaHistory.push({ event: "submit", timestamp: new Date().toISOString(), detail: finding, reviewSessionKey });
        this.qaStatus = "pending";
        this.qaRejectedAt = null;
        this.qaRejectReason = null;
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
            return "❓ QA required — submit findings with genorch_qa_submit";
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
        // Create a fresh per-session state for this session key
        const state = newSessionState();
        state.sessionKey = key;
        state.agentStatus = "running";
        state.lastActivityTimestamp = Date.now();
        this._states.set(key, state);
        this._activeSessionKey = key;
        this._fallback.sessionKey = key;
    }
    end() {
        if (!this.currentProject)
            return null;
        const ms = Date.now() - this.sessionStartTimestamp;
        const dur = ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}min`;
        this.agentStatus = "done";
        const result = {
            project: this.currentProject,
            task: this.currentTask || "auto-task",
            duration: dur,
            model: this.currentModel || "auto",
        };
        // Clean up per-session state — no longer needed
        if (this._activeSessionKey)
            this._states.delete(this._activeSessionKey);
        this._activeSessionKey = null;
        this._fallback = newSessionState();
        return result;
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
            qa_status: this.qaStatus,
            qa_history: this.qaHistory,
            qa_findings_count: this.qaFindings.length,
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
                    `call genorch_project_leave first to unbind this session.`);
            }
        }
        // Reset completion log flag — new task starts fresh
        this.loggedTaskCompletion = false;
        this.currentProject = project;
        this.currentTask = task;
        this.trackAction("Setting context");
        this.agentStatus = "running";
        // Reset workflow tracker with project config
        this.workflow.reset(workflowConfig);
        // Store per-session so before_prompt_build can scope injection
        if (this.sessionKey) {
            this.sessionContexts.set(this.sessionKey, {
                project, task, model: this.currentModel, modelProvider: this.currentModelProvider,
                timestamp: Date.now(), workflowConfig
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
//  Singleton instance — shared across the plugin
// ═══════════════════════════════════════════════════════════════
export const sessionTracker = new SessionTracker();
