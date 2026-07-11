// ═══════════════════════════════════════════════════════════════
//  SESSION TRACKER
// ═══════════════════════════════════════════════════════════════

import { WorkflowTracker } from "./workflow.js";

export interface ActionEvent {
  action: string;
  file?: string;
  ts: string;
}

// ── PER-SESSION STATE ──
// Each session gets its own state object to prevent cross-session pollution.
// Scalar fields are exposed as getter/setter pairs on SessionTracker for
// backward compatibility with the 250+ external references (e.g. sessionTracker.currentProject).

export interface SessionState {
  currentProject: string | null;
  currentTask: string | null;
  currentModel: string | null;
  currentModelProvider: string | null;
  currentAgent: string;
  sessionStartTimestamp: number;
  sessionKey: string | null;
  subagentDepth: number;
  currentAction: string | null;
  currentFile: string | null;
  agentStatus: string;
  touchedFiles: string[];
  actionHistory: ActionEvent[];
  tokenUsage: { input: number; output: number; total: number };
  lastError: string | null;
  lastActivityTimestamp: number;
  errorCount: number;
  loggedTaskCompletion: boolean;
  qaStatus: "none" | "pending" | "approved" | "rejected";
  qaFindings: Array<{ finding: string; timestamp: string }>;
  qaApprovedAt: string | null;
  qaRejectedAt: string | null;
  qaRejectReason: string | null;
  qaHistory: Array<{ event: "submit" | "approve" | "reject"; timestamp: string; detail: string; reviewSessionKey?: string | null }>;
  handoffGenerated: boolean;
  handoffPath: string | null;
  workflow: WorkflowTracker;
}

