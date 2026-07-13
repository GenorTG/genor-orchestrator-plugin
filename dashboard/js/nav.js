// nav.js — setMainView, showSettings, initProjectSelect, createNewProject, showProjectCreateModal, showModalPrompt, showModalConfirm, switchProject, getTeamStats, applyFontScale, changeFontScale

import { state, FONT_SCALES } from './state.js';
import { visualState, toast } from './utils.js';
import { renderKanbanFull } from './kanban.js';
import { renderVault } from './vault.js';
import { closeDetailPanel, renderProjPanel, updateStats } from './panels.js';

export function setMainView(mode, navBtn) {
  state.mainView = mode;
  window._closePmBubble();
  document.getElementById('settingsView').classList.remove('show');
  document.getElementById('vaultView').classList.remove('show');
  document.querySelector('.chat-panel').style.display = 'flex';
  document.getElementById('projPanel').style.display = 'flex';
  document.getElementById('officeView').classList.toggle('hidden', mode !== 'office');
  document.getElementById('kanbanFullView').classList.toggle('show', mode === 'kanban');
  document.getElementById('vaultView').classList.toggle('show', mode === 'vault');
  document.getElementById('btnViewOffice').classList.toggle('active', mode === 'office');
  document.getElementById('btnViewKanban').classList.toggle('active', mode === 'kanban');
  document.getElementById('btnViewVault').classList.toggle('active', mode === 'vault');
  document.getElementById('navOffice').classList.toggle('active', mode === 'office');
  document.getElementById('navKanban').classList.toggle('active', mode === 'kanban');
  document.getElementById('navVault').classList.toggle('active', mode === 'vault');
  if (navBtn) {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    navBtn.classList.add('active');
  }
  if (mode === 'kanban') renderKanbanFull();
  if (mode === 'vault') renderVault();
}

export function showSettings(navBtn) {
  closeDetailPanel();
  window._closePmBubble();
  state.mainView = 'settings';
  document.getElementById('officeView').classList.add('hidden');
  document.getElementById('kanbanFullView').classList.remove('show');
  document.getElementById('vaultView').classList.remove('show');
  document.getElementById('settingsView').classList.add('show');
  document.querySelector('.chat-panel').style.display = 'none';
  document.getElementById('projPanel').style.display = 'none';
  document.getElementById('btnViewOffice').classList.remove('active');
  document.getElementById('btnViewKanban').classList.remove('active');
  document.getElementById('btnViewVault').classList.remove('active');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  if (navBtn) navBtn.classList.add('active');
}

export function initProjectSelect() {
  const sel = document.getElementById('projectSelect');
  const catalog = window.__projectsCatalog || {};
  sel.innerHTML = Object.values(catalog).map(p =>
    `<option value="${p.id}"${!p.hasWorkers ? ' style="color:var(--text-dim)"' : ''}>${p.name}${!p.hasWorkers ? ' (empty)' : ''}</option>`).join('') +
    `<option value="__new__" style="color:var(--green);font-weight:700">➕ Nowy projekt…</option>`;
  sel.value = state.currentProjectId;
}

export async function createNewProject(name, repoUrl) {
  try {
    const body = { name };
    if (repoUrl) body.repo_url = repoUrl;
    const data = await store.createProject(name, repoUrl);
    if (!data || !data.ok) throw new Error((data && data.error) || 'Create failed');
    const tag = repoUrl ? 'cloned from repo' : 'utworzony';
    toast(`✅ Projekt "${name}" ${tag}`);
    window.location.href = '/orchestrator/software-house?project=' + encodeURIComponent(name);
  } catch (e) {
    toast('⚠️ ' + e.message);
  }
}

export function showProjectCreateModal() {
  var ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = '<div class="modal-box"><h3>➕ Nowy projekt</h3><input type="text" id="_pcName" placeholder="Nazwa projektu" style="margin-bottom:8px"><input type="text" id="_pcRepo" placeholder="URL repozytorium (opcjonalnie)" style="margin-bottom:16px"><div class="modal-actions"><button class="btn" id="_pcCancel">Anuluj</button><button class="btn primary" id="_pcOk">Utwórz</button></div></div>';
  document.body.appendChild(ov);
  var nameInput = document.getElementById('_pcName');
  var repoInput = document.getElementById('_pcRepo');
  nameInput.focus();
  function done() {
    var name = nameInput.value.trim();
    if (!name) return;
    ov.remove();
    createNewProject(name, repoInput.value.trim() || '');
  }
  document.getElementById('_pcOk').onclick = done;
  document.getElementById('_pcCancel').onclick = function() { ov.remove(); };
  nameInput.onkeydown = function(e) { if (e.key === 'Enter') done(); if (e.key === 'Escape') ov.remove(); };
  repoInput.onkeydown = function(e) { if (e.key === 'Enter') done(); };
}

export function showModalPrompt(title, defaultVal) {
  defaultVal = defaultVal || '';
  return new Promise(function(resolve) {
    var ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = '<div class="modal-box"><h3>' + title + '</h3><input type="text" id="_mpInput" value="' + defaultVal.replace(/"/g, '&quot;') + '"><div class="modal-actions"><button class="btn" id="_mpCancel">Anuluj</button><button class="btn primary" id="_mpOk">OK</button></div></div>';
    document.body.appendChild(ov);
    var inp = document.getElementById('_mpInput');
    inp.focus(); inp.select();
    function done(v) { ov.remove(); resolve(v); }
    document.getElementById('_mpOk').onclick = function() { done(inp.value); };
    document.getElementById('_mpCancel').onclick = function() { done(null); };
    inp.onkeydown = function(e) { if (e.key === 'Enter') done(inp.value); if (e.key === 'Escape') done(null); };
  });
}

export function showModalConfirm(title, msg) {
  return new Promise(function(resolve) {
    var ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = '<div class="modal-box"><h3>' + title + '</h3><p>' + msg + '</p><div class="modal-actions"><button class="btn" id="_mcNo">Nie</button><button class="btn primary" id="_mcYes">Tak</button></div></div>';
    document.body.appendChild(ov);
    function done(v) { ov.remove(); resolve(v); }
    document.getElementById('_mcYes').onclick = function() { done(true); };
    document.getElementById('_mcNo').onclick = function() { done(false); };
  });
}

export async function switchProject(id) { 
  if (id === '__new__') {
    showProjectCreateModal();
    document.getElementById('projectSelect').value = state.currentProjectId;
    return;
  }
  if (id === state.currentProjectId) return;
  window.location.href = '/orchestrator/software-house?project=' + encodeURIComponent(id);
}

export function getTeamStats() {
  const devs = state.agents;
  const working = devs.filter(a => ['working','reviewing','thinking'].includes(visualState(a))).length;
  const sleep = devs.filter(a => visualState(a) === 'sleep').length;
  const errors = devs.filter(a => visualState(a) === 'error').length;
  return { total: devs.length, working, sleep, errors, tasks: state.tasks.filter(t => t.phase !== 'done').length };
}

export function applyFontScale() {
  const scale = FONT_SCALES[state.fontScaleIdx];
  document.documentElement.style.setProperty('--fs-scale', scale);
  document.getElementById('fontScaleLabel').textContent = Math.round(scale * 100) + '%';
  try { localStorage.setItem('sh-fs-scale', state.fontScaleIdx); } catch (_) {}
}

export function changeFontScale(delta) {
  state.fontScaleIdx = Math.max(0, Math.min(FONT_SCALES.length - 1, state.fontScaleIdx + delta));
  applyFontScale();
}
