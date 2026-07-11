/**
 * Tests for worker-runtime.ts — the generic OpenAI-compatible LLM client.
 *
 * Uses a mock fetch for callLLM tests. The tests configure the LLM
 * endpoint explicitly via configureLLM(), so they don't depend on any
 * real backend (OpenClaw, LM Studio, etc.).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { configureLLM, getLLMConfig } from "../src/worker-runtime.js";

// ── Configure the mock endpoint before any tests run ──
configureLLM({
  endpoint: "http://mock-llm:9999/v1/chat/completions",
  token: "test-token-123",
  defaultModel: "test-model",
  defaultMessageChannel: "test-channel",
  timeoutMs: 5_000,
});

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
  checkLLMHealth,
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

  it("posts to the configured endpoint and returns the result", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Hello from the test endpoint" } }],
      }),
    });

    const result = await callLLM({
      systemPrompt: "You are a test worker.",
      userMessage: "Say hello.",
    });

    expect(result.content).toBe("Hello from the test endpoint");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("http://mock-llm:9999/v1/chat/completions");
    const body = JSON.parse(opts.body);
    expect(body.model).toBe("test-model");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toBe("You are a test worker.");
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toBe("Say hello.");
    expect(opts.headers.Authorization).toBe("Bearer test-token-123");
  });

  it("sends bearer auth header when token is set", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ choices: [{ message: { content: "x" } }] }),
    });
    await callLLM({ systemPrompt: "x", userMessage: "y" });
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers.Authorization).toBe("Bearer test-token-123");
  });

  it("omits auth header when no token is configured", async () => {
    configureLLM({ token: "" });
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ choices: [{ message: { content: "x" } }] }),
    });
    await callLLM({ systemPrompt: "x", userMessage: "y" });
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers.Authorization).toBeUndefined();
    configureLLM({ token: "test-token-123" }); // restore
  });

  it("sends x-openclaw-session-key when sessionKey is provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ choices: [{ message: { content: "x" } }] }),
    });
    await callLLM({
      systemPrompt: "x", userMessage: "y",
      sessionKey: "agent:main:worker:w123",
    });
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["x-openclaw-session-key"]).toBe("agent:main:worker:w123");
  });

  it("sends x-openclaw-model when backendModel is provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ choices: [{ message: { content: "x" } }] }),
    });
    await callLLM({
      systemPrompt: "x", userMessage: "y",
      backendModel: "openai/gpt-5.4",
    });
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["x-openclaw-model"]).toBe("openai/gpt-5.4");
  });

  it("sends x-openclaw-message-channel when messageChannel is provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ choices: [{ message: { content: "x" } }] }),
    });
    await callLLM({
      systemPrompt: "x", userMessage: "y",
      messageChannel: "custom-channel",
    });
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["x-openclaw-message-channel"]).toBe("custom-channel");
  });

  it("uses default message channel from config when not specified", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ choices: [{ message: { content: "x" } }] }),
    });
    await callLLM({ systemPrompt: "x", userMessage: "y" });
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["x-openclaw-message-channel"]).toBe("test-channel");
  });

  it("includes user field for per-worker session tracking", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ choices: [{ message: { content: "x" } }] }),
    });
    await callLLM({ systemPrompt: "x", userMessage: "y", user: "worker-w123" });
    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body).user).toBe("worker-w123");
  });

  it("includes history messages when provided", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ choices: [{ message: { content: "x" } }] }),
    });
    await callLLM({
      systemPrompt: "You are a worker.",
      userMessage: "What did we discuss?",
      history: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ],
    });
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.messages.length).toBe(4); // system + 2 history + new user
  });

  it("passes tools array for function calling", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ choices: [{ message: { content: "x" } }] }),
    });
    await callLLM({
      systemPrompt: "x", userMessage: "y",
      tools: [{ type: "function", function: { name: "test_tool" } }],
    });
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.tools).toEqual([{ type: "function", function: { name: "test_tool" } }]);
    expect(body.tool_choice).toBe("auto");
  });

  it("returns tool calls when present in response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call_1",
              function: { name: "test_tool", arguments: '{"x":1}' },
            }],
          },
        }],
      }),
    });
    const result = await callLLM({ systemPrompt: "x", userMessage: "y" });
    expect(result.toolCalls).toEqual([{
      id: "call_1",
      name: "test_tool",
      arguments: '{"x":1}',
    }]);
  });

  it("throws on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 500, text: async () => "Internal Server Error",
    });
    await expect(
      callLLM({ systemPrompt: "x", userMessage: "y" })
    ).rejects.toThrow(/LLM endpoint error 500/);
  });

  it("throws on empty response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ choices: [] }),
    });
    await expect(
      callLLM({ systemPrompt: "x", userMessage: "y" })
    ).rejects.toThrow(/empty response/);
  });

  it("throws descriptive error when endpoint is unreachable", async () => {
    mockFetch.mockRejectedValue(new TypeError("fetch failed"));
    await expect(
      callLLM({ systemPrompt: "x", userMessage: "y" })
    ).rejects.toThrow(/Cannot reach LLM endpoint/);
  });

  it("throws on request timeout", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    mockFetch.mockRejectedValueOnce(abortError);
    await expect(
      callLLM({ systemPrompt: "x", userMessage: "y" })
    ).rejects.toThrow(/timed out/);
  });
});

describe("checkLLMHealth", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns reachable=true when endpoint responds", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { id: "model-1", name: "Model One" },
          { id: "model-2", name: "Model Two" },
        ],
      }),
    });

    const result = await checkLLMHealth();
    expect(result.reachable).toBe(true);
    expect(result.models).toContain("model-1");
    expect(result.models).toContain("model-2");
    expect(result.endpoint).toBe("http://mock-llm:9999/v1/chat/completions");
  });

  it("returns reachable=false with error when endpoint is down", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await checkLLMHealth();
    expect(result.reachable).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe("generateJobReport", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("generates a structured report via LLM", async () => {
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
  beforeEach(() => { mockFetch.mockReset(); });

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

  it("throws when endpoint is unreachable", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    await expect(pickAvailableModel()).rejects.toThrow();
  });
});

describe("configureLLM", () => {
  it("overrides endpoint and token", () => {
    configureLLM({ endpoint: "http://other:1234/v1/chat/completions", token: "new-token" });
    const cfg = getLLMConfig();
    expect(cfg.endpoint).toBe("http://other:1234/v1/chat/completions");
    expect(cfg.token).toBe("new-token");
    // Restore for subsequent tests
    configureLLM({
      endpoint: "http://mock-llm:9999/v1/chat/completions",
      token: "test-token-123",
    });
  });
});
