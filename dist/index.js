import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { toolPluginMetadataSymbol } from "openclaw/plugin-sdk/tool-plugin";
import * as fs from "node:fs";
import * as path from "node:path";
import { WORKER_TOOLS } from "./worker-tools.js";
import * as os from "node:os";
import { execSync, spawn } from "node:child_process";
import * as crypto from "node:crypto";
import { createDashboardHandler } from "./dashboard-handler.js";
import { getDataDir } from "./shared.js";
import { MaintenanceService } from "./maintenance.js";
import { configureLLM } from "./worker-runtime.js";
import { OrchestratorLogger } from "./logger.js";
import { txt, writeJSON } from "./utils.js";
import { WORKFLOW_ORDER } from "./workflow.js";
import { sessionTracker } from "./session-tracker.js";
import { queueLiveAgents } from "./live-agents.js";
import { _toolCount, incrementToolCount, _collectedToolMeta, _staticToolNames } from "./plugin-state.js";
import { isPaid, projDir, logOrchestratorError, backlogAdd, backlogList, backlogUpdate, getStatus, getConfig, getModels, checkModels, autoPopulate, logSession, logDecision, getLogs, requireRegistration, requireBinding, getProjectDocsFn, getProjectLocation, generateRecoveryDoc, writeStateEvent, buildProjectDocContext, initProjectDocs, setContext, clearContextFn, syncProject, generateStateFromEvents, snapshotState, tryFixDocsDrift, _resolveBacklogCandidates } from "./legacy-helpers.js";
import { initDb, getAllGlobalConfig, setGlobalConfig, getProjectConfig, setProjectConfig, listSessions, countSessions, listBacklogTasks, addBacklogTask, updateBacklogTask, listModels, countModels, addLog, addVerificationRun, getVerificationRun, updateVerificationRun, getDb, addWorker, updateWorker, deleteWorker, getWorker, getStalledTasksForWorker, addRoom, updateRoom, deleteRoom, addWorkerTaskHistory, deleteWorkerMessagesByWorker, deleteWorkerSessionsByWorker, deleteWorkerTaskHistoryByWorker, } from "./db.js";
// ProjectBacklogTask is now imported from legacy-helpers.ts
// ═══════════════════════════════════════════════════════════════
//  PLUGIN ENTRY
// ═══════════════════════════════════════════════════════════════
let maintenanceSvc = null;
// Proper tool metadata for agent session exposure (OpenClaw agent tool injection).
// ═══════════════════════════════════════════════════════════════
//  SHARED BACKLOG HELPERS — extracted to eliminate duplicate code
//  between backlog_dispatch and backlog_dispatch_all
// ═══════════════════════════════════════════════════════════════
// _parseTaskField + _resolveBacklogCandidates are now imported from legacy-helpers.ts
// _collectedToolMeta + _staticToolNames are now imported from plugin-state.ts
// _toolCount is now imported from plugin-state.ts (shared with legacy-helpers.ts)
const PLUGIN_ID = "genor-orchestrator-software-house";
const _plugin = definePluginEntry({
    id: PLUGIN_ID,
    name: "Genor Orchestrator Software House",
    description: "AI-powered software house with persistent worker sessions, task execution, and inter-worker collaboration. Requires OpenAI HTTP API endpoints enabled in OpenClaw config.",
    register(api) {
        const cfg = api.pluginConfig || {};
        const dataDir = getDataDir(cfg.orchestratorDataDir);
        const logLevel = cfg.logLevel || "info";
        const logRetention = cfg.logRetentionDays || 30;
        const logger = new OrchestratorLogger(dataDir, logLevel, logRetention);
        // ═══ Auto-configure LLM endpoint on install ═══
        // Default to the local OpenClaw gateway. The plugin user can override
        // any of these via plugin config:
        //   llmEndpoint       full chat completions URL
        //   llmAuthToken      bearer token (or read from OpenClaw gateway)
        //   llmDefaultModel   model field (agent target like "openclaw")
        //   llmMessageChannel synthetic ingress channel
        // The endpoint is fully generic — any OpenAI-compatible server with
        // tool call support works (OpenClaw, LM Studio, vLLM, OpenRouter, etc.).
        const openclawCfg = api.config || {};
        const gw = openclawCfg?.gateway || {};
        const gwPort = gw.port || 18789;
        const gwAuth = gw.auth || {};
        const gwToken = gwAuth.token || gwAuth.password || "";
        const llmEndpoint = cfg.llmEndpoint
            || process.env.LLM_ENDPOINT
            || `http://127.0.0.1:${gwPort}/v1/chat/completions`;
        const llmToken = cfg.llmAuthToken
            || process.env.LLM_AUTH_TOKEN
            || gwToken;
        const llmDefaultModel = cfg.llmDefaultModel
            || process.env.LLM_DEFAULT_MODEL
            || "openclaw";
        const llmMessageChannel = cfg.llmMessageChannel
            || process.env.LLM_MESSAGE_CHANNEL
            || "orchestrator-software-house";
        configureLLM({
            endpoint: llmEndpoint,
            token: llmToken,
            defaultModel: llmDefaultModel,
            defaultMessageChannel: llmMessageChannel,
            timeoutMs: 60_000,
        });
        logger.info("llm", `LLM endpoint configured: ${llmEndpoint} (model: ${llmDefaultModel})`);
        // ═══ Initialize SQLite database ═══
        // Replaces all ad-hoc JSON file I/O with a single orchestrator.db
        initDb(dataDir);
        logger.info("db", "SQLite database initialized");
        for (const sub of ["logs", "sessions", "adrs", "projects"]) {
            const p = path.join(dataDir, sub);
            if (!fs.existsSync(p)) {
                fs.mkdirSync(p, { recursive: true });
                logger.info("boot", `Created dir: ${sub}`);
            }
        }
        // ═══════════════════════════════════════════════════════════
        //  OPENAI ENDPOINT DETECTION & GATEWAY TOKEN ACCESS
        // ═══════════════════════════════════════════════════════════
        // Check if OpenAI HTTP API endpoint is enabled
        // Plugin requires this for worker session execution
        let gatewayToken = null;
        let openaiEndpointEnabled = false;
        // Try to detect if OpenAI endpoint is enabled (non-blocking)
        const gatewayUrl = "http://localhost:18789";
        fetch(`${gatewayUrl}/v1/models`, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
        })
            .then((healthResponse) => {
            if (healthResponse.ok) {
                openaiEndpointEnabled = true;
                logger.info("boot", "✅ OpenAI HTTP API endpoint detected");
            }
            else {
                logger.warn("boot", "⚠️  OpenAI HTTP API endpoint not responding");
            }
        })
            .catch(() => {
            logger.warn("boot", "⚠️  Could not detect OpenAI HTTP API endpoint");
        });
        // Get gateway token from environment (never copy to files)
        try {
            if (process.env.OPENCLAW_GATEWAY_TOKEN) {
                gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
                logger.info("boot", "✅ Gateway token loaded from environment");
            }
            else if (process.env.OPENCLAW_GATEWAY_PASSWORD) {
                gatewayToken = process.env.OPENCLAW_GATEWAY_PASSWORD;
                logger.info("boot", "✅ Gateway password loaded from environment");
            }
            else {
                logger.warn("boot", "⚠️  Gateway token not found in environment");
                logger.warn("boot", "   Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD");
            }
        }
        catch (e) {
            logger.warn("boot", `Gateway token access error: ${e.message}`);
        }
        // Log warnings if requirements not met
        if (!openaiEndpointEnabled) {
            logger.error("boot", "═══════════════════════════════════════════════════════════════");
            logger.error("boot", "⚠️  SOFTWARE HOUSE PLUGIN REQUIRES OPENAI ENDPOINTS");
            logger.error("boot", "═══════════════════════════════════════════════════════════════");
            logger.error("boot", "Enable in openclaw.json:");
            logger.error("boot", "");
            logger.error("boot", '{');
            logger.error("boot", '  "gateway": {');
            logger.error("boot", '    "http": {');
            logger.error("boot", '      "endpoints": {');
            logger.error("boot", '        "chatCompletions": { "enabled": true }');
            logger.error("boot", '      }');
            logger.error("boot", '    }');
            logger.error("boot", '  }');
            logger.error("boot", '}');
            logger.error("boot", "");
            logger.error("boot", "Then restart OpenClaw gateway.");
            logger.error("boot", "═══════════════════════════════════════════════════════════════");
        }
        if (!gatewayToken) {
            logger.error("boot", "═══════════════════════════════════════════════════════════════");
            logger.error("boot", "⚠️  GATEWAY TOKEN NOT FOUND");
            logger.error("boot", "═══════════════════════════════════════════════════════════════");
            logger.error("boot", "Worker execution requires gateway token.");
            logger.error("boot", "Set OPENCLAW_GATEWAY_TOKEN environment variable.");
            logger.error("boot", "═══════════════════════════════════════════════════════════════");
        }
        // Store for later use by worker engine
        global.__SOFTWARE_HOUSE_CONFIG__ = {
            gatewayToken,
            openaiEndpointEnabled,
            gatewayUrl: "http://localhost:18789",
        };
        // ═══════════════════════════════════════════════════════════
        //  BOOT MODEL SYNC
        // ═══════════════════════════════════════════════════════════
        // Auto-populate model inventory from gateway config on EVERY boot.
        // This keeps models.json in sync: new models are added, and models
        // removed from the gateway config are pruned (not preserved as orphans).
        //
        // Also runs first-run onboarding tasks on initial install.
        const firstRunMarker = path.join(dataDir, ".FIRST_RUN");
        // Auto-populate model inventory — runs every boot to stay in sync
        try {
            autoPopulate(dataDir, logger);
            logger.info("boot", "Models synced from gateway config");
        }
        catch (e) {
            logger.warn("boot", `Boot model sync skipped — ${e.message}`);
        }
        // ── First-run onboarding ──
        if (!fs.existsSync(firstRunMarker)) {
            logger.info("boot", "═══════════ First run detected — running onboarding... ═══════════");
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
                // Init DB global config defaults if empty
                const existingCfg = getAllGlobalConfig();
                if (!existingCfg.free_only_mode && !existingCfg.disabled_models) {
                    setGlobalConfig("free_only_mode", false);
                    setGlobalConfig("disabled_models", []);
                    setGlobalConfig("safeguards", {});
                    logger.info("boot", "First-run: DB global config initialized");
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
                            let sessCount = countSessions(e);
                            const loc = getProjectLocation(e, dataDir);
                            const repoNote = loc ? `**Location:** \`${loc}\`` : "*(not configured — run genorch_project_sync_files)";
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
                                "3. Call `genorch_session_register` to opt in",
                                "4. Call `genorch_session_start_work` to start work",
                                "5. Log sessions via `genorch_session_log`",
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
        logger.info("plugin", "Plugin loaded", { dataDir, logLevel, logRetention });
        // ═══════════════════════════════════════════════════════════
        //  HOOKS
        // ═══════════════════════════════════════════════════════════
        api.on("session_start", async (event) => {
            try {
                const sk = (event.sessionKey || "").toString();
                if (!sk)
                    return;
                // Adopt the real gateway key so genorch_session_register can find it
                if (sessionTracker.sessionKey !== sk) {
                    sessionTracker.start(sk, event.reason || "new");
                }
                // Auto-register so tools like genorch_session_start_work can work
                // without manually calling genorch_session_register first.
                // NOTE: Key is adopted but NOT auto-registered.
                // Registration is explicit — user must call genorch_session_register.
                logger.info("hooks", `session_start adopted key: ${sk} (reason: ${event.reason || ""})`);
            }
            catch (e) {
                logger.warn("hooks", `session_start error: ${e.message}`);
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
                    sessionTracker.setStatus("done");
                    sessionTracker.trackAction("session_ending");
                    queueLiveAgents("session_end", sessionTracker);
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
                        status: event.reason === "shutdown" ? "interrupted" : event.reason === "error" ? "failed" : "done",
                        duration: info.duration,
                        start_time: new Date(sessionTracker.sessionStartTimestamp).toISOString(),
                        end_time: new Date().toISOString(),
                        session_key: sk_end || sessionTracker.sessionKey || "",
                        parent_session_key: isSubagent && subInfo ? subInfo.parentKey || null : (sk_end && sk_end !== sessionTracker.sessionKey ? sessionTracker.sessionKey || null : null),
                        goal: info.task,
                        action_history: sessionTracker.actionHistory.slice(-20),
                        touched_files: sessionTracker.touchedFiles.slice(-20),
                        token_usage: sessionTracker.tokenUsage,
                        workflow: sessionTracker.workflow.toJSON(),
                        qa_status: sessionTracker.qaStatus,
                        qa_history: sessionTracker.qaHistory,
                        qa_findings: sessionTracker.qaFindings,
                        error_count: sessionTracker.errorCount,
                        last_error: sessionTracker.lastError,
                        last_activity_at: new Date(sessionTracker.lastActivityTimestamp).toISOString(),
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
                    queueLiveAgents("session_complete", sessionTracker);
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
            sessionTracker.setStatus("running");
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
            queueLiveAgents("subagent_spawned", sessionTracker);
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
                queueLiveAgents("subagent_ended", sessionTracker);
            }
        });
        // ═══ Model routing resolution — merges project overrides with global defaults ═══
        function getEffectiveChain(project, category) {
            try {
                // 1. Project-specific routing takes priority
                if (project) {
                    const pc = getProjectConfig(project);
                    if (pc?.model_routing?.[category]?.length) {
                        return pc.model_routing[category];
                    }
                }
                // 2. Fall back to global default routing
                const globalCfg = getAllGlobalConfig();
                const globalRouting = globalCfg?.default_model_routing || {};
                if (globalRouting[category]?.length) {
                    return globalRouting[category];
                }
            }
            catch (e) {
                logger.warn("routing", `getEffectiveChain error: ${e.message}`);
            }
            return null;
        }
        api.on("before_model_resolve", async (event, hookCtx) => {
            try {
                const ctxSessionKey = hookCtx?.sessionKey || "";
                if (!ctxSessionKey)
                    return;
                // ═══════════════════════════════════════════════════════════
                //  STEP 1: KEY ADOPTION (resolves chicken-and-egg)
                //  MUST run before the registration check so that
                //  genorch_session_register sees a non-null session key.
                // ═══════════════════════════════════════════════════════════
                const isBackground = ctxSessionKey.includes("dreaming") || ctxSessionKey.includes(":cron:") || ctxSessionKey.includes(":acp:");
                if (!isBackground) {
                    // ── Adopt the real gateway key (NO auto-registration) ──
                    // Key adoption is safe singleton set-once from null logic.
                    // Registration is EXPLICIT — user must call genorch_session_register.
                    if (sessionTracker.sessionKey !== ctxSessionKey) {
                        sessionTracker.start(ctxSessionKey, "resumed");
                    }
                    logger.info("hooks", "before_model_resolve: active key=" + ctxSessionKey);
                }
                // ═══════════════════════════════════════════════════════════
                //  STEP 2: SUBAGENT SESSION SETUP
                //  If this is a subagent spawned by a registered parent, adopt
                //  its key, register it, and inherit the parent's project context.
                // ═══════════════════════════════════════════════════════════
                if (ctxSessionKey.includes(":subagent:")) {
                    const subInfo = sessionTracker.getSubagent(ctxSessionKey);
                    if (subInfo && subInfo.parentKey && sessionTracker.isSessionRegistered(subInfo.parentKey)) {
                        if (!sessionTracker.isSessionRegistered(ctxSessionKey)) {
                            sessionTracker.start(ctxSessionKey, "subagent");
                            sessionTracker.registerSession(ctxSessionKey);
                            if (subInfo.project) {
                                sessionTracker.setContext(subInfo.project, subInfo.task || "");
                            }
                            logger.info("hooks", `Subagent auto-registered: ${ctxSessionKey} (parent: ${subInfo.parentKey})`);
                        }
                    }
                }
                // ═══════════════════════════════════════════════════════════
                //  STEP 3: STATUS UPDATE
                // ═══════════════════════════════════════════════════════════
                sessionTracker.setStatus("running");
                sessionTracker.trackAction("resolving_model");
                queueLiveAgents("before_model_resolve", sessionTracker);
                // ═══════════════════════════════════════════════════════════
                //  STEP 4: MODEL ROUTING (only for registered sessions)
                // ═══════════════════════════════════════════════════════════
                if (!sessionTracker.isSessionRegistered(ctxSessionKey))
                    return;
                if (!sessionTracker.currentProject)
                    return;
                const allModels = listModels(false);
                const cfg2 = getAllGlobalConfig();
                const pc = sessionTracker.currentProject ? getProjectConfig(sessionTracker.currentProject) : null;
                // ── Resolve routing preset ──
                const routingPreset = pc?.routing_preset || "custom";
                // Preset: "no-steering" — skip entirely, let OpenClaw's default resolution run
                if (routingPreset === "no-steering") {
                    logger.debug("routing", `no-steering preset for ${sessionTracker.currentProject} — skipping model override`);
                    sessionTracker.trackModel(event?.resolvedModel || "default", "default");
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
                // Determine the task category — explicit Task Type: line takes priority, else infer
                const ctx2 = sessionTracker.getSessionContext(ctxSessionKey);
                const taskStr = ctx2?.task || "";
                const taskLower = taskStr.toLowerCase();
                const typeMatch = taskLower.match(/task\s*type:\s*(\w+)/);
                let taskCategory = "coding"; // default
                if (typeMatch && ["coding", "fixing", "research", "qa", "documentation", "test"].includes(typeMatch[1])) {
                    taskCategory = typeMatch[1];
                }
                else if (taskLower.includes("fix") || taskLower.includes("bug") || taskLower.includes("error") || taskLower.includes("broken"))
                    taskCategory = "fixing";
                else if (taskLower.includes("research") || taskLower.includes("investigat") || taskLower.includes("explore") || taskLower.includes("learn") || taskLower.includes("find out"))
                    taskCategory = "research";
                else if (taskLower.includes("q&a") || taskLower.includes("question") || taskLower.includes("answer") || taskLower.includes("what is") || taskLower.includes("how do"))
                    taskCategory = "qa";
                else if (taskLower.includes("doc") || taskLower.includes("readme") || taskLower.includes("adr") || taskLower.includes("manual") || taskLower.includes("write up"))
                    taskCategory = "documentation";
                else if (taskLower.includes("test") || taskLower.includes("spec") || taskLower.includes("unit") || taskLower.includes("e2e"))
                    taskCategory = "test";
                // Merge project overrides + global defaults
                const chain = getEffectiveChain(sessionTracker.currentProject, taskCategory);
                // Also pass explicitly-set model_routing for per-project filtering below
                const modelRouting = pc?.model_routing || {};
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
                        sessionTracker.trackModel(selected.id, selected.provider);
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
                // ── Fallback: first-eligible model selection ──
                if (eligible.length > 0) {
                    const best = eligible
                        .filter(m => m.agent_ready !== false && m.status === "active")[0];
                    if (best) {
                        sessionTracker.trackModel(best.id, best.provider);
                        logger.info("routing", `[tier-fallback] Routed ${sessionTracker.currentProject} → ${best.id}`);
                        return { modelOverride: best.id };
                    }
                }
                // ── Last resort: track whatever OpenClaw resolved ──
                if (event?.resolvedModel) {
                    const resolvedInfo = allModels.find((m) => m.id === event.resolvedModel);
                    sessionTracker.trackModel(event.resolvedModel, resolvedInfo?.provider);
                    logger.info("routing", `[pass-through] No eligible models for ${sessionTracker.currentProject}, using resolved: ${event.resolvedModel}`);
                }
            }
            catch (err) {
                logger.error("hooks", `before_model_resolve error: ${err.message}`);
            }
        });
        api.on("before_prompt_build", async (event, hookCtx) => {
            try {
                // ═══ SESSION ISOLATION: Use hook context key, NOT tracker singleton ═══
                // sessionTracker.sessionKey is shared across all sessions and may have
                // been set by a different session's hooks. Always use hookCtx.sessionKey.
                const hk = hookCtx?.sessionKey || "";
                sessionTracker.setStatus("running");
                sessionTracker.trackAction("building_prompt");
                queueLiveAgents("before_prompt_build", sessionTracker);
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
                // Safe key adoption: if the tracker has no session key yet (null),
                // adopt the hook context key. Once set, never overwrite — prevents
                // cross-session pollution where Session B's key would replace
                // Session A's established key.
                if (!sessionTracker.sessionKey) {
                    sessionTracker.start(hk, "resumed");
                    logger.info("hooks", `before_prompt_build adopted orphan session key: ${hk}`);
                }
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
                ctx += `**Workflow phases** (advance in order via \`genorch_workflow_advance_phase\`):
   analyze → plan → document → work → log → finish
`;
                ctx += `**Enforced gates** (code blocks these if violated):
• Must call \`genorch_session_register\` → \`genorch_project_bind\` → \`genorch_session_start_work\` in order
• work→log: BLOCKED until QA approves (run \`genorch_qa_submit\` → \`genorch_qa_approve\`)\n• log→finish: BLOCKED until \`genorch_session_log\` AND \`genorch_handoff_create\` complete
`;
                ctx += `**Model routing**: Orchestrator auto-selects the best model per task category.
  Use \`genorch_models_recommend\` to see recommendations. Don't override unless necessary.
`;
                ctx += `**Phase tools**:
  • Analyze: study context, output findings
  • Plan: create step-by-step plan, ADR (\`genorch_adr_log\`)
  • Document: \`genorch_adr_log\` for architecture decisions
  • Work: implement, then submit QA if enabled
  • Log: \`genorch_session_log\` with status=complete
  • Finish: \`genorch_handoff_create\` before advancing

`;
                let pcl = `⚡ Project: ${pc.project}`;
                if (pc.task)
                    pcl += ` | Task: ${pc.task}`;
                pcl += `\nLocation: ${loc || "not set"}`;
                pcl += ` | Sub-agents: ${sessionTracker.subagentDepth}`;
                pcl += ` | Data: orchestrator-data/projects/${pc.project}/`;
                ctx += pcl;
                // ═══ PROJECT DOCS INJECTION (style rules, code rules, feature map, structure) ═══
                // Auto-inject project-specific rules and context to minimize LLM mental drift.
                // Reads STYLE_GUIDE.md, ARCHITECTURE.md, FEATURES.md, PROJECT_PLAN.md, BUGS.md
                // from the project directory and prepends them to the prompt.
                const projectDocCtx = buildProjectDocContext(dataDir, pc.project);
                if (projectDocCtx) {
                    ctx += "\n\n" + projectDocCtx;
                }
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
                        analyze: "🔍 PHASE: ANALYZE — Study the request and project context. Output findings, questions, and scope. Do NOT write code yet. Call genorch_workflow_advance_phase when analysis is complete.",
                        plan: "📋 PHASE: PLAN — Create a step-by-step plan. List files to change, approach, risks, and dependencies. Do NOT code yet. Call genorch_workflow_advance_phase when plan is approved.",
                        document: "📝 PHASE: DOCUMENT — Write an ADR (genorch_adr_log) or design doc covering the architecture, trade-offs, and key decisions. Call genorch_workflow_advance_phase when design is documented.",
                        work: `⚡ PHASE: IMPLEMENT — Execute the plan. Write code. Make changes.${sessionTracker.workflow.includeQa ? " After implementation, submit for QA review with genorch_qa_submit (enforced: auto-spawns an independent QA review subagent). The work→log transition is BLOCKED until QA approves." : ""} Call genorch_workflow_advance_phase when implementation is complete.`,
                        log: "📊 PHASE: LOG — Log the session via genorch_session_log with status=complete. Include a summary of what was done, decisions made, and next steps. After logging, generate a handoff document with genorch_handoff_create (REQUIRED before finish). Then call genorch_workflow_advance_phase. (Docs are auto-synced when advancing to finish.)",
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
                        ctx += `\n📄 Handoff: ❌ Not generated — run genorch_handoff_create`;
                    }
                }
                return { prependContext: ctx };
            }
            catch (e) {
                logger.warn("context", "before_prompt_build failed:", e.message);
            }
        });
        api.on("agent_end", async () => {
            sessionTracker.trackAction("agent_stopped");
            queueLiveAgents("agent_end", sessionTracker);
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
            sessionTracker.setStatus("done");
            maintenanceSvc?.stop();
            logger.stop();
        });
        // ═══════════════════════════════════════════════════════════
        //  TOOLS
        // ═══════════════════════════════════════════════════════════
        // ── Workflow helpers (extracted to eliminate advance_phase duplication) ──
        const _checkQaGate = () => {
            if (!sessionTracker.workflow.includeQa)
                return null;
            if (sessionTracker.canAdvanceFromWork())
                return null;
            const qs = sessionTracker.qaStatus;
            if (qs === "none")
                return "QA review required before advancing. Run genorch_qa_submit with your findings first.";
            if (qs === "pending")
                return "QA review is pending approval. A reviewer must call genorch_qa_approve or genorch_qa_reject.";
            if (qs === "rejected")
                return "QA review rejected the previous submission. Fix the reported issues and call genorch_qa_submit again.";
            return "QA gate not passed. Submit findings with genorch_qa_submit.";
        };
        const _checkHandoffGate = () => {
            if (!sessionTracker.canFinish())
                return "Handoff document required before finishing. Run genorch_handoff_create to create one.";
            if (!sessionTracker.loggedTaskCompletion)
                return "Task must be explicitly logged before finishing. Call genorch_session_log with status=complete first.";
            return null;
        };
        const _checkGitStatus = () => {
            const project = sessionTracker.currentProject;
            if (!project)
                return;
            const loc = getProjectLocation(project, dataDir);
            if (!loc || !fs.existsSync(path.join(loc, ".git")))
                return;
            try {
                const statusRaw = execSync("git status --porcelain", { cwd: loc, encoding: "utf-8", timeout: 5000 });
                const changed = statusRaw.trim().split("\n").filter(Boolean);
                if (changed.length > 0)
                    logger.warn("workflow", `${changed.length} uncommitted file(s) before logging phase. Consider committing or stashing first.`);
            }
            catch { /* git check non-fatal */ }
        };
        const _checkAdrPresence = () => {
            const project = sessionTracker.currentProject;
            if (!project)
                return;
            const adrsDir = path.join(dataDir, "adrs");
            let adrCount = 0;
            if (fs.existsSync(adrsDir)) {
                adrCount = fs.readdirSync(adrsDir).filter((f) => f.endsWith(".md") && f.includes(project.replace(/[^a-zA-Z0-9_-]/g, "-"))).length;
            }
            if (adrCount === 0) {
                const projAdrsDir2 = path.join(projDir(project, dataDir), "adrs");
                if (fs.existsSync(projAdrsDir2)) {
                    adrCount = fs.readdirSync(projAdrsDir2).filter((f) => f.endsWith(".md")).length;
                }
            }
            if (adrCount === 0)
                logger.warn("workflow", "No ADR found. Consider documenting decisions with genorch_adr_log before implementing.");
        };
        // ── Wrap api.registerTool to auto-collect metadata ──
        // This eliminates TOOL_METADATA duplication (single source of truth).
        const _origRegister = api.registerTool.bind(api);
        api.registerTool = ((meta) => {
            _collectedToolMeta.push({
                name: meta.name,
                label: meta.label,
                description: meta.description,
                parameters: JSON.parse(JSON.stringify(meta.parameters)),
            });
            incrementToolCount();
            return _origRegister(meta);
        });
        api.registerTool({
            name: "genorch_session_start_work",
            label: "Orchestrator Start Work",
            description: "Start working on a specific task in the bound project. Requires prior genorch_project_bind. Sets task context enabling auto-routing, auto-logging, and project context injection.",
            parameters: Type.Object({
                task: Type.String({ description: "Describe the task concisely. Format:\n• What needs to be done\n• Why (context / motivation)\n• Scope (what files/systems are involved)" }),
                task_type: Type.Optional(Type.Enum({ coding: "coding", fixing: "fixing", research: "research", qa: "qa", documentation: "documentation", test: "test" }, { description: "Task category for model routing. If omitted, inferred from task text." })),
                original_prompt: Type.Optional(Type.String({ description: "OPTIONAL: The original user request, verbatim. Truncated to 500 chars." })),
            }),
            async execute(_id, _params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                const bind = requireBinding();
                if (bind)
                    return txt({ ok: false, error: bind });
                const params = _params;
                const project = sessionTracker.currentProject;
                try {
                    return txt(setContext(dataDir, project, params.task, logger, params.original_prompt));
                }
                catch (err) {
                    return txt({ ok: false, error: err.message });
                }
            },
        });
        api.registerTool({
            name: "genorch_session_clear_work",
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
            name: "genorch_session_register",
            label: "Orchestrator Register",
            description: "Register this session for orchestrator tracking. Must be called BEFORE genorch_session_start_work. Once registered, the orchestrator tracks the session lifecycle (start → context → work → end) and injects project context into prompts. Only call this when you intend to do project work in this session.",
            parameters: Type.Object({}),
            async execute(_id, _params) {
                // The session key MUST be the real OpenClaw gateway session key.
                // It is populated by the session_start and before_prompt_build
                // hooks from the real event/hook context. NO synthetic keys.
                const sk = sessionTracker.sessionKey;
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
                    queueLiveAgents("register", sessionTracker);
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
                // Already registered (auto-registration handles this)
                return txt({
                    ok: true,
                    message: "already_registered",
                    session_key: sk,
                    note: "Session is auto-registered. Call genorch_session_start_work to bind to a project.",
                });
            },
        });
        api.registerTool({
            name: "genorch_session_unregister",
            label: "Orchestrator Unregister",
            description: "Unregister this session from orchestrator tracking. Clears project context and stops all tracking. The session will no longer receive project context injection. Call this when project work is complete or the session should no longer be tracked.",
            parameters: Type.Object({}),
            async execute(_id, _params) {
                const sk = sessionTracker.sessionKey;
                if (!sk)
                    return txt("error: no session key available");
                // ═══ ENFORCE TASK COMPLETION LOGGING ═══
                if (sessionTracker.currentProject && !sessionTracker.loggedTaskCompletion) {
                    return txt({
                        ok: false,
                        error: `❌ Task not logged. Session has active context on project "${sessionTracker.currentProject}" ` +
                            `but hasn't logged completion. Call genorch_session_log with status="done" first ` +
                            `to document what was done before unregistering.`,
                    });
                }
                sessionTracker.unregisterSession(sk);
                sessionTracker.clearContext();
                sessionTracker.trackAction("session_unregistered");
                queueLiveAgents("unregister", sessionTracker);
                logger.info("hooks", `session unregistered: ${sk}`);
                return txt("unregistered");
            },
        });
        api.registerTool({
            name: "genorch_status",
            label: "Status",
            description: "Get quick orchestration status: model counts, session count, project list, free-only mode state.",
            parameters: Type.Object({}),
            async execute() {
                return txt(getStatus(dataDir, logger));
            },
        });
        api.registerTool({
            name: "genorch_config_show_routing",
            label: "Config",
            description: "Read the full routing configuration: free-only mode, disabled models, per-project allowlists.",
            parameters: Type.Object({}),
            async execute() {
                return txt(getConfig(dataDir, logger));
            },
        });
        api.registerTool({
            name: "genorch_models_list",
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
            name: "genorch_models_check_routing",
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
            name: "genorch_models_auto_discover",
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
            name: "genorch_session_log",
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
                queueLiveAgents("tool_log_session", sessionTracker);
                // Mark completion logged so clearContext/unregister know work is documented
                const terminal = ["done", "complete", "blocked", "failed", "interrupted"].includes((params.status || "").toLowerCase());
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
            name: "genorch_adr_log",
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
            name: "genorch_logs_query",
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
            name: "genorch_project_sync_files",
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
                queueLiveAgents("tool_sync_project", sessionTracker);
                return txt(syncProject(dataDir, params.project, logger));
            },
        });
        api.registerTool({
            name: "genorch_project_docs_list",
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
            name: "genorch_workflow_advance_phase",
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
                const target = params.phase?.toLowerCase();
                if (target) {
                    // Validate transition direction
                    if (!wf.canTransitionTo(target)) {
                        return txt({ ok: false, error: `Cannot transition to '${params.phase}' from current phase '${currentPhase}'. Workflow must go forward: ${WORKFLOW_ORDER.join(" → ")}` });
                    }
                    // ═══ ENFORCED GATES ═══
                    if (currentPhase === "work" && target === "log") {
                        const qaErr = _checkQaGate();
                        if (qaErr)
                            return txt({ ok: false, error: qaErr, qa_required: true });
                    }
                    if (currentPhase === "log" && target === "finish") {
                        const hfErr = _checkHandoffGate();
                        if (hfErr)
                            return txt({ ok: false, error: hfErr, handoff_required: true, log_required: !sessionTracker.loggedTaskCompletion });
                        tryFixDocsDrift(sessionTracker.currentProject, dataDir, logger);
                    }
                    // ═══ SOFT WARNINGS ═══
                    if (currentPhase === "work" && target === "log")
                        _checkGitStatus();
                    if (currentPhase === "document" && target === "work")
                        _checkAdrPresence();
                    wf.completePhase(currentPhase, params.skip);
                    wf.enterPhase(target);
                }
                else {
                    // Auto-advance with quality gates
                    if (currentPhase === "work" && wf.includeQa) {
                        const qaErr = _checkQaGate();
                        if (qaErr)
                            return txt({ ok: false, error: `QA review required. ${sessionTracker.getQaSummary()}`, qa_required: true, qa_status: sessionTracker.qaStatus });
                    }
                    if (currentPhase === "log") {
                        if (!sessionTracker.loggedTaskCompletion)
                            return txt({ ok: false, error: "Task must be logged before finishing. Call genorch_session_log with status=complete.", log_required: true });
                        if (!sessionTracker.canFinish())
                            return txt({ ok: false, error: "Handoff document required before finishing. Run genorch_handoff_create.", handoff_required: true });
                        tryFixDocsDrift(sessionTracker.currentProject, dataDir, logger);
                    }
                    // Soft warnings
                    if (currentPhase === "document")
                        _checkAdrPresence();
                    if (currentPhase === "work")
                        _checkGitStatus();
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
                queueLiveAgents("workflow_advance", sessionTracker);
                logger.info("workflow", `Phase advanced: ${wf.currentPhase} (${wf.getProgress()})`);
                return txt({ ok: true, phase: wf.currentPhase, progress: wf.getProgress(), elapsed: wf.getPhaseElapsed(), phase_history: wf.phaseHistory });
            },
        });
        // ═══════════════════════════════════════════════════════════
        //  BACKLOG TOOLS
        // ═══════════════════════════════════════════════════════════
        api.registerTool({
            name: "genorch_backlog_add",
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
            name: "genorch_backlog_list",
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
            name: "genorch_backlog_update",
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
            name: "genorch_models_recommend",
            label: "Get Model Routing",
            description: "Get the recommended model for a task category (coding, fixing, research, q&a, documentation). Returns the ordered model list and best available model for the given project and category.",
            parameters: Type.Object({
                category: Type.String({ description: "Task category: coding, fixing, research, q&a, documentation" }),
                project: Type.Optional(Type.String({ description: "Project name. Omit to use current project context." })),
            }),
            async execute(_id, params) {
                const proj = params.project || sessionTracker.currentProject;
                if (!proj) {
                    return txt({ ok: false, error: "No project specified and no project context set. Use genorch_session_start_work first or pass a project name." });
                }
                const pc = getProjectConfig(proj);
                if (!pc) {
                    return txt({ ok: false, error: `Project '${proj}' not found.` });
                }
                // Load model inventory for quality data
                const allModels = listModels(false);
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
                        .filter(m => !isPaid(m) && m.agent_ready !== false && m.status === "active");
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
                            context: m.context_window || 0,
                            cost_type: m.cost_type || null,
                        })),
                    });
                }
                // ── Preset: single-provider ──
                if (preset === "single-provider" && singleProvider) {
                    const provModels = allModels
                        .filter(m => m.provider === singleProvider && m.agent_ready !== false && m.status === "active");
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
                const enriched = models.map((id) => {
                    const found = allModels.find((m) => m.id === id);
                    return found ? {
                        id: found.id,
                        provider: found.provider,
                        context: found.context_window || 0,
                        status: found.status || "unknown",
                        agent_ready: found.agent_ready !== false,
                    } : { id, provider: "?", context: 0, status: "unknown", agent_ready: false };
                });
                const available = enriched.filter((m) => m.status === "active" && m.agent_ready);
                const blocked = enriched.filter((m) => m.status !== "active" || !m.agent_ready);
                return txt({
                    ok: true,
                    project: proj,
                    category: cat,
                    preset,
                    routing_preset: preset,
                    recommended: available[0]?.id || enriched[0]?.id || models[0],
                    fallbacks: available.slice(1).map((m) => m.id),
                    blocked_chain: blocked.length > 0 ? blocked.map((m) => m.id) : undefined,
                    all: models,
                    model_quality: enriched,
                    source: "dashboard-config.json projects." + proj + ".model_routing",
                });
            },
        });
        api.registerTool({
            name: "genorch_session_list",
            label: "Get Registered Sessions",
            description: "List all currently registered orchestrator sessions with their project context, status, and activity. Only sessions that explicitly called genorch_session_register are tracked.",
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
            name: "genorch_system_diagnose",
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
                        addIssue("No session key set. before_prompt_build or session_start hooks have not populated one yet.");
                    }
                    else {
                        if (!sessionTracker.isSessionRegistered(hk)) {
                            addIssue("Session key " + hk + " is not registered. Call genorch_session_register.");
                            if (autoFix) {
                                sessionTracker.registerSession(hk);
                                addFix("Registered session: " + hk);
                            }
                        }
                    }
                    // Synthetic keys no longer exist. We use real OpenClaw session IDs 1:1.
                    const allRegSessions = sessionTracker.getRegisteredSessions();
                    if (allRegSessions.length === 0) {
                        addIssue("No sessions registered. Use genorch_session_register.");
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
                        addIssue("No project context set. Use genorch_session_start_work to activate a project.");
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
                    const mc = countModels();
                    if (mc.total === 0)
                        addIssue("Model inventory is empty. Run genorch_models_auto_discover.");
                    else if (mc.active === 0)
                        addIssue("Model inventory has 0 active models. Run genorch_models_auto_discover.");
                    // Check DB has global config
                    const dbCfg = getAllGlobalConfig();
                    if (!dbCfg || (!dbCfg.free_only_mode && !(dbCfg.disabled_models?.length))) {
                        addIssue("Global config not initialized in DB.");
                    }
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
                    const livePath = path.join(dataDir, "live-agents.json");
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
                            // Check if project has any sessions via DB
                            const projectSessions = listSessions(e);
                            const sessCount = projectSessions.length;
                            // Check required docs
                            const missingDocs = REQUIRED_PROJECT_DOCS.filter(doc => !fs.existsSync(path.join(pp, doc)));
                            // Check for stale sessions (running entries older than 24h)
                            let staleSessions = 0;
                            if (sessCount > 0) {
                                staleSessions = projectSessions.filter((s) => s.status === "running" && s.start_ts &&
                                    (Date.now() - s.start_ts) > 86400000).length;
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
                                            `_(Auto-generated by genorch_system_diagnose. Update this file as the project evolves to keep docs in sync with reality.)_`,
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
            name: "genorch_project_leave",
            label: "Orchestrator Release Project",
            description: "Release the current session's project binding so it can work on a different project. Use when you're done with the current project.",
            parameters: Type.Object({
                force: Type.Optional(Type.Boolean({ description: "Force release (default: false)" })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                const sk = sessionTracker.sessionKey;
                const bound = sk ? sessionTracker.getBoundProject(sk) : null;
                if (!bound)
                    return txt({ ok: false, error: "No project binding to release." });
                // ═══ ENFORCE TASK COMPLETION LOGGING ═══
                if (!sessionTracker.loggedTaskCompletion && !params.force) {
                    return txt({
                        ok: false,
                        error: `❌ Task not logged. Session is bound to project "${bound}" but hasn't logged completion. ` +
                            `Call genorch_session_log with status="done" first to document what was done ` +
                            `before releasing the binding. Use force=true to override this check.`,
                    });
                }
                const released = sessionTracker.releaseProjectBinding(sk ?? undefined);
                sessionTracker.trackAction(`released_project: ${released}`);
                queueLiveAgents("release_project", sessionTracker);
                logger.info("sessions", `Released project binding: ${released} (session=${sk})`);
                return txt({
                    ok: true,
                    released_project: released,
                    message: `Released from project "${released}". You can now set context to a different project.`,
                });
            },
        });
        api.registerTool({
            name: "genorch_project_list_active",
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
                        let sessCount = 0;
                        try {
                            sessCount = countSessions(e);
                        }
                        catch { /* non-critical — project may have no sessions */ }
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
            name: "genorch_project_join",
            label: "Orchestrator Join Project",
            description: "Register session + bind to project + set task in one step. Convenience for new/ad-hoc sessions. Internally calls genorch_session_register + genorch_project_bind + genorch_session_start_work.",
            parameters: Type.Object({
                project: Type.String({ description: "Project name. Use genorch_project_list_active first." }),
                task: Type.String({ description: "Task description for what you're joining to do." }),
            }),
            async execute(_id, params) {
                const sk = sessionTracker.sessionKey;
                if (!sk)
                    return txt({ ok: false, error: "No session key available." });
                sessionTracker.registerSession(sk);
                if (!sessionTracker.sessionKey)
                    sessionTracker.sessionKey = sk;
                if (!sessionTracker.currentProject) {
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
                // Already bound: just set task
                return txt(setContext(dataDir, sessionTracker.currentProject, params.task, logger));
            },
        });
        api.registerTool({
            name: "genorch_project_bind",
            label: "Orchestrator Bind Project",
            description: "Bind this session to a project. Loads project context (README, architecture, style guides, plan) for injection into prompts. Use BEFORE genorch_session_start_work. The LLM will receive full project knowledge on the next turn.",
            parameters: Type.Object({
                project: Type.String({ description: "Project name (e.g., kfinance, kotw). Use genorch_project_list_active to see available projects." }),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                try {
                    const result = setContext(dataDir, params.project, "", logger);
                    logger.info("sessions", `Session bound to project: ${params.project} (session=${sessionTracker.sessionKey})`);
                    return txt({
                        ok: true,
                        bound_project: params.project,
                        message: `Bound to project "${params.project}". Project context will be injected on next prompt. Call genorch_session_start_work to begin a task.`,
                        details: result,
                    });
                }
                catch (err) {
                    return txt({ ok: false, error: `Failed to bind project "${params.project}": ${err.message}` });
                }
            },
        });
        api.registerTool({
            name: "genorch_task_delegate",
            label: "Orchestrator Spawn Subagent",
            description: "Spawn a subagent using orchestrator-managed project context, with model routing and auto-logging. Logged as subagent session under current project. Returns session key for tracking.",
            parameters: Type.Object({
                task: Type.String({ description: "Task description for the subagent." }),
                task_type: Type.Optional(Type.Union([
                    Type.Literal("coding"),
                    Type.Literal("fixing"),
                    Type.Literal("research"),
                    Type.Literal("qa"),
                    Type.Literal("documentation"),
                    Type.Literal("test"),
                ], { description: "Task category for model routing. Required when model is not specified — auto-selects from project routing config." })),
                model: Type.Optional(Type.String({ description: "Optional model override. Omit to use project routing rules (requires task_type or auto-inferred from task text)." })),
                taskName: Type.Optional(Type.String({ description: "Optional stable name for subagent (lowercase with underscores/hyphens)." })),
                timeoutSeconds: Type.Optional(Type.Number({ description: "Optional timeout in seconds (default: 300, max: 1800)." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: "Session not registered. Call genorch_session_register or genorch_project_join first." });
                if (!sessionTracker.currentProject) {
                    return txt({ ok: false, error: "No active project. Set project context first with genorch_session_start_work or genorch_project_join." });
                }
                const project = sessionTracker.currentProject;
                const task = params.task;
                const taskType = params.task_type;
                let model = params.model || sessionTracker.currentModel || undefined;
                const taskName = params.taskName || `sub-${project}-${Date.now().toString(36)}`;
                const timeoutSeconds = Math.min(params.timeoutSeconds || 300, 1800);
                // Auto-resolve model using effective routing (project override + global fallback)
                if (!model && taskType) {
                    try {
                        // Helper to get effective chain (same logic as getEffectiveChain in before_model_resolve)
                        function getChain(proj, cat) {
                            const pc2 = getProjectConfig(proj);
                            if (pc2?.model_routing?.[cat]?.length)
                                return pc2.model_routing[cat];
                            const gc = getAllGlobalConfig();
                            const gr = gc?.default_model_routing || {};
                            if (gr[cat]?.length)
                                return gr[cat];
                            return null;
                        }
                        const chain = getChain(project, taskType);
                        if (chain && chain.length > 0) {
                            const allModels = listModels();
                            for (const chainId of chain) {
                                const found = allModels.find(m => m.id === chainId && m.status === "active" && m.agent_ready !== false);
                                if (found) {
                                    model = found.id;
                                    logger.info("routing", `Auto-routed ${project}/${taskType} → ${found.id}`);
                                    break;
                                }
                            }
                            if (!model)
                                logger.warn("routing", `Chain for ${project}/${taskType} all inactive — spawning without explicit model`);
                        }
                        else {
                            logger.warn("routing", `No routing chain for ${project}/${taskType} — spawning without explicit model`);
                        }
                    }
                    catch (e) {
                        logger.error("routing", `Auto-route error: ${e.message}`);
                    }
                }
                // Log the subagent spawn
                sessionTracker.trackSubagent(`pending-${taskName}`, {
                    parentKey: sessionTracker.sessionKey || "unknown",
                    project,
                    task,
                    startedAt: new Date().toISOString(),
                });
                sessionTracker.trackAction(`spawn_subagent: ${taskName}`);
                queueLiveAgents("spawn_subagent", sessionTracker);
                // Build the spawn message with full context
                const spawnTask = [
                    `[Subagent Task - Spawned by Orchestrator Plugin]`,
                    `Project: ${project}`,
                    `Parent Session: ${sessionTracker.sessionKey || "unknown"}`,
                    `Task: ${task}`,
                    taskType ? `Task Type: ${taskType}` : "",
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
                        message: `Subagent "${taskName}" spawned successfully (runId: ${spawnResult.runId}). Use genorch_task_delegate to track completion.`,
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
            name: "genorch_backlog_dispatch",
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
                    return txt({ ok: false, error: "No project selected. Set context via genorch_session_start_work or pass project param." });
                const tasks = listBacklogTasks(project);
                // Specific-task mode — filter early before shared resolution
                let taskIdCandidates = tasks;
                if (params.task_id) {
                    taskIdCandidates = tasks.filter((t) => t.id === params.task_id);
                    if (!taskIdCandidates.length)
                        return txt({ ok: false, error: `Task "${params.task_id}" not found or unavailable.` });
                }
                const maxD = Math.max(1, Math.min(params.max_dispatch || 1, 10));
                const { candidates, selected, dispatchList } = _resolveBacklogCandidates(project, taskIdCandidates, params.filter_labels, maxD);
                if (!candidates.length)
                    return txt({ ok: false, error: "No available tasks to dispatch (dependencies unresolved or backlog empty)." });
                // Auto-claim selected tasks
                if (params.auto_claim) {
                    const claimedIds = selected.map((t) => { updateBacklogTask(t.id, { status: "in_progress" }); return t.id; });
                    logger.info("dispatch", `Claimed ${claimedIds.length} tasks: ${claimedIds.join(", ")}`);
                }
                const loc = getProjectLocation(project, dataDir);
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
                    const taskLabels = typeof task.labels === "string" ? (() => { try {
                        return JSON.parse(task.labels);
                    }
                    catch {
                        return [];
                    } })() : (task.labels || []);
                    const taskDeps = typeof task.depends_on === "string" ? (() => { try {
                        return JSON.parse(task.depends_on);
                    }
                    catch {
                        return [];
                    } })() : (task.depends_on || []);
                    const labels = taskLabels.join(", ");
                    const deps = taskDeps.map((d) => {
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
                        spawn_instructions: dispatchList[0].spawn + `\n\n📋 Use genorch_task_delegate or sessions_spawn to dispatch this task.`,
                    });
                }
                return txt(result);
            },
        });
        // ═══════════════════════════════════════════════════════════
        //  NEW TOOL — Backlog Dispatch All (Phase 2c: Parallel dispatch)
        // ═══════════════════════════════════════════════════════════
        api.registerTool({
            name: "genorch_backlog_dispatch_all",
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
                const tasks = listBacklogTasks(project);
                const maxD = Math.max(1, Math.min(params.max_dispatch || 5, 20));
                const { candidates, selected, dispatchList } = _resolveBacklogCandidates(project, tasks, params.filter_labels, maxD);
                if (!candidates.length)
                    return txt({ ok: false, error: "No available tasks to dispatch." });
                // Auto-claim (default true for dispatch_all)
                const autoClaim = params.auto_claim !== false;
                if (autoClaim) {
                    for (const task of selected)
                        updateBacklogTask(task.id, { status: "in_progress" });
                }
                const loc = getProjectLocation(project, dataDir);
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
            name: "genorch_qa_submit",
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
                let reviewSessionKey = null;
                const project = sessionTracker.currentProject;
                const taskDesc = sessionTracker.currentTask || "Unknown task";
                const parentKey = sessionTracker.sessionKey;
                // ── ENFORCED: Always spawn an independent QA review subagent ──
                // Uses a unique session key so each QA review gets its own isolated session
                let spawnResult = null;
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
                        reviewSessionKey = qaSessionKey;
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
                // Record QA finding after review subagent may have been spawned
                sessionTracker.addQaFinding(params.finding, reviewSessionKey || undefined);
                sessionTracker.setStatus("qa");
                logger.info("qa", `QA finding submitted: ${params.finding.substring(0, 100)}`);
                return txt({
                    ok: true,
                    message: "QA finding submitted. Waiting for review (call genorch_qa_approve or genorch_qa_reject).",
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
            name: "genorch_qa_approve",
            label: "QA Approve",
            description: "Approve the current work. Unblocks the work→log transition when QA gate is active.",
            parameters: Type.Object({}),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                if (sessionTracker.qaStatus !== "pending") {
                    return txt({ ok: false, error: "No pending QA review to approve. Submit findings with genorch_qa_submit first." });
                }
                sessionTracker.setQaStatus("approved");
                sessionTracker.setStatus("running");
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
            name: "genorch_qa_reject",
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
                sessionTracker.qaRejectedAt = new Date().toISOString();
                sessionTracker.qaRejectReason = params.reason;
                sessionTracker.qaHistory.push({ event: "reject", timestamp: new Date().toISOString(), detail: params.reason });
                sessionTracker.setStatus("running");
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
            name: "genorch_handoff_create",
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
                    return txt({ ok: false, error: "No active project. Set context with genorch_session_start_work first." });
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
            name: "genorch_project_create",
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
                // Initialize project docs from templates
                initProjectDocs(projDir2, projectName, params.description, params.directory);
                // Create project config entry in DB FIRST (so FK constraints on state_events don't fail)
                setProjectConfig(projectName, {
                    location: params.directory || null,
                    workflow: { enabled: true },
                });
                // Write project_created state event (append-only, no overwrites)
                writeStateEvent(projectName, dataDir, {
                    type: "project_created",
                    description: params.description || null,
                    version: "0.0.1",
                    location: params.directory || null,
                });
                // Generate initial STATE.md from event log
                generateStateFromEvents(projectName, dataDir, logger);
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
                            note: "Session spawn marker created. A dedicated session will be available shortly. Use genorch_project_join to start working.",
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
                    message: `Project "${projectName}" created. ${params.directory ? `Location: ${params.directory}` : ""} Call genorch_session_start_work to start working, or genorch_project_join if you're in a different session.`,
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
            name: "genorch_knowledge_quiz",
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
            name: "genorch_project_tidy_docs",
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
            name: "genorch_test_create_unit",
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
            name: "genorch_test_create_e2e",
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
            name: "genorch_issue_debug",
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
            name: "genorch_feature_design",
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
            name: "genorch_project_sync_docs",
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
                                toolCount = _toolCount;
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
                            catch (e2) {
                                logger.debug("doctor", "Version read failed:", e2.message);
                            }
                        }
                    }
                    catch { /* doctor — project may not exist */ }
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
            name: "genorch_project_rebuild_state",
            label: "Regenerate State",
            description: "Regenerate STATE.md from the project state event log (SQLite). Computed from actual events, no LLM involved.",
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
        //  MULTI-AGENT VERIFICATION PIPELINE
        //  Work → Review → Fix → loop until pass or max iterations
        // ═══════════════════════════════════════════════════════════
        // ═══ Pipeline temp directory helper — deterministic from pipeline_id ═══
        function pipelineWorkDir(pipelineId) {
            return path.join(os.tmpdir(), `verify_${pipelineId.replace(/[^a-zA-Z0-9_-]/g, "_")}`);
        }
        // ═══ Atomic phase transition — returns true if transition succeeded ═══
        function transitionPhase(pipelineId, fromPhase, toPhase, updates) {
            const fields = ["phase = ?"];
            const values = [toPhase];
            if (updates) {
                for (const [k, v] of Object.entries(updates)) {
                    fields.push(`${k} = ?`);
                    values.push(v);
                }
            }
            fields.push("updated_ts = ?");
            values.push(Math.floor(Date.now() / 1000));
            values.push(pipelineId);
            values.push(fromPhase);
            const result = getDb().prepare(`UPDATE verification_runs SET ${fields.join(", ")} WHERE pipeline_id = ? AND phase = ?`).run(...values);
            return result.changes > 0;
        }
        // ═══ Pipeline cleanup — removes temp dir ═══
        function cleanupPipeline(pipelineId) {
            try {
                const dir = pipelineWorkDir(pipelineId);
                if (fs.existsSync(dir))
                    fs.rmSync(dir, { recursive: true, force: true });
            }
            catch (e) {
                logger.warn("verification", `Cleanup failed for ${pipelineId}: ${e.message}`);
            }
        }
        api.registerTool({
            name: "genorch_verify_pipeline_start",
            label: "Verify Work",
            description: "Start a multi-agent verification pipeline. Spawns a worker subagent, then a reviewer checks the work, and a fixer addresses issues — looping until pass or max iterations. Default max_iterations=3; after that the pipeline stalls at 'needs_guidance'. Use genorch_verify_pipeline_guide to give direction and retry.",
            parameters: Type.Object({
                task: Type.String({ description: "Description of the work to be done." }),
                criteria: Type.String({ description: "Verification criteria — what the reviewer should check for." }),
                max_iterations: Type.Optional(Type.Number({ description: "Maximum review-fix cycles (default: 3)." })),
                worker_model: Type.Optional(Type.String({ description: "Model override for the worker subagent." })),
                reviewer_model: Type.Optional(Type.String({ description: "Model override for the reviewer subagent." })),
                fixer_model: Type.Optional(Type.String({ description: "Model override for the fixer subagent." })),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                if (!sessionTracker.currentProject) {
                    return txt({ ok: false, error: "No active project. Set project context first." });
                }
                if (!params.task) {
                    return txt({ ok: false, error: "Task description is required." });
                }
                if (!params.criteria) {
                    return txt({ ok: false, error: "Verification criteria is required." });
                }
                const pipelineId = `verify_${crypto.randomUUID().slice(0, 12)}`;
                const maxIter = params.max_iterations || 3;
                const workDir = pipelineWorkDir(pipelineId);
                const workerOutputPath = path.join(workDir, "worker-output.md");
                const reviewerPath = path.join(workDir, "reviewer-verdict.md");
                const fixerOutputPath = path.join(workDir, "fixer-output.md");
                try {
                    fs.mkdirSync(workDir, { recursive: true });
                }
                catch (e) {
                    logger.warn("verification", `Failed to create workDir ${workDir}: ${e.message}`);
                }
                const project = sessionTracker.currentProject;
                const parentKey = sessionTracker.sessionKey || "";
                const workerTask = [
                    `[Verification Pipeline — Worker #1 — Auto-spawned by Orchestrator Plugin]`,
                    `Project: ${project}`,
                    `Parent Session: ${parentKey}`,
                    ``,
                    `You are the WORKER in a multi-agent verification pipeline. Complete the following task.`,
                    ``,
                    `## Task`,
                    params.task,
                    ``,
                    `## Instructions`,
                    `1. Complete the task thoroughly — write code, make changes, produce required output.`,
                    `2. When finished, write your complete work output to: ${workerOutputPath}`,
                    `3. Be thorough and self-contained — your output will be reviewed independently.`,
                ].filter(Boolean).join("\n");
                try {
                    const workerSessionKey = `agent:main:subagent:verify-worker-${crypto.randomUUID().slice(0, 8)}`;
                    await api.runtime.subagent.run({
                        sessionKey: workerSessionKey,
                        message: workerTask,
                        model: params.worker_model || undefined,
                        lightContext: true,
                    });
                    const msgs = JSON.stringify([
                        { ts: Date.now(), level: "info", msg: `Worker #1 spawned (session: ${workerSessionKey})` },
                    ]);
                    addVerificationRun({
                        pipeline_id: pipelineId,
                        project,
                        task: params.task,
                        criteria: params.criteria,
                        phase: "working",
                        iteration: 1,
                        max_iterations: maxIter,
                        worker_session: workerSessionKey,
                        reviewer_session: "",
                        fixer_session: "",
                        worker_output_path: workerOutputPath,
                        reviewer_result: "",
                        fixer_output_path: fixerOutputPath,
                        guidance: "",
                        artifacts: JSON.stringify({ workDir, reviewerPath, fixerOutputPath }),
                        messages: msgs,
                        created_ts: Math.floor(Date.now() / 1000),
                        updated_ts: Math.floor(Date.now() / 1000),
                    });
                    addLog("info", "verification", `Pipeline ${pipelineId}: worker spawned for ${project}`);
                    logger.info("verification", `Pipeline ${pipelineId} started for project=${project}`);
                    return txt({
                        ok: true,
                        pipeline_id: pipelineId,
                        project,
                        phase: "working",
                        iteration: 1,
                        max_iterations: maxIter,
                        worker_session: workerSessionKey,
                        message: `✅ Pipeline started. Worker #1 spawned. Call genorch_verify_pipeline_check pipeline_id="${pipelineId}" to check.`,
                    });
                }
                catch (err) {
                    logger.error("verification", `Pipeline ${pipelineId} spawn failed: ${err.message}`);
                    cleanupPipeline(pipelineId);
                    return txt({ ok: false, error: `Failed to start pipeline: ${err.message}` });
                }
            },
        });
        api.registerTool({
            name: "genorch_verify_pipeline_check",
            label: "Verify Check Progress",
            description: "Check and advance a multi-agent verification pipeline. Reads the current state, checks if the current subagent has completed (via output marker file), and spawns the next agent in the pipeline. Call repeatedly to advance through work→review→fix→loop.",
            parameters: Type.Object({
                pipeline_id: Type.String({ description: "Pipeline ID from genorch_verify_pipeline_start." }),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                if (!params.pipeline_id) {
                    return txt({ ok: false, error: "Pipeline ID is required." });
                }
                const run2 = getVerificationRun(params.pipeline_id);
                if (!run2) {
                    return txt({ ok: false, error: `Pipeline "${params.pipeline_id}" not found.` });
                }
                const run = run2;
                // Terminal states — just report
                if (run.phase === "pass") {
                    return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "pass", iteration: run.iteration, message: "✅ PASSED", reviewer_result: run.reviewer_result });
                }
                if (run.phase === "fail") {
                    return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "fail", iteration: run.iteration, message: "❌ FAILED — max iterations", reviewer_result: run.reviewer_result });
                }
                // Needs guidance — idle, waiting for user input
                if (run.phase === "needs_guidance") {
                    const hasGuidance = run.guidance && run.guidance.trim().length > 0;
                    return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "needs_guidance", iteration: run.iteration,
                        message: hasGuidance
                            ? "⏳ Guidance provided — call check again to resume."
                            : `⏳ Awaiting user guidance. Use genorch_verify_pipeline_guide to give direction.`,
                        reviewer_result: run.reviewer_result
                    });
                }
                const msgs = JSON.parse(run.messages || "[]");
                const maxIter = run.max_iterations || 3;
                const workDir = pipelineWorkDir(run.pipeline_id);
                // ── Helper: log + persist messages ──
                function pushMsg(level, msg) {
                    msgs.push({ ts: Date.now(), level, msg });
                }
                function saveMsgs() {
                    updateVerificationRun(run.pipeline_id, { messages: JSON.stringify(msgs) });
                }
                // ═══════════════════════════════════════════════════════
                //  Phase: WORKING — worker subagent running
                // ═══════════════════════════════════════════════════════
                if (run.phase === "working") {
                    // Timeout check: 30 min
                    const elapsed = Math.floor(Date.now() / 1000) - run.created_ts;
                    if (elapsed > 1800) {
                        pushMsg("error", `Worker #${run.iteration} timed out after ${elapsed}s`);
                        saveMsgs();
                        cleanupPipeline(run.pipeline_id);
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "error", iteration: run.iteration, message: `⏰ Worker #${run.iteration} timed out after 30 min.` });
                    }
                    const workerPath = run.worker_output_path;
                    if (!workerPath || !fs.existsSync(workerPath)) {
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "working", iteration: run.iteration, worker_session: run.worker_session, message: `⏳ Worker #${run.iteration} still running...` });
                    }
                    // Atomic: working → reviewing. If this fails, another caller already advanced.
                    const workerOutput = fs.readFileSync(workerPath, "utf-8");
                    const reviewerSessionKey = `agent:main:subagent:verify-reviewer-${crypto.randomUUID().slice(0, 8)}`;
                    const reviewerPath = path.join(workDir, "reviewer-verdict.md");
                    // Delete old reviewer file if present
                    try {
                        if (fs.existsSync(reviewerPath))
                            fs.unlinkSync(reviewerPath);
                    }
                    catch { /* */ }
                    const reviewerTask = [
                        `[Verification Pipeline — Reviewer #${run.iteration}]`,
                        `Project: ${run.project}`,
                        ``,
                        `Review the work against criteria.`,
                        ``,
                        `## Task`,
                        run.task,
                        `## Criteria`,
                        run.criteria,
                        `## Worker Output`,
                        workerOutput,
                        ``,
                        `## Instructions`,
                        `1. Check correctness, completeness, edge cases, code quality.`,
                        `2. Write verdict to: ${reviewerPath}`,
                        `3. First line MUST be "PASS" or "FAIL".`,
                        `   PASS = explain why it meets all criteria.`,
                        `   FAIL = explain what needs fixing.`,
                    ].filter(Boolean).join("\n");
                    if (!transitionPhase(run.pipeline_id, "working", "reviewing", {
                        reviewer_session: reviewerSessionKey,
                        messages: JSON.stringify(msgs),
                    })) {
                        // Another invocation already transitioned
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "reviewing", iteration: run.iteration, message: `Pipeline was already advanced by another call — reviewer spawning. Check again.` });
                    }
                    try {
                        await api.runtime.subagent.run({
                            sessionKey: reviewerSessionKey,
                            message: reviewerTask,
                            model: undefined,
                            lightContext: true,
                        });
                        pushMsg("info", `Reviewer #${run.iteration} spawned`);
                        saveMsgs();
                        addLog("info", "verification", `Pipeline ${run.pipeline_id}: worker done → reviewer #${run.iteration}`);
                        logger.info("verification", `Pipeline ${run.pipeline_id}: worker #${run.iteration} done → reviewer`);
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "reviewing", iteration: run.iteration, message: `✅ Worker done. Reviewer #${run.iteration} spawned. Check again for verdict.` });
                    }
                    catch (err) {
                        pushMsg("error", `Reviewer spawn failed: ${err.message}`);
                        saveMsgs();
                        addLog("error", "verification", `Pipeline ${run.pipeline_id}: reviewer spawn failed: ${err.message}`);
                        return txt({ ok: false, error: `Reviewer spawn failed: ${err.message}` });
                    }
                }
                // ═══════════════════════════════════════════════════════
                //  Phase: REVIEWING — reviewer subagent running
                // ═══════════════════════════════════════════════════════
                if (run.phase === "reviewing") {
                    // Timeout check: 30 min
                    const elapsed = Math.floor(Date.now() / 1000) - run.created_ts;
                    if (elapsed > 1800) {
                        // Derive reviewer path from workDir
                        const rPath = path.join(workDir, "reviewer-verdict.md");
                        // If a partial verdict file exists, try to use it
                        if (fs.existsSync(rPath)) {
                            const partial = fs.readFileSync(rPath, "utf-8");
                            pushMsg("warn", `Reviewer timed out, using partial verdict`);
                            // Write partial verdict as the reviewer_result and transition to fail
                            updateVerificationRun(run.pipeline_id, { reviewer_result: partial, phase: "fail" });
                            cleanupPipeline(run.pipeline_id);
                            return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "fail", iteration: run.iteration, message: `⏰ Reviewer timed out. Partial verdict recovered.`, reviewer_result: partial });
                        }
                        pushMsg("error", `Reviewer #${run.iteration} timed out`);
                        saveMsgs();
                        cleanupPipeline(run.pipeline_id);
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "error", iteration: run.iteration, message: `⏰ Reviewer #${run.iteration} timed out after 30 min.` });
                    }
                    const reviewerPath = path.join(workDir, "reviewer-verdict.md");
                    if (!fs.existsSync(reviewerPath)) {
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "reviewing", iteration: run.iteration, message: `⏳ Reviewer #${run.iteration} still reviewing...` });
                    }
                    const verdict = fs.readFileSync(reviewerPath, "utf-8");
                    const firstLine = verdict.trim().split("\n")[0].trim().toUpperCase();
                    const passed = firstLine.startsWith("PASS");
                    pushMsg("info", `Reviewer #${run.iteration} verdict: ${passed ? "PASS" : "FAIL"}`);
                    updateVerificationRun(run.pipeline_id, { reviewer_result: verdict, messages: JSON.stringify(msgs) });
                    addLog("info", "verification", `Pipeline ${run.pipeline_id}: reviewer verdict = ${passed ? "PASS" : "FAIL"}`);
                    if (passed) {
                        // Atomic: reviewing → pass
                        if (transitionPhase(run.pipeline_id, "reviewing", "pass")) {
                            cleanupPipeline(run.pipeline_id);
                            logger.info("verification", `Pipeline ${run.pipeline_id}: PASSED after ${run.iteration} iteration(s)`);
                            return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "pass", iteration: run.iteration, message: `✅ PASSED after ${run.iteration} iteration(s)!`, reviewer_result: verdict });
                        }
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "pass", message: "Already passed by another call.", reviewer_result: verdict });
                    }
                    // FAIL — check max iterations
                    if (run.iteration >= maxIter) {
                        // Transition to needs_guidance instead of terminal fail.
                        // Keep temp files — user can provide guidance and retry.
                        if (transitionPhase(run.pipeline_id, "reviewing", "needs_guidance")) {
                            logger.info("verification", `Pipeline ${run.pipeline_id}: needs guidance after ${maxIter} iterations`);
                        }
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "needs_guidance", iteration: run.iteration, message: `❌ FAILED after ${maxIter} iterations. Use genorch_verify_pipeline_guide to give direction and retry.`, reviewer_result: verdict });
                    }
                    // Spawn fixer
                    const nextIter = run.iteration + 1;
                    const fixerSessionKey = `agent:main:subagent:verify-fixer-${crypto.randomUUID().slice(0, 8)}`;
                    const fixerPath = path.join(workDir, "fixer-output.md");
                    // Save original worker output before fixer overwrites it
                    const origWorkerPath = path.join(workDir, "worker-original.md");
                    if (fs.existsSync(run.worker_output_path) && !fs.existsSync(origWorkerPath)) {
                        try {
                            fs.copyFileSync(run.worker_output_path, origWorkerPath);
                        }
                        catch { /* */ }
                    }
                    const workerOutput = fs.existsSync(run.worker_output_path) ? fs.readFileSync(run.worker_output_path, "utf-8") : "(no worker output)";
                    const fixerTask = [
                        `[Verification Pipeline — Fixer #${nextIter}]`,
                        `Project: ${run.project}`,
                        ``,
                        `Fix the issues found by the reviewer.`,
                        ``,
                        `## Task`,
                        run.task,
                        `## Worker Output`,
                        workerOutput,
                        `## Reviewer's FAIL Verdict`,
                        verdict,
                        ``,
                        `## Instructions`,
                        `1. Address ALL issues in the verdict.`,
                        `2. Write your complete fixed output to: ${fixerPath}`,
                    ].filter(Boolean).join("\n");
                    // Atomic: reviewing → fixing
                    if (!transitionPhase(run.pipeline_id, "reviewing", "fixing", {
                        iteration: nextIter,
                        fixer_session: fixerSessionKey,
                        fixer_output_path: fixerPath,
                        messages: JSON.stringify(msgs),
                    })) {
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "fixing", iteration: nextIter, message: `Pipeline already advanced — fixer spawning.` });
                    }
                    try {
                        await api.runtime.subagent.run({
                            sessionKey: fixerSessionKey,
                            message: fixerTask,
                            model: undefined,
                            lightContext: true,
                        });
                        pushMsg("info", `Fixer #${nextIter} spawned`);
                        saveMsgs();
                        addLog("info", "verification", `Pipeline ${run.pipeline_id}: fixer #${nextIter} spawned`);
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "fixing", iteration: nextIter, message: `🔧 Fixer #${nextIter} spawned. Check again for fixer progress.` });
                    }
                    catch (err) {
                        pushMsg("error", `Fixer spawn failed: ${err.message}`);
                        saveMsgs();
                        return txt({ ok: false, error: `Fixer spawn failed: ${err.message}` });
                    }
                }
                // ═══════════════════════════════════════════════════════
                //  Phase: FIXING — fixer subagent running
                // ═══════════════════════════════════════════════════════
                if (run.phase === "fixing") {
                    const elapsed = Math.floor(Date.now() / 1000) - run.created_ts;
                    if (elapsed > 1800) {
                        pushMsg("error", `Fixer #${run.iteration} timed out`);
                        saveMsgs();
                        cleanupPipeline(run.pipeline_id);
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "error", iteration: run.iteration, message: `⏰ Fixer #${run.iteration} timed out.` });
                    }
                    const fixerPath = run.fixer_output_path;
                    if (!fixerPath || !fs.existsSync(fixerPath)) {
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "fixing", iteration: run.iteration, message: `⏳ Fixer #${run.iteration} still working...` });
                    }
                    const fixerOutput = fs.readFileSync(fixerPath, "utf-8");
                    pushMsg("info", `Fixer #${run.iteration} completed`);
                    // Write fixer output to worker path for re-review (worker output is the canonical "current state" for review)
                    try {
                        fs.writeFileSync(run.worker_output_path, fixerOutput, "utf-8");
                    }
                    catch (e) {
                        logger.warn("verification", `Failed to update worker output: ${e.message}`);
                    }
                    // Clear old reviewer verdict file
                    const oldReviewerPath = path.join(workDir, "reviewer-verdict.md");
                    try {
                        if (fs.existsSync(oldReviewerPath))
                            fs.unlinkSync(oldReviewerPath);
                    }
                    catch (e) {
                        logger.warn("verification", `Failed to clear old verdict: ${e.message}`);
                    }
                    // Spawn re-review
                    const reviewerSessionKey = `agent:main:subagent:verify-reviewer-${crypto.randomUUID().slice(0, 8)}`;
                    const reReviewTask = [
                        `[Verification Pipeline — Reviewer #${run.iteration} (re-review)]`,
                        `Project: ${run.project}`,
                        ``,
                        `Re-review the fixed work.`,
                        ``,
                        `## Task`,
                        run.task,
                        `## Criteria`,
                        run.criteria,
                        `## Fixed Output`,
                        fixerOutput,
                        `## Previous Review (FAIL)`,
                        run.reviewer_result || "N/A",
                        ``,
                        `## Instructions`,
                        `1. Check ALL previous issues were addressed.`,
                        `2. Write verdict to: ${oldReviewerPath}`,
                        `3. First line MUST be "PASS" or "FAIL".`,
                    ].filter(Boolean).join("\n");
                    // Atomic: fixing → reviewing
                    if (!transitionPhase(run.pipeline_id, "fixing", "reviewing", {
                        reviewer_session: reviewerSessionKey,
                        reviewer_result: "",
                        messages: JSON.stringify(msgs),
                    })) {
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "reviewing", iteration: run.iteration, message: `Pipeline already advanced — re-review spawning.` });
                    }
                    try {
                        await api.runtime.subagent.run({
                            sessionKey: reviewerSessionKey,
                            message: reReviewTask,
                            model: undefined,
                            lightContext: true,
                        });
                        pushMsg("info", `Re-review reviewer #${run.iteration} spawned`);
                        saveMsgs();
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "reviewing", iteration: run.iteration, message: `✅ Fixer done. Re-review spawned. Check again for verdict.` });
                    }
                    catch (err) {
                        pushMsg("error", `Re-review spawn failed: ${err.message}`);
                        saveMsgs();
                        return txt({ ok: false, error: `Re-review spawn failed: ${err.message}` });
                    }
                }
                // ── Phase: error or unknown ──
                // ═══════════════════════════════════════════════════════
                //  Phase: GUIDED FIXING — fixer running with user guidance
                // ═══════════════════════════════════════════════════════
                if (run.phase === "guided_fixing") {
                    const elapsed = Math.floor(Date.now() / 1000) - run.created_ts;
                    if (elapsed > 1800) {
                        pushMsg("error", `Guided fixer #${run.iteration} timed out`);
                        saveMsgs();
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "error", iteration: run.iteration, message: `⏰ Guided fixer #${run.iteration} timed out.` });
                    }
                    const fixerPath = run.fixer_output_path;
                    if (!fixerPath || !fs.existsSync(fixerPath)) {
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "guided_fixing", iteration: run.iteration, message: `⏳ Guided fixer still working...` });
                    }
                    const fixerOutput = fs.readFileSync(fixerPath, "utf-8");
                    pushMsg("info", `Guided fixer #${run.iteration} completed`);
                    // Write fixer output to worker path for review
                    try {
                        fs.writeFileSync(run.worker_output_path, fixerOutput, "utf-8");
                    }
                    catch (e) {
                        logger.warn("verification", `Failed to update worker output: ${e.message}`);
                    }
                    // Clear old reviewer verdict
                    const oldReviewerPath = path.join(workDir, "reviewer-verdict.md");
                    try {
                        if (fs.existsSync(oldReviewerPath))
                            fs.unlinkSync(oldReviewerPath);
                    }
                    catch (e) {
                        logger.warn("verification", `Failed to clear old verdict: ${e.message}`);
                    }
                    // Spawn final review
                    const finalReviewerKey = `agent:main:subagent:verify-final-review-${crypto.randomUUID().slice(0, 8)}`;
                    const finalReviewTask = [
                        `[Verification Pipeline — Final Review]`,
                        `Project: ${run.project}`,
                        ``,
                        `Final review after user-guided fix.`,
                        ``,
                        `## Task`,
                        run.task,
                        `## Criteria`,
                        run.criteria,
                        `## User Guidance`,
                        run.guidance || "N/A",
                        `## Fixed Output`,
                        fixerOutput,
                        `## Previous Review (FAIL)`,
                        run.reviewer_result || "N/A",
                        ``,
                        `## Instructions`,
                        `1. Check ALL previous issues were addressed.`,
                        `2. Verify the user's guidance was followed.`,
                        `3. Write verdict to: ${oldReviewerPath}`,
                        `4. First line MUST be "PASS" or "FAIL".`,
                    ].filter(Boolean).join("\n");
                    // Atomic: guided_fixing → guided_review
                    if (!transitionPhase(run.pipeline_id, "guided_fixing", "guided_review", {
                        reviewer_session: finalReviewerKey,
                        reviewer_result: "",
                        messages: JSON.stringify(msgs),
                    })) {
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "guided_review", iteration: run.iteration, message: `Guided fix already advanced to review.` });
                    }
                    try {
                        await api.runtime.subagent.run({
                            sessionKey: finalReviewerKey,
                            message: finalReviewTask,
                            model: undefined,
                            lightContext: true,
                        });
                        pushMsg("info", `Final reviewer spawned`);
                        saveMsgs();
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "guided_review", iteration: run.iteration, message: `✅ Guided fix complete. Final review spawned. Check again for verdict.` });
                    }
                    catch (err) {
                        pushMsg("error", `Final review spawn failed: ${err.message}`);
                        saveMsgs();
                        return txt({ ok: false, error: `Final review spawn failed: ${err.message}` });
                    }
                }
                // ═══════════════════════════════════════════════════════
                //  Phase: GUIDED REVIEW — final review after user guidance
                // ═══════════════════════════════════════════════════════
                if (run.phase === "guided_review") {
                    const elapsed = Math.floor(Date.now() / 1000) - run.created_ts;
                    if (elapsed > 1800) {
                        pushMsg("error", `Final review timed out`);
                        saveMsgs();
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "error", iteration: run.iteration, message: `⏰ Final review timed out.` });
                    }
                    const verdictPath = path.join(workDir, "reviewer-verdict.md");
                    if (!fs.existsSync(verdictPath)) {
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "guided_review", iteration: run.iteration, message: `⏳ Final review still in progress...` });
                    }
                    const verdictContent = fs.readFileSync(verdictPath, "utf-8");
                    const firstLine = verdictContent.trim().split("\n")[0].trim().toUpperCase();
                    const passed = firstLine.startsWith("PASS");
                    pushMsg("info", `Final review verdict: ${passed ? "PASS" : "FAIL"}`);
                    updateVerificationRun(run.pipeline_id, { reviewer_result: verdictContent, messages: JSON.stringify(msgs) });
                    if (passed) {
                        if (transitionPhase(run.pipeline_id, "guided_review", "pass")) {
                            cleanupPipeline(run.pipeline_id);
                            logger.info("verification", `Pipeline ${run.pipeline_id}: PASSED after user guidance`);
                        }
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "pass", iteration: run.iteration, message: `✅ PASSED after user guidance!`, reviewer_result: verdictContent });
                    }
                    else {
                        if (transitionPhase(run.pipeline_id, "guided_review", "fail")) {
                            cleanupPipeline(run.pipeline_id);
                            logger.info("verification", `Pipeline ${run.pipeline_id}: FINAL FAIL after user guidance`);
                        }
                        return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "fail", iteration: run.iteration, message: `❌ FINAL FAIL after user guidance.`, reviewer_result: verdictContent });
                    }
                }
                const recent = msgs.slice(-3).map((m) => m.msg).join("; ");
                return txt({ ok: true, pipeline_id: run.pipeline_id, phase: run.phase, message: `State: "${run.phase}". ${recent}` });
            },
        });
        // ═══════════════════════════════════════════════════════════
        //  TOOL: genorch_verify_pipeline_guide
        // ═══════════════════════════════════════════════════════════
        api.registerTool({
            name: "genorch_verify_pipeline_guide",
            label: "Provide Guidance",
            description: "Provide user guidance for a stalled verification pipeline. After max retries, the pipeline enters 'needs_guidance' and waits for direction. Call this to give guidance and resume with a guided fixer + final review.",
            parameters: Type.Object({
                pipeline_id: Type.String({ description: "Pipeline ID from genorch_verify_pipeline_start." }),
                guidance: Type.String({ description: "Your guidance for the fixer. Describe what needs to be fixed and how." }),
            }),
            async execute(_id, params) {
                const reg = requireRegistration();
                if (reg)
                    return txt({ ok: false, error: reg });
                if (!params.pipeline_id || !params.guidance) {
                    return txt({ ok: false, error: "Both pipeline_id and guidance are required." });
                }
                const run = getVerificationRun(params.pipeline_id);
                if (!run) {
                    return txt({ ok: false, error: `Pipeline "${params.pipeline_id}" not found.` });
                }
                if (run.phase !== "needs_guidance") {
                    return txt({ ok: false, error: `Pipeline is in "${run.phase}" phase, not "needs_guidance". Cannot provide guidance now.` });
                }
                // Store guidance
                updateVerificationRun(run.pipeline_id, { guidance: params.guidance });
                // Spawn guided fixer
                const nextIter = (run.iteration || 1) + 1;
                const workDir = pipelineWorkDir(run.pipeline_id);
                const fixerPath = path.join(workDir, "fixer-output.md");
                const fixerSessionKey = `agent:main:subagent:verify-guided-fixer-${crypto.randomUUID().slice(0, 8)}`;
                const workerOutputPath = run.worker_output_path;
                const workerOutput = workerOutputPath && fs.existsSync(workerOutputPath)
                    ? fs.readFileSync(workerOutputPath, "utf-8")
                    : "(no previous worker output)";
                const fixerTask = [
                    `[Verification Pipeline — Guided Fixer #${nextIter}]`,
                    `Project: ${run.project}`,
                    ``,
                    `Fix the issues with guidance from the project owner.`,
                    ``,
                    `## Task`,
                    run.task,
                    `## Previous Worker Output`,
                    workerOutput,
                    `## Reviewer's FAIL Verdict`,
                    run.reviewer_result || "N/A",
                    `## User/Owner Guidance`,
                    params.guidance,
                    ``,
                    `## Instructions`,
                    `1. Follow the user/owner's guidance carefully.`,
                    `2. Address ALL issues from the reviewer's verdict.`,
                    `3. Write your complete fixed output to: ${fixerPath}`,
                ].filter(Boolean).join("\n");
                // Atomic: needs_guidance → guided_fixing
                if (!transitionPhase(run.pipeline_id, "needs_guidance", "guided_fixing", {
                    iteration: nextIter,
                    fixer_session: fixerSessionKey,
                    fixer_output_path: fixerPath,
                    messages: "[]",
                })) {
                    return txt({ ok: false, error: "Pipeline was already advanced by another call." });
                }
                try {
                    if (!fs.existsSync(workDir))
                        fs.mkdirSync(workDir, { recursive: true });
                    await api.runtime.subagent.run({
                        sessionKey: fixerSessionKey,
                        message: fixerTask,
                        model: undefined,
                        lightContext: true,
                    });
                    addLog("info", "verification", `Pipeline ${run.pipeline_id}: guided fixer #${nextIter} spawned`);
                    return txt({ ok: true, pipeline_id: run.pipeline_id, phase: "guided_fixing", iteration: nextIter,
                        message: `✅ Guidance received. Guided fixer #${nextIter} spawned. Call genorch_verify_pipeline_check to check progress.`,
                        guidance_received: true });
                }
                catch (err) {
                    return txt({ ok: false, error: `Guided fixer spawn failed: ${err.message}` });
                }
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
            const mc = countModels();
            modelCount = mc.total;
            const sf = path.join(dataDir, "session_log.md");
            if (fs.existsSync(sf))
                sessionCount = fs.readFileSync(sf, "utf-8").split("\n").filter(l => l.startsWith("|") && !l.includes("Date") && !l.includes("---")).length;
        }
        catch (e) {
            logger.debug("status", "Session count failed:", e.message);
        }
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
                        return { text: "**\u26a0 No project context.** Set context first with `/genor-set-context project=... task=...` or use `genorch_session_start_work`.", continueAgent: false };
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
                        issues.push("Session not registered. Call genorch_session_register.");
                    // Context check
                    const ctx = hk ? sessionTracker.getSessionContext(hk) : null;
                    if (!ctx)
                        issues.push("No project context set. Use genorch_session_start_work.");
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
                        lines.push("", "**Tip:** Use genorch_system_diagnose (tool) with fix=true to auto-repair.");
                    }
                    return { text: lines.join("\n"), continueAgent: false };
                }
                catch (e) {
                    return { text: "**\u274c Doctor error:** " + e.message, continueAgent: false };
                }
            },
        });
        // ═══════════════════════════════════════════════════════════
        //  SOFTWARE HOUSE MANAGEMENT TOOLS
        // ═══════════════════════════════════════════════════════════
        api.registerTool({
            name: "genorch_worker_hire",
            label: "Hire Worker",
            description: "Create a new worker.",
            parameters: Type.Object({
                name: Type.String({ description: "Worker name." }),
                role: Type.String({ description: "Worker role (e.g. developer, designer)." }),
                is_pm: Type.Optional(Type.Boolean({ description: "Set true to make this worker a PM (Project Manager)." })),
                sprite: Type.Optional(Type.String({ description: "Sprite color/style (default: blue)." })),
                model: Type.Optional(Type.String({ description: "AI model to use for this worker." })),
                room: Type.Optional(Type.String({ description: "Room ID to place the worker in." })),
                project: Type.Optional(Type.String({ description: "Project name (default: genor-orchestrator-plugin)." })),
            }),
            async execute(_id, params) {
                const id = `w${Date.now()}`;
                const proj = params.project || "genor-orchestrator-plugin";
                const isPmValue = params.is_pm ? 1 : 0;
                addWorker(id, params.name, params.role || "", params.sprite || "blue", params.model || "", "", params.room || "", proj, isPmValue);
                return txt({ ok: true, worker: { id, name: params.name, is_pm: params.is_pm || false } });
            },
        });
        api.registerTool({
            name: "genorch_worker_edit",
            label: "Edit Worker",
            description: "Edit worker details.",
            parameters: Type.Object({
                worker_id: Type.String({ description: "Worker ID." }),
                name: Type.Optional(Type.String({ description: "New name." })),
                role: Type.Optional(Type.String({ description: "New role." })),
                sprite: Type.Optional(Type.String({ description: "New sprite color/style." })),
                model: Type.Optional(Type.String({ description: "New AI model." })),
                room: Type.Optional(Type.String({ description: "New room ID." })),
            }),
            async execute(_id, params) {
                const updates = {};
                for (const key of ["name", "role", "sprite", "model", "room"]) {
                    if (params[key] !== undefined) {
                        updates[key] = params[key];
                    }
                }
                if (Object.keys(updates).length === 0)
                    return txt({ ok: false, error: "no fields to update" });
                updateWorker(params.worker_id, updates);
                return txt({ ok: true });
            },
        });
        api.registerTool({
            name: "genorch_worker_fire",
            label: "Fire Worker",
            description: "Remove a worker.",
            parameters: Type.Object({
                worker_id: Type.String({ description: "Worker ID." }),
            }),
            async execute(_id, params) {
                // Delete related records first (foreign key constraints)
                deleteWorkerMessagesByWorker(params.worker_id);
                deleteWorkerSessionsByWorker(params.worker_id);
                deleteWorkerTaskHistoryByWorker(params.worker_id);
                // Unassign backlog tasks
                const stalled = getStalledTasksForWorker(params.worker_id);
                for (const t of stalled) {
                    updateBacklogTask(t.id, { worker_id: null });
                }
                deleteWorker(params.worker_id);
                return txt({ ok: true });
            },
        });
        api.registerTool({
            name: "genorch_worker_set_pm",
            label: "Set Worker as PM",
            description: "Set or unset a worker as Project Manager (PM).",
            parameters: Type.Object({
                worker_id: Type.String({ description: "Worker ID." }),
                is_pm: Type.Boolean({ description: "True to make this worker a PM, false to remove PM status." }),
            }),
            async execute(_id, params) {
                const isPmValue = params.is_pm ? 1 : 0;
                const worker = getWorker(params.worker_id);
                if (!worker) {
                    return txt({ ok: false, error: "worker not found" });
                }
                updateWorker(params.worker_id, { is_pm: isPmValue });
                return txt({ ok: true, worker_id: params.worker_id, is_pm: !!params.is_pm });
            },
        });
        api.registerTool({
            name: "genorch_room_create",
            label: "Create Room",
            description: "Create a new room.",
            parameters: Type.Object({
                name: Type.String({ description: "Room name." }),
                purpose: Type.Optional(Type.String({ description: "Room purpose/description." })),
                project: Type.Optional(Type.String({ description: "Project name (default: genor-orchestrator-plugin)." })),
            }),
            async execute(_id, params) {
                const id = `room_${Date.now().toString(36)}`;
                const proj = params.project || "genor-orchestrator-plugin";
                addRoom(id, params.name, params.purpose || "", "[]", proj);
                return txt({ ok: true, room: { id, name: params.name } });
            },
        });
        api.registerTool({
            name: "genorch_room_edit",
            label: "Edit Room",
            description: "Edit room details.",
            parameters: Type.Object({
                room_id: Type.String({ description: "Room ID." }),
                name: Type.Optional(Type.String({ description: "New name." })),
                purpose: Type.Optional(Type.String({ description: "New purpose/description." })),
            }),
            async execute(_id, params) {
                const updates = {};
                for (const key of ["name", "purpose"]) {
                    if (params[key] !== undefined) {
                        updates[key] = params[key];
                    }
                }
                if (Object.keys(updates).length === 0)
                    return txt({ ok: false, error: "no fields to update" });
                updateRoom(params.room_id, updates);
                return txt({ ok: true });
            },
        });
        api.registerTool({
            name: "genorch_room_delete",
            label: "Delete Room",
            description: "Remove a room.",
            parameters: Type.Object({
                room_id: Type.String({ description: "Room ID." }),
            }),
            async execute(_id, params) {
                deleteRoom(params.room_id);
                return txt({ ok: true });
            },
        });
        api.registerTool({
            name: "genorch_task_create",
            label: "Create Task",
            description: "Create a backlog task (replaces HTTP-only POST /backlog).",
            parameters: Type.Object({
                title: Type.String({ description: "Task title." }),
                description: Type.Optional(Type.String({ description: "Task description." })),
                priority: Type.Optional(Type.String({ description: "Priority: p0 (urgent), p1 (high), p2 (normal), p3 (low). Default: p2." })),
                labels: Type.Optional(Type.Array(Type.String(), { description: "Labels/tags." })),
                project: Type.Optional(Type.String({ description: "Project name (default: genor-orchestrator-plugin)." })),
            }),
            async execute(_id, params) {
                const proj = params.project || "genor-orchestrator-plugin";
                const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                addBacklogTask({
                    id, project: proj, title: params.title,
                    description: params.description || "",
                    priority: params.priority || "p2",
                    status: "todo",
                    labels: JSON.stringify(params.labels || []),
                });
                return txt({ ok: true, id });
            },
        });
        api.registerTool({
            name: "genorch_task_move",
            label: "Move Task",
            description: "Move task to a different phase.",
            parameters: Type.Object({
                task_id: Type.String({ description: "Task ID." }),
                phase: Type.Enum({ todo: "todo", in_progress: "in_progress", review: "review", done: "done" }, { description: "Target phase: todo, in_progress, review, done." }),
                project: Type.Optional(Type.String({ description: "Project name (default: genor-orchestrator-plugin)." })),
            }),
            async execute(_id, params) {
                updateBacklogTask(params.task_id, { status: params.phase });
                return txt({ ok: true });
            },
        });
        api.registerTool({
            name: "genorch_task_assign",
            label: "Assign Task",
            description: "Assign a task to a worker.",
            parameters: Type.Object({
                task_id: Type.String({ description: "Task ID." }),
                worker_id: Type.String({ description: "Worker ID." }),
                project: Type.Optional(Type.String({ description: "Project name (default: genor-orchestrator-plugin)." })),
            }),
            async execute(_id, params) {
                updateBacklogTask(params.task_id, { worker_id: params.worker_id });
                updateWorker(params.worker_id, { status: 'working' });
                addWorkerTaskHistory(params.worker_id, params.task_id, 'assigned', JSON.stringify({ assignedAt: new Date().toISOString() }));
                return txt({ ok: true });
            },
        });
        // ── Dashboard HTTP handler — serve dashboard through gateway ──
        // Follows the same pattern as built-in plugins (canvas, admin-http-rpc, webhooks)
        try {
            const dashHandler = createDashboardHandler(api);
            // Dashboard UI + API: "plugin" auth serves the dashboard and handles API calls
            // No operator.write scope needed — dashboard handler uses OpenAI endpoint for spawns
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
        // Count actual registered tools from metadata
        const toolCount = _collectedToolMeta.length;
        logger.info("plugin", `Orchestrator ready — ${logLevel} logging, maintenance active, ${toolCount} tools, 5 slash commands`);
        // ═══════════════════════════════════════════════════════════
        //  WORKER TOOLS — Software House execution tools
        // ═══════════════════════════════════════════════════════════
        // Register all worker tools
        for (const tool of WORKER_TOOLS) {
            api.registerTool({
                name: tool.name,
                label: tool.label,
                description: tool.description,
                parameters: tool.parameters,
                execute: tool.execute,
            });
        }
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
        get tools() {
            // Prefer the full metadata when register() has populated it.
            // Fall back to name-only entries for build-time reflection
            // (openclaw plugins build evaluates the module before register()).
            return _collectedToolMeta.length > 0
                ? _collectedToolMeta
                : _staticToolNames.map((name) => ({ name }));
        },
    },
    enumerable: false,
});
// ── Test helper ────────────────────────────────────────────────
// Sets a synthetic session key so `genorch_session_register` works
// in test environments where hooks don't fire.
export function __setTestSessionKey(key) {
    sessionTracker.start(key, "test");
}
// ═══════════════════════════════════════════════════════════════
// DEFAULT EXPORT — required by OpenClaw plugin loader
// ═══════════════════════════════════════════════════════════════
export default pluginExport;
