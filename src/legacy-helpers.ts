// ═══════════════════════════════════════════════════════════════
//  LEGACY HELPERS — file-based + tool-logic helpers extracted
//  from src/index.ts as part of the slice refactor.
//
//  Self-contained: no symbols from index.ts (only stdlib, db.ts,
//  session-tracker.ts, utils.ts, logger.ts).
//
//  INTENTIONALLY LEFT IN index.ts (caused circular dep risk):
//  - setContext, clearContextFn, syncProject — call queueLiveAgents,
//    getProjectLocation, buildProjectToc, syncProjectToOrchestrator
//    (all still in index.ts).
// ═══════════════════════════════════════════════════════════════

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import * as crypto from "node:crypto";
import { PLUGIN_ROOT, txt, getDashboardDir, readJSON, writeJSON, extractTags, readFileContent } from "./utils.js";
import { OrchestratorLogger } from "./logger.js";
import { SessionTracker, sessionTracker } from "./session-tracker.js";
import { queueLiveAgents } from "./live-agents.js";
import { _toolCount } from "./plugin-state.js";

export { sessionTracker };
import {
  initDb,
  countModels,
  addSession,
  listSessions,
  getAllSessions,
  listBacklogTasks,
  getBacklogTask,
  addBacklogTask,
  updateBacklogTask,
  listModels,
  getAllGlobalConfig,
  getAllProjectConfigs,
  getProjectConfig,
  countSessions,
  addStateEvent,
  getStateEvents,
} from "./db.js";

export interface ModelEntry {
  id: string;
  provider: string;
  name: string;
  status: string;
  agent_ready: boolean;
  capabilities?: Record<string, any>;
  cost?: Record<string, any>;
  context_window?: number;
  notes?: string;
  [key: string]: any;
}

// ═══════════════════════════════════════════════════════════════
//  MODEL / DASHBOARD HELPERS
// ═══════════════════════════════════════════════════════════════

function isPaid(m: ModelEntry): boolean {
  return ["subscription", "payg", "pay_per_token"].includes(m.cost?.type || "");
}

