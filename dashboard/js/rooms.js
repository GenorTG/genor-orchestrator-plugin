// rooms.js — renderRooms, toggleRoomEdit, setRoomLayout, saveLayoutToAPI, addRoom, deleteRoom, roomForTaskType, renderRoomTaskTypeChips, renderRoomPanel, toggleRoomTaskType, saveRoomPanel

import { state, STATUS, TASK_TYPES } from './state.js';
import { staticPath, visualState, toast } from './utils.js';
import { computeRoomSize, layoutAll } from './layout.js';

export function renderRooms() {
  layoutAll();
  document.getElementById('rooms').innerHTML = state.rooms.map(r => {
    const editCls = state.roomEditEnabled ? ' editable' : '';
    const activeCls = state.detailMode === 'room' && state.detailId === r.id ? ' active' : '';
    const hireBtn = !r.isCommand
      ? `<button class="room-hire-fab" onclick="event.stopPropagation();window._openHireModal('${r.id}')">+ Pracownik</button>` : '';
    const layoutBtns = state.roomEditEnabled ? `
      <div class="room-layout-btns" onclick="event.stopPropagation()">
        <button class="${(r.layout||'auto')==='row'?'active':''}" title="Obok siebie" onclick="window._setRoomLayout('${r.id}','row')">▤</button>
        <button class="${r.layout==='column'?'active':''}" title="Jeden pod drugim" onclick="window._setRoomLayout('${r.id}','column')">▥</button>
        <button class="${!r.layout||r.layout==='auto'?'active':''}" title="Auto siatka" onclick="window._setRoomLayout('${r.id}','auto')">⬚</button>
      </div>` : '';
    const resizeHandles = state.roomEditEnabled ? `
      <div class="room-resize-handle room-resize-e" onmousedown="window._startRoomResize(event,'${r.id}','e')"></div>
      <div class="room-resize-handle room-resize-s" onmousedown="window._startRoomResize(event,'${r.id}','s')"></div>
      <div class="room-resize-handle room-resize-se" onmousedown="window._startRoomResize(event,'${r.id}','se')"></div>` : '';
    const mouseAttr = ` onmousedown="window._onRoomPointerDown(event,'${r.id}')"`;
    return `<div class="room-zone${editCls}${activeCls}" data-room="${r.id}" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;border-color:${r.color}44"${mouseAttr}>
      <div class="room-label">
        <span style="color:${r.color}">${r.name}</span>
        ${state.roomEditEnabled ? '<span class="room-drag-hint">przeciągnij / rozciągnij</span>' : ''}
      </div>${layoutBtns}${hireBtn}${resizeHandles}</div>`;
  }).join('');
  document.getElementById('roomTabs').innerHTML = state.rooms.map(r =>
    `<button class="room-tab" onclick="window._focusRoom('${r.id}')">${r.name}</button>`).join('');
  const hireRoom = document.getElementById('hireRoom');
  if (hireRoom) hireRoom.innerHTML = state.rooms.filter(r => !r.isCommand).map(r =>
    `<option value="${r.id}">${r.name}</option>`).join('');
}

export function toggleRoomEdit() {
  state.roomEditEnabled = !state.roomEditEnabled;
  const btn = document.getElementById('layoutToggle');
  btn.textContent = state.roomEditEnabled ? '✥ Edycja pokoi: ON' : '✥ Edycja pokoi: OFF';
  btn.style.background = state.roomEditEnabled ? 'rgba(167,139,250,.15)' : '';
  if (state.roomEditEnabled) {
    state.manualRoomLayout = true;
    toast('Przeciągaj pokoje, rozciągaj uchwyty, ustaw układ agentów ▤▥⬚');
  }
  renderRooms();
}

export function setRoomLayout(roomId, layout) {
  const room = state.rooms.find(r => r.id === roomId);
  if (!room) return;
  room.layout = layout;
  state.roomEditEnabled = true;
  document.getElementById('layoutToggle').textContent = '✥ Edycja pokoi: ON';
  if (!state.manualRoomLayout) layoutAll();
  renderRooms();
  window._renderDesks && window._renderDesks();
}

