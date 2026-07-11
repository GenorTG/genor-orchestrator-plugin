// ═══════════════════════════════════════════════════════════════
//  MAINTENANCE SERVICE — Periodic background tasks:
//  - Log rotation
//  - Project doc regeneration (RECOVERY.md, STATE.md)
//  - Live agents safety checks (stale agent detection)
//  - Control action processing
//  Extracted from src/index.ts as part of the slice refactor.
// ═══════════════════════════════════════════════════════════════

import * as fs from "node:fs";
import * as path from "node:path";
import { OrchestratorLogger } from "./logger.js";
import {
  generateRecoveryDoc,
  getProjectLocation,
  syncProjectToOrchestrator,
  generateStateFromEvents,
} from "./legacy-helpers.js";
import { controlDir, writeActionResult, processControlAction } from "./control-actions.js";
import { getAllGlobalConfig, getLiveAgents } from "./db.js";

export class MaintenanceService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private dataDir: string;
  private logger: OrchestratorLogger;
  private safeguardLog: string[] = [];

  constructor(dataDir: string, logger: OrchestratorLogger) {
    this.dataDir = dataDir;
    this.logger = logger;
  }

  start(intervalMs: number = 30 * 60_000): void {
    if (this.started) return;
    this.started = true;
    // First tick sooner for safeguards
    setTimeout(() => this.tick(), 15_000);
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.logger.info("maintenance", `Started (every ${Math.round(intervalMs / 60000)}min)`);
  }

  tick(): void {
    try {
      this.logger.cleanup();
      const popLog = path.join(this.dataDir, "logs", "auto-populate.log");
      if (fs.existsSync(popLog)) {
        const stat = fs.statSync(popLog);
        if (Date.now() - stat.mtimeMs > 90 * 24 * 60 * 60_000) {
          fs.truncateSync(popLog, 0);
          this.logger.debug("maintenance", "Rotated auto-populate.log");
        }
      }
      // Process control actions (dashboard → plugin commands)
      this.processControlActions();
      // Check agent health (safeguards)
      this.detectStaleAgents();
      // Process projects
      const projDirPath = path.join(this.dataDir, "projects");
      if (!fs.existsSync(projDirPath)) return;
      const projects = fs.readdirSync(projDirPath).filter(f =>
        !f.startsWith(".") && fs.statSync(path.join(projDirPath, f)).isDirectory()
      );
      for (const p of projects) {
        try {
          generateRecoveryDoc(p, this.dataDir, this.logger);
          if (getProjectLocation(p, this.dataDir)) {
            syncProjectToOrchestrator(p, this.dataDir, this.logger);
          }
          // Auto-generate state from event log on every tick
          generateStateFromEvents(p, this.dataDir, this.logger);
        } catch (err: any) {
          this.logger.warn("maintenance", `Error processing ${p}: ${err.message}`);
        }
      }
      this.logger.debug("maintenance", `Tick: ${projects.length} projects processed, control actions checked`);
    } catch (err: any) {
      this.logger.warn("maintenance", `Tick error: ${err.message}`);
    }
  }

  processControlActions(): void {
    try {
      const cd = controlDir(this.dataDir);
      if (!fs.existsSync(cd)) return;
      const files = fs.readdirSync(cd)
        .filter(f => f.endsWith(".action.json"))
        .sort()
        .slice(0, 5); // Max 5 per tick
      for (const f of files) {
        const fp = path.join(cd, f);
        try {
          const raw = fs.readFileSync(fp, "utf-8");
          const action: any = JSON.parse(raw);
          if (!action.id || !action.action) {
            this.logger.warn("control", `Invalid action file: ${f}`);
            fs.unlinkSync(fp);
            continue;
          }
          // Check TTL
          if (action.ttl_seconds && action.created_at) {
            const age = Date.now() - new Date(action.created_at).getTime();
            if (age > action.ttl_seconds * 1000) {
              writeActionResult(this.dataDir, action.id, false, null, "Action timed out");
              fs.unlinkSync(fp);
              continue;
            }
          }
          processControlAction(this.dataDir, action, this.logger);
          fs.unlinkSync(fp);
        } catch (err: any) {
          this.logger.warn("control", `Error processing ${f}: ${err.message}`);
          // Remove malformed actions to avoid re-processing
          try { fs.unlinkSync(fp); } catch { /* non-critical - action file may already be gone */ }
        }
      }
    } catch (err: any) {
      this.logger.warn("control", `processControlActions error: ${err.message}`);
    }
  }

  detectStaleAgents(): void {
    try {
      const cfg = getAllGlobalConfig();
      const safeguards = cfg.safeguards || {};
      if (safeguards.enabled === false) return;

      const idleTimeout = safeguards.idle_timeout_ms || 10 * 60 * 1000;      // 10 min
      const stuckTimeout = safeguards.stuck_timeout_ms || 30 * 60 * 1000;    // 30 min
      const maxErrors = safeguards.max_errors_before_escalation || 3;
      const now = Date.now();

        let agents: any[] = [];
      try {
        agents = getLiveAgents();
      } catch (e: any) { this.logger.debug("maintenance", "Failed to fetch live agents:", e.message); }
      let recoveryNeeded = false;

      for (const a of agents) {
        if (!a.project) continue; // Skip agents without active project

        const status = a.agent_status || "";
        const lastActivity = a.last_activity_at ? new Date(a.last_activity_at).getTime() : 0;
        const lastUpdate = a.timestamp ? new Date(a.timestamp).getTime() : 0;
        const elapsedSinceActivity = lastActivity ? now - lastActivity : 0;
        const elapsedSinceUpdate = lastUpdate ? now - lastUpdate : 0;
        const elapsedHuman = a.elapsed || "?";
        const errorCount = a.error_count || 0;
        const agentName = a.agent || "?";

        // Check 1: Agent is idle with active project for too long
        if (status === "idle" && elapsedSinceActivity > idleTimeout) {
          this.logger.warn("safeguard", `Agent ${agentName} idle for ${Math.round(elapsedSinceActivity/1000)}s (project: ${a.project})`);
          this.safeguardLog.push(`[${new Date().toISOString()}] IDLE: ${agentName} idle ${Math.round(elapsedSinceActivity/60000)}m on ${a.project}`);
          
          if (safeguards.auto_recover !== false && a.project) {
            // Auto-recover: write a set_context action for the same project
            const actionId = `recover_${agentName}_${Date.now()}`;
            const action = {
              id: actionId,
              action: "set_context" as const,
              params: { project: a.project, task: a.task || "auto-recovery" },
              created_at: new Date().toISOString(),
              ttl_seconds: 30,
            };
            try {
              const cd = controlDir(this.dataDir);
              if (!fs.existsSync(cd)) fs.mkdirSync(cd, { recursive: true });
              fs.writeFileSync(
                path.join(cd, `${actionId}.action.json`),
                JSON.stringify(action, null, 2)
              );
              this.logger.info("safeguard", `Auto-recovery triggered for ${agentName} on ${a.project}`);
              this.safeguardLog.push(`[${new Date().toISOString()}] RECOVER: ${agentName} → set_context ${a.project}`);
              recoveryNeeded = true;
            } catch (err: any) {
              this.logger.warn("safeguard", `Auto-recovery write failed: ${err.message}`);
            }
          }
        }

        // Check 2: Agent hasn't updated in too long despite having project context
        // Skip actively-working statuses (prompting/running = AI is building a response)
        if (status !== "idle" && status !== "done" && status !== "running" && elapsedSinceUpdate > stuckTimeout) {
          this.logger.warn("safeguard", `Agent ${agentName} stuck (no update ${Math.round(elapsedSinceUpdate/60000)}m, status: ${status})`);
          this.safeguardLog.push(`[${new Date().toISOString()}] STUCK: ${agentName} no update ${Math.round(elapsedSinceUpdate/60000)}m (${status})`);
        }

        // Check 3: Error storm
        if (errorCount >= maxErrors) {
          this.logger.warn("safeguard", `Agent ${agentName} hit ${errorCount} errors — escalation needed`);
          this.safeguardLog.push(`[${new Date().toISOString()}] ESCALATE: ${agentName} ${errorCount} errors`);
        }
      }

      // Write safeguard log if anything was detected
      if (this.safeguardLog.length > 0) {
        const logPath = path.join(this.dataDir, "safeguard-log.md");
        const existing = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8") : "# Safeguard Recovery Log\n\n| Timestamp | Event | Details |\n|-----------|-------|---------|\n";
        const lines = this.safeguardLog.map(s => {
          const parts = s.match(/\[(.*?)\] (\w+): (.*)/);
          if (parts) return `| ${parts[1]} | ${parts[2]} | ${parts[3]} |`;
          return `| ${new Date().toISOString()} | INFO | ${s} |`;
        });
        fs.writeFileSync(logPath, existing + lines.join("\n") + "\n");
        this.safeguardLog = [];
      }

      if (recoveryNeeded) {
        this.logger.info("safeguard", "Recovery actions written — next tick will process them");
      }
    } catch (err: any) {
      this.logger.warn("safeguard", `detectStaleAgents error: ${err.message}`);
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
