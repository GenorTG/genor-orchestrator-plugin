import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import * as url from "node:url";
import { execSync } from "node:child_process";

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

interface DashboardConfig {
  free_only_mode?: boolean;
  theme?: string;
  auto_refresh_seconds?: number;
  disabled_models?: string[];
  projects?: Record<string, { model_allowlist?: string[]; free_only?: boolean; location?: string }>;
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
// api.registerTool does NOT auto-wrap return values (unlike defineToolPlugin).
// We must return MCP-style content format explicitly.
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

  constructor(dataDir: string, level: string = "info", retentionDays: number = 30) {
    const logDir = path.join(dataDir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    this.logFile = path.join(logDir, "orchestrator.jsonl");
    this.level = level;
    this.retentionDays = retentionDays;
    this.cleanupTimer = setInterval(() => this.cleanup(), 6 * 3600_000);
    setTimeout(() => this.cleanup(), 60_000);
  }

  private levelNum(l: string): number {
    return { debug: 0, info: 1, warn: 2, error: 3 }[l.toLowerCase()] ?? 1;
  }

  private write(level: string, source: string, msg: string, data?: Record<string, any>): void {
    if (this.levelNum(level) < this.levelNum(this.level)) return;
    try {
      const entry: LogEntry = { ts: new Date().toISOString(), level, source, msg };
      if (data && Object.keys(data).length > 0) entry.data = data;
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + "\n", "utf-8");
    } catch { /* logging never crashes */ }
  }

  debug(source: string, msg: string, data?: any) { this.write("debug", source, msg, data); }
  info(source: string, msg: string, data?: any) { this.write("info", source, msg, data); }
  warn(source: string, msg: string, data?: any) { this.write("warn", source, msg, data); }
  error(source: string, msg: string, data?: any) { this.write("error", source, msg, data); }

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
          if (opts?.level && this.levelNum(e.level) < this.levelNum(opts.level)) continue;
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
//  SESSION TRACKER — tracks active project/task/model/depth
// ═══════════════════════════════════════════════════════════════

class SessionTracker {
  currentProject: string | null = null;
  currentTask: string | null = null;
  currentModel: string | null = null;
  currentAgent: string = "Amy";
  sessionStartTimestamp: number = Date.now();
  sessionKey: string | null = null;
  subagentDepth: number = 0;
  /** Last action the agent was observed doing — shown live in dashboard */
  currentAction: string | null = null;
  /** Files the agent has touched this session */
  touchedFiles: string[] = [];

  trackModel(model: string): void { this.currentModel = model; }

  /** Record what the agent is doing right now — pushes to live-agents.json */
  trackAction(action: string, file?: string): void {
    this.currentAction = action;
    if (file && !this.touchedFiles.includes(file)) {
      this.touchedFiles.push(file);
    }
  }

  start(key: string, reason: string): void {
    this.sessionKey = key;
    this.sessionStartTimestamp = Date.now();
    this.subagentDepth = 0;
    this.currentAction = null;
    this.touchedFiles = [];
    if (reason === "new" || reason === "reset") {
      this.currentProject = null;
      this.currentTask = null;
      this.currentModel = null;
    }
  }