export function saveLayoutToAPI() {
  const layoutData = state.rooms.map(r => ({
    id: r.id, x: r.x, y: r.y, w: r.w, h: r.h
  }));
  store.saveLayout({ rooms: layoutData }).then(data => {
    if (data && data.ok) console.log('Layout saved to API');
    else console.error('Layout save failed:', data.error);
  }).catch(err => console.error('Layout save error:', err));
}

export function roomForTaskType(type) {
  return state.rooms.find(r => r.taskTypes && r.taskTypes.includes(type) && !r.isCommand);
}

export function renderRoomTaskTypeChips(selected) {
  return TASK_TYPES.map(tt =>
    `<button type="button" class="task-type-chip${selected.includes(tt.id)?' on':''}" data-type="${tt.id}" onclick="window._toggleRoomTaskType('${tt.id}')">${tt.label}</button>`
  ).join('');
}

export function renderRoomPanel(roomId) {
  state.editingRoomId = roomId;
  const r = state.rooms.find(x => x.id === roomId);
  if (!r) return;
  state.pickedRoomTaskTypes = [...(r.taskTypes || [])];
  const devs = state.agents.filter(a => a.room === roomId);
  const routed = state.tasks.filter(t => r.taskTypes?.includes(t.type));
  const size = computeRoomSize(r);

  document.getElementById('detailHead').innerHTML = `
    <div class="detail-head-top">
      <div style="flex:1;min-width:0">
        <h2>🏢 ${r.name}</h2>
        <p>${r.isCommand ? 'Command Center' : 'Ustawienia pokoju'}</p>
      </div>
      <button class="detail-close" onclick="window._closeDetailPanel()">×</button>
    </div>`;

  document.getElementById('detailBody').innerHTML = `
    ${r.isCommand ? `<p style="font-size:12px;color:var(--text-dim);line-height:1.5">${r.purpose || ''}</p>` : `
    <div class="form-grid">
      <div class="form-field"><label>Nazwa</label><input id="rmName" value="${r.name}"></div>
      <div class="form-field"><label>Kolor</label><input id="rmColor" type="color" value="${r.color}"></div>
      <div class="form-field"><label>Do czego służy</label><textarea id="rmPurpose">${r.purpose||''}</textarea></div>
      <div class="form-field"><label>Routing tasków</label>
        <div class="task-type-chips" id="rmTaskTypes">${renderRoomTaskTypeChips(state.pickedRoomTaskTypes)}</div>
      </div>
    </div>`}
    <div style="margin-top:12px;padding:10px;background:var(--bg-floor);border-radius:8px;border:1px solid var(--border);font-size:10px;color:var(--text-dim)">
      Rozmiar: <b style="color:var(--text-bright)">${size.w}×${size.h}px</b> · Taski: <b style="color:var(--text-bright)">${routed.length}</b>
    </div>
    ${devs.length ? `<div class="detail-section"><h4>Pracownicy (${devs.length})</h4>
      ${devs.map(a=>`<div class="dev-mini-row${state.detailMode==='agent'&&state.detailId===a.id?' active':''}" onclick="window._openAgentPanel('${a.id}')">
        <img src="${staticPath(a.sprite)}" alt="">
        <div class="info"><div class="name">${a.name}</div><div class="role">${a.role}</div></div>
        <span class="status-pill">${STATUS[visualState(a)]?.label||''}</span>
      </div>`).join('')}
    </div>` : `<p style="margin-top:12px;font-size:11px;color:var(--text-dim)">Brak pracowników — <button class="btn" style="padding:4px 8px;font-size:10px;margin-left:4px" onclick="window._openHireModal('${r.id}')">+ Zatrudnij</button></p>`}
    <button class="btn" style="width:100%;margin-top:12px" onclick="window._focusRoom('${r.id}')">🎯 Pokaż na mapie</button>`;

  document.getElementById('detailFoot').innerHTML = `
    ${!r.isCommand ? '<button class="btn danger" onclick="window._deleteRoom()">Usuń</button>' : ''}
    ${!r.isCommand ? '<button class="btn primary" onclick="window._saveRoomPanel()">💾 Zapisz</button>' : '<button class="btn" onclick="window._closeDetailPanel()">Zamknij</button>'}`;
}

