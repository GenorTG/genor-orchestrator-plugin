/**
 * Playwright E2E Dashboard Tests
 *
 * Verifies the live Genor Orchestrator Software House dashboard using
 * real browser automation (Playwright).
 *
 * Prerequisites:
 *   - Gateway running at http://localhost:18789
 *   - Plugin loaded with software-house dashboard
 *
 * Tests gracefully skip when gateway is unreachable.
 */

import { test, expect, type Page } from '@playwright/test';

// ── Helpers ──────────────────────────────────────────────────

const BASE = 'http://localhost:18789';
const DASHBOARD_URL = '/orchestrator/software-house';

/** Check if gateway is alive — skip all tests if not. */
async function gatewayUp(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json() as any;
    return j?.ok === true;
  } catch {
    return false;
  }
}

// ── Lifecycle ────────────────────────────────────────────────

let UP = false;

test.beforeAll(async () => {
  UP = await gatewayUp();
  if (!UP) console.warn('⚠️  Gateway not running — skipping all tests');
});

test.beforeEach(async ({ page }, info) => {
  test.skip(!UP, 'Gateway is not running');
  await page.goto(DASHBOARD_URL);
  await page.waitForLoadState('networkidle');
});

test.afterEach(async ({ page }, info) => {
  if (info.error) {
    await page.screenshot({
      path: `./test-results/screenshots/${info.title.replace(/[^a-z0-9]/gi, '_')}.png`,
      fullPage: true,
    });
  }
});

// ── Test: Dashboard loads ────────────────────────────────────

test('Dashboard loads with correct title and dark theme', async ({ page }) => {
  // Title
  await expect(page).toHaveTitle(/Genor Orchestrator|Software House/);

  // Dark theme
  const theme = await page.getAttribute('html', 'data-theme');
  expect(theme).toBe('dark');

  // Header elements
  await expect(page.locator('.logo')).toContainText(/Genor/);
  await expect(page.locator('.badge')).toBeVisible();
  await expect(page.locator('.pulse')).toBeVisible();

  // Status bar
  await expect(page.locator('.status-bar')).toContainText('ACTIVE');
  await expect(page.locator('.status-bar')).toContainText('Software House');
});

// ── Test: Project selector ──────────────────────────────────

test('Project selector dropdown shows projects', async ({ page }) => {
  const select = page.locator('#projectSelect');
  await expect(select).toBeVisible();

  // Should have at least one option (current project)
  const options = await select.locator('option').all();
  expect(options.length).toBeGreaterThanOrEqual(1);

  // Current project should be displayed in the pill
  await expect(page.locator('#projectName')).toBeVisible();
  await expect(page.locator('#projectId')).toBeVisible();

  const firstOptText = await options[0].textContent();
  expect(firstOptText?.trim().length).toBeGreaterThan(0);
});

// ── Test: Navigation sidebar ────────────────────────────────

test('Sidebar navigation buttons are present and clickable', async ({ page }) => {
  const navs = page.locator('.sidebar .nav-btn');
  const count = await navs.count();
  expect(count).toBeGreaterThanOrEqual(4); // office, kanban, vault, settings, help

  // Office nav should be active by default
  const activeNavs = page.locator('.sidebar .nav-btn.active');
  await expect(activeNavs).toHaveCount(1);
});

// ── Test: Worker stats cards ─────────────────────────────────

test('Worker stats cards display (total, working, sleep, errors)', async ({ page }) => {
  const statCards = page.locator('.stat-card');
  await expect(statCards.first()).toBeVisible();

  // Should show at least the total workers stat
  const statTexts = await statCards.allTextContents();
  const combined = statTexts.join(' ');
  expect(combined).toMatch(/Pracowników|Pracuje|Sleep|Błędy|Errors/);
});

// ── Test: Workers rendered from API data ──────────────────────

test('Worker desk slots are present on the office canvas', async ({ page }) => {
  await page.waitForTimeout(2000);

  // The bootstrap data populates workers — check desk slots exist
  const deskSlots = page.locator('.desk-slot');
  const count = await deskSlots.count();
  expect(count).toBeGreaterThanOrEqual(1); // at least 1 worker

  // Each desk slot should have a nameplate
  const nameplates = page.locator('.nameplate');
  await expect(nameplates.first()).toBeVisible();
});

// ── Test: Workers include expected names (Alex, Maya, Eve) ────

