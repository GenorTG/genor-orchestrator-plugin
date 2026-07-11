/**
 * Stall Detector — monitors OpenClaw session file for worker activity.
 *
 * Uses fs.watch() on the .jsonl session file. When OpenClaw writes
 * to the session (tool calls, responses, etc.), the file changes and
 * we reset the inactivity timer. If no changes for STALL_TIMEOUT_MS,
 * the worker is considered stalled.
 *
 * Fallback: fs.stat() polling every 5s if fs.watch fails.
 */

import fs from "fs";
import path from "path";
import os from "os";

const SESSIONS_JSON = path.join(
  os.homedir(),
  ".openclaw/agents/main/sessions/sessions.json",
);

export interface StallDetectorOptions {
  /** Worker session key, e.g. "agent:main:worker:w1783787355050" */
  sessionKey: string;
  /** Ms without activity before declaring stall (default: 180000 = 3min) */
  stallTimeoutMs?: number;
  /** Ms between stat polls when watch fallback is active (default: 5000) */
  pollIntervalMs?: number;
  /** Called when stall is detected */
  onStall: (detail: { since: number; idleMs: number }) => void;
}

export interface StallDetector {
  /** Start monitoring. Returns immediately. */
  start(): void;
  /** Stop monitoring and clean up watchers. */
  stop(): void;
  /** Manually reset the activity timer (e.g. after tool call). */
  touch(): void;
  /** Current state. */
  status(): { active: boolean; idleMs: number; method: string };
}

/**
 * Resolve the .jsonl session file path from sessions.json.
 * Returns null if not found.
 */
function resolveSessionFile(sessionKey: string): string | null {
  try {
    const raw = fs.readFileSync(SESSIONS_JSON, "utf8");
    const data = JSON.parse(raw);
    const session = data[sessionKey];
    return session?.sessionFile ?? null;
  } catch {
    return null;
  }
}

export function createStallDetector(
  opts: StallDetectorOptions,
): StallDetector {
  const {
    sessionKey,
    stallTimeoutMs = 180_000,
    pollIntervalMs = 5_000,
    onStall,
  } = opts;

  let watcher: fs.FSWatcher | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  let lastActivity = Date.now();
  let method = "none";
  let active = false;

  function resetStallTimer() {
    lastActivity = Date.now();
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (active) {
        active = false;
        onStall({ since: lastActivity, idleMs: Date.now() - lastActivity });
      }
    }, stallTimeoutMs);
  }

  function onActivity() {
    if (!active) return;
    resetStallTimer();
  }

  function startWatching(filePath: string) {
    // Primary: fs.watch on .jsonl
    try {
      watcher = fs.watch(filePath, onActivity);
      watcher.on("error", () => {
        // Watch failed, fall back to polling
        startPolling(filePath);
      });
      method = "fs.watch";
      active = true;
      resetStallTimer();
      return;
    } catch {
      // fs.watch failed (e.g. file gone), fall back
    }

    // Fallback: stat polling
    startPolling(filePath);
  }

  function startPolling(filePath: string) {
    // Clean up any existing watcher
    if (watcher) {
      watcher.close();
      watcher = null;
    }

    method = "fs.stat+poll";
    active = true;
    let lastMtime = 0;

    try {
      const stat = fs.statSync(filePath);
      lastMtime = stat.mtimeMs;
    } catch {
      // File might not exist yet
    }

    resetStallTimer();

    pollTimer = setInterval(() => {
      if (!active) return;
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs !== lastMtime) {
          lastMtime = stat.mtimeMs;
          onActivity();
        }
      } catch {
        // File missing — could be session rotation, try to re-resolve
        const newPath = resolveSessionFile(sessionKey);
        if (newPath && newPath !== filePath) {
          // Session rotated, watch new file
          if (pollTimer) clearInterval(pollTimer);
          startWatching(newPath);
        }
      }
    }, pollIntervalMs);
  }

  return {
    start() {
      const filePath = resolveSessionFile(sessionKey);
      if (!filePath) {
        // No session file yet — start polling sessions.json
        method = "sessions.json+poll";
        active = true;
        resetStallTimer();

        pollTimer = setInterval(() => {
          if (!active) return;
          const newPath = resolveSessionFile(sessionKey);
          if (newPath) {
            if (pollTimer) clearInterval(pollTimer);
            startWatching(newPath);
          }
        }, pollIntervalMs);
        return;
      }

      startWatching(filePath);
    },

    stop() {
      active = false;
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    },

    touch() {
      onActivity();
    },

    status() {
      return {
        active,
        idleMs: active ? Date.now() - lastActivity : 0,
        method,
      };
    },
  };
}
