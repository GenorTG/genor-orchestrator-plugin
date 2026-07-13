// state.js — All global state + syncFromStore + loadData + loadProject
// Uses a single mutable state object so other modules can read AND write.

export const state = {
  project: null,
  agents: [],
  rooms: [],
  tasks: [],
  currentProjectId: new URLSearchParams(window.location.search).get('project') || 'genor-orchestrator-plugin',
  availableModels: [],
  selectedAgent: null,
  pickedSprite: 'blue',
  officeZoom: .92,
  officePan: { x: 30, y: 20 },
  animsEnabled: true,
  mainView: 'office',
  roomEditEnabled: false,
  manualRoomLayout: false,
  draggingRoomId: null,
  resizingRoom: null,
  roomDragStart: { mx: 0, my: 0, rx: 0, ry: 0 },
  editingRoomId: null,
  pickedRoomTaskTypes: [],
  detailMode: null,
  detailId: null,
  roomPointer: null,
  pmBubbleOpen: false,
  activeVaultFile: 'STATE.md',
  fontScaleIdx: 1,
  workerMessageTarget: null,
  __projectsCatalog: {},
};

export const STATUS = {
  working:  { label:'Working',  cls:'working',  anim:true },
  reviewing:{ label:'Reviewing',cls:'reviewing',anim:true },
  sleep:    { label:'Sleep',    cls:'sleep',    anim:false },
  thinking: { label:'Thinking', cls:'thinking', anim:false },
  error:    { label:'Error',    cls:'error',    anim:false },
};

export const phases = [
  { id:'backlog', label:'📥 Backlog', color:'#8b949e' },
  { id:'in-progress', label:'⚡ W toku', color:'#f0883e' },
  { id:'review', label:'👁️ Review', color:'#a78bfa' },
  { id:'done', label:'✅ Done', color:'#3fb950' },
];

export const TASK_TYPES = [
  { id:'dev', label:'💻 Dev', color:'#5e9cff' },
  { id:'design', label:'🎨 Design', color:'#c084fc' },
  { id:'qa', label:'🧪 QA', color:'#3fb950' },
  { id:'review', label:'👁️ Review', color:'#f0883e' },
  { id:'devops', label:'⚙️ DevOps', color:'#22d3ee' },
  { id:'docs', label:'📄 Docs', color:'#8b949e' },
];

export const SPRITES = {
  blue: { label:'Niebieski', desc:'Hoodie, jeden monitor' },
  orange: { label:'Dual monitor', desc:'2 monitory, pomarańczowa koszulka' },
  violet: { label:'Fioletowy', desc:'Laptop, purple hoodie' },
  hacker: { label:'Hacker', desc:'Linux tower, słuchawki, terminal' },
};

export const DESK_W = 264;
export const DESK_H = 300;
export const COL_GAP = 32;
export const ROW_GAP = 36;
export const COL_SPACING = DESK_W + COL_GAP;
export const ROW_SPACING = DESK_H + ROW_GAP;
export const ROOM_PAD_X = 48;
export const ROOM_PAD_Y = 64;
export const ROOM_GAP = 56;
export const MIN_ROOM_W = DESK_W + ROOM_PAD_X * 2;
export const MIN_ROOM_H = DESK_H + ROOM_PAD_Y + 56;
export const FONT_SCALES = [0.9, 1, 1.15, 1.3];
export const framePlayers = new Map();

export function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

export async function loadModels() {
  try {
    await store.loadModels();
    state.availableModels = store.models;
  } catch (e) {}
}

export function syncFromStore() {
  if (!store.currentBootstrap) return;
  const p = store.project;
  if (!p) return;
  state.project = p;
  state.rooms = store.rooms || [];
  state.agents = store.workers || [];
  state.tasks = store.tasks || [];
  state.project.vault = store.vault || {};
  const data = store.currentBootstrap;
  if (data && data.projects) {
    window.__projectsCatalog = data.projects;
    state.__projectsCatalog = data.projects;
  }
  const firstRoom = state.rooms[0];
  if (firstRoom) {
    state.agents.forEach(a => {
      if (!a.room || !state.rooms.find(r => r.id === a.room)) {
        a.room = firstRoom.id;
      }
    });
  }
}

export async function loadData() {
  try {
    store.addEventListener('change', syncFromStore);
    const data = await store.loadBootstrap(state.currentProjectId);
    if (!data.ok) throw new Error(data.error || 'Bootstrap failed');
    state.currentProjectId = data.defaultProjectId || state.currentProjectId;
    syncFromStore();
    loadModels();
  } catch (e) {
    console.error('Bootstrap load failed:', e);
  }
}

export function loadProject(id, skipSave) {
  const p = window.__projectsCatalog ? window.__projectsCatalog[id] : null;
  if (!p) return;
  state.currentProjectId = id;
  state.project = p;
  state.rooms = deepClone(p.rooms || []);
  state.agents = deepClone(p.workers || p.agents || []);
  state.tasks = deepClone(p.tasks || []);
  state.project.vault = p.vault || {};
  state.manualRoomLayout = false;
  state.roomEditEnabled = false;
  document.getElementById('layoutToggle').textContent = '✥ Edycja pokoi: OFF';
  const firstRoom = state.rooms[0];
  if (firstRoom) {
    state.agents.forEach(a => {
      if (!a.room || !state.rooms.find(r => r.id === a.room)) {
        a.room = firstRoom.id;
      }
    });
  }
  const projectNameEl = document.getElementById('projectName');
  const displayName = (state.project.displayName || state.project.friendlyName || '').trim();
  if (displayName && displayName !== state.project.id) {
    projectNameEl.textContent = displayName;
    projectNameEl.style.display = '';
  } else {
    projectNameEl.textContent = state.project.id;
    projectNameEl.style.display = 'none';
  }
  document.getElementById('projectId').textContent = state.project.id;
  document.getElementById('panelProjectId').textContent = state.project.id;
  document.getElementById('projectSelect').value = id;
  state.activeVaultFile = 'STATE.md';
  const ws = document.getElementById('chatWorkerSelect');
  ws.innerHTML = '<option value="">🧠 Wybierz pracownika…</option>' + 
    state.agents.map(a => `<option value="${a.id}">${a.isOrchestrator ? '🧠' : '👤'} ${a.name} (${a.role})</option>`).join('');
}
