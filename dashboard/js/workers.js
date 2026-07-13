// workers.js — renderDesks, onDeskClick, openAgentPanel, renderAgentPanel, saveAgent, fireAgent, openHireModal, closeHire, pickSprite, confirmHire, getRoleActions, renderPmBubbleActions

import { state, SPRITES, STATUS } from './state.js';
import { staticPath, spritePath, visualState, toast } from './utils.js';
import { startAnim, stopAnim } from './layout.js';

export function renderDesks() {
  const html = state.agents.map(a => {
    const vs = visualState(a);
    const st = STATUS[vs] || STATUS.sleep;
    const anim = state.animsEnabled && st.anim;
    const orch = a.isOrchestrator ? ' orchestrator' : '';
    const sel = state.selectedAgent === a.id ? ' selected' : '';
    return `<div class="desk-slot${orch}${sel}" style="left:${a._x}px;top:${a._y}px" onclick="window._onDeskClick(event,'${a.id}')">
      <div class="desk-card">
        <div class="sprite-stage state-${st.cls}" data-sprite="${a.sprite}" data-anim="${anim}">
          <img class="sprite" src="${anim ? spritePath(a.sprite,0) : staticPath(a.sprite)}" alt="">
          <div class="overlay-sleep">💤</div>
          <div class="overlay-think"></div>
          <div class="overlay-error">ERROR</div>
        </div>
        <div class="agent-meta">
          <div class="status-badge ${st.cls}"><span class="dot"></span>${st.label}</div>
          <div class="nameplate">${a.name}</div>
          <div class="role-tag">${a.role}</div>
          ${a.task ? `<div class="task-line">${a.task}</div>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
  document.getElementById('desks').innerHTML = html;
  document.querySelectorAll('.sprite-stage[data-anim="true"] .sprite').forEach(img => {
    const stage = img.parentElement;
    startAnim(img, stage.dataset.sprite);
  });
}

export function onDeskClick(e, id) {
  e.stopPropagation();
  const a = state.agents.find(x => x.id === id);
  if (!a) return;
  window._openPmBubble(id);
}

export function openAgentPanel(id) { window._openDetailPanel('agent', id); }

export function renderAgentPanel(id) {
  const a = state.agents.find(x => x.id === id);
  if (!a) return;
  const vs = visualState(a);
  const agentTasks = state.tasks.filter(t => t.agent === a.id);
  const isOrch = a.isOrchestrator;
  const room = state.rooms.find(r => r.id === a.room);

  document.getElementById('detailHead').innerHTML = `
    <div class="detail-head-top">
      <img class="preview" src="${staticPath(a.sprite)}" alt="">
      <div style="flex:1;min-width:0">
        <h2>${a.name} ${isOrch ? '🧠' : ''}</h2>
        <p>${a.role}</p>
        ${room ? `<p style="margin-top:2px;color:${room.color};font-size:10px;font-weight:600">${room.name}</p>` : ''}
      </div>
      <button class="detail-close" onclick="window._closeDetailPanel()" title="Zamknij">×</button>
    </div>`;

  document.getElementById('detailBody').innerHTML = `
    <div class="form-grid">
      <div class="form-field"><label>Status</label>
        <div style="padding:6px 10px;border-radius:6px;background:var(--bg-floor);color:var(--text-bright);font-size:12px;display:flex;align-items:center;gap:6px">
          <span class="dot" style="background:${vs==='working'?'var(--green)':vs==='thinking'?'var(--yellow)':vs==='sleep'?'var(--text-dim)':'var(--red)'}"></span>
          ${vs === 'working' ? '⚡ Working' : vs === 'thinking' ? '🤔 Thinking' : vs === 'reviewing' ? '👁️ Reviewing' : vs === 'sleep' ? '💤 Sleep' : vs === 'error' ? '🔴 Error' : vs || 'Unknown'}
        </div></div>
      <div class="form-field"><label>Model</label>
        <select id="mModel">${state.availableModels.length ? state.availableModels.map(m => `<option value="${m.id}"${a.model===m.id?' selected':''}>${m.name}${m.provider?' ['+m.provider+']':''}</option>`).join('') : `<option value="${a.model}">${a.model}</option>`}</select></div>
      <div class="form-field"><label>Pokój</label>
        <select id="mRoom">${state.rooms.map(r=>`<option value="${r.id}"${r.id===a.room?' selected':''}>${r.name}</option>`).join('')}</select></div>
      <div class="form-field"><label>Sprite</label>
        <select id="mSprite">${Object.entries(SPRITES).map(([k,v])=>
          `<option value="${k}"${a.sprite===k?' selected':''}>${v.label}</option>`).join('')}</select></div>
      <div class="form-field" style="display:flex;flex-direction:row;align-items:center;gap:8px;padding:16px 0 0">
        <input type="checkbox" id="mIsPm" style="width:18px;height:18px;cursor:pointer" ${a.isOrchestrator ? 'checked' : ''}>
        <label for="mIsPm" style="cursor:pointer;font-weight:700;color:var(--purple);font-size:12px">🧠 PM — Project Manager</label>
      </div>
      <div class="form-field"><label>Aktualne zadanie</label><input id="mTask" value="${a.task||''}" placeholder="Brak"></div>
      ${a.progress ? `<div class="form-field"><label>Postęp ${a.progress}%</label><div class="progress"><i style="width:${a.progress}%"></i></div></div>` : ''}
      <div class="form-field"><label>Instrukcje systemowe</label><textarea id="mPrompt">${a.prompt}</textarea></div>
    </div>
    ${room ? `<button class="btn" style="width:100%;margin-top:12px" onclick="window._openRoomPanel('${room.id}')">🏢 Ustawienia pokoju: ${room.name}</button>` : ''}
    ${agentTasks.length ? `<div class="detail-section"><h4>Taski (${agentTasks.length})</h4>
      ${agentTasks.map(t=>`<div class="kanban-card" onclick="window._openTaskPanel('${t.id}')">${t.pri} ${t.title}</div>`).join('')}
    </div>` : ''}
    ${!isOrch ? `<button class="btn" style="width:100%;margin-top:12px" onclick="window._openWorkerMessageModal('${a.id}')">💬 Wyślij wiadomość</button>` : ''}
    ${!isOrch ? `<button class="btn" style="width:100%;margin-top:8px" onclick="window._checkWorkerHealth('${a.id}')">🔍 Sprawdź zdrowie</button>` : ''}
    ${isOrch ? `<p style="margin-top:12px;font-size:11px;color:var(--purple)">🧠 Project Manager — <b>Thinking</b> = planuje sprint.</p>` : ''}`;

  document.getElementById('detailFoot').innerHTML = `
    ${isOrch ? '' : '<button class="btn danger" onclick="window._fireAgent()">Zwolnij</button>'}
    <button class="btn primary" onclick="window._saveAgent()">💾 Zapisz</button>`;
}

export function saveAgent() {
  const a = state.agents.find(x => x.id === state.selectedAgent);
  if (!a) return;
  const isPmCheckbox = document.getElementById('mIsPm');
  const isPm = isPmCheckbox ? isPmCheckbox.checked : a.isOrchestrator;
  const updates = {
    model: document.getElementById('mModel').value,
    room: document.getElementById('mRoom').value,
    sprite: document.getElementById('mSprite').value,
    task: document.getElementById('mTask').value || null,
    prompt: document.getElementById('mPrompt').value,
    is_pm: isPm,
  };
  store.api(`/software-house/workers/${a.id}?project=${state.currentProjectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  }).then(data => {
    if (data && data.ok) {
      Object.assign(a, updates);
      a.isOrchestrator = isPm;
      const ws = document.getElementById('chatWorkerSelect');
      ws.innerHTML = '<option value="">🧠 Wybierz pracownika…</option>' + 
        state.agents.map(x => `<option value="${x.id}">${x.isOrchestrator ? '🧠' : '👤'} ${x.name} (${x.role})</option>`).join('');
      window._renderAll();
      renderAgentPanel(a.id);
      toast(`💾 ${a.name} zaktualizowany`);
    } else {
      toast(`❌ Błąd: ${data.error}`);
    }
  }).catch(err => { toast(`❌ Błąd sieci: ${err.message}`); });
}

export function fireAgent() {
  const a = state.agents.find(x => x.id === state.selectedAgent);
  if (!a || a.isOrchestrator || !confirm(`Zwolnić ${a.name}?`)) return;
  store.api(`/software-house/workers/${a.id}?project=${state.currentProjectId}`, {
    method: 'DELETE'
  }).then(data => {
    if (data && data.ok) {
      state.agents = state.agents.filter(x => x.id !== state.selectedAgent);
      state.tasks.forEach(t => { if (t.agent === state.selectedAgent) t.agent = null; });
      window._closeDetailPanel();
      window._renderAll();
      toast(`👋 ${a.name} zwolniony`);
    } else {
      toast(`❌ Błąd: ${data.error}`);
    }
  }).catch(err => { toast(`❌ Błąd sieci: ${err.message}`); });
}

export function openHireModal(roomId) {
  const modelSelect = document.getElementById('hireModel');
  modelSelect.innerHTML = '';
  if (state.availableModels.length) {
    state.availableModels.forEach(m => {
      modelSelect.innerHTML += `<option value="${m.id}">${m.name}${m.provider?' ['+m.provider+']':''}</option>`;
    });
  } else {
    modelSelect.innerHTML = '<option value="opencode-go/minimax-m3">opencode-go/minimax-m3</option>';
  }
  if (roomId) document.getElementById('hireRoom').value = roomId;
  document.getElementById('hireOverlay').classList.add('show');
}

export function closeHire() { document.getElementById('hireOverlay').classList.remove('show'); }

export function pickSprite(el) {
  document.querySelectorAll('.sprite-opt').forEach(x => x.classList.remove('picked'));
  el.classList.add('picked'); state.pickedSprite = el.dataset.sprite;
}

export function confirmHire() {
  const isPm = document.getElementById('hireIsPm').checked;
  const workerData = {
    name: document.getElementById('hireName').value.trim() || 'Nowy Agent',
    role: isPm ? 'Project Manager' : document.getElementById('hireRole').value,
    sprite: state.pickedSprite,
    model: document.getElementById('hireModel').value,
    room: document.getElementById('hireRoom').value,
    prompt: document.getElementById('hirePrompt').value,
    is_pm: isPm,
  };
  store.api(`/software-house/workers/hire?project=${state.currentProjectId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(workerData)
  }).then(data => {
    if (data && data.ok) {
      const a = {
        id: data.worker.id, ...workerData,
        isOrchestrator: isPm, status: 'sleep', task: null, progress: 0, ctx: '0/195k',
      };
      state.agents.push(a);
      closeHire();
      window._renderAll();
      toast(`👋 ${a.name} zatrudniony!`);
      window._addBotMsg(`Zatrudniono <b>${a.name}</b> (${a.role}) → ${state.rooms.find(r=>r.id===a.room)?.name}. Bez limitu miejsc — pokój się rozciąga.`);
      setTimeout(() => openAgentPanel(a.id), 350);
    } else {
      toast(`❌ Błąd: ${data.error}`);
    }
  }).catch(err => { toast(`❌ Błąd sieci: ${err.message}`); });
}

export function getRoleActions(agent) {
  const role = (agent.role || '').toLowerCase();
  const isOrch = agent.isOrchestrator;
  const isDev = role.includes('dev') || role.includes('fullstack') || role.includes('full-stack');
  const isQA = role.includes('qa') || role.includes('test');
  const isReview = role.includes('review');
  const isPM = isOrch || role.includes('pm') || role.includes('project manager');

  if (isPM) return [
    {action:'status', label:'📊 Status zespołu'}, {action:'tasks', label:'📋 Zadania'},
    {action:'blockers', label:'🚧 Blokery'}, {action:'plan', label:'🗓️ Plan sprintu'},
    {action:'hire', label:'➕ Zatrudnij'}, {action:'vault', label:'📚 Vault'},
    {action:'kanban', label:'📊 Kanban'},
  ];
  if (isDev) return [
    {action:'my_tasks', label:'📋 Moje zadania'}, {action:'status', label:'📊 Mój status'},
    {action:'run_tests', label:'🧪 Uruchom testy'}, {action:'git_status', label:'🔀 Git status'},
    {action:'vault', label:'📚 Vault'},
  ];
  if (isQA) return [
    {action:'run_tests', label:'🧪 Uruchom testy'}, {action:'test_report', label:'📊 Raport testów'},
    {action:'bugs', label:'🐛 Błędy'}, {action:'vault', label:'📚 Vault'},
  ];
  if (isReview) return [
    {action:'review', label:'👀 Review'}, {action:'git_status', label:'🔀 Zmiany'},
    {action:'vault', label:'📚 Vault'},
  ];
  return [
    {action:'status', label:'📊 Status'}, {action:'tasks', label:'📋 Zadania'},
    {action:'vault', label:'📚 Vault'},
  ];
}

export function renderPmBubbleActions(agent) {
  const el = document.getElementById('pmBubbleActions');
  const actions = getRoleActions(agent);
  el.innerHTML = actions.map(a => `<button onclick="window._pmQuick('${a.action}')">${a.label}</button>`).join('');
}
