/**
 * Dashboard HTTP handler — serves the Orchestrator Dashboard directly
 * through the OpenClaw gateway's built-in HTTP server via registerHttpRoute().
 *
 * Replaces: dashboard/server.py + serve.sh + PM2 orchestration-dashboard process.
 * Auto-starts with the plugin — no separate process needed.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { getDataDir } from "./shared.js";
import { initDb, getAllGlobalConfig, getAllProjectConfigs, setGlobalConfig, getProjectConfig, setProjectConfig, updateProjectConfig, listSessions, addSession, updateSession, countSessions, listBacklogTasks, getBacklogTask, addBacklogTask, updateBacklogTask, deleteBacklogTask, listModels, getModel, updateModel, getLiveAgents, setLiveAgents, getLiveSessions, getPendingRegistrations, addPendingRegistration, removePendingRegistration, getControlResults, addControlResult, getLogs, addLog, addStateEvent } from "./db.js";
import { handleSoftwareHouseRoute } from "./software-house.js";

// ── RESOLVE PLUGIN ROOT ──────────────────────────────────────
// Match the resolution in src/index.ts so dashboard relative paths work
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, "..");


// ── MIME TYPES ────────────────────────────────────────────────
const MIME: Record<string, string> = {
  ".html": "text/html;charset=utf-8",
  ".js": "application/javascript;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".json": "application/json;charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// ── FILE HELPERS ──────────────────────────────────────────────
// ── API RESPONSE HELPERS ──────────────────────────────────────
function sendJSON(res: ServerResponse, data: any, code = 200): void {
  res.writeHead(code, {
    "Content-Type": "application/json;charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, code: number, msg: string): void {
  sendJSON(res, { ok: false, error: msg }, code);
}

function getGatewayToken(): string {
  try {
    const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      if (cfg?.gateway?.auth?.token) return cfg.gateway.auth.token;
    }
  } catch { /* fallback */ }
  return process.env.OPENCLAW_GATEWAY_TOKEN || "";
}

function sendFile(res: ServerResponse, filePath: string, extraVars?: Record<string, string>): void {
  if (!fs.existsSync(filePath)) {
    sendError(res, 404, "Not found");
    return;
  }
  const ext = path.extname(filePath);
  const ct = MIME[ext] || "application/octet-stream";
  let content = fs.readFileSync(filePath);
  if (filePath.endsWith("index.html") && extraVars) {
    let html = content.toString("utf-8");
    for (const [key, val] of Object.entries(extraVars)) {
      html = html.replaceAll(`__${key}__`, val);
    }
    content = Buffer.from(html, "utf-8");
  }
  res.writeHead(200, { "Content-Type": ct, "Access-Control-Allow-Origin": "*" });
  res.end(content);
}

// ── PARSE QUERY STRING ────────────────────────────────────────
function parseQuery(url: string): Record<string, string | undefined> {
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  const qs: Record<string, string | undefined> = {};
  for (const pair of url.slice(idx + 1).split("&")) {
    const [k, v] = pair.split("=");
    qs[decodeURIComponent(k)] = v ? decodeURIComponent(v) : "";
  }
  return qs;
}

function parsePathname(url: string): string {
  const idx = url.indexOf("?");
  return idx === -1 ? url : url.slice(0, idx);
}

// ── READ BODY ─────────────────────────────────────────────────
function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

// ── SSE HANDLER ───────────────────────────────────────────────
function handleSSE(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const liveFile = path.join(getDataDir(), "live-sessions.json");
  let lastMtime = 0;
  const timer = setInterval(() => {
    try {
      if (fs.existsSync(liveFile)) {
        const mtime = fs.statSync(liveFile).mtimeMs;
        if (mtime > lastMtime) {
          lastMtime = mtime;
          const content = fs.readFileSync(liveFile, "utf-8");
          res.write(`data: ${content}\n\n`);
        }
      } else {
        res.write(`data: {"_meta":{"connected":false,"sessionCount":0}}\n\n`);
      }
    } catch { /* */ }
  }, 1000);

  res.on("close", () => clearInterval(timer));
}

// ── API HANDLERS ──────────────────────────────────────────────

function handleStatus(_req: IncomingMessage, res: ServerResponse): void {
  const cfg = getAllGlobalConfig();
  // Read plugin version from manifest
  let pluginVersion = "?";
  try {
    const manifestPath = path.join(PLUGIN_ROOT, "openclaw.plugin.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
      pluginVersion = manifest.version || "?";
    }
  } catch { /* */ }
  // Count project configs
  const allProjectConfigs = getAllProjectConfigs();
  sendJSON(res, {
    ok: true,
    version: pluginVersion,
    nightly_price_check: fs.existsSync(path.join(getDataDir(), "price_changes.log")) ? "Configured (2 AM)" : "Not configured",
    price_log_exists: fs.existsSync(path.join(getDataDir(), "price_changes.log")),
    data_dir: getDataDir(),
    free_only_mode: cfg?.free_only_mode || false,
    disabled_models: (cfg?.disabled_models as any[] | undefined)?.length || 0,
    projects_configured: Object.keys(allProjectConfigs).length,
  });
}

