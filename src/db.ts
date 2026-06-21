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

import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getDataDir } from "./shared.js";

// ── TYPES ─────────────────────────────────────────────────────

export interface SessionRow {
  id: string;
  project: string;
  agent: string;
  model: string;
  tags: string;        // JSON array
  status: string;
  task: string;
  start_ts: number | null;
  end_ts: number | null;
  duration: string;
  session_key: string;
  extra: string;       // JSON blob
  logged_at: string;
}

export interface BacklogRow {
  id: string;
  project: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  labels: string;       // JSON array
  depends_on: string;   // JSON array
  assigned_to: string;
  session_refs: string; // JSON array
  created_ts: number;
  updated_ts: number;
}

// ── VALID COLUMNS (SQL injection prevention for dynamic update functions) ──

const SESSION_COLUMNS = new Set([
  "project", "agent", "model", "tags", "status", "task",
  "start_ts", "end_ts", "duration", "session_key", "extra", "logged_at"
]);

const BACKLOG_COLUMNS = new Set([
  "project", "title", "description", "priority", "status",
  "labels", "depends_on", "assigned_to", "session_refs", "created_ts", "updated_ts"
]);

// ── SINGLETON ──────────────────────────────────────────────────

let _db: DatabaseSync | null = null;
let _initialized = false;

export function getDb(dataDir?: string): DatabaseSync {
  if (!_db) {
    const dir = getDataDir(dataDir);
    const dbPath = path.join(dir, "orchestrator.db");
    _db = new DatabaseSync(dbPath);
    _db.exec("PRAGMA journal_mode=WAL");
    _db.exec("PRAGMA busy_timeout=5000");
    _db.exec("PRAGMA foreign_keys=ON");
  }
  return _db;
}

/**
 * Get the resolved data directory for the DB.
 * Useful for diagnostics — not cached, always reflects current state.
 */


// ── SCHEMA / MIGRATION VERSIONING ──────────────────────────────

/**
 * Migration system: Schema changes are tracked via a version table.
 * Each migration is a named step applied once. Adding a new migration:
 *   1. Write a function that applies the change
 *   2. Add it to MIGRATIONS array with version+name
 *   3. Test with fresh DB and existing DB
 */

const SCHEMA_V1 = `
-- Schema version tracking
CREATE TABLE IF NOT EXISTS _schema_version (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_ts INTEGER NOT NULL
);

-- Global key-value config
CREATE TABLE IF NOT EXISTS global_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Per-project config
CREATE TABLE IF NOT EXISTS project_configs (
    project TEXT PRIMARY KEY,
    location TEXT,
    config TEXT NOT NULL DEFAULT '{}'
);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    agent TEXT DEFAULT '',
    model TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    status TEXT DEFAULT '',
    task TEXT DEFAULT '',
    start_ts INTEGER,
    end_ts INTEGER,
    duration TEXT DEFAULT '',
    session_key TEXT DEFAULT '',
    extra TEXT DEFAULT '{}',
    logged_at TEXT DEFAULT ''
);

-- Backlog tasks
CREATE TABLE IF NOT EXISTS backlog_tasks (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    priority TEXT DEFAULT 'p2',
    status TEXT DEFAULT 'todo',
    labels TEXT DEFAULT '[]',
    depends_on TEXT DEFAULT '[]',
    assigned_to TEXT DEFAULT '',
    session_refs TEXT DEFAULT '[]',
    created_ts INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_ts INTEGER NOT NULL DEFAULT (unixepoch())
);

-- State events
CREATE TABLE IF NOT EXISTS state_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    ts INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Model inventory
CREATE TABLE IF NOT EXISTS models (
    id TEXT PRIMARY KEY,
    name TEXT DEFAULT '',
    provider TEXT DEFAULT '',
    agent_ready INTEGER DEFAULT 1,
    status TEXT DEFAULT 'active',
    config TEXT NOT NULL DEFAULT '{}'
);

-- Live agents
CREATE TABLE IF NOT EXISTS live_agents (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}'
);

-- Live sessions
CREATE TABLE IF NOT EXISTS live_sessions (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}'
);

-- Chat outbox

-- Pending registrations
CREATE TABLE IF NOT EXISTS pending_registrations (
    session_key TEXT PRIMARY KEY,
    project TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    data TEXT NOT NULL DEFAULT '{}'
);

-- Control action results
CREATE TABLE IF NOT EXISTS control_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    data TEXT NOT NULL DEFAULT '{}',
    ts INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Orchestrator log entries
CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT DEFAULT 'info',
    source TEXT DEFAULT '',
    message TEXT DEFAULT '',
    data TEXT DEFAULT '{}',
    ts INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_ts ON sessions(start_ts);
CREATE INDEX IF NOT EXISTS idx_backlog_project ON backlog_tasks(project);
CREATE INDEX IF NOT EXISTS idx_backlog_status ON backlog_tasks(status);
CREATE INDEX IF NOT EXISTS idx_events_project ON state_events(project);
CREATE INDEX IF NOT EXISTS idx_events_ts ON state_events(ts);
CREATE INDEX IF NOT EXISTS idx_models_status ON models(status);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);

-- Verification pipeline runs
CREATE TABLE IF NOT EXISTS verification_runs (
    pipeline_id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    task TEXT NOT NULL,
    criteria TEXT DEFAULT '',
    phase TEXT NOT NULL DEFAULT 'working',
    iteration INTEGER NOT NULL DEFAULT 1,
    max_iterations INTEGER NOT NULL DEFAULT 3,
    worker_session TEXT DEFAULT '',
    reviewer_session TEXT DEFAULT '',
    fixer_session TEXT DEFAULT '',
    worker_output_path TEXT DEFAULT '',
    reviewer_result TEXT DEFAULT '',
    fixer_output_path TEXT DEFAULT '',
    guidance TEXT DEFAULT '',
    artifacts TEXT DEFAULT '[]',
    messages TEXT DEFAULT '[]',
    created_ts INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_ts INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_verification_project ON verification_runs(project);
CREATE INDEX IF NOT EXISTS idx_verification_phase ON verification_runs(phase);

`;

