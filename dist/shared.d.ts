/**
 * Shared utilities for the genor-orchestrator-plugin.
 *
 * Centralizes data directory resolution so both the main plugin
 * (src/index.ts) and the dashboard handler (src/dashboard-handler.ts)
 * use the same logic. The data dir is owned by the plugin core —
 * not by any one subsystem — because it stores critical state
 * (models.json, dashboard-config.json, projects/, logs/, etc.).
 */
export declare function getDataDir(cfgDir?: string): string;