function handleAll(_req: IncomingMessage, res: ServerResponse): void {
  const cfg = getAllGlobalConfig();
  const liveSessions = getLiveSessions();
  const liveAgentsData = getLiveAgents();
  const modelsData = listModels(false);

  const sessions = liveSessions?.sessions || [];
  const meta = liveSessions?.meta || {};
  const agents = liveAgentsData || [];
  // Phase 5a: Enrich agents with health status
  const healthThresholds = cfg?.safeguards || {};
  const staleThreshold = healthThresholds.stuck_timeout_ms || 30 * 60 * 1000;
  const warnThreshold = healthThresholds.idle_timeout_ms || 10 * 60 * 1000;
  const now = Date.now();
  for (const agent of agents) {
    const lastActivity = agent.last_activity_at ? new Date(agent.last_activity_at).getTime() : 0;
    const lastUpdate = agent.timestamp ? new Date(agent.timestamp).getTime() : 0;
    const elapsed = lastActivity ? now - lastActivity : (lastUpdate ? now - lastUpdate : 0);
    if (!elapsed || elapsed < 0) {
      agent.health_status = "unknown";
    } else if (elapsed < warnThreshold) {
      agent.health_status = "healthy";
    } else if (elapsed < staleThreshold) {
      agent.health_status = "warning";
    } else {
      agent.health_status = "stale";
    }
    agent.last_active_at = lastActivity ? new Date(lastActivity).toISOString() : agent.timestamp || null;
  }
  const state = agents[0] || {};

  // modelsData is already an array of model config objects
  const modelList = modelsData || [];
  const activeModelCount = modelList.filter((m: any) => m.agent_ready !== false && m.status !== "removed").length;

  // Build projects list with active model info (Phase 3a)
  const allProjectsCfg = getAllProjectConfigs();
  const projectsList: any[] = [];
  for (const [name, pc] of Object.entries(allProjectsCfg) as [string, any][]) {
      const sessionCount = countSessions(name);
      
      // Find active model from live agents
      const matchingAgent = agents.find((a: any) => a.project === name || a.project === name);
      const activeModel = matchingAgent?.model || null;
      const activeModelProvider = matchingAgent?.model_provider || null;
      
      // Find model details from inventory
      let modelDetails = null;
      if (activeModel) {
        const found = modelList.find((m: any) => m.id === activeModel);
        if (found) {
          modelDetails = {
            name: found.name || found.id,
            provider: found.provider,
            tier: found.tier || 3,
            cost: found.cost || {},
          };
        }
      }
      
      projectsList.push({
        name, session_count: sessionCount,
        model_allowlist: pc.model_allowlist || [],
        free_only: pc.free_only || false,
        active_model: activeModel,
        active_model_provider: activeModelProvider,
        active_model_details: modelDetails,
        model_routing: pc.model_routing || null,
        routing_preset: pc.routing_preset || 'custom',
        routing_single_provider: pc.routing_single_provider || null,
      });
  }

  sendJSON(res, {
    ok: true,
    sessions,
    live_session_count: meta.sessionCount || meta?.sessionCount || 0,
    live_connected: meta.connected || false,
    live_updated: meta.updatedAt || null,
    live_agents: { agents, agent_count: agents.length, active_count: agents.filter((a: any) => a.project).length },
    state,
    models: { models: modelList, total: modelList.length, active: activeModelCount },
    projects: { projects: projectsList, count: projectsList.length },
    config: cfg,
  });
}

function handleModels(req: IncomingMessage, res: ServerResponse, qs: Record<string, string | undefined>): void {
  const cfg = getAllGlobalConfig();

  if (qs.id) {
    const m = getModel(qs.id);
    if (!m) return sendError(res, 404, "Model not found");
    return sendJSON(res, m);
  }

  const project = qs.project;
  const models = listModels(false, project);

  if (qs.all) {
    return sendJSON(res, { ok: true, models, total: models.length });
  }

  let filtered = [...models];

  if (cfg?.free_only_mode) {
    filtered = filtered.filter((m: any) => m.cost?.type !== "subscription" && m.cost?.type !== "payg");
  }
  if (cfg?.disabled_models?.length) {
    filtered = filtered.filter((m: any) => !(cfg.disabled_models as string[]).includes(m.id));
  }

  const active = filtered.filter((m: any) => m.agent_ready !== false && m.status !== "removed").length;
  sendJSON(res, { ok: true, models: filtered, total: filtered.length, active, project });
}

async function handleModelUpdate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = JSON.parse(await readBody(req));
    const { id, ...updates } = body;
    if (!id) return sendError(res, 400, "Model ID required");

    const model = getModel(id);
    if (!model) return sendError(res, 500, "Models data not found or model not found");

    updateModel(id, updates);
    addLog("info", "dashboard", `Updated model ${id}: tier=${updates.tier}, enabled=${updates.enabled}`);
    sendJSON(res, { ok: true, model: getModel(id) });
  } catch (e: any) {
    sendError(res, 400, e.message);
  }
}

function handleLogs(req: IncomingMessage, res: ServerResponse, qs: Record<string, string | undefined>): void {
  try {
    const limit = parseInt(qs.limit || "50", 10);
    const level = qs.level;
    const entries = getLogs(limit, level);
    sendJSON(res, { ok: true, entries, count: entries.length });
  } catch {
    sendJSON(res, { ok: true, entries: [], count: 0 });
  }
}

function handleLiveAgents(_req: IncomingMessage, res: ServerResponse): void {
  const agents = getLiveAgents();
  sendJSON(res, { ok: true, agents, agent_count: agents.length, active_count: agents.filter((a: any) => a.project).length });
}

function handleConfigGET(_req: IncomingMessage, res: ServerResponse): void {
  const cfg = getAllGlobalConfig();
  // Add projects for backward compat with dashboard
  const allProjectsCfg = getAllProjectConfigs();
  sendJSON(res, { ok: true, ...cfg, projects: allProjectsCfg });
}

