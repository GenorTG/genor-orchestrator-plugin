import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // ═══ SAFETY: Limit parallelism to prevent system overload ═══
    // Full suite in parallel (8 workers) + SQLite I/O + GPU services
    // caused system freezes during boot storms. Capped at 2 workers
    // to keep CPU/Disk load predictable.
    pool: "forks",
    maxWorkers: 2,
  },
});
