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
const HTML_PATH = path.join(os.homedir(), "projects", "genor-orchestrator-plugin", "dashboard", "index.html");
const DATA_DIR = path.join(os.homedir(), ".openclaw", "workspace", "orchestrator-data");
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
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(JSON.stringify(data));
}
function sendError(res, code, msg) {
    sendJSON(res, { error: msg }, code);
}
function sendFile(res, filePath) {
    if (!fs.existsSync(filePath)) {
        sendError(res, 404, "Not found");
        return;
    }
    const ext = path.extname(filePath);
    const ct = MIME[ext] || "application/octet-stream";
    const content = fs.readFileSync(filePath);
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
    const liveFile = path.join(DATA_DIR, "live-sessions.json");
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
    const cfg = readJSON(path.join(DATA_DIR, "dashboard-config.json"));
    sendJSON(res, {
        nightly_price_check: fs.existsSync(path.join(DATA_DIR, "price_changes.log")) ? "Configured (2 AM)" : "Not configured",
        price_log_exists: fs.existsSync(path.join(DATA_DIR, "price_changes.log")),
        data_dir: DATA_DIR,
        free_only_mode: cfg?.free_only_mode || false,
        disabled_models: cfg?.disabled_models?.length || 0,
        projects_configured: cfg?.projects ? Object.keys(cfg.projects).length : 0,
    });
}
function handleAll(_req, res) {
    const cfg = readJSON(path.join(DATA_DIR, "dashboard-config.json")) || {};
    const liveSessions = readJSON(path.join(DATA_DIR, "live-sessions.json"));
    const liveAgents = readJSON(path.join(DATA_DIR, "live-agents.json"));
    const models = readJSON(path.join(DATA_DIR, "models.json"));
    const sessions = liveSessions?.sessions || [];
    const meta = liveSessions?._meta || {};
    const agents = liveAgents?.agents || [];
    const state = agents[0] || {};
    sendJSON(res, {
        sessions,
        live_session_count: meta.sessionCount || 0,
        live_connected: meta.connected || false,
        live_updated: meta.updatedAt || null,
        live_agents: liveAgents || { agents: [], agent_count: 0, active_count: 0 },
        state,
        models: models || { models: [], total: 0, active: 0 },
        config: cfg,
    });
}
function handleModels(req, res, qs) {
    const data = readJSON(path.join(DATA_DIR, "models.json"));
    if (!data)
        return sendJSON(res, { models: [], total: 0 });
    const models = data.models || [];
    const cfg = readJSON(path.join(DATA_DIR, "dashboard-config.json"));
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
function handleLogs(req, res, qs) {
    const logPath = path.join(DATA_DIR, "logs", "orchestrator.jsonl");
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
    const data = readJSON(path.join(DATA_DIR, "live-agents.json"));
    if (data)
        return sendJSON(res, data);
    sendJSON(res, { agents: [], agent_count: 0, active_count: 0 });
}
function handleConfigGET(_req, res) {
    const cfg = readJSON(path.join(DATA_DIR, "dashboard-config.json")) || {};
    sendJSON(res, cfg);
}
function handleConfigPOST(req, res) {
    return readBody(req).then((data) => {
        const cfg = readJSON(path.join(DATA_DIR, "dashboard-config.json")) || {};
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
        fs.writeFileSync(path.join(DATA_DIR, "dashboard-config.json"), JSON.stringify(cfg, null, 2));
        sendJSON(res, { ok: true });
    });
}
function handleProjects(_req, res) {
    const projDir = path.join(DATA_DIR, "projects");
    if (!fs.existsSync(projDir))
        return sendJSON(res, { projects: [], count: 0 });
    const projects = fs.readdirSync(projDir).filter((n) => {
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
    const cfg = readJSON(path.join(DATA_DIR, "dashboard-config.json"));
    for (const p of projects) {
        const pc = cfg?.projects?.[p.name] || {};
        p.model_allowlist = pc.model_allowlist || [];
        p.free_only = pc.free_only || false;
    }
    sendJSON(res, { projects, count: projects.length });
}
function handlePrices(_req, res) {
    const logPath = path.join(DATA_DIR, "price_changes.log");
    if (!fs.existsSync(logPath))
        return sendJSON(res, { entries: [], count: 0 });
    const entries = fs.readFileSync(logPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("#"))
        .map((l) => ({ text: l.trim() }));
    sendJSON(res, { entries, count: entries.length });
}
function handleGateway(req, res) {
    const lf = path.join(DATA_DIR, "live-sessions.json");
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
    const sf = path.join(DATA_DIR, "session_log.md");
    if (!fs.existsSync(sf))
        return sendJSON(res, { sessions: [], count: 0 });
    const content = fs.readFileSync(sf, "utf-8");
    const sessions = [];
    for (const line of content.split("\n")) {
        const tr = line.trim();
        if (tr.startsWith("|") && !tr.startsWith("|---") && !tr.startsWith("| Date")) {
            const parts = tr.split("|").slice(1, -1).map((p) => p.trim());
            if (parts.length >= 5) {
                sessions.push({ date: parts[0], project: parts[1], task: parts[2], model: parts[3], agent: parts[4] });
            }
        }
    }
    sendJSON(res, { sessions, count: sessions.length });
}
function handleSafeguardLog(_req, res) {
    const sl = path.join(DATA_DIR, "safeguard-log.md");
    if (!fs.existsSync(sl))
        return sendJSON(res, { entries: [], count: 0 });
    const lines = fs.readFileSync(sl, "utf-8").split("\n").filter((l) => l.startsWith("|") && !l.includes("---"));
    const entries = lines.slice(1).map((l) => {
        const parts = l.split("|").slice(1, -1).map((p) => p.trim());
        return { timestamp: parts[0] || "", event: parts[1] || "", details: parts[2] || "" };
    });
    sendJSON(res, { entries, count: entries.length });
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
export function createDashboardHandler(_api) {
    return async (req, res) => {
        try {
            const method = req.method || "GET";
            const rawPathname = parsePathname(req.url || "/");
            const pathname = stripBasePath(rawPathname);
            const qs = parseQuery(req.url || "");
            // CORS preflight
            if (method === "OPTIONS") {
                res.writeHead(200, {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type",
                });
                res.end();
                return true;
            }
            // ── STATIC FILES ──
            if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
                sendFile(res, HTML_PATH);
                return true;
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
                }
            }
            // ── POST API ──
            if (method === "POST") {
                switch (pathname) {
                    case "/api/config": return handleConfigPOST(req, res).then(() => true);
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