function handleConfigPOST(req: IncomingMessage, res: ServerResponse): Promise<void> {
  return readBody(req).then((data) => {
    for (const key of ["free_only_mode", "theme", "auto_refresh_seconds", "disabled_models", "safeguards", "default_model_routing"]) {
      if (data[key] !== undefined) setGlobalConfig(key, data[key]);
    }
    if (data.projects && typeof data.projects === "object") {
      for (const [pn, pc] of Object.entries(data.projects) as [string, any][]) {
        const existing = getProjectConfig(pn) || {};
        if (pc.model_allowlist) existing.model_allowlist = pc.model_allowlist;
        if (pc.free_only !== undefined) existing.free_only = pc.free_only;
        setProjectConfig(pn, existing);
      }
    }
    addLog("info", "dashboard", "Config updated via POST /api/config");
    sendJSON(res, { ok: true });
  });
}

async function handleAutoPopulate(_req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  try {
    const dataDir = getDataDir();
    const scriptPath = path.join(PLUGIN_ROOT, "scripts", "auto-populate-models.py");
    const out = execSync(
      `ORCHESTRATOR_DATA_DIR="${dataDir}" python3 "${scriptPath}" 2>&1`,
      { encoding: "utf-8", timeout: 30000 }
    ).trim();
    addLog("info", "dashboard", `Auto-populate complete (${out.length} chars output)`);
    sendJSON(res, { ok: true, output: out });
  } catch (err: any) {
    sendJSON(res, { ok: false, error: err.message || "Auto-populate failed" });
  }
  return true;
}

/** Project directory path */
function projectDir(name: string): string {
  const dir = path.join(getDataDir(), "projects", name);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

/** Safe filename guard (no path traversal) */
function safeFile(fn: string): boolean {
  return !fn.includes("..") && !fn.includes("/") && !fn.includes('\\');
}

async function handleProjectState(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url || "/", "http://localhost");
  const name = url.searchParams.get("name") || "";
  if (!name) { sendError(res, 400, "Missing name"); return true; }

  try {
    const pd = projectDir(name);
    const projCfg = getProjectConfig(name) || {};
    const sessions = listSessions(name, 200);

    // List docs
    const docs: any[] = [];
    if (fs.existsSync(pd)) {
      for (const f of fs.readdirSync(pd).sort()) {
        const fp = path.join(pd, f);
        try {
          const st = fs.statSync(fp);
          if (st.isFile()) {
            docs.push({
              name: f,
              size: st.size,
              modified: Math.floor(st.mtimeMs / 1000),
              is_md: f.endsWith(".md"),
              is_json: f.endsWith(".json"),
            });
          }
        } catch {}
      }
    }

    // Read known docs
    const readProjectDoc = (fn: string): string => {
      if (!safeFile(fn)) return "";
      const fp = path.join(pd, fn);
      if (!fs.existsSync(fp)) return "";
      try { return fs.readFileSync(fp, "utf-8"); } catch { return ""; }
    };

    // Merge global default_model_routing so per-project UI can show inheritance
    const globalCfg = getAllGlobalConfig();
    const mergedConfig = { ...projCfg, default_model_routing: globalCfg?.default_model_routing || {} };

    sendJSON(res, {
      ok: true,
      name,
      config: mergedConfig,
      sessions,
      session_count: sessions.length,
      docs,
      state: readProjectDoc("STATE.md"),
      roadmap: readProjectDoc("ROADMAP.md"),
      context: readProjectDoc("CONTEXT.md"),
      notes: readProjectDoc("NOTES.md"),
      matched_live: [],
      live_matched_count: 0,
      agents_on_project: false,
      total_live_gateway: 0,
    });
  } catch (err: any) {
    sendError(res, 500, err.message);
  }
  return true;
}

async function handleProjectDoc(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = req.method || "GET";
  const url = new URL(req.url || "/", "http://localhost");
  const name = url.searchParams.get("name") || "";
  const fn = url.searchParams.get("file") || "";

  if (!name || !fn) { sendError(res, 400, "Missing name or file"); return true; }
  if (!safeFile(fn)) { sendError(res, 400, "Invalid filename"); return true; }

  const pd = projectDir(name);
  const fp = path.join(pd, fn);

  if (method === "GET") {
    if (!fs.existsSync(fp)) { sendJSON(res, { content: null, error: "Not found" }); return true; }
    const content = fs.readFileSync(fp, "utf-8");
    sendJSON(res, { ok: true, content, name, file: fn });
  } else if (method === "DELETE") {
    try {
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      sendJSON(res, { ok: true });
    } catch (err: any) {
      sendJSON(res, { ok: false, error: err.message });
    }
  } else {
    sendError(res, 405, "Method not allowed");
  }
  return true;
}

async function handleProjectDocSave(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  try {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    const { name, file, content } = data;
    if (!name || !file) { sendJSON(res, { ok: false, error: "Missing name or file" }); return true; }
    if (!safeFile(file)) { sendJSON(res, { ok: false, error: "Invalid filename" }); return true; }

    const pd = projectDir(name);
    fs.writeFileSync(path.join(pd, file), content || "", "utf-8");
    addLog("info", "dashboard", `Saved project doc ${name}/${file}`);
    sendJSON(res, { ok: true });
  } catch (err: any) {
    sendJSON(res, { ok: false, error: err.message });
  }
  return true;
}

