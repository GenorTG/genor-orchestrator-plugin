/**
 * Centralized database for the genor-orchestrator-plugin.
 *
 * Replaces all ad-hoc JSON file I/O with a single SQLite database.
 * Uses Node 23's built-in `node:sqlite` — zero dependencies.
 *
 * KEEPS ON DISK (human-readable only):
 *   - STATE.md, ROADMAP.md, CONTEXT.md, NOTES.md, RECOVERY.md, KEY_FILES.md
 *   - adrs/*.md
 *   - sessions/*.md  (human-readable session logs)
 *
 * EVERYTHING ELSE goes into orchestrator.db via this module.
 */
import { DatabaseSync } from "node:sqlite";
export interface SessionRow {
    id: string;
    project: string;
    agent: string;
    model: string;
    tags: string;
    status: string;
    task: string;
    start_ts: number | null;
    end_ts: number | null;
    duration: string;
    session_key: string;
    extra: string;
    logged_at: string;
}
export interface BacklogRow {
    id: string;
    project: string;
    title: string;
    description: string;
    priority: string;
    status: string;
    labels: string;
    depends_on: string;
    assigned_to: string;
    session_refs: string;
    created_ts: number;
    updated_ts: number;
}
export declare function getDb(dataDir?: string): DatabaseSync;
/**
 * Get the resolved data directory for the DB.
 * Useful for diagnostics — not cached, always reflects current state.
 */
export declare function getDbDir(): string;
export declare function initDb(dataDir?: string): void;
export declare function getGlobalConfig(key: string): any;
export declare function getAllGlobalConfig(limit?: number): Record<string, any>;
export declare function setGlobalConfig(key: string, value: any): void;
export declare function deleteGlobalConfig(key: string): void;
export declare function getProjectConfig(project: string): any;
export declare function getAllProjectConfigs(limit?: number): Record<string, any>;
export declare function setProjectConfig(project: string, config: any): void;
export declare function updateProjectConfig(project: string, updates: Record<string, any>): void;
export declare function deleteProjectConfig(project: string): void;
export declare function listSessions(project: string, limit?: number, offset?: number): SessionRow[];
export declare function getAllSessions(limit?: number): SessionRow[];
export declare function getSession(id: string): SessionRow | null;
export declare function addSession(session: SessionRow): void;
export declare function updateSession(id: string, updates: Partial<SessionRow>): void;
export declare function deleteSession(id: string): void;
export declare function countSessions(project: string): number;
export declare function listBacklogTasks(project: string, limit?: number): BacklogRow[];
export declare function getBacklogTask(id: string): BacklogRow | null;
export declare function addBacklogTask(task: BacklogRow): void;
export declare function updateBacklogTask(id: string, updates: Partial<BacklogRow>): void;
export declare function deleteBacklogTask(id: string): void;
export declare function deleteBacklogTasksByStatus(project: string, status: string): number;
export declare function countBacklogByStatus(project: string): Record<string, number>;
export declare function addStateEvent(project: string, type: string, data: any): void;
export declare function getStateEvents(project: string, limit?: number): any[];
export declare function pruneStateEvents(project: string, cutoffTs: number): number;
export declare function listModels(filterDisabled?: boolean, project?: string): any[];
export declare function getModel(id: string): any | null;
export declare function upsertModel(id: string, config: any): void;
export declare function updateModel(id: string, updates: Record<string, any>): void;
export declare function deleteModel(id: string): void;
export declare function countModels(): {
    total: number;
    active: number;
};
export declare function getLiveAgents(limit?: number): any[];
export declare function setLiveAgents(agents: any[]): void;
export declare function getLiveSessions(limit?: number): {
    sessions: any[];
    meta: any;
};
export declare function setLiveSessions(sessions: any[], meta?: any): void;
export declare function getPendingRegistrations(limit?: number): any[];
export declare function addPendingRegistration(reg: any): void;
export declare function removePendingRegistration(sessionKey: string): void;
export declare function getChatOutbox(limit?: number): any[];
export declare function addToChatOutbox(data: any): void;
export declare function clearChatOutbox(): void;
export declare function getControlResults(limit?: number): any[];
export declare function addControlResult(name: string, data: any): void;
export declare function getLogs(limit?: number, level?: string): any[];
export declare function addLog(level: string, source: string, message: string, data?: any): void;
