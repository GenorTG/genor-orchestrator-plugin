import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { toolPluginMetadataSymbol } from "openclaw/plugin-sdk/tool-plugin";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawn } from "node:child_process";

import { createDashboardHandler } from "./dashboard-handler.js";

// ═══════════════════════════════════════════════════════════════
//  TABLE OF CONTENTS — for quick LLM & developer navigation
// ═══════════════════════════════════════════════════════════════
//
//  Lines  Section
//  ────── ──────────────────────────────────────────────────────
//  1-7    Imports
//  10-14  TABLE OF CONTENTS (this block)
//  16-18  TYPES — LogEntry, DashboardConfig, ModelEntry, ProjectBacklogTask
//  19-53  Interfaces
//  57-63  txt() — Tool result helper
//  65-67  DATA DIRECTORY RESOLUTION
//  68-89  getDataDir() / getDashboardDir()
//  91-93  JSON FILE HELPERS
//  95-109 readJSON() / writeJSON() / readFileContent()
//  111-113 LOGGER — OrchestratorLogger class
//  116-199 OrchestratorLogger methods
//  200-202 SESSION TRACKER — SessionTracker class
//  202-275 SessionTracker methods
//  277-279 LIVE AGENTS FILE
//  283-338 writeLiveAgents() — writes live-agents.json + state.json
//  340-342 PROJECT HELPERS
//  344-443 getProjectLocation / buildProjectToc / syncProjectToOrchestrator
//  392-406 normalizeSessionsJson
//  409-433 generateRecoveryDoc
//  435-443 readRecentSessions
//  445-447 BACKGROUND MAINTENANCE — MaintenanceService class
//  449-504 MaintenanceService.start() / tick() / stop()
//  506-508 MODEL / DASHBOARD HELPERS
//  510-539 isPaid / parseSessionLog / parsePriceLog / projDir
//  541-543 TOOL LOGIC (pure functions behind each tool)
//  545-793 getStatus / getConfig / filterModelsForProject / getModels
//  633-658 checkModels / autoPopulate / logSession / logDecision
//  683-715 logSession() — Write session file + log
//  718-736 logDecision() — Write ADR file
//  738-746 getLogs — query orchestrator logs
//  748-793 setContext / clearContextFn / syncProject / getProjectDocsFn
//  795-797 PLUGIN ENTRY
//  801-808 Constants: TOOL_NAMES (13 tools), PLUGIN_ID
//  810-822 definePluginEntry({...}) + register() — init
//  824-838 Cron scheduling (nightly auto-populate 3 AM)
//  840-842   LOGGER init
//  844-846   HOOKS (8 hooks)
//  848-855   • session_start
//  856-875   • session_end (auto-log + recovery doc)
//  877-883   • subagent_spawned
//  885-890   • subagent_ended
//  892-925   • before_model_resolve (auto-routing)
//  927-940   • before_prompt_build (context injection)
//  942-946   • agent_end
//  948-952   • gateway_stop
//  954-956   TOOLS (12 registered via api.registerTool)
//  957-969   • orchestrator_set_context
//  970-978   • orchestrator_clear_context
//  979-988   • orchestrator_get_status
//  989-998   • orchestrator_get_config
//  999-1014  • orchestrator_get_models
//  1016-1026 • orchestrator_check_models
//  1028-1036 • orchestrator_auto_populate
//  1038-1058 • orchestrator_log_session
//  1060-1075 • orchestrator_log_decision
//  1077-1090 • orchestrator_get_logs
//  1092-1104 • orchestrator_sync_project
//  1106-1116 • orchestrator_get_project_docs
//  1118-1121 BACKGROUND MAINTENANCE start
//  1123-1129 SLASH COMMANDS: /genor, /genor-dashboard, /genor-status, /genor-help
//  1131-1188 api.registerCommand({ name: "genor", ... })
//  1190      logger.info — "Orchestrator ready"
//  1192-1194 close register()
//  1196-1198 EXPORT — defineToolPlugin + openclaw metadata
//  1200-1230 toolPluginMetadataSymbol + configSchema
//  1232     export default
//
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  TYPES
// ═══════════════════════════════════════════════════════════════

interface LogEntry {
  ts: string;
  level: string;
  source: string;
  msg: string;
  data?: Record<string, any>;
}

interface SafeguardsConfig {
  enabled?: boolean;
  idle_timeout_ms?: number;
  stuck_timeout_ms?: number;
  max_errors_before_escalation?: number;
  auto_recover?: boolean;
  tick_interval_ms?: number;
}

interface DashboardConfig {
  free_only_mode?: boolean;
  theme?: string;
  auto_refresh_seconds?: number;
  disabled_models?: string[];
  projects?: Record<string, {
    model_allowlist?: string[];
    free_only?: boolean;
    location?: string;
    workflow?: {
      enabled: boolean;
      include_qa?: boolean;
      auto_commit?: boolean;
      qa_retries?: number;
      skip_phases?: string[];
    };
    model_routing?: Record<string, string[]>;
  }>;
  safeguards?: SafeguardsConfig;
}

interface ModelEntry {
  id: string;
  provider: string;
  name: string;
  tier: number;
  speed_rating: number;
  status: string;
  agent_ready: boolean;
  capabilities?: Record<string, any>;
  cost?: Record<string, any>;
  context_window?: number;
  notes?: string;
  [key: string]: any;
}

interface ProjectBacklogTask {
  id: string;
  title: string;
  description: string;
  status: "todo" | "in_progress" | "done" | "blocked" | "cancelled";
  priority: "low" | "medium" | "high" | "critical";
  created: string;
  completed: string | null;
  session_refs: string[];
  tags: string[];
}

// ── Tool result helper ─────────────────────────────────────────
function txt(data: any): { content: Array<{ type: "text"; text: string }>; details: any } {
  return {
    content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ═══════════════════════════════════════════════════════════════
//  DATA DIRECTORY RESOLUTION
// ═══════════════════════════════════════════════════════════════

function getDataDir(cfgDir?: string): string {
  if (cfgDir && fs.existsSync(cfgDir)) return cfgDir;
  if (process.env.ORCHESTRATOR_DATA_DIR && fs.existsSync(process.env.ORCHESTRATOR_DATA_DIR))
    return process.env.ORCHESTRATOR_DATA_DIR;
  const dflt = path.join(os.homedir(), ".openclaw/workspace/orchestrator-data");
  fs.mkdirSync(dflt, { recursive: true });
  return dflt;
}

function getDashboardDir(): string {
  const candidates = [
    process.env.DASHBOARD_DIR,
    path.join(os.homedir(), ".openclaw/workspace/skills/genor-orchestrator/dashboard"),
    path.join(os.homedir(), ".openclaw/extensions/genor-orchestrator/dashboard"),
    path.join(os.homedir(), "projects", "genor-orchestrator-plugin", "dashboard"),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  const dflt = path.join(os.homedir(), ".openclaw/workspace/skills/genor-orchestrator/dashboard");
  fs.mkdirSync(dflt, { recursive: true });
  return dflt;
}

// ═══════════════════════════════════════════════════════════════
//  JSON FILE HELPERS
// ═══════════════════════════════════════════════════════════════

function readJSON(filePath: string): any {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); }
  catch { return null; }
}

function writeJSON(filePath: string, data: any): void {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

/** Extract tags from a task slug and notes text. Used for session entry tags. */
function extractTags(task: string, notes: string): string[] {
  const tags: string[] = [];
  const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "have", "has"]);
  const t = (task || "").toLowerCase();
  for (const part of t.split(/[-_]/)) {
    if (part.length > 2 && !stop.has(part) && !/^v?\d/.test(part) && !tags.includes(part)) {
      tags.push(part);
    }
  }
  const n = (notes || "").toLowerCase();
  for (const kw of ["design", "implement", "fix", "test", "refactor", "debug", "audit", "review"]) {
    if (n.includes(kw) && !tags.includes(kw)) tags.push(kw);
  }
  return tags.slice(0, 8);
}

function readFileContent(p: string): string | null {
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf-8");
}

// ═══════════════════════════════════════════════════════════════
//  LOGGER — JSONL-based, level-filtered, auto-cleanup
// ═══════════════════════════════════════════════════════════════

class OrchestratorLogger {
  private logFile: string;
  private level: string;
  private retentionDays: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private static LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

  constructor(dataDir: string, level: string = "info", retentionDays: number = 30) {
    const logDir = path.join(dataDir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    this.logFile = path.join(logDir, "orchestrator.jsonl");
    this.level = level;
    this.retentionDays = retentionDays;
    this.cleanupTimer = setInterval(() => this.cleanup(), 6 * 3600_000);
    setTimeout(() => this.cleanup(), 60_000);
  }

  private shouldLog(lvl: string): boolean {
    return (OrchestratorLogger.LEVELS[lvl.toLowerCase()] ?? 1) >= (OrchestratorLogger.LEVELS[this.level] ?? 1);
  }

  private write(level: string, source: string, msg: string, data?: Record<string, any>): void {
    if (!this.shouldLog(level)) return;
    try {
      const entry: LogEntry = { ts: new Date().toISOString(), level, source, msg };
      if (data && Object.keys(data).length > 0) entry.data = data;
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + "\n", "utf-8");
    } catch { /* logging never crashes */ }
  }

  debug = (source: string, msg: string, data?: any) => this.write("debug", source, msg, data);
  info = (source: string, msg: string, data?: any) => this.write("info", source, msg, data);
  warn = (source: string, msg: string, data?: any) => this.write("warn", source, msg, data);
  error = (source: string, msg: string, data?: any) => this.write("error", source, msg, data);

  logRouting(modelId: string, project: string | null, eligible: number, total: number, filters: string[]): void {
    this.info("routing", `Model check for ${project ?? "global"}: ${eligible}/${total} eligible`, { project, eligible, total, filters });
  }

  logSession(project: string, task: string, model: string, agent: string, status: string): void {
    this.info("session", `${project}/${task} → ${status}`, { project, task, model, agent, status });
  }

  logConfigChange(key: string, value: any): void {
    this.info("config", `Config changed: ${key}`, { key, value });
  }

