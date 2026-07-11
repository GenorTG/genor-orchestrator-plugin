// ═══════════════════════════════════════════════════════════════
//  UTILITIES — small helpers shared across the plugin
// ═══════════════════════════════════════════════════════════════
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/** Plugin root = parent of the `src/` (or `dist/`) directory. */
export const PLUGIN_ROOT = path.resolve(__dirname, "..");
// ── Tool result helper ─────────────────────────────────────────
export function txt(data) {
    return {
        content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
        details: data,
    };
}
// ═══════════════════════════════════════════════════════════════
//  DATA DIRECTORY RESOLUTION
// ═══════════════════════════════════════════════════════════════
export function getDashboardDir() {
    // Dashboard is bundled INSIDE the plugin package — no skill dir needed!
    const pluginDashboard = path.join(PLUGIN_ROOT, "dashboard");
    if (fs.existsSync(pluginDashboard))
        return pluginDashboard;
    // fallback for development
    const devPath = process.env.DASHBOARD_DIR;
    if (devPath && fs.existsSync(devPath))
        return devPath;
    return pluginDashboard;
}
// ═══════════════════════════════════════════════════════════════
//  JSON FILE HELPERS
// ═══════════════════════════════════════════════════════════════
export function readJSON(filePath) {
    if (!fs.existsSync(filePath))
        return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
    catch {
        return null;
    }
}
export function writeJSON(filePath, data) {
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
}
/** Extract tags from a task slug and notes text. Used for session entry tags. */
export function extractTags(task, notes) {
    const tags = [];
    const stop = new Set(["the", "and", "for", "with", "from", "this", "that", "have", "has"]);
    const t = (task || "").toLowerCase();
    for (const part of t.split(/[-_]/)) {
        if (part.length > 2 && !stop.has(part) && !/^v?\d/.test(part) && !tags.includes(part)) {
            tags.push(part);
        }
    }
    const n = (notes || "").toLowerCase();
    for (const kw of ["design", "implement", "fix", "test", "refactor", "debug", "audit", "review"]) {
        if (n.includes(kw) && !tags.includes(kw))
            tags.push(kw);
    }
    return tags.slice(0, 8);
}
export function readFileContent(p) {
    if (!fs.existsSync(p))
        return null;
    return fs.readFileSync(p, "utf-8");
}