export function toggleRoomTaskType(id) {
  if (state.pickedRoomTaskTypes.includes(id)) state.pickedRoomTaskTypes = state.pickedRoomTaskTypes.filter(x => x !== id);
  else state.pickedRoomTaskTypes.push(id);
  document.querySelectorAll('#rmTaskTypes .task-type-chip').forEach(el =>
    el.classList.toggle('on', state.pickedRoomTaskTypes.includes(el.dataset.type)));
}

export function saveRoomPanel() {
  const r = state.rooms.find(x => x.id === state.editingRoomId);
  if (!r || r.isCommand) return;
  const updates = {
    name: document.getElementById('rmName').value.trim() || r.name,
    color: document.getElementById('rmColor').value,
    purpose: document.getElementById('rmPurpose').value,
    taskTypes: [...state.pickedRoomTaskTypes],
  };
  store.api(`/software-house/rooms/${r.id}?project=${state.currentProjectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  }).then(data => {
    if (data && data.ok) {
      Object.assign(r, updates);
      window._renderAll();
      renderRoomPanel(r.id);
      toast(`🏢 Pokój "${r.name}" zapisany`);
    } else {
      toast(`❌ Błąd: ${data.error}`);
    }
  }).catch(err => { toast(`❌ Błąd sieci: ${err.message}`); });
}

export function deleteRoom() {
  const r = state.rooms.find(x => x.id === state.editingRoomId);
  if (!r || r.isCommand) return;
  const inRoom = state.agents.filter(a => a.room === r.id);
  if (inRoom.length && !confirm(`Pokój ma ${inRoom.length} agentów. Przenieść na Open Floor?`)) return;
  store.api(`/software-house/rooms/${r.id}?project=${state.currentProjectId}`, {
    method: 'DELETE'
  }).then(data => {
    if (data && data.ok) {
      const fallback = state.rooms.find(x => x.isOpenFloor) || state.rooms.find(x => !x.isCommand && x.id !== r.id);
      inRoom.forEach(a => { if (fallback) a.room = fallback.id; });
      state.rooms = state.rooms.filter(x => x.id !== state.editingRoomId);
      state.manualRoomLayout = false;
      window._closeDetailPanel();
      window._renderAll();
      toast('Pokój usunięty');
    } else {
      toast(`❌ Błąd: ${data.error}`);
    }
  }).catch(err => { toast(`❌ Błąd sieci: ${err.message}`); });
}

export function addRoom() {
  const roomData = {
    name: 'Nowy pokój', purpose: 'Opisz do czego służy ten pokój w projekcie.',
    taskTypes: ['dev'], x: 40, y: 400, w: 160, h: 160,
  };
  store.api(`/software-house/rooms?project=${state.currentProjectId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(roomData)
  }).then(data => {
    if (data && data.ok) {
      const id = data.room.id;
      state.rooms.push({
        id, name: roomData.name, tag: 'custom', color: '#22d3ee',
        purpose: roomData.purpose, taskTypes: roomData.taskTypes, layout: 'auto',
        x: roomData.x, y: roomData.y, w: roomData.w, h: roomData.h,
      });
      state.manualRoomLayout = false;
      window._renderAll();
      renderRoomPanel(id);
      toast('Ustaw nazwę, tag i routing tasków');
    } else {
      toast(`❌ Błąd: ${data.error}`);
    }
  }).catch(err => { toast(`❌ Błąd sieci: ${err.message}`); });
}
