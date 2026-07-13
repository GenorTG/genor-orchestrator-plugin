// kanban.js — renderKanbanFull, taskWorkerId, renderTaskPanel, moveTask, startTaskExecution, assignAndStartTask

import { state, phases } from './state.js';
import { staticPath, toast } from './utils.js';
import { roomForTaskType } from './rooms.js';

export function taskWorkerId(t) {
  return t.agent || t.worker || t.worker_id || null;
}

export function renderKanbanFull() {
  document.getElementById('kanbanProjectName').textContent = state.project.name;
  document.getElementById('kanbanTaskCount').textContent = `${state.tasks.length} tasków`;
  document.getElementById('kanbanFullBoard').innerHTML = phases.map(p => {
    const items = state.tasks.filter(t => {
      const s = String(t.phase || t.status || '').toLowerCase().replace(/_/g, '-');
      if (p.id === 'backlog' && (s === 'todo' || s === 'backlog')) return true;
      if (p.id === 'in-progress' && (s === 'in-progress' || s === 'in_progress' || s === 'doing' || s === 'active')) return true;
      if (p.id === 'review' && (s === 'review' || s === 'reviewing')) return true;
      if (p.id === 'done' && (s === 'done' || s === 'complete' || s === 'completed' || s === 'closed')) return true;
      return false;
    });
    return `<div class="kanban-col"><h4 style="color:${p.color}">${p.label} (${items.length})</h4>
      ${items.map(t => {
        const wid = taskWorkerId(t);
        const ag = state.agents.find(a => a.id === wid);
        return `<div class="kanban-card" style="border-left-color:${p.color}" onclick="window._openTaskPanel('${t.id}')">
          <div><span class="pri">${t.pri}</span> ${t.title}</div>
          ${ag ? `<div class="who">👤 ${ag.name}</div>` : '<div class="who">— nieprzypisany</div>'}
        </div>`;
      }).join('')}</div>`;
  }).join('');
}

export function renderTaskPanel(id) {
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  const ag = state.agents.find(a => a.id === t.agent);
  const phase = phases.find(p => p.id === t.phase);
  const targetRoom = roomForTaskType(t.type);

  document.getElementById('detailHead').innerHTML = `
    <div class="detail-head-top">
      <div style="flex:1;min-width:0">
        <h2>${t.title}</h2>
        <p>${t.pri} · ${phase?.label || t.phase}</p>
      </div>
      <button class="detail-close" onclick="window._closeDetailPanel()">×</button>
    </div>`;

  document.getElementById('detailBody').innerHTML = `
    <div class="task-detail-meta" style="grid-template-columns:1fr">
      <div><strong>Faza</strong>${phase?.label || t.phase}</div>
      <div><strong>Typ</strong>${t.type}${targetRoom ? ' → ' + targetRoom.name : ''}</div>
      <div><strong>Agent</strong>${ag ? ag.name : '— nieprzypisany'}</div>
    </div>
    <div class="task-desc">${t.desc}</div>
    ${ag ? `<button class="btn" style="width:100%;margin-top:12px" onclick="window._openAgentPanel('${ag.id}')">👤 ${ag.name}</button>` : ''}
    ${targetRoom ? `<button class="btn" style="width:100%;margin-top:8px" onclick="window._openRoomPanel('${targetRoom.id}')">🏢 Pokój: ${targetRoom.name}</button>` : ''}
    ${ag ? `<button class="btn primary" style="width:100%;margin-top:12px" onclick="window._startTaskExecution('${t.id}', '${ag.id}')">▶️ Rozpocznij zadanie</button>` : `<button class="btn" style="width:100%;margin-top:12px" onclick="window._assignAndStartTask('${t.id}')">👤 Przypisz i rozpocznij</button>`}`;

  document.getElementById('detailFoot').innerHTML = `
    ${t.phase !== 'done' ? `<button class="btn primary" onclick="window._moveTask('${t.id}')">→ Następna faza</button>` : '<button class="btn" onclick="window._closeDetailPanel()">Zamknij</button>'}`;
}

export function moveTask(taskId) {
  const t = state.tasks.find(x => x.id === taskId);
  if (!t || t.phase === 'done') return;
  const phaseOrder = ['backlog', 'in-progress', 'review', 'done'];
  const currentIdx = phaseOrder.indexOf(t.phase);
  const nextPhase = phaseOrder[currentIdx + 1];
  if (!nextPhase) return;
  store.api(`/software-house/backlog/move?project=${state.currentProjectId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: t.id, phase: nextPhase })
  }).then(data => {
    if (data && data.ok) {
      t.phase = nextPhase;
      window._renderAll();
      renderTaskPanel(t.id);
      toast(`✅ Task przesunięty do: ${nextPhase}`);
    } else {
      toast(`❌ Błąd: ${data.error}`);
    }
  }).catch(err => { toast(`❌ Błąd sieci: ${err.message}`); });
}

export function startTaskExecution(taskId, workerId) {
  const t = state.tasks.find(x => x.id === taskId);
  if (!t) return;
  toast(`🤖 Rozpoczynam zadanie: ${t.title}`);
  store.api(`/software-house/worker/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId, taskId: parseInt(taskId) })
  }).then(data => {
    if (data && data.ok) {
      toast(`✅ Zadanie wykonane: ${t.title}`);
      window._loadData();
    } else {
      toast(`❌ Błąd: ${data.error || 'Unknown error'}`);
    }
  }).catch(err => { toast(`❌ Błąd sieci: ${err.message}`); });
}

export function assignAndStartTask(taskId) {
  const availableWorker = state.agents.find(a => !a.isOrchestrator && a.status !== 'error');
  if (!availableWorker) { toast('❌ Brak dostępnych pracowników'); return; }
  store.api(`/software-house/backlog/assign?project=${state.currentProjectId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId, workerId: availableWorker.id })
  }).then(data => {
    if (data && data.ok) startTaskExecution(taskId, availableWorker.id);
    else toast(`❌ Błąd przypisania: ${data.error}`);
  }).catch(err => { toast(`❌ Błąd sieci: ${err.message}`); });
}
