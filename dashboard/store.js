/**
 * Centralized client-side Data Store for the Genor Orchestrator dashboard.
 *
 * Wraps all fetch() calls behind a single DataStore class.
 * All HTML pages use this store instead of calling fetch() directly.
 * Emits 'change' events when data is loaded.
 */
class DataStore extends EventTarget {
  constructor() {
    super();
    this.state = {
      projects: [],
      project: null,
      workers: [],
      rooms: [],
      tasks: [],
      models: [],
      sessions: [],
      pmChat: [],
      vault: {},
      bootstrap: null,
    };
    this.api = '/orchestrator/api';
    this.currentProjectId = null;
  }

  /**
   * Single fetch wrapper — all HTTP calls go through here.
   */
  async fetch(path, options = {}) {
    const url = path.startsWith(this.api) ? path : `${this.api}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`${res.status} ${err}`);
    }
    return res.json();
  }

  // ═══════════════════════════════════════════════════
  //  BOOTSTRAP — full project state
  // ═══════════════════════════════════════════════════

  async bootstrap(projectId) {
    this.currentProjectId = projectId;
    const data = await this.fetch(`/software-house/bootstrap?project=${projectId}`);
    this.state.bootstrap = data;
    this.state.project = data.projects ? data.projects[projectId] : null;
    this.state.workers = this.state.project ? (this.state.project.workers || []) : [];
    this.state.rooms = this.state.project ? (this.state.project.rooms || []) : [];
    this.state.tasks = this.state.project ? (this.state.project.tasks || []) : [];
    this.state.vault = this.state.project ? (this.state.project.vault || {}) : {};
    this.emit('change');
    return data;
  }

  // ═══════════════════════════════════════════════════
  //  PROJECT CATALOG
  // ═══════════════════════════════════════════════════

  async loadProjects() {
    const data = await this.fetch('/software-house/projects/list');
    this.state.projects = data.projects || [];
    this.emit('change');
    return this.state.projects;
  }

  // ═══════════════════════════════════════════════════
  //  MODELS
  // ═══════════════════════════════════════════════════

  async loadModels() {
    const data = await this.fetch('/software-house/models');
    this.state.models = Array.isArray(data) ? data : (data.models || []);
    this.emit('change');
    return this.state.models;
  }

  // ═══════════════════════════════════════════════════
  //  BACKLOG
  // ═══════════════════════════════════════════════════

  async loadBacklog() {
    if (!this.currentProjectId) return [];
    const data = await this.fetch(`/software-house/backlog?project=${this.currentProjectId}`);
    this.state.tasks = Array.isArray(data) ? data : [];
    this.emit('change');
    return this.state.tasks;
  }

  // ═══════════════════════════════════════════════════
  //  SESSIONS
  // ═══════════════════════════════════════════════════

  async loadSessions() {
    if (!this.currentProjectId) return [];
    const data = await this.fetch(`/software-house/sessions?project=${this.currentProjectId}`);
    this.state.sessions = data.sessions || [];
    this.emit('change');
    return this.state.sessions;
  }

  // ═══════════════════════════════════════════════════
  //  PM CHAT
  // ═══════════════════════════════════════════════════

  async loadPmChat() {
    if (!this.currentProjectId) return [];
    const data = await this.fetch(`/software-house/pm/chat?project=${this.currentProjectId}`);
    this.state.pmChat = data.messages || [];
    this.emit('change');
    return this.state.pmChat;
  }

  // ═══════════════════════════════════════════════════
  //  VAULT
  // ═══════════════════════════════════════════════════

  async loadVault() {
    if (!this.currentProjectId) return {};
    const data = await this.fetch(`/software-house/vault?project=${this.currentProjectId}`);
    this.state.vault = data.vault || {};
    this.emit('change');
    return this.state.vault;
  }

  // ═══════════════════════════════════════════════════
  //  MUTATIONS
  // ═══════════════════════════════════════════════════

  async deleteProject(name, deleteFiles = false) {
    await this.fetch(`/software-house/projects/${encodeURIComponent(name)}${deleteFiles ? '?deleteFiles=true' : ''}`, { method: 'DELETE' });
    await this.loadProjects();
  }

  async createProject(name, repoUrl) {
    await this.fetch('/software-house/projects/create', {
      method: 'POST',
      body: JSON.stringify({ name, repo_url: repoUrl || null })
    });
    await this.loadProjects();
  }

  async addBacklogTask(task) {
    const result = await this.fetch('/software-house/backlog', {
      method: 'POST',
      body: JSON.stringify({ ...task, project: this.currentProjectId })
    });
    await this.loadBacklog();
    return result;
  }

  async moveTask(taskId, status, workerId) {
    const body = { id: taskId, status };
    if (workerId !== undefined) body.worker_id = workerId;
    await this.fetch(`/software-house/backlog/move?project=${this.currentProjectId}`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    await this.loadBacklog();
  }

  async sendChat(message, workerId) {
    await this.fetch('/software-house/worker/message', {
      method: 'POST',
      body: JSON.stringify({ project: this.currentProjectId, worker_id: workerId, message })
    });
    await this.loadPmChat();
  }

  async hireWorker(worker) {
    await this.fetch(`/software-house/workers/hire?project=${this.currentProjectId}`, {
      method: 'POST',
      body: JSON.stringify(worker)
    });
    // Reload full bootstrap to refresh all state
    await this.bootstrap(this.currentProjectId);
  }

  async fireWorker(workerId) {
    await this.fetch(`/software-house/workers/${workerId}?project=${this.currentProjectId}`, { method: 'DELETE' });
    await this.bootstrap(this.currentProjectId);
  }

  async updateRoom(roomId, updates) {
    await this.fetch(`/software-house/rooms/${roomId}?project=${this.currentProjectId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates)
    });
    await this.bootstrap(this.currentProjectId);
  }

  async deleteRoom(roomId) {
    await this.fetch(`/software-house/rooms/${roomId}?project=${this.currentProjectId}`, { method: 'DELETE' });
    await this.bootstrap(this.currentProjectId);
  }

  async gitPull() {
    const data = await this.fetch(`/software-house/projects/${encodeURIComponent(this.currentProjectId)}/repo/pull`, { method: 'POST' });
    await this.bootstrap(this.currentProjectId);
    return data;
  }

  async gitPush(message) {
    const data = await this.fetch(`/software-house/projects/${encodeURIComponent(this.currentProjectId)}/repo/push`, {
      method: 'POST',
      body: JSON.stringify({ message })
    });
    await this.bootstrap(this.currentProjectId);
    return data;
  }

  async saveLayout(layout) {
    await this.fetch(`/software-house/layout/save?project=${this.currentProjectId}`, {
      method: 'POST',
      body: JSON.stringify(layout)
    });
  }

  async refreshRepoStatus() {
    const data = await this.fetch(`/software-house/projects/${encodeURIComponent(this.currentProjectId)}/repo`);
    return data;
  }

  // ═══════════════════════════════════════════════════
  //  PM CHAT (send message)
  // ═══════════════════════════════════════════════════

  async sendPmChat(message, sender) {
    const data = await this.fetch('/software-house/pm/chat', {
      method: 'POST',
      body: JSON.stringify({ message, sender: sender || 'user', project: this.currentProjectId })
    });
    return data;
  }

  // ═══════════════════════════════════════════════════
  //  VAULT (inject)
  // ═══════════════════════════════════════════════════

  async injectVaultDoc(path) {
    const data = await this.fetch(`/software-house/vault/inject?project=${this.currentProjectId}`, {
      method: 'POST',
      body: JSON.stringify({ path })
    });
    return data;
  }

  // ═══════════════════════════════════════════════════
  //  RAISE EVENTS
  // ═══════════════════════════════════════════════════

  emit(event) {
    this.dispatchEvent(new CustomEvent(event || 'change'));
  }

  // ═══════════════════════════════════════════════════
  //  CONVENIENCE GETTERS
  // ═══════════════════════════════════════════════════

  get project() { return this.state.project; }
  get workers() { return this.state.workers; }
  get rooms() { return this.state.rooms; }
  get tasks() { return this.state.tasks; }
  get models() { return this.state.models; }
  get projects() { return this.state.projects; }
  get sessions() { return this.state.sessions; }
  get pmChat() { return this.state.pmChat; }
  get vault() { return this.state.vault; }
  get bootstrap() { return this.state.bootstrap; }
  get bootstrapData() { return this.state.bootstrap; }

  /** General-purpose fetch — extends api path, returns JSON. */
  async api(path, options = {}) {
    const url = path.startsWith('http') ? path : `${this.api}${path}`;
    const res = await fetch(url, options);
    const data = await res.json();
    if (!data.ok && !data.error) data.ok = res.ok;
    return data;
  }
}

const store = new DataStore();
window.store = store;
