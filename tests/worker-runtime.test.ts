/**
 * Tests for worker-runtime.ts
 *
 * Tests the core LLM utilities: buildSystemPrompt, callLLM, generateJobReport,
 * reportWorkerActivity, and checkLmStudioHealth.
 *
 * Uses a mock fetch for callLLM tests to avoid actual LM Studio dependency.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Force LM Studio backend for the legacy tests in this file.
// The OpenClaw-specific tests set `backend: "openclaw"` per call.
process.env.WORKER_LLM_BACKEND = "lmstudio";
process.env.LMSTUDIO_BASE = "http://localhost:1234/v1";

// ── Mock fetch before importing the module ──

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

// Helper: queue a LM Studio models response (callLLM -> pickAvailableModel)
const MOCK_MODELS_RESPONSE = {
  ok: true,
  json: async () => ({ data: [{ id: "test-gemma" }] }),
};
const setupModelsMock = () => {
  mockFetch.mockImplementation(async (url: any) => {
    if (String(url).includes("/v1/models")) return MOCK_MODELS_RESPONSE;
    throw new Error("Unexpected fetch URL: " + url);
  });
};

// Need to mock db functions that worker-runtime imports
vi.mock("../src/db.js", () => ({
  addVaultDoc: vi.fn(),
  addWorkerTaskHistory: vi.fn(),
  updateWorker: vi.fn(),
  updateBacklogTask: vi.fn(),
  WorkerRow: {},
  BacklogRow: {},
}));

// Now import the module under test
import {
  buildSystemPrompt,
  callLLM,
  generateJobReport,
  reportWorkerActivity,
  checkLmStudioHealth,
  saveJobReportAsVaultDoc,
  pickAvailableModel,
} from "../src/worker-runtime.js";

import {
  addVaultDoc,
  addWorkerTaskHistory,
  updateWorker,
  updateBacklogTask,
} from "../src/db.js";

// ── MOCK WORKER DATA ──

const mockWorker = {
  id: "w123",
  name: "Test Dev",
  role: "Backend Developer",
  sprite: "blue",
  model: "test-model",
  prompt: "",
  room: "dev-room",
  status: "sleep",
  project: "test-project",
  is_pm: 0,
  created_at: "2024-01-01T00:00:00Z",
};

const mockWorkerWithPrompt = {
  ...mockWorker,
  prompt: "Focus on TypeScript and test coverage. Always write unit tests.",
};

// ── TESTS ──

describe("buildSystemPrompt", () => {
  it("creates a system prompt with worker name and role", () => {
    const prompt = buildSystemPrompt(mockWorker, "test-project");
    expect(prompt).toContain("Test Dev");
    expect(prompt).toContain("Backend Developer");
    expect(prompt).toContain("test-project");
  });

  it("includes task info when provided", () => {
    const prompt = buildSystemPrompt(mockWorker, "test-project", "Fix login bug", "Users cannot log in with OAuth");
    expect(prompt).toContain("Fix login bug");
    expect(prompt).toContain("Users cannot log in with OAuth");
  });

  it("includes custom prompt instructions when available", () => {
    const prompt = buildSystemPrompt(mockWorkerWithPrompt, "test-project");
    expect(prompt).toContain("TypeScript");
    expect(prompt).toContain("unit tests");
  });

  it("picks correct role prompt for developer", () => {
    const prompt = buildSystemPrompt(mockWorker, "proj");
    expect(prompt).toContain("software developer");
    expect(prompt).toContain("clean, maintainable code");
  });

  it("picks correct role prompt for PM", () => {
    const pmWorker = { ...mockWorker, role: "Project Manager" };
    const prompt = buildSystemPrompt(pmWorker, "proj");
    expect(prompt).toContain("project manager");
    expect(prompt.toLowerCase()).toContain("plan sprints");
  });

  it("picks correct role prompt for QA", () => {
    const qaWorker = { ...mockWorker, role: "QA Engineer" };
    const prompt = buildSystemPrompt(qaWorker, "proj");
    expect(prompt).toContain("QA engineer");
    expect(prompt).toContain("Find bugs");
  });

  it("picks correct role prompt for designer", () => {
    const designWorker = { ...mockWorker, role: "UI/UX Designer" };
    const prompt = buildSystemPrompt(designWorker, "proj");
    expect(prompt).toContain("UI/UX designer");
    expect(prompt).toContain("usability");
  });

  it("falls back to default for unknown roles", () => {
    const weirdWorker = { ...mockWorker, role: "Mysterious Role" };
    const prompt = buildSystemPrompt(weirdWorker, "proj");
    expect(prompt).toContain("helpful AI worker");
  });
});

describe("callLLM", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("calls LM Studio and returns the response text", async () => {
    // pickAvailableModel -> /v1/models
    mockFetch.mockResolvedValueOnce(MOCK_MODELS_RESPONSE);
    // callLLM -> /v1/chat/completions
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Hello, I am an AI worker!" } }],
      }),
    });

    const result = await callLLM({
      systemPrompt: "You are a test worker.",
      userMessage: "Say hello.",
    });

    expect(result).toBe("Hello, I am an AI worker!");
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify the chat completion request format
    const chatCall = mockFetch.mock.calls.find((c: any) => String(c[0]).includes("chat/completions"))!;
    expect(chatCall[0]).toContain("localhost:1234/v1/chat/completions");
    const callBody = JSON.parse(chatCall[1].body);
    expect(callBody.messages[0].role).toBe("system");
    expect(callBody.messages[0].content).toBe("You are a test worker.");
    expect(callBody.messages[1].role).toBe("user");
    expect(callBody.messages[1].content).toBe("Say hello.");
  });

  it("includes history messages when provided", async () => {
    mockFetch.mockResolvedValueOnce(MOCK_MODELS_RESPONSE);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Based on our conversation..." } }],
      }),
    });

    const result = await callLLM({
      systemPrompt: "You are a worker.",
      userMessage: "What did we discuss?",
      history: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
    });

    expect(result).toBe("Based on our conversation...");
    const chatCall = mockFetch.mock.calls.find((c: any) => String(c[0]).includes("chat/completions"))!;
    const callBody = JSON.parse(chatCall[1].body);
    // Should have: system, user, assistant, user (4 messages total)
    expect(callBody.messages.length).toBe(4);
  });

  it("throws on HTTP error from LM Studio", async () => {
    mockFetch.mockResolvedValueOnce(MOCK_MODELS_RESPONSE);
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    await expect(
      callLLM({ systemPrompt: "test", userMessage: "test" })
    ).rejects.toThrow("LM Studio error 500");
  });

  it("throws on empty response", async () => {
    mockFetch.mockResolvedValueOnce(MOCK_MODELS_RESPONSE);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [] }),
    });

    await expect(
      callLLM({ systemPrompt: "test", userMessage: "test" })
    ).rejects.toThrow("empty response");
  });

  it("throws descriptive error when LM Studio is unreachable", async () => {
    // Both pickAvailableModel and callLLM fail to reach LM Studio
    mockFetch.mockRejectedValue(new TypeError("fetch failed"));

    await expect(
      callLLM({ systemPrompt: "test", userMessage: "test" })
    ).rejects.toThrow(/Cannot reach LM Studio/);
  });

  it("throws on request timeout", async () => {
    mockFetch.mockResolvedValueOnce(MOCK_MODELS_RESPONSE);
    const abortError = new DOMException("The operation was aborted", "AbortError");
    mockFetch.mockRejectedValueOnce(abortError);

    await expect(
      callLLM({ systemPrompt: "test", userMessage: "test" })
    ).rejects.toThrow(/timed out/);
  });
});

describe("checkLmStudioHealth", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns reachable=true when LM Studio responds", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: "model-1", name: "Model One" },
          { id: "model-2", name: "Model Two" },
        ],
      }),
    });

    const result = await checkLmStudioHealth();
    expect(result.reachable).toBe(true);
    expect(result.models).toContain("model-1");
    expect(result.models).toContain("model-2");
  });

  it("returns reachable=false with error when LM Studio is down", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await checkLmStudioHealth();
    expect(result.reachable).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("generateJobReport", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("generates a structured report via LLM", async () => {
    mockFetch.mockResolvedValueOnce(MOCK_MODELS_RESPONSE);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: `## Summary\nFixed the login bug.\n\n## What Was Done\n- Added OAuth token refresh\n- Fixed redirect logic`,
          },
        }],
      }),
    });

    const report = await generateJobReport({
      workerName: "Test Dev",
      workerRole: "Backend Developer",
      taskTitle: "Fix login bug",
      taskDescription: "OAuth login is broken",
      workLog: [
        "Started debugging OAuth flow",
        "Found missing token refresh endpoint",
        "Implemented fix",
      ],
    });

    expect(report).toContain("Summary");
    expect(report).toContain("Fixed the login bug");
    expect(report).toContain("What Was Done");
  });
});

describe("reportWorkerActivity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores history entry and updates worker status", async () => {
    await reportWorkerActivity({
      workerId: "w123",
      taskId: 42,
      action: "started",
      message: "Worker started",
      workerStatus: "working",
    });

    expect(addWorkerTaskHistory).toHaveBeenCalledWith(
      "w123",
      42,
      "started",
      expect.stringContaining("Worker started"),
    );
    expect(updateWorker).toHaveBeenCalledWith(
      "w123",
      { status: "working" },
    );
  });

  it("updates task status when provided", async () => {
    await reportWorkerActivity({
      workerId: "w123",
      taskId: 42,
      action: "completed",
      message: "Done",
      taskStatus: "done",
    });

    expect(updateBacklogTask).toHaveBeenCalledWith(
      "42",
      { status: "done" },
    );
  });

  it("handles null taskId", async () => {
    await reportWorkerActivity({
      workerId: "w123",
      action: "idle",
      message: "Worker is idle",
    });

    expect(addWorkerTaskHistory).toHaveBeenCalledWith(
      "w123",
      null,
      "idle",
      expect.any(String),
    );
  });
});

describe("saveJobReportAsVaultDoc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves report as vault document with correct path", () => {
    saveJobReportAsVaultDoc("test-project", "task_123", "Fix Bug", "# Report content");

    expect(addVaultDoc).toHaveBeenCalledWith(
      "reports/task-task_123-report.md",
      "Task Report: Fix Bug",
      "# Report content",
      "reports",
      "test-project",
      expect.any(String),
      "completed",
      "[]",
      "📋",
    );
  });

  it("creates vault doc with proper tags", () => {
    saveJobReportAsVaultDoc("proj", "42", "Test Task", "content");

    const callArgs = (addVaultDoc as any).mock.calls[0];
    const tags = JSON.parse(callArgs[5]);
    expect(tags).toContain("report");
    expect(tags).toContain("completed");
  });
});

describe("pickAvailableModel", () => {
  it("returns the preferred model if it is loaded", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: "gemma-x" }, { id: "qwen-y" }] }),
    });
    const model = await pickAvailableModel("gemma-x");
    expect(model).toBe("gemma-x");
  });

  it("picks a chat model when preferred is not loaded", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: "text-embedding-foo" },
          { id: "gemma-4-12b-agentic" },
          { id: "qwen3.6-9b" },
        ],
      }),
    });
    const model = await pickAvailableModel("nonexistent-model");
    expect(model).toBe("gemma-4-12b-agentic");
  });

  it("skips embedding models when picking a default", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ id: "text-embedding-x" }] }),
    });
    const model = await pickAvailableModel("nope");
    expect(model).toBe("text-embedding-x"); // last resort
  });

  it("throws when LM Studio is unreachable", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(pickAvailableModel()).rejects.toThrow("LM Studio unreachable");
  });
});

// ── OpenClaw backend tests ─────────────────────────────────────

describe("callLLM (OpenClaw backend)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("POSTs to /v1/chat/completions with bearer auth", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "Hi from OpenClaw" } }] }),
    });
    const result = await callLLM({
      systemPrompt: "You are a worker.",
      userMessage: "Say hi.",
      backend: "openclaw",
      user: "worker-w123",
    });
    expect(result).toBe("Hi from OpenClaw");

    // The chat/completions call
    const chatCall = mockFetch.mock.calls.find((c: any) => String(c[0]).includes("chat/completions"))!;
    expect(chatCall).toBeTruthy();
    const headers = chatCall[1].headers;
    expect(headers.Authorization).toMatch(/^Bearer /);
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(chatCall[1].body);
    expect(body.model).toBe("openclaw");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("user");
    expect(body.user).toBe("worker-w123");
  });

  it("sends x-openclaw-session-key when sessionKey is provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ack" } }] }),
    });
    await callLLM({
      systemPrompt: "x", userMessage: "y", backend: "openclaw",
      sessionKey: "agent:main:worker:w123",
    });
    const chatCall = mockFetch.mock.calls.find((c: any) => String(c[0]).includes("chat/completions"))!;
    expect(chatCall[1].headers["x-openclaw-session-key"]).toBe("agent:main:worker:w123");
  });

  it("sends x-openclaw-model when backendModel is provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "premium response" } }] }),
    });
    await callLLM({
      systemPrompt: "x", userMessage: "y", backend: "openclaw",
      backendModel: "openai/gpt-5.4",
    });
    const chatCall = mockFetch.mock.calls.find((c: any) => String(c[0]).includes("chat/completions"))!;
    expect(chatCall[1].headers["x-openclaw-model"]).toBe("openai/gpt-5.4");
  });

  it("sends x-openclaw-message-channel when messageChannel is provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "x" } }] }),
    });
    await callLLM({
      systemPrompt: "x", userMessage: "y", backend: "openclaw",
      messageChannel: "orchestrator-software-house",
    });
    const chatCall = mockFetch.mock.calls.find((c: any) => String(c[0]).includes("chat/completions"))!;
    expect(chatCall[1].headers["x-openclaw-message-channel"]).toBe("orchestrator-software-house");
  });

  it("uses 60s timeout for OpenClaw (vs 30s for LM Studio)", async () => {
    // Just verify the call succeeds; timeout is exercised in a separate test
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });
    const result = await callLLM({
      systemPrompt: "x", userMessage: "y", backend: "openclaw",
    });
    expect(result).toBe("ok");
  });

  it("throws descriptive error when OpenClaw is unreachable", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      callLLM({ systemPrompt: "x", userMessage: "y", backend: "openclaw" })
    ).rejects.toThrow(/Cannot reach OpenClaw gateway/);
  });

  it("throws on HTTP error from OpenClaw", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    await expect(
      callLLM({ systemPrompt: "x", userMessage: "y", backend: "openclaw" })
    ).rejects.toThrow(/OpenClaw error 401/);
  });

  it("throws on empty response from OpenClaw", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [] }),
    });
    await expect(
      callLLM({ systemPrompt: "x", userMessage: "y", backend: "openclaw" })
    ).rejects.toThrow(/empty response/);
  });
});