  end(): { project: string; task: string; duration: string; model: string } | null {
    if (!this.currentProject) return null;
    const ms = Date.now() - this.sessionStartTimestamp;
    const dur = ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}min`;
    return {
      project: this.currentProject,
      task: this.currentTask || "auto-task",
      duration: dur,
      model: this.currentModel || "auto",
    };
  }

  /** Build the live-agents.json state snapshot */
  toLiveState(): any {
    return {
      agent: this.currentAgent,
      project: this.currentProject,
      task: this.currentTask,
      model: this.currentModel,
      subagent_depth: this.subagentDepth,
      action: this.currentAction,
      touched_files: this.touchedFiles.slice(-20), // keep last 20
      timestamp: new Date().toISOString(),
      session_key: this.sessionKey,
      uptime_ms: Date.now() - this.sessionStartTimestamp,
    };
  }

  setContext(dataDir: string, project: string, task: string): any {
    this.currentProject = project;
    this.currentTask = task;
    this.currentAction = "Setting context";
    const loc = getProjectLocation(project, dataDir);
    const toc = loc ? buildProjectToc(loc) : [];
    writeLiveAgents("context", this);
    return { project, task, location: loc || "not configured", toc_file_count: toc.length };
  }

  clearContext(): void {
    this.currentProject = null;
    this.currentTask = null;
    this.currentModel = null;
    this.currentAction = null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  LIVE AGENTS FILE — written on every state change, polled by dashboard SSE
// ═══════════════════════════════════════════════════════════════

const LIVE_AGENTS_FILE = "live-agents.json";

function writeLiveAgents(reason: string, tracker: SessionTracker): void {
  try {
    const dataDir = getDataDir();
    const agents: any[] = [];

    // Main agent
    const main = tracker.toLiveState();
    main.reason = reason;
    if (main.project || main.agent) {
      agents.push(main);
    }

    // Sub-agents are derived from depth — the dashboard also reads from
    // per-project sessions.json for full tree visibility
    for (let i = 0; i < tracker.subagentDepth; i++) {
      agents.push({
        agent: `${tracker.currentAgent}::sub-${i + 1}`,
        project: tracker.currentProject,
        task: tracker.currentTask,
        model: tracker.currentModel,
        subagent_depth: 0,
        action: "working",
        touched_files: [],
        timestamp: new Date().toISOString(),
        session_key: null,
        uptime_ms: 0,
        parent_depth: i + 1,
      });
    }

    const filePath = path.join(dataDir, LIVE_AGENTS_FILE);
    writeJSON(filePath, {
      agents,
      agent_count: agents.length,
      active_count: agents.filter(a => a.project).length,
      last_updated: new Date().toISOString(),
      reason,
    });

    // Also update state.json for backward compat
    const stateFile = path.join(dataDir, "state.json");
    if (tracker.currentProject) {
      const state: any = {
        project: tracker.currentProject,
        task: tracker.currentTask,
        model: tracker.currentModel,
        agent: tracker.currentAgent,
        timestamp: new Date().toISOString(),
        subagent_depth: tracker.subagentDepth,
        action: tracker.currentAction,
      };
      writeJSON(stateFile, state);
    }
  } catch { /* writing agent state never crashes */ }
}

const sessionTracker = new SessionTracker();

// ═══════════════════════════════════════════════════════════════
//  PROJECT HELPERS — sync from disk, generate docs
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
  } catch {}
  const tocDisplay = toc.filter(f => !f.includes("node_modules") && !f.includes("/."));
  context += `\n## File Index (${tocDisplay.length} files)\n\n${tocDisplay.map(f => `- ${path.relative(loc, f)}`).join("\n")}\n`;
  fs.writeFileSync(path.join(pd, "CONTEXT.md"), context, "utf-8");

  let tocMd = `# ${project} \u2014 File Index\n\n**Location:** \`${loc}\`\n\n### Key Files (${keyFiles.length})\n\n`;
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
  } catch {}
}

function generateRecoveryDoc(project: string, dataDir: string, logger: OrchestratorLogger): void {
  const pd = projDir(project, dataDir);
  const loc = getProjectLocation(project, dataDir);
  const context = readFileContent(path.join(pd, "CONTEXT.md")) || "";

  const blPath = path.join(pd, "BACKLOG.json");
  let backlog: ProjectBacklogTask[] = [];
  if (fs.existsSync(blPath)) { try { backlog = JSON.parse(fs.readFileSync(blPath, "utf-8")); } catch {} }

  const openTasks = backlog.filter(t => t.status === "todo" || t.status === "in_progress");
  const sessions = readRecentSessions(project, dataDir, 10);

  let md = `# \u26a1 Recovery Doc: ${project}\n\n*Generated: ${new Date().toISOString()}*\n\nThis is a self-contained project state. If resuming after session loss,\nread this to catch up on context, decisions, and open work.\n\n## 1. Location\n\n${loc || "Not configured"}\n\n## 2. Context (first KB)\n\n${context.slice(0, 1000)}\n\n## 3. Open Backlog\n\n`;

  if (openTasks.length === 0) {
    md += `No open tasks.\n`;
  } else {
    md += `| Title | Priority | Status | Created |\n|------|----------|--------|---------|\n`;
    for (const t of openTasks) { md += `| ${t.title} | ${t.priority} | ${t.status} | ${t.created} |\n`; }
  }

  md += `\n## 4. Recent Sessions\n\n`;
  if (sessions.length === 0) { md += `No sessions recorded.\n`; }
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

class MaintenanceService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private dataDir: string;
  private logger: OrchestratorLogger;

  constructor(dataDir: string, logger: OrchestratorLogger) {
    this.dataDir = dataDir;
    this.logger = logger;
  }

  start(intervalMs: number = 30 * 60_000): void {
    if (this.timer) { clearInterval(this.timer); clearTimeout((this.timer as any)._firstTick); }
    const firstTick = setTimeout(() => this.tick(), 60_000);
    (firstTick as any)._firstTick = true;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.logger.info("maintenance", `Started (every ${Math.round(intervalMs/60000)}min)`);
  }

  tick(): void {
    try {
      const projDirPath = path.join(this.dataDir, "projects");

      // Enforce log rotation on every tick
      this.logger.cleanup();

      // Cleanup stale auto-populate logs (>90 days)
      const popLog = path.join(this.dataDir, "logs", "auto-populate.log");
      if (fs.existsSync(popLog)) {
        try {
          const stat = fs.statSync(popLog);
          if (Date.now() - stat.mtimeMs > 90 * 24 * 60 * 60_000) {
            fs.truncateSync(popLog, 0);
            this.logger.debug("maintenance", "Rotated auto-populate.log");
          }
        } catch { /* */ }
      }

      // Process projects
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

      this.logger.debug("maintenance", `Tick: ${projects.length} projects processed`);
    } catch (err: any) {
      this.logger.warn("maintenance", `Tick error: ${err.message}`);
    }
  }

  stop(): void { if (this.timer) clearInterval(this.timer); }
}








