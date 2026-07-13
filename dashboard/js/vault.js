// vault.js — renderVault, openVaultFile, renderVaultTreeActive, injectVaultDoc

import { state } from './state.js';
import { toast } from './utils.js';

export function renderVault() {
  const vault = state.project.vault || {};
  document.getElementById('vaultProjectLabel').textContent = state.project.name;
  const folders = {};
  Object.entries(vault).forEach(([path, doc]) => {
    const f = doc.folder || '';
    if (!folders[f]) folders[f] = [];
    folders[f].push({ path, ...doc });
  });
  const folderLabels = { '': 'Główne', docs: 'docs/', decisions: 'decisions/', sessions: 'sessions/', compliance: 'compliance/', experiments: 'experiments/', content: 'content/' };
  const folderOrder = ['', 'docs', 'decisions', 'compliance', 'experiments', 'content', 'sessions', ...Object.keys(folders).filter(f => !['','docs','decisions','sessions','compliance','experiments','content'].includes(f))];
  let tree = '';
  folderOrder.forEach(f => {
    const files = folders[f];
    if (!files?.length) return;
    tree += `<div class="vault-folder"><div class="vault-folder-label">${folderLabels[f] || f + '/'}</div>`;
    files.forEach(doc => {
      const active = state.activeVaultFile === doc.path ? ' active' : '';
      tree += `<div class="vault-file${active}" onclick="window._openVaultFile('${doc.path}')">
        <span class="icon">${doc.icon}</span><span>${doc.path.split('/').pop()}</span>
        <span class="meta">${doc.updated?.slice(5) || ''}</span></div>`;
    });
    tree += '</div>';
  });
  document.getElementById('vaultTree').innerHTML = tree;
  if (!vault[state.activeVaultFile]) state.activeVaultFile = Object.keys(vault)[0] || 'STATE.md';
  openVaultFile(state.activeVaultFile, true);
}

export function openVaultFile(path, skipTree) {
  const doc = state.project.vault?.[path];
  if (!doc) return;
  state.activeVaultFile = path;
  document.getElementById('vaultDocTitle').textContent = doc.title || path;
  document.getElementById('vaultDocPath').textContent = '/' + path;
  document.getElementById('vaultContent').innerHTML = doc.html || '<p>Brak treści.</p>';
  const statusColors = { active: 'var(--green)', stable: 'var(--accent)', accepted: 'var(--purple)', archive: 'var(--text-dim)' };
  document.getElementById('vaultMeta').innerHTML = `
    <h4>Metadane</h4>
    <div class="vault-meta-row"><span>Status</span><b><span class="vault-status-dot" style="background:${statusColors[doc.status]||'var(--text-dim)'}"></span>${doc.status || '—'}</b></div>
    <div class="vault-meta-row"><span>Ostatnia zmiana</span><b>${doc.updated || '—'}</b></div>
    <div class="vault-meta-row"><span>Projekt</span><b>${state.project.name}</b></div>
    <h4 style="margin-top:16px">Tagi</h4>
    <div class="vault-tags">${(doc.tags||[]).map(t=>`<span class="vault-tag">#${t}</span>`).join('')}</div>
    ${doc.links?.length ? `<h4 style="margin-top:16px">Powiązane</h4><div class="vault-link-list">${doc.links.map(l=>`<span class="vault-link" onclick="window._openVaultFile('${l}')">${l}</span>`).join('')}</div>` : ''}
    <h4 style="margin-top:16px">Orchestrator</h4>
    <p style="font-size:11px;color:var(--text-dim);line-height:1.5;margin-top:6px">Ten vault będzie synchronizowany z <code>orchestrator-data/</code> i wstrzykiwany do kontekstu agentów przez hooki pluginu.</p>
    <button class="btn primary" style="width:100%;margin-top:12px;font-size:11px" onclick="window._injectVaultDoc('${path}')">📥 Wstrzyknij do sesji</button>`;
  if (!skipTree) {
    document.querySelectorAll('.vault-file').forEach(el => {
      el.classList.toggle('active', el.textContent.includes(path.split('/').pop()));
    });
    renderVaultTreeActive(path);
  }
}

export function renderVaultTreeActive(path) {
  document.querySelectorAll('.vault-file').forEach(el => {
    const onclick = el.getAttribute('onclick') || '';
    el.classList.toggle('active', onclick.includes(`'${path}'`));
  });
}

export function injectVaultDoc(path) {
  store.injectVaultDoc(path).then(data => {
    if (data.ok) toast(`📥 Dokument "${path}" wstrzyknięty do kontekstu`);
    else toast(`❌ Błąd: ${data.error}`);
  }).catch(err => { toast(`❌ Błąd sieci: ${err.message}`); });
}
