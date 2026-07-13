// canvas.js — canvasPoint, onRoomPointerDown, startRoomDrag, startRoomResize, applyTransform, zoomOffice, resetView, focusRoom

import { state, MIN_ROOM_W, MIN_ROOM_H } from './state.js';
import { saveLayoutToAPI } from './rooms.js';

const officeEl = document.getElementById('office');
const canvasEl = document.getElementById('officeCanvas');
let dragging = false;
let dragStart = { x: 0, y: 0 };

export function canvasPoint(e) {
  const rect = officeEl.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left - state.officePan.x) / state.officeZoom,
    y: (e.clientY - rect.top - state.officePan.y) / state.officeZoom,
  };
}

export function onRoomPointerDown(e, roomId) {
  if (e.target.closest('.desk-slot,.room-hire-fab,.room-layout-btns,.room-resize-handle')) return;
  if (state.roomEditEnabled) {
    startRoomDrag(e, roomId);
    return;
  }
  e.stopPropagation();
  state.roomPointer = { id: roomId, x: e.clientX, y: e.clientY };
}

export function startRoomDrag(e, roomId) {
  if (!state.roomEditEnabled) return;
  if (e.target.closest('.room-hire-fab,.room-layout-btns,.room-resize-handle,.room-settings-fab')) return;
  e.stopPropagation();
  e.preventDefault();
  state.draggingRoomId = roomId;
  state.manualRoomLayout = true;
  const room = state.rooms.find(r => r.id === roomId);
  const p = canvasPoint(e);
  state.roomDragStart = { mx: p.x, my: p.y, rx: room.x, ry: room.y };
  document.querySelectorAll('.room-zone').forEach(el =>
    el.classList.toggle('dragging-room', el.dataset.room === roomId));
}

export function startRoomResize(e, roomId, handle) {
  if (!state.roomEditEnabled) return;
  e.stopPropagation();
  e.preventDefault();
  state.manualRoomLayout = true;
  const room = state.rooms.find(r => r.id === roomId);
  const p = canvasPoint(e);
  state.resizingRoom = { id: roomId, handle, mx: p.x, my: p.y, rw: room.w, rh: room.h };
  document.querySelectorAll('.room-zone').forEach(el =>
    el.classList.toggle('resizing', el.dataset.room === roomId));
}

// PAN/ZOOM event listeners
officeEl.addEventListener('mousedown', e => {
  if (e.target.closest('.desk-slot,.modal,.room-hire-fab,.room-layout-btns,.room-resize-handle,#detailPanel')) return;
  if (e.target.closest('.room-zone')) return;
  dragging = true; officeEl.classList.add('dragging');
  dragStart = { x: e.clientX - state.officePan.x, y: e.clientY - state.officePan.y };
});

window.addEventListener('mousemove', e => {
  if (state.resizingRoom) {
    const room = state.rooms.find(r => r.id === state.resizingRoom.id);
    const p = canvasPoint(e);
    const dx = p.x - state.resizingRoom.mx;
    const dy = p.y - state.resizingRoom.my;
    if (state.resizingRoom.handle.includes('e')) room.w = Math.max(MIN_ROOM_W, state.resizingRoom.rw + dx);
    if (state.resizingRoom.handle.includes('s')) room.h = Math.max(MIN_ROOM_H, state.resizingRoom.rh + dy);
    window._renderRooms();
    window._renderDesks();
    return;
  }
  if (state.draggingRoomId) {
    const p = canvasPoint(e);
    const room = state.rooms.find(r => r.id === state.draggingRoomId);
    room.x = Math.max(0, state.roomDragStart.rx + (p.x - state.roomDragStart.mx));
    room.y = Math.max(0, state.roomDragStart.ry + (p.y - state.roomDragStart.my));
    window._renderRooms();
    window._renderDesks();
    return;
  }
  if (state.roomPointer && !dragging) {
    const moved = Math.hypot(e.clientX - state.roomPointer.x, e.clientY - state.roomPointer.y);
    if (moved > 6) {
      dragging = true;
      officeEl.classList.add('dragging');
      dragStart = { x: e.clientX - state.officePan.x, y: e.clientY - state.officePan.y };
      state.roomPointer = null;
    }
    return;
  }
  if (!dragging) return;
  state.officePan.x = e.clientX - dragStart.x;
  state.officePan.y = e.clientY - dragStart.y;
  applyTransform();
});

window.addEventListener('mouseup', () => {
  if (state.roomPointer) {
    window._openRoomPanel(state.roomPointer.id);
    state.roomPointer = null;
  }
  if (state.draggingRoomId) {
    saveLayoutToAPI();
    state.draggingRoomId = null;
    document.querySelectorAll('.room-zone').forEach(el => el.classList.remove('dragging-room'));
  }
  if (state.resizingRoom) {
    saveLayoutToAPI();
    state.resizingRoom = null;
    document.querySelectorAll('.room-zone').forEach(el => el.classList.remove('resizing'));
  }
  dragging = false;
  officeEl.classList.remove('dragging');
});

officeEl.addEventListener('wheel', e => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? -0.07 : 0.07;
  const rect = officeEl.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const prev = state.officeZoom;
  state.officeZoom = Math.min(1.45, Math.max(0.45, state.officeZoom + delta));
  const scale = state.officeZoom / prev;
  state.officePan.x = mx - (mx - state.officePan.x) * scale;
  state.officePan.y = my - (my - state.officePan.y) * scale;
  applyTransform();
}, { passive: false });

export function applyTransform() {
  canvasEl.style.transform = `translate(${state.officePan.x}px,${state.officePan.y}px) scale(${state.officeZoom})`;
  document.getElementById('zoomLabel').textContent = Math.round(state.officeZoom * 100) + '%';
  if (state.pmBubbleOpen) window._positionPmBubble();
}

export function zoomOffice(d) {
  state.officeZoom = Math.min(1.3, Math.max(.55, state.officeZoom + d));
  applyTransform();
}

export function resetView() {
  state.officeZoom = .92;
  state.officePan = { x: 30, y: 20 };
  applyTransform();
}

export function focusRoom(id) {
  const r = state.rooms.find(x => x.id === id);
  if (!r) return;
  state.officePan.x = -r.x * state.officeZoom + 60;
  state.officePan.y = -r.y * state.officeZoom + 50;
  applyTransform();
}
