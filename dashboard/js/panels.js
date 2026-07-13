// panels.js — openDetailPanel, closeDetailPanel, renderProjPanel, updateStats

import { state, STATUS } from './state.js';
import { staticPath, visualState } from './utils.js';
import { renderAgentPanel } from './workers.js';
import { renderRoomPanel } from './rooms.js';
import { renderTaskPanel } from './kanban.js';

export function openDetailPanel(mode, id) {
  window._closePmBubble();
  state.detailMode = mode;
  state.detailId = id;
  if (mode === 'agent') {
    state.selectedAgent = id;
    state.editingRoomId = null;
    renderAgentPanel(id);
  } else if (mode === 'room') {
    state.editingRoomId = id;
    state.selectedAgent = null;
    renderRoomPanel(id);
  } else if (mode === 'task') {
    state.selectedAgent = null;
    state.editingRoomId = null;
    renderTaskPanel(id);
  }
  document.getElementById('detailPanel').classList.add('open');
  window._renderRooms();
  window._renderDesks();
  renderProjPanel();
}

export function closeDetailPanel() {
  state.detailMode = null;
  state.detailId = null;
  state.selectedAgent = null;
  state.editingRoomId = null;
  state.roomPointer = null;
  document.getElementById('detailPanel').classList.remove('open');
  document.getElementById('detailHead').innerHTML = '';
  document.getElementById('detailBody').innerHTML = '';
  document.getElementById('detailFoot').innerHTML = '';
  window._renderRooms();
  window._renderDesks();
  renderProjPanel();
}

export function renderProjPanel() {
  const s = getTeamStats();
  document.getElementById('projStats').innerHTML = `
    <div class="stat-card wide"><div><div class="num">${s.total}</div><div class="lbl">Pracowników</div></div>
      <div style="text-align:right;font-size:10px;color:var(--text-dim)">${s.tasks} aktywnych tasków</div></div>
    <div class="stat-card working"><div class="num">${s.working}</div><div class="lbl">Pracuje</div></div>
    <div class="stat-card sleep"><div class="num">${s.sleep}</div><div class="lbl">Sleep</div></div>
    <div class="stat-card error"><div class="num">${s.errors}</div><div class="lbl">Błędy</div></div>`;
  const command = state.rooms.find(r => r.isCommand);
  let listHtml = '';
  if (command) {
    const active = state.detailMode === 'room' && state.detailId === command.id ? ' active' : '';
    listHtml += `<div class="room-row${active}" onclick="window._openRoomPanel('${command.id}')">
      <span class="dot" style="background:${command.color}"></span>
      <span class="name">${command.name}</span>
      <span class="cnt">1</span>
      <button class="mini-gear" onclick="event.stopPropagation();window._openRoomPanel('${command.id}')">⚙️</button>
    </div>`;
  }
  listHtml += state.rooms.filter(r => !r.isCommand).map(r => {
    const cnt = state.agents.filter(a => a.room === r.id).length;
    const active = state.detailMode === 'room' && state.detailId === r.id ? ' active' : '';
    return `<div class="room-row${active}" onclick="window._openRoomPanel('${r.id}')">
      <span class="dot" style="background:${r.color}"></span>
      <span class="name">${r.name}</span>
      <span class="cnt">${cnt}</span>
      <button class="mini-gear" title="Ustawienia pokoju" onclick="event.stopPropagation();window._openRoomPanel('${r.id}')">⚙️</button>
      <button class="mini-hire" title="Zatrudnij do ${r.name}" onclick="event.stopPropagation();window._openHireModal('${r.id}')">+</button>
    </div>`;
  }).join('');
  document.getElementById('panelRoomList').innerHTML = listHtml;
}

function getTeamStats() {
  const devs = state.agents;
  const working = devs.filter(a => ['working','reviewing','thinking'].includes(visualState(a))).length;
  const sleep = devs.filter(a => visualState(a) === 'sleep').length;
  const errors = devs.filter(a => visualState(a) === 'error').length;
  return { total: devs.length, working, sleep, errors, tasks: state.tasks.filter(t => t.phase !== 'done').length };
}

export function updateStats() {
  renderProjPanel();
}
