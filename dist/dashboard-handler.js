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
import { getDataDir } from "./shared.js";
// ── RESOLVE PLUGIN ROOT ──────────────────────────────────────
// Match the resolution in src/index.ts so dashboard relative paths work
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const HTML_PATH = path.join(PLUGIN_ROOT, "dashboard", "index.html");
// ── MIME TYPES ────────────────────────────────────────────────
const MIME = {
    ".html": "text/html;charset=utf-8",
    ".js": "application/javascript;charset=utf-8",
    ".css": "text/css;charset=utf-8",
    ".json": "application/json;charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
};
// ── FILE HELPERS ──────────────────────────────────────────────
function readJSON(filePath) {
    try {
        if (fs.existsSync(filePath))
            return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
    catch { /* */ }
    return null;
}
// ── API RESPONSE HELPERS ──────────────────────────────────────
function sendJSON(res, data, code = 200) {
    res.writeHead(code, {
        "Content-Type": "application/json;charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(JSON.stringify(data));
}
function sendError(res, code, msg) {
    sendJSON(res, { error: msg }, code);
}
function sendFile(res, filePath, extraVars) {
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
function parseQuery(url) {
    const idx = url.indexOf("?");
    if (idx === -1)
        return {};
    const qs = {};
    for (const pair of url.slice(idx + 1).split("&")) {
        const [k, v] = pair.split("=");
        qs[decodeURIComponent(k)] = v ? decodeURIComponent(v) : "";
    }
    return qs;
}
function parsePathname(url) {
    const idx = url.indexOf("?");
    return idx === -1 ? url : url.slice(0, idx);
}
// ── READ BODY ─────────────────────────────────────────────────
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            try {
                const raw = Buffer.concat(chunks).toString("utf-8");
                resolve(raw ? JSON.parse(raw) : {});
            }
            catch {
                reject(new Error("Invalid JSON"));
            }
        });
        req.on("error", reject);
    });
}
// ── SSE HANDLER ───────────────────────────────────────────────
function handleSSE(res) {
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
            }
            else {
                res.write(`data: {"_meta":{"connected":false,"sessionCount":0}}\n\n`);
            }
        }
        catch { /* */ }
    }, 1000);
    res.on("close", () => clearInterval(timer));
}
// ── API HANDLERS ──────────────────────────────────────────────
function handleStatus(_req, res) {
    const cfg = readJSON(path.join(getDataDir(), "dashboard-config.json"));
    // Read plugin version from manifest
    let pluginVersion = "?";
    try {
        const manifestPath = path.join(PLUGIN_ROOT, "openclaw.plugin.json");
        if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
            pluginVersion = manifest.version || "?";
        }
    }
    catch { /* */ }
    sendJSON(res, {
        version: pluginVersion,
        nightly_price_check: fs.existsSync(path.join(getDataDir(), "price_changes.log")) ? "Configured (2 AM)" : "Not configured",
        price_log_exists: fs.existsSync(path.join(getDataDir(), "price_changes.log")),
        data_dir: getDataDir(),
        free_only_mode: cfg?.free_only_mode || false,
        disabled_models: cfg?.disabled_models?.length || 0,
        projects_configured: cfg?.projects ? Object.keys(cfg.projects).length : 0,
    });
}
function handleAll(_req, res) {
    const cfg = readJSON(path.join(getDataDir(), "dashboard-config.json")) || {};
    const liveSessions = readJSON(path.join(getDataDir(), "live-sessions.json"));
    const liveAgents = readJSON(path.join(getDataDir(), "live-agents.json"));
    const modelsData = readJSON(path.join(getDataDir(), "models.json"));
    const sessions = liveSessions?.sessions || [];
    const meta = liveSessions?._meta || {};
    const agents = liveAgents?.agents || [];
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
        }
        else if (elapsed < warnThreshold) {
            agent.health_status = "healthy";
        }
        else if (elapsed < staleThreshold) {
            agent.health_status = "warning";
        }
        else {
            agent.health_status = "stale";
        }
        agent.last_active_at = lastActivity ? new Date(lastActivity).toISOString() : agent.timestamp || null;
    }
    const state = agents[0] || {};
    // Normalize models: models.json has nested { version, schema, models: [...] }
    // Frontend expects { total, active } at the top level
    const models = modelsData || { models: [] };
    const modelList = models.models || [];
    const activeModelCount = modelList.filter((m) => m.agent_ready !== false && m.status !== "removed").length;
    // Build projects list with active model info (Phase 3a)
    const projDir = path.join(getDataDir(), "projects");
    const projectsList = [];
    if (fs.existsSync(projDir)) {
        for (const name of fs.readdirSync(projDir).sort()) {
            if (name.startsWith("."))
                continue;
            const p = path.join(projDir, name);
            if (!fs.statSync(p).isDirectory())
                continue;
            let projectSessions = [];
            try {
                projectSessions = JSON.parse(fs.readFileSync(path.join(p, "sessions.json"), "utf-8")).sessions || [];
            }
            catch { }
            const pc = cfg?.projects?.[name] || {};
            // Find active model from live agents
            const matchingAgent = agents.find((a) => a.project === name || a.project === name);
            const activeModel = matchingAgent?.model || null;
            const activeModelProvider = matchingAgent?.model_provider || null;
            // Find model details from inventory
            let modelDetails = null;
            if (activeModel) {
                const found = modelList.find((m) => m.id === activeModel);
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
                name, session_count: projectSessions.length,
                created: projectSessions[0]?.logged_at || "N/A",
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
    }
    sendJSON(res, {
        sessions,
        live_session_count: meta.sessionCount || 0,
        live_connected: meta.connected || false,
        live_updated: meta.updatedAt || null,
        live_agents: liveAgents || { agents: [], agent_count: 0, active_count: 0 },
        state,
        models: { ...models, total: modelList.length, active: activeModelCount },
        projects: { projects: projectsList, count: projectsList.length },
        config: cfg,
    });
}
function handleModels(req, res, qs) {
    const data = readJSON(path.join(getDataDir(), "models.json"));
    if (!data)
        return sendJSON(res, { models: [], total: 0 });
    const models = data.models || [];
    const cfg = readJSON(path.join(getDataDir(), "dashboard-config.json"));
    if (qs.id) {
        const m = models.find((m) => m.id === qs.id);
        if (!m)
            return sendError(res, 404, "Model not found");
        return sendJSON(res, m);
    }
    if (qs.all) {
        return sendJSON(res, { models, total: models.length });
    }
    const project = qs.project;
    let filtered = [...models];
    if (cfg?.free_only_mode) {
        filtered = filtered.filter((m) => m.cost?.type !== "subscription" && m.cost?.type !== "payg");
    }
    if (cfg?.disabled_models?.length) {
        filtered = filtered.filter((m) => !cfg.disabled_models.includes(m.id));
    }
    if (project && cfg?.projects?.[project]?.model_allowlist?.length) {
        const wl = cfg.projects[project].model_allowlist;
        filtered = filtered.filter((m) => wl.includes(m.id));
    }
    const active = filtered.filter((m) => m.agent_ready !== false && m.status !== "removed").length;
    sendJSON(res, { models: filtered, total: filtered.length, active, project });
}
async function handleModelUpdate(req, res) {
    try {
        const body = JSON.parse(await readBody(req));
        const { id, ...updates } = body;
        if (!id)
            return sendError(res, 400, "Model ID required");
        const modelsPath = path.join(getDataDir(), "models.json");
        const data = readJSON(modelsPath);
        if (!data || !data.models)
            return sendError(res, 500, "Models data not found");
        const idx = data.models.findIndex((m) => m.id === id);
        if (idx === -1)
            return sendError(res, 404, `Model "${id}" not found`);
        // Apply updates — deep merge for nested objects
        const model = data.models[idx];
        for (const [key, val] of Object.entries(updates)) {
            if (val !== undefined && val !== null) {
                if (typeof val === "object" && !Array.isArray(val) && typeof model[key] === "object" && model[key] !== null) {
                    model[key] = { ...model[key], ...val };
                }
                else {
                    model[key] = val;
                }
            }
        }
        model.last_edited = new Date().toISOString();
        data.models[idx] = model;
        fs.writeFileSync(modelsPath, JSON.stringify(data, null, 2));
        sendJSON(res, { ok: true, model });
    }
    catch (e) {
        sendError(res, 400, e.message);
    }
}
function handleLogs(req, res, qs) {
    const logPath = path.join(getDataDir(), "logs", "orchestrator.jsonl");
    if (!fs.existsSync(logPath))
        return sendJSON(res, { entries: [], count: 0 });
    const limit = parseInt(qs.limit || "50", 10);
    const level = qs.level;
    try {
        const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
        const filtered = [];
        for (const l of lines.reverse()) {
            try {
                const e = JSON.parse(l);
                if (level && e.level !== level)
                    continue;
                filtered.push(e);
                if (filtered.length >= limit)
                    break;
            }
            catch { /* */ }
        }
        sendJSON(res, { entries: filtered, count: filtered.length });
    }
    catch {
        sendJSON(res, { entries: [], count: 0 });
    }
}
function handleLiveAgents(_req, res) {
    const data = readJSON(path.join(getDataDir(), "live-agents.json"));
    if (data)
        return sendJSON(res, data);
    sendJSON(res, { agents: [], agent_count: 0, active_count: 0 });
}
function handleConfigGET(_req, res) {
    const cfg = readJSON(path.join(getDataDir(), "dashboard-config.json")) || {};
    sendJSON(res, cfg);
}
function handleConfigPOST(req, res) {
    return readBody(req).then((data) => {
        const cfg = readJSON(path.join(getDataDir(), "dashboard-config.json")) || {};
        for (const key of ["free_only_mode", "theme", "auto_refresh_seconds", "disabled_models"]) {
            if (data[key] !== undefined)
                cfg[key] = data[key];
        }
        if (data.projects && typeof data.projects === "object") {
            cfg.projects = cfg.projects || {};
            for (const [pn, pc] of Object.entries(data.projects)) {
                cfg.projects[pn] = cfg.projects[pn] || {};
                if (pc.model_allowlist)
                    cfg.projects[pn].model_allowlist = pc.model_allowlist;
                if (pc.free_only !== undefined)
                    cfg.projects[pn].free_only = pc.free_only;
            }
        }
        if (data.safeguards && typeof data.safeguards === "object") {
            cfg.safeguards = { ...(cfg.safeguards || {}), ...data.safeguards };
        }
        fs.writeFileSync(path.join(getDataDir(), "dashboard-config.json"), JSON.stringify(cfg, null, 2));
        sendJSON(res, { ok: true });
    });
}
async function handleAutoPopulate(_req, res) {
    try {
        const dataDir = getDataDir();
        const scriptPath = path.join(PLUGIN_ROOT, "scripts", "auto-populate-models.py");
        const out = execSync(`ORCHESTRATOR_DATA_DIR="${dataDir}" python3 "${scriptPath}" 2>&1`, { encoding: "utf-8", timeout: 30000 }).trim();
        sendJSON(res, { ok: true, output: out });
    }
    catch (err) {
        sendJSON(res, { ok: false, error: err.message || "Auto-populate failed" });
    }
    return true;
}
/** Project directory path */
function projectDir(name) {
    const dir = path.join(getDataDir(), "projects", name);
    try {
        fs.mkdirSync(dir, { recursive: true });
    }
    catch { }
    return dir;
}
/** Safe filename guard (no path traversal) */
function safeFile(fn) {
    return !fn.includes("..") && !fn.includes("/") && !fn.includes('\\');
}
async function handleProjectState(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const name = url.searchParams.get("name") || "";
    if (!name) {
        sendError(res, 400, "Missing name");
        return true;
    }
    try {
        const pd = projectDir(name);
        const cfg = readJSON(path.join(getDataDir(), "dashboard-config.json")) || {};
        const projCfg = cfg.projects?.[name] || {};
        const sessions = [];
        // Load logged sessions
        const sf = path.join(pd, "sessions.json");
        if (fs.existsSync(sf)) {
            try {
                const sdata = JSON.parse(fs.readFileSync(sf, "utf-8"));
                sessions.push(...(sdata.sessions || []));
            }
            catch { }
        }
        // List docs
        const docs = [];
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
                }
                catch { }
            }
        }
        // Read known docs
        const readProjectDoc = (fn) => {
            if (!safeFile(fn))
                return "";
            const fp = path.join(pd, fn);
            if (!fs.existsSync(fp))
                return "";
            try {
                return fs.readFileSync(fp, "utf-8");
            }
            catch {
                return "";
            }
        };
        sendJSON(res, {
            name,
            config: projCfg,
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
    }
    catch (err) {
        sendError(res, 500, err.message);
    }
    return true;
}
async function handleProjectDoc(req, res) {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", "http://localhost");
    const name = url.searchParams.get("name") || "";
    const fn = url.searchParams.get("file") || "";
    if (!name || !fn) {
        sendError(res, 400, "Missing name or file");
        return true;
    }
    if (!safeFile(fn)) {
        sendError(res, 400, "Invalid filename");
        return true;
    }
    const pd = projectDir(name);
    const fp = path.join(pd, fn);
    if (method === "GET") {
        if (!fs.existsSync(fp)) {
            sendJSON(res, { content: null, error: "Not found" });
            return true;
        }
        const content = fs.readFileSync(fp, "utf-8");
        sendJSON(res, { content, name, file: fn });
    }
    else if (method === "DELETE") {
        try {
            if (fs.existsSync(fp))
                fs.unlinkSync(fp);
            sendJSON(res, { ok: true });
        }
        catch (err) {
            sendJSON(res, { ok: false, error: err.message });
        }
    }
    else {
        sendError(res, 405, "Method not allowed");
    }
    return true;
}
async function handleProjectDocSave(req, res) {
    try {
        let body = "";
        for await (const chunk of req)
            body += chunk;
        const data = JSON.parse(body);
        const { name, file, content } = data;
        if (!name || !file) {
            sendJSON(res, { ok: false, error: "Missing name or file" });
            return true;
        }
        if (!safeFile(file)) {
            sendJSON(res, { ok: false, error: "Invalid filename" });
            return true;
        }
        const pd = projectDir(name);
        fs.writeFileSync(path.join(pd, file), content || "", "utf-8");
        sendJSON(res, { ok: true });
    }
    catch (err) {
        sendJSON(res, { ok: false, error: err.message });
    }
    return true;
}
async function handleCreateProject(req, res) {
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
        // Update dashboard config
        const configPath = path.join(getDataDir(), "dashboard-config.json");
        let cfg = {};
        try {
            if (fs.existsSync(configPath))
                cfg = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        }
        catch { /* */ }
        if (!cfg.projects)
            cfg.projects = {};
        cfg.projects[projectName] = {
            location: loc,
            workflow: { enabled: true },
        };
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
        // Create spawn marker if requested
        let spawnInfo = null;
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
    }
    catch (err) {
        sendJSON(res, { ok: false, error: err.message });
    }
}
function handleProjects(_req, res) {
    const projDir = path.join(getDataDir(), "projects");
    if (!fs.existsSync(projDir))
        return sendJSON(res, { projects: [], count: 0 });
    const projects = fs.readdirSync(projDir).filter((n) => {
        if (n.startsWith("."))
            return false;
        const p = path.join(projDir, n);
        return fs.statSync(p).isDirectory();
    }).map((name) => {
        const sf = path.join(projDir, name, "sessions.json");
        let sessions = [];
        try {
            sessions = JSON.parse(fs.readFileSync(sf, "utf-8")).sessions || [];
        }
        catch { /* */ }
        return { name, session_count: sessions.length, created: sessions[0]?.logged_at || "N/A" };
    });
    const cfg = readJSON(path.join(getDataDir(), "dashboard-config.json"));
    for (const p of projects) {
        const pc = cfg?.projects?.[p.name] || {};
        p.model_allowlist = pc.model_allowlist || [];
        p.free_only = pc.free_only || false;
    }
    sendJSON(res, { projects, count: projects.length });
}
function handlePrices(_req, res) {
    const logPath = path.join(getDataDir(), "price_changes.log");
    if (!fs.existsSync(logPath))
        return sendJSON(res, { entries: [], count: 0 });
    const entries = fs.readFileSync(logPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("#"))
        .map((l) => ({ text: l.trim() }));
    sendJSON(res, { entries, count: entries.length });
}
function handleGateway(req, res) {
    const lf = path.join(getDataDir(), "live-sessions.json");
    if (fs.existsSync(lf)) {
        try {
            const live = JSON.parse(fs.readFileSync(lf, "utf-8"));
            return sendJSON(res, {
                live: true,
                session_count: live._meta?.sessionCount || 0,
                sessions: live.sessions || [],
                updated: live._meta?.updatedAt || null,
            });
        }
        catch { /* */ }
    }
    sendJSON(res, { live: false, sessions: [], session_count: 0 });
}
function handleSessions(req, res) {
    // Return live gateway sessions (used by Gateway tab)
    const lf = path.join(getDataDir(), "live-sessions.json");
    if (fs.existsSync(lf)) {
        try {
            const live = JSON.parse(fs.readFileSync(lf, "utf-8"));
            return sendJSON(res, {
                sessions: live.sessions || [],
                count: live.sessions?.length || 0,
                session_count: live._meta?.sessionCount || 0,
                updated: live._meta?.updatedAt || null,
            });
        }
        catch { /* fall through */ }
    }
    sendJSON(res, { sessions: [], count: 0 });
}
function handleSafeguardLog(_req, res) {
    const sl = path.join(getDataDir(), "safeguard-log.md");
    if (!fs.existsSync(sl))
        return sendJSON(res, { entries: [], count: 0 });
    const lines = fs.readFileSync(sl, "utf-8").split("\n").filter((l) => l.startsWith("|") && !l.includes("---"));
    const entries = lines.slice(1).map((l) => {
        const parts = l.split("|").slice(1, -1).map((p) => p.trim());
        return { timestamp: parts[0] || "", event: parts[1] || "", details: parts[2] || "" };
    });
    sendJSON(res, { entries, count: entries.length });
}
// ── ERROR READING HELPERS ────────────────────────────────────
function readOrchestratorErrors(project, limit = 50) {
    const pd = projectDir(project);
    const errLog = path.join(pd, "errors.log");
    if (!fs.existsSync(errLog))
        return [];
    try {
        const content = fs.readFileSync(errLog, "utf-8");
        return content.trim().split("\n").filter(Boolean).slice(-limit).map(l => {
            try {
                return JSON.parse(l);
            }
            catch {
                return { error: l };
            }
        });
    }
    catch {
        return [];
    }
}
function readGlobalErrors(limit = 20) {
    const projectsDir = path.join(getDataDir(), "projects");
    if (!fs.existsSync(projectsDir))
        return [];
    try {
        const all = [];
        for (const p of fs.readdirSync(projectsDir)) {
            if (p.startsWith("."))
                continue;
            const pp = path.join(projectsDir, p);
            if (!fs.statSync(pp).isDirectory())
                continue;
            const errFile = path.join(pp, "errors.log");
            if (fs.existsSync(errFile)) {
                try {
                    const content = fs.readFileSync(errFile, "utf-8");
                    for (const line of content.trim().split("\n").filter(Boolean)) {
                        try {
                            all.push({ ...JSON.parse(line), project: p });
                        }
                        catch { }
                    }
                }
                catch { }
            }
        }
        return all.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || "")).slice(0, limit);
    }
    catch {
        return [];
    }
}
// ═══ Session Validation (Phase 4a) ═══
function validateProjectSessions(dataDir, project) {
    const issues = [];
    let total = 0;
    const projectsChecked = [];
    const checkProject = (projName) => {
        const sf = path.join(getDataDir(), "projects", projName, "sessions.json");
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
            if (!sk || typeof sk !== "string") {
                issues.push({ id, session_key: sk, issue: "Missing or invalid session_key", field: "session_key", severity: "error" });
            }
            else if (!sk.startsWith("agent:")) {
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
    }
    else {
        const projDir = path.join(getDataDir(), "projects");
        if (fs.existsSync(projDir)) {
            for (const p of fs.readdirSync(projDir).sort()) {
                if (p.startsWith("."))
                    continue;
                const pp = path.join(projDir, p);
                if (!fs.statSync(pp).isDirectory())
                    continue;
                checkProject(p);
            }
        }
    }
    return { ok: true, total, issues, projects_checked: projectsChecked };
}
function handleValidateSessions(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const project = url.searchParams.get("project") || "";
    const result = validateProjectSessions(getDataDir(), project || undefined);
    sendJSON(res, result);
}
// ═══ Model Assignment (Phase 3b) ═══
async function handleSetProjectModel(req, res) {
    try {
        const body = await readBody(req);
        const { project, model_id } = body;
        if (!project || !model_id) {
            sendJSON(res, { ok: false, error: "Missing project or model_id" });
            return;
        }
        // Validate model exists in inventory
        const modelsData = readJSON(path.join(getDataDir(), "models.json"));
        const models = (modelsData?.models || []);
        const model = models.find((m) => m.id === model_id);
        if (!model) {
            sendJSON(res, { ok: false, error: `Model "${model_id}" not found in inventory` });
            return;
        }
        // Update project config
        const cfg = readJSON(path.join(getDataDir(), "dashboard-config.json")) || {};
        if (!cfg.projects)
            cfg.projects = {};
        if (!cfg.projects[project])
            cfg.projects[project] = {};
        cfg.projects[project].model_allowlist = [model_id];
        cfg.projects[project].free_only = model.tier === "free" || model.tier === 0 ? true : false;
        fs.writeFileSync(path.join(getDataDir(), "dashboard-config.json"), JSON.stringify(cfg, null, 2));
        sendJSON(res, {
            ok: true,
            model: model.id,
            provider: model.provider,
        });
    }
    catch (e) {
        console.error("[handleSetProjectModel] Error:", e, "Message:", e?.message, "Stack:", e?.stack);
        sendJSON(res, { ok: false, error: typeof e === 'string' ? e : (e?.message || String(e)) });
    }
}
// ═══ Set Project Routing (Phase 3b) ═══
async function handleSetProjectRouting(req, res) {
    try {
        const body = await readBody(req);
        const { project, routing, preset, free_only, model_allowlist, routing_single_provider } = body;
        if (!project) {
            sendJSON(res, { ok: false, error: "Missing project" });
            return;
        }
        const cfg = readJSON(path.join(getDataDir(), "dashboard-config.json")) || {};
        if (!cfg.projects)
            cfg.projects = {};
        if (!cfg.projects[project])
            cfg.projects[project] = {};
        if (routing !== undefined) {
            cfg.projects[project].model_routing = routing;
        }
        if (preset !== undefined) {
            cfg.projects[project].routing_preset = preset;
        }
        if (free_only !== undefined) {
            cfg.projects[project].free_only = free_only;
        }
        if (model_allowlist !== undefined) {
            cfg.projects[project].model_allowlist = model_allowlist;
        }
        if (routing_single_provider !== undefined) {
            cfg.projects[project].routing_single_provider = routing_single_provider;
        }
        fs.writeFileSync(path.join(getDataDir(), "dashboard-config.json"), JSON.stringify(cfg, null, 2));
        sendJSON(res, {
            ok: true,
            message: `Routing updated for ${project}`,
            preset: cfg.projects[project].routing_preset || null,
            chains: Object.keys(cfg.projects[project].model_routing || {}).length,
        });
    }
    catch (e) {
        console.error("[handleSetProjectRouting] Error:", e);
        sendJSON(res, { ok: false, error: e?.message || String(e) });
    }
}
// ═══ Phase 3c: Backlog API ═══
function handleProjectBacklog(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const project = url.searchParams.get("project");
    if (!project)
        return sendJSON(res, { ok: false, error: "Missing project" });
    const bp = path.join(getDataDir(), "projects", project, "BACKLOG.json");
    if (!fs.existsSync(bp))
        return sendJSON(res, { tasks: [] });
    try {
        const data = JSON.parse(fs.readFileSync(bp, "utf-8"));
        sendJSON(res, { tasks: data.tasks || [] });
    }
    catch {
        sendJSON(res, { tasks: [] });
    }
}
function handleProjectErrors(req, res) {
    const url = new URL(req.url || "/", "http://localhost");
    const project = url.searchParams.get("project") || "";
    if (!project) {
        sendJSON(res, { ok: false, error: "Missing project" });
        return;
    }
    const limit = parseInt(url.searchParams.get("limit") || "50", 10);
    sendJSON(res, { ok: true, errors: readOrchestratorErrors(project, limit) });
}
function handleGlobalErrors(req, res) {
    const limit = parseInt(new URL(req.url || "/", "http://localhost").searchParams.get("limit") || "20", 10);
    sendJSON(res, { ok: true, errors: readGlobalErrors(limit) });
}
// ── MAIN HTTP HANDLER ─────────────────────────────────────────
const BASE_PATH = "/orchestrator";
/** Strip the registered base path prefix from a URL pathname. */
function stripBasePath(pathname) {
    if (pathname === BASE_PATH || pathname === BASE_PATH + "/")
        return "/";
    if (pathname.startsWith(BASE_PATH + "/"))
        return pathname.slice(BASE_PATH.length);
    return pathname;
}
export function createDashboardHandler(api) {
    return async (req, res) => {
        try {
            const method = req.method || "GET";
            const rawPathname = parsePathname(req.url || "/");
            const pathname = stripBasePath(rawPathname);
            const qs = parseQuery(req.url || "");
            // ── Helper: Quick Action — spawns a subagent with a preset prompt ──
            async function handleQuickAction(_req, _res) {
                try {
                    const body = await readBody(_req);
                    const { action, params } = typeof body === "string" ? JSON.parse(body) : body;
                    if (!action) {
                        sendJSON(_res, { ok: false, error: "Action name required" });
                        return true;
                    }
                    const promptTemplates = {
                        grill_with_docs: (p) => [
                            `[Quick Action: Grill Me With Docs — from Orchestrator Dashboard]`,
                            `You are a project documentation examiner.`,
                            `1. Read ALL project documentation files.`,
                            `2. Formulate 5-10 probing questions about the project's architecture, decisions, trade-offs.`,
                            `3. Present ONE question at a time, wait for the user's answer, then give feedback.`,
                            `4. After all questions, provide a summary of gaps and strengths.`,
                            p.topic ? `Focus on: ${p.topic}` : "",
                            `Be tough but fair.`,
                        ].filter(Boolean).join("\n"),
                        cleanup_docs: (p) => [
                            `[Quick Action: Clean Up & Organize Docs — from Orchestrator Dashboard]`,
                            `You are a documentation specialist.`,
                            `Scope: ${p.scope || "all"}`,
                            `1. READ all existing documentation.`,
                            `2. Fix broken links, stale content, missing sections, inconsistent formatting.`,
                            `3. Update files and create new ones if important gaps found.`,
                            `4. Report summary of changes and why.`,
                        ].filter(Boolean).join("\n"),
                        setup_unit_tests: (p) => [
                            `[Quick Action: Set Up Unit Tests — from Orchestrator Dashboard]`,
                            `You are a test infrastructure engineer.`,
                            `Framework: ${p.framework || "vitest"}`,
                            `1. Install and configure the test framework.`,
                            `2. Create initial unit tests for critical modules.`,
                            `3. Set up test scripts in package.json.`,
                            `4. Run tests and fix failures.`,
                            `5. Report what was set up, pass rate, recommendations.`,
                        ].filter(Boolean).join("\n"),
                        setup_e2e_tests: (p) => [
                            `[Quick Action: Set Up E2E Tests — from Orchestrator Dashboard]`,
                            `You are a test infrastructure engineer.`,
                            `Framework: ${p.framework || "playwright"}`,
                            `1. Install and configure E2E testing.`,
                            `2. Create E2E test scenarios for critical user journeys.`,
                            `3. Set up test scripts.`,
                            `4. Run tests and fix issues.`,
                            `5. Report results and recommendations.`,
                        ].filter(Boolean).join("\n"),
                        debug_issue: (p) => [
                            `[Quick Action: Debug Issue — from Orchestrator Dashboard]`,
                            `## Issue Description`,
                            p.issue_description || "No description provided.",
                            ``,
                            `## Instructions`,
                            `1. Understand the project and the issue.`,
                            `2. Reproduce the issue.`,
                            `3. Identify root cause.`,
                            `4. Implement a fix.`,
                            `5. Verify the fix.`,
                            `6. Report findings.`,
                        ].filter(Boolean).join("\n"),
                        create_functionality: (p) => [
                            `[Quick Action: Create New Functionality — from Orchestrator Dashboard]`,
                            `## Requirements`,
                            p.description || "No description provided.",
                            ``,
                            `## Instructions`,
                            `1. Understand the project architecture.`,
                            `2. Design a solution fitting existing patterns.`,
                            `3. Implement following project standards.`,
                            `4. Add tests.`,
                            `5. Verify everything works.`,
                            `6. Report what was built and decisions made.`,
                        ].filter(Boolean).join("\n"),
                    };
                    const templateFn = promptTemplates[action];
                    if (!templateFn) {
                        sendJSON(_res, { ok: false, error: `Unknown action: ${action}` });
                        return true;
                    }
                    const message = templateFn(params || {});
                    const sessionKey = `agent:main:subagent:orch-dash-${crypto.randomUUID()}`;
                    const result = await api.runtime.subagent.run({
                        sessionKey,
                        message,
                        model: params?.model || undefined,
                        lightContext: true,
                    });
                    sendJSON(_res, {
                        ok: true,
                        action,
                        run_id: result.runId,
                        session_key: sessionKey,
                        message: `Quick action "${action}" spawned (runId: ${result.runId})`,
                    });
                }
                catch (e) {
                    sendJSON(_res, { ok: false, error: e.message }, 500);
                }
                return true;
            }
            async function handleSpawnProjectSession(_req, _res) {
                try {
                    const body = await readBody(_req);
                    const { project, task, model } = typeof body === "string" ? JSON.parse(body) : body;
                    if (!project || !task) {
                        sendJSON(_res, { ok: false, error: "Project and task are required" });
                        return true;
                    }
                    const safeName = project.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
                    const sessionKey = `agent:main:project-session:${safeName}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
                    // ═══ Read gateway token from config ═══
                    let gatewayToken = "";
                    try {
                        const cfgPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
                        if (fs.existsSync(cfgPath)) {
                            const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
                            gatewayToken = cfg?.gateway?.auth?.token || "";
                        }
                    }
                    catch { /* fallback to env */ }
                    if (!gatewayToken) {
                        gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || "";
                    }
                    if (!gatewayToken) {
                        sendJSON(_res, { ok: false, error: "Gateway token not found — cannot spawn via OpenAI endpoint" }, 500);
                        return true;
                    }
                    api.logger.info(`spawn: Creating session via OpenAI endpoint -> ${sessionKey.slice(0, 50)}`);
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
                }
                catch (e) {
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
                // Dashboard main page
                if (pathname === "/" || pathname === "/index.html") {
                    sendFile(res, HTML_PATH);
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
            if (method === "GET") {
                switch (pathname) {
                    case "/api/status":
                        handleStatus(req, res);
                        return true;
                    case "/api/all":
                        handleAll(req, res);
                        return true;
                    case "/api/models":
                        handleModels(req, res, qs);
                        return true;
                    case "/api/logs":
                        handleLogs(req, res, qs);
                        return true;
                    case "/api/live-agents":
                        handleLiveAgents(req, res);
                        return true;
                    case "/api/config":
                        handleConfigGET(req, res);
                        return true;
                    case "/api/projects":
                        handleProjects(req, res);
                        return true;
                    case "/api/prices":
                        handlePrices(req, res);
                        return true;
                    case "/api/sessions":
                        handleSessions(req, res);
                        return true;
                    case "/api/gateway":
                        handleGateway(req, res);
                        return true;
                    case "/api/safeguard-log":
                        handleSafeguardLog(req, res);
                        return true;
                    case "/api/sse/live-sessions":
                        handleSSE(res);
                        return true;
                    case "/api/project-state": return handleProjectState(req, res);
                    case "/api/project-doc": return handleProjectDoc(req, res);
                    case "/api/project-errors":
                        handleProjectErrors(req, res);
                        return true;
                    case "/api/global-errors":
                        handleGlobalErrors(req, res);
                        return true;
                    case "/api/project-backlog":
                        handleProjectBacklog(req, res);
                        return true;
                    case "/api/validate-sessions":
                        handleValidateSessions(req, res);
                        return true;
                }
            }
            // ── POST API ──
            if (method === "POST") {
                switch (pathname) {
                    case "/api/config": return handleConfigPOST(req, res).then(() => true);
                    case "/api/auto-populate": return handleAutoPopulate(req, res);
                    case "/api/project-state": return handleProjectState(req, res);
                    case "/api/project-doc": return handleProjectDocSave(req, res);
                    case "/api/create-project":
                        handleCreateProject(req, res);
                        return true;
                    case "/api/set-project-model": return handleSetProjectModel(req, res).then(() => true);
                    case "/api/set-project-routing": return handleSetProjectRouting(req, res).then(() => true);
                    case "/api/quick-action": return handleQuickAction(req, res);
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
        }
        catch (err) {
            sendError(res, 500, err.message);
            return true;
        }
    };
}
