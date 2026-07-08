/**
 * Browser E2E Tests
 *
 * Verifies the live gateway dashboard and API endpoints using fetch().
 * Requires the gateway to be running and the plugin loaded.
 *
 * Cleanup: any test projects created during tests are removed in afterAll.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const BASE = 'http://localhost:18789';

// ── Helpers ───────────────────────────────────────────────────

async function gatewayUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json() as any;
    return j?.ok === true;
  } catch {
    return false;
  }
}

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { redirect: 'follow' });
  return r.json();
}

async function getText(url: string): Promise<string> {
  const r = await fetch(url, { redirect: 'follow' });
  return r.text();
}

async function postJson(url: string, body: Record<string, unknown>): Promise<any> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'follow',
  });
  return r.json();
}

// ── Test projects created during this suite (cleaned up in afterAll) ──
const testProjectsCreated: string[] = [];

describe('Browser E2E Tests', () => {
  let up = false;

  beforeAll(async () => {
    up = await gatewayUp();
    if (!up) console.log('⚠️  Gateway not running — skipping browser tests');
    // Clean up any stale test projects from previous failed runs
    if (up) {
      try {
        const list = await getJson(`${BASE}/orchestrator/api/software-house/projects/list`);
        for (const p of list.projects || []) {
          if (p.name.startsWith('e2e-test-')) {
            await fetch(`${BASE}/orchestrator/api/software-house/projects/${encodeURIComponent(p.name)}?deleteFiles=true`, { method: 'DELETE' }).catch(() => {});
          }
        }
      } catch { /* best-effort */ }
    }
  });

  afterAll(async () => {
    if (!up) return;
    for (const proj of testProjectsCreated) {
      try {
        await fetch(`${BASE}/orchestrator/api/software-house/projects/${encodeURIComponent(proj)}?deleteFiles=true`, { method: 'DELETE' });
      } catch { /* best-effort */ }
    }
    testProjectsCreated.length = 0;
  });

  // ── Health ────────────────────────────────────────────────

  it('should have gateway running', () => {
    expect(up).toBe(true);
  });

  // ── Dashboard pages ───────────────────────────────────────

  it('should have dashboard accessible (follows redirect)', async () => {
    if (!up) return;

    // /orchestrator/ 302-redirects to /orchestrator/software-house
    const html = await getText(`${BASE}/orchestrator/`);
    expect(html).toContain('Orchestrator');
    expect(html).toContain('Genor');
  });

  it('should have software-house dashboard accessible', async () => {
    if (!up) return;

    const html = await getText(`${BASE}/orchestrator/software-house`);
    expect(html).toContain('Software House');
  });

  // ── API: bootstrap ────────────────────────────────────────

  it('should have API endpoints working', async () => {
    if (!up) return;

    const data = await getJson(`${BASE}/orchestrator/api/software-house/bootstrap`);
    expect(data.ok).toBe(true);
    expect(data.projects).toBeDefined();
  });

  // ── API: workers ──────────────────────────────────────────

  it('should have workers endpoint working', async () => {
    if (!up) return;

    const data = await getJson(
      `${BASE}/orchestrator/api/software-house/workers?project=genor-orchestrator-plugin`,
    );
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);

    const worker = data[0];
    expect(worker).toHaveProperty('id');
    expect(worker).toHaveProperty('name');
    expect(worker).toHaveProperty('role');
    expect(worker).toHaveProperty('status');
  });

  // ── API: backlog ──────────────────────────────────────────

  it('should have backlog endpoint working', async () => {
    if (!up) return;

    const data = await getJson(
      `${BASE}/orchestrator/api/software-house/backlog?project=genor-orchestrator-plugin`,
    );
    // Backlog endpoint returns a plain array of tasks
    expect(Array.isArray(data)).toBe(true);
  });

  // ── API: PM chat ──────────────────────────────────────────

  it('should have PM chat endpoint working', async () => {
    if (!up) return;

    const data = await getJson(
      `${BASE}/orchestrator/api/software-house/pm/chat?project=genor-orchestrator-plugin`,
    );
    expect(data.ok).toBe(true);
    expect(data.messages).toBeDefined();
    expect(Array.isArray(data.messages)).toBe(true);
  });

  // ── API: vault ────────────────────────────────────────────

  it('should have vault endpoint working', async () => {
    if (!up) return;

    const data = await getJson(
      `${BASE}/orchestrator/api/software-house/vault/tree?project=genor-orchestrator-plugin`,
    );
    expect(data.ok).toBe(true);
    expect(data.vault).toBeDefined();
  });

  // ── API: models ───────────────────────────────────────────

  it('should have models endpoint working', async () => {
    if (!up) return;

    const data = await getJson(`${BASE}/orchestrator/api/software-house/models`);
    // Models endpoint returns a plain array of model objects
    expect(Array.isArray(data)).toBe(true);
  });

  // ── CRUD round-trip + cleanup ─────────────────────────────

  it('should create and delete a test project via API', async () => {
    if (!up) return;

    const projName = `e2e-test-${Date.now()}`;
    testProjectsCreated.push(projName);

    // 1. Create the project first (required for backlog FK)
    const createProj = await postJson(
      `${BASE}/orchestrator/api/software-house/projects/create`,
      { name: projName },
    );
    expect(createProj.ok).toBe(true);

    // 2. Add a backlog task
    const createTask = await postJson(`${BASE}/orchestrator/api/software-house/backlog`, {
      project: projName,
      title: 'E2E test task',
      description: 'Auto-created by browser-e2e test',
      priority: 'p2',
    });
    expect(createTask.ok).toBe(true);

    // 3. Verify task exists (backlog returns a plain array)
    const backlog = await getJson(
      `${BASE}/orchestrator/api/software-house/backlog?project=${projName}`,
    );
    expect(Array.isArray(backlog)).toBe(true);
    expect(backlog.length).toBeGreaterThanOrEqual(1);

    // 4. Cleanup: delete project with cascade + filesystem
    const idx = testProjectsCreated.indexOf(projName);
    if (idx !== -1) testProjectsCreated.splice(idx, 1);
    try {
      await fetch(`${BASE}/orchestrator/api/software-house/projects/${encodeURIComponent(projName)}?deleteFiles=true`, { method: 'DELETE' });
    } catch { /* best-effort */ }
  });
});