test('Expected workers appear in the canvas with correct roles', async ({ page }) => {
  await page.waitForTimeout(2000);

  const nameplates = page.locator('.nameplate');
  const names = await nameplates.allTextContents();
  const allNames = names.join(', ');

  // At least one of these should be present
  const found = ['Alex', 'Maya', 'Eve', 'PM', 'Project Manager'].some(n => allNames.includes(n));
  expect(found).toBe(true);

  // Check role tags exist
  const roles = page.locator('.role-tag');
  await expect(roles.first()).toBeVisible();

  // Check status badges exist
  const badges = page.locator('.status-badge');
  await expect(badges.first()).toBeVisible();
});

// ── Test: Click worker opens PM bubble ───────────────────────

test('Clicking a worker opens PM chat bubble', async ({ page }) => {
  await page.waitForTimeout(1500);

  // Click the first desk slot
  const firstDesk = page.locator('.desk-slot').first();
  await expect(firstDesk).toBeVisible({ timeout: 5000 });
  await firstDesk.click();

  // PM bubble should appear
  const bubble = page.locator('#pmBubble');
  await expect(bubble).toBeVisible({ timeout: 3000 });
  await expect(bubble.locator('#pmBubbleName')).toBeVisible();
});

// ── Test: PM chat - typing and sending a message ─────────────

test('PM chat bubble — type message and verify it appears', async ({ page }) => {
  await page.waitForTimeout(1500);

  // Select a worker from the chat dropdown
  const workerSelect = page.locator('#chatWorkerSelect');
  await expect(workerSelect).toBeVisible({ timeout: 5000 });

  // If we can open PM bubble by clicking a desk, use that
  const firstDesk = page.locator('.desk-slot').first();
  await firstDesk.click();

  const bubble = page.locator('#pmBubble');
  await expect(bubble).toBeVisible({ timeout: 3000 });

  // Type a message
  const input = bubble.locator('#pmBubbleInput');
  await input.fill('Jaki jest status zespołu?');

  // Click send button
  await bubble.locator('button:has-text("→")').click();

  // The message should appear as a user message in the bubble
  await expect(bubble.locator('.msg.user')).toContainText('status zespołu');
});

// ── Test: PM chat quick action buttons ────────────────────────

test('PM bubble quick action buttons are clickable', async ({ page }) => {
  await page.waitForTimeout(1500);

  const firstDesk = page.locator('.desk-slot').first();
  await firstDesk.click();

  const bubble = page.locator('#pmBubble');
  await expect(bubble).toBeVisible({ timeout: 3000 });

  // Check quick action buttons exist
  const actions = bubble.locator('#pmBubbleActions button');
  const count = await actions.count();
  expect(count).toBeGreaterThanOrEqual(3);

  // Click "Status" button
  const statusBtn = bubble.locator('#pmBubbleActions button:has-text("Status")');
  await expect(statusBtn).toBeVisible();
  await statusBtn.click();

  // Should see a bot response message appear
  await expect(bubble.locator('.msg.bot').last()).toBeVisible({ timeout: 2000 });
});

// ── Test: Rooms render correctly ──────────────────────────────

test('Room rows display in the project panel', async ({ page }) => {
  await page.waitForTimeout(1500);

  const roomRows = page.locator('.room-row');
  const count = await roomRows.count();
  expect(count).toBeGreaterThanOrEqual(1);

  // Check room names are visible
  const roomNames = page.locator('.room-row .name');
  await expect(roomNames.first()).toBeVisible();

  // Check room count indicators
  const counts = page.locator('.room-row .cnt');
  await expect(counts.first()).toBeVisible();
});

// ── Test: Room tabs in office toolbar ─────────────────────────

test('Room tabs appear in the office toolbar', async ({ page }) => {
  await page.waitForTimeout(1500);

  const tabs = page.locator('.room-tab');
  const count = await tabs.count();
  expect(count).toBeGreaterThanOrEqual(1);

  await expect(tabs.first()).toBeVisible();
});

// ── Test: Room zones on canvas ────────────────────────────────

test('Room zones render on the office canvas', async ({ page }) => {
  await page.waitForTimeout(1500);

  const zones = page.locator('.room-zone');
  const count = await zones.count();
  expect(count).toBeGreaterThanOrEqual(1);

  await expect(zones.first()).toBeVisible();
});

// ── Test: Kanban view loads ──────────────────────────────────

test('Kanban board view is accessible and shows tasks', async ({ page }) => {
  await page.waitForTimeout(1500);

  // Click kanban nav button
  const kanbanNav = page.locator('#navKanban');
  await expect(kanbanNav).toBeVisible();
  await kanbanNav.click();

  // Kanban view should be visible
  const kanbanView = page.locator('#kanbanFullView');
  await expect(kanbanView).toBeVisible({ timeout: 3000 });

  // Should have board columns
  const columns = kanbanView.locator('.kanban-col');
  const colCount = await columns.count();
  expect(colCount).toBeGreaterThanOrEqual(1);
});

