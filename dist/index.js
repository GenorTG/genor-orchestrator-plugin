import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { toolPluginMetadataSymbol } from "openclaw/plugin-sdk/tool-plugin";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawn } from "node:child_process";
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
function getDataDir(cfgDir) {
    if (cfgDir && fs.existsSync(cfgDir))
        return cfgDir;
    if (process.env.ORCHESTRATOR_DATA_DIR && fs.existsSync(process.env.ORCHESTRATOR_DATA_DIR))
        return process.env.ORCHESTRATOR_DATA_DIR;
    const dflt = path.join(os.homedir(), ".openclaw/workspace/orchestrator-data");
    fs.mkdirSync(dflt, { recursive: true });
    return dflt;
}
function getDashboardDir() {
    const candidates = [
        process.env.DASHBOARD_DIR,
        path.join(os.homedir(), ".openclaw/workspace/skills/genor-orchestrator/dashboard"),
        path.join(os.homedir(), ".openclaw/extensions/genor-orchestrator/dashboard"),
    ];
    for (const c of candidates) {
        if (c && fs.existsSync(c))
            return c;
    }
    const dflt = path.join(os.homedir(), ".openclaw/workspace/skills/genor-orchestrator/dashboard");
    fs.mkdirSync(dflt, { recursive: true });
    return dflt;
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
    autoCommit = false;
    skipPhases = [];
    reset(projectWorkflowConfig) {
        this.enabled = projectWorkflowConfig?.enabled ?? false;
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
    workflow = new WorkflowTracker();
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
        this.actionHistory.push({ action, file, ts: new Date().toISOString() });
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
        this.lastActivityTimestamp = Date.now();
        if (reason === "new" || reason === "reset") {
            this.currentProject = null;
            this.currentTask = null;
            this.currentModel = null;
            this.currentModelProvider = null;
            this.currentModelTier = 0;
            this.tokenUsage = { input: 0, output: 0, total: 0 };
        }
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
        this.currentProject = project;
        this.currentTask = task;
        this.trackAction("Setting context");
        this.agentStatus = "working";
        // Reset workflow tracker with project config
        this.workflow.reset(workflowConfig);
    }
    clearContext() {
        const prev = this.currentProject;
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
        if (prev)
            this.trackAction("Clearing context");
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
    const sf = path.join(projDir(project, dataDir), "sessions.json");
    if (!fs.existsSync(sf))
        return;
    try {
        const raw = JSON.parse(fs.readFileSync(sf, "utf-8"));
        let sessions = Array.isArray(raw) ? raw : (raw.sessions || []);
        let changed = false;
        sessions = sessions.map(s => {
            const ns = { ...s };
            if (ns.timestamp && !ns.date) {
                ns.date = ns.timestamp.split("T")[0];
                changed = true;
            }
            if (!ns.logged_at) {
                ns.logged_at = new Date().toISOString();
                changed = true;
            }
            return ns;
        });
        if (changed)
            writeJSON(sf, { sessions });
    }
    catch { /* */ }
}
function generateRecoveryDoc(project, dataDir, logger) {
    const pd = projDir(project, dataDir);
    const loc = getProjectLocation(project, dataDir);
    const context = readFileContent(path.join(pd, "CONTEXT.md")) || "";
    const blPath = path.join(pd, "BACKLOG.json");
    let backlog = [];
    if (fs.existsSync(blPath)) {
        try {
            backlog = JSON.parse(fs.readFileSync(blPath, "utf-8"));
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
    const sf = path.join(projDir(project, dataDir), "sessions.json");
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
            const projects = fs.readdirSync(projDirPath).filter(f => fs.statSync(path.join(projDirPath, f)).isDirectory());
            for (const p of projects) {
                try {
                    normalizeSessionsJson(p, this.dataDir);
                    generateRecoveryDoc(p, this.dataDir, this.logger);
                    if (getProjectLocation(p, this.dataDir)) {
                        syncProjectToOrchestrator(p, this.dataDir, this.logger);
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
    const dd = getDashboardDir();
    const candidates = [
        path.join(dd, "..", "scripts", "auto-populate-models.py"),
        path.join(os.homedir(), ".openclaw/workspace/skills/genor-orchestrator", "scripts", "auto-populate-models.py"),
        path.join(os.homedir(), ".openclaw/extensions/genor-orchestrator", "scripts", "auto-populate-models.py"),
    ];
    let script = "";
    for (const c of candidates) {
        if (fs.existsSync(c)) {
            script = c;
            break;
        }
    }
    if (!script)
        return { error: "Script not found. Checked: " + candidates.join(", "), skill_dir: dd };
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
    ps.push({
        date,
        project: opts.project,
        task: opts.task,
        goal: opts.goal || opts.task,
        model: opts.model,
        agent: opts.agent,
        session_key: opts.session_key || "",
        status: opts.status,
        duration: opts.duration || "",
        qa: opts.qa || false,
        checked: opts.checked || false,
        notes: opts.notes || "",
        logged_at: new Date().toISOString(),
    });
    writeJSON(psf, { sessions: ps });
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
function setContext(dataDir, project, task, logger) {
    projDir(project, dataDir);
    // Read per-project workflow config from dashboard-config.json
    const cfg = readJSON(path.join(dataDir, "dashboard-config.json")) || {};
    const projCfg = cfg.projects?.[project] || {};
    sessionTracker.setContext(project, task, projCfg.workflow);
    writeLiveAgents("context", sessionTracker);
    const loc = getProjectLocation(project, dataDir);
    const toc = loc ? buildProjectToc(loc) : [];
    // Auto-log session only when a model is actually assigned (skip phantom 'pending' entries)
    const sessionModel = sessionTracker.currentModel;
    if (sessionModel && sessionModel !== "pending") {
        logSession(dataDir, {
            project,
            task,
            model: sessionModel,
            agent: sessionTracker.currentAgent || sessionTracker.sessionKey || "system",
            status: "running",
            duration: "",
            session_key: sessionTracker.sessionKey || "",
            goal: task,
            notes: `Goal: ${task} | Agent: ${sessionTracker.currentAgent || "?"} | Key: ${sessionTracker.sessionKey || "?"} | Workflow: ${projCfg.workflow?.enabled ? "ON" : "OFF"}`,
        }, logger);
    }
    logger.info("context", `Context set: ${project}/${task} [session=${sessionTracker.sessionKey}]`);
    return {
        ok: true, project, task, location: loc || "not configured",
        location_configured: loc !== undefined && loc !== null,
        toc_file_count: toc.length,
        workflow_enabled: sessionTracker.workflow.enabled,
    };
}
function clearContextFn(dataDir, logger) {
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
    const pd = projDir(project, dataDir);
    const docs = [];
    if (fs.existsSync(pd)) {
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
    "orchestrator_advance_phase",
];
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
                sessionTracker.start(sk || "unknown", event.reason || "new");
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
                sessionTracker.setStatus("complete");
                sessionTracker.trackAction("session_ending");
                writeLiveAgents("session_end", sessionTracker, logger);
                const info = sessionTracker.end();
                if (info) {
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
                        session_key: sessionTracker.sessionKey || "",
                        goal: info.task,
                        notes: `Completed: ${info.task} | Agent: ${sessionTracker.currentAgent || "?"} | Status: ${event.reason} | Workflow: ${sessionTracker.workflow.enabled ? sessionTracker.workflow.currentPhase : "OFF"}`,
                    }, logger);
                    generateRecoveryDoc(info.project, dataDir, logger);
                    sessionTracker.currentAction = "session_complete";
                    writeLiveAgents("session_complete", sessionTracker, logger);
                    logger.info("hooks", `Session auto-logged: ${info.project}/${info.task} (${info.duration})`);
                }
                logger.debug("hooks", `session_end: ${event.reason}`);
            }
            catch (err) {
                logger.error("hooks", `session_end error: ${err.message}`);
            }
        });
        api.on("subagent_spawned", async () => {
            sessionTracker.subagentDepth++;
            sessionTracker.setStatus("working");
            if (sessionTracker.currentProject) {
                logger.debug("subagent", `Depth ${sessionTracker.subagentDepth} for ${sessionTracker.currentProject}`);
            }
            writeLiveAgents("subagent_spawned", sessionTracker, logger);
        });
        api.on("subagent_ended", async () => {
            sessionTracker.subagentDepth = Math.max(0, sessionTracker.subagentDepth - 1);
            if (sessionTracker.currentProject) {
                writeLiveAgents("subagent_ended", sessionTracker, logger);
            }
        });
        api.on("before_model_resolve", async (event) => {
            try {
                sessionTracker.setStatus("resolving");
                sessionTracker.trackAction("resolving_model");
                writeLiveAgents("before_model_resolve", sessionTracker, logger);
                if (!sessionTracker.currentProject)
                    return;
                const md = readJSON(path.join(dataDir, "models.json"));
                const allModels = md?.models || [];
                const cfg2 = readJSON(path.join(dataDir, "dashboard-config.json")) || {};
                const pc = cfg2.projects?.[sessionTracker.currentProject];
                let eligible = [...allModels];
                const filters = [];
                if (cfg2.free_only_mode) {
                    eligible = eligible.filter(m => !isPaid(m));
                    filters.push("global_free_only");
                }
                const disabled = cfg2.disabled_models || [];
                if (disabled.length) {
                    eligible = eligible.filter(m => !disabled.includes(m.id));
                    filters.push("global_disabled");
                }
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
                    const resolvedInfo = allModels.find((m) => m.id === event.resolvedModel);
                    sessionTracker.trackModel(event.resolvedModel, resolvedInfo?.provider, resolvedInfo?.tier);
                }
            }
            catch (err) {
                logger.error("hooks", `before_model_resolve error: ${err.message}`);
            }
        });
        api.on("before_prompt_build", async () => {
            try {
                sessionTracker.setStatus("prompting");
                sessionTracker.trackAction("building_prompt");
                writeLiveAgents("before_prompt_build", sessionTracker, logger);
                if (!sessionTracker.currentProject)
                    return;
                const loc = getProjectLocation(sessionTracker.currentProject, dataDir);
                let ctx = `⚡ Project: ${sessionTracker.currentProject}`;
                if (sessionTracker.currentTask)
                    ctx += ` | Task: ${sessionTracker.currentTask}`;
                ctx += `\nLocation: ${loc || "not set"}`;
                ctx += ` | Sub-agents: ${sessionTracker.subagentDepth}`;
                ctx += ` | Data: orchestrator-data/projects/${sessionTracker.currentProject}/`;
                return { prependContext: ctx };
            }
            catch { /* */ }
        });
        api.on("agent_end", async () => {
            sessionTracker.setStatus("stopped");
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
                task: Type.String({ description: "Task description (e.g., fix-dashboard-js-syntax)." }),
            }),
            async execute(_id, params) {
                return txt(setContext(dataDir, params.project, params.task, logger));
            },
        });
        api.registerTool({
            name: "orchestrator_clear_context",
            label: "Orchestrator Clear Context",
            description: "Clear active project context. Disables auto-routing and auto-logging.",
            parameters: Type.Object({}),
            async execute(_id, _params) {
                return txt(clearContextFn(dataDir, logger));
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
            async execute() {
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
            async execute(_id, params) {
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
                context: Type.String({ description: "Why this decision was made." }),
                decision: Type.String({ description: "What was decided." }),
                alternatives: Type.Optional(Type.String({ description: "Alternatives considered." })),
                consequences: Type.Optional(Type.String({ description: "Impact." })),
            }),
            async execute(_id, params) {
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
                const wf = sessionTracker.workflow;
                if (!wf.enabled) {
                    return txt({ ok: false, error: "Workflow enforcement is not enabled for this project. Set workflow.enabled in dashboard-config.json" });
                }
                if (params.phase) {
                    // Check transition is valid
                    if (!wf.canTransitionTo(params.phase.toLowerCase())) {
                        return txt({ ok: false, error: `Cannot transition to '${params.phase}' from current phase '${wf.currentPhase}'. Workflow must go forward: ${["analyze", "plan", "document", "work", "log", "finish"].join(" → ")}` });
                    }
                    wf.completePhase(wf.currentPhase, params.skip);
                    wf.enterPhase(params.phase.toLowerCase());
                }
                else {
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
                    "**Dashboard:** http://${tailscaleHost}:${dashPort}",
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
                    "**/genor-dashboard** \u2014 Dashboard URL",
                    "**/genor-status** \u2014 Quick status overview",
                    "**/genor-git-commit** \u2014 Commit project changes with versioning",
                    "",
                    "Dashboard: http://${tailscaleHost}:${dashPort}",
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
        logger.info("plugin", `Orchestrator ready — ${logLevel} logging, maintenance active, ${Object.keys(TOOL_NAMES).length} tools, 4 slash commands`);
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
        tools: [...TOOL_NAMES],
        contracts: {
            tools: [...TOOL_NAMES],
        },
    },
    enumerable: false,
});
export default pluginExport;