async function handleCreateProject(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const params = await readBody(req);
    const projectName = (params.name || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (!projectName || projectName.length < 2) {
      return sendJSON(res, { ok: false, error: "Invalid project name." });
    }

    const projDir = path.join(getDataDir(), "projects", projectName);
    if (fs.existsSync(projDir)) {
      return sendJSON(res, { ok: false, error: `Project "${projectName}" already exists.` });
    }

    fs.mkdirSync(projDir, { recursive: true });

    // Create STATE.md
    const loc = params.directory || null;
    const stateContent = [
      `# STATE: ${projectName} — v0.0.1`,
      "",
      "## Overview",
      "",
      params.description || "No description yet.",
      "",
      "## Status",
      "",
      "🟢 Active",
      "",
      loc ? `**Location:** \`${loc}\`` : "*Location not configured*",
      "",
      "## Sessions",
      "",
      "No sessions logged yet.",
    ].join("\n");
    fs.writeFileSync(path.join(projDir, "STATE.md"), stateContent, "utf-8");

    // Update project config via DB
    const pc: any = { location: loc, workflow: { enabled: true } };
    setProjectConfig(projectName, pc);

    // Create spawn marker if requested
    let spawnInfo: any = null;
    if (params.spawn) {
      const spawnTask = params.spawn_task || `Start working on "${projectName}"`;
      const spawnMarker = path.join(projDir, ".SPAWN_PENDING");
      fs.writeFileSync(spawnMarker, JSON.stringify({
        project: projectName,
        task: spawnTask,
        created_at: new Date().toISOString(),
        spawned: false,
      }), "utf-8");
      spawnInfo = {
        scheduled: true,
        task: spawnTask,
      };
    }

    sendJSON(res, {
      ok: true,
      project: projectName,
      directory: loc,
      description: params.description || null,
      state_md: path.join(projDir, "STATE.md"),
      spawn: spawnInfo,
      message: `Project "${projectName}" created.`,
    });
    addLog("info", "dashboard", `Created project ${projectName} (loc: ${loc || "none"})`);
  } catch (err: any) {
    sendJSON(res, { ok: false, error: err.message });
  }
}

function handleProjects(_req: IncomingMessage, res: ServerResponse): void {
  const allProjectsCfg = getAllProjectConfigs();
  const projects = Object.entries(allProjectsCfg).map(([name, pc]: [string, any]) => {
    const sessionCount = countSessions(name);
    return {
      name,
      session_count: sessionCount,
      model_allowlist: pc.model_allowlist || [],
      free_only: pc.free_only || false,
    };
  });

  sendJSON(res, { ok: true, projects, count: projects.length });
}

function handlePrices(_req: IncomingMessage, res: ServerResponse): void {
  const logPath = path.join(getDataDir(), "price_changes.log");
  if (!fs.existsSync(logPath)) return sendJSON(res, { entries: [], count: 0 });
  const entries = fs.readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => ({ text: l.trim() }));
  sendJSON(res, { entries, count: entries.length });
}

function handleGateway(req: IncomingMessage, res: ServerResponse): void {
  const live = getLiveSessions();
  return sendJSON(res, {
    live: true,
    session_count: live.meta?.sessionCount || 0,
    sessions: live.sessions || [],
    updated: live.meta?.updatedAt || null,
  });
}

function handleSessions(req: IncomingMessage, res: ServerResponse): void {
  const live = getLiveSessions();
  return sendJSON(res, {
    sessions: live.sessions || [],
    count: live.sessions?.length || 0,
    session_count: live.meta?.sessionCount || 0,
    updated: live.meta?.updatedAt || null,
  });
}

function handleSafeguardLog(_req: IncomingMessage, res: ServerResponse): void {
  const sl = path.join(getDataDir(), "safeguard-log.md");
  if (!fs.existsSync(sl)) return sendJSON(res, { entries: [], count: 0 });
  const lines = fs.readFileSync(sl, "utf-8").split("\n").filter((l) => l.startsWith("|") && !l.includes("---"));
  const entries = lines.slice(1).map((l) => {
    const parts = l.split("|").slice(1, -1).map((p) => p.trim());
    return { timestamp: parts[0] || "", event: parts[1] || "", details: parts[2] || "" };
  });
  sendJSON(res, { entries, count: entries.length });
}

// ── ERROR READING HELPERS ────────────────────────────────────

function readOrchestratorErrors(project: string, limit: number = 50): any[] {
  const pd = projectDir(project);
  const errLog = path.join(pd, "errors.log");
  if (!fs.existsSync(errLog)) return [];
  try {
    const content = fs.readFileSync(errLog, "utf-8");
    return content.trim().split("\n").filter(Boolean).slice(-limit).map(l => {
      try { return JSON.parse(l); } catch { return { error: l }; }
    });
  } catch { return []; }
}

function readGlobalErrors(limit: number = 20): any[] {
  const projectsDir = path.join(getDataDir(), "projects");
  if (!fs.existsSync(projectsDir)) return [];
  try {
    const all: any[] = [];
    for (const p of fs.readdirSync(projectsDir)) {
      if (p.startsWith(".")) continue;
      const pp = path.join(projectsDir, p);
      if (!fs.statSync(pp).isDirectory()) continue;
      const errFile = path.join(pp, "errors.log");
      if (fs.existsSync(errFile)) {
        try {
          const content = fs.readFileSync(errFile, "utf-8");
          for (const line of content.trim().split("\n").filter(Boolean)) {
            try { all.push({ ...JSON.parse(line), project: p }); } catch {}
          }
        } catch {}
      }
    }
    return all.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || "")).slice(0, limit);
  } catch { return []; }
}