function projDir(name: string, dd: string): string {
  const p = path.join(dd, "projects", name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** Get the project data dir WITHOUT creating it. Returns null if it doesn't exist. */
function getProjDir(name: string, dd: string): string | null {
  const p = path.join(dd, "projects", name);
  if (fs.existsSync(p)) return p;
  return null;
}

// ═══════════════════════════════════════════════════════════════
//  ERROR LOGGING
// ═══════════════════════════════════════════════════════════════

function logOrchestratorError(project: string, dataDir: string, entry: {
  phase: string;
  step: string;
  error: string;
  action_taken: string;
}): void {
  const pd = projDir(project, dataDir);
  fs.mkdirSync(pd, { recursive: true });
  const errLog = path.join(pd, "errors.log");
  const timestamp = new Date().toISOString();
  const line = JSON.stringify({ ...entry, timestamp }) + "\n";
  try {
    fs.appendFileSync(errLog, line, "utf-8");
  } catch { /* errors never crash */ }
}

// ═══════════════════════════════════════════════════════════════
//  SESSION VALIDATION (Phase 4a)
// ═══════════════════════════════════════════════════════════════

interface SessionValidationIssue {
  id: string;
  session_key: string;
  issue: string;
  field: string;
  severity: "error" | "warn";
}

/** Validate session entries for integrity. Flags suspicious/fake entries without deleting. */
function validateSessions(dataDir: string, project?: string): {
  ok: boolean;
  total: number;
  issues: SessionValidationIssue[];
  projects_checked: string[];
} {
  const issues: SessionValidationIssue[] = [];
  let total = 0;
  const projectsChecked: string[] = [];

  const checkProject = (projName: string) => {
    const pd = getProjDir(projName, dataDir);
    if (!pd) return;
    let sessions: any[] = [];
    try {
      sessions = listSessions(projName).map(s => ({
        ...s,
        start_time: s.start_ts ? new Date(s.start_ts).toISOString() : s.logged_at,
        session_key: s.session_key,
      }));
    } catch { return; }
    if (!sessions.length) return;

    projectsChecked.push(projName);
    const seenIds = new Map<string, number>();

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      total++;
      const id = s.id || `index_${i}`;
      const sk = s.session_key || "";

      // 1. Valid session_key format
      if (!sk || typeof sk !== "string") {
        issues.push({ id, session_key: sk, issue: "Missing or invalid session_key", field: "session_key", severity: "error" });
      } else if (!sk.startsWith("agent:")) {
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
  } else {
    const projectsDir = path.join(dataDir, "projects");
    if (fs.existsSync(projectsDir)) {
      for (const p of fs.readdirSync(projectsDir).sort()) {
        if (p.startsWith(".")) continue;
        const pp = path.join(projectsDir, p);
        if (!fs.statSync(pp).isDirectory()) continue;
        checkProject(p);
      }
    }
  }

  return { ok: true, total, issues, projects_checked: projectsChecked };
}

// ═══════════════════════════════════════════════════════════════
//  BACKLOG MANAGEMENT
// ═══════════════════════════════════════════════════════════════

interface BacklogTask {
  id: string;
  title: string;
  description: string;
  status: "todo" | "in_progress" | "done" | "blocked";
  priority: "p0" | "p1" | "p2" | "p3";
  created: string;
  updated: string;
  assigned_to: string | null;
  depends_on: string[];
  labels: string[];
  session_key: string | null;
}

function getBacklogPath(project: string, dataDir: string): string {
  return path.join(projDir(project, dataDir), "BACKLOG.json");
}

function readBacklog(project: string, dataDir: string): any[] {
  try {
    return listBacklogTasks(project) as any[];
  } catch { return []; }
}

function readBacklogJson(project: string, dataDir: string): any[] {
  const bp = getBacklogPath(project, dataDir);
  if (!fs.existsSync(bp)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(bp, "utf-8"));
    return Array.isArray(raw) ? raw : (raw.tasks || []);
  } catch { return []; }
}

function writeBacklog(project: string, dataDir: string, tasks: any[]): void {
  writeJSON(getBacklogPath(project, dataDir), { tasks });
}

function backlogAdd(project: string, dataDir: string, opts: {
  title: string;
  description?: string;
  priority?: string;
  labels?: string[];
  depends_on?: string[];
}): { ok: boolean; id?: string; error?: string } {
  const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    // Insert into DB
    addBacklogTask({
      id,
      project,
      title: opts.title,
      description: opts.description || "",
      priority: (["p0","p1","p2","p3"].includes(opts.priority || "") ? opts.priority! : "p2"),
      status: "todo",
      labels: JSON.stringify(opts.labels || []),
      depends_on: JSON.stringify(opts.depends_on || []),
      assigned_to: "",
      session_refs: "[]",
      created_ts: now,
      updated_ts: now,
    });
    // Also write to JSON for backward compat (read from file to preserve existing tasks)
    const tasks = readBacklogJson(project, dataDir);
    tasks.push({
      id,
      title: opts.title,
      description: opts.description || "",
      status: "todo",
      priority: (["p0","p1","p2","p3"].includes(opts.priority || "") ? opts.priority! : "p2"),
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      assigned_to: null,
      depends_on: opts.depends_on || [],
      labels: opts.labels || [],
      session_key: null,
    });
    writeBacklog(project, dataDir, tasks);
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
  return { ok: true, id };
}

function backlogList(project: string, dataDir: string, opts?: {
  status?: string;
  priority?: string;
  label?: string;
}): { ok: boolean; tasks: any[] } {
  let tasks = readBacklog(project, dataDir);
  // Parse JSON string fields from DB rows for backward compat
  tasks = tasks.map((t: any) => ({
    ...t,
    labels: typeof t.labels === "string" ? JSON.parse(t.labels) : (t.labels || []),
    depends_on: typeof t.depends_on === "string" ? JSON.parse(t.depends_on) : (t.depends_on || []),
    session_refs: typeof t.session_refs === "string" ? JSON.parse(t.session_refs) : (t.session_refs || []),
  }));
  if (opts?.status) tasks = tasks.filter((t: any) => t.status === opts.status);
  if (opts?.priority) tasks = tasks.filter((t: any) => t.priority === opts.priority);
  if (opts?.label) tasks = tasks.filter((t: any) => (t.labels || []).includes(opts.label!));
  return { ok: true, tasks };
}

function backlogUpdate(project: string, dataDir: string, opts: {
  id: string;
  status?: string;
  priority?: string;
  assigned_to?: string;
  labels?: string[];
  session_key?: string;
}): { ok: boolean; error?: string } {
  try {
    const task = getBacklogTask(opts.id);
    if (!task) return { ok: false, error: `Task ${opts.id} not found. Use genorch_backlog_list to see available tasks.` };
    const updates: any = {};
    if (opts.status && ["todo","in_progress","done","blocked"].includes(opts.status)) updates.status = opts.status;
    if (opts.priority && ["p0","p1","p2","p3"].includes(opts.priority)) updates.priority = opts.priority;
    if (opts.assigned_to !== undefined) updates.assigned_to = opts.assigned_to || "";
    if (opts.labels !== undefined) updates.labels = JSON.stringify(opts.labels);
    if (opts.session_key !== undefined) updates.session_refs = JSON.stringify(opts.session_key ? [opts.session_key] : []);
    updateBacklogTask(opts.id, updates);
    // Also update JSON for backward compat
    const tasks = readBacklogJson(project, dataDir);
    const idx = tasks.findIndex((t: any) => t.id === opts.id);
    if (idx >= 0) {
      if (opts.status) tasks[idx].status = opts.status;
      if (opts.priority) tasks[idx].priority = opts.priority;
      if (opts.labels !== undefined) tasks[idx].labels = opts.labels;
      if (opts.assigned_to !== undefined) tasks[idx].assigned_to = opts.assigned_to;
      tasks[idx].updated = new Date().toISOString();
      writeBacklog(project, dataDir, tasks);
    }
  } catch (e: any) {
    return { ok: false, error: String(e) };
  }
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════
//  TOOL LOGIC
// ═══════════════════════════════════════════════════════════════

function getStatus(dataDir: string, logger: OrchestratorLogger) {
  const cfg = getAllGlobalConfig();
  const models = listModels(false);
  const allProjects = getAllProjectConfigs();
  const projects = Object.keys(allProjects);
  logger.debug("status", "Status requested");
  return {
    total_models: models.length,
    active_models: models.filter((m: any) => m.status === "active").length,
    agent_ready_models: models.filter((m: any) => m.agent_ready).length,
    sessions_logged: getAllSessions().length,
    projects,
    free_only_mode: cfg.free_only_mode || false,
    data_dir: dataDir,
  };
}

function getConfig(dataDir: string, logger: OrchestratorLogger) {
  const cfg = getAllGlobalConfig();
  const models = listModels(false);
  const allProjects = getAllProjectConfigs();
  const pc: Record<string, number> = {};
  for (const m of models) { const p = m.provider || "unknown"; pc[p] = (pc[p] || 0) + 1; }
  logger.debug("config", "Config requested");
  return {
    free_only_mode: cfg.free_only_mode || false,
    disabled_models: cfg.disabled_models || [],
    projects: Object.entries(allProjects).map(([n, c]: [string, any]) => ({
      name: n,
      model_allowlist: c.model_allowlist || [],
      free_only: c.free_only || false,
      whitelist_count: (c.model_allowlist || []).length,
    })),
    total_models: models.length,
    providers: pc,
    project_count: Object.keys(allProjects).length,
  };
}

function filterModelsForProject(project: string | undefined, dataDir: string): any[] {
  return listModels(false, project);
}

function getModels(dataDir: string, opts: any, logger: OrchestratorLogger) {
  let all = listModels(false);
  let f = filterModelsForProject(opts.project, dataDir);
  if (opts.status) {
    const ss = opts.status.split(",").map((s: string) => s.trim().toLowerCase());
    f = f.filter((m: any) => ss.includes((m.status || "").toLowerCase()));
  }
  if (opts.provider) f = f.filter((m: any) => (m.provider || "").toLowerCase().includes(opts.provider.toLowerCase()));
  if (opts.search) {
    const q = opts.search.toLowerCase();
    f = f.filter((m: any) => m.id.toLowerCase().includes(q) || (m.name || "").toLowerCase().includes(q));
  }
  if (opts.agent_ready !== undefined) f = f.filter((m: any) => m.agent_ready === opts.agent_ready);
  logger.debug("models", `Listed ${f.length}/${all.length}`);
  return {
    total: all.length,
    filtered: f.length,
    models: f.map((m: any) => ({
      id: m.id, provider: m.provider, name: m.name, status: m.status, agent_ready: m.agent_ready,
      cost_type: m.cost?.type || "unknown", context_window: m.context_window || 0,
      capabilities: m.capabilities || {}, notes: m.notes || "",
    })),
  };
}

function checkModels(dataDir: string, project: string | undefined, logger: OrchestratorLogger) {
  const cfg = getAllGlobalConfig();
  let eligible = listModels(false, project);
  const filters: string[] = [];
  if (cfg.free_only_mode) { eligible = eligible.filter((m: any) => !isPaid(m)); filters.push("global_free_only"); }
  const d: string[] = (cfg.disabled_models as string[]) || [];
  if (d.length) { eligible = eligible.filter((m: any) => !d.includes(m.id)); filters.push("global_disabled"); }
  const pc = project ? getProjectConfig(project) : undefined;
  if (pc) {
    if (pc.model_allowlist?.length) { eligible = eligible.filter((m: any) => pc.model_allowlist!.includes(m.id)); filters.push("project_allowlist"); }
    if (pc.free_only) { eligible = eligible.filter((m: any) => !isPaid(m)); filters.push("project_free_only"); }
  }
  const all = listModels(false).length;
  logger.logRouting(eligible[0]?.id || "none", project || null, eligible.length, all, filters);
  return {
    project: project || null, free_only_mode: cfg.free_only_mode || false,
    disabled_models: d, filters_applied: filters, total_available: all,
    eligible_count: eligible.length,
    eligible_models: eligible.map((m: any) => ({
      id: m.id, provider: m.provider, name: m.name, status: m.status, agent_ready: m.agent_ready,
      cost_type: m.cost?.type || "unknown",
    })),
  };
}

function autoPopulate(dataDir: string, logger: OrchestratorLogger) {
  // Script is bundled in the plugin package — no skill dir needed!
  const script = path.join(PLUGIN_ROOT, "scripts", "auto-populate-models.py");
  if (!fs.existsSync(script)) return { error: `Script not found at ${script} — ensure the plugin package includes scripts/auto-populate-models.py` };
  try {
    logger.debug("populate", "Running...");
    const r = execSync(`python3 "${script}" 2>&1`, { cwd: path.dirname(script), encoding: "utf-8", timeout: 120_000 });
    // After auto-populate, re-init DB to pick up newly written models.json
    initDb(dataDir);
    const t = countModels().total;
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
    if (m) return `sub-${m[1].slice(0, 8)}`;
    if (a === "amy" || a === "spice") return a[0].toUpperCase() + a.slice(1);
    return a || "system";
  })();
  const tags = Array.isArray(opts.tags) ? opts.tags : extractTags(opts.task || "", opts.notes || "");
  const now = new Date().toISOString();
  // Log to DB (primary store)
  try {
    addSession({
      id: sessId,
      project: opts.project,
      agent: agentNorm,
      model: opts.model || "",
      tags: JSON.stringify(tags),
      status: opts.status || "logged",
      task: opts.task || "",
      start_ts: opts.start_time ? Math.floor(new Date(opts.start_time).getTime() / 1000) : Math.floor(Date.now() / 1000),
      end_ts: opts.end_time ? Math.floor(new Date(opts.end_time).getTime() / 1000) : (opts.status === "running" ? null : Math.floor(Date.now() / 1000)),
      duration: opts.duration || "",
      session_key: sessionKey,
      extra: JSON.stringify({
        parent_session_key: parentSessionKey,
        goal: opts.goal || "",
        original_prompt: opts.original_prompt,
        notes: opts.notes || "",
        qa: opts.qa || false,
        checked: opts.checked || false,
        action_history: opts.action_history,
        touched_files: opts.touched_files,
        token_usage: opts.token_usage,
        workflow: opts.workflow,
        qa_status: opts.qa_status,
        qa_history: opts.qa_history,
        qa_findings: opts.qa_findings,
        error_count: opts.error_count,
        last_error: opts.last_error,
        last_activity_at: opts.last_activity_at,
        model_provider: opts.model_provider,
      }),
      logged_at: now,
    });
  } catch (e: any) {
    logger.warn("logSession", `DB write failed: ${e.message}`);
  }
  logger.logSession(opts.project, opts.task, opts.model, opts.agent, opts.status);
  return { success: true, date, project: opts.project, task: opts.task };
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
  return "This session is not registered with the orchestrator. Call genorch_session_register first to opt in to orchestrator tracking and project context injection.";
}

function requireBinding(): string | null {
  if (!sessionTracker.currentProject) return "No project bound. Call genorch_project_bind first to bind this session to a project and receive project context injection.";
  return null;
}

function getProjectDocsFn(dataDir: string, project: string, logger: OrchestratorLogger) {
  const pd = getProjDir(project, dataDir) || projDir(project, dataDir);
  // GetProjDir first (no create), fall back to projDir if we need to create for new projects
  const docs: string[] = [];
  if (pd && fs.existsSync(pd)) {
    for (const f of fs.readdirSync(pd)) {
      if (f.endsWith(".md") || f.endsWith(".json")) docs.push(f);
    }
  }
  logger.debug("projects", `Docs for ${project}: ${docs.length}`);
  return { project, doc_count: docs.length, docs };
}

// ═══════════════════════════════════════════════════════════════
//  PROJECT SYNC HELPERS
// ═══════════════════════════════════════════════════════════════

function getProjectLocation(project: string, dataDir: string): string | null {
  try {
    const pc = getProjectConfig(project);
    return pc?.location || null;
  } catch { return null; }
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
  } catch (e: any) { logger.debug("sync", "Package.json read failed:", e.message); }
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

function generateRecoveryDoc(project: string, dataDir: string, logger: OrchestratorLogger): void {
  const pd = getProjDir(project, dataDir);
  if (!pd) return; // Skip if project dir doesn't exist (archived/cleaned up)
  const loc = getProjectLocation(project, dataDir);
  const context = readFileContent(path.join(pd, "CONTEXT.md")) || "";
  // Read backlog from DB (with JSON fallback for backward compat)
  let backlog: any[] = [];
  try { backlog = listBacklogTasks(project).map(t => ({ title: t.title, priority: t.priority, status: t.status, created: t.created_ts ? new Date(t.created_ts * 1000).toISOString() : "?" })); } catch (e: any) { logger.warn("context", "Backlog fetch failed:", e.message); }
  if (backlog.length === 0) {
    const blPath = path.join(pd, "BACKLOG.json");
    if (fs.existsSync(blPath)) { try { const parsed = JSON.parse(fs.readFileSync(blPath, "utf-8")); backlog = Array.isArray(parsed) ? parsed : (parsed.tasks || []); } catch (e: any) { logger.warn("context", "JSON backlog fallback failed:", e.message); } }
  }

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
  try {
    const sessions = listSessions(project, n);
    return sessions.map(s => ({
      date: s.logged_at?.split("T")[0] || "",
      task: s.task,
      model: s.model,
      agent: s.agent,
      status: s.status,
      duration: s.duration,
      id: s.id,
      session_key: s.session_key,
    }));
  } catch { return []; }
}

function writeStateEvent(project: string, dataDir: string, event: Record<string, any>): void {
  try {
    addStateEvent(project, event.type || "event", {
      ...event,
      _ts: new Date().toISOString(),
      _id: crypto.randomUUID(),
    });
  } catch { /* best-effort — state log append */ }
}

function readStateEvents(project: string, dataDir: string): Record<string, any>[] {
  try {
    // Prefer DB first, fall back to JSONL
    const dbEvents = getStateEvents(project, 10000);
    if (dbEvents.length > 0) {
      return dbEvents.map((row: any) => {
        let eventData: any = {};
        if (typeof row.data === 'object') eventData = row.data;
        else if (typeof row.data === 'string') { try { eventData = JSON.parse(row.data); } catch {} }
        return {
          ...eventData,
          type: row.type,
          _ts: row.ts ? new Date(row.ts * 1000).toISOString() : null,
          _id: row.id,
        };
      });
    }
  } catch { /* fall through */ }
  return [];
}

// ═══════════════════════════════════════════════════════════════
//  PROJECT DOCS — read template / generated docs and assemble context
// ═══════════════════════════════════════════════════════════════

/** Read a project document from the project directory (or empty string if missing). */
function readProjectDoc(dataDir: string, projectName: string, fileName: string): string {
  if (!projectName) return "";
  const safeName = projectName.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeName) return "";
  const fp = path.join(dataDir, "projects", safeName, fileName);
  if (!fs.existsSync(fp)) return "";
  try {
    return fs.readFileSync(fp, "utf-8");
  } catch {
    return "";
  }
}

/** Extract the first N lines of a markdown doc (skipping blank lines and headers-only). */
function truncateDoc(content: string, maxLines: number, maxChars: number): string {
  if (!content) return "";
  const lines = content.split("\n");
  const out: string[] = [];
  let total = 0;
  for (const line of lines) {
    if (out.length >= maxLines) break;
    if (line.length + total > maxChars) break;
    out.push(line);
    total += line.length;
  }
  return out.join("\n");
}

/** Build a project context block from project docs (plan, style, features, architecture). */
function buildProjectDocContext(dataDir: string, projectName: string): string {
  if (!projectName) return "";

  const plan = readProjectDoc(dataDir, projectName, "PROJECT_PLAN.md");
  const style = readProjectDoc(dataDir, projectName, "STYLE_GUIDE.md");
  const features = readProjectDoc(dataDir, projectName, "FEATURES.md");
  const architecture = readProjectDoc(dataDir, projectName, "ARCHITECTURE.md");
  const bugs = readProjectDoc(dataDir, projectName, "BUGS.md");

  if (!plan && !style && !features && !architecture) return "";

  const sections: string[] = [];
  sections.push("━━━ PROJECT RULES & CONTEXT (auto-injected) ━━━");
  sections.push("Follow these rules automatically. They are project-specific and take priority over general behavior.");
  sections.push("");

  if (plan) {
    sections.push("📋 PROJECT PLAN:");
    sections.push(truncateDoc(plan, 25, 1500));
    sections.push("");
  }

  if (style) {
    sections.push("🎨 CODE & STYLE RULES (must follow):");
    sections.push(truncateDoc(style, 20, 1500));
    sections.push("");
  }

  if (architecture) {
    sections.push("🏛️ ARCHITECTURE & DESIGN DECISIONS:");
    sections.push(truncateDoc(architecture, 25, 1500));
    sections.push("");
  }

  if (features) {
    // Find in-progress section
    const lines = features.split("\n");
    let inProgressStart = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/in[\s_-]?progress/i.test(lines[i]) || /🚧/.test(lines[i])) {
        inProgressStart = i;
        break;
      }
    }
    if (inProgressStart >= 0) {
      const inProgress = lines.slice(inProgressStart, inProgressStart + 15).join("\n").trim();
      if (inProgress) {
        sections.push("🚧 ACTIVE FEATURES (in progress):");
        sections.push(inProgress);
        sections.push("");
      }
    } else {
      sections.push("📋 FEATURE INVENTORY:");
      sections.push(truncateDoc(features, 15, 1000));
      sections.push("");
    }
  }

  if (bugs) {
    // Find open bugs
    const lines = bugs.split("\n");
    let openStart = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/open\s*bugs|🪼/i.test(lines[i])) {
        openStart = i;
        break;
      }
    }
    if (openStart >= 0) {
      const openBugs = lines.slice(openStart, openStart + 15).join("\n").trim();
      if (openBugs && !openBugs.startsWith("## 🪼")) {
        sections.push("🐛 OPEN BUGS (verify these aren't reintroduced):");
        sections.push(openBugs);
        sections.push("");
      }
    }
  }

  sections.push("━━━ END PROJECT CONTEXT ━━━");
  return sections.join("\n");
}

