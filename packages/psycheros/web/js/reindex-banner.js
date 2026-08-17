/**
 * Re-index Banner
 *
 * Persistent status banner for embedding re-indexing, fed by
 * `embedding_reindex` SSE events (entity-core rebuilds and the Settings
 * re-embed orchestrator both emit them). Lives in the app shell above the
 * chat bar so it survives HTMX swaps of #chat.
 */

let dismissed = false;
let reindexing = false;

function getBanner() {
  let el = document.getElementById('reindex-banner');
  if (!el) {
    // Defensive: re-create if a swap removed it.
    el = document.createElement('div');
    el.id = 'reindex-banner';
    el.className = 'reindex-banner';
    el.hidden = true;
    const chat = document.getElementById('chat');
    if (chat && chat.parentNode) chat.parentNode.insertBefore(el, chat);
    else document.body.appendChild(el);
  }
  return el;
}

function dismissBanner() {
  dismissed = true;
  const el = document.getElementById('reindex-banner');
  if (el) {
    el.hidden = true;
    el.innerHTML = '';
  }
}

function renderProgress(evt) {
  const el = getBanner();
  const done = typeof evt.done === 'number' ? evt.done : 0;
  const total = typeof evt.total === 'number' ? evt.total : 0;
  const count = total > 0 ? ` — ${done}/${total}` : '';
  el.innerHTML =
    `<span class="reindex-banner-text">Re-indexing entity memory${count}. Chat works normally; memory recall may be sparse until done.</span>` +
    `<button class="reindex-banner-dismiss" onclick="ReindexBanner.dismiss()" aria-label="Dismiss">×</button>`;
  el.hidden = false;
}

function renderModelChange(evt) {
  const el = getBanner();
  el.innerHTML =
    `<span class="reindex-banner-text">${evt.message || 'Embedding model changed — memory indexes need rebuilding.'}</span>` +
    `<button class="reindex-banner-action" onclick="ReindexBanner.startReindex()">Re-index now</button>` +
    `<button class="reindex-banner-dismiss" onclick="ReindexBanner.dismiss()" aria-label="Dismiss">×</button>`;
  el.hidden = false;
}

async function startReindex() {
  const el = getBanner();
  const btn = el.querySelector('.reindex-banner-action');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Starting…';
  }
  try {
    const resp = await fetch('/api/embedding-settings/confirm-reembed', { method: 'POST' });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.success === false) {
      throw new Error(data.error || `HTTP ${resp.status}`);
    }
    // Subsequent embedding_reindex events take over the banner.
  } catch (e) {
    if (globalThis.showToast) showToast('Failed to start re-index: ' + e.message, 'warning');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Re-index now';
    }
  }
}

function onEvent(evt) {
  if (!evt || typeof evt.phase !== 'string') return;
  switch (evt.phase) {
    case 'started':
      dismissed = false;
      reindexing = true;
      renderProgress(evt);
      break;
    case 'progress':
      reindexing = true;
      if (!dismissed) renderProgress(evt);
      break;
    case 'done':
      reindexing = false;
      dismissBanner();
      if (globalThis.showToast) showToast('Re-indexing complete');
      break;
    case 'failed':
      reindexing = false;
      dismissBanner();
      if (globalThis.showToast) {
        showToast(evt.message || 'Re-indexing failed', 'warning');
      }
      break;
    case 'model_change_detected':
      reindexing = false;
      if (!dismissed) renderModelChange(evt);
      break;
  }
}

globalThis.ReindexBanner = { onEvent, dismiss: dismissBanner, startReindex };
