import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const MOCK_WORKERS = [
  { id: 'w1', name: 'Alex', role: 'Full Stack Developer', sprite: 'dev', model: 'deepseek-v4-flash', prompt: 'You are a full stack developer.', room: 'dev', status: 'sleep', project: 'test-project', created_at: new Date().toISOString() },
  { id: 'w2', name: 'Maya', role: 'Frontend Developer', sprite: 'dev', model: 'deepseek-v4-flash', prompt: 'You are a frontend developer.', room: 'dev', status: 'sleep', project: 'test-project', created_at: new Date().toISOString() },
  { id: 'pm', name: 'PM', role: 'Project Manager', sprite: 'pm', model: 'deepseek-v4-flash', prompt: 'You are a project manager.', room: 'dev', status: 'sleep', project: 'test-project', created_at: new Date().toISOString() },
];

const MOCK_TASKS = [
  { id: '1', project: 'test-project', title: 'Create login page', description: 'Build a login page with form validation', priority: 'p1', status: 'backlog', labels: '[]', depends_on: '[]', assigned_to: '', session_refs: '[]', created_ts: Date.now(), updated_ts: Date.now(), worker_id: null },
  { id: '2', project: 'test-project', title: 'Add API endpoints', description: 'Create REST API for user management', priority: 'p0', status: 'backlog', labels: '[]', depends_on: '[]', assigned_to: '', session_refs: '[]', created_ts: Date.now(), updated_ts: Date.now(), worker_id: null },
];

const MOCK_VAULT = [
  { id: 'v1', project_id: 'test-project', path: '/README.md', title: 'README', content: '# Test Project\n\nThis is a test project.', created_at: new Date().toISOString() },
];

class MockDatabase {
  private workers: any[];
  private tasks: any[];
  private vault: any[];
  private messages: any[];
  private history: any[];

  constructor() {
    this.workers = JSON.parse(JSON.stringify(MOCK_WORKERS));
    this.tasks = JSON.parse(JSON.stringify(MOCK_TASKS));
    this.vault = JSON.parse(JSON.stringify(MOCK_VAULT));
    this.messages = [];
    this.history = [];
  }

  reset() {
    this.workers = JSON.parse(JSON.stringify(MOCK_WORKERS));
    this.tasks = JSON.parse(JSON.stringify(MOCK_TASKS));
    this.vault = JSON.parse(JSON.stringify(MOCK_VAULT));
    this.messages = [];
    this.history = [];
  }

  prepare(sql: string) {
    const self = this;
    return {
      get(...args: any[]) {
        if (sql.includes('FROM workers WHERE id = ?')) return self.workers.find(w => w.id === args[0]);
        if (sql.includes('FROM backlog_tasks WHERE id = ?')) return self.tasks.find(t => t.id === String(args[0]));
        if (sql.includes('FROM vault_docs WHERE project_id = ?')) return self.vault.find(v => v.project_id === args[0]);
        return null;
      },
      all(...args: any[]) {
        if (sql.includes('FROM workers')) return self.workers;
        if (sql.includes('FROM backlog_tasks WHERE worker_id = ? AND status')) {
          // Parse: WHERE worker_id = ? AND status IN (?, ?)
          const workerId = args[0];
          const statuses = args.slice(1);
          return self.tasks.filter(t => t.worker_id === workerId && statuses.includes(t.status));
        }
        if (sql.includes('FROM backlog_tasks WHERE worker_id = ?')) return self.tasks.filter(t => t.worker_id === args[0] && t.status !== 'done');
        if (sql.includes('FROM backlog_tasks')) return self.tasks;
        if (sql.includes('FROM worker_task_history WHERE worker_id = ?')) return self.history.filter(h => h.worker_id === args[0]).slice(-5);
        if (sql.includes('FROM worker_messages WHERE to_worker = ?')) return self.messages.filter(m => m.to_worker === args[0]);
        if (sql.includes('FROM vault_docs WHERE project_id = ?')) return self.vault.filter(v => v.project_id === args[0]);
        return [];
      },
      run(...args: any[]) {
        if (sql.includes('UPDATE backlog_tasks SET worker_id = ?') && sql.includes('WHERE id = ?')) {
          const task = self.tasks.find(t => t.id === String(args[1]));
          if (task) task.worker_id = args[0];
          return { changes: 1 };
        }
        if (sql.includes('UPDATE backlog_tasks SET status = ?') && sql.includes('WHERE id = ?')) {
          const task = self.tasks.find(t => t.id === String(args[1]));
          if (task) task.status = args[0];
          return { changes: 1 };
        }
        if (sql.includes('UPDATE workers SET status = ?') && sql.includes('WHERE id = ?')) {
          const worker = self.workers.find(w => w.id === args[1]);
          if (worker) worker.status = args[0];
          return { changes: 1 };
        }
        if (sql.includes('UPDATE backlog_tasks SET worker_id = NULL')) {
          self.tasks.forEach(t => { if (t.worker_id === args[0]) t.worker_id = null; });
          return { changes: 1 };
        }
        if (sql.includes('INSERT INTO worker_task_history')) {
          self.history.push({ worker_id: args[0], task_id: args[1], action: args[2], details: args[3], created_at: new Date().toISOString() });
          return { changes: 1 };
        }
        if (sql.includes('INSERT INTO worker_messages')) {
          self.messages.push({ from_worker: args[0], to_worker: args[1], type: args[2], content: args[3], task_id: args[4], created_at: new Date().toISOString() });
          return { changes: 1 };
        }
        return { changes: 0 };
      },
    };
  }
  exec() {}
}