function msum(m: ModelEntry): any {
  return {
    id: m.id, name: m.name || m.id, provider: m.provider || m.host || "?",
    tier: m.tier || 0, speed_rating: m.speed_rating || 0,
    context_window: m.context_window || 0, architecture: m.architecture || "",
    status: m.status || "active", agent_ready: m.agent_ready ?? true,
    cost_type: m.cost?.type || "?", cost_amount: m.cost?.amount || 0,
    cost_period: m.cost?.period || "", cost_limits: m.cost?.limits || "",
    cost_source: m.cost?.source_url || "", cost_last_checked: m.cost?.last_checked || "",
    capabilities: m.capabilities || {}, user_notes: m.user_notes || "",
    research_notes: m.research_notes || "", research_sources: m.research_sources || [],
    catalogued_by: m.catalogued_by || "", last_tested: m.last_tested || "", gpu: m.gpu || "",
  };
}

function isPaid(m: ModelEntry): boolean { return ["subscription", "payg", "pay_per_token"].includes(m.cost?.type || ""); }

function loadModelsForDash(models: ModelEntry[], cfg: DashboardConfig, project?: string): any {
  let f = [...models];
  if (cfg.free_only_mode) f = f.filter(m => !isPaid(m));
  const d = cfg.disabled_models || [];
  if (d.length) f = f.filter(m => !d.includes(m.id));
  if (project) { const pc = cfg.projects?.[project]; if (pc) { if (pc.model_allowlist?.length) f = f.filter(m => pc.model_allowlist!.includes(m.id)); if (pc.free_only) f = f.filter(m => !isPaid(m)); } }
  const list = f.map(m => msum(m));
  return { models: list, total: list.length, active: list.filter(m => m.agent_ready && m.status !== "removed").length, broken: list.filter(m => !m.agent_ready).length, removed: list.filter(m => m.status === "removed").length, free_only: cfg.free_only_mode || false, disabled_count: d.length, project: project || null };
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

function loadProjs(dd: string): any {
  const pd = path.join(dd, "projects");
  if (!fs.existsSync(pd)) return { projects: [], count: 0 };
  const projects: any[] = [];
  for (const n of fs.readdirSync(pd)) {
    const pp = path.join(pd, n);
    if (!fs.statSync(pp).isDirectory()) continue;
    const sf = path.join(pp, "sessions.json");
    let rawSessions: any[] = [];
    if (fs.existsSync(sf)) {
      try {
        const raw = JSON.parse(fs.readFileSync(sf, "utf-8"));
        if (Array.isArray(raw)) rawSessions = raw;
        else if (raw?.sessions && Array.isArray(raw.sessions)) rawSessions = raw.sessions;
      } catch {}
    }
    const sessions = rawSessions.slice(-5);
    projects.push({
      name: n,
      session_count: rawSessions.length,
      sessions,
      created: rawSessions[0]?.logged_at || rawSessions[0]?.timestamp || "N/A",
      task_count: new Set(rawSessions.map((x: any) => x.task || x.title)).size,
    });
  }
  return { projects, count: projects.length };
}

function enrichProj(pd: any, cfg: DashboardConfig): any {
  for (const p of pd.projects || []) {
    const pc = cfg.projects?.[p.name];
    p.model_allowlist = pc?.model_allowlist || [];
    p.allowlist_count = p.model_allowlist.length;
    p.free_only = pc?.free_only || false;
    p.location = pc?.location || "";
  }
  return pd;
}

function projDir(name: string, dd: string): string { const p = path.join(dd, "projects", name); fs.mkdirSync(p, { recursive: true }); return p; }

function getProjState(name: string, dd: string, cfg: DashboardConfig): any {
  const pd = projDir(name, dd);
  const pc = cfg.projects?.[name] || {};
  const sf = path.join(pd, "sessions.json");
  let s: any[] = [];
  if (fs.existsSync(sf)) {
    try {
      const raw = JSON.parse(fs.readFileSync(sf, "utf-8"));
      if (Array.isArray(raw)) s = raw;
      else if (raw?.sessions && Array.isArray(raw.sessions)) s = raw.sessions;
    } catch {}
  }
  return { name, config: pc, sessions: s, session_count: s.length, docs: fs.readdirSync(pd).filter(f => fs.statSync(path.join(pd, f)).isFile()).map(f => ({ name: f })), state: readFileContent(path.join(pd, "STATE.md")) || "", roadmap: readFileContent(path.join(pd, "ROADMAP.md")) || "", context: readFileContent(path.join(pd, "CONTEXT.md")) || "", notes: readFileContent(path.join(pd, "NOTES.md")) || "" };
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
  if (fs.existsSync(pd)) { for (const e of fs.readdirSync(pd)) { const pp = path.join(pd, e); if (fs.statSync(pp).isDirectory()) projects.push(e); } }
  logger.debug("status", "Status requested");
  const sl = parseSessionLog(dataDir);
  return {
    total_models: models.length, active_models: models.filter(m => m.status === "active").length,
    agent_ready_models: models.filter(m => m.agent_ready).length,
    sessions_logged: sl.count, projects, free_only_mode: cfg.free_only_mode || false,
    data_dir: dataDir,
  };
}

function getConfig(dataDir: string, logger: OrchestratorLogger) {
  const cfg: DashboardConfig = readJSON(path.join(dataDir, "dashboard-config.json"));
  if (!cfg) return { error: "No config found — run orchestrator_auto_populate first", data_dir: dataDir };
  const md = readJSON(path.join(dataDir, "models.json"));
  const models = md?.models || [];
  const pc: Record<string, number> = {};
  for (const m of models) { const p = m.provider || "unknown"; pc[p] = (pc[p] || 0) + 1; }
  logger.debug("config", "Config requested");
  return {
    free_only_mode: cfg.free_only_mode || false, disabled_models: cfg.disabled_models || [],
    projects: Object.entries(cfg.projects || {}).map(([n, c]) => ({ name: n, model_allowlist: c.model_allowlist || [], free_only: c.free_only || false, whitelist_count: c.model_allowlist?.length || 0 })),
    total_models: models.length, providers: pc, project_count: Object.keys(cfg.projects || {}).length,
  };
}

function getModels(dataDir: string, opts: any, logger: OrchestratorLogger) {
  const md = readJSON(path.join(dataDir, "models.json"));
  let all: ModelEntry[] = md?.models || [];
  let f = [...all];
  if (opts.project) {
    const cfg: DashboardConfig = readJSON(path.join(dataDir, "dashboard-config.json")) || {};
    const proj = cfg.projects?.[opts.project];
    if (cfg.free_only_mode) f = f.filter(m => !isPaid(m));
    const d = cfg.disabled_models || [];
    if (d.length) f = f.filter(m => !d.includes(m.id));
    if (proj) {
      if (proj.model_allowlist?.length) f = f.filter(m => proj.model_allowlist!.includes(m.id));
      if (proj.free_only) f = f.filter(m => !isPaid(m));
    }
  }
  if (opts.status) { const ss = opts.status.split(",").map((s: string) => s.trim().toLowerCase()); f = f.filter(m => ss.includes((m.status || "").toLowerCase())); }
  if (opts.provider) f = f.filter(m => (m.provider || "").toLowerCase().includes(opts.provider.toLowerCase()));
  if (opts.search) { const q = opts.search.toLowerCase(); f = f.filter(m => m.id.toLowerCase().includes(q) || (m.name || "").toLowerCase().includes(q)); }
  if (opts.agent_ready !== undefined) f = f.filter(m => m.agent_ready === opts.agent_ready);
  logger.debug("models", `Listed ${f.length}/${all.length}`);
  return { total: all.length, filtered: f.length, models: f.map(m => ({ id: m.id, provider: m.provider, name: m.name, tier: m.tier, speed_rating: m.speed_rating, status: m.status, agent_ready: m.agent_ready, cost_type: m.cost?.type || "unknown", context_window: m.context_window || 0, capabilities: m.capabilities || {}, notes: m.notes || "" })) };
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
  return { project: project || null, free_only_mode: cfg.free_only_mode || false, disabled_models: d, filters_applied: filters, total_available: all, eligible_count: eligible.length, eligible_models: eligible.map(m => ({ id: m.id, provider: m.provider, name: m.name, tier: m.tier, speed_rating: m.speed_rating, status: m.status, agent_ready: m.agent_ready, cost_type: m.cost?.type || "unknown" })) };
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
  } catch (err: any) { logger.error("populate", `Failed: ${err.message}`); return { success: false, error: err.message }; }
}

