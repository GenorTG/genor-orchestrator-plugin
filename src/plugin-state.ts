// ═══════════════════════════════════════════════════════════════
//  PLUGIN STATE — Module-level mutable state shared between
//  index.ts and helper modules. Centralizes cross-module state
//  to avoid circular imports and tangled dependencies.
// ═══════════════════════════════════════════════════════════════

/** Total number of tools registered via api.registerTool().
 *  Mutated by register() in index.ts, read by snapshotState and
 *  generateStateFromEvents in legacy-helpers.ts. */
export let _toolCount = 0;

export function incrementToolCount(): number {
  return ++_toolCount;
}
