/**
 * Shared utilities for the genor-orchestrator-plugin.
 *
 * Centralizes data directory resolution so both the main plugin
 * (src/index.ts) and the dashboard handler (src/dashboard-handler.ts)
 * use the same logic. The data dir is owned by the plugin core —
 * not by any one subsystem — because it stores critical state
 * (models.json, dashboard-config.json, projects/, logs/, etc.).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
// ── DATA DIRECTORY RESOLUTION ─────────────────────────────────
// Priority: 1) explicit cfgDir  2) ORCHESTRATOR_DATA_DIR env var  3) default
// Auto-creates on first access. NOT cached so tests can change the env var.
export function getDataDir(cfgDir) {
    if (cfgDir && fs.existsSync(cfgDir))
        return cfgDir;
    const envDir = process.env.ORCHESTRATOR_DATA_DIR;
    if (envDir && fs.existsSync(envDir))
        return envDir;
    const dflt = path.join(os.homedir(), ".openclaw/workspace/orchestrator-data");
    fs.mkdirSync(dflt, { recursive: true });
    return dflt;
}