// ── Project Document Templates ─────────────────────────────────
const PROJECT_TEMPLATES_DIR = path.join(PLUGIN_ROOT, "scripts", "project-templates");
const PROJECT_DOCS = [
  "PROJECT_PLAN.md",
  "FEATURES.md",
  "BUGS.md",
  "CHANGELOG.md",
  "STYLE_GUIDE.md",
  "ARCHITECTURE.md",
];

/** Initialize a new project directory with template documents. */
function initProjectDocs(projectDir: string, projectName: string, description?: string, location?: string): void {
  const date = new Date().toISOString().split("T")[0];
  const replacements: Record<string, string> = {
    "{{project_name}}": projectName,
    "{{date}}": date,
    "{{description}}": description || "",
    "{{location}}": location || "",
    "{{language}}": "TypeScript",
  };

  for (const fn of PROJECT_DOCS) {
    const templatePath = path.join(PROJECT_TEMPLATES_DIR, fn);
    if (!fs.existsSync(templatePath)) {
      continue; // template file missing — skip
    }
    let content = fs.readFileSync(templatePath, "utf-8");
    // Apply template substitutions
    for (const [key, val] of Object.entries(replacements)) {
      content = content.replaceAll(key, val);
    }
    const outPath = path.join(projectDir, fn);
    fs.writeFileSync(outPath, content, "utf-8");
  }
}

