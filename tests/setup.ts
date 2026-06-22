/**
 * Test setup for genor-orchestrator-plugin.
 *
 * Mocks node:child_process globally, creates temp data directories,
 * provides fixture data, and exposes a mock API factory for capturing
 * registered tool execute handlers.
 */

import { vi, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Global execSync mock ──────────────────────────────────────
// Must be at top-level so vi.mock hoisting works in setup files.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    execSync: vi.fn((command: string, _opts?: unknown) => {
      const cmd = typeof command === "string" ? command : String(command);
      // Known commands used during plugin registration / tool execution
      if (cmd.startsWith("hostname")) return "test-host\n";
      if (cmd.startsWith("tailscale")) return "";
      if (cmd.startsWith("crontab -l")) return "";
      if (cmd.startsWith("crontab ")) return "";
      if (cmd.startsWith("git status")) return "";
      if (cmd.startsWith("git add")) return "";
      if (cmd.startsWith("git commit")) return "";
      if (cmd.startsWith("git tag")) return "";
      if (cmd.startsWith("git push")) return "";
      if (cmd.startsWith("pm2 jlist")) return "[]";
      if (cmd.startsWith("pm2 ")) return "";
      if (cmd.startsWith("find ")) return "";
      if (cmd.startsWith("python3 ")) throw new Error(`[mock] execSync called for: ${cmd}`);
      return "";
    }),
  };
});

// ── Types ─────────────────────────────────────────────────────
export interface MockApiType {
  pluginConfig: Record<string, unknown>;
  registerTool: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  registerHttpRoute: ReturnType<typeof vi.fn>;
  tools: Map<string, (id: string, params: any) => any>;
  hooks: Map<string, Function>;
  commands: Map<string, Function>;
  runtime: {
    subagent: {
      run: ReturnType<typeof vi.fn>;
    };
  };
  cron: {
    add: ReturnType<typeof vi.fn>;
  };
}

// ── Mock API factory ──────────────────────────────────────────
export function createMockApi(): MockApiType {
  const tools = new Map<string, (id: string, params: any) => any>();
  const hooks = new Map<string, Function>();
  const commands = new Map<string, Function>();

  return {
    pluginConfig: {},
    registerTool: vi.fn(({ name, execute }: { name: string; execute: (id: string, params: any) => any }) => {
      tools.set(name, execute);
    }),
    on: vi.fn((event: string, handler: Function) => {
      hooks.set(event, handler);
    }),
    registerCommand: vi.fn(({ name, handler }: { name: string; handler: Function }) => {
      commands.set(name, handler);
    }),
    registerHttpRoute: vi.fn(),
    runtime: {
      subagent: {
        run: vi.fn((_params: any) => Promise.resolve({ runId: "mock-run-123" })),
      },
    },
    cron: {
      add: vi.fn((_job: any) => Promise.resolve({ ok: true, id: 'mock-cron-1' })),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      logRouting: vi.fn(),
      logSession: vi.fn(),
      logConfigChange: vi.fn(),
      query: vi.fn(() => []),
    },
    tools,
    hooks,
    commands,
  };
}

// ── Sample fixture data ───────────────────────────────────────
export const sampleModels = {
  version: 2,
  schema: "models-v2",
  models: [
    {
      id: "gpt-4",
      provider: "openai",
      name: "GPT-4",
      tier: 1,
      speed_rating: 8,
      status: "active",
      agent_ready: true,
      cost: { type: "subscription" },
      context_window: 128_000,
      capabilities: { coding: true, vision: true },
    },
    {
      id: "claude-3",
      provider: "anthropic",
      name: "Claude 3",
      tier: 1,
      speed_rating: 7,
      status: "active",
      agent_ready: true,
      cost: { type: "pay_per_token" },
      context_window: 200_000,
      capabilities: { coding: true, vision: true },
    },
    {
      id: "gemini-pro",
      provider: "google",
      name: "Gemini Pro",
      tier: 2,
      speed_rating: 9,
      status: "active",
      agent_ready: true,
      cost: { type: "free" },
      context_window: 128_000,
      capabilities: { coding: true },
    },
    {
      id: "llama-3",
      provider: "meta",
      name: "Llama 3",
      tier: 2,
      speed_rating: 6,
      status: "active",
      agent_ready: true,
      cost: { type: "free" },
      context_window: 32_000,
    },
    {
      id: "deepseek-v2",
      provider: "deepseek",
      name: "DeepSeek V2",
      tier: 3,
      speed_rating: 5,
      status: "active",
      agent_ready: true,
      cost: { type: "free" },
      context_window: 64_000,
      capabilities: { coding: true },
    },
    {
      id: "gpt-3.5",
      provider: "openai",
      name: "GPT-3.5",
      tier: 3,
      speed_rating: 10,
      status: "active",
      agent_ready: false,
      cost: { type: "pay_per_token" },
      context_window: 16_000,
    },
    {
      id: "offline-model",
      provider: "local",
      name: "Offline Model",
      tier: 3,
      speed_rating: 4,
      status: "removed",
      agent_ready: false,
      cost: { type: "free" },
      context_window: 8_000,
    },
    {
      id: "paid-vision",
      provider: "openai",
      name: "Paid Vision",
      tier: 1,
      speed_rating: 8,
      status: "active",
      agent_ready: true,
      cost: { type: "payg" },
      context_window: 128_000,
      capabilities: { coding: true, vision: true },
    },
  ],
};