function logSession(dataDir: string, opts: any, logger: OrchestratorLogger) {
  const date = new Date().toISOString().split("T")[0];
  const sp = opts.project.replace(/[^a-zA-Z0-9_-]/g, "-");
  const st = opts.task.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
  const slp = path.join(dataDir, "session_log.md");
  if (!fs.existsSync(slp)) fs.writeFileSync(slp, "# Session Log\n\n| Date | Project | Task | Model | Agent | Status | Duration | QA | Checked | Notes |\n|------|---------|------|-------|-------|--------|----------|----|---------|-------|\n", "utf-8");
  fs.appendFileSync(slp, `| ${date} | ${opts.project} | ${opts.task} | ${opts.model} | ${opts.agent} | ${opts.status} | ${opts.duration || ""} | ${opts.qa ? "true" : "false"} | ${opts.checked ? "true" : "false"} | ${opts.notes || ""} |\n`, "utf-8");
  const sd = path.join(dataDir, "sessions"); fs.mkdirSync(sd, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const df = path.join(sd, `${ts}-${sp}-${st}.md`);
  fs.writeFileSync(df, `# Session: ${opts.project} / ${opts.task}\n\n**Date:** ${date}\n**Agent:** ${opts.agent}\n**Model:** ${opts.model}\n**Status:** ${opts.status}\n**Duration:** ${opts.duration || "N/A"}\n**QA:** ${opts.qa ? "true" : "false"} | **Checked:** ${opts.checked ? "true" : "false"}\n\n## Notes\n\n${opts.notes || "None"}\n`, "utf-8");
  const pd = path.join(dataDir, "projects", sp); fs.mkdirSync(pd, { recursive: true });
  const psf = path.join(pd, "sessions.json");
  let ps: any[] = [];
  if (fs.existsSync(psf)) {
    try {
      const raw = JSON.parse(fs.readFileSync(psf, "utf-8"));
      if (Array.isArray(raw)) ps = raw;
      else if (raw?.sessions && Array.isArray(raw.sessions)) ps = raw.sessions;
    } catch {}
  }
  ps.push({ date, project: opts.project, task: opts.task, model: opts.model, agent: opts.agent, status: opts.status, duration: opts.duration || "", qa: opts.qa || false, checked: opts.checked || false, notes: opts.notes || "", logged_at: new Date().toISOString() });
  writeJSON(psf, { sessions: ps });
  logger.logSession(opts.project, opts.task, opts.model, opts.agent, opts.status);
  return { success: true, date, project: opts.project, task: opts.task, session_file: path.basename(df), total_project_sessions: ps.length };
}

function logDecision(dataDir: string, opts: any, logger: OrchestratorLogger) {
  const date = new Date().toISOString().split("T")[0];
  const slug = opts.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const ad = path.join(dataDir, "adrs"); fs.mkdirSync(ad, { recursive: true });
  let num = 1; const ex = fs.existsSync(ad) ? fs.readdirSync(ad).filter(f => /^\d{4}-.*\.md$/.test(f)) : [];
  if (ex.length > 0) num = Math.max(...ex.map(f => parseInt(f.split("-")[0], 10))) + 1;
  const p = String(num).padStart(4, "0"); const af = path.join(ad, `${p}-${slug}.md`);
  fs.writeFileSync(af, `# ADR-${p}: ${opts.title}\n\n**Status:** Accepted\n**Date:** ${date}\n**Project:** ${opts.project}\n\n## Context\n\n${opts.context}\n\n## Decision\n\n${opts.decision}\n\n## Alternatives Considered\n\n${opts.alternatives || "N/A"}\n\n## Consequences\n\n${opts.consequences || "TBD"}\n`, "utf-8");
  const dl = path.join(dataDir, "price_changes.log");
  if (!fs.existsSync(dl)) fs.writeFileSync(dl, "# Decision Log\n\n| Date | Project | Decision | ADR |\n|------|---------|----------|-----|\n", "utf-8");
  fs.appendFileSync(dl, `| ${date} | ${opts.project} | ${opts.title} | adrs/${p}-${slug}.md |\n`, "utf-8");
  logger.info("decisions", `ADR #${num}: ${opts.title}`, { file: `adrs/${p}-${slug}.md` });
  return { success: true, adr_number: num, adr_file: `adrs/${p}-${slug}.md`, title: opts.title, project: opts.project };
}

function getLogs(dataDir: string, opts: any, logger: OrchestratorLogger) {
  const entries = logger.query(opts.limit || 50, { level: opts.level, source: opts.source, since: opts.since });
  return { entries: entries.map(e => ({ ts: e.ts, level: e.level, source: e.source, msg: e.msg, data: e.data || {} })), total: entries.length, sources: [...new Set(entries.map(e => e.source))], levels: [...new Set(entries.map(e => e.level))] };
}

function setContext(dataDir: string, project: string, task: string, logger: OrchestratorLogger) {
  projDir(project, dataDir);
  const ctx = sessionTracker.setContext(dataDir, project, task);
  logger.info("context", `Context set: ${project}/${task}`);
  return {
    ok: true, project, task, location: ctx.location,
    location_configured: ctx.location !== "not configured",
    toc_file_count: ctx.toc_file_count,
    context_doc: ctx,
  };
}

function clearContext(_dataDir: string, logger: OrchestratorLogger) {
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
  if (!loc || !fs.existsSync(loc)) return { error: `No valid location for ${project}`, project };
  sessionTracker.trackAction(`syncing_project: ${project}`);
  writeLiveAgents("sync_project", sessionTracker);
  syncProjectToOrchestrator(project, dataDir, logger);
  return { ok: true, project, location: loc };
}

function getProjectDocs(dataDir: string, project: string, logger: OrchestratorLogger) {
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

const _plugin: Record<string, any> = definePluginEntry({
  id: "genor-orchestrator",
  name: "Genor's Orchestrator",
  description: "Model routing, session logging, project management, dashboard, hooks, and context injection. Plugin-driven: orchestrator drives the workflow, LLM focuses on thinking.",
  register(api) {
    const cfg = api.pluginConfig as Record<string, any> || {};
    const dataDir = getDataDir(cfg.orchestratorDataDir as string | undefined);
    const logLevel = (cfg.logLevel as string) || "info";
    const logRetention = (cfg.logRetentionDays as number) || 30;
    const logger = new OrchestratorLogger(dataDir, logLevel, logRetention);

    // Auto-create required data directories on every startup
    for (const sub of ["logs", "sessions", "adrs", "projects"]) {
      const p = path.join(dataDir, sub);
      if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); logger.info("boot", `Created dir: ${sub}`); }
    }

    // Auto-schedule nightly model population if not already scheduled
    try {
      const cronCmd = `python3 "${path.join(getDashboardDir(), "..", "scripts", "auto-populate-models.py")}" 2>&1 >> "${path.join(dataDir, "logs", "auto-populate.log")}"`;
      const existing = execSync("crontab -l 2>/dev/null || true", { encoding: "utf-8", timeout: 5000 });
      if (!existing.includes("auto-populate-models.py")) {
        execSync(`(crontab -l 2>/dev/null; echo "0 3 * * * ${cronCmd} # genor-orchestrator auto-populate") | crontab -`, { timeout: 5000 });
        execSync(`(crontab -l 2>/dev/null; echo "0 3 * * * ${cronCmd}") | crontab -`, { timeout: 5000 });
        logger.info("boot", "Scheduled nightly model population (3 AM)");
      }
    } catch (_c) { logger.debug("boot", "Cron scheduling skipped (no crontab access)"); }

    logger.info("plugin", "Plugin loaded", { dataDir, logLevel, logRetention });

    // ═══════════════════════════════════════════════════════════
    //  HOOKS — Plugin-driven automation
    // ═══════════════════════════════════════════════════════════

    api.on("session_start", async (event: any) => {
      try {
        sessionTracker.start(event.sessionKey || "unknown", event.reason || "new");
        writeLiveAgents("session_start", sessionTracker);
        logger.debug("hooks", `session_start: ${event.reason}`);
      } catch (err: any) { logger.error("hooks", `session_start error: ${err.message}`); }
    });

    api.on("session_end", async (event: any) => {
      try {
        writeLiveAgents("session_end", sessionTracker);
        const info = sessionTracker.end();
        if (info) {
          logSession(dataDir, {
            project: info.project,
            task: info.task,
            model: info.model,
            agent: sessionTracker.currentAgent,
            status: event.reason === "shutdown" ? "interrupted" : "complete",
            duration: info.duration,
            notes: `Auto-logged via session_end (${event.reason || "unknown"})`,
          }, logger);
          generateRecoveryDoc(info.project, dataDir, logger);
          // Final write with action="session_complete" so dashboard shows status
          sessionTracker.currentAction = "session_complete";
          writeLiveAgents("session_complete", sessionTracker);
          logger.info("hooks", `Session auto-logged: ${info.project}/${info.task} (${info.duration})`);
        }
        logger.debug("hooks", `session_end: ${event.reason}`);
      } catch (err: any) { logger.error("hooks", `session_end error: ${err.message}`); }
    });

    api.on("subagent_spawned", async (_event: any) => {
      try {
        sessionTracker.subagentDepth++;
        if (sessionTracker.currentProject) {
          logger.debug("subagent", `Depth ${sessionTracker.subagentDepth} for ${sessionTracker.currentProject}`);
        }
        writeLiveAgents("subagent_spawned", sessionTracker);
      } catch { /* */ }
    });

    api.on("subagent_ended", async (_event: any) => {
      try {
        sessionTracker.subagentDepth = Math.max(0, sessionTracker.subagentDepth - 1);
        if (sessionTracker.currentProject) {
          writeLiveAgents("subagent_ended", sessionTracker);
        }
      } catch { /* */ }
    });

    api.on("before_model_resolve", async (event: any) => {
      try {
        sessionTracker.trackAction("resolving_model");
        writeLiveAgents("before_model_resolve", sessionTracker);
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
            sessionTracker.trackModel(best.id);
            logger.debug("routing", `Auto-routed to ${best.id} for ${sessionTracker.currentProject}`);
            return { modelOverride: best.id };
          }
        }
        if (event?.resolvedModel) sessionTracker.trackModel(event.resolvedModel);
      } catch (err: any) { logger.error("hooks", `before_model_resolve error: ${err.message}`); }
    });

    api.on("before_prompt_build", async (event: any) => {
      try {
        sessionTracker.trackAction("building_prompt");
        writeLiveAgents("before_prompt_build", sessionTracker);
        if (!sessionTracker.currentProject) return;
        const loc = getProjectLocation(sessionTracker.currentProject, dataDir);
        let ctx = `⚡ Project: ${sessionTracker.currentProject}`;
        if (sessionTracker.currentTask) ctx += ` | Task: ${sessionTracker.currentTask}`;
        ctx += `\nLocation: ${loc || "not set"}`;
        ctx += ` | Sub-agents: ${sessionTracker.subagentDepth}`;
        ctx += ` | Data: orchestrator-data/projects/${sessionTracker.currentProject}/`;
        return { prependContext: ctx };
      } catch { /* */ }
    });

    api.on("agent_end", async (event: any) => {
      try {
        sessionTracker.trackAction("agent_stopped");
        writeLiveAgents("agent_end", sessionTracker);
        logger.debug("hooks", `agent_end for ${sessionTracker.currentProject || "no-project"}`);
      } catch { /* */ }
    });

    api.on("gateway_stop", async () => {
      try {
        maintenanceSvc?.stop();
        logger.stop();
      } catch { /* */ }
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
        task: Type.String({ description: "Task description (e.g., fix-dashboard-js-syntax)." }),
      }),
      async execute(_id: string, params: any) {
        return txt(setContext(dataDir, params.project, params.task, logger));
      },
    });

    api.registerTool({
      name: "orchestrator_clear_context",
      label: "Orchestrator Clear Context",
      description: "Clear active project context. Disables auto-routing and auto-logging.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: any) {
        return txt(clearContext(dataDir, logger));
      },
    });

    api.registerTool({
      name: "orchestrator_get_status",
      label: "Status",
      description: "Get quick orchestration status: model counts, session count, project list, free-only mode state.",
      parameters: Type.Object({}),
      async execute(_toolCallId: string, _params: unknown, _signal?: any) {
        return txt(getStatus(dataDir, logger));
      },
    });

    api.registerTool({
      name: "orchestrator_get_config",
      label: "Config",
      description: "Read the full routing configuration: free-only mode, disabled models, per-project allowlists.",
      parameters: Type.Object({}),
      async execute(_toolCallId: string, _params: unknown, _signal?: any) {
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
      async execute(_toolCallId: string, params: any, _signal?: any) {
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
      async execute(_toolCallId: string, params: any, _signal?: any) {
        return txt(checkModels(dataDir, params.project, logger));
      },
    });

    api.registerTool({
      name: "orchestrator_auto_populate",
      label: "Auto-Populate",
      description: "Auto-populate model inventory from OpenClaw gateway config. Merges into orchestrator-data/models.json, preserving manual ratings.",
      parameters: Type.Object({}),
      async execute(_toolCallId: string, _params: unknown, _signal?: any) {
        return txt(autoPopulate(dataDir, logger));
      },
    });

    api.registerTool({
      name: "orchestrator_log_session",
      label: "Log Session",
      description: "Log a completed session. Normally handled automatically by hooks; use for manual logging or retroactive entries.",
      parameters: Type.Object({
        project: Type.String({ description: "Project name." }),
        task: Type.String({ description: "Task description." }),
        model: Type.String({ description: "Model ID used." }),
        agent: Type.String({ description: "Agent name." }),
        status: Type.String({ description: "Status: complete, blocked, in_progress, failed." }),
        notes: Type.Optional(Type.String({ description: "Session notes." })),
        duration: Type.Optional(Type.String({ description: "Duration (e.g., 30min)." })),
        qa: Type.Optional(Type.Boolean({ description: "QA checked flag." })),
        checked: Type.Optional(Type.Boolean({ description: "Reviewed flag." })),
      }),
      async execute(_toolCallId: string, params: any, _signal?: any) {
        sessionTracker.trackAction(`log: ${params.task}`);
        writeLiveAgents("tool_log_session", sessionTracker);
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
        context: Type.String({ description: "Why this decision was made." }),
        decision: Type.String({ description: "What was decided." }),
        alternatives: Type.Optional(Type.String({ description: "Alternatives considered." })),
        consequences: Type.Optional(Type.String({ description: "Impact." })),
      }),
      async execute(_toolCallId: string, params: any, _signal?: any) {
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
      async execute(_toolCallId: string, params: any, _signal?: any) {
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
        sessionTracker.trackAction(`sync: ${params.project}`);
        writeLiveAgents("tool_sync_project", sessionTracker);
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
        return txt(getProjectDocs(dataDir, params.project, logger));
      },
    });

    // ═══════════════════════════════════════════════════════════
    //  BACKGROUND MAINTENANCE
    // ═══════════════════════════════════════════════════════════

    // Stop old service first to prevent duplicate timers on plugin reload
    if (maintenanceSvc) maintenanceSvc.stop();
    maintenanceSvc = new MaintenanceService(dataDir, logger);
    const maintInterval = (cfg.maintenanceIntervalMs as number) || 30 * 60_000;
    maintenanceSvc.start(maintInterval);

    // ═══════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════

    logger.info("plugin", `Orchestrator ready — ${logLevel} logging, maintenance active`);
  },
});

// Embed ClawHub plugin metadata directly on the export for static analyzers
export default Object.assign(_plugin, {
  __openclaw: {
    compat: { pluginApi: "0.1.0" },
    build: { openclawVersion: ">=2026.5.17" },
  },
});