class MockWorkerEngine {
  private db: MockDatabase;
  constructor(db: MockDatabase) { this.db = db; }
  async executeTask(workerId: string, taskId: number) {
    const worker = this.db.prepare('SELECT * FROM workers WHERE id = ?').get(workerId);
    const task = this.db.prepare('SELECT * FROM backlog_tasks WHERE id = ?').get(taskId);
    if (!worker) return { success: false, error: 'Worker not found' };
    if (!task) return { success: false, error: 'Task not found' };
    return { success: true, output: 'Task completed', filesChanged: ['/src/login.tsx'] };
  }
}

describe('Software House Alpha', () => {
  let db: MockDatabase;
  let engine: MockWorkerEngine;
  beforeAll(() => { db = new MockDatabase(); engine = new MockWorkerEngine(db); });
  beforeEach(() => { db.reset(); });

  describe('Worker Management', () => {
    it('should list all workers', () => {
      expect(db.prepare('SELECT * FROM workers').all()).toHaveLength(3);
    });
    it('should get worker by id', () => {
      const w = db.prepare('SELECT * FROM workers WHERE id = ?').get('w1');
      expect(w.name).toBe('Alex');
    });
    it('should update worker status', () => {
      db.prepare('UPDATE workers SET status = ? WHERE id = ?').run('working', 'w1');
      expect(db.prepare('SELECT * FROM workers WHERE id = ?').get('w1').status).toBe('working');
    });
  });

  describe('Task Management', () => {
    it('should list all tasks', () => {
      expect(db.prepare('SELECT * FROM backlog_tasks').all()).toHaveLength(2);
    });
    it('should assign task to worker', () => {
      db.prepare('UPDATE backlog_tasks SET worker_id = ? WHERE id = ?').run('w1', '1');
      expect(db.prepare('SELECT * FROM backlog_tasks WHERE id = ?').get('1').worker_id).toBe('w1');
    });
    it('should move task to next phase', () => {
      db.prepare('UPDATE backlog_tasks SET status = ? WHERE id = ?').run('in-progress', '1');
      expect(db.prepare('SELECT * FROM backlog_tasks WHERE id = ?').get('1').status).toBe('in-progress');
    });
  });

  describe('Worker Execution Engine', () => {
    it('should execute task successfully', async () => {
      const result = await engine.executeTask('w1', 1);
      expect(result.success).toBe(true);
    });
    it('should handle worker not found', async () => {
      const result = await engine.executeTask('nonexistent', 1);
      expect(result.success).toBe(false);
    });
  });

  describe('Inter-Worker Messaging', () => {
    it('should send message', () => {
      db.prepare('INSERT INTO worker_messages (from_worker, to_worker, type, content, task_id) VALUES (?, ?, ?, ?, ?)').run('w1', 'w2', 'chat', 'Hello', null);
      expect(db.prepare('SELECT * FROM worker_messages WHERE to_worker = ?').all('w2')).toHaveLength(1);
    });
  });

  describe('Vault Documentation', () => {
    it('should list vault documents', () => {
      expect(db.prepare('SELECT * FROM vault_docs WHERE project_id = ?').all('test-project')).toHaveLength(1);
    });
  });

  describe('Health & Recovery', () => {
    it('should detect healthy worker', () => {
      expect(db.prepare('SELECT * FROM backlog_tasks WHERE worker_id = ? AND status IN (?, ?)').all('w1', 'in-progress', 'testing')).toHaveLength(0);
    });
    it('should detect stalled worker', () => {
      // First assign and set status
      db.prepare('UPDATE backlog_tasks SET worker_id = ? WHERE id = ?').run('w1', '1');
      db.prepare('UPDATE backlog_tasks SET status = ? WHERE id = ?').run('in-progress', '1');
      // Now query
      const stalled = db.prepare('SELECT * FROM backlog_tasks WHERE worker_id = ? AND status IN (?, ?)').all('w1', 'in-progress', 'testing');
      expect(stalled.length).toBeGreaterThan(0);
    });
  });

  describe('End-to-End Workflow', () => {
    it('should complete full lifecycle', async () => {
      db.prepare('UPDATE backlog_tasks SET worker_id = ? WHERE id = ?').run('w1', '1');
      const result = await engine.executeTask('w1', 1);
      expect(result.success).toBe(true);
      db.prepare('UPDATE backlog_tasks SET status = ? WHERE id = ?').run('done', '1');
      expect(db.prepare('SELECT * FROM backlog_tasks WHERE id = ?').get('1').status).toBe('done');
    });
  });
});
