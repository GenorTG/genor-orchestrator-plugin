/**
 * Dashboard HTTP handler — serves the Orchestrator Dashboard directly
 * through the OpenClaw gateway's built-in HTTP server via registerHttpRoute().
 *
 * Replaces: dashboard/server.py + serve.sh + PM2 orchestration-dashboard process.
 * Auto-starts with the plugin — no separate process needed.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
export declare function createDashboardHandler(api: OpenClawPluginApi): (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void>;