  query(limit: number = 50, opts?: { level?: string; source?: string; since?: string }): LogEntry[] {
    if (!fs.existsSync(this.logFile)) return [];
    try {
      const content = fs.readFileSync(this.logFile, "utf-8");
      const entries: LogEntry[] = [];
      for (const line of content.trim().split("\n").filter(Boolean)) {
        try {
          const e = JSON.parse(line) as LogEntry;
          if (opts?.level && !this.shouldLog(opts.level)) continue;
          if (opts?.source && !e.source.includes(opts.source)) continue;
          if (opts?.since && e.ts < opts.since) continue;
          entries.push(e);
        } catch { /* skip malformed */ }
      }
      return entries.slice(-limit);
    } catch { return []; }
  }

  cleanup(): void {
    if (!fs.existsSync(this.logFile)) return;
    const cutoff = Date.now() - this.retentionDays * 86400_000;
    try {
      const content = fs.readFileSync(this.logFile, "utf-8");
      const kept = content.trim().split("\n").filter(line => {
        try { return new Date(JSON.parse(line).ts).getTime() > cutoff; } catch { return false; }
      });
      fs.writeFileSync(this.logFile, kept.join("\n") + (kept.length ? "\n" : ""), "utf-8");
    } catch { /* fail silently */ }
  }

  stop(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }
}

// ═══════════════════════════════════════════════════════════════
//  SESSION TRACKER
// ═══════════════════════════════════════════════════════════════

interface ActionEvent {
  action: string;
  file?: string;
  ts: string;
}

// ═══════════════════════════════════════════════════════════════
//  WORKFLOW PHASES — Analyze → Plan → Document → Work → Log → Finish
// ═══════════════════════════════════════════════════════════════

type WorkflowPhase = "analyze" | "plan" | "document" | "work" | "log" | "finish";

interface PhaseEntry {
  phase: WorkflowPhase;
  enteredAt: string;
  completedAt?: string;
  skipped?: boolean;
}

interface QAResult {
  passed: boolean;
  notes: string;
  attemptedAt: string;
}

const WORKFLOW_ORDER: WorkflowPhase[] = ["analyze", "plan", "document", "work", "log", "finish"];

class WorkflowTracker {
  enabled: boolean = false;
  currentPhase: WorkflowPhase = "analyze";
  phaseHistory: PhaseEntry[] = [];
  currentPhaseStartedAt: number = Date.now();
  qaRetries: number = 0;
  qaMaxRetries: number = 3;
  qaResults: QAResult[] = [];
  isQARunning: boolean = false;
  autoCommit: boolean = false;
  skipPhases: WorkflowPhase[] = [];

  reset(projectWorkflowConfig?: { enabled: boolean; include_qa?: boolean; auto_commit?: boolean; qa_retries?: number; skip_phases?: string[] }): void {
    this.enabled = projectWorkflowConfig?.enabled ?? false;
    this.currentPhase = "analyze";
    this.phaseHistory = [];
    this.currentPhaseStartedAt = Date.now();
    this.qaRetries = 0;
    this.qaResults = [];
    this.isQARunning = false;
    this.autoCommit = projectWorkflowConfig?.auto_commit ?? false;
    this.skipPhases = (projectWorkflowConfig?.skip_phases ?? []).filter((p): p is WorkflowPhase => WORKFLOW_ORDER.includes(p as any)) as WorkflowPhase[];
    this.qaMaxRetries = projectWorkflowConfig?.qa_retries ?? 3;
    this.enterPhase("analyze");
  }

  enterPhase(phase: WorkflowPhase): void {
    this.currentPhase = phase;
    this.currentPhaseStartedAt = Date.now();
    const existing = this.phaseHistory.find(p => p.phase === phase);
    if (existing) {
      existing.enteredAt = new Date().toISOString();
      existing.completedAt = undefined;
    } else {
      this.phaseHistory.push({ phase, enteredAt: new Date().toISOString() });
    }
  }

  completePhase(phase: WorkflowPhase, skipped?: boolean): void {
    const entry = this.phaseHistory.find(p => p.phase === phase);
    if (entry) {
      entry.completedAt = new Date().toISOString();
      entry.skipped = skipped ?? false;
    }
  }

  nextPhase(): WorkflowPhase | null {
    const idx = WORKFLOW_ORDER.indexOf(this.currentPhase);
    if (idx < 0 || idx >= WORKFLOW_ORDER.length - 1) return null;
    // Skip configured phases
    for (let i = idx + 1; i < WORKFLOW_ORDER.length; i++) {
      if (!this.skipPhases.includes(WORKFLOW_ORDER[i])) {
        return WORKFLOW_ORDER[i];
      }
    }
    return null;
  }

  advance(): WorkflowPhase | null {
    this.completePhase(this.currentPhase);
    const next = this.nextPhase();
    if (next) this.enterPhase(next);
    return next;
  }

  canTransitionTo(target: WorkflowPhase): boolean {
    if (!this.enabled) return true;
    const currentIdx = WORKFLOW_ORDER.indexOf(this.currentPhase);
    const targetIdx = WORKFLOW_ORDER.indexOf(target);
    if (currentIdx < 0 || targetIdx < 0) return true;
    // Allow transitions forward or to same phase (re-entry ok)
    return targetIdx >= currentIdx;
  }

  getPhaseElapsed(): string {
    const elapsed = Date.now() - this.currentPhaseStartedAt;
    const mins = Math.floor(elapsed / 60000);
    const secs = Math.floor((elapsed % 60000) / 1000);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }

  getProgress(): string {
    const completed = this.phaseHistory.filter(p => p.completedAt).length;
    const total = WORKFLOW_ORDER.filter(p => !this.skipPhases.includes(p)).length;
    return `${completed}/${total}`;
  }

  toJSON(): Record<string, any> {
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
  currentProject: string | null = null;
  currentTask: string | null = null;
  currentModel: string | null = null;
  currentModelProvider: string | null = null;
  currentModelTier: number = 0;
  currentAgent: string = "Amy";
  sessionStartTimestamp: number = Date.now();
  sessionKey: string | null = null;
  subagentDepth: number = 0;
  currentAction: string | null = null;
  currentFile: string | null = null;
  agentStatus: string = "idle";
  touchedFiles: string[] = [];
  actionHistory: ActionEvent[] = [];
  tokenUsage: { input: number; output: number; total: number } = { input: 0, output: 0, total: 0 };
  lastError: string | null = null;
  lastActivityTimestamp: number = Date.now();
  errorCount: number = 0;
  workflow: WorkflowTracker = new WorkflowTracker();
  // Per-session project contexts — keyed by sessionKey.
  // A session only gets project context injected if it explicitly
  // registered via orchestrator_set_context. This prevents project
  // context from bleeding between unrelated sessions.
  private sessionContexts: Map<string, { project: string; task: string | null; model: string | null; modelProvider: string | null; modelTier: number; timestamp: number; workflowConfig?: any }> = new Map();
  // Subagent session registry — tracks which subagent keys belong to which parent
  // and what project/task they were spawned under. Used at session_end to log
  // the subagent with its real session key, not the parent's.
  private subagentRegistry: Map<string, { parentKey: string | null; project: string | null; task: string | null; startedAt: string }> = new Map();
  // Explicitly registered sessions — only these get orchestrator tracking.
  // A session must call orchestrator_register before using any orchestrator
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

  trackModel(model: string, provider?: string, tier?: number): void {
    this.currentModel = model;
    if (provider) this.currentModelProvider = provider;
    if (tier !== undefined) this.currentModelTier = tier;
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

  start(key: string, reason: string): void {
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

  end(): { project: string; task: string; duration: string; model: string } | null {
    if (!this.currentProject) return null;
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
          `call orchestrator_release_project first to unbind this session.`
        );
      }
    }

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
    if (this.sessionKey) this.sessionContexts.delete(this.sessionKey);
    if (prev) this.trackAction("Clearing context");
  }