// ═══ Session Validation (Phase 4a) ═══
function validateProjectSessions(dataDir: string, project?: string): any {
  const issues: any[] = [];
  let total = 0;
  const projectsChecked: string[] = [];

  const checkProject = (projName: string) => {
    const sessRows = listSessions(projName, 10000);
    if (!sessRows.length) return;
    const sessions = sessRows.map(s => ({
      id: s.id,
      session_key: s.session_key,
      project: s.project,
      task: s.task,
      status: s.status,
      start_time: s.start_ts ? new Date(s.start_ts * 1000).toISOString() : null,
      started_at: s.start_ts ? new Date(s.start_ts * 1000).toISOString() : null,
      end_time: s.end_ts ? new Date(s.end_ts * 1000).toISOString() : null,
      duration: s.duration,
      logged_at: s.logged_at,
    }));

    projectsChecked.push(projName);
    const seenIds = new Map<string, number>();

    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      total++;
      const id = s.id || `index_${i}`;
      const sk = s.session_key || "";

      if (!sk || typeof sk !== "string") {
        issues.push({ id, session_key: sk, issue: "Missing or invalid session_key", field: "session_key", severity: "error" });
      } else if (!sk.startsWith("agent:")) {
        issues.push({ id, session_key: sk, issue: "session_key does not start with 'agent:'", field: "session_key", severity: "error" });
      }
      if (!s.project || typeof s.project !== "string" || !s.project.trim()) {
        issues.push({ id, session_key: sk, issue: "Missing or empty project field", field: "project", severity: "error" });
      }
      if (!s.task || typeof s.task !== "string" || !s.task.trim()) {
        issues.push({ id, session_key: sk, issue: "Missing or empty task field", field: "task", severity: "error" });
      }
      if (!s.start_time && !s.started_at && !s.logged_at) {
        issues.push({ id, session_key: sk, issue: "No timestamp fields", field: "start_time", severity: "error" });
      }
      if (s.start_time && s.end_time && new Date(s.start_time).getTime() > new Date(s.end_time).getTime()) {
        issues.push({ id, session_key: sk, issue: "start_time after end_time", field: "start_time/end_time", severity: "error" });
      }
      if (s.duration) {
        const durStr = String(s.duration);
        const numMatch = durStr.match(/^(\d+)\s*(min|h|hr)/i);
        if (numMatch) {
          const val = parseInt(numMatch[1], 10);
          const unit = numMatch[2].toLowerCase();
          if ((unit === "h" || unit === "hr") && val > 24) {
            issues.push({ id, session_key: sk, issue: `Duration >24h: ${durStr}`, field: "duration", severity: "warn" });
          }
          if (unit === "min" && val > 1440) {
            issues.push({ id, session_key: sk, issue: `Duration >24h: ${durStr}`, field: "duration", severity: "warn" });
          }
        }
      }
      if (seenIds.has(id)) {
        issues.push({ id, session_key: sk, issue: `Duplicate id "${id}"`, field: "id", severity: "error" });
      }
      seenIds.set(id, i);
      if (sk && sk.includes("synthetic") && (!s.project || !s.task)) {
        issues.push({ id, session_key: sk, issue: "Synthetic key with missing fields", field: "session_key", severity: "warn" });
      }
    }
  };

  if (project) {
    checkProject(project);
  } else {
    const projDir = path.join(getDataDir(), "projects");
    if (fs.existsSync(projDir)) {
      for (const p of fs.readdirSync(projDir).sort()) {
        if (p.startsWith(".")) continue;
        const pp = path.join(projDir, p);
        if (!fs.statSync(pp).isDirectory()) continue;
        checkProject(p);
      }
    }
  }

  return { ok: true, total, issues, projects_checked: projectsChecked };
}

function handleValidateSessions(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || "/", "http://localhost");
  const project = url.searchParams.get("project") || "";
  const result = validateProjectSessions(getDataDir(), project || undefined);
  sendJSON(res, result);
}

// ═══ Model Assignment (Phase 3b) ═══
async function handleSetProjectModel(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const { project, model_id } = body;
    if (!project || !model_id) {
      sendJSON(res, { ok: false, error: "Missing project or model_id" });
      return;
    }
    // Validate model exists in inventory
    const model = getModel(model_id);
    if (!model) {
      sendJSON(res, { ok: false, error: `Model "${model_id}" not found in inventory` });
      return;
    }
    // Update project config
    const pc = getProjectConfig(project) || {};
    pc.model_allowlist = [model_id];
    pc.free_only = model.tier === "free" || model.tier === 0 ? true : false;
    setProjectConfig(project, pc);
    addLog("info", "dashboard", `Set project model: ${project} -> ${model_id}`);
    sendJSON(res, {
      ok: true,
      model: model.id,
      provider: model.provider,
    });
  } catch (e: any) {
    console.error("[handleSetProjectModel] Error:", e, "Message:", e?.message, "Stack:", e?.stack);
    sendJSON(res, { ok: false, error: typeof e === 'string' ? e : (e?.message || String(e)) });
  }
}

