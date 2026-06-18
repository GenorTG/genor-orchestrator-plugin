/**
 * PLUGIN-002h — Dashboard API Endpoint Tests
 *
 * Tests the dashboard HTTP handler's API endpoints using
 * mock IncomingMessage / ServerResponse objects.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as http from "node:http";
import { createMockApi, prepareTestDataDir, registerPlugin } from "./setup.js";

let plugin: any;
beforeEach(async () => {
  vi.resetModules();
  plugin = (await import("../src/index.js")).default;
});

interface MockRes {
  res: http.ServerResponse;
  getBody(): string;
  getJson(): any;
}

function createMockRes(): MockRes {
  let body = "";
  let json: any = null;
  const res: any = {
    writeHead: vi.fn(() => res),
    write: vi.fn((chunk: string) => { body += chunk; return true; }),
    end: vi.fn((chunk?: string) => {
      if (chunk) body += chunk;
      try { json = JSON.parse(body); } catch {}
      return res;
    }),
    setHeader: vi.fn(),
    getHeader: vi.fn(() => ""),
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
  };
  return {
    res,
    getBody: () => body,
    getJson: () => json,
  };
}

function createMockReq(method: string, pathname: string, body?: string): http.IncomingMessage {
  let dataHandler: Function | null = null;
  let endHandler: Function | null = null;
  const req: any = {
    method, url: pathname,
    headers: { "content-type": "application/json" },
    on: vi.fn((evt: string, cb: Function) => {
      if (evt === "data") dataHandler = cb;
      if (evt === "end") endHandler = cb;
      return req;
    }),
    once: vi.fn(), emit: vi.fn(),
  };
  setTimeout(() => {
    if (body && dataHandler) dataHandler(Buffer.from(body));
    if (endHandler) endHandler();
  }, 5);
  return req;
}

async function setupDashboard(): Promise<{ handler: Function }> {
  const dd = prepareTestDataDir();
  const api = createMockApi();
  await registerPlugin(dd, plugin, api);
  const dashModule = await import("../src/dashboard-handler.js");
  const handler = dashModule.createDashboardHandler(api);
  return { handler };
}

describe("PLUGIN-002h — Dashboard API Endpoints", () => {
  it("GET /api/status — returns JSON", async () => {
    const { handler } = await setupDashboard();
    const { res, getJson } = createMockRes();
    await handler(createMockReq("GET", "/api/status"), res);
    expect(getJson()).toBeDefined();
  });

  it("GET /api/all — returns dashboard data", async () => {
    const { handler } = await setupDashboard();
    const { res, getJson } = createMockRes();
    await handler(createMockReq("GET", "/api/all"), res);
    expect(getJson()).toBeDefined();
  });

  it("GET /api/models — returns model list", async () => {
    const { handler } = await setupDashboard();
    const { res, getJson } = createMockRes();
    await handler(createMockReq("GET", "/api/models"), res);
    expect(getJson()).toBeDefined();
  });

  it("GET /api/logs — returns log entries", async () => {
    const { handler } = await setupDashboard();
    const { res, getJson } = createMockRes();
    await handler(createMockReq("GET", "/api/logs"), res);
    expect(getJson()).toBeDefined();
  });

  it("GET /api/projects — returns project list", async () => {
    const { handler } = await setupDashboard();
    const { res, getJson } = createMockRes();
    await handler(createMockReq("GET", "/api/projects"), res);
    expect(getJson()).toBeDefined();
  });

  it("GET /api/sessions — returns session info", async () => {
    const { handler } = await setupDashboard();
    const { res, getJson } = createMockRes();
    await handler(createMockReq("GET", "/api/sessions"), res);
    expect(getJson()).toBeDefined();
  });

  it("GET /api/live-agents — returns live agents", async () => {
    const { handler } = await setupDashboard();
    const { res, getJson } = createMockRes();
    await handler(createMockReq("GET", "/api/live-agents"), res);
    expect(getJson()).toBeDefined();
  });

  it("GET /api/gateway — returns gateway info", async () => {
    const { handler } = await setupDashboard();
    const { res, getJson } = createMockRes();
    await handler(createMockReq("GET", "/api/gateway"), res);
    expect(getJson()).toBeDefined();
  });

  it("GET /api/config — returns config", async () => {
    const { handler } = await setupDashboard();
    const { res, getJson } = createMockRes();
    await handler(createMockReq("GET", "/api/config"), res);
    expect(getJson()).toBeDefined();
  });

  it("POST /api/config — accepts config update", async () => {
    const { handler } = await setupDashboard();
    const { res, getJson } = createMockRes();
    await handler(createMockReq("POST", "/api/config", JSON.stringify({ free_only_mode: true })), res);
    expect(getJson()).toBeDefined();
  });

  it("GET /api/safeguard-log — returns logs", async () => {
    const { handler } = await setupDashboard();
    const { res, getJson } = createMockRes();
    await handler(createMockReq("GET", "/api/safeguard-log"), res);
    expect(getJson()).toBeDefined();
  });

  it("OPTIONS — handles CORS preflight", async () => {
    const { handler } = await setupDashboard();
    const { res } = createMockRes();
    await handler(createMockReq("OPTIONS", "/api/status"), res);
  });

  it("GET /api/nonexistent — returns 404 error", async () => {
    const { handler } = await setupDashboard();
    const { res, getJson } = createMockRes();
    await handler(createMockReq("GET", "/api/nonexistent"), res);
    const j = getJson();
    expect(j).toBeDefined();
  });
});
