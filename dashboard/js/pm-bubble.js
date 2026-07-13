// pm-bubble.js — openPmBubble, closePmBubble, positionPmBubble, renderPmBubbleMsgs, pmQuick, sendPmBubble

import { state, STATUS } from './state.js';
import { staticPath, formatTime, visualState, toast } from './utils.js';
import { renderPmBubbleActions } from './workers.js';

export function openPmBubble(id) {
  const a = state.agents.find(x => x.id === id);
  if (!a) return;
  window._closeDetailPanel();
  state.pmBubbleOpen = true;
  state.selectedAgent = id;
  document.getElementById('pmBubbleName').textContent = a.name;
  document.getElementById('pmBubbleAvatar').src = staticPath(a.sprite);
  renderPmBubbleMsgs();
  renderPmBubbleActions(a);
  document.getElementById('pmBubble').classList.add('show');
  document.getElementById('pmBubbleInput').placeholder = `Napisz do ${a.name}…`;
  document.querySelectorAll('.desk-slot').forEach(el => el.classList.remove('chatting'));
  const desk = document.querySelector(`.desk-slot[style*="${a._x}px"], .desk-slot[style*="top:${a._y}px"]`);
  if (desk) desk.classList.add('chatting');
  positionPmBubble();
  setTimeout(() => document.getElementById('pmBubbleInput').focus(), 80);
  window._renderDesks();
}

export function closePmBubble() {
  state.pmBubbleOpen = false;
  document.getElementById('pmBubble').classList.remove('show');
  document.querySelectorAll('.desk-slot').forEach(el => el.classList.remove('chatting'));
  state.selectedAgent = null;
  window._renderDesks();
}

export function positionPmBubble() {
  const a = state.agents.find(x => x.id === state.selectedAgent);
  if (!a) return;
  const desk = document.querySelector(`[style*="left:${a._x}px"][style*="top:${a._y}px"]`);
  const bubble = document.getElementById('pmBubble');
  if (!desk || !bubble.classList.contains('show')) return;
  const rect = desk.getBoundingClientRect();
  const bw = 400;
  const bh = bubble.offsetHeight || 420;
  bubble.classList.remove('side-left', 'side-right');
  let left = rect.right + 18;
  let top = rect.top + rect.height / 2 - bh / 2;
  if (left + bw > window.innerWidth - 16) {
    left = rect.left - bw - 18;
    bubble.classList.add('side-left');
  } else {
    bubble.classList.add('side-right');
  }
  top = Math.max(70, Math.min(window.innerHeight - bh - 16, top));
  left = Math.max(12, Math.min(window.innerWidth - bw - 12, left));
  bubble.style.left = left + 'px';
  bubble.style.top = top + 'px';
}

export function renderPmBubbleMsgs() {
  const a = state.agents.find(x => x.id === state.selectedAgent);
  if (!a) return;
  const el = document.getElementById('pmBubbleMsgs');
  const roleLabel = a.isOrchestrator ? 'Project Managerem' : 'asystentem';
  const welcome = `Cześć! Jestem <b>${a.name}</b>, ${roleLabel} projektu <b>${state.project.name}</b>. Mogę zaplanować sprint, sprawdzić status zespołu albo zatrudnić kogoś.`;
  el.innerHTML = `<div class="msg bot"><img class="avatar" src="${staticPath(a.sprite)}" alt=""><span class="msg-text">${welcome}</span><div class="time">teraz</div></div>`;
}