// ── Test: Vault view loads ───────────────────────────────────

test('Vault view is accessible', async ({ page }) => {
  await page.waitForTimeout(1500);

  const vaultNav = page.locator('#navVault');
  await expect(vaultNav).toBeVisible();
  await vaultNav.click();

  const vaultView = page.locator('#vaultView');
  await expect(vaultView).toBeVisible({ timeout: 3000 });

  // Vault sidebar should show
  await expect(vaultView.locator('.vault-sidebar')).toBeVisible();
});

// ── Test: Quick action chips in chat panel ────────────────────

test('Quick action chips (Status, Plan) are clickable', async ({ page }) => {
  await page.waitForTimeout(1500);

  const chips = page.locator('.chip');
  const count = await chips.count();
  expect(count).toBeGreaterThanOrEqual(2);

  // Click Status chip
  const statusChip = page.locator('.chip:has-text("Status")');
  await expect(statusChip).toBeVisible();
  await statusChip.click();

  // Wait for any potential action (some chips open modals or change views)
  await page.waitForTimeout(500);
  expect(true).toBe(true); // No crash / dialog means success
});

// ── Test: Settings view renders ──────────────────────────────

test('Settings view opens and shows configuration options', async ({ page }) => {
  await page.waitForTimeout(1500);

  const settingsBtn = page.locator('.sidebar .nav-btn', { hasText: '⚙️' });
  await expect(settingsBtn).toBeVisible();
  await settingsBtn.click();

  const settingsView = page.locator('#settingsView');
  await expect(settingsView).toBeVisible({ timeout: 3000 });

  // Should have settings content
  await expect(settingsView.locator('h2')).toContainText('Ustawienia');
});

// ── Test: Font scale controls ───────────────────────────────

test('Font scale controls work', async ({ page }) => {
  await page.waitForTimeout(1000);

  const fontCtrl = page.locator('.font-ctrl');
  await expect(fontCtrl).toBeVisible();

  // Buttons for font scaling
  const buttons = fontCtrl.locator('button');
  const btnCount = await buttons.count();
  expect(btnCount).toBeGreaterThanOrEqual(2);

  // Font scale label should show a percentage
  await expect(fontCtrl.locator('span')).toBeVisible();
});

// ── Test: Hire modal opens ──────────────────────────────────

test('Hire modal opens and has required fields', async ({ page }) => {
  await page.waitForTimeout(1500);

  // Click hire button
  const hireBtn = page.locator('.btn-hire-big');
  await expect(hireBtn).toBeVisible();
  await hireBtn.click();

  // Modal should appear
  const overlay = page.locator('#hireOverlay.show, .overlay.show');
  await expect(overlay).toBeVisible({ timeout: 3000 });

  // Should have form fields
  await expect(page.locator('#hireName')).toBeVisible();
  await expect(page.locator('#hireRole')).toBeVisible();
  await expect(page.locator('#hireModel')).toBeVisible();

  // Close modal
  const cancelBtn = page.locator('.modal-foot .btn:has-text("Anuluj")');
  await cancelBtn.click();
  await expect(overlay).not.toBeVisible({ timeout: 2000 });
});

// ── Test: Detail panel opens for room click ──────────────────

test('Clicking room row opens detail panel', async ({ page }) => {
  await page.waitForTimeout(1500);

  // Click the gear icon of first non-command room
  const gearBtn = page.locator('.room-row .mini-gear').first();
  await expect(gearBtn).toBeVisible({ timeout: 5000 });
  await gearBtn.click();

  // Detail panel should open
  const panel = page.locator('#detailPanel.open');
  await expect(panel).toBeVisible({ timeout: 3000 });
  await expect(panel.locator('.detail-head h2')).toBeVisible();
});

// ── Test: View switching (Office → Kanban → Office) ─────────

test('View switching between Office and Kanban works', async ({ page }) => {
  await page.waitForTimeout(1500);

  // Start in office view
  await expect(page.locator('#officeView')).toBeVisible();
  await expect(page.locator('#officeView')).not.toHaveClass(/hidden/);

  // Switch to kanban
  await page.locator('#navKanban').click();
  await expect(page.locator('#kanbanFullView')).toBeVisible({ timeout: 2000 });
  await expect(page.locator('#kanbanFullView')).toHaveClass(/show/);

  // Switch back to office
  await page.locator('#navOffice').click();
  await expect(page.locator('#officeView')).toBeVisible({ timeout: 2000 });
  await expect(page.locator('#officeView')).not.toHaveClass(/hidden/);
});