export const sampleDashboardConfig: Record<string, unknown> = {
  free_only_mode: false,
  disabled_models: ["offline-model"],
  projects: {
    "test-project": {
      location: "/tmp/test-project-loc",
      workflow: {
        enabled: true,
        include_qa: false,
        auto_commit: false,
        qa_retries: 3,
        skip_phases: [],
      },
      model_routing: {
        coding: ["gpt-4", "claude-3", "gemini-pro"],
        fixing: ["claude-3", "gpt-4"],
        research: ["gemini-pro", "claude-3"],
        qa: ["gemini-pro", "llama-3"],
        documentation: ["llama-3"],
      },
    },
    "free-project": {
      workflow: { enabled: false },
      free_only: true,
    },
    "allowlist-project": {
      workflow: { enabled: false },
      model_allowlist: ["deepseek-v2", "gemini-pro"],
    },
  },
};

// ── Temp data dir management ──────────────────────────────────
const _dataDirs: string[] = [];

export function getTestDataDir(): string {
  const dd = fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
  _dataDirs.push(dd);
  return dd;
}

export function cleanupAllDataDirs(): void {
  for (const dd of _dataDirs) {
    try {
      fs.rmSync(dd, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  _dataDirs.length = 0;
}

/** Prepare a temp data dir with standard subdirs + .FIRST_RUN marker
 *  and optional fixture files. */
export function prepareTestDataDir(
  withFixtures = true,
  customConfig?: Record<string, unknown>,
): string {
  const dd = getTestDataDir();

  // Standard subdirs (matches what register() creates)
  for (const sub of ["logs", "sessions", "adrs", "projects"]) {
    fs.mkdirSync(path.join(dd, sub), { recursive: true });
  }

  // Write .FIRST_RUN marker to prevent first-run onboarding side-effects
  fs.writeFileSync(path.join(dd, ".FIRST_RUN"), new Date().toISOString());

  if (withFixtures) {
    fs.writeFileSync(
      path.join(dd, "models.json"),
      JSON.stringify(sampleModels, null, 2),
    );
    fs.writeFileSync(
      path.join(dd, "dashboard-config.json"),
      JSON.stringify(customConfig ?? sampleDashboardConfig, null, 2),
    );
  }

  return dd;
}

/** Write a minimal session_log.md so parseSessionLog doesn't return empty. */
export function writeSessionLog(dd: string, lines?: string[]): void {
  const header =
    "# Session Log\n\n| Date | Project | Task | Model | Agent | Status | Duration | QA | Checked | Notes |\n|------|---------|------|-------|-------|--------|----------|----|---------|-------|\n";
  const body =
    lines?.join("\n") ??
    "| 2025-06-01 | test-project | fix-bug | gpt-4 | Amy | complete | 30min | false | false | fixed |\n";
  fs.writeFileSync(path.join(dd, "session_log.md"), header + body);
}

/** Register the plugin, capture tools, set env. */
export async function registerPlugin(
  dataDir: string,
  plugin: any,
  api: MockApiType,
): Promise<void> {
  process.env.ORCHESTRATOR_DATA_DIR = dataDir;
  plugin.register(api);
}

// ── Session setup helper ───────────────────────────────────────
// Sets a synthetic session key so genorch_session_register works in tests.
export function setupTestSession(pluginModule: any): void {
  if (typeof pluginModule.__setTestSessionKey === "function") {
    pluginModule.__setTestSessionKey("test-session-key");
  }
}

// ── Full test init: temp dir + register + session + project context ──
export async function initTest(
  plugin: any,
  api?: MockApiType,
  project = "test-project",
  task = "test-task",
): Promise<{ api: MockApiType; dd: string }> {
  if (!api) api = createMockApi();
  const dd = prepareTestDataDir();
  await registerPlugin(dd, plugin, api);
  
  // Set synthetic session key
  const mod = await import("../src/index.js");
  setupTestSession(mod);
  
  // Register session + bind project
  const reg = api.tools.get("genorch_session_register")!;
  await unwrap(reg("", {}));
  
  const bind = api.tools.get("genorch_session_start_work")!;
  await unwrap(bind("", { project, task }));
  
  return { api, dd };
}

// ── Tool result unwrapper ─────────────────────────────────────
export async function unwrap(result: any): Promise<any> {
  const resolved = await result;
  if (resolved && typeof resolved === "object" && "details" in resolved) {
    return resolved.details;
  }
  return resolved;
}

// ── Global afterAll cleanup ──────────────────────────────────
afterAll(() => {
  cleanupAllDataDirs();
});
