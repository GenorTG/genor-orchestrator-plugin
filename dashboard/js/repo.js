// repo.js — updateRepoStatus, repoPull, repoPush, refreshRepoStatus

import { state, syncFromStore } from './state.js';
import { toast } from './utils.js';

export function updateRepoStatus() {
  const repoArea = document.getElementById('repoStatusArea');
  const repoActions = document.getElementById('repoActions');
  const repo = state.project?.repo;

  if (!repoArea || !repoActions) return; // elements removed in UI redesign

  if (!repo || !repo.hasRepo) {
    repoArea.style.display = 'none';
    repoActions.style.display = 'none';
    return;
  }

  repoArea.style.display = 'block';
  repoActions.style.display = 'flex';

  const branchLabel = repo.branch ? '<b style="color:var(--accent)">' + repo.branch + '</b>' : '—';
  const dirtyBadge = repo.dirty ? ' <span style="color:var(--orange);font-weight:700">● dirty</span>' : ' <span style="color:var(--green)">● clean</span>';
  const commitLabel = repo.lastCommit ? repo.lastCommit.slice(0, 50) : '—';
  const commitFull = repo.lastCommit || '—';

  repoArea.innerHTML = '<div style="margin-bottom:4px">📂 <b>Git</b> ' + branchLabel + dirtyBadge + '</div>' +
    '<div style="font-size:10px;color:var(--text-dim);word-break:break-all">' +
    (repo.remote ? '🔗 ' + repo.remote + '<br>' : '') +
    '<span title="' + commitFull.replace(/"/g, '&quot;') + '">' + '📝 ' + commitLabel + '</span></div>';
}

export async function repoPull() {
  try {
    const data = await store.gitPull();
    toast('⬇ Pull OK — zmieniono ' + (data.filesChanged || 0) + ' plików');
    syncFromStore();
  } catch (e) {
    toast('⚠️ ' + e.message);
  }
}

export async function repoPush() {
  var msg = prompt('Komentarz do commitu:');
  if (!msg || !msg.trim()) return;
  try {
    const data = await store.gitPush(msg.trim());
    const parts = [];
    if (data.committed) parts.push('committed');
    if (data.pushed) parts.push('pushed');
    toast('⬆ Push OK — ' + (parts.join(' + ') || 'nothing to do'));
    syncFromStore();
  } catch (e) {
    toast('⚠️ ' + e.message);
  }
}

export async function refreshRepoStatus() {
  try {
    const data = await store.refreshRepoStatus();
    if (data.ok && state.project) {
      state.project.repo = data;
      updateRepoStatus();
    }
  } catch (e) {}
}
