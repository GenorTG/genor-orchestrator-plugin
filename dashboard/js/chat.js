// chat.js — addBotMsg, orchSay, sendChat, openWorkerMessageModal, closeWorkerMessageModal, sendWorkerMessage, checkWorkerHealth, orchPlan, loadChatHistory

import { state, STATUS } from './state.js';
import { staticPath, formatTime, visualState, toast } from './utils.js';

function getSelectedChatWorker() {
  const sel = document.getElementById('chatWorkerSelect').value;
  return sel ? state.agents.find(a => a.id === sel) : null;
}

export function onChatWorkerSelect(workerId) {
  if (!workerId) return;
  const a = state.agents.find(x => x.id === workerId);
  if (!a) return;
  const chatMsgs = document.getElementById('chatMsgs');
  chatMsgs.innerHTML += `<div class="msg bot"><img class="avatar" src="${staticPath(a.sprite)}" alt=""><span class="msg-text">Rozpoczęto czat z <b>${a.name}</b> (${a.role}).</span><div class="time">teraz</div></div>`;
  chatMsgs.scrollTop = chatMsgs.scrollHeight;
}

export function addBotMsg(html, worker) {
  const el = document.getElementById('chatMsgs');
  const sprite = worker?.sprite || 'blue';
  el.innerHTML += `<div class="msg bot"><img class="avatar" src="${staticPath(sprite)}" alt=""><span class="msg-text">${html}</span><div class="time">teraz</div></div>`;
  el.scrollTop = el.scrollHeight;
}

export function orchSay(key) {
  const replies = {
    status: () => `📊 <b>${state.project.name}</b><br>${state.agents.map(a=>`• ${a.name}${a.isOrchestrator?' 🧠':''}: ${STATUS[visualState(a)]?.label}${a.task?' — '+a.task:''}`).join('<br>')}`,
    plan: () => `📋 Plan dla <b>${state.project.name}</b>:<br>1. API Gateway (Alex 64%)<br>2. Dashboard UI (Maya 72%)<br>3. Fix CI (Bob — ERROR)<br><button class="act" onclick="toast('Plan OK')">Zatwierdź</button>`,
    help: () => `ℹ️ <b>Pomoc</b><br>• <b>Klik agenta</b> → dymki czatu<br>• <b>Kanban</b> → klik task → panel edycji<br>• <b>Vault</b> → 📚 kontekst projektu<br>• <b>+ Wolne biurko</b> → zatrudnij<br>• <b>⚙️</b> → ustawienia, edycja pokoi`,
    hire: () => `Kliknij <b>+ Wolne biurko</b> — bez limitu miejsc w pokoju.`,
  };
  orchSay._reply = k => replies[k] ? replies[k]() : '';
  if (key === 'hire') { window._openHireModal(); return; }
  if (replies[key]) addBotMsg(replies[key](), getSelectedChatWorker());
}

export function sendChat() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  const worker = getSelectedChatWorker();
  const workerId = worker?.id || null;
  document.getElementById('chatMsgs').innerHTML += `<div class="msg user">${text}<div class="time">teraz</div></div>`;
  input.value = '';
  store.sendPmChat(text, 'user', workerId).then(data => {
    if (data && data.ok) return store.loadPmChat();
    else addBotMsg('Coś poszło nie tak. Spróbuj ponownie.', worker);
  }).then(messages => {
    if (Array.isArray(messages)) {
      const chatMsgs = document.getElementById('chatMsgs');
      chatMsgs.innerHTML = '';
      messages.forEach(msg => {
        if (msg.sender === 'user') {
          chatMsgs.innerHTML += `<div class="msg user">${msg.message}<div class="time">${formatTime(msg.created_at)}</div></div>`;
        } else {
          const sprite = worker?.sprite || 'blue';
          chatMsgs.innerHTML += `<div class="msg bot"><img class="avatar" src="${staticPath(sprite)}" alt=""><span class="msg-text">${msg.message}</span><div class="time">${formatTime(msg.created_at)}</div></div>`;
        }
      });
      chatMsgs.scrollTop = chatMsgs.scrollHeight;
    }
  }).catch(err => { addBotMsg('Błąd połączenia: ' + err.message, worker); });
}

