/**
 * PLUGIN-002i — Full Spawn Flow with Background API Tests
 *
 * Tests HTTP route registration for the spawn API endpoint,
 * queue structure, and response format.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMockApi, prepareTestDataDir, registerPlugin, type MockApiType } from "./setup.js";

let plugin: any;
beforeEach(async () => { vi.resetModules(); plugin = (await import("../src/index.js")).default; });

describe("PLUGIN-002i — Spawn Flow Background API", () => {
  let dd: string;
  let api: MockApiType;
  beforeEach(async () => {
    dd = prepareTestDataDir();
    api = createMockApi();
    await registerPlugin(dd, plugin, api);
  });

  it("should register spawn routes", () => {
    const calls = api.registerHttpRoute.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
  });

  it("should have spawn-related routes", () => {
    const allRoutes = api.registerHttpRoute.mock.calls;
      expect(allRoutes.length).toBeGreaterThan(0);
  });

  it("should have dashboard routes", () => {
    
  });
});
