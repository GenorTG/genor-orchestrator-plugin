/**
 * Centralized Data Store for the genor-orchestrator-plugin.
 *
 * Service layer between HTTP handlers and db.ts.
 * Returns CONSISTENTLY-SHAPED data (camelCase, ISO dates, numbers for counts).
 * NEVER throws — returns null/[] on missing data.
 * Reads from db.ts only (no direct SQL).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import * as db from "./db.js";
import { getDataDir } from "./shared.js";

// ═══════════════════════════════════════════════════════════════
//  CANONICAL TYPES
// ═══════════════════════════════════════════════════════════════

export interface ProjectRecord {
  name: string;
  displayName: string | null;
  location: string;
  exists: boolean;
  fileCount: number;
  repoUrl: string;
  hasGit: boolean;
  branch: string;
  lastCommit: string;
  workerCount: number;
  taskCount: number;
  sessionCount: number;
  hasWorkers: boolean;
  repo: any | null;
}

export interface WorkerRecord {
  id: string;
  name: string;
  role: string;
  sprite: string;
  model: string;
  prompt: string;
  room: string;
  status: string;
  project: string;
  isPm: boolean;
  isOrchestrator: boolean;
  createdAt: string;
}

export interface RoomRecord {
  id: string;
  name: string;
  purpose: string;
  taskTypes: string[];
  project: string;
  x: number;
  y: number;
  w: number;
  h: number;
  isCommand: boolean;
  createdAt: string;
  color: string;
  tag: string;
  layout: string;
}

export interface BacklogTask {
  id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  labels: string[];
  dependsOn: string[];
  assignedTo: string;
  workerId: string | null;
  sessionRefs: string[];
  createdTs: number;
  updatedTs: number;
}

export interface ModelRecord {
  id: string;
  name: string;
  provider: string;
  agentReady: boolean;
  status: string;
  [key: string]: any;
}

export interface PmChatMessage {
  id: number;
  message: string;
  sender: string;
  project: string;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  project: string;
  agent: string;
  model: string;
  tags: string[];
  status: string;
  task: string;
  startTs: number | null;
  endTs: number | null;
  duration: string;
  sessionKey: string;
  loggedAt: string;
  workerId?: string;
  contextUsed?: string;
  [key: string]: any;
}

export interface VaultDocRecord {
  folder: string | null;
  icon: string;
  title: string;
  updated: string;
  tags: string[];
  status: string;
  links: string[];
  html: string;
}

export interface BootstrapData {
  defaultProjectId: string;
  projects: Record<string, any>;
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

function gitExec(location: string, args: string[], timeout = 15000): string {
  if (!fs.existsSync(path.join(location, ".git"))) return "";
  try {
    return execSync(`git ${args.join(" ")}`, {
      cwd: location,
      encoding: "utf-8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

function getRepoStatus(location: string): any | null {
  const gitDir = path.join(location, ".git");
  if (!fs.existsSync(gitDir)) {
    return null;
  }
  const branch = gitExec(location, ["rev-parse", "--abbrev-ref", "HEAD"]) || "unknown";
  const lastCommitRaw = gitExec(location, ["log", "--oneline", "-1"]);
  const lastCommit = lastCommitRaw || "";
  const remote = gitExec(location, ["remote", "get-url", "origin"]) || "";
  const statusOut = gitExec(location, ["status", "--porcelain"]) || "";
  const dirty = statusOut.length > 0;
  let ahead = 0;
  let behind = 0;
  if (remote) {
    try {
      const revList = gitExec(location, ["rev-list", "--left-right", "--count", `${branch}...${branch}@{upstream}`], 10000);
      if (revList) {
        const parts = revList.split(/\s+/);
        ahead = parseInt(parts[0], 10) || 0;
        behind = parseInt(parts[1], 10) || 0;
      }
    } catch { /* no upstream */ }
  }
  return { hasRepo: true, branch, dirty, lastCommit, remote, ahead, behind };
}

// ═══════════════════════════════════════════════════════════════
//  PROJECT STORE
// ═══════════════════════════════════════════════════════════════

export function listProjects(): ProjectRecord[] {
  try {
    const dataDir = getDataDir();
    const projectsDir = path.join(dataDir, "projects");
    const allConfigs = db.getAllProjectConfigs(500);

    const projects: ProjectRecord[] = [];
    for (const [name, cfg] of Object.entries(allConfigs) as [string, any][]) {
      const location = cfg.location || path.join(projectsDir, name);
      const configJson = cfg.config ? (typeof cfg.config === "string" ? JSON.parse(cfg.config) : cfg.config) : {};
      const exists = fs.existsSync(location);
      let fileCount = 0;
      let repoUrl = configJson.repo_url || "";
      let hasGit = false;
      let branch = "";
      let lastCommit = "";
      let repoStatus: any = null;

      if (exists) {
        try {
          const entries = fs.readdirSync(location, { withFileTypes: true });
          fileCount = entries.filter((e) => e.name !== ".git").length;
          hasGit = fs.existsSync(path.join(location, ".git"));
          if (hasGit) {
            repoStatus = getRepoStatus(location);
            branch = repoStatus?.branch || "";
            lastCommit = repoStatus?.lastCommit || "";
          }
        } catch { /* stat failed */ }
      }

      const workerCount = db.countWorkers(name);
      const taskCount = db.countBacklogByProject(name);
      const sessionCount = db.countSessions(name);

      projects.push({
        name,
        displayName: configJson.displayName || null,
        location,
        exists,
        fileCount,
        repoUrl,
        hasGit,
        branch,
        lastCommit,
        workerCount,
        taskCount,
        sessionCount,
        hasWorkers: workerCount > 0,
        repo: repoStatus,
      });
    }

    return projects;
  } catch {
    return [];
  }
}