export function openWorkerMessageModal(workerId) {
  state.workerMessageTarget = workerId;
  const worker = state.agents.find(a => a.id === workerId);
  if (!worker) return;
  const modal = document.createElement('div');
  modal.id = 'workerMessageModal';
  modal.className = 'modal';
  modal.innerHTML = `
    <div class="modal-content" style="max-width:400px">
      <h3>💬 Wyślij wiadomość do ${worker.name}</h3>
      <div style="margin:12px 0">
        <label style="font-size:11px;color:var(--text-dim)">Typ wiadomości:</label>
        <select id="workerMsgType" style="width:100%;margin-top:4px;padding:6px;background:var(--bg-desk);border:1px solid var(--border);border-radius:8px;color:var(--text)">
          <option value="chat">💬 Chat</option>
          <option value="task_assign">📋 Przypisz zadanie</option>
          <option value="review_request">👀 Poproś o review</option>
          <option value="review_feedback">📝 Feedback</option>
        </select>
      </div>
      <div style="margin:12px 0">
        <label style="font-size:11px;color:var(--text-dim)">Wiadomość:</label>
        <textarea id="workerMsgContent" style="width:100%;margin-top:4px;padding:8px;background:var(--bg-desk);border:1px solid var(--border);border-radius:8px;color:var(--text);min-height:80px" placeholder="Napisz wiadomość..."></textarea>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn" onclick="window._closeWorkerMessageModal()">Anuluj</button>
        <button class="btn primary" onclick="window._sendWorkerMessage()">Wyślij</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

export function closeWorkerMessageModal() {
  const modal = document.getElementById('workerMessageModal');
  if (modal) modal.remove();
  state.workerMessageTarget = null;
}

export function sendWorkerMessage() {
  if (!state.workerMessageTarget) return;
  const type = document.getElementById('workerMsgType').value;
  const content = document.getElementById('workerMsgContent').value.trim();
  if (!content) { toast('❌ Wpisz wiadomość'); return; }
  const senderId = state.agents[0]?.id;
  if (!senderId) { toast('❌ Brak dostępnych nadawców'); return; }
  store.api(`/software-house/worker/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fromWorker: senderId, toWorker: state.workerMessageTarget,
      type, content, project: state.currentProjectId
    })
  }).then(data => {
    if (data.ok) {
      toast(`✅ Wiadomość wysłana do ${state.agents.find(a => a.id === state.workerMessageTarget)?.name}`);
      closeWorkerMessageModal();
    } else { toast(`❌ Błąd: ${data.error}`); }
  }).catch(err => { toast(`❌ Błąd sieci: ${err.message}`); });
}

export function checkWorkerHealth(workerId) {
  store.api(`/software-house/worker/health/${workerId}`).then(data => {
    if (data.error) { toast(`❌ Błąd: ${data.error}`); return; }
    const worker = data.worker;
    const healthy = data.healthy;
    const stalled = data.stalledTasks;
    const lastActive = data.minutesSinceActive;
    let statusMsg = healthy ? '✅ Zdrowy' : '⚠️ Problem';
    let details = [];
    if (stalled > 0) details.push(`${stalled} zablokowanych tasków`);
    if (lastActive !== null) details.push(`Ostatnia aktywność: ${lastActive} min temu`);
    toast(`${statusMsg}: ${worker.name}${details.length ? ' — ' + details.join(', ') : ''}`);
    if (!healthy) {
      if (confirm(`Worker ${worker.name} ma problemy. Przywrócić?`)) {
        // recoverWorker would go here
      }
    }
  }).catch(err => { toast(`❌ Błąd sieci: ${err.message}`); });
}

export function orchPlan() {
  document.getElementById('chatInput').value = 'Stwórz plan sprintu';
  sendChat();
}

export async function loadChatHistory() {
  try {
    const data = await store.loadPmChat();
    if (data && data.ok && data.messages) {
      const chatMsgs = document.getElementById('chatMsgs');
      chatMsgs.innerHTML = '';
      data.messages.forEach(msg => {
        const worker = msg.worker_id ? state.agents.find(a => a.id === msg.worker_id) : null;
        const sprite = worker?.sprite || 'blue';
        if (msg.sender === 'user') {
          chatMsgs.innerHTML += `<div class="msg user">${msg.message}<div class="time">${formatTime(msg.created_at)}</div></div>`;
        } else {
          chatMsgs.innerHTML += `<div class="msg bot"><img class="avatar" src="${staticPath(sprite)}" alt=""><span class="msg-text">${msg.message}</span><div class="time">${formatTime(msg.created_at)}</div></div>`;
        }
      });
      chatMsgs.scrollTop = chatMsgs.scrollHeight;
    }
  } catch (e) {
    console.error('Chat history load failed:', e);
  }
}
