const { chromium } = require('playwright');
const path = require('path');

const UI_AUDIT = path.join(__dirname);

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  
  // 1. Main dashboard
  await page.goto('http://localhost:18789/orchestrator/software-house?project=genor-paste');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(UI_AUDIT, '01-main-dashboard.png') });
  console.log('✅ 01-main-dashboard.png');
  
  // 2. Click Maya-PM worker to open detail modal
  await page.click('.worker-sprite >> nth=0', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(UI_AUDIT, '02-worker-detail-modal.png') });
  console.log('✅ 02-worker-detail-modal.png');
  
  // 3. Close modal, click hire button
  await page.click('body', { position: { x: 10, y: 10 } }).catch(() => {});
  await page.waitForTimeout(300);
  await page.click('text=Zatrudnij programistę', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(UI_AUDIT, '03-hire-dialog.png') });
  console.log('✅ 03-hire-dialog.png');
  
  // 4. Close hire dialog, click Kanban
  await page.click('text=Anuluj', { timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(300);
  await page.click('text=Kanban board', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(UI_AUDIT, '04-kanban-board.png') });
  console.log('✅ 04-kanban-board.png');
  
  // 5. Click on a kanban task
  await page.click('.kanban-card >> nth=0', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(UI_AUDIT, '05-kanban-task-detail.png') });
  console.log('✅ 05-kanban-task-detail.png');
  
  // 6. Back to office view, open PM chat
  await page.click('text=Widok biura', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.selectOption('#pmSelect', { label: '🧠 Maya-PM (pm)' }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(UI_AUDIT, '06-pm-chat.png') });
  console.log('✅ 06-pm-chat.png');
  
  // 7. Context/project docs panel
  await page.click('text=Kontekst projektu', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(UI_AUDIT, '07-project-context.png') });
  console.log('✅ 07-project-context.png');
  
  // 8. Projects page
  await page.goto('http://localhost:18789/orchestrator/projects.html');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(UI_AUDIT, '08-projects-page.png') });
  console.log('✅ 08-projects-page.png');
  
  // 9. Settings panel
  await page.goto('http://localhost:18789/orchestrator/software-house?project=genor-paste');
  await page.waitForTimeout(2000);
  await page.click('text=⚙️', { timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(UI_AUDIT, '09-settings-panel.png') });
  console.log('✅ 09-settings-panel.png');
  
  await browser.close();
  console.log('\nDone! All screenshots saved to', UI_AUDIT);
})();