export function getProject(name: string): ProjectRecord | null {
  try {
    const all = listProjects();
    return all.find((p) => p.name === name) || null;
  } catch {
    return null;
  }
}

export function getProjectBootstrap(project: string): BootstrapData {
  const workers = db.listWorkers(project);
  const rooms = db.listRooms(project);
  const tasks = db.listBacklogTasks(project);
  const vaultDocs = db.listVaultDocs(project);
  const allConfigs = db.getAllProjectConfigs(500);
  const projectNames = Object.keys(allConfigs);

  // Build projects map with full detail for requested project
  const projects: Record<string, any> = {};

  // Fill all projects with basic info
  for (const pId of projectNames) {
    const pc = allConfigs[pId] as any;
    const loc = pc.location || "";
    let repoStatus: any = null;
    if (loc && fs.existsSync(loc)) {
      repoStatus = getRepoStatus(loc);
    }
    projects[pId] = {
      id: pId,
      name: pId,
      hasWorkers: db.countWorkers(pId) > 0,
      repoUrl: pc.repo_url || "",
      repo: repoStatus,
    };
  }

  // Fill current project with full detail
  const pc = allConfigs[project] || {};
  const loc = pc.location || "";
  let repoStatus: any = null;
  if (loc && fs.existsSync(loc)) {
    repoStatus = getRepoStatus(loc);
  }

  projects[project] = {
    id: project,
    name: project,
    hasWorkers: workers.length > 0,
    repoUrl: pc.repo_url || "",
    repo: repoStatus,
    rooms: rooms.map((r) => ({
      id: r.id,
      name: r.name,
      tag: r.id,
      color: "#5e9cff",
      isCommand: r.isCommand === 1,
      purpose: r.purpose,
      taskTypes: parseJsonSafe(r.taskTypes || "[]", []),
      layout: "auto",
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
    })),
    workers: workers.map((w) => ({
      id: w.id,
      name: w.name,
      role: w.role,
      sprite: w.sprite,
      model: w.model,
      status: w.status,
      task: null,
      progress: 0,
      room: w.room,
      isOrchestrator: w.is_pm === 1 || w.role.toLowerCase().includes("project manager"),
      is_pm: w.is_pm === 1,
      prompt: w.prompt,
      ctx: "—",
    })),
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      desc: t.description,
      worker: t.worker_id || null,
      phase: t.status,
      pri: t.priority,
      type: parseJsonSafe(t.labels || "[]", [])[0] || "dev",
    })),
    vault: vaultDocsToMap(vaultDocs),
  };

  return { defaultProjectId: project, projects };
}

function vaultDocsToMap(vaultDocs: any[]): Record<string, VaultDocRecord> {
  const result: Record<string, VaultDocRecord> = {};
  for (const doc of vaultDocs) {
    result[doc.path] = {
      folder: doc.folder || null,
      icon: doc.icon || "📄",
      title: doc.title,
      updated: doc.updated_at || "",
      tags: parseJsonSafe(doc.tags || "[]", []),
      status: doc.status || "",
      links: parseJsonSafe(doc.links || "[]", []),
      html: doc.content || "",
    };
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
//  WORKER STORE
// ═══════════════════════════════════════════════════════════════

export function listWorkers(project: string): WorkerRecord[] {
  try {
    const rows = db.listWorkers(project);
    return rows.map((w) => ({
      id: w.id,
      name: w.name,
      role: w.role,
      sprite: w.sprite,
      model: w.model,
      prompt: w.prompt || "",
      room: w.room,
      status: w.status,
      project: w.project,
      isPm: w.is_pm === 1,
      isOrchestrator: w.is_pm === 1 || w.role.toLowerCase().includes("project manager"),
      createdAt: w.created_at || "",
    }));
  } catch {
    return [];
  }
}

export function getWorkerRecord(id: string): WorkerRecord | null {
  try {
    const w = db.getWorker(id);
    if (!w) return null;
    return {
      id: w.id,
      name: w.name,
      role: w.role,
      sprite: w.sprite,
      model: w.model,
      prompt: w.prompt || "",
      room: w.room,
      status: w.status,
      project: w.project,
      isPm: w.is_pm === 1,
      isOrchestrator: w.is_pm === 1 || w.role.toLowerCase().includes("project manager"),
      createdAt: w.created_at || "",
    };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  ROOM STORE
// ═══════════════════════════════════════════════════════════════

export function listRooms(project: string): RoomRecord[] {
  try {
    const rows = db.listRooms(project);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      purpose: r.purpose,
      taskTypes: parseJsonSafe(r.taskTypes || "[]", []),
      project: r.project,
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      isCommand: r.isCommand === 1,
      createdAt: r.created_at || "",
      color: "#5e9cff",
      tag: r.id,
      layout: "auto",
    }));
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
//  BACKLOG STORE
// ═══════════════════════════════════════════════════════════════

export function listBacklog(project: string): BacklogTask[] {
  try {
    const rows = db.listBacklogTasks(project);
    return rows.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description || "",
      priority: t.priority || "p2",
      status: t.status || "todo",
      labels: parseJsonSafe(t.labels || "[]", []),
      dependsOn: parseJsonSafe(t.depends_on || "[]", []),
      assignedTo: t.assigned_to || "",
      workerId: t.worker_id || null,
      sessionRefs: parseJsonSafe(t.session_refs || "[]", []),
      createdTs: t.created_ts,
      updatedTs: t.updated_ts,
    }));
  } catch {
    return [];
  }
}

