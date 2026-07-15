// app.js — init (DOMContentLoaded), imports all modules, wires cross-module calls

import { state, loadData, loadModels, syncFromStore } from './state.js';
import { toast } from './utils.js';
import { renderRooms } from './rooms.js';
import { renderDesks } from './workers.js';
import { renderKanbanFull } from './kanban.js';
import { renderVault } from './vault.js';
import { renderProjPanel, updateStats, openDetailPanel, closeDetailPanel } from './panels.js';
import { setMainView, showSettings, initProjectSelect, switchProject, applyFontScale, changeFontScale } from './nav.js';
import { addBotMsg, orchSay, sendChat, onChatWorkerSelect, openWorkerMessageModal, closeWorkerMessageModal, sendWorkerMessage, checkWorkerHealth, orchPlan, loadChatHistory, toggleChatPanel } from './chat.js';
import { openPmBubble, closePmBubble, positionPmBubble, pmQuick, sendPmBubble } from './pm-bubble.js';
import { openHireModal, closeHire, pickSprite, confirmHire, saveAgent, fireAgent } from './workers.js';
import { toggleRoomEdit, setRoomLayout, saveLayoutToAPI, addRoom, deleteRoom, renderRoomPanel, toggleRoomTaskType, saveRoomPanel } from './rooms.js';
import { openAgentPanel } from './workers.js';
import { renderTaskPanel, moveTask, startTaskExecution, assignAndStartTask } from './kanban.js';
import { openVaultFile, injectVaultDoc } from './vault.js';
import { updateRepoStatus, repoPull, repoPush, refreshRepoStatus } from './repo.js';
import { applyTransform, focusRoom, zoomOffice, resetView, canvasPoint, onRoomPointerDown, startRoomDrag, startRoomResize } from './canvas.js';

// Expose functions to window for inline onclick handlers
window._renderAll = renderAll;
window._renderRooms = renderRooms;
window._renderDesks = renderDesks;
window._openHireModal = openHireModal;
window._openAgentPanel = openAgentPanel;
window._openRoomPanel = (id) => openDetailPanel('room', id);
window._openTaskPanel = (id) => openDetailPanel('task', id);
window._closeDetailPanel = closeDetailPanel;
window._setRoomLayout = setRoomLayout;
window._startRoomResize = startRoomResize;
window._onRoomPointerDown = onRoomPointerDown;
window._focusRoom = focusRoom;
window._openPmBubble = openPmBubble;
window._closePmBubble = closePmBubble;
window._positionPmBubble = positionPmBubble;
window._pmQuick = pmQuick;
window._orchSay = orchSay;
window._setMainView = setMainView;
window._openWorkerMessageModal = openWorkerMessageModal;
window.toggleChatPanel = toggleChatPanel;
window._closeWorkerMessageModal = closeWorkerMessageModal;
window._sendWorkerMessage = sendWorkerMessage;
window._checkWorkerHealth = checkWorkerHealth;
window._addBotMsg = addBotMsg;
window._loadData = loadData;
window._saveAgent = saveAgent;
window._fireAgent = fireAgent;
window._deleteRoom = deleteRoom;
window._saveRoomPanel = saveRoomPanel;
window._toggleRoomTaskType = toggleRoomTaskType;
window._moveTask = moveTask;
window._startTaskExecution = startTaskExecution;
window._assignAndStartTask = assignAndStartTask;
window._injectVaultDoc = injectVaultDoc;
window._openVaultFile = openVaultFile;

// Also expose standalone functions for non-inline usage
window.orchSay = orchSay;
window.orchPlan = orchPlan;
window.sendChat = sendChat;
window.sendPmBubble = sendPmBubble;
window.closePmBubble = closePmBubble;
window.closeHire = closeHire;
window.pickSprite = pickSprite;
window.confirmHire = confirmHire;
window.setMainView = setMainView;
window.showSettings = (btn) => showSettings(btn);
window.switchProject = switchProject;
window.openHireModal = openHireModal;
window.addRoom = addRoom;
window.toggleRoomEdit = toggleRoomEdit;
window.zoomOffice = zoomOffice;
window.resetView = resetView;
window.changeFontScale = changeFontScale;
window.refreshRepoStatus = refreshRepoStatus;
window.repoPull = repoPull;
window.repoPush = repoPush;
window.toast = toast;

function renderAll() {
  renderRooms();
  renderDesks();
  if (state.project) renderKanbanFull();
  renderProjPanel();
  updateStats();
  if (state.mainView === 'vault') renderVault();
  if (state.pmBubbleOpen) positionPmBubble();
}

// Wire syncFromStore to include full render pipeline
// The store 'change' event triggers syncFromStore in state.js;
// we add a second listener that does the post-sync render
store.addEventListener('change', () => {
  applyTransform();
  focusRoom('command');
  initProjectSelect();
  updateRepoStatus();
  renderAll();
  const ws = document.getElementById('chatWorkerSelect');
  if (ws) {
    ws.innerHTML = '<option value="">🧠 Wybierz pracownika…</option>' + 
      state.agents.map(a => `<option value="${a.id}">${a.isOrchestrator ? '🧠' : '👤'} ${a.name} (${a.role})</option>`).join('');
  }
});

// INIT
try {
  const saved = localStorage.getItem('sh-fs-scale');
  if (saved !== null) state.fontScaleIdx = Math.max(0, Math.min(3, parseInt(saved, 10)));
} catch (_) {}
applyFontScale();

document.addEventListener('click', e => {
  if (!state.pmBubbleOpen) return;
  if (e.target.closest('#pmBubble,.desk-slot')) return;
  closePmBubble();
});

window.addEventListener('resize', () => { if (state.pmBubbleOpen) positionPmBubble(); });

loadData().then(() => loadChatHistory());
applyTransform();
