// layout.js — computeRoomGrid, computeRoomSize, autoFitAllRooms, layoutAgentsInRoom, layoutAll, startAnim, stopAnim

import { state, DESK_W, DESK_H, COL_GAP, ROW_GAP, COL_SPACING, ROW_SPACING, ROOM_PAD_X, ROOM_PAD_Y, ROOM_GAP, framePlayers } from './state.js';
import { spritePath } from './utils.js';

export function computeRoomGrid(room) {
  const list = state.agents.filter(a => a.room === room.id);
  const count = Math.max(1, list.length);
  const layout = room.layout || 'auto';
  let cols, rows;
  if (layout === 'column') {
    cols = 1; rows = count;
  } else if (layout === 'row') {
    cols = count; rows = 1;
  } else if (count === 1) {
    cols = 1; rows = 1;
  } else if (count === 2) {
    cols = 2; rows = 1;
  } else {
    cols = Math.min(3, Math.ceil(Math.sqrt(count)));
    rows = Math.ceil(count / cols);
  }
  return { cols, rows, count: list.length };
}

export function computeRoomSize(room) {
  const { cols, rows } = computeRoomGrid(room);
  const w = ROOM_PAD_X * 2 + cols * DESK_W + Math.max(0, cols - 1) * COL_GAP;
  const h = ROOM_PAD_Y + rows * DESK_H + Math.max(0, rows - 1) * ROW_GAP + 48;
  return { w, h, cols, rows };
}

export function autoFitAllRooms() {
  if (state.manualRoomLayout) return;
  state.rooms.forEach(r => {
    const { w, h } = computeRoomSize(r);
    r.w = w;
    r.h = h;
  });
  const command = state.rooms.find(r => r.isCommand);
  const open = state.rooms.find(r => r.isOpenFloor);
  const middle = state.rooms.filter(r => !r.isCommand && !r.isOpenFloor);
  let y = 30;
  if (command) {
    command.y = y;
    y += command.h + ROOM_GAP;
  }
  let x = 40;
  let rowH = 0;
  middle.forEach(r => {
    r.x = x;
    r.y = y;
    x += r.w + ROOM_GAP;
    rowH = Math.max(rowH, r.h);
  });
  if (middle.length) y += rowH + ROOM_GAP;
  if (open) {
    open.x = 40;
    open.y = y;
  }
  if (command && middle.length) {
    const rowW = middle.reduce((s, r, i) => s + r.w + (i ? ROOM_GAP : 0), 0);
    command.x = 40 + Math.max(0, Math.floor((rowW - command.w) / 2));
  } else if (command) {
    command.x = 40;
  }
}

export function layoutAgentsInRoom(roomId) {
  const room = state.rooms.find(r => r.id === roomId);
  const list = state.agents.filter(a => a.room === roomId);
  if (!list.length) return;

  const { cols, rows } = computeRoomGrid(room);
  const layout = room.layout || 'auto';
  const innerW = Math.max(DESK_W, room.w - ROOM_PAD_X * 2);
  let spacingX = COL_SPACING;
  let spacingY = ROW_SPACING;

  if (layout === 'row' && list.length > 1) {
    const totalW = list.length * DESK_W + (list.length - 1) * COL_GAP;
    spacingX = totalW <= innerW ? COL_SPACING : Math.max(DESK_W + 8, (innerW - DESK_W) / (list.length - 1));
    spacingY = 0;
  } else if (layout === 'column') {
    spacingX = 0;
    spacingY = ROW_SPACING;
  }

  list.forEach((a, i) => {
    const col = layout === 'row' ? i : (layout === 'column' ? 0 : i % cols);
    const row = layout === 'row' ? 0 : (layout === 'column' ? i : Math.floor(i / cols));
    a._x = room.x + ROOM_PAD_X + col * spacingX;
    a._y = room.y + ROOM_PAD_Y + row * spacingY;
  });
  room._computedH = room.h;
  room._computedW = room.w;
}

export function layoutAll() {
  if (!state.manualRoomLayout) autoFitAllRooms();
  state.rooms.forEach(r => layoutAgentsInRoom(r.id));
  const maxY = Math.max(...state.rooms.map(r => r.y + r.h), 400);
  const maxX = Math.max(...state.rooms.map(r => r.x + r.w + 80), 800);
  document.getElementById('officeGrid').style.width = maxX + 'px';
  document.getElementById('officeGrid').style.height = (maxY + 100) + 'px';
}

export function startAnim(img, sprite, fps = 8) {
  stopAnim(img);
  let i = 0;
  const tick = () => { img.src = spritePath(sprite, i); i = (i + 1) % 9; };
  tick();
  framePlayers.set(img, setInterval(tick, 1000 / fps));
}

export function stopAnim(img) {
  const id = framePlayers.get(img);
  if (id) { clearInterval(id); framePlayers.delete(img); }
}