export function getBacklogTaskRecord(id: string): BacklogTask | null {
  try {
    const t = db.getBacklogTask(id);
    if (!t) return null;
    return {
      id: t.id,
      title: t.title,
      description: t.description || "",
      priority: t.priority || "p2",
      status: t.status || "todo",
      labels: parseJsonSafe(t.labels || "[]", []),
      dependsOn: parseJsonSafe(t.depends_on || "[]", []),
      assignedTo: t.assigned_to || "",
      workerId: t.worker_id || null,
      sessionRefs: parseJsonSafe(t.session_refs || "[]", []),
      createdTs: t.created_ts,
      updatedTs: t.updated_ts,
    };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  MODEL STORE
// ═══════════════════════════════════════════════════════════════

export function listModels(agentReadyOnly = true, project?: string): ModelRecord[] {
  try {
    const rows = db.listModels(false, project);
    let models = rows.map((m: any) => ({
      id: m.id || m.name || "",
      name: m.name || m.id || "",
      provider: m.provider || "",
      agentReady: m.agent_ready !== false && m.status !== "removed",
      status: m.status || "active",
      ...Object.fromEntries(Object.entries(m).filter(([k]) => !["config", "id", "name", "provider", "agent_ready", "status"].includes(k))),
    }));
    if (agentReadyOnly) {
      models = models.filter((m) => m.agentReady);
    }
    return models;
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
//  PM CHAT STORE
// ═══════════════════════════════════════════════════════════════

export function listPmChat(project: string): PmChatMessage[] {
  try {
    const rows = db.listPmChat(project);
    return rows.map((m) => ({
      id: m.id,
      message: m.message,
      sender: m.sender || "",
      project: m.project,
      createdAt: m.created_at || "",
    }));
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
//  SESSION STORE
// ═══════════════════════════════════════════════════════════════

export function listSessions(project: string, limit = 200, offset = 0): SessionRecord[] {
  try {
    const rows = db.listSessions(project, limit, offset);
    return rows.map((s) => ({
      id: s.id,
      project: s.project,
      agent: s.agent || "",
      model: s.model || "",
      tags: parseJsonSafe(s.tags || "[]", []),
      status: s.status || "",
      task: s.task || "",
      startTs: s.start_ts || null,
      endTs: s.end_ts || null,
      duration: s.duration || "",
      sessionKey: s.session_key || "",
      loggedAt: s.logged_at || "",
      workerId: (s as any).worker_id || undefined,
      contextUsed: (s as any).context_used || undefined,
      extra: s.extra || "{}",
    }));
  } catch {
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
//  VAULT DOC STORE
// ═══════════════════════════════════════════════════════════════

export function listVaultDocs(project: string): Record<string, VaultDocRecord> {
  try {
    const docs = db.listVaultDocs(project);
    return vaultDocsToMap(docs);
  } catch {
    return {};
  }
}

// ═══════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════

function parseJsonSafe(json: string, fallback: any): any {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

/**
 * Update worker status in db.
 */
export function setWorkerStatus(id: string, status: string): void {
  try {
    db.updateWorker(id, { status } as any);
  } catch { /* noop */ }
}

/**
 * Update backlog task status.
 */
export function setBacklogTaskStatus(id: string, status: string, workerId?: string | null): void {
  try {
    const updates: any = { status };
    if (workerId !== undefined) updates.worker_id = workerId;
    db.updateBacklogTask(id, updates);
  } catch { /* noop */ }
}

/**
 * Update room layout.
 */
export function updateRoomLayout(id: string, x: number, y: number, w: number, h: number): void {
  try {
    db.updateRoom(id, { x, y, w, h } as any);
  } catch { /* noop */ }
}