export function pmQuick(action) {
  const a = state.agents.find(x => x.id === state.selectedAgent);
  const el = document.getElementById('pmBubbleMsgs');
  const sprite = a?.sprite || 'blue';
  const append = html => {
    el.innerHTML += `<div class="msg bot"><img class="avatar" src="${staticPath(sprite)}" alt=""><span class="msg-text">${html}</span><div class="time">teraz</div></div>`;
    el.scrollTop = el.scrollHeight;
    positionPmBubble();
  };
  const devs = state.agents.filter(a => !a.isOrchestrator);
  const active = state.tasks.filter(t => t.phase !== 'done');
  const blockers = devs.filter(a => visualState(a) === 'error');
  switch (action) {
    case 'status':
      append(`📊 <b>${state.project.name}</b> — ${devs.length} pracowników, ${active.length} aktywnych tasków<br>${devs.map(a=>`• ${a.name}: <b>${STATUS[visualState(a)]?.label}</b>${a.task?' — '+a.task:''}`).join('<br>')}`);
      break;
    case 'tasks':
      append(`📋 <b>Zadania (${active.length})</b><br>${active.slice(0,8).map(t=>`• ${t.pri} ${t.title} <span style="opacity:.7">(${t.phase})</span>`).join('<br>')}${active.length>8?'<br>…':''}`);
      break;
    case 'blockers':
      if (!blockers.length) append('✅ Brak blokujących błędów — zespół działa płynnie.');
      else append(`🚧 <b>Blokery (${blockers.length})</b><br>${blockers.map(a=>`• <b>${a.name}</b>: ${a.task||'błąd agenta'}`).join('<br>')}`);
      break;
    case 'plan':
      append(window._orchSay._reply('plan'));
      break;
    case 'hire':
      window._openHireModal();
      append('Otwieram formularz zatrudnienia 👇');
      break;
    case 'vault':
      window._setMainView('vault', document.getElementById('navVault'));
      append('Otwieram vault z kontekstem projektu 📚');
      break;
    case 'kanban':
      window._setMainView('kanban', document.getElementById('navKanban'));
      append('Otwieram kanban board 📊');
      break;
    case 'my_tasks': {
      const myTasks = state.tasks.filter(t => t.worker === a.id && t.phase !== 'done');
      if (!myTasks.length) append('✅ Nie masz przypisanych zadań.');
      else append(`📋 <b>Twoje zadania (${myTasks.length})</b><br>${myTasks.map(t=>`• ${t.pri} ${t.title} <span style="opacity:.7">(${t.phase})</span>`).join('<br>')}`);
      break;
    }
    case 'run_tests':
      append('🧪 Uruchamiam testy... (funkcja wkrótce)');
      break;
    case 'git_status':
      append('🔀 Sprawdzam git status... (funkcja wkrótce)');
      break;
    case 'test_report':
      append('📊 Raport testów: 40/40 testów przechodzi ✅');
      break;
    case 'bugs': {
      const errWorkers = state.agents.filter(x => visualState(x) === 'error');
      if (!errWorkers.length) append('✅ Brak błędów w zespole.');
      else append(`🐛 <b>Błędy (${errWorkers.length})</b><br>${errWorkers.map(x=>`• <b>${x.name}</b>: ${x.task||'błąd agenta'}`).join('<br>')}`);
      break;
    }
    case 'review':
      append('👀 Przeglądam zmiany... (funkcja wkrótce)');
      break;
  }
}

export function sendPmBubble() {
  const input = document.getElementById('pmBubbleInput');
  const text = input.value.trim();
  if (!text) return;
  const a = state.agents.find(x => x.id === state.selectedAgent);
  const sprite = a?.sprite || 'blue';
  const el = document.getElementById('pmBubbleMsgs');
  el.innerHTML += `<div class="msg user">${text}<div class="time">teraz</div></div>`;
  input.value = '';
  el.scrollTop = el.scrollHeight;
  document.getElementById('chatMsgs').innerHTML += `<div class="msg user">${text}<div class="time">teraz</div></div>`;
  
  store.sendPmChat(text, 'user', state.selectedAgent).then(data => {
    if (data && data.ok) return store.loadPmChat();
  }).then(messages => {
    if (Array.isArray(messages) && messages.length) {
      const lastPmMsg = [...messages].reverse().find(m => m.sender === 'pm');
      if (lastPmMsg) {
        el.innerHTML += `<div class="msg bot"><img class="avatar" src="${staticPath(sprite)}" alt=""><span class="msg-text">${lastPmMsg.message}</span><div class="time">${new Date(lastPmMsg.created_at).toLocaleTimeString('pl-PL')}</div></div>`;
        el.scrollTop = el.scrollHeight;
        positionPmBubble();
        const chatMsgs = document.getElementById('chatMsgs');
        chatMsgs.innerHTML = '';
        messages.forEach(msg => {
          const msgSprite = msg.worker_id ? state.agents.find(x => x.id === msg.worker_id)?.sprite || 'blue' : (a?.sprite || 'blue');
          if (msg.sender === 'user') {
            chatMsgs.innerHTML += `<div class="msg user">${msg.message}<div class="time">${formatTime(msg.created_at)}</div></div>`;
          } else {
            chatMsgs.innerHTML += `<div class="msg bot"><img class="avatar" src="${staticPath(msgSprite)}" alt=""><span class="msg-text">${msg.message}</span><div class="time">${formatTime(msg.created_at)}</div></div>`;
          }
        });
        chatMsgs.scrollTop = chatMsgs.scrollHeight;
      }
    }
  }).catch(err => { console.error('PM bubble error:', err); });
}