// ═══ Set Project Routing (Phase 3b) ═══
async function handleSetProjectRouting(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const { project, routing, preset, free_only, model_allowlist, routing_single_provider } = body;
    if (!project) {
      sendJSON(res, { ok: false, error: "Missing project" });
      return;
    }
    const pc = getProjectConfig(project) || {};

    if (routing !== undefined) {
      pc.model_routing = routing;
    }
    if (preset !== undefined) {
      pc.routing_preset = preset;
    }
    if (free_only !== undefined) {
      pc.free_only = free_only;
    }
    if (model_allowlist !== undefined) {
      pc.model_allowlist = model_allowlist;
    }
    if (routing_single_provider !== undefined) {
      pc.routing_single_provider = routing_single_provider;
    }

    setProjectConfig(project, pc);
    sendJSON(res, {
      ok: true,
      message: `Routing updated for ${project}`,
      preset: pc.routing_preset || null,
      chains: Object.keys(pc.model_routing || {}).length,
    });
  } catch (e: any) {
    console.error("[handleSetProjectRouting] Error:", e);
    sendJSON(res, { ok: false, error: e?.message || String(e) });
  }
}

// ═══ Phase 3c: Backlog API ═══
function handleProjectBacklog(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || "/", "http://localhost");
  const project = url.searchParams.get("project");
  if (!project) return sendJSON(res, { ok: false, error: "Missing project" });
  try {
    const tasks = listBacklogTasks(project);
    sendJSON(res, { tasks });
  } catch {
    sendJSON(res, { tasks: [] });
  }
}

function handleProjectErrors(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || "/", "http://localhost");
  const project = url.searchParams.get("project") || "";
  if (!project) { sendJSON(res, { ok: false, error: "Missing project" }); return; }
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);
  sendJSON(res, { ok: true, errors: readOrchestratorErrors(project, limit) });
}

function handleGlobalErrors(req: IncomingMessage, res: ServerResponse): void {
  const limit = parseInt(new URL(req.url || "/", "http://localhost").searchParams.get("limit") || "20", 10);
  sendJSON(res, { ok: true, errors: readGlobalErrors(limit) });
}

// ── MAIN HTTP HANDLER ─────────────────────────────────────────
const BASE_PATH = "/orchestrator";

/** Strip the registered base path prefix from a URL pathname. */
function stripBasePath(pathname: string): string {
  if (pathname === BASE_PATH || pathname === BASE_PATH + "/") return "/";
  if (pathname.startsWith(BASE_PATH + "/")) return pathname.slice(BASE_PATH.length);
  return pathname;
}