// ═══════════════════════════════════════════════════════════════
//  CONTEXT MANAGEMENT — set/clear/sync project context
// ═══════════════════════════════════════════════════════════════

function setContext(dataDir: string, project: string, task: string, logger: OrchestratorLogger, originalPrompt?: string) {
  projDir(project, dataDir);

  // Read per-project workflow config from DB
  const projCfg = getProjectConfig(project) || {};

  sessionTracker.setContext(project, task, projCfg.workflow);
  queueLiveAgents("context", sessionTracker);
  const loc = getProjectLocation(project, dataDir);
  const toc = loc ? buildProjectToc(loc) : [];

  // Warn if this project has NO sessions logged yet (brand new / never worked on)
  let sessionCount = countSessions(project);
  const isFresh = sessionCount === 0;

  // Auto-log session only when task is specified AND model is assigned
  // (binding-only calls with empty task skip logging)
  const sessionModel = sessionTracker.currentModel;
  if (task && sessionModel && sessionModel !== "pending") {
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
  // ═══ ENFORCE TASK COMPLETION LOGGING ═══
  // Before clearing context, require the session to have logged
  // its completion via genorch_session_log.
  if (sessionTracker.currentProject && !sessionTracker.loggedTaskCompletion) {
    return {
      ok: false,
      error: `❌ Task not logged. Session has active context on project "${sessionTracker.currentProject}" ` +
        `but hasn't logged completion. Call genorch_session_log with status="done" (or "blocked"/"failed") ` +
        `first to document what was done. This ensures no work falls through the cracks.`,
    };
  }

  const prev = sessionTracker.currentProject;
  sessionTracker.clearContext();
  if (prev) {
    logger.info("context", `Context cleared: ${prev}`);
    queueLiveAgents("clear_context", sessionTracker);
  }
  return { ok: true, previous_project: prev };
}

function syncProject(dataDir: string, project: string, logger: OrchestratorLogger) {
  const loc = getProjectLocation(project, dataDir);
  if (!loc || !fs.existsSync(loc)) {
    return { error: `No valid location for ${project}`, project };
  }
  sessionTracker.trackAction(`syncing_project: ${project}`);
  queueLiveAgents("sync_project", sessionTracker);
  syncProjectToOrchestrator(project, dataDir, logger);
  return { ok: true, project, location: loc };
}

// ═══════════════════════════════════════════════════════════════
//  STATE EVENT GENERATION + SNAPSHOT
// ═══════════════════════════════════════════════════════════════

/**
 * Generate STATE.md from the event log. No LLM involved — pure data → template.
 * Returns { generated: boolean, stats: {...} }.
 */
function generateStateFromEvents(project: string, dataDir: string, logger: OrchestratorLogger): { generated: boolean; stats: Record<string, any> } {
  try {
    const events = readStateEvents(project, dataDir);
    const projDataDir = projDir(project, dataDir);

    // ── Compute state from events ──
    let version = "0.0.1";
    let toolCount = 0;
    let testCount = 0;
    let hooksCount = 0;
    let sessionCount = 0;
    let projectCreated: string | null = null;
    let projectDescription: string | null = null;
    let projectLocation: string | null = null;
    const completedPhases: string[] = [];
    const backlog: { total: number; done: number; todo: number } = { total: 0, done: 0, todo: 0 };
    const recentSessions: any[] = [];

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
          if (typeof ev.total === "number") backlog.total = ev.total;
          if (typeof ev.done === "number") backlog.done = ev.done;
          if (typeof ev.todo === "number") backlog.todo = ev.todo;
          break;
      }
    }

    // Also try to read actual counts from source
    const srcDir = getProjectLocation(project, dataDir);
    if (srcDir && fs.existsSync(srcDir)) {
      if (!toolCount) {
        try {
          const content = fs.readFileSync(path.join(srcDir, "src", "index.ts"), "utf-8");
          toolCount = _toolCount;
        } catch (e: any) { logger.debug("state", "Tool count read failed:", e.message); }
      }
      if (!testCount) {
        try {
          const tDir = path.join(srcDir, "tests");
          if (fs.existsSync(tDir)) {
            testCount = fs.readdirSync(tDir).filter(f => f.endsWith(".test.ts") || f.endsWith(".test.js")).length;
          }
        } catch (e: any) { logger.debug("state", "Test count read failed:", e.message); }
      }
      if (!version || version === "0.0.1") {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(srcDir, "package.json"), "utf-8"));
          if (pkg.version) version = pkg.version;
        } catch (e: any) { logger.debug("state", "Version read failed:", e.message); }
      }
    }

    const stats = { version, toolCount, testCount, hooksCount, sessionCount, backlog, completedPhases };

    // ── Build STATE.md ──
    const lines: string[] = [];
    lines.push(`# STATE: ${project} — v${version}`);
    lines.push("");
    lines.push("> _Auto-generated from state event log — edit events, not STATE.md._");
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
    if (hooksCount) lines.push(`- **Hooks:** ${hooksCount}`);
    if (srcDir) lines.push(`- **Location:** \`${srcDir}\``);
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
        const statusEmoji = s.status === "done" ? "✅" : s.status === "blocked" ? "🔴" : s.status === "failed" ? "❌" : "🟡";
        lines.push(`| ${idx++} | ${taskShort} | ${statusEmoji} ${s.status || ""} | ${s.model ? s.model.substring(0, 20) : "-"} | ${s.duration || "-"} |`);
      }
    } else {
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
  } catch (e: any) {
    logger.error("state", `Failed to generate STATE.md for ${project}: ${e.message}`);
    return { generated: false, stats: {} };
  }
}

