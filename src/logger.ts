// ═══════════════════════════════════════════════════════════════
//  LOGGER — JSONL-based, level-filtered, auto-cleanup
// ═══════════════════════════════════════════════════════════════

import * as fs from "node:fs";
import * as path from "node:path";

export interface LogEntry {
  ts: string;
  level: string;
  source: string;
  msg: string;
  data?: Record<string, any>;
}

export class OrchestratorLogger {
  private logFile: string;
  private level: string;
  private retentionDays: number;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private static LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

  constructor(dataDir: string, level: string = "info", retentionDays: number = 30) {
    const logDir = path.join(dataDir, "logs");
    fs.mkdirSync(logDir, { recursive: true });
    this.logFile = path.join(logDir, "orchestrator.jsonl");
    this.level = level;
    this.retentionDays = retentionDays;
    this.cleanupTimer = setInterval(() => this.cleanup(), 6 * 3600_000);
    setTimeout(() => this.cleanup(), 60_000);
  }

  private shouldLog(lvl: string): boolean {
    return (OrchestratorLogger.LEVELS[lvl.toLowerCase()] ?? 1) >= (OrchestratorLogger.LEVELS[this.level] ?? 1);
  }

  private write(level: string, source: string, msg: string, data?: Record<string, any>): void {
    if (!this.shouldLog(level)) return;
    try {
      const entry: LogEntry = { ts: new Date().toISOString(), level, source, msg };
      if (data && Object.keys(data).length > 0) entry.data = data;
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + "\n", "utf-8");
    } catch { /* logging never crashes */ }
  }

  debug = (source: string, msg: string, data?: any) => this.write("debug", source, msg, data);
  info = (source: string, msg: string, data?: any) => this.write("info", source, msg, data);
  warn = (source: string, msg: string, data?: any) => this.write("warn", source, msg, data);
  error = (source: string, msg: string, data?: any) => this.write("error", source, msg, data);

  logRouting(modelId: string, project: string | null, eligible: number, total: number, filters: string[]): void {
    this.info("routing", `Model check for ${project ?? "global"}: ${eligible}/${total} eligible`, { project, eligible, total, filters });
  }

  logSession(project: string, task: string, model: string, agent: string, status: string): void {
    this.info("session", `${project}/${task} → ${status}`, { project, task, model, agent, status });
  }

  logConfigChange(key: string, value: any): void {
    this.info("config", `Config changed: ${key}`, { key, value });
  }

  query(limit: number = 50, opts?: { level?: string; source?: string; since?: string }): LogEntry[] {
    if (!fs.existsSync(this.logFile)) return [];
    try {
      const content = fs.readFileSync(this.logFile, "utf-8");
      const entries: LogEntry[] = [];
      for (const line of content.trim().split("\n").filter(Boolean)) {
        try {
          const e = JSON.parse(line) as LogEntry;
          if (opts?.level && !this.shouldLog(opts.level)) continue;
          if (opts?.source && !e.source.includes(opts.source)) continue;
          if (opts?.since && e.ts < opts.since) continue;
          entries.push(e);
        } catch { /* skip malformed */ }
      }
      return entries.slice(-limit);
    } catch { return []; }
  }

  cleanup(): void {
    if (!fs.existsSync(this.logFile)) return;
    const cutoff = Date.now() - this.retentionDays * 86400_000;
    try {
      const content = fs.readFileSync(this.logFile, "utf-8");
      const kept = content.trim().split("\n").filter(line => {
        try { return new Date(JSON.parse(line).ts).getTime() > cutoff; } catch { return false; }
      });
      fs.writeFileSync(this.logFile, kept.join("\n") + (kept.length ? "\n" : ""), "utf-8");
    } catch { /* fail silently */ }
  }

  stop(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }
}