export function createDashboardHandler(api: OpenClawPluginApi) {
  // Initialize DB on first use
  initDb();
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean | void> => {
    try {
      const method = req.method || "GET";
      const rawPathname = parsePathname(req.url || "/");
      const pathname = stripBasePath(rawPathname);
      const qs = parseQuery(req.url || "");

      // ── Helper: Quick Action — spawns a subagent with a preset prompt ──
      async function handleQuickAction(_req: IncomingMessage, _res: ServerResponse): Promise<true> {
        try {
          const body = await readBody(_req);
          const { action, params } = typeof body === "string" ? JSON.parse(body) : body;
          if (!action) { sendJSON(_res, { ok: false, error: "Action name required" }); return true; }

          // Map frontend action names to prompt templates
          const actionAlias: Record<string, string> = {
            'fix-docs': 'cleanup_docs',
          };
          const resolvedAction = actionAlias[action] || action;

          const promptTemplates: Record<string, (p: any) => string> = {
            doctor: (p) => [
              `[Quick Action: Orchestrator Doctor — from Dashboard]`,
              `You are an orchestrator diagnostician. Run a full health check on the orchestrator system:`,
              `1. Check all sessions for stale/orphaned entries`,
              `2. Check model configuration and routing`,
              `3. Verify project context and state consistency`,
              `4. Fix any issues found (session mismatches, broken registrations, stale data, orphaned projects)`,
              `5. Report what was checked, what was found, and what was fixed.`,
            ].filter(Boolean).join('\n'),
            cleanup_docs: (p) => [
              `[Quick Action: Clean Up & Organize Docs — from Orchestrator Dashboard]`,
              `You are a documentation specialist.`,
              `Scope: ${p.scope || "all"}`,
              `1. READ all existing documentation.`,
              `2. Fix broken links, stale content, missing sections, inconsistent formatting.`,
              `3. Update files and create new ones if important gaps found.`,
              `4. Report summary of changes and why.`,
            ].filter(Boolean).join("\n"),
          };

          const templateFn = promptTemplates[resolvedAction];
          if (!templateFn) { sendJSON(_res, { ok: false, error: `Unknown action: ${action}` }); return true; }

          const message = templateFn(params || {});

          const gatewayToken = getGatewayToken();
          if (!gatewayToken) {
            sendJSON(_res, { ok: false, error: "Gateway token not found — cannot spawn session" }, 500);
            return true;
          }

          const safeActionKey = action.replace(/[^a-z0-9]/gi, '-').slice(0, 24);
          const sessionKey = `agent:main:project-session:qa-${safeActionKey}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
          const gatewayPort = 18789;

          // ═══ Spawn agent session via OpenAI-compatible endpoint ═══
          const safeAction = action.replace(/[^a-z0-9_-]/gi, '_');
          const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${gatewayToken}`,
              "Content-Type": "application/json",
              "x-openclaw-session-key": sessionKey,
              ...(params?.model ? { "x-openclaw-model": params.model } : {}),
            },
            body: JSON.stringify({
              model: "openclaw/main",
              messages: [
                {
                  role: "user",
                  content: `[Orchestrator Quick Action: ${safeAction} — from Dashboard]\n\n${message}\n\nAuto-register with the orchestrator project if applicable and report your findings back to the dashboard.`
                }
              ],
              max_tokens: 100,
            }),
          });

          if (!response.ok) {
            const errText = await response.text().catch(() => "unknown error");
            api.logger.warn(`quick-action: Endpoint returned ${response.status}: ${errText.slice(0, 200)}`);
            sendJSON(_res, { ok: false, error: `Endpoint returned ${response.status}: ${errText.slice(0, 200)}` }, 500);
            return true;
          }

          const result = await response.json();
          api.logger.info(`quick-action: Spawned session for "${safeAction}": ${sessionKey.slice(0, 50)}`);

          sendJSON(_res, {
            ok: true,
            action: safeAction,
            session_key: sessionKey,
            message: `Quick action "${safeAction}" launched — session ${sessionKey.slice(0, 24)}…`,
          });
        } catch (e: any) {
          api.logger.error(`quick-action: Error: ${e.message}`);
          sendJSON(_res, { ok: false, error: e.message }, 500);
        }
        return true;
      }

      async function handleSpawnProjectSession(_req: IncomingMessage, _res: ServerResponse): Promise<true> {
        try {
          const body = await readBody(_req);
          const { project, task, model, tags } = typeof body === "string" ? JSON.parse(body) : body;
          if (!project || !task) {
            sendJSON(_res, { ok: false, error: "Project and task are required" });
            return true;
          }

          const safeName = project.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
          const sessionKey = `agent:main:project-session:${safeName}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

          const gatewayToken = getGatewayToken();
          if (!gatewayToken) {
            sendJSON(_res, { ok: false, error: "Gateway token not found — cannot spawn via OpenAI endpoint" }, 500);
            return true;
          }

          api.logger.info(`spawn: Creating session via OpenAI endpoint -> ${sessionKey.slice(0, 50)}`);

          // ═══ Write pending registration via DB ═══
          try {
            addPendingRegistration({
              session_key: sessionKey,
              project,
              tags: typeof tags === "string" ? tags.split(",").map((t: string) => t.trim()).filter(Boolean) : Array.isArray(tags) ? tags : [],
              created_at: new Date().toISOString()
            });
            api.logger.info(`spawn: Written pending registration in DB for ${sessionKey.slice(0, 50)}`);
          } catch (e: any) {
            api.logger.warn(`spawn: Could not write pending registration: ${e.message}`);
          }

          // ═══ Create session via OpenAI-compatible endpoint ═══
          // This call creates a new session with our custom key, sends the task,
          // and the AI starts processing. We limit max_tokens for a quick response.
          const gatewayPort = 18789;
          const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${gatewayToken}`,
              "Content-Type": "application/json",
              "x-openclaw-session-key": sessionKey,
              ...(model ? { "x-openclaw-model": model } : {}),
            },
            body: JSON.stringify({
              model: "openclaw/main",
              messages: [
                {
                  role: "user",
                  content: `[Orchestrator: New Session for "${project}"]\n\nYou are a newly spawned session. Your task:\n\n${task}\n\nAuto-register with the orchestrator project "${project}" and begin working on the task above.`
                }
              ],
              max_tokens: 50,
            }),
          });

          if (!response.ok) {
            const errText = await response.text().catch(() => "unknown error");
            api.logger.warn(`spawn: OpenAI endpoint returned ${response.status}: ${errText.slice(0, 200)}`);
            sendJSON(_res, { ok: false, error: `Endpoint returned ${response.status}: ${errText.slice(0, 200)}` }, 500);
            return true;
          }

          const result = await response.json();
          api.logger.info(`spawn: Created session: ${sessionKey.slice(0, 50)} (${result?.choices?.[0]?.message?.content?.slice(0, 40) || "?"})`);

          sendJSON(_res, {
            ok: true,
            session_key: sessionKey,
            project,
            message: `Session created for "${project}": ${sessionKey}`,
          });
        } catch (e: any) {
          api.logger.error(`spawn: Error: ${e.message}`);
          sendJSON(_res, { ok: false, error: e.message }, 500);
        }
        return true;
      }

      // CORS preflight
      if (method === "OPTIONS") {
        res.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return true;
      }

      // ── STATIC FILES ──
      if (method === "GET") {
        // Software House UI proposal (frontend-only mockup)
        if (pathname === "/software-house" || pathname === "/software-house/") {
          sendFile(res, path.join(PLUGIN_ROOT, "dashboard", "software-house.html"));
          return true;
        }
        // Static assets for dashboard pages (sprites, mock JSON)
        if (pathname.startsWith("/assets/") || pathname.startsWith("/data/")) {
          const assetFile = path.join(PLUGIN_ROOT, "dashboard", pathname.slice(1));
          if (fs.existsSync(assetFile) && fs.statSync(assetFile).isFile()) {
            sendFile(res, assetFile);
            return true;
          }
        }
        // Dashboard main page — redirect to Software House
        if (pathname === "/" || pathname === "/index.html") {
          res.writeHead(302, { Location: "/orchestrator/software-house" });
          res.end();
          return true;
        }
        // Other static HTML files in dashboard dir
        if (pathname.endsWith(".html") && !pathname.startsWith("/api/")) {
          const staticFile = path.join(PLUGIN_ROOT, "dashboard", pathname.slice(1));
          if (fs.existsSync(staticFile)) {
            sendFile(res, staticFile);
            return true;
          }
        }
      }

      // ── API ROUTES ──
      // Software House routes (must be checked first)
      if (await handleSoftwareHouseRoute(req, res)) return true;

      if (method === "GET") {
        switch (pathname) {
          case "/api/status": handleStatus(req, res); return true;
          case "/api/all": handleAll(req, res); return true;
          case "/api/models": handleModels(req, res, qs); return true;
          case "/api/logs": handleLogs(req, res, qs); return true;
          case "/api/live-agents": handleLiveAgents(req, res); return true;
          case "/api/config": handleConfigGET(req, res); return true;
          case "/api/projects": handleProjects(req, res); return true;
          case "/api/prices": handlePrices(req, res); return true;
          case "/api/sessions": handleSessions(req, res); return true;
          case "/api/gateway": handleGateway(req, res); return true;
          case "/api/safeguard-log": handleSafeguardLog(req, res); return true;
          case "/api/sse/live-sessions": handleSSE(res); return true;
          case "/api/project-state": return handleProjectState(req, res);
          case "/api/project-doc": return handleProjectDoc(req, res);
          case "/api/project-errors": handleProjectErrors(req, res); return true;
          case "/api/global-errors": handleGlobalErrors(req, res); return true;
          case "/api/project-backlog": handleProjectBacklog(req, res); return true;
          case "/api/validate-sessions": handleValidateSessions(req, res); return true;
        }
      }

      // ── POST API ──
      if (method === "POST") {
        switch (pathname) {
          case "/api/config": return handleConfigPOST(req, res).then(() => true);
          case "/api/auto-populate": return handleAutoPopulate(req, res);
          case "/api/project-state": return handleProjectState(req, res);
          case "/api/project-doc": return handleProjectDocSave(req, res);
          case "/api/create-project": handleCreateProject(req, res); return true;
          case "/api/set-project-model": return handleSetProjectModel(req, res).then(() => true);
          case "/api/set-project-routing": return handleSetProjectRouting(req, res).then(() => true);
          case "/api/quick-action": return handleQuickAction(req, res);
          case "/api/update-backlog-task": return handleUpdateBacklogTask(req, res);
          case "/api/update-project-workflow": return handleUpdateProjectWorkflow(req, res);
          case "/api/spawn-project-session": return handleSpawnProjectSession(req, res);
        }
      }

      // ── PATCH API ──
      if (method === "PATCH") {
        switch (pathname) {
          case "/api/models": return handleModelUpdate(req, res);
        }
      }

      // ── 404 ──
      sendError(res, 404, `Not found: ${method} ${rawPathname}`);
      return true;
    } catch (err: any) {
      sendError(res, 500, err.message);
      return true;
    }
  };
}
// ═══ Update Backlog Task ═══
async function handleUpdateBacklogTask(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  try {
    const body = await readBody(req);
    const { project, id, status } = typeof body === "string" ? JSON.parse(body) : body;
    if (!project) { sendJSON(res, { ok: false, error: "Missing project" }); return true; }
    
    if (status === "cleanup_done") {
      // Remove all done/complete/decomposed tasks by marking as done in DB
      const tasks = listBacklogTasks(project);
      for (const t of tasks) {
        if (t.status === "done" || t.status === "complete" || (t.labels && t.labels.includes("decomposed"))) {
          deleteBacklogTask(t.id);
        }
      }
      addLog("info", "dashboard", `Cleaned up completed tasks for ${project}`);
      sendJSON(res, { ok: true, message: `Cleaned up completed tasks` });
      return true;
    }
    
    if (status === "deleted") {
      deleteBacklogTask(id);
      addLog("info", "dashboard", `Deleted backlog task ${id}`);
      sendJSON(res, { ok: true, message: `Task ${id} deleted` });
      return true;
    }
    
    // Update specific task status
    const task = getBacklogTask(id);
    if (!task) { sendJSON(res, { ok: false, error: `Task ${id} not found` }); return true; }
    
    updateBacklogTask(id, { status, updated_ts: Math.floor(Date.now() / 1000) });
    addLog("info", "dashboard", `Backlog task ${id} -> ${status} (project: ${project})`);
    sendJSON(res, { ok: true, message: `Task ${id} updated to ${status}` });
    return true;
  } catch (e: any) {
    sendJSON(res, { ok: false, error: e.message }, 500);
    return true;
  }
}

