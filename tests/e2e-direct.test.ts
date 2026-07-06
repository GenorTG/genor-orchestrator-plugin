/**
 * E2E Direct Database Tests
 * 
 * These tests interact directly with the database, bypassing the
 * file migration that causes timeouts in test environments.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb, setProjectConfig, getProjectConfig, deleteProjectConfig, addBacklogTask, listBacklogTasks, updateBacklogTask, addSession, listSessions, upsertModel, listModels } from '../src/db.js';
import { handleSoftwareHouseRoute } from '../src/software-house.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { IncomingMessage, ServerResponse } from 'node:http';

// Test database setup
const TEST_DB_DIR = path.join(os.tmpdir(), 'orchestrator-e2e-direct-' + Date.now());
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'orchestrator.db');

// Helper to create mock HTTP request/response
function createMockRequest(method: string, url: string, body?: any): { req: IncomingMessage; res: ServerResponse; getResponse: () => any } {
  let responseData: any = null;
  let responseCode = 200;
  const bodyStr = body ? JSON.stringify(body) : '';
  const dataListeners: Function[] = [];
  const endListeners: Function[] = [];
  let dataEmitted = false;
  let endEmitted = false;

  const req = {
    method,
    url,
    headers: { 'content-type': 'application/json' },
    on: (event: string, callback: Function) => {
      if (event === 'data') {
        dataListeners.push(callback);
        // Emit data asynchronously if not yet emitted
        if (!dataEmitted && bodyStr) {
          dataEmitted = true;
          setTimeout(() => callback(Buffer.from(bodyStr)), 0);
        }
      } else if (event === 'end') {
        endListeners.push(callback);
        // Emit end asynchronously if not yet emitted
        if (!endEmitted) {
          endEmitted = true;
          setTimeout(() => callback(), 0);
        }
      }
    },
  } as unknown as IncomingMessage;

  const res = {
    writeHead: (code: number, headers?: any) => {
      responseCode = code;
    },
    end: (data: string) => {
      try {
        responseData = JSON.parse(data);
      } catch {
        responseData = data;
      }
    },
    write: (data: string) => {
      // SSE data
    },
  } as unknown as ServerResponse;

  return {
    req,
    res,
    getResponse: () => ({ code: responseCode, data: responseData }),
  };
}

describe('E2E Direct Database Tests', () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_DB_DIR, { recursive: true });
    
    // Initialize database manually without file migration
    const db = getDb(TEST_DB_PATH);
    
    // Create schema manually
    db.exec(`
      CREATE TABLE IF NOT EXISTS _schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER DEFAULT (unixepoch())
      );
      
      CREATE TABLE IF NOT EXISTS global_config (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      
      CREATE TABLE IF NOT EXISTS project_configs (
        project TEXT PRIMARY KEY,
        config TEXT DEFAULT '{}'
      );
      
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        agent TEXT DEFAULT '',
        model TEXT DEFAULT '',
        tags TEXT DEFAULT '[]',
        status TEXT DEFAULT '',
        task TEXT DEFAULT '',
        start_ts INTEGER,
        end_ts INTEGER,
        duration TEXT DEFAULT '',
        session_key TEXT DEFAULT '',
        extra TEXT DEFAULT '{}',
        logged_at INTEGER DEFAULT 0
      );
      
      CREATE TABLE IF NOT EXISTS backlog_tasks (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        priority TEXT DEFAULT 'p2',
        status TEXT DEFAULT 'backlog',
        labels TEXT DEFAULT '[]',
        depends_on TEXT DEFAULT '[]',
        assigned_to TEXT DEFAULT '',
        session_refs TEXT DEFAULT '[]',
        created_ts INTEGER DEFAULT (unixepoch()),
        updated_ts INTEGER DEFAULT (unixepoch()),
        worker_id TEXT
      );
      
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL DEFAULT '{}'
      );
      
      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT DEFAULT '',
        sprite TEXT DEFAULT 'dev',
        model TEXT DEFAULT 'deepseek-v4-flash',
        prompt TEXT DEFAULT '',
        room TEXT DEFAULT 'dev',
        status TEXT DEFAULT 'sleep',
        created_at TEXT DEFAULT (datetime('now'))
      );
      
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        name TEXT NOT NULL,
        purpose TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      );
      
      CREATE TABLE IF NOT EXISTS vault_docs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT DEFAULT '',
        content TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now'))
      );
      
      CREATE TABLE IF NOT EXISTS pm_chat (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        content TEXT NOT NULL,
        sender TEXT DEFAULT 'user',
        created_at TEXT DEFAULT (datetime('now'))
      );
      
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT DEFAULT (datetime('now')),
        level TEXT DEFAULT 'info',
        source TEXT DEFAULT 'orchestrator',
        msg TEXT DEFAULT '',
        data TEXT DEFAULT '{}'
      );
      
      CREATE TABLE IF NOT EXISTS state_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT DEFAULT (datetime('now')),
        project TEXT,
        event_type TEXT,
        data TEXT DEFAULT '{}'
      );
      
      CREATE TABLE IF NOT EXISTS verification_runs (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        task TEXT NOT NULL,
        criteria TEXT DEFAULT '',
        status TEXT DEFAULT 'pending',
        worker_model TEXT,
        reviewer_model TEXT,
        fixer_model TEXT,
        max_iterations INTEGER DEFAULT 3,
        current_iteration INTEGER DEFAULT 0,
        worker_output TEXT,
        reviewer_output TEXT,
        fixer_output TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      
      CREATE TABLE IF NOT EXISTS live_agents (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL DEFAULT '{}'
      );
      
      CREATE TABLE IF NOT EXISTS live_sessions (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL DEFAULT '{}'
      );
      
      CREATE TABLE IF NOT EXISTS pending_registrations (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL DEFAULT '{}'
      );
      
      CREATE TABLE IF NOT EXISTS control_results (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL DEFAULT '{}'
      );
      
      INSERT OR IGNORE INTO _schema_version (version) VALUES (1);
    `);
  });

  afterAll(() => {
    try {
      fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  describe('Project Management', () => {
    const testProject = `test-project-${Date.now()}`;

    it('should create a new project', () => {
      setProjectConfig(testProject, { location: `/tmp/${testProject}` });
      const config = getProjectConfig(testProject);
      expect(config).toBeDefined();
      expect(config.location).toBe(`/tmp/${testProject}`);
    });

    it('should update project config', () => {
      setProjectConfig(testProject, { 
        location: `/tmp/${testProject}`,
        routing_preset: 'free-only',
      });
      const config = getProjectConfig(testProject);
      expect(config.routing_preset).toBe('free-only');
    });

    it('should delete project config', () => {
      deleteProjectConfig(testProject);
      const config = getProjectConfig(testProject);
      // getProjectConfig returns empty object when project doesn't exist
      expect(Object.keys(config).length).toBe(0);
    });
  });

  describe('Backlog Management', () => {
    const testProject = `test-backlog-${Date.now()}`;

    beforeAll(() => {
      setProjectConfig(testProject, { location: `/tmp/${testProject}` });
    });

    it('should add a backlog task', () => {
      const task = {
        id: `task-${Date.now()}`,
        project: testProject,
        title: 'Implement login page',
        description: 'Create a login page with form validation',
        priority: 'p1',
        status: 'todo',
        labels: JSON.stringify(['frontend', 'auth']),
        depends_on: JSON.stringify([]),
        assigned_to: '',
        session_refs: JSON.stringify([]),
        created_ts: Date.now(),
        updated_ts: Date.now(),
      };

      addBacklogTask(task);
      const tasks = listBacklogTasks(testProject);
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks.some(t => t.title === 'Implement login page')).toBe(true);
    });

    it('should list backlog tasks', () => {
      const tasks = listBacklogTasks(testProject);
      expect(tasks.length).toBeGreaterThan(0);
    });

    it('should update task status', () => {
      const tasks = listBacklogTasks(testProject);
      const task = tasks.find(t => t.title === 'Implement login page');
      
      if (task) {
        updateBacklogTask(task.id, { status: 'in_progress' });
        const updatedTasks = listBacklogTasks(testProject);
        const updatedTask = updatedTasks.find(t => t.id === task.id);
        expect(updatedTask?.status).toBe('in_progress');
      }
    });
  });

  describe('Worker Management', () => {
    const testProject = `test-workers-${Date.now()}`;

    beforeAll(() => {
      setProjectConfig(testProject, { location: `/tmp/${testProject}` });
    });

    it('should hire a worker', async () => {
      const { req, res, getResponse } = createMockRequest('POST', '/api/software-house/workers/hire', {
        name: 'TestDev',
        role: 'Full Stack Developer',
        model: 'deepseek-v4-flash',
        room: 'dev',
        project: testProject,
      });

      await handleSoftwareHouseRoute(req, res);
      const response = getResponse();

      expect(response.code).toBe(200);
      expect(response.data.ok).toBe(true);
      expect(response.data.worker).toBeDefined();
      expect(response.data.worker.name).toBe('TestDev');
    });

    it('should list workers', async () => {
      const { req, res, getResponse } = createMockRequest('GET', `/api/software-house/workers?project=${testProject}`);

      await handleSoftwareHouseRoute(req, res);
      const response = getResponse();

      expect(response.code).toBe(200);
      // Workers endpoint returns array directly
      expect(Array.isArray(response.data)).toBe(true);
    });
  });

  describe('PM Chat', () => {
    const testProject = `test-pm-chat-${Date.now()}`;

    beforeAll(() => {
      setProjectConfig(testProject, { location: `/tmp/${testProject}` });
    });

    it('should send PM chat message', async () => {
      const { req, res, getResponse } = createMockRequest('POST', '/api/software-house/pm/chat', {
        project: testProject,
        message: 'What is the current status of the project?',
        sender: 'user',
      });

      await handleSoftwareHouseRoute(req, res);
      const response = getResponse();

      expect(response.code).toBe(200);
      expect(response.data.ok).toBe(true);
    });

    it('should get PM chat history', async () => {
      const { req, res, getResponse } = createMockRequest('GET', `/api/software-house/pm/chat?project=${testProject}`);

      await handleSoftwareHouseRoute(req, res);
      const response = getResponse();

      expect(response.code).toBe(200);
      expect(response.data.ok).toBe(true);
      expect(response.data.messages).toBeDefined();
    });
  });

  describe('Vault Documentation', () => {
    const testProject = `test-vault-${Date.now()}`;

    beforeAll(() => {
      setProjectConfig(testProject, { location: `/tmp/${testProject}` });
    });

    it('should create vault document', async () => {
      const { req, res, getResponse } = createMockRequest('PUT', '/api/software-house/vault/doc', {
        project: testProject,
        path: '/README.md',
        title: 'README',
        content: '# Test Project\n\nThis is a test project.',
      });

      await handleSoftwareHouseRoute(req, res);
      const response = getResponse();

      expect(response.code).toBe(200);
      expect(response.data.ok).toBe(true);
    });

    it('should list vault documents', async () => {
      const { req, res, getResponse } = createMockRequest('GET', `/api/software-house/vault/tree?project=${testProject}`);

      await handleSoftwareHouseRoute(req, res);
      const response = getResponse();

      expect(response.code).toBe(200);
      expect(response.data.ok).toBe(true);
      expect(response.data.vault).toBeDefined();
    });

    it('should get vault document content', async () => {
      const { req, res, getResponse } = createMockRequest('GET', `/api/software-house/vault/doc?project=${testProject}&path=/README.md`);

      await handleSoftwareHouseRoute(req, res);
      const response = getResponse();

      expect(response.code).toBe(200);
      // Vault doc get returns the document directly
      expect(response.data).toBeDefined();
      expect(response.data.content).toContain('# Test Project');
    });
  });

  describe('Model Management', () => {
    it('should upsert a model', () => {
      const modelId = `test-model-${Date.now()}`;
      const modelConfig = {
        name: 'Test Model',
        provider: 'test-provider',
        status: 'active',
        agent_ready: true,
        context_window: 100000,
        architecture: 'transformer',
        pricing: { input: 0, output: 0 },
        metadata: {},
      };

      upsertModel(modelId, modelConfig);
      const models = listModels();
      // listModels returns config objects, check by name
      expect(models.some(m => m.name === modelConfig.name)).toBe(true);
    });

    it('should list models', () => {
      const models = listModels();
      expect(Array.isArray(models)).toBe(true);
    });
  });

  describe('Session Management', () => {
    const testProject = `test-sessions-${Date.now()}`;

    beforeAll(() => {
      setProjectConfig(testProject, { location: `/tmp/${testProject}` });
    });

    it('should add a session', () => {
      const session = {
        id: `session-${Date.now()}`,
        session_key: `test-session-${Date.now()}`,
        project: testProject,
        task: 'Test task',
        model: 'test-model',
        agent: 'test-agent',
        status: 'in_progress',
        start_ts: Date.now(),
      };

      addSession(session);
      const sessions = listSessions(testProject);
      expect(sessions.some(s => s.session_key === session.session_key)).toBe(true);
    });

    it('should list sessions', () => {
      const sessions = listSessions(testProject);
      expect(Array.isArray(sessions)).toBe(true);
    });
  });

  describe('Full Workflow Integration', () => {
    const testProject = `test-full-workflow-${Date.now()}`;

    it('should complete full project lifecycle', async () => {
      // 1. Create project
      setProjectConfig(testProject, { location: `/tmp/${testProject}` });
      const config = getProjectConfig(testProject);
      expect(config).toBeDefined();

      // 2. Hire worker
      const hireRes = createMockRequest('POST', '/api/software-house/workers/hire', {
        name: 'WorkflowDev',
        role: 'Developer',
        model: 'deepseek-v4-flash',
        room: 'dev',
        project: testProject,
      });
      await handleSoftwareHouseRoute(hireRes.req, hireRes.res);
      expect(hireRes.getResponse().data.ok).toBe(true);

      // 3. Add backlog tasks
      const task1 = {
        id: `task1-${Date.now()}`,
        project: testProject,
        title: 'Task 1: Setup project',
        description: 'Initialize project structure',
        priority: 'p0',
        status: 'todo',
        labels: '[]',
        depends_on: '[]',
        assigned_to: '',
        session_refs: '[]',
        created_ts: Date.now(),
        updated_ts: Date.now(),
      };
      addBacklogTask(task1);

      const task2 = {
        id: `task2-${Date.now()}`,
        project: testProject,
        title: 'Task 2: Implement feature',
        description: 'Build the main feature',
        priority: 'p1',
        status: 'todo',
        labels: '[]',
        depends_on: '[]',
        assigned_to: '',
        session_refs: '[]',
        created_ts: Date.now(),
        updated_ts: Date.now(),
      };
      addBacklogTask(task2);

      // 4. Create vault documentation
      const vaultRes = createMockRequest('PUT', '/api/software-house/vault/doc', {
        project: testProject,
        path: '/ARCHITECTURE.md',
        title: 'Architecture',
        content: '# Architecture\n\nSystem design document.',
      });
      await handleSoftwareHouseRoute(vaultRes.req, vaultRes.res);
      expect(vaultRes.getResponse().data.ok).toBe(true);

      // 5. Send PM message
      const pmRes = createMockRequest('POST', '/api/software-house/pm/chat', {
        project: testProject,
        message: 'Project started, please begin Task 1.',
        sender: 'user',
      });
      await handleSoftwareHouseRoute(pmRes.req, pmRes.res);
      expect(pmRes.getResponse().data.ok).toBe(true);

      // 6. Verify all data exists
      const tasks = listBacklogTasks(testProject);
      expect(tasks.length).toBe(2);

      // 7. Get bootstrap data
      const bootstrapRes = createMockRequest('GET', '/api/software-house/bootstrap');
      await handleSoftwareHouseRoute(bootstrapRes.req, bootstrapRes.res);
      const bootstrap = bootstrapRes.getResponse().data;
      expect(bootstrap.ok).toBe(true);
      expect(bootstrap.projects).toBeDefined();
    });
  });

  describe('Cleanup', () => {
    it('should clean up test projects', async () => {
      // Add a small delay to ensure all operations complete
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const db = getDb();
      const projects = db.prepare('SELECT project FROM project_configs').all() as any[];
      
      for (const p of projects) {
        if (p.project.startsWith('test-')) {
          try {
            deleteProjectConfig(p.project);
          } catch (e) {
            // Ignore errors during cleanup
          }
        }
      }

      const remainingProjects = db.prepare('SELECT project FROM project_configs').all() as any[];
      const testProjectsRemaining = remainingProjects.filter((p: any) => p.project.startsWith('test-'));
      expect(testProjectsRemaining.length).toBe(0);
    });
  });
});
