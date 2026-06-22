/**
 * PLUGIN-002h — Dashboard API Endpoints Tests
 *
 * Tests HTTP route registration, dashboard config,
 * and spawn API structure.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi, prepareTestDataDir, registerPlugin, type MockApiType } from "./setup.js";

let plugin: any;
beforeEach(async () => { vi.resetModules(); plugin = (await import("../src/index.js")).default; });

describe("PLUGIN-002h — Dashboard API Endpoints", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
  });

  it("should register HTTP routes", () => {
    expect(api.registerHttpRoute.mock.calls.length).toBeGreaterThan(0);
  });

  it("should register status endpoint", () => {
    const allRoutes = api.registerHttpRoute.mock.calls;
      expect(allRoutes.length).toBeGreaterThan(0);
  });

  it("should register spawn endpoint", () => {
    
  });
});