/**
 * Snapshot current project state into the event log.
 * Reads actual source, writes diff events, regenerates STATE.md.
 */
function snapshotState(project: string, dataDir: string, logger: OrchestratorLogger): void {
  if (!project) return;
  try {
    const srcDir = getProjectLocation(project, dataDir);
    if (!srcDir || !fs.existsSync(srcDir)) return;

    let toolCount = 0;
    let testCount = 0;
    let version = "";

    const srcPath = path.join(srcDir, "src", "index.ts");
    if (fs.existsSync(srcPath)) {
      const content = fs.readFileSync(srcPath, "utf-8");
      // Only count actual registerTool calls in the register(api) section
      // (not comment references like "// Each entry matches an api.registerTool")
      toolCount = _toolCount;
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
      } catch (e: any) { logger.debug("state", "Snapshot version read failed:", e.message); }
    }

    // Write snapshot events only if changed vs latest in log
    const events = readStateEvents(project, dataDir);
    let latestVersion = "";
    let latestToolCount = 0;
    let latestTestCount = 0;
    for (const ev of events) {
      if (ev.type === "version_changed") latestVersion = ev.version || "";
      if (ev.type === "tool_count_changed") latestToolCount = ev.count ?? 0;
      if (ev.type === "test_count_changed") latestTestCount = ev.count ?? 0;
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
  } catch (e: any) { logger.warn("state", "State regeneration failed:", e.message); }
}

