// ═══════════════════════════════════════════════════════════════
//  CONTROL ACTIONS — Process dashboard → plugin commands
//  (set_context, clear_context, update_routing, etc.)
//  Extracted from src/index.ts as part of the slice refactor.
// ═══════════════════════════════════════════════════════════════
import * as fs from "node:fs";
import * as path from "node:path";
import { sessionTracker } from "./session-tracker.js";
import { queueLiveAgents } from "./live-agents.js";
import { setGlobalConfig, getAllGlobalConfig, getProjectConfig, setProjectConfig, getAllProjectConfigs, } from "./db.js";
export function controlDir(dataDir) {
    return path.join(dataDir, "control");
}
export function writeActionResult(dataDir, actionId, ok, result, error) {
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
export function processSetContext(dataDir, params, logger) {
    const project = params.project;
    const task = params.task;
    if (!project)
        throw new Error("Missing project");
    sessionTracker.setContext(project, task || "");
    queueLiveAgents("control_set_context", sessionTracker);
    return { project, task, ok: true };
}
export function processClearContext(dataDir, _params, logger) {
    const prev = sessionTracker.currentProject;
    sessionTracker.clearContext();
    queueLiveAgents("control_clear_context", sessionTracker);
    return { previous_project: prev, ok: true };
}
export function processUpdateRouting(dataDir, params, logger) {
    if (typeof params.free_only_mode === "boolean") {
        setGlobalConfig("free_only_mode", params.free_only_mode);
    }
    if (Array.isArray(params.disabled_models)) {
        setGlobalConfig("disabled_models", params.disabled_models);
    }
    if (typeof params.project === "string" && params.project_allowlist) {
        const pc = getProjectConfig(params.project) || {};
        pc.model_allowlist = params.project_allowlist;
        setProjectConfig(params.project, pc);
    }
    if (typeof params.project === "string" && typeof params.project_free_only === "boolean") {
        const pc = getProjectConfig(params.project) || {};
        pc.free_only = params.project_free_only;
        setProjectConfig(params.project, pc);
    }
    const globalCfg = getAllGlobalConfig();
    logger.info("control", `Routing updated: free_only=${globalCfg.free_only_mode}`);
    return { ok: true, config: { ...globalCfg, projects: getAllProjectConfigs() } };
}
export function processControlAction(dataDir, action, logger) {
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