// ═══ Update Project Workflow ═══
async function handleUpdateProjectWorkflow(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  try {
    const body = await readBody(req);
    const parsed = typeof body === "string" ? JSON.parse(body) : body;
    const { project, workflow, free_only, model_routing } = parsed;
    if (!project) { sendJSON(res, { ok: false, error: "Missing project" }); return true; }
    
    const pc = getProjectConfig(project) || {};
    
    if (workflow !== undefined) {
      pc.workflow = { ...(pc.workflow || {}), ...workflow };
    }
    if (free_only !== undefined) {
      pc.free_only = free_only;
    }
    if (model_routing !== undefined) {
      if (!pc.model_routing) pc.model_routing = {};
      for (const [cat, models] of Object.entries(model_routing) as [string, any][]) {
        if (models === null) {
          delete pc.model_routing[cat];
        } else {
          pc.model_routing[cat] = models;
        }
      }
      if (Object.keys(pc.model_routing).length === 0) {
        delete pc.model_routing;
      }
    }
    
    setProjectConfig(project, pc);
    addLog("info", "dashboard", `Updated workflow config for ${project}`);
    sendJSON(res, { ok: true, message: `Project ${project} updated` });
    return true;
  } catch (e: any) {
    sendJSON(res, { ok: false, error: e.message }, 500);
    return true;
  }
}