/**
 * Legacy alias: tryFixDocsDrift now uses state event log + regeneration.
 */
function tryFixDocsDrift(project: string | null, dataDir: string, logger: OrchestratorLogger): void {
  if (!project) return;
  try {
    writeStateEvent(project, dataDir, { type: "doc_synced", auto: true });
    snapshotState(project, dataDir, logger);
  } catch (e: any) { logger.warn("state", "Doc sync failed:", e.message); }
}

// ═══════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════

export {
  isPaid,
  projDir,
  getProjDir,
  logOrchestratorError,
  validateSessions,
  getBacklogPath,
  readBacklog,
  readBacklogJson,
  writeBacklog,
  backlogAdd,
  backlogList,
  backlogUpdate,
  getStatus,
  getConfig,
  filterModelsForProject,
  getModels,
  checkModels,
  autoPopulate,
  logSession,
  logDecision,
  getLogs,
  requireRegistration,
  requireBinding,
  getProjectDocsFn,
  getProjectLocation,
  buildProjectToc,
  syncProjectToOrchestrator,
  generateRecoveryDoc,
  readRecentSessions,
  writeStateEvent,
  readStateEvents,
  readProjectDoc,
  truncateDoc,
  buildProjectDocContext,
  initProjectDocs,
  PROJECT_TEMPLATES_DIR,
  PROJECT_DOCS,
  setContext,
  clearContextFn,
  syncProject,
  generateStateFromEvents,
  snapshotState,
  tryFixDocsDrift,
};

// sessionTracker re-exported at top
