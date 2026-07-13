// utils.js — spritePath, staticPath, formatTime, visualState, deepClone, toast

import { STATUS } from './state.js';

export function spritePath(s, f) { return `assets/pixel-agents/${s}/frames/${f}.png`; }
export function staticPath(s) { return `assets/pixel-agents/${s}/static.png`; }

export function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('pl-PL');
}

export function visualState(a) {
  if (a.status === 'idle') return 'sleep';
  return a.status;
}

export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(t._t); t._t = setTimeout(() => t.style.display = 'none', 2200);
}
