#!/usr/bin/env node
/**
 * gateway-ws-bridge.js — v4
 * Connects to Gateway WS, subscribes to session events, processes chat outbox.
 *
 * Usage: node gateway-ws-bridge.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');

const HOME = process.env.HOME || '/home/genorbox1';
const DATA_DIR = path.join(HOME, '.openclaw', 'workspace', 'orchestrator-data');
const LIVE_FILE = path.join(DATA_DIR, 'live-sessions.json');
const OUTBOX_FILE = path.join(DATA_DIR, 'chat-outbox.json');
const GATEWAY_HOST = '127.0.0.1';
const GATEWAY_PORT = 18789;
const WS_URL = `ws://${GATEWAY_HOST}:${GATEWAY_PORT}/ws`;

// ── Token from config (with SOPS fallback) ────────────────────
function readConfigToken() {
  // 1) Try direct from openclaw.json
  try {
    const p = path.join(HOME, '.openclaw', 'openclaw.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t = cfg.gateway?.auth?.token;
    if (t && !t.includes('REDACTED') && !t.startsWith('__')) return t;
  } catch (e) {}
  // 2) Try SOPS-encrypted secrets (survives config corruption)
  try {
    const secretFile = path.join(HOME, '.openclaw', 'secrets.enc.json');
    const ageKey = path.join(HOME, '.age', 'key.txt');
    if (fs.existsSync(secretFile) && fs.existsSync(ageKey)) {
      const { execSync } = require('child_process');
      const stdout = execSync(
        `sops --decrypt "${secretFile}"`,
        { env: { ...process.env, SOPS_AGE_KEY_FILE: ageKey }, timeout: 5000, encoding: 'utf8' }
      );
      const cfg = JSON.parse(stdout);
      const t = cfg.data?.gateway_token;
      if (t && !t.includes('REDACTED')) return t;
    }
  } catch (e) {
    console.error('[Bridge] SOPS token fallback failed:', e.message);
  }
  // 3) Last resort: environment variable
  return process.env.GATEWAY_TOKEN || '';
}
const TOKEN = readConfigToken();
function gw(method, path, body) {
  return new Promise((resolve) => {
    const opts = {
      hostname: GATEWAY_HOST, port: GATEWAY_PORT, path, method,
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 5000,
    };
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({ ok: false, error: e.message }); } });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Outbox processing (fire-and-forget via HTTP) ──────────────
const OUTBOX_SEND_TIMEOUT = 15000; // 15s — sessions_send can block on agent reply
const STALE_SENDING_MS = 30000; // 30s — reset stuck "sending" items

function processOutbox() {
  try {
    if (!fs.existsSync(OUTBOX_FILE)) return;
    const raw = fs.readFileSync(OUTBOX_FILE, 'utf8').trim();
    if (!raw) return;
    const ob = JSON.parse(raw);
    const pending = ob.pending || [];
    if (!pending.length) return;

    const now = Date.now();
    let changed = false;

    // Reset stale sending items (bridge crashed mid-send)
    for (const item of pending) {
      if (item.sending && !item.sent && (now - (item.ts * 1000 || 0)) > STALE_SENDING_MS) {
        item.sending = false;
        item.retries = (item.retries || 0) + 1;
        item.error = 'stale (crashed), retry ' + item.retries;
        changed = true;
        console.log(`[Bridge] ⚠ Reset stale sending item ${item.id}`);
      }
    }
    // Drop items with too many retries
    ob.pending = pending.filter(p => (p.retries || 0) < 5);

    const next = (ob.pending || []).find(p => !p.sent && !p.sending);
    if (!next) return;

    next.sending = true;
    changed = true;
    if (changed) fs.writeFileSync(OUTBOX_FILE, JSON.stringify(ob, null, 2));

    console.log(`[Bridge] Sending to ${next.sessionKey}: "${(next.message||'').substring(0,40)}..."`);
    const body = JSON.stringify({ tool: 'sessions_send', args: { sessionKey: next.sessionKey, message: next.message } });
    const opts = {
      hostname: GATEWAY_HOST, port: GATEWAY_PORT,
      path: '/tools/invoke', method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: OUTBOX_SEND_TIMEOUT,
    };
    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          next.sent = true; next.error = null;
          console.log(`[Bridge] ✅ Sent to ${next.sessionKey}`);
        } else {
          next.error = `HTTP ${res.statusCode}: ${d.substring(0, 100)}`;
          console.log(`[Bridge] ❌ Send failed: ${next.error}`);
        }
        // Flush state before cleanup
        try {
          const raw = fs.readFileSync(OUTBOX_FILE, 'utf8');
          const ob2 = JSON.parse(raw);
          ob2.pending = (ob2.pending || []).map(p => p.id === next.id ? next : p);
          ob2.pending = ob2.pending.filter(p => !p.sent);
          fs.writeFileSync(OUTBOX_FILE, JSON.stringify(ob2, null, 2));
        } catch(e) {}
      });
    });
    req.on('error', (e) => {
      next.error = e.message;
      try {
        const raw = fs.readFileSync(OUTBOX_FILE, 'utf8');
        const ob2 = JSON.parse(raw);
        ob2.pending = (ob2.pending || []).map(p => p.id === next.id ? next : p);
        fs.writeFileSync(OUTBOX_FILE, JSON.stringify(ob2, null, 2));
      } catch(e) {}
    });
    req.on('timeout', () => {
      req.destroy();
      // sessions_send can block — timeout is expected after send goes through
      next.sent = true; next.error = null;
      // Write state before cleanup (timeout handler mutates in-memory, not file)
      try {
        const raw = fs.readFileSync(OUTBOX_FILE, 'utf8');
        const ob2 = JSON.parse(raw);
        ob2.pending = (ob2.pending || []).map(p => p.id === next.id ? next : p);
        ob2.pending = ob2.pending.filter(p => !p.sent);
        fs.writeFileSync(OUTBOX_FILE, JSON.stringify(ob2, null, 2));
      } catch(e) {}
      console.log(`[Bridge] ⏱ sessions_send timed out — message probably sent`);
    });
    req.write(body);
    req.end();
  } catch (e) { console.error(`[Bridge] Outbox: ${e.message}`); }
}

function cleanupOutbox() {
  try {
    const raw = fs.readFileSync(OUTBOX_FILE, 'utf8');
    const ob = JSON.parse(raw);
    ob.pending = (ob.pending || []).filter(p => !p.sent);
    fs.writeFileSync(OUTBOX_FILE, JSON.stringify(ob, null, 2));
  } catch (e) {}
}

setInterval(processOutbox, 2000);

// ── WebSocket Connection ───────────────────────────────────────
function connect() {
  console.log('[Bridge] Connecting to Gateway WS...');
  const ws = new WebSocket(WS_URL, { handshakeTimeout: 5000 });
  let connected = false;
  let pingTimer = null;

  ws.on('open', () => {
    console.log('[Bridge] WS connected, waiting for challenge...');
    connected = true;
    // Don't subscribe yet — wait for auth challenge first
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleMessage(msg, ws);
    } catch (e) {
      console.error('[Bridge] Parse error:', e.message);
    }
  });

  ws.on('close', () => {
    connected = false;
    console.log('[Bridge] WS closed, reconnecting in 3s');
    // Don't overwrite connected=False — the HTTP fetch (30s) sets it
    setTimeout(connect, 3000);
  });

  ws.on('error', (e) => {
    console.error('[Bridge] WS error:', e.message);
  });

  // Ping every 15s
  pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 15000);
}

function handleMessage(msg, ws) {
  console.log('[Bridge] WS received:', msg.type || JSON.stringify(msg).substring(0, 100));

  if (msg.type === 'challenge') {
    console.log('[Bridge] Auth challenge received');
    const keypair = getDeviceKeypair();
    if (!keypair) return;
    // Build signed challenge
    const challenge = msg.challenge || msg;
    const challengeStr = typeof challenge === 'string' ? challenge : JSON.stringify(challenge);
    const { createSign } = require('crypto');
    const signer = createSign('SHA512');
    signer.update(challengeStr);
    const signature = signer.sign({
      key: `-----BEGIN PRIVATE KEY-----\n${keypair.private}\n-----END PRIVATE KEY-----`,
      format: 'pem', type: 'pkcs8'
    }, 'hex');
    ws.send(JSON.stringify({ type: 'challenge.response', response: signature }));
    console.log('[Bridge] Auth response sent');
    return;
  }

  if (msg.type === 'error') {
    console.error('[Bridge] WS error:', JSON.stringify(msg).substring(0, 300));
    return;
  }

  if (msg.type === 'connected' || msg.type === 'hello' || msg.type === 'ready') {
    console.log('[Bridge] Authenticated! Subscribing...');
    ws.send(JSON.stringify({ type: 'sessions.messages.subscribe', params: {} }));
    console.log('[Bridge] Subscribed');
    fetchAndWriteSessions();
    return;
  }

  if (msg.type === 'session.message' || msg.type === 'sessions.message' || msg.type === 'sessions.message.event') {
    console.log('[Bridge] Session message event');
    fetchAndWriteSessions();
    return;
  }

  if (msg.type === 'sessions.list' || msg.type === 'sessions.changed') {
    fetchAndWriteSessions();
    return;
  }

  if (msg.type === 'pong') return;
  if (msg.type === 'ok' || msg.type === 'ack') {
    console.log('[Bridge] Ack:', JSON.stringify(msg).substring(0, 200));
    return;
  }
}

// ── Keypair ───────────────────────────────────────────────────
function getDeviceKeypair() {
  const kp = path.join(HOME, '.openclaw', 'identity-ed25519.json');
  try { return JSON.parse(fs.readFileSync(kp, 'utf8')); }
  catch (e) { console.error('[Bridge] No keypair at', kp); return null; }
}

function signChallenge(challenge, privateKeyHex) { /* moved inline */ }