  /** Get project context for a specific session key. */
  getSessionContext(sessionKey: string): { project: string; task: string | null; model: string | null } | null {
    const ctx = this.sessionContexts.get(sessionKey);
    if (!ctx) return null;
    return { project: ctx.project, task: ctx.task, model: ctx.model };
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
//  LIVE AGENTS FILE
// ═══════════════════════════════════════════════════════════════

const LIVE_AGENTS_FILE = "live-agents.json";

function writeLiveAgents(reason: string, tracker: SessionTracker, logger?: OrchestratorLogger): void {
  // Debounced: queues write to disk, coalesces rapid sequential calls
  queueLiveAgents(reason, tracker);
}

// Debounce: coalesce rapid sequential writes into one disk write every 500ms
let _liveAgentsTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingData: { agents: any[]; agent_count: number; active_count: number; last_updated: string; reason: string } | null = null;
let _pendingState: { project: string | null; task: string | null; model: string | null; agent: string; timestamp: string; subagent_depth: number; action: string | null } | null = null;

function flushLiveAgents(): void {
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
  } catch (e: any) {
    try { fs.appendFileSync('/tmp/live-agents-errors.log', `${new Date().toISOString()} flushLiveAgents: ${e.message}\n`, 'utf-8'); } catch {}
  }
}

function queueLiveAgents(reason: string, tracker: SessionTracker): void {
  // ═══ SCOPE: Only track registered sessions ═══
  // The plugin should be invisible to unregistered sessions.
  // No live agents data, no tracking, no context injection for sessions
  // that haven't explicitly opted in via orchestrator_register.
  if (tracker.sessionKey && !tracker.isSessionRegistered(tracker.sessionKey)) return;

  const main = tracker.toLiveState(reason);
  const agents: any[] = [];
  if (main.project || main.agent) agents.push(main);
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

function flushLiveAgentsNow(reason: string, tracker: SessionTracker): void {
  // Only track registered sessions
  if (tracker.sessionKey && !tracker.isSessionRegistered(tracker.sessionKey)) return;
  if (_liveAgentsTimer) { clearTimeout(_liveAgentsTimer); _liveAgentsTimer = null; }
  _pendingData = null;
  _pendingState = null;
  try {
    const dataDir = getDataDir();
    const main = tracker.toLiveState(reason);
    const agents: any[] = [];
    if (main.project || main.agent) agents.push(main);
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
  } catch (e: any) {
    try { fs.appendFileSync('/tmp/live-agents-errors.log', `${new Date().toISOString()} flushLiveAgentsNow(${reason}): ${e.message}\n`, 'utf-8'); } catch {}
  }
}

const sessionTracker = new SessionTracker();

/** Generate a stable default session key when hooks have not provided one yet.
 *  Used as fallback for orchestrator_register when session_start has not
 *  fired (e.g. sessions that existed before a gateway restart). */
function agentDefaultSessionKey(): string {
  if (sessionTracker.sessionKey) return sessionTracker.sessionKey;
  return `agent:main:auto:${sessionTracker.currentAgent}:${sessionTracker.sessionStartTimestamp}`;
}


// ═══════════════════════════════════════════════════════════════
//  PROJECT HELPERS
// ═══════════════════════════════════════════════════════════════

function getProjectLocation(project: string, dataDir: string): string | null {
  const cfg: DashboardConfig = readJSON(path.join(dataDir, "dashboard-config.json")) || {};
  return cfg.projects?.[project]?.location || null;
}

function buildProjectToc(location: string): string[] {
  try {
    const result = execSync(
      `find "${location}" -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" -maxdepth 4 -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" -o -name "*.py" -o -name "*.md" -o -name "*.json" -o -name "*.yaml" -o -name "*.yml" -o -name "*.css" -o -name "*.html" \\) 2>/dev/null | head -300`,
      { encoding: "utf-8", timeout: 5000 }
    );
    return result.trim().split("\n").filter(Boolean);
  } catch { return []; }
}

function syncProjectToOrchestrator(project: string, dataDir: string, logger: OrchestratorLogger): void {
  const pd = projDir(project, dataDir);
  const loc = getProjectLocation(project, dataDir);
  if (!loc || !fs.existsSync(loc)) { logger.warn("sync", `No valid location for ${project}`); return; }

  const readme = readFileContent(path.join(loc, "README.md")) || "No README.md";
  const toc = buildProjectToc(loc);
  const keyFiles = toc.filter(f =>
    !f.includes("node_modules") && (f.endsWith(".md") || f.endsWith("package.json") ||
    f.endsWith("package-lock.json") || f.endsWith(".ts") || f.endsWith(".tsx") ||
    f.endsWith(".py") || f.endsWith(".css") || f.endsWith(".html") ||
    f.includes("tsconfig") || f.includes("next.config") ||
    f.includes("tailwind") || f.endsWith(".env.example"))
  );

  let context = `# ${project}\n\n## Location\n\`${loc}\`\n\n## README\n\n${readme.slice(0, 3000)}\n`;
  try {
    const pkg = readJSON(path.join(loc, "package.json"));
    if (pkg) context += `\n## Package\n- Name: ${pkg.name || "N/A"}\n- Version: ${pkg.version || "N/A"}\n`;
  } catch { /* */ }
  const tocDisplay = toc.filter(f => !f.includes("node_modules") && !f.includes("/."));
  context += `\n## File Index (${tocDisplay.length} files)\n\n${tocDisplay.map(f => `- ${path.relative(loc, f)}`).join("\n")}\n`;
  fs.writeFileSync(path.join(pd, "CONTEXT.md"), context, "utf-8");

  let tocMd = `# ${project} — File Index\n\n**Location:** \`${loc}\`\n\n### Key Files (${keyFiles.length})\n\n`;
  for (const f of keyFiles) { tocMd += `- \`${path.relative(loc, f)}\`\n`; }
  tocMd += `\n### Full TOC (first 80 of ${toc.length})\n\n`;
  for (const f of toc.slice(0, 80)) { tocMd += `- \`${path.relative(loc, f)}\`\n`; }
  if (toc.length > 80) tocMd += `\n*... and ${toc.length - 80} more*\n`;
  fs.writeFileSync(path.join(pd, "KEY_FILES.md"), tocMd, "utf-8");
  logger.info("sync", `Synced ${project} from ${loc}: ${toc.length} files`);
}

function normalizeSessionsJson(project: string, dataDir: string): void {
  const sf = path.join(projDir(project, dataDir), "sessions.json");
  if (!fs.existsSync(sf)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(sf, "utf-8"));
    let sessions: any[] = Array.isArray(raw) ? raw : (raw.sessions || []);
    let changed = false;
    sessions = sessions.map(s => {
      const ns = { ...s };
      if (ns.timestamp && !ns.date) { ns.date = ns.timestamp.split("T")[0]; changed = true; }
      if (!ns.logged_at) { ns.logged_at = new Date().toISOString(); changed = true; }
      return ns;
    });
    if (changed) writeJSON(sf, { sessions });
  } catch { /* */ }
}

function generateRecoveryDoc(project: string, dataDir: string, logger: OrchestratorLogger): void {
  const pd = projDir(project, dataDir);
  const loc = getProjectLocation(project, dataDir);
  const context = readFileContent(path.join(pd, "CONTEXT.md")) || "";
  const blPath = path.join(pd, "BACKLOG.json");
  let backlog: ProjectBacklogTask[] = [];
  if (fs.existsSync(blPath)) { try { backlog = JSON.parse(fs.readFileSync(blPath, "utf-8")); } catch { /* */ } }

  const openTasks = backlog.filter(t => t.status === "todo" || t.status === "in_progress");
  const sessions = readRecentSessions(project, dataDir, 10);

  let md = `# ⚡ Recovery Doc: ${project}\n\n*Generated: ${new Date().toISOString()}*\n\nThis is a self-contained project state. If resuming after session loss,\nread this to catch up on context, decisions, and open work.\n\n## 1. Location\n\n${loc || "Not configured"}\n\n## 2. Context (first KB)\n\n${context.slice(0, 1000)}\n\n## 3. Open Backlog\n\n`;
  if (openTasks.length === 0) { md += `No open tasks.\n`; } else {
    md += `| Title | Priority | Status | Created |\n|------|----------|--------|---------|\n`;
    for (const t of openTasks) { md += `| ${t.title} | ${t.priority} | ${t.status} | ${t.created} |\n`; }
  }
  md += `\n## 4. Recent Sessions\n\n`;
  if (sessions.length === 0) { md += `No sessions recorded.\n`; } else {
    md += `| Date | Task | Model | Agent | Status | Duration |\n|------|------|-------|-------|--------|----------|\n`;
    for (const s of sessions) { md += `| ${s.date || "?"} | ${s.task} | ${s.model} | ${s.agent} | ${s.status} | ${s.duration || ""} |\n`; }
  }
  md += `\n---\n*End Recovery Doc*\n`;
  fs.writeFileSync(path.join(pd, "RECOVERY.md"), md, "utf-8");
  logger.debug("recovery", `Generated RECOVERY.md for ${project}`);
}

function readRecentSessions(project: string, dataDir: string, n: number): any[] {
  const sf = path.join(projDir(project, dataDir), "sessions.json");
  if (!fs.existsSync(sf)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(sf, "utf-8"));
    const sessions = Array.isArray(raw) ? raw : (raw.sessions || []);
    return sessions.slice(-n);
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════════════
//  BACKGROUND MAINTENANCE SERVICE
// ═══════════════════════════════════════════════════════════════

interface ControlAction {
  id: string;
  action: "set_context" | "clear_context" | "update_routing" | "spawn_agent" | "stop_agent";
  params: Record<string, any>;
  created_at: string;
  ttl_seconds?: number;
}

function controlDir(dataDir: string): string {
  return path.join(dataDir, "control");
}

function writeActionResult(dataDir: string, actionId: string, ok: boolean, result: any, error: string | null): void {
  try {
    const cd = controlDir(dataDir);
    if (!fs.existsSync(cd)) fs.mkdirSync(cd, { recursive: true });
    fs.writeFileSync(
      path.join(cd, `${actionId}.result.json`),
      JSON.stringify({
        id: actionId,
        ok,
        result,
        error,
        processed_at: new Date().toISOString(),
      }, null, 2)
    );
  } catch { /* silent */ }
}

function processSetContext(dataDir: string, params: Record<string, any>, logger: OrchestratorLogger): any {
  const project = params.project as string;
  const task = params.task as string;
  if (!project) throw new Error("Missing project");
  sessionTracker.setContext(project, task || "");
  writeLiveAgents("control_set_context", sessionTracker, logger);
  return { project, task, ok: true };
}

function processClearContext(dataDir: string, _params: Record<string, any>, logger: OrchestratorLogger): any {
  const prev = sessionTracker.currentProject;
  sessionTracker.clearContext();
  writeLiveAgents("control_clear_context", sessionTracker, logger);
  return { previous_project: prev, ok: true };
}

function processUpdateRouting(dataDir: string, params: Record<string, any>, logger: OrchestratorLogger): any {
  const cfg: DashboardConfig = readJSON(path.join(dataDir, "dashboard-config.json")) || {
    free_only_mode: false, disabled_models: [], projects: {}
  };
  if (typeof params.free_only_mode === "boolean") cfg.free_only_mode = params.free_only_mode;
  if (Array.isArray(params.disabled_models)) cfg.disabled_models = params.disabled_models;
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

function processControlAction(dataDir: string, action: ControlAction, logger: OrchestratorLogger): void {
  try {
    logger.info("control", `Processing action ${action.id}: ${action.action}`);
    let result: any;
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
  } catch (err: any) {
    logger.warn("control", `Action ${action.id} failed: ${err.message}`);
    writeActionResult(dataDir, action.id, false, null, err.message);
  }
}

class MaintenanceService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private dataDir: string;
  private logger: OrchestratorLogger;
  private safeguardLog: string[] = [];

  constructor(dataDir: string, logger: OrchestratorLogger) {
    this.dataDir = dataDir;
    this.logger = logger;
  }

  start(intervalMs: number = 30 * 60_000): void {
    if (this.started) return;
    this.started = true;
    // First tick sooner for safeguards
    setTimeout(() => this.tick(), 15_000);
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.logger.info("maintenance", `Started (every ${Math.round(intervalMs / 60000)}min)`);
  }

  tick(): void {
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
      if (!fs.existsSync(projDirPath)) return;
      const projects = fs.readdirSync(projDirPath).filter(f =>
        fs.statSync(path.join(projDirPath, f)).isDirectory()
      );
      for (const p of projects) {
        try {
          normalizeSessionsJson(p, this.dataDir);
          generateRecoveryDoc(p, this.dataDir, this.logger);
          if (getProjectLocation(p, this.dataDir)) {
            syncProjectToOrchestrator(p, this.dataDir, this.logger);
          }
        } catch (err: any) {
          this.logger.warn("maintenance", `Error processing ${p}: ${err.message}`);
        }
      }
      this.logger.debug("maintenance", `Tick: ${projects.length} projects processed, control actions checked`);
    } catch (err: any) {
      this.logger.warn("maintenance", `Tick error: ${err.message}`);
    }
  }

  processControlActions(): void {
    try {
      const cd = controlDir(this.dataDir);
      if (!fs.existsSync(cd)) return;
      const files = fs.readdirSync(cd)
        .filter(f => f.endsWith(".action.json"))
        .sort()
        .slice(0, 5); // Max 5 per tick
      for (const f of files) {
        const fp = path.join(cd, f);
        try {
          const raw = fs.readFileSync(fp, "utf-8");
          const action: ControlAction = JSON.parse(raw);
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
        } catch (err: any) {
          this.logger.warn("control", `Error processing ${f}: ${err.message}`);
          // Remove malformed actions to avoid re-processing
          try { fs.unlinkSync(fp); } catch { /* */ }
        }
      }
    } catch (err: any) {
      this.logger.warn("control", `processControlActions error: ${err.message}`);
    }
  }

  detectStaleAgents(): void {
    try {
      const laPath = path.join(this.dataDir, "live-agents.json");
      if (!fs.existsSync(laPath)) return;
      const cfg: DashboardConfig = readJSON(path.join(this.dataDir, "dashboard-config.json")) || {};
      const safeguards = cfg.safeguards || {};
      if (safeguards.enabled === false) return;

      const idleTimeout = safeguards.idle_timeout_ms || 10 * 60 * 1000;      // 10 min
      const stuckTimeout = safeguards.stuck_timeout_ms || 30 * 60 * 1000;    // 30 min
      const maxErrors = safeguards.max_errors_before_escalation || 3;
      const now = Date.now();

      const live = JSON.parse(fs.readFileSync(laPath, "utf-8"));
      const agents = live.agents || [];
      let recoveryNeeded = false;

      for (const a of agents) {
        if (!a.project) continue; // Skip agents without active project

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
          this.logger.warn("safeguard", `Agent ${agentName} idle for ${Math.round(elapsedSinceActivity/1000)}s (project: ${a.project})`);
          this.safeguardLog.push(`[${new Date().toISOString()}] IDLE: ${agentName} idle ${Math.round(elapsedSinceActivity/60000)}m on ${a.project}`);
          
          if (safeguards.auto_recover !== false && a.project) {
            // Auto-recover: write a set_context action for the same project
            const actionId = `recover_${agentName}_${Date.now()}`;
            const action = {
              id: actionId,
              action: "set_context" as const,
              params: { project: a.project, task: a.task || "auto-recovery" },
              created_at: new Date().toISOString(),
              ttl_seconds: 30,
            };
            try {
              const cd = controlDir(this.dataDir);
              if (!fs.existsSync(cd)) fs.mkdirSync(cd, { recursive: true });
              fs.writeFileSync(
                path.join(cd, `${actionId}.action.json`),
                JSON.stringify(action, null, 2)
              );
              this.logger.info("safeguard", `Auto-recovery triggered for ${agentName} on ${a.project}`);
              this.safeguardLog.push(`[${new Date().toISOString()}] RECOVER: ${agentName} → set_context ${a.project}`);
              recoveryNeeded = true;
            } catch (err: any) {
              this.logger.warn("safeguard", `Auto-recovery write failed: ${err.message}`);
            }
          }
        }

        // Check 2: Agent hasn't updated in too long despite having project context
        if (status !== "idle" && status !== "complete" && status !== "shutdown" && elapsedSinceUpdate > stuckTimeout) {
          this.logger.warn("safeguard", `Agent ${agentName} stuck (no update ${Math.round(elapsedSinceUpdate/60000)}m, status: ${status})`);
          this.safeguardLog.push(`[${new Date().toISOString()}] STUCK: ${agentName} no update ${Math.round(elapsedSinceUpdate/60000)}m (${status})`);
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
          if (parts) return `| ${parts[1]} | ${parts[2]} | ${parts[3]} |`;
          return `| ${new Date().toISOString()} | INFO | ${s} |`;
        });
        fs.writeFileSync(logPath, existing + lines.join("\n") + "\n");
        this.safeguardLog = [];
      }

      if (recoveryNeeded) {
        this.logger.info("safeguard", "Recovery actions written — next tick will process them");
      }
    } catch (err: any) {
      this.logger.warn("safeguard", `detectStaleAgents error: ${err.message}`);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

// ═══════════════════════════════════════════════════════════════
//  MODEL / DASHBOARD HELPERS
// ═══════════════════════════════════════════════════════════════

function isPaid(m: ModelEntry): boolean {
  return ["subscription", "payg", "pay_per_token"].includes(m.cost?.type || "");
}

function parseSessionLog(dd: string): any {
  const c = readFileContent(path.join(dd, "session_log.md"));
  if (!c) return { sessions: [], count: 0, projects: [] };
  const sessions: any[] = [];
  for (const l of c.split("\n")) {
    const t = l.trim();
    if (t.startsWith("|") && !t.startsWith("|---") && !t.startsWith("| Date")) {
      const p = t.split("|").slice(1, -1).map(x => x.trim());
      if (p.length >= 5) sessions.push({ date: p[0], project: p[1], task: p[2], model: p[3], agent: p[4] || "shell", status: p[5] || "", duration: p[6] || "", qa_done: p[7]?.includes("✓") || false, checked: p[8]?.includes("✓") || false, notes: p[9] || "" });
    }
  }
  return { sessions, count: sessions.length, projects: [...new Set(sessions.map(s => s.project))] };
}

function parsePriceLog(dd: string): any {
  const c = readFileContent(path.join(dd, "price_changes.log"));
  if (!c) return { entries: [], count: 0 };
  const entries = c.split("\n").filter(l => l.trim() && !l.startsWith("#")).map(l => ({ text: l.trim() }));
  return { entries, count: entries.length };
}

function projDir(name: string, dd: string): string {
  const p = path.join(dd, "projects", name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// ═══════════════════════════════════════════════════════════════
//  TOOL LOGIC
// ═══════════════════════════════════════════════════════════════

function getStatus(dataDir: string, logger: OrchestratorLogger) {
  const cfg: DashboardConfig = readJSON(path.join(dataDir, "dashboard-config.json")) || {};
  const md = readJSON(path.join(dataDir, "models.json"));
  const models: ModelEntry[] = md?.models || [];
  const pd = path.join(dataDir, "projects");
  const projects: string[] = [];
  if (fs.existsSync(pd)) {
    for (const e of fs.readdirSync(pd)) {
      if (e.startsWith(".")) continue; // Skip hidden dirs (.archived)
      if (fs.statSync(path.join(pd, e)).isDirectory()) projects.push(e);
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

function getConfig(dataDir: string, logger: OrchestratorLogger) {
  const cfg: DashboardConfig = readJSON(path.join(dataDir, "dashboard-config.json"));
  if (!cfg) return { error: "No config found — run orchestrator_auto_populate first", data_dir: dataDir };
  const models = readJSON(path.join(dataDir, "models.json"))?.models || [];
  const pc: Record<string, number> = {};
  for (const m of models) { const p = m.provider || "unknown"; pc[p] = (pc[p] || 0) + 1; }
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

function filterModelsForProject(models: ModelEntry[], project: string | undefined, dataDir: string): ModelEntry[] {
  if (!project) return [...models];
  const cfg: DashboardConfig = readJSON(path.join(dataDir, "dashboard-config.json")) || {};
  let f = [...models];
  if (cfg.free_only_mode) f = f.filter(m => !isPaid(m));
  const d = cfg.disabled_models || [];
  if (d.length) f = f.filter(m => !d.includes(m.id));
  const pc = cfg.projects?.[project];
  if (pc) {
    if (pc.model_allowlist?.length) f = f.filter(m => pc.model_allowlist!.includes(m.id));
    if (pc.free_only) f = f.filter(m => !isPaid(m));
  }
  return f;
}

function getModels(dataDir: string, opts: any, logger: OrchestratorLogger) {
  const md = readJSON(path.join(dataDir, "models.json"));
  let all: ModelEntry[] = md?.models || [];
  let f = filterModelsForProject(all, opts.project, dataDir);
  if (opts.status) {
    const ss = opts.status.split(",").map((s: string) => s.trim().toLowerCase());
    f = f.filter(m => ss.includes((m.status || "").toLowerCase()));
  }
  if (opts.provider) f = f.filter(m => (m.provider || "").toLowerCase().includes(opts.provider.toLowerCase()));
  if (opts.search) {
    const q = opts.search.toLowerCase();
    f = f.filter(m => m.id.toLowerCase().includes(q) || (m.name || "").toLowerCase().includes(q));
  }
  if (opts.agent_ready !== undefined) f = f.filter(m => m.agent_ready === opts.agent_ready);
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

function checkModels(dataDir: string, project: string | undefined, logger: OrchestratorLogger) {
  const cfg: DashboardConfig = readJSON(path.join(dataDir, "dashboard-config.json")) || {};
  const md = readJSON(path.join(dataDir, "models.json"));
  let eligible: ModelEntry[] = md?.models || [];
  const filters: string[] = [];
  if (cfg.free_only_mode) { eligible = eligible.filter(m => !isPaid(m)); filters.push("global_free_only"); }
  const d = cfg.disabled_models || [];
  if (d.length) { eligible = eligible.filter(m => !d.includes(m.id)); filters.push("global_disabled"); }
  const pc = project ? cfg.projects?.[project] : undefined;
  if (pc) {
    if (pc.model_allowlist?.length) { eligible = eligible.filter(m => pc.model_allowlist!.includes(m.id)); filters.push("project_allowlist"); }
    if (pc.free_only) { eligible = eligible.filter(m => !isPaid(m)); filters.push("project_free_only"); }
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

function autoPopulate(dataDir: string, logger: OrchestratorLogger) {
  const dd = getDashboardDir();
  const candidates = [
    path.join(dd, "..", "scripts", "auto-populate-models.py"),
    path.join(os.homedir(), ".openclaw/workspace/skills/genor-orchestrator", "scripts", "auto-populate-models.py"),
    path.join(os.homedir(), ".openclaw/extensions/genor-orchestrator", "scripts", "auto-populate-models.py"),
  ];
  let script = "";
  for (const c of candidates) { if (fs.existsSync(c)) { script = c; break; } }
  if (!script) return { error: "Script not found. Checked: " + candidates.join(", "), skill_dir: dd };
  try {
    logger.debug("populate", "Running...");
    const r = execSync(`python3 "${script}" 2>&1`, { cwd: path.dirname(script), encoding: "utf-8", timeout: 120_000 });
    const md = readJSON(path.join(dataDir, "models.json"));
    const t = md?.models?.length || 0;
    logger.info("populate", `Done: ${t} models`);
    return { success: true, total_models: t, output: r.trim() };
  } catch (err: any) {
    logger.error("populate", `Failed: ${err.message}`);
    return { success: false, error: err.message };
  }
}

function logSession(dataDir: string, opts: any, logger: OrchestratorLogger) {
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
  let ps: any[] = [];
  if (fs.existsSync(psf)) {
    try {
      const raw = JSON.parse(fs.readFileSync(psf, "utf-8"));
      if (Array.isArray(raw)) ps = raw;
      else if (raw?.sessions && Array.isArray(raw.sessions)) ps = raw.sessions;
    } catch { /* */ }
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
    const hash = require("crypto").createHash("sha256").update(`${opts.project}|${opts.task}|${startTime}`).digest("hex").slice(0, 12);
    sessionKey = `agent:main:synthetic:${safeProj}:${safeTask}:${hash}`;
  }
  const parentSessionKey = opts.parent_session_key || (sessionKey.includes(":subagent:") ? sessionKey.split(":subagent:")[0] : null);
  const agentNorm = (() => {
    const a = (opts.agent || "system").toString().toLowerCase();
    const m = a.match(/subagent[-_]?([0-9a-f]+)/);
    if (m) return `sub-${m[1].slice(0, 8)}`;
    if (a === "amy" || a === "spice") return a[0].toUpperCase() + a.slice(1);
    return a || "system";
  })();
  const tags = Array.isArray(opts.tags) ? opts.tags : extractTags(opts.task || "", opts.notes || "");
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
    start_time: opts.start_time || new Date().toISOString(),
    end_time: opts.end_time || (opts.status === "running" ? null : new Date().toISOString()),
    duration: opts.duration || "",
    tags,
    links: opts.links || { session_file: path.basename(df), recovery_doc: null, parent_recovery: null, synthetic_key: syntheticKey },
    notes: opts.notes || "",
    qa: opts.qa || false,
    checked: opts.checked || false,
    logged_at: new Date().toISOString(),
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

function logDecision(dataDir: string, opts: any, logger: OrchestratorLogger) {
  const date = new Date().toISOString().split("T")[0];
  const slug = opts.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const ad = path.join(dataDir, "adrs");
  fs.mkdirSync(ad, { recursive: true });
  let num = 1;
  const ex = fs.existsSync(ad) ? fs.readdirSync(ad).filter(f => /^\d{4}-.*\.md$/.test(f)) : [];
  if (ex.length > 0) num = Math.max(...ex.map(f => parseInt(f.split("-")[0], 10))) + 1;
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

function getLogs(dataDir: string, opts: any, logger: OrchestratorLogger) {
  const entries = logger.query(opts.limit || 50, { level: opts.level, source: opts.source, since: opts.since });
  return {
    entries: entries.map(e => ({ ts: e.ts, level: e.level, source: e.source, msg: e.msg, data: e.data || {} })),
    total: entries.length,
    sources: [...new Set(entries.map(e => e.source))],
    levels: [...new Set(entries.map(e => e.level))],
  };
}

function requireRegistration(): string | null {
  const sk = sessionTracker.sessionKey;
  if (sk && sessionTracker.isSessionRegistered(sk)) return null;
  return "This session is not registered with the orchestrator. Call orchestrator_register first to opt in to orchestrator tracking and project context injection.";
}

function setContext(dataDir: string, project: string, task: string, logger: OrchestratorLogger, originalPrompt?: string) {
  projDir(project, dataDir);

  // Read per-project workflow config from dashboard-config.json
  const cfg: DashboardConfig = readJSON(path.join(dataDir, "dashboard-config.json")) || {};
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
    } catch { /* */ }
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

function clearContextFn(dataDir: string, logger: OrchestratorLogger) {
  const prev = sessionTracker.currentProject;
  sessionTracker.clearContext();
  if (prev) {
    logger.info("context", `Context cleared: ${prev}`);
    writeLiveAgents("clear_context", sessionTracker);
  }
  return { ok: true, previous_project: prev };
}

function syncProject(dataDir: string, project: string, logger: OrchestratorLogger) {
  const loc = getProjectLocation(project, dataDir);
  if (!loc || !fs.existsSync(loc)) {
    return { error: `No valid location for ${project}`, project };
  }
  sessionTracker.trackAction(`syncing_project: ${project}`);
  writeLiveAgents("sync_project", sessionTracker);
  syncProjectToOrchestrator(project, dataDir, logger);
  return { ok: true, project, location: loc };
}

function getProjectDocsFn(dataDir: string, project: string, logger: OrchestratorLogger) {
  const pd = projDir(project, dataDir);
  const docs: string[] = [];
  if (fs.existsSync(pd)) {
    for (const f of fs.readdirSync(pd)) {
      if (f.endsWith(".md") || f.endsWith(".json")) docs.push(f);
    }
  }
  logger.debug("projects", `Docs for ${project}: ${docs.length}`);
  return { project, doc_count: docs.length, docs };
}

// ═══════════════════════════════════════════════════════════════
//  PLUGIN ENTRY
// ═══════════════════════════════════════════════════════════════

let maintenanceSvc: MaintenanceService | null = null;

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
] as const;

// Proper tool metadata for agent session exposure (OpenClaw agent tool injection).
// Each entry matches an api.registerTool({...}) call in register() below.
// Parameters use OpenClaw's TypeBox schema compiled to JSON Schema.
const TOOL_METADATA: Array<{ name: string; label: string; description: string; parameters: any }> = [
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
  { name: "orchestrator_doctor", label: "Doctor", description: "Diagnose and auto-fix common orchestrator issues: session key mismatches, broken registration, stale data, missing PM2 processes, context inconsistencies.", parameters: { type: "object", properties: { check: { type: "string", description: "Specific check: 'all', 'sessions', 'context', 'data', 'pm2'" }, fix: { type: "boolean", description: "Auto-fix issues when possible" } } } },
  { name: "orchestrator_release_project", label: "Release Project Binding", description: "Release the current session's project binding so it can work on a different project. Use when you're done with the current project and need to switch contexts with a fresh start.", parameters: { type: "object", properties: { force: { type: "boolean", description: "Force release even if migration in progress (default: false)" } } } },
  { name: "orchestrator_list_active_projects", label: "List Active Projects", description: "List projects that currently have active sessions working on them. Shows project names, active session count, and session keys.", parameters: { type: "object", properties: {} } },
  { name: "orchestrator_join_project", label: "Join Active Project", description: "Non-registered sessions can discover and join an active project. Handles registration + context setting in one step. Use for new/ad-hoc sessions contributing to existing projects.", parameters: { type: "object", properties: { project: { type: "string", description: "Project name to join. Use orchestrator_list_active_projects first." }, task: { type: "string", description: "Task description for what you're joining to do." } }, required: ["project", "task"] } },
  { name: "orchestrator_spawn_subagent", label: "Spawn Subagent", description: "Spawn a subagent using orchestrator-managed project context, with model routing and auto-logging. Logged as subagent session under current project. Returns session key for tracking.", parameters: { type: "object", properties: { task: { type: "string", description: "Task description for the subagent." }, model: { type: "string", description: "Optional model override. Omit to use project routing rules." }, taskName: { type: "string", description: "Optional stable name for subagent (lowercase_underscores)." }, timeoutSeconds: { type: "number", description: "Optional timeout in seconds (default: 300, max: 1800)." } }, required: ["task"] } },
];

const PLUGIN_ID = "genor-orchestrator";

const _plugin: Record<string, any> = definePluginEntry({
  id: PLUGIN_ID,
  name: "Genor's Orchestrator",
  description: "Model routing, session logging, project management, dashboard, hooks, and context injection. Plugin-driven: orchestrator drives the workflow, LLM focuses on thinking.",
  register(api) {
    const cfg = api.pluginConfig as Record<string, any> || {};
    const dataDir = getDataDir(cfg.orchestratorDataDir as string | undefined);
    const logLevel = (cfg.logLevel as string) || "info";
    const logRetention = (cfg.logRetentionDays as number) || 30;
    const logger = new OrchestratorLogger(dataDir, logLevel, logRetention);

    for (const sub of ["logs", "sessions", "adrs", "projects"]) {
      const p = path.join(dataDir, sub);
      if (!fs.existsSync(p)) {
        fs.mkdirSync(p, { recursive: true });
        logger.info("boot", `Created dir: ${sub}`);
      }
    }

    // Schedule nightly model population
    try {
      const scriptDir = path.join(getDashboardDir(), "..", "scripts", "auto-populate-models.py");
      if (fs.existsSync(scriptDir)) {
        const cronCmd = `python3 "${scriptDir}" 2>&1 >> "${path.join(dataDir, "logs", "auto-populate.log")}"`;
        const existing = execSync("crontab -l 2>/dev/null || true", { encoding: "utf-8", timeout: 5000 });
        if (!existing.includes("auto-populate-models.py")) {
          execSync(`(crontab -l 2>/dev/null; echo "0 3 * * * ${cronCmd} # genor-orchestrator auto-populate") | crontab -`, { timeout: 5000 });
          logger.info("boot", "Scheduled nightly model population (3 AM)");
        }
      }
    } catch { logger.debug("boot", "Cron scheduling skipped (no crontab access)"); }

    logger.info("plugin", "Plugin loaded", { dataDir, logLevel, logRetention });

    // ═══════════════════════════════════════════════════════════
    //  HOOKS
    // ═══════════════════════════════════════════════════════════

    api.on("session_start", async (event: any) => {
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
        sessionTracker.start(sk || "unknown", event.reason || "new");
        sessionTracker.trackAction("session_started");
        writeLiveAgents("session_start", sessionTracker, logger);
        logger.debug("hooks", `session_start: ${event.reason} key=${sk}`);
      } catch (err: any) { logger.error("hooks", `session_start error: ${err.message}`); }
    });

    api.on("session_end", async (event: any) => {
      try {
        const sk_end = (event.sessionKey || "").toString();
        
        // ═══ SCOPE: Only process registered sessions ═══
        // Plugin is invisible to unregistered sessions.
        // Skip all logging, auto-commit, and file writes.
        if (!sk_end || !sessionTracker.isSessionRegistered(sk_end)) {
          // Still clean up if somehow registered
          if (sk_end) sessionTracker.unregisterSession(sk_end);
          return;
        }

        // Clean up per-session project context
        if (sk_end) sessionTracker.unregisterSession(sk_end);
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
                    if (changed.length === 0) return;
                    // Bump patch version
                    let version = "0.0.0";
                    const pj = path.join(loc, "package.json");
                    if (fs.existsSync(pj)) {
                      try { version = JSON.parse(fs.readFileSync(pj, "utf-8")).version || "0.0.0"; } catch {}
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
                    child.on("close", (code: number | null) => {
                      if (code !== 0) return;
                      const child2 = spawn("git", ["commit", "-m", `v${newVersion}: session ${info.task} [auto-commit]`], { cwd: loc, stdio: "ignore" });
                      child2.on("close", (code2: number | null) => {
                        if (code2 !== 0) return;
                        spawn("git", ["tag", `v${newVersion}`], { cwd: loc, stdio: "ignore" });
                        spawn("git", ["push", "--tags"], { cwd: loc, stdio: "ignore" });
                        logger.info("hooks", `Auto-committed v${newVersion} for ${info.project}`);
                      });
                    });
                  } catch (e: any) {
                    logger.warn("hooks", `Auto-commit status check failed: ${e.message}`);
                  }
                };
                doAutoCommit();
              }
            } catch (e: any) {
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
          sessionTracker.currentAction = "session_complete";
          writeLiveAgents("session_complete", sessionTracker, logger);
          logger.info("hooks", `Session auto-logged: ${info.project}/${info.task} (${info.duration})`);
        }
        logger.debug("hooks", `session_end: ${event.reason}`);
      } catch (err: any) { logger.error("hooks", `session_end error: ${err.message}`); }
    });

    api.on("subagent_spawned", async (event: any) => {
      // ═══ SCOPE: Only track registered parent sessions ═══
      if (!sessionTracker.sessionKey || !sessionTracker.isSessionRegistered(sessionTracker.sessionKey)) return;
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

    api.on("subagent_ended", async (event: any) => {
      // ═══ SCOPE: Only track registered parent sessions ═══
      if (!sessionTracker.sessionKey || !sessionTracker.isSessionRegistered(sessionTracker.sessionKey)) return;
      const subKey = (event?.sessionKey || event?.subagentKey || "").toString();
      sessionTracker.subagentDepth = Math.max(0, sessionTracker.subagentDepth - 1);
      if (subKey) sessionTracker.untrackSubagent(subKey);
      if (sessionTracker.currentProject) {
        writeLiveAgents("subagent_ended", sessionTracker, logger);
      }
    });

    api.on("before_model_resolve", async (event: any, hookCtx: any) => {
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

        // Resolve session key from hook context - the REAL gateway key.
        // Bridge synthetic fallback keys (from orchestrator_register)
        // with the real key so before_prompt_build injection works.
        if (ctxSessionKey) {
          const isBackground = ctxSessionKey.includes("dreaming") || ctxSessionKey.includes(":cron:") || ctxSessionKey.includes(":subagent:") || ctxSessionKey.includes(":acp:");
          if (!isBackground) {
            // Bridge: register the real key alongside any synthetic one
            // so before_prompt_build finds the registration.
            // CRITICAL: Only bridge from synthetic fallback keys
            // (agent:main:auto:...) to real keys. NEVER bridge from one
            // real key to another — that would cross-contaminate sessions.
            const regSk = sessionTracker.sessionKey;
            if (regSk && regSk !== ctxSessionKey && regSk.startsWith("agent:main:auto:")) {
              sessionTracker.registerSession(ctxSessionKey);
              const existingCtx = sessionTracker.getSessionContext(regSk);
              if (existingCtx) {
                // start() resets context, so capture first then restore
                const { project, task } = existingCtx;
                sessionTracker.sessionKey = ctxSessionKey;
                sessionTracker.setContext(project, task || "");
                sessionTracker.setStatus("prompting");
              }
            }
            // Always adopt the real key as tracker primary key
            if (!sessionTracker.sessionKey || sessionTracker.sessionKey !== ctxSessionKey) {
              sessionTracker.start(ctxSessionKey, "resumed");
            }
            logger.info("hooks", "before_model_resolve: active session key=" + ctxSessionKey);
          }
        }
        sessionTracker.setStatus("resolving");
        sessionTracker.trackAction("resolving_model");
        writeLiveAgents("before_model_resolve", sessionTracker, logger);
        if (!sessionTracker.currentProject) return;

        const md = readJSON(path.join(dataDir, "models.json"));
        const allModels: ModelEntry[] = md?.models || [];
        const cfg2: DashboardConfig = readJSON(path.join(dataDir, "dashboard-config.json")) || {};
        const pc = cfg2.projects?.[sessionTracker.currentProject];
        let eligible = [...allModels];
        const filters: string[] = [];

        if (cfg2.free_only_mode) { eligible = eligible.filter(m => !isPaid(m)); filters.push("global_free_only"); }
        const disabled = cfg2.disabled_models || [];
        if (disabled.length) { eligible = eligible.filter(m => !disabled.includes(m.id)); filters.push("global_disabled"); }
        if (pc) {
          if (pc.model_allowlist?.length) { eligible = eligible.filter(m => pc.model_allowlist!.includes(m.id)); filters.push("project_allowlist"); }
          if (pc.free_only) { eligible = eligible.filter(m => !isPaid(m)); filters.push("project_free_only"); }
        }

        if (filters.length > 0 && eligible.length > 0) {
          const best = eligible
            .filter(m => m.agent_ready && m.status === "active")
            .sort((a, b) => (b.tier || 0) - (a.tier || 0))[0];
          if (best) {
            sessionTracker.trackModel(best.id, best.provider, best.tier);
            logger.debug("routing", `Auto-routed to ${best.id} for ${sessionTracker.currentProject}`);
            return { modelOverride: best.id };
          }
        }
        if (event?.resolvedModel) {
          const resolvedInfo = allModels.find((m: ModelEntry) => m.id === event.resolvedModel);
          sessionTracker.trackModel(event.resolvedModel, resolvedInfo?.provider, resolvedInfo?.tier);
        }
      } catch (err: any) { logger.error("hooks", `before_model_resolve error: ${err.message}`); }
    });

    api.on("before_prompt_build", async (event, hookCtx) => {
      try {
        sessionTracker.setStatus("prompting");
        sessionTracker.trackAction("building_prompt");
        writeLiveAgents("before_prompt_build", sessionTracker, logger);
        // Scope project context injection to the session that registered it.
        const hk = hookCtx?.sessionKey || "";
        // Safety net: if hook context has a real gateway key that differs
        // from the synthetic fallback, register it so the context check
        // still passes. This handles the case where before_model_resolve
        // was skipped or didn't bridge.
        // Safety net bridge: if hookCtx has a real key that differs from
        // the synthetic fallback, register it and copy context across.
        // CRITICAL: Only bridge from synthetic to real. Never bridge
        // from one real key to another (cross-session pollution).
        if (hk) {
          const skVal = sessionTracker.sessionKey;
          if (skVal && hk !== skVal && skVal.startsWith("agent:main:auto:") && sessionTracker.isSessionRegistered(skVal)) {
            const existingCtx = sessionTracker.getSessionContext(skVal);
            sessionTracker.registerSession(hk);
            if (existingCtx) {
              const { project, task } = existingCtx;
              sessionTracker.sessionKey = hk;
              sessionTracker.setContext(project, task || "");
              sessionTracker.setStatus("resolving");
            }
          }
        }
        const sk = hk || sessionTracker.sessionKey;
        // ONLY inject project context for explicitly registered sessions.
        // A session must call orchestrator_register() to opt in — no
        // chat/logging session ever gets context unless it registered.
        if (!sk || !sessionTracker.isSessionRegistered(sk)) return;
        const pc = sessionTracker.getSessionContext(sk);
        if (!pc) return;
        const loc = getProjectLocation(pc.project, dataDir);
        let ctx = `⚡ Project: ${pc.project}`;
        if (pc.task) ctx += ` | Task: ${pc.task}`;
        ctx += `\nLocation: ${loc || "not set"}`;
        ctx += ` | Sub-agents: ${sessionTracker.subagentDepth}`;
        ctx += ` | Data: orchestrator-data/projects/${pc.project}/`;
        return { prependContext: ctx };
      } catch { /* */ }
    });

    api.on("agent_end", async () => {
      sessionTracker.trackAction("agent_stopped");
      writeLiveAgents("agent_end", sessionTracker, logger);
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
        task: Type.String({ description: "Describe the task you are about to do, as a concise bullet list. Format:\n• What needs to be done\n• Why (context / motivation)\n• Scope (what files or systems are involved)\nExample: 'Add delete-story MCP tool to story-vault server. Currently story-vault has create/list/get but no delete. Requires: new delete_story tool in mcp_server.py, restart PM2 process.'" }),
        original_prompt: Type.Optional(Type.String({ description: "OPTIONAL: The original user request that triggered this task. Captured in the session log for traceability — so we can see WHY the work was started, not just WHAT was done. Recommended: include the user's full request verbatim. Truncated to 500 chars." })),
      }),
      async execute(_id: string, params: any) {
        const reg = requireRegistration();
        if (reg) return txt({ ok: false, error: reg });
        try {
          return txt(setContext(dataDir, params.project, params.task, logger, params.original_prompt));
        } catch (err: any) {
          return txt({ ok: false, error: err.message });
        }
      },
    });

    api.registerTool({
      name: "orchestrator_clear_context",
      label: "Orchestrator Clear Context",
      description: "Clear active project context. Disables auto-routing and auto-logging.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: any) {
        const reg = requireRegistration();
        if (reg) return txt({ ok: false, error: reg });
        return txt(clearContextFn(dataDir, logger));
      },
    });

    api.registerTool({
      name: "orchestrator_register",
      label: "Orchestrator Register",
      description: "Register this session for orchestrator tracking. Must be called BEFORE orchestrator_set_context. Once registered, the orchestrator tracks the session lifecycle (start → context → work → end) and injects project context into prompts. Only call this when you intend to do project work in this session.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: any) {
        // Resolve the session key: prefer the hook-populated key, fall back
        // to a synthetic stable key derived from agent identity + timestamp.
        // session_start may not fire for sessions that existed before a
        // gateway restart, so we can't depend on it for existing sessions.
        const sk = sessionTracker.sessionKey || agentDefaultSessionKey();
        if (!sk) return txt("error: no session key available");
        const newly = sessionTracker.registerSession(sk);
        if (newly) {
          // If no real session key was set yet, use this synthetic one
          // as the tracker's current key so requireRegistration() works.
          if (!sessionTracker.sessionKey) sessionTracker.sessionKey = sk;
          sessionTracker.trackAction("session_registered");
          writeLiveAgents("register", sessionTracker, logger);
          logger.info("hooks", `session registered: ${sk}`);
          return txt("registered");
        }
        return txt("already registered");
      },
    });

    api.registerTool({
      name: "orchestrator_unregister",
      label: "Orchestrator Unregister",
      description: "Unregister this session from orchestrator tracking. Clears project context and stops all tracking. The session will no longer receive project context injection. Call this when project work is complete or the session should no longer be tracked.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: any) {
        const sk = sessionTracker.sessionKey || agentDefaultSessionKey();
        if (!sk) return txt("error: no session key available");
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
      async execute(_id: string, params: any) {
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
      async execute(_id: string, params: any) {
        return txt(checkModels(dataDir, params.project, logger));
      },
    });

    api.registerTool({
      name: "orchestrator_auto_populate",
      label: "Auto-Populate",
      description: "Auto-populate model inventory from OpenClaw gateway config. Merges into orchestrator-data/models.json, preserving manual ratings.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: any) {
        const reg = requireRegistration();
        if (reg) return txt({ ok: false, error: reg });
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
      async execute(_id: string, params: any) {
        const reg = requireRegistration();
        if (reg) return txt({ ok: false, error: reg });
        sessionTracker.trackAction(`log: ${params.task}`);
        writeLiveAgents("tool_log_session", sessionTracker, logger);
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
      async execute(_id: string, params: any) {
        const reg = requireRegistration();
        if (reg) return txt({ ok: false, error: reg });
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
      async execute(_id: string, params: any) {
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
      async execute(_id: string, params: any) {
        const reg = requireRegistration();
        if (reg) return txt({ ok: false, error: reg });
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
      async execute(_id: string, params: any) {
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
      async execute(_id: string, params: any) {
        const reg = requireRegistration();
        if (reg) return txt({ ok: false, error: reg });
        const wf = sessionTracker.workflow;
        if (!wf.enabled) {
          return txt({ ok: false, error: "Workflow enforcement is not enabled for this project. Set workflow.enabled in dashboard-config.json" });
        }
        
        if (params.phase) {
          // Check transition is valid
          if (!wf.canTransitionTo(params.phase.toLowerCase() as any)) {
            return txt({ ok: false, error: `Cannot transition to '${params.phase}' from current phase '${wf.currentPhase}'. Workflow must go forward: ${["analyze","plan","document","work","log","finish"].join(" → ")}` });
          }
          wf.completePhase(wf.currentPhase, params.skip);
          wf.enterPhase(params.phase.toLowerCase() as any);
        } else {
          const next = wf.advance();
          if (!next) {
            return txt({ ok: true, warning: "Already at last phase. No more phases to advance.", phase: wf.currentPhase, progress: wf.getProgress() });
          }
        }
        
        sessionTracker.trackAction(`workflow: ${wf.currentPhase}`);
        writeLiveAgents("workflow_advance", sessionTracker, logger);
        logger.info("workflow", `Phase advanced: ${wf.currentPhase} (${wf.getProgress()})`);
        return txt({ ok: true, phase: wf.currentPhase, progress: wf.getProgress(), elapsed: wf.getPhaseElapsed(), phase_history: wf.phaseHistory });
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
      async execute(_id: string, params: any) {
        const cfg: DashboardConfig = readJSON(path.join(dataDir, "dashboard-config.json")) || {};
        const proj = params.project || sessionTracker.currentProject;
        if (!proj) {
          return txt({ ok: false, error: "No project specified and no project context set. Use orchestrator_set_context first or pass a project name." });
        }
        const pc = cfg.projects?.[proj];
        if (!pc) {
          return txt({ ok: false, error: `Project '${proj}' not found in dashboard-config.json` });
        }
        const routing = pc.model_routing;
        if (!routing) {
          return txt({ ok: false, error: `No model_routing configured for project '${proj}'` });
        }
        const cat = params.category.toLowerCase().trim();
        const models = routing[cat];
        if (!models || models.length === 0) {
          return txt({ ok: false, error: `No models routed for category '${cat}' in project '${proj}'. Available categories: ${Object.keys(routing).join(", ")}` });
        }
        return txt({
          ok: true,
          project: proj,
          category: cat,
          recommended: models[0],
          fallbacks: models.slice(1),
          all: models,
          source: "dashboard-config.json projects." + proj + ".model_routing",
        });
      },
    });

    api.registerTool({
      name: "orchestrator_get_registered_sessions",
      label: "Get Registered Sessions",
      description: "List all currently registered orchestrator sessions with their project context, status, and activity. Only sessions that explicitly called orchestrator_register are tracked.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: any) {
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
      description: "Diagnose and auto-fix common orchestrator issues: session key mismatches, broken registration, stale data, missing PM2 processes, context inconsistencies.",
      parameters: Type.Object({
        check: Type.Optional(Type.String({ description: "Specific check to run: 'all' (default), 'sessions', 'context', 'data', 'pm2'" })),
        fix: Type.Optional(Type.Boolean({ description: "Auto-fix discovered issues when possible (default: false)" })),
      }),
      async execute(_id: string, params: any) {
        const checks = (params.check || "all") as string;
        const autoFix = !!params.fix;
        const issues: string[] = [];
        const fixes: string[] = [];
        let ok = true;
        function addIssue(msg: string) { issues.push(msg); ok = false; }
        function addFix(msg: string) { fixes.push(msg); }

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
          } else {
            if (!sessionTracker.isSessionRegistered(hk)) {
              addIssue("Session key " + hk + " is not registered. Call orchestrator_register.");
              if (autoFix) { sessionTracker.registerSession(hk); addFix("Registered session: " + hk); }
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
              } else {
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
            .filter((x): x is { key: string; ctx: NonNullable<ReturnType<typeof sessionTracker.getSessionContext>> } => !!x.ctx);
          if (!ctx && allCtxRaw.length === 0) {
            addIssue("No project context set. Use orchestrator_set_context to activate a project.");
          } else if (!ctx && allCtxRaw.length > 0) {
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
              const activeModels = (md.models || []).filter((m: any) => m.status === "active").length;
              if (activeModels === 0) addIssue("models.json has 0 active models. Run orchestrator_auto_populate.");
            } catch (e: any) {
              addIssue("models.json is corrupt: " + e.message + ". Run orchestrator_auto_populate.");
              if (autoFix) { try { fs.unlinkSync(modelsPath); addFix("Deleted corrupt models.json"); } catch {} }
            }
          }
          const cfgPath = path.join(dataDir, "dashboard-config.json");
          if (!fs.existsSync(cfgPath)) addIssue("dashboard-config.json not found.");
          const logPath = path.join(dataDir, "logs", "orchestrator.jsonl");
          if (fs.existsSync(logPath)) {
            const stat = fs.statSync(logPath);
            const ageHrs = (Date.now() - stat.mtimeMs) / 3600000;
            if (ageHrs > 24) addIssue("orchestrator.jsonl last modified " + ageHrs.toFixed(1) + " hours ago.");
          } else { addIssue("orchestrator.jsonl missing."); }
          const livePath = path.join(dataDir, LIVE_AGENTS_FILE);
          if (fs.existsSync(livePath)) {
            const stat = fs.statSync(livePath);
            const ageSec = (Date.now() - stat.mtimeMs) / 1000;
            if (ageSec > 300) addIssue("live-agents.json stale (" + Math.round(ageSec) + "s old).");
            if (autoFix && ageSec > 600) { try { fs.unlinkSync(livePath); addFix("Removed stale live-agents.json"); } catch {} }
          }
        }

        // -- 4. BRIDGE PROCESS HEALTH (gateway-ws-bridge) --
        if (checks === "all" || checks === "pm2") {
          try {
            const pm2Out = execSync("pm2 jlist 2>/dev/null", { encoding: "utf-8", timeout: 5000 });
            const processes = JSON.parse(pm2Out);
            // Dashboard is served via registerHttpRoute — no PM2 process needed
            const bridgeProc = processes.find((p: any) => p.name === "genor-bridge" || p.name === "gateway-ws-bridge" || p.name === "gw-ws-bridge" || (p.pm2_env?.name?.includes("bridge")));
            if (!bridgeProc) addIssue("WebSocket bridge PM2 process not found (expected: genor-bridge, gateway-ws-bridge, or gw-ws-bridge).");
            else if (bridgeProc.pm2_env?.status !== "online") {
              addIssue("Bridge is " + (bridgeProc.pm2_env?.status || "unknown") + ".");
              if (autoFix) { try { execSync("pm2 start " + path.join(getDashboardDir(), "gateway-ws-bridge.js") + " --name gateway-ws-bridge 2>&1", { timeout: 10000 }); addFix("Started gateway-ws-bridge"); } catch (e: any) { addFix("Failed: " + e.message); } }
            }
          } catch (e: any) { addIssue("PM2 check failed: " + e.message); }
        }

        // -- 5. PROJECT HEALTH (requires required docs, no orphaned projects) --
        if (checks === "all" || checks === "data") {
          const REQUIRED_PROJECT_DOCS = ["STATE.md"];
          const pd = path.join(dataDir, "projects");
          if (fs.existsSync(pd)) {
            for (const e of fs.readdirSync(pd)) {
              const pp = path.join(pd, e);
              if (!fs.statSync(pp).isDirectory()) continue;
              // Check if project has any sessions
              const sf = path.join(pp, "sessions.json");
              let sessCount = 0;
              if (fs.existsSync(sf)) {
                try {
                  const d = JSON.parse(fs.readFileSync(sf, "utf-8"));
                  sessCount = (Array.isArray(d) ? d : (d.sessions || [])).length;
                } catch {}
              }
              // Check required docs
              const missingDocs = REQUIRED_PROJECT_DOCS.filter(doc => !fs.existsSync(path.join(pp, doc)));
              // Check for stale sessions (running entries older than 24h)
              let staleSessions = 0;
              if (sessCount > 0) {
                try {
                  const d = JSON.parse(fs.readFileSync(sf, "utf-8"));
                  const sessList = Array.isArray(d) ? d : (d.sessions || []);
                  staleSessions = sessList.filter((s: any) =>
                    s.status === "running" && s.start_time &&
                    (Date.now() - new Date(s.start_time).getTime()) > 86400000
                  ).length;
                } catch {}
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
                  } catch (archErr: any) {
                    addFix(`Failed to archive "${e}": ${archErr.message}`);
                  }
                }
              } else if (missingDocs.length > 0) {
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

        const result: any = { ok, checks: checks, auto_fix: autoFix, issues_found: issues.length, fixes_applied: fixes.length, session_key: sessionTracker.sessionKey || "(none)", registered: sessionTracker.sessionKey ? sessionTracker.isSessionRegistered(sessionTracker.sessionKey) : false, project_context: sessionTracker.currentProject || "(none)" };
        if (issues.length > 0) result.issues = issues;
        if (fixes.length > 0) result.fixes = fixes;
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
      async execute(_id: string, params: any) {
        const reg = requireRegistration();
        if (reg) return txt({ ok: false, error: reg });
        const sk = sessionTracker.sessionKey || agentDefaultSessionKey();
        const bound = sessionTracker.getBoundProject(sk);
        if (!bound) return txt({ ok: false, error: "No project binding to release." });
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
      async execute(_id: string, _params: any) {
        const active = sessionTracker.getActiveProjects();
        // Also supplement with projects from orchestrator-data that have sessions logged
        const pd = path.join(dataDir, "projects");
        const allProjects: Array<{ project: string; sessions_logged: number; location: string | null; healthy_docs: boolean; active_sessions: number }> = [];
        if (fs.existsSync(pd)) {
          for (const e of fs.readdirSync(pd)) {
            const pp = path.join(pd, e);
            if (!fs.statSync(pp).isDirectory()) continue;
            const sf = path.join(pp, "sessions.json");
            let sessCount = 0;
            if (fs.existsSync(sf)) {
              try {
                const d = JSON.parse(fs.readFileSync(sf, "utf-8"));
                sessCount = (Array.isArray(d) ? d : (d.sessions || [])).length;
              } catch { /* */ }
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
      async execute(_id: string, params: any) {
        const sk = sessionTracker.sessionKey || agentDefaultSessionKey();
        if (!sk) return txt({ ok: false, error: "No session key available." });

        // Auto-register this session
        sessionTracker.registerSession(sk);
        if (!sessionTracker.sessionKey) sessionTracker.sessionKey = sk;

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
        } catch (err: any) {
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
      async execute(_id: string, params: any) {
        const reg = requireRegistration();
        if (reg) return txt({ ok: false, error: "Session not registered. Call orchestrator_register or orchestrator_join_project first." });
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
          // Use api.spawnSubagent or sessions_spawn via the tool
          // The actual spawn is delegated to the OpenClaw runtime
          logger.info("subagent", `Spawning: ${taskName} (${project}/${task}) model=${model || "auto"}`);

          // Return the spawn request — the calling agent can use sessions_spawn
          // with the orchestrator context injected
          return txt({
            ok: true,
            project,
            task,
            task_name: taskName,
            recommended_model: model || "auto-routed",
            timeout_seconds: timeoutSeconds,
            spawn_instructions: `Use sessions_spawn with the following context:\n\n${spawnTask}\n\nRecommended: runtime="subagent", taskName="${taskName}", model="${model || "auto"}"`,
          });
        } catch (err: any) {
          logger.error("subagent", `Spawn failed for ${taskName}: ${err.message}`);
          return txt({ ok: false, error: `Failed to spawn subagent: ${err.message}` });
        }
      },
    });

    // ═══════════════════════════════════════════════════════════
    //  BACKGROUND MAINTENANCE
    // ═══════════════════════════════════════════════════════════

    if (maintenanceSvc) maintenanceSvc.stop();
    maintenanceSvc = new MaintenanceService(dataDir, logger);
    maintenanceSvc.start((cfg.maintenanceIntervalMs as number) || 30 * 60_000);


    const hostname = execSync("hostname", { encoding: "utf-8", timeout: 3000 }).trim();
    const dashPort = cfg.dashboardPort || 8767;
    let tailscaleHost = "";
    try {
      tailscaleHost = execSync("tailscale status 2>/dev/null | head -1 | awk '{print $2}'", { encoding: "utf-8", timeout: 3000 }).trim();
    } catch { /* tailscale not available */ }
    if (!tailscaleHost) tailscaleHost = hostname;

    // Shared: quick counts
    let modelCount = 0, sessionCount = 0;
    try {
      const mf = path.join(dataDir, "models.json");
      if (fs.existsSync(mf)) modelCount = JSON.parse(fs.readFileSync(mf, "utf-8")).models?.length || 0;
      const sf = path.join(dataDir, "session_log.md");
      if (fs.existsSync(sf)) sessionCount = fs.readFileSync(sf, "utf-8").split("\n").filter(l => l.startsWith("|") && !l.includes("Date") && !l.includes("---")).length;
    } catch { /* */ }

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
            } catch {}
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
          } catch (e: any) {
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
        } catch (e: any) {
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
          const issues: string[] = [];
          // Session key check
          if (!hk) issues.push("No session key set.");
          else if (!sessionTracker.isSessionRegistered(hk)) issues.push("Session not registered. Call orchestrator_register.");
          // Context check
          const ctx = hk ? sessionTracker.getSessionContext(hk) : null;
          if (!ctx) issues.push("No project context set. Use orchestrator_set_context.");
          // Log age check
          const logPath = path.join(dataDir, "logs", "orchestrator.jsonl");
          if (fs.existsSync(logPath)) {
            const stat = fs.statSync(logPath);
            const ageHrs = (Date.now() - stat.mtimeMs) / 3600000;
            if (ageHrs > 24) issues.push("Log file stale (" + ageHrs.toFixed(1) + "h).");
          } else issues.push("Log file missing.");
          // PM2 check
          try {
            const pm2Out = execSync("pm2 jlist 2>/dev/null", { encoding: "utf-8", timeout: 3000 });
            const procs = JSON.parse(pm2Out);
            const br = procs.find((p: any) => p.name === "genor-bridge" || p.name === "gateway-ws-bridge" || p.name === "gw-ws-bridge" || (p.pm2_env?.name?.includes("bridge")));
            if (!br) issues.push("gateway-ws-bridge PM2 process missing.");
            else if (br.pm2_env?.status !== "online") issues.push("gateway-ws-bridge is " + (br.pm2_env?.status || "unknown") + ".");
          } catch { issues.push("PM2 process list unavailable."); }

          const lines = ["**\uD83D\uDC8A Genor Orchestrator Doctor**"];
          if (issues.length === 0) {
            lines.push("", "**\u2705 All checks passed.**", "", "Session: " + hk);
          } else {
            lines.push("", "**" + issues.length + " issue(s) found:**", "");
            for (const iss of issues) lines.push(iss);
            lines.push("", "**Tip:** Use orchestrator_doctor (tool) with fix=true to auto-repair.");
          }
          return { text: lines.join("\n"), continueAgent: false };
        } catch (e: any) {
          return { text: "**\u274c Doctor error:** " + e.message, continueAgent: false };
        }
      },
    });

    // ── Dashboard HTTP handler — serve dashboard through gateway ──
    // Follows the same pattern as built-in plugins (canvas, admin-http-rpc, webhooks)
    try {
      const dashHandler = createDashboardHandler(api);
      api.registerHttpRoute({
        path: "/orchestrator",
        auth: "plugin",
        match: "prefix",
        handler: dashHandler,
      });
      logger.info("plugin", "Dashboard handler registered at /orchestrator");
    } catch (dhErr: any) {
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