export function newSessionState(): SessionState {
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
  private _states: Map<string, SessionState> = new Map();
  // Fallback for operations before a session key is assigned
  private _fallback: SessionState = newSessionState();
  // Active session key — stored separately to avoid circular getter/setter dependency
  private _activeSessionKey: string | null = null;

  /** Resolve per-session state for the current active session key. */
  private get _s(): SessionState {
    if (this._activeSessionKey !== null && this._states.has(this._activeSessionKey)) {
      return this._states.get(this._activeSessionKey)!;
    }
    return this._fallback;
  }

  // ── Per-session scalar field delegates ──
  get currentProject(): string | null { return this._s.currentProject; }
  set currentProject(v: string | null) { this._s.currentProject = v; }
  get currentTask(): string | null { return this._s.currentTask; }
  set currentTask(v: string | null) { this._s.currentTask = v; }
  get currentModel(): string | null { return this._s.currentModel; }
  set currentModel(v: string | null) { this._s.currentModel = v; }
  get currentModelProvider(): string | null { return this._s.currentModelProvider; }
  set currentModelProvider(v: string | null) { this._s.currentModelProvider = v; }
  get currentAgent(): string { return this._s.currentAgent; }
  set currentAgent(v: string) { this._s.currentAgent = v; }
  get sessionStartTimestamp(): number { return this._s.sessionStartTimestamp; }
  set sessionStartTimestamp(v: number) { this._s.sessionStartTimestamp = v; }
  get sessionKey(): string | null { return this._activeSessionKey; }
  set sessionKey(v: string | null) { this._activeSessionKey = v; this._fallback.sessionKey = v; }
  get subagentDepth(): number { return this._s.subagentDepth; }
  set subagentDepth(v: number) { this._s.subagentDepth = v; }
  get currentAction(): string | null { return this._s.currentAction; }
  set currentAction(v: string | null) { this._s.currentAction = v; }
  get currentFile(): string | null { return this._s.currentFile; }
  set currentFile(v: string | null) { this._s.currentFile = v; }
  get agentStatus(): string { return this._s.agentStatus; }
  set agentStatus(v: string) { this._s.agentStatus = v; }
  get touchedFiles(): string[] { return this._s.touchedFiles; }
  set touchedFiles(v: string[]) { this._s.touchedFiles = v; }
  get actionHistory(): ActionEvent[] { return this._s.actionHistory; }
  set actionHistory(v: ActionEvent[]) { this._s.actionHistory = v; }
  get tokenUsage(): { input: number; output: number; total: number } { return this._s.tokenUsage; }
  set tokenUsage(v: { input: number; output: number; total: number }) { this._s.tokenUsage = v; }
  get lastError(): string | null { return this._s.lastError; }
  set lastError(v: string | null) { this._s.lastError = v; }
  get lastActivityTimestamp(): number { return this._s.lastActivityTimestamp; }
  set lastActivityTimestamp(v: number) { this._s.lastActivityTimestamp = v; }
  get errorCount(): number { return this._s.errorCount; }
  set errorCount(v: number) { this._s.errorCount = v; }
  get loggedTaskCompletion(): boolean { return this._s.loggedTaskCompletion; }
  set loggedTaskCompletion(v: boolean) { this._s.loggedTaskCompletion = v; }
  get qaStatus(): "none" | "pending" | "approved" | "rejected" { return this._s.qaStatus; }
  set qaStatus(v: "none" | "pending" | "approved" | "rejected") { this._s.qaStatus = v; }
  get qaFindings(): Array<{ finding: string; timestamp: string }> { return this._s.qaFindings; }
  set qaFindings(v: Array<{ finding: string; timestamp: string }>) { this._s.qaFindings = v; }
  get qaApprovedAt(): string | null { return this._s.qaApprovedAt; }
  set qaApprovedAt(v: string | null) { this._s.qaApprovedAt = v; }
  get qaRejectedAt(): string | null { return this._s.qaRejectedAt; }
  set qaRejectedAt(v: string | null) { this._s.qaRejectedAt = v; }
  get qaRejectReason(): string | null { return this._s.qaRejectReason; }
  set qaRejectReason(v: string | null) { this._s.qaRejectReason = v; }
  get qaHistory(): Array<{ event: "submit" | "approve" | "reject"; timestamp: string; detail: string; reviewSessionKey?: string | null }> { return this._s.qaHistory; }
  set qaHistory(v: Array<{ event: "submit" | "approve" | "reject"; timestamp: string; detail: string; reviewSessionKey?: string | null }>) { this._s.qaHistory = v; }
  get handoffGenerated(): boolean { return this._s.handoffGenerated; }
  set handoffGenerated(v: boolean) { this._s.handoffGenerated = v; }
  get handoffPath(): string | null { return this._s.handoffPath; }
  set handoffPath(v: string | null) { this._s.handoffPath = v; }
  get workflow(): WorkflowTracker { return this._s.workflow; }
  set workflow(v: WorkflowTracker) { this._s.workflow = v; }
  // Per-session project contexts — keyed by sessionKey.
  // A session only gets project context injected if it explicitly
  // registered via genorch_session_start_work. This prevents project
  // context from bleeding between unrelated sessions.
  private sessionContexts: Map<string, { project: string; task: string | null; model: string | null; modelProvider: string | null; timestamp: number; workflowConfig?: any }> = new Map();
  // Subagent session registry — tracks which subagent keys belong to which parent
  // and what project/task they were spawned under. Used at session_end to log
  // the subagent with its real session key, not the parent's.
  private subagentRegistry: Map<string, { parentKey: string | null; project: string | null; task: string | null; startedAt: string }> = new Map();
  // Explicitly registered sessions — only these get orchestrator tracking.
  // A session must call genorch_session_register before using any orchestrator
  // features. This ensures no chat/logging session accidentally gets project
  // context injected into its prompts.
  private registeredSessions: Set<string> = new Set();
  // Session-to-project binding: once a session registers to a project,
  // it's locked to that project until explicitly released. This prevents
  // cross-project contamination and ensures 1 session = 1 project.
  private sessionProjectBinding: Map<string, string> = new Map();
  // Track which projects have at least one active session.
  // A project must have at least one session to be considered "active".
  private projectActiveSessions: Map<string, Set<string>> = new Map();

  trackModel(model: string, provider?: string): void {
    this.currentModel = model;
    if (provider) this.currentModelProvider = provider;
  }

  trackAction(action: string, file?: string): void {
    this.currentAction = action;
    this.lastActivityTimestamp = Date.now();
    if (file) this.currentFile = file;
    if (file && !this.touchedFiles.includes(file)) {
      this.touchedFiles.push(file);
    }
    // Dedup: skip consecutive identical actions (e.g., repeated "building_prompt")
    const last = this.actionHistory[this.actionHistory.length - 1];
    if (last && last.action === action && last.file === file) {
      // Just update timestamp on the existing entry
      last.ts = new Date().toISOString();
    } else {
      this.actionHistory.push({ action, file, ts: new Date().toISOString() });
    }
    if (this.actionHistory.length > 100) this.actionHistory = this.actionHistory.slice(-100);
  }

  trackTokenUsage(input: number, output: number): void {
    this.tokenUsage.input += input;
    this.tokenUsage.output += output;
    this.tokenUsage.total += input + output;
    this.lastActivityTimestamp = Date.now();
  }

  trackError(error: string): void {
    this.lastError = error;
    this.agentStatus = "blocked";
    this.errorCount++;
    this.lastActivityTimestamp = Date.now();
  }

  setStatus(status: string): void {
    this.agentStatus = status;
  }

  markLoggedCompletion(): void {
    this.loggedTaskCompletion = true;
  }

  // ── QA GATE METHODS ──
  setQaStatus(status: "none" | "pending" | "approved" | "rejected"): void {
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

  addQaFinding(finding: string, reviewSessionKey?: string): void {
    this.qaFindings.push({ finding, timestamp: new Date().toISOString() });
    this.qaHistory.push({ event: "submit", timestamp: new Date().toISOString(), detail: finding, reviewSessionKey });
    this.qaStatus = "pending";
    this.qaRejectedAt = null;
    this.qaRejectReason = null;
  }

  canAdvanceFromWork(): boolean {
    // If QA is not required, always can advance
    if (!this.workflow.enabled || !this.workflow.includeQa) return true;
    // QA must be approved
    return this.qaStatus === "approved";
  }

  getQaSummary(): string {
    if (this.qaStatus === "none" && this.workflow.includeQa) return "❓ QA required — submit findings with genorch_qa_submit";
    if (this.qaStatus === "pending") return "⏳ QA pending — waiting for approval";
    if (this.qaStatus === "approved") return `✅ QA approved (${this.qaApprovedAt || "unknown"})`;
    if (this.qaStatus === "rejected") return "❌ QA rejected — fix issues and resubmit";
    return "";
  }

  // ── HANDOFF METHODS ──
  markHandoffGenerated(path: string): void {
    this.handoffGenerated = true;
    this.handoffPath = path;
  }

  canFinish(): boolean {
    // Handoff doc is always required before finish
    return this.handoffGenerated;
  }

  start(key: string, reason: string): void {
    // Create a fresh per-session state for this session key
    const state = newSessionState();
    state.sessionKey = key;
    state.agentStatus = "running";
    state.lastActivityTimestamp = Date.now();
    this._states.set(key, state);
    this._activeSessionKey = key;
    this._fallback.sessionKey = key;
  }

  end(): { project: string; task: string; duration: string; model: string } | null {
    if (!this.currentProject) return null;
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
    if (this._activeSessionKey) this._states.delete(this._activeSessionKey);
    this._activeSessionKey = null;
    this._fallback = newSessionState();
    return result;
  }

  private formatElapsed(ms: number): string {
    if (ms < 1000) return "0s";
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    const m = Math.floor(ms / 60000);
    const s = Math.round((ms % 60000) / 1000);
    return `${m}m ${s}s`;
  }

  toLiveState(reason: string): any {
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

  setContext(project: string, task: string, workflowConfig?: any): void {
    // ═══ ENFORCE SESSION-PROJECT BINDING ═══
    // Once a session registers to a project, it's locked to that project.
    // This prevents cross-project contamination from a single session.
    if (this.sessionKey && this.sessionProjectBinding.has(this.sessionKey)) {
      const boundProject = this.sessionProjectBinding.get(this.sessionKey)!;
      if (boundProject !== project) {
        throw new Error(
          `❌ Binding violation: This session is already locked to project "${boundProject}". ` +
          `Cannot set context to "${project}". To work on a different project, start a completely ` +
          `new session (not a subagent — a fresh session). If you're done with "${boundProject}", ` +
          `call genorch_project_leave first to unbind this session.`
        );
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
        this.projectActiveSessions.get(project)!.add(this.sessionKey);
      }
    }
  }

  clearContext(): void {
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
    if (this.sessionKey) this.sessionContexts.delete(this.sessionKey);
    if (prev) this.trackAction("Clearing context");
  }

  /** Get project context for a specific session key. */
  getSessionContext(sessionKey: string): { project: string; task: string | null; model: string | null; workflowConfig?: any } | null {
    const ctx = this.sessionContexts.get(sessionKey);
    if (!ctx) return null;
    return { project: ctx.project, task: ctx.task, model: ctx.model, workflowConfig: ctx.workflowConfig };
  }

  /** Clean up session context for a given key. Call on session_end. */
  removeSessionContext(sessionKey: string): void {
    this.sessionContexts.delete(sessionKey);
  }

  /** Track a subagent session's metadata so we can log it with the right key. */
  trackSubagent(subKey: string, info: { parentKey: string | null; project: string | null; task: string | null; startedAt: string }): void {
    this.subagentRegistry.set(subKey, info);
  }

  /** Remove subagent tracking when subagent_ended fires. */
  untrackSubagent(subKey: string): void {
    this.subagentRegistry.delete(subKey);
  }

  /** Get subagent info by key, or undefined. */
  getSubagent(subKey: string): { parentKey: string | null; project: string | null; task: string | null; startedAt: string } | undefined {
    return this.subagentRegistry.get(subKey);
  }

  /** Register a session for orchestrator tracking. Returns true if newly registered. */
  registerSession(sessionKey: string): boolean {
    if (this.registeredSessions.has(sessionKey)) return false;
    this.registeredSessions.add(sessionKey);
    return true;
  }

  /** Unregister a session from orchestrator tracking. Also releases project binding. */
  unregisterSession(sessionKey: string): boolean {
    if (!this.registeredSessions.has(sessionKey)) return false;
    this.registeredSessions.delete(sessionKey);
    this.sessionContexts.delete(sessionKey);
    // Also release project binding
    this.releaseProjectBinding(sessionKey);
    return true;
  }

  /** Check if a session is registered for orchestrator tracking. */
  isSessionRegistered(sessionKey: string): boolean {
    return this.registeredSessions.has(sessionKey);
  }

  /** Get list of all registered session keys. */
  getRegisteredSessions(): string[] {
    return Array.from(this.registeredSessions);
  }

  /** Release this session's project binding. Returns the previously bound project or null. */
  releaseProjectBinding(sessionKey?: string): string | null {
    const sk = sessionKey || this.sessionKey;
    if (!sk || !this.sessionProjectBinding.has(sk)) return null;
    const prevProject = this.sessionProjectBinding.get(sk)!;
    this.sessionProjectBinding.delete(sk);
    // Remove from project active sessions
    if (this.projectActiveSessions.has(prevProject)) {
      this.projectActiveSessions.get(prevProject)!.delete(sk);
      if (this.projectActiveSessions.get(prevProject)!.size === 0) {
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
  getBoundProject(sessionKey?: string): string | null {
    const sk = sessionKey || this.sessionKey;
    return sk ? this.sessionProjectBinding.get(sk) || null : null;
  }

  /** Get projects that have at least one active session. */
  getActiveProjects(): Array<{ project: string; active_sessions: number; session_keys: string[] }> {
    const result: Array<{ project: string; active_sessions: number; session_keys: string[] }> = [];
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
  hasActiveSessionsFor(project: string): boolean {
    return this.projectActiveSessions.has(project) && this.projectActiveSessions.get(project)!.size > 0;
  }
}

// ═══════════════════════════════════════════════════════════════
//  Singleton instance — shared across the plugin
// ═══════════════════════════════════════════════════════════════

export const sessionTracker = new SessionTracker();