/** Get current schema version from DB, or 0 if not yet tracked. */
function getSchemaVersion(): number {
  try {
    const row = getDb().prepare("SELECT COALESCE(MAX(version), 0) as v FROM _schema_version").get() as any;
    return row?.v || 0;
  } catch {
    return 0;
  }
}

/** Apply a single migration with error logging. */
function applyMigration(version: number, name: string, sql: string): void {
  const db = getDb();
  db.exec(sql);
  db.prepare("INSERT INTO _schema_version (version, name, applied_ts) VALUES (?, ?, ?)").run(
    version, name, Math.floor(Date.now() / 1000)
  );
  console.error(`[orchestrator-db] Migration v${version}: ${name}`);
}

interface Migration {
  version: number;
  name: string;
  apply: () => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 2,
    name: "Add FK constraints, fix logged_at type, normalize timestamps",
    apply: () => {
      const db = getDb();

      // ── Record this migration (BEFORE table ops, so any failure still records) ──
      const now = Math.floor(Date.now() / 1000);

      // ── Sessions v2: FK + logged_as INTEGER ──
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions_v2 (
          id TEXT PRIMARY KEY,
          project TEXT NOT NULL REFERENCES project_configs(project) ON DELETE CASCADE,
          agent TEXT DEFAULT '',
          model TEXT DEFAULT '',
          tags TEXT DEFAULT '[]',
          status TEXT DEFAULT '',
          task TEXT DEFAULT '',
          start_ts INTEGER,
          end_ts INTEGER,
          duration TEXT DEFAULT '',
          session_key TEXT DEFAULT '',
          extra TEXT DEFAULT '{}',
          logged_at INTEGER DEFAULT 0
        );
        INSERT OR IGNORE INTO sessions_v2 SELECT * FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_v2 RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
        CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
        CREATE INDEX IF NOT EXISTS idx_sessions_ts ON sessions(start_ts);
      `);

      // ── Backlog tasks v2: FK ──
      db.exec(`
        CREATE TABLE IF NOT EXISTS backlog_tasks_v2 (
          id TEXT PRIMARY KEY,
          project TEXT NOT NULL REFERENCES project_configs(project) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT DEFAULT '',
          priority TEXT DEFAULT 'p2',
          status TEXT DEFAULT 'todo',
          labels TEXT DEFAULT '[]',
          depends_on TEXT DEFAULT '[]',
          assigned_to TEXT DEFAULT '',
          session_refs TEXT DEFAULT '[]',
          created_ts INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_ts INTEGER NOT NULL DEFAULT (unixepoch())
        );
        INSERT OR IGNORE INTO backlog_tasks_v2 SELECT * FROM backlog_tasks;
        DROP TABLE backlog_tasks;
        ALTER TABLE backlog_tasks_v2 RENAME TO backlog_tasks;
        CREATE INDEX IF NOT EXISTS idx_backlog_project ON backlog_tasks(project);
        CREATE INDEX IF NOT EXISTS idx_backlog_status ON backlog_tasks(status);
      `);

      // ── State events v2: FK ──
      db.exec(`
        CREATE TABLE IF NOT EXISTS state_events_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project TEXT NOT NULL REFERENCES project_configs(project) ON DELETE CASCADE,
          type TEXT NOT NULL,
          data TEXT NOT NULL DEFAULT '{}',
          ts INTEGER NOT NULL DEFAULT (unixepoch())
        );
        INSERT OR IGNORE INTO state_events_v2 SELECT * FROM state_events;
        DROP TABLE state_events;
        ALTER TABLE state_events_v2 RENAME TO state_events;
        CREATE INDEX IF NOT EXISTS idx_events_project ON state_events(project);
        CREATE INDEX IF NOT EXISTS idx_events_ts ON state_events(ts);
      `);

      // ── Convert logged_at TEXT to INTEGER in sessions ──
      // Migrate ISO strings to epoch seconds; keep existing integers as-is.
      db.exec(`
        UPDATE sessions SET logged_at = CAST(strftime('%s', logged_at) AS INTEGER)
        WHERE logged_at != '' AND logged_at GLOB '[0-9]*-[0-9]*-*';
      `);

      // ── Convert ms-based start_ts/end_ts to seconds ──
      // Values > 1e11 are ms (year 5138+); divide down to seconds.
      db.exec(`
        UPDATE sessions SET start_ts = start_ts / 1000 WHERE start_ts > 100000000000;
        UPDATE sessions SET end_ts = end_ts / 1000 WHERE end_ts > 100000000000;
      `);

      // ── Record this migration ──
      db.prepare("INSERT OR REPLACE INTO _schema_version (version, name, applied_ts) VALUES (?, ?, ?)").run(
        2, "Add FK constraints, fix logged_at type, normalize timestamps", now
      );
    },
  },
  {
    version: 3,
    name: "Add guidance column to verification_runs",
    apply: () => {
      const db = getDb();
      db.exec("ALTER TABLE verification_runs ADD COLUMN guidance TEXT DEFAULT ''");
      const now = Math.floor(Date.now() / 1000);
      db.prepare("INSERT OR REPLACE INTO _schema_version (version, name, applied_ts) VALUES (?, ?, ?)").run(
        3, "Add guidance column to verification_runs", now
      );
    },
  },
];

// ── INIT / MIGRATE ─────────────────────────────────────────────

export function initDb(dataDir?: string): void {
  if (_initialized) return;
  const db = getDb(dataDir);

  // 1. Create base v1 schema (all tables with original format)
  db.exec(SCHEMA_V1);

  // 2. Import from legacy JSON files FIRST (populates v1 tables)
  const count = db.prepare("SELECT count(*) as cnt FROM sessions").get() as any;
  if (!count || Number(count.cnt) === 0) {
    migrateFromFiles(dataDir);
  }

  // 3. Apply pending migrations (upgrades data + adds constraints)
  const current = getSchemaVersion();
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      try {
        m.apply();
      } catch (e: any) {
        console.error(`[orchestrator-db] Migration v${m.version} FAILED: ${e.message}`);
        throw e;
      }
    }
  }

  _initialized = true;
}

/** Read existing JSON/JSONL files and import into DB. */
function migrateFromFiles(dataDir?: string): void {
  const dir = getDataDir(dataDir);
  const db = getDb();

  // Only migrate if tables are empty (first run)
  const count = db.prepare("SELECT count(*) as cnt FROM sessions").get() as any;
  if (count && count.cnt > 0) return; // Already migrated

  console.log("[orchestrator-db] Migrating data from files...");

  // ── 1. Global config ──
  const cfgFile = path.join(dir, "dashboard-config.json");
  if (fs.existsSync(cfgFile)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf-8"));
      const stmt = db.prepare("INSERT OR REPLACE INTO global_config VALUES (?, ?)");
      for (const k of ["free_only_mode", "disabled_models", "safeguards", "theme", "auto_refresh_seconds"]) {
        if (cfg[k] !== undefined) stmt.run(k, JSON.stringify(cfg[k]));
      }
      // Per-project configs
      if (cfg.projects) {
        const pstmt = db.prepare("INSERT OR REPLACE INTO project_configs (project, location, config) VALUES (?, ?, ?)");
        for (const [name, pc] of Object.entries(cfg.projects) as [string, any][]) {
          const loc = pc.location || "";
          const { location, ...rest } = pc;
          pstmt.run(name, loc || "", JSON.stringify(rest));
        }
      }
    } catch (e: any) {
      console.error("[orchestrator-db] migrate global_config:", e.message);
    }
  }

  // ── 2. Sessions ──
  const projDir = path.join(dir, "projects");
  if (fs.existsSync(projDir)) {
    const sstmt = db.prepare(
      "INSERT OR REPLACE INTO sessions (id, project, agent, model, tags, status, task, start_ts, end_ts, duration, session_key, extra, logged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const pname of fs.readdirSync(projDir)) {
      if (pname.startsWith(".")) continue;
      const sf = path.join(projDir, pname, "sessions.json");
      if (!fs.existsSync(sf)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(sf, "utf-8"));
        const sessions = raw?.sessions || (Array.isArray(raw) ? raw : []);
        for (const s of sessions) {
          try {
            sstmt.run(
              s.id || "",
              pname,
              s.agent || "",
              s.model || "",
              JSON.stringify(s.tags || []),
              s.status || "",
              s.task || "",
              s.start_ts || (s.logged_at ? new Date(s.logged_at).getTime() : null),
              s.end_ts || null,
              s.duration || "",
              s.session_key || "",
              JSON.stringify({
                model_provider: s.model_provider,
                qa_history: s.qa_history,
                metadata: s.metadata,
                phase: s.phase,
                extra_tags: s.extra_tags,
                hook_action: s.hook_action,
                hook_source: s.hook_source,
                timestamp: s.timestamp,
                url: s.url,
              }),
              s.logged_at || ""
            );
          } catch { /* skip bad row */ }
        }
      } catch { /* skip bad file */ }
    }
  }

  // ── 3. Backlog tasks ──
  if (fs.existsSync(projDir)) {
    const bstmt = db.prepare(
      "INSERT OR REPLACE INTO backlog_tasks (id, project, title, description, priority, status, labels, depends_on, assigned_to, session_refs, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const pname of fs.readdirSync(projDir)) {
      if (pname.startsWith(".")) continue;
      const blf = path.join(projDir, pname, "BACKLOG.json");
      if (!fs.existsSync(blf)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(blf, "utf-8"));
        const tasks = Array.isArray(raw) ? raw : (raw.tasks || []);
        for (const t of tasks) {
          try {
            bstmt.run(
              t.id || "",
              pname,
              t.title || "",
              t.description || "",
              t.priority || "p2",
              t.status || "todo",
              JSON.stringify(t.labels || []),
              JSON.stringify(t.depends_on || []),
              t.assigned_to || "",
              JSON.stringify(t.session_refs || []),
              t.created_ts || Math.floor(Date.now() / 1000),
              t.updated_ts || Math.floor(Date.now() / 1000)
            );
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  }

  // ── 4. State events ──
  if (fs.existsSync(projDir)) {
    const estmt = db.prepare("INSERT OR IGNORE INTO state_events (project, type, data, ts) VALUES (?, ?, ?, ?)");
    for (const pname of fs.readdirSync(projDir)) {
      if (pname.startsWith(".")) continue;
      const ef = path.join(projDir, pname, "state-events.jsonl");
      if (!fs.existsSync(ef)) continue;
      try {
        const lines = fs.readFileSync(ef, "utf-8").split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            estmt.run(pname, ev.type || "event", JSON.stringify(ev.data || ev), ev.ts || Math.floor(Date.now() / 1000));
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  }

  // ── 5. Models ──
  const mf = path.join(dir, "models.json");
  if (fs.existsSync(mf)) {
    try {
      const raw = JSON.parse(fs.readFileSync(mf, "utf-8"));
      const modelsList = raw?.models || [];
      const mstmt = db.prepare("INSERT OR REPLACE INTO models (id, name, provider, agent_ready, status, config) VALUES (?, ?, ?, ?, ?, ?)");
      for (const m of modelsList) {
        try {
          mstmt.run(
            m.id || "",
            m.name || m.id || "",
            m.provider || "",
            m.agent_ready !== false && m.status !== "removed" ? 1 : 0,
            m.status || "active",
            JSON.stringify(m)
          );
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  // ── 6. Live agents ──
  const laf = path.join(dir, "live-agents.json");
  if (fs.existsSync(laf)) {
    try {
      const raw = JSON.parse(fs.readFileSync(laf, "utf-8"));
      const agents = raw?.agents || [];
      const lstmt = db.prepare("INSERT OR REPLACE INTO live_agents (id, data) VALUES (?, ?)");
      for (const a of agents) {
        try { lstmt.run(a.id || a.name || "?", JSON.stringify(a)); } catch { /* */ }
      }
    } catch { /* */ }
  }

  // ── 7. Live sessions ──
  const lsf = path.join(dir, "live-sessions.json");
  if (fs.existsSync(lsf)) {
    try {
      const raw = JSON.parse(fs.readFileSync(lsf, "utf-8"));
      const sessions = raw?.sessions || [];
      const lstmt = db.prepare("INSERT OR REPLACE INTO live_sessions (id, data) VALUES (?, ?)");
      for (const s of sessions) {
        try { lstmt.run(s.id || s.session_id || "?", JSON.stringify(s)); } catch { /* */ }
      }
      // Store meta separately
      if (raw._meta) {
        db.prepare("INSERT OR REPLACE INTO global_config VALUES (?, ?)").run("live_session_meta", JSON.stringify(raw._meta));
      }
    } catch { /* */ }
  }

  // ── 8. Pending registrations ──
  const prf = path.join(dir, "projects", "pending-registrations.json");
  if (fs.existsSync(prf)) {
    try {
      const raw = JSON.parse(fs.readFileSync(prf, "utf-8"));
      const entries = Array.isArray(raw) ? raw : [];
      const prstmt = db.prepare("INSERT OR REPLACE INTO pending_registrations (session_key, project, tags, data) VALUES (?, ?, ?, ?)");
      for (const e of entries) {
        try {
          prstmt.run(
            e.session_key || e.id || "",
            e.project || "",
            JSON.stringify(e.tags || []),
            JSON.stringify(e)
          );
        } catch { /* */ }
      }
    } catch { /* */ }
  }

  // ── 9. Chat outbox ──
  const cof = path.join(dir, "chat-outbox.json");
  if (fs.existsSync(cof)) {
    try {
      const raw = JSON.parse(fs.readFileSync(cof, "utf-8"));
      const entries = Array.isArray(raw) ? raw : [];

      for (const e of entries) {
      }
    } catch { /* */ }
  }

  // ── 10. Control results ──
  const ctrlDir = path.join(dir, "control");
  if (fs.existsSync(ctrlDir)) {
    const crstmt = db.prepare("INSERT OR IGNORE INTO control_results (name, data, ts) VALUES (?, ?, ?)");
    for (const fn of fs.readdirSync(ctrlDir)) {
      if (!fn.endsWith(".json")) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(ctrlDir, fn), "utf-8"));
        crstmt.run(fn.replace(".result.json", ""), JSON.stringify(data), Math.floor(Date.now() / 1000));
      } catch { /* */ }
    }
  }

  // ── 11. Logs ──
  const logf = path.join(dir, "logs", "orchestrator.jsonl");
  if (fs.existsSync(logf)) {
    try {
      const lines = fs.readFileSync(logf, "utf-8").split("\n").filter(Boolean);
      const lstmt = db.prepare("INSERT OR IGNORE INTO logs (level, source, message, data, ts) VALUES (?, ?, ?, ?, ?)");
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          lstmt.run(e.level || "info", e.source || "", e.message || "", JSON.stringify(e.data || {}), e.ts || Math.floor(Date.now() / 1000));
        } catch { /* */ }
      }
    } catch { /* */ }
  }

  console.log("[orchestrator-db] Migration complete.");
}

// ── GLOBAL CONFIG ──────────────────────────────────────────────

export function getGlobalConfig(key: string): any {
  const row = getDb().prepare("SELECT value FROM global_config WHERE key = ?").get(key) as any;
  if (!row) return undefined;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export function getAllGlobalConfig(limit = 500): Record<string, any> {
  const rows = getDb().prepare("SELECT key, value FROM global_config LIMIT ?").all(limit) as any[];
  const result: Record<string, any> = {};
  for (const r of rows) {
    try { result[r.key] = JSON.parse(r.value); } catch { result[r.key] = r.value; }
  }
  return result;
}

export function setGlobalConfig(key: string, value: any): void {
  getDb().prepare("INSERT OR REPLACE INTO global_config VALUES (?, ?)").run(key, JSON.stringify(value));
}

export function deleteGlobalConfig(key: string): void {
  getDb().prepare("DELETE FROM global_config WHERE key = ?").run(key);
}

// ── PROJECT CONFIG ─────────────────────────────────────────────

export function getProjectConfig(project: string): any {
  const row = getDb().prepare("SELECT config, location FROM project_configs WHERE project = ?").get(project) as any;
  if (!row) return {};
  const config = JSON.parse(row.config || "{}");
  if (row.location) config.location = row.location;
  return config;
}

export function getAllProjectConfigs(limit = 500): Record<string, any> {
  const rows = getDb().prepare("SELECT project, config, location FROM project_configs LIMIT ?").all(limit) as any[];
  const result: Record<string, any> = {};
  for (const r of rows) {
    const cfg = JSON.parse(r.config || "{}");
    if (r.location) cfg.location = r.location;
    result[r.project] = cfg;
  }
  return result;
}

export function setProjectConfig(project: string, config: any): void {
  const loc = config.location || "";
  const { location, ...rest } = config;
  getDb().prepare("INSERT OR REPLACE INTO project_configs (project, location, config) VALUES (?, ?, ?)").run(project, loc || "", JSON.stringify(rest));
}

export function updateProjectConfig(project: string, updates: Record<string, any>): void {
  const existing = getProjectConfig(project);
  Object.assign(existing, updates);
  setProjectConfig(project, existing);
}

export function deleteProjectConfig(project: string): void {
  getDb().prepare("DELETE FROM project_configs WHERE project = ?").run(project);
}

// ── SESSIONS ───────────────────────────────────────────────────

export function listSessions(project: string, limit = 200, offset = 0): SessionRow[] {
  return getDb().prepare(
    "SELECT * FROM sessions WHERE project = ? ORDER BY start_ts DESC LIMIT ? OFFSET ?"
  ).all(project, limit, offset) as unknown as SessionRow[];
}

export function getAllSessions(limit = 1000): SessionRow[] {
  return getDb().prepare("SELECT * FROM sessions ORDER BY start_ts DESC LIMIT ?").all(limit) as unknown as SessionRow[];
}

export function getSession(id: string): SessionRow | null {
  return (getDb().prepare("SELECT * FROM sessions WHERE id = ?").get(id) as unknown as SessionRow) || null;
}

export function addSession(session: SessionRow): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO sessions (id, project, agent, model, tags, status, task, start_ts, end_ts, duration, session_key, extra, logged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    session.id, session.project, session.agent || "", session.model || "",
    session.tags || "[]", session.status || "", session.task || "",
    session.start_ts || null, session.end_ts || null, session.duration || "",
    session.session_key || "", session.extra || "{}", session.logged_at || ""
  );
}

export function updateSession(id: string, updates: Partial<SessionRow>): void {
  const fields: string[] = [];
  const values: any[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (!SESSION_COLUMNS.has(k)) continue;
    if (k === "id") continue;
    fields.push(`${k} = ?`);
    values.push(v !== undefined ? v : null);
  }
  if (!fields.length) return;
  values.push(id);
  getDb().prepare(`UPDATE sessions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteSession(id: string): void {
  getDb().prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

export function countSessions(project: string): number {
  const row = getDb().prepare("SELECT count(*) as cnt FROM sessions WHERE project = ?").get(project) as any;
  return Number(row?.cnt) || 0;
}

// ── BACKLOG ────────────────────────────────────────────────────

export function listBacklogTasks(project: string, limit = 1000): BacklogRow[] {
  return getDb().prepare(
    "SELECT * FROM backlog_tasks WHERE project = ? ORDER BY CASE priority WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 WHEN 'p3' THEN 3 WHEN 'high' THEN 0 WHEN 'medium' THEN 2 WHEN 'low' THEN 4 ELSE 5 END, created_ts DESC LIMIT ?"
  ).all(project, limit) as unknown as BacklogRow[];
}

export function getBacklogTask(id: string): BacklogRow | null {
  return (getDb().prepare("SELECT * FROM backlog_tasks WHERE id = ?").get(id) as unknown as BacklogRow) || null;
}

export function addBacklogTask(task: BacklogRow): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO backlog_tasks (id, project, title, description, priority, status, labels, depends_on, assigned_to, session_refs, created_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    task.id, task.project, task.title, task.description || "",
    task.priority || "p2", task.status || "todo",
    task.labels || "[]", task.depends_on || "[]",
    task.assigned_to || "", task.session_refs || "[]",
    task.created_ts || Math.floor(Date.now() / 1000),
    task.updated_ts || Math.floor(Date.now() / 1000)
  );
}

export function updateBacklogTask(id: string, updates: Partial<BacklogRow>): void {
  const fields: string[] = [];
  const values: any[] = [];
  for (const [k, v] of Object.entries(updates)) {
    if (!BACKLOG_COLUMNS.has(k)) continue;
    if (k === "id" || k === "project") continue;
    fields.push(`${k} = ?`);
    values.push(v !== undefined ? v : null);
  }
  if (!fields.length) return;
  fields.push("updated_ts = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);
  getDb().prepare(`UPDATE backlog_tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteBacklogTask(id: string): void {
  getDb().prepare("DELETE FROM backlog_tasks WHERE id = ?").run(id);
}

export function deleteBacklogTasksByStatus(project: string, status: string): number {
  const r = getDb().prepare("DELETE FROM backlog_tasks WHERE project = ? AND status = ?").run(project, status);
  return Number(r.changes);
}

export function countBacklogByStatus(project: string): Record<string, number> {
  const rows = getDb().prepare(
    "SELECT status, count(*) as cnt FROM backlog_tasks WHERE project = ? GROUP BY status"
  ).all(project) as any[];
  const result: Record<string, number> = {};
  for (const r of rows) result[r.status] = Number(r.cnt);
  return result;
}

// ── STATE EVENTS ───────────────────────────────────────────────

export function addStateEvent(project: string, type: string, data: any): void {
  getDb().prepare("INSERT INTO state_events (project, type, data, ts) VALUES (?, ?, ?, ?)").run(
    project, type, JSON.stringify(data), Math.floor(Date.now() / 1000)
  );
}

export function getStateEvents(project: string, limit = 200): any[] {
  return getDb().prepare(
    "SELECT * FROM state_events WHERE project = ? ORDER BY ts DESC LIMIT ?"
  ).all(project, limit) as any[];
}

export function pruneStateEvents(project: string, cutoffTs: number): number {
  const r = getDb().prepare("DELETE FROM state_events WHERE project = ? AND ts < ?").run(project, cutoffTs);
  return Number(r.changes);
}

// ── MODELS ────────────────────────────────────────────────────

export function listModels(filterDisabled = false, project?: string): any[] {
  const db = getDb();
  let sql = "SELECT config FROM models WHERE 1=1";
  const params: any[] = [];
  if (filterDisabled) {
    sql += " AND status != 'removed'";
  }
  if (project) {
    // Check project's model_allowlist
    const pc = getProjectConfig(project);
    const wl = pc.model_allowlist;
    if (wl && wl.length) {
      sql += ` AND id IN (${wl.map(() => "?").join(",")})`;
      params.push(...wl);
    }
  }
  const rows = db.prepare(sql).all(...params) as any[];
  return rows.map((r: any) => JSON.parse(r.config));
}

export function getModel(id: string): any | null {
  const row = getDb().prepare("SELECT config FROM models WHERE id = ?").get(id) as any;
  if (!row) return null;
  return JSON.parse(row.config);
}

export function upsertModel(id: string, config: any): void {
  getDb().prepare(
    "INSERT OR REPLACE INTO models (id, name, provider, agent_ready, status, config) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    config.name || config.id || id,
    config.provider || "",
    config.agent_ready !== false && config.status !== "removed" ? 1 : 0,
    config.status || "active",
    JSON.stringify(config)
  );
}

export function updateModel(id: string, updates: Record<string, any>): void {
  const existing = getModel(id);
  if (!existing) return;
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined && v !== null) {
      if (typeof v === "object" && !Array.isArray(v) && typeof existing[k] === "object" && existing[k] !== null) {
        existing[k] = { ...existing[k], ...v };
      } else {
        existing[k] = v;
      }
    }
  }
  existing.last_edited = new Date().toISOString();
  upsertModel(id, existing);
}

export function deleteModel(id: string): void {
  getDb().prepare("DELETE FROM models WHERE id = ?").run(id);
}

export function countModels(): { total: number; active: number } {
  const total = Number((getDb().prepare("SELECT count(*) as cnt FROM models").get() as any)?.cnt) || 0;
  const active = Number((getDb().prepare("SELECT count(*) as cnt FROM models WHERE agent_ready = 1 AND status != 'removed'").get() as any)?.cnt) || 0;
  return { total, active };
}

// ── LIVE AGENTS ────────────────────────────────────────────────

export function getLiveAgents(limit = 500): any[] {
  const rows = getDb().prepare("SELECT data FROM live_agents LIMIT ?").all(limit) as any[];
  return rows.map((r: any) => JSON.parse(r.data));
}

export function setLiveAgents(agents: any[]): void {
  const db = getDb();
  db.exec("DELETE FROM live_agents");
  const stmt = db.prepare("INSERT INTO live_agents (id, data) VALUES (?, ?)");
  for (const a of agents) {
    try {
      stmt.run(a.id || a.name || "?", JSON.stringify(a));
    } catch (e: any) {
      console.error("[orchestrator-db] setLiveAgents: failed to insert agent:", e.message);
    }
  }
}

// ── LIVE SESSIONS ──────────────────────────────────────────────

export function getLiveSessions(limit = 500): { sessions: any[]; meta: any } {
  const rows = getDb().prepare("SELECT data FROM live_sessions LIMIT ?").all(limit) as any[];
  const sessions = rows.map((r: any) => JSON.parse(r.data));
  const metaRow = getDb().prepare("SELECT value FROM global_config WHERE key = 'live_session_meta'").get() as any;
  let meta = {};
  if (metaRow) {
    try { meta = JSON.parse(metaRow.value); } catch (e: any) { console.error("[orchestrator-db] getLiveSessions: invalid meta JSON:", e.message); }
  }
  return { sessions, meta };
}

export function setLiveSessions(sessions: any[], meta?: any): void {
  const db = getDb();
  db.exec("DELETE FROM live_sessions");
  const stmt = db.prepare("INSERT INTO live_sessions (id, data) VALUES (?, ?)");
  for (const s of sessions) {
    try {
      stmt.run(s.id || s.session_id || "?", JSON.stringify(s));
    } catch (e: any) {
      console.error("[orchestrator-db] setLiveSessions: failed to insert session:", e.message);
    }
  }
  if (meta) {
    setGlobalConfig("live_session_meta", meta);
  }
}

// ── PENDING REGISTRATIONS ─────────────────────────────────────

export function getPendingRegistrations(limit = 500): any[] {
  const rows = getDb().prepare("SELECT data FROM pending_registrations LIMIT ?").all(limit) as any[];
  return rows.map((r: any) => JSON.parse(r.data));
}

export function addPendingRegistration(reg: any): void {
  getDb().prepare(
    "INSERT OR REPLACE INTO pending_registrations (session_key, project, tags, data) VALUES (?, ?, ?, ?)"
  ).run(
    reg.session_key || reg.id || "",
    reg.project || "",
    JSON.stringify(reg.tags || []),
    JSON.stringify(reg)
  );
}

export function removePendingRegistration(sessionKey: string): void {
  getDb().prepare("DELETE FROM pending_registrations WHERE session_key = ?").run(sessionKey);
}



// ── CONTROL RESULTS ────────────────────────────────────────────

export function getControlResults(limit = 500): any[] {
  const rows = getDb().prepare("SELECT name, data, ts FROM control_results ORDER BY ts DESC LIMIT ?").all(limit) as any[];
  return rows.map((r: any) => ({
    name: r.name,
    data: JSON.parse(r.data),
    ts: r.ts,
  }));
}

export function addControlResult(name: string, data: any): void {
  getDb().prepare("INSERT INTO control_results (name, data, ts) VALUES (?, ?, ?)").run(
    name, JSON.stringify(data), Math.floor(Date.now() / 1000)
  );
}

// ── LOGS ───────────────────────────────────────────────────────

export function getLogs(limit = 50, level?: string): any[] {
  let sql = "SELECT * FROM logs WHERE 1=1";
  const params: any[] = [];
  if (level) {
    sql += " AND level = ?";
    params.push(level);
  }
  sql += " ORDER BY ts DESC LIMIT ?";
  params.push(limit);
  const rows = getDb().prepare(sql).all(...params) as any[];
  return rows.map((r: any) => ({
    ...r,
    data: JSON.parse(r.data || "{}"),
  }));
}

export function addLog(level: string, source: string, message: string, data?: any): void {
  getDb().prepare("INSERT INTO logs (level, source, message, data, ts) VALUES (?, ?, ?, ?, ?)").run(
    level, source, message, JSON.stringify(data || {}), Math.floor(Date.now() / 1000)
  );
}

// ── VERIFICATION PIPELINE RUNS ─────────────────────────────────

export interface VerificationRun {
  pipeline_id: string;
  project: string;
  task: string;
  criteria: string;
  phase: string;
  iteration: number;
  max_iterations: number;
  worker_session: string;
  reviewer_session: string;
  fixer_session: string;
  worker_output_path: string;
  reviewer_result: string;
  fixer_output_path: string;
  guidance: string;
  artifacts: string;
  messages: string;
  created_ts: number;
  updated_ts: number;
}

export function addVerificationRun(run: VerificationRun): void {
  const db = getDb();
  db.prepare(`INSERT INTO verification_runs (
    pipeline_id, project, task, criteria, phase, iteration, max_iterations,
    worker_session, reviewer_session, fixer_session,
    worker_output_path, reviewer_result, fixer_output_path, guidance,
    artifacts, messages, created_ts, updated_ts
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    run.pipeline_id,
    run.project,
    run.task,
    run.criteria,
    run.phase,
    run.iteration,
    run.max_iterations,
    run.worker_session || "",
    run.reviewer_session || "",
    run.fixer_session || "",
    run.worker_output_path || "",
    run.reviewer_result || "",
    run.fixer_output_path || "",
    run.guidance || "",
    run.artifacts || "[]",
    run.messages || "[]",
    run.created_ts || Math.floor(Date.now() / 1000),
    run.updated_ts || Math.floor(Date.now() / 1000)
  );
}

export function getVerificationRun(pipelineId: string): VerificationRun | null {
  const row = getDb().prepare("SELECT * FROM verification_runs WHERE pipeline_id = ?").get(pipelineId) as any;
  if (!row) return null;
  return row as unknown as VerificationRun;
}

export function updateVerificationRun(pipelineId: string, updates: Partial<VerificationRun>): void {
  const fields: string[] = [];
  const values: any[] = [];
  const allowed = ["phase", "iteration", "worker_session", "reviewer_session", "fixer_session",
    "worker_output_path", "reviewer_result", "fixer_output_path", "artifacts", "messages", "guidance"];
  for (const key of allowed) {
    if ((updates as any)[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push((updates as any)[key]);
    }
  }
  if (fields.length === 0) return;
  fields.push("updated_ts = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(pipelineId);
  getDb().prepare(`UPDATE verification_runs SET ${fields.join(", ")} WHERE pipeline_id = ?`).run(...values);
}

export function listVerificationRuns(project?: string, limit = 20): VerificationRun[] {
  let sql = "SELECT * FROM verification_runs";
  const params: any[] = [];
  if (project) {
    sql += " WHERE project = ?";
    params.push(project);
  }
  sql += " ORDER BY created_ts DESC LIMIT ?";
  params.push(limit);
  return getDb().prepare(sql).all(...params) as unknown as VerificationRun[];
}
