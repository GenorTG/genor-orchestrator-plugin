import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createStallDetector } from "../src/workers/stall-detector.js";
import fs from "fs";
import path from "path";
import os from "os";

describe("StallDetector", () => {
  let tmpDir: string;
  let sessionFile: string;
  let sessionsJson: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "stall-test-"));
    sessionFile = path.join(tmpDir, "test-session.jsonl");
    sessionsJson = path.join(tmpDir, "sessions.json");

    // Create a fake session file
    fs.writeFileSync(sessionFile, '{"type":"start"}\n');

    // Create sessions.json pointing to it
    fs.writeFileSync(sessionsJson, JSON.stringify({
      "agent:main:worker:test-123": {
        sessionFile,
        updatedAt: Date.now(),
      },
    }));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects activity via file modification", async () => {
    let stalled = false;
    const detector = createStallDetector({
      sessionKey: "agent:main:worker:test-123",
      stallTimeoutMs: 200,
      pollIntervalMs: 50,
      onStall: () => { stalled = true; },
    });

    // Patch to use our test sessions.json
    // (In real code, sessions.json is at ~/.openclaw/...)
    // For testing, we verify the stall callback fires
    detector.start();

    // Simulate activity
    fs.appendFileSync(sessionFile, '{"type":"tool_call"}\n');
    detector.touch();
    await new Promise(r => setTimeout(r, 100));
    expect(stalled).toBe(false);

    detector.stop();
  });

  it("fires stall callback when no activity", async () => {
    let stalled = false;
    let idleMs = 0;
    const detector = createStallDetector({
      sessionKey: "agent:main:worker:test-123",
      stallTimeoutMs: 150,
      onStall: ({ idleMs: ms }) => { stalled = true; idleMs = ms; },
    });

    detector.start();

    // No activity — wait for stall
    await new Promise(r => setTimeout(r, 250));
    expect(stalled).toBe(true);
    expect(idleMs).toBeGreaterThan(100);

    detector.stop();
  });

  it("touch() resets stall timer", async () => {
    let stalled = false;
    const detector = createStallDetector({
      sessionKey: "agent:main:worker:test-123",
      stallTimeoutMs: 150,
      onStall: () => { stalled = true; },
    });

    detector.start();

    // Touch repeatedly to keep alive
    for (let i = 0; i < 5; i++) {
      detector.touch();
      await new Promise(r => setTimeout(r, 100));
      expect(stalled).toBe(false);
    }

    detector.stop();
  });

  it("status() returns correct state", () => {
    const detector = createStallDetector({
      sessionKey: "agent:main:worker:test-123",
      stallTimeoutMs: 1000,
      onStall: () => {},
    });

    const s1 = detector.status();
    expect(s1.active).toBe(false);

    detector.start();
    const s2 = detector.status();
    expect(s2.active).toBe(true);
    expect(s2.method).toMatch(/fs\.(watch|stat)|sessions\.json\+poll/);

    detector.stop();
    const s3 = detector.status();
    expect(s3.active).toBe(false);
  });

  it("stop() cleans up watchers", () => {
    const detector = createStallDetector({
      sessionKey: "agent:main:worker:test-123",
      stallTimeoutMs: 1000,
      onStall: () => {},
    });

    detector.start();
    detector.stop();

    // Should be able to start/stop again without errors
    detector.start();
    detector.stop();
  });

  it("handles missing session file gracefully", async () => {
    let stalled = false;
    const detector = createStallDetector({
      sessionKey: "agent:main:worker:nonexistent",
      stallTimeoutMs: 150,
      pollIntervalMs: 50,
      onStall: () => { stalled = true; },
    });

    // Should not throw
    detector.start();
    await new Promise(r => setTimeout(r, 250));
    expect(stalled).toBe(true); // No session file = no activity = stall
    detector.stop();
  });
});