// ── Fetch sessions via HTTP API ────────────────────────────────
async function fetchAndWriteSessions() {
  try {
    const r = await gw('POST', '/tools/invoke', { tool: 'sessions_list', args: { limit: 100 } });
    if (!r.ok) return;
    const content = r.result?.content || [];
    let rawSessions = {};
    if (content[0]?.text) {
      try { rawSessions = JSON.parse(content[0].text); } catch(e) {
        console.error('[Bridge] Parse error:', e.message);
        return;
      }
    }
    // Normalize: gateway returns { sessions: [...], count: N }
    const arr = Array.isArray(rawSessions) ? rawSessions
      : (rawSessions?.sessions || rawSessions?.result || []);

    // Generate smart display names
    function makeDisplayName(s) {
      if (s.displayName && s.displayName !== '?') return s.displayName;
      if (s.name && s.name !== '?') return s.name;
      const key = s.key || s.sessionKey || '';
      const parts = key.split(':');
      // agent:type:channel:id format
      if (parts.length >= 4) {
        const agentType = parts[2] || '';
        const suffix = parts[3] ? parts[3].substring(0, 8) : '';
        if (agentType === 'discord' || agentType === 'direct') {
          return parts.slice(3,5).filter(Boolean).join(':') || parts[1];
        }
        if (agentType === 'dashboard') {
          return 'Dashboard (' + suffix + ')';
        }
        if (agentType === 'cron') {
          return 'Cron: ' + (parts[3] || '').substring(0, 8);
        }
        if (agentType === 'subagent') {
          return 'Subagent (' + suffix + ')';
        }
        if (agentType === 'acp') {
          return 'ACP (' + suffix + ')';
        }
        return parts.slice(2,4).join(':') || suffix || 'Unnamed';
      }
      return parts.slice(-1)[0] || key.substring(0, 16) || 'Unnamed';
    }

    function makeModel(s) {
      return s.model || s.tools?.model || s._meta?.model || '?';
    }

    function makeStatus(s) {
      const st = s.status;
      if (!st || st === '?') {
        if (s.lastActivity) return 'active';
        if (s.messages?.length > 0) return 'idle';
        return 'unknown';
      }
      return ['running','done','timeout','failed','killed','inactive','active','completed','idle'].includes(st) ? st : 'unknown';
    }

    const data = {
      _meta: {
        updatedAt: new Date().toISOString(),
        sessionCount: arr.length || 0,
        connected: true,
      },
      sessions: (arr || []).map(s => ({
        key: s.key || s.sessionKey || '',
        displayName: makeDisplayName(s),
        model: makeModel(s),
        status: makeStatus(s),
        messages: s.messages || s.history || [],
      })),
    };
    fs.writeFileSync(LIVE_FILE, JSON.stringify(data, null, 2));
    console.log(`[Bridge] Updated: ${data._meta.sessionCount} sessions`);
  } catch (e) {
    console.error('[Bridge] Fetch error:', e.message);
  }
}

function writeMeta(connected) {
  try {
    const data = JSON.parse(fs.readFileSync(LIVE_FILE, 'utf8'));
    data._meta.connected = connected;
    data._meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(LIVE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {}
}

// Fetch sessions immediately on start and every 30s as fallback
setInterval(fetchAndWriteSessions, 30000);

// ── Boot ───────────────────────────────────────────────────────
console.log(`[Bridge] Token: ${TOKEN ? 'YES (' + TOKEN.substring(0, 8) + '...)' : 'NO'}`);
if (!fs.existsSync(OUTBOX_FILE)) {
  fs.writeFileSync(OUTBOX_FILE, JSON.stringify({ pending: [] }, null, 2));
}
fetchAndWriteSessions();
connect();
console.log('[Bridge] Running.');
