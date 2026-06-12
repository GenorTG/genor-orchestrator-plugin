import { describe, it, expect } from "vitest";
import plugin from "./index.js";

describe("genor-orchestrator plugin", () => {
  it("has the correct plugin id", () => {
    expect(plugin.id).toBe("genor-orchestrator");
  });

  it("has a non-empty name", () => {
    expect(plugin.name?.length).toBeGreaterThan(0);
  });

  it("has a register function", () => {
    expect(typeof plugin.register).toBe("function");
  });
});
