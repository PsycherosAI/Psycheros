/**
 * Knowledge Graph — List Editor + Network Graph Toggle
 *
 * Mobile-first card list with an optional vis-network graph,
 * proper edge creation modal, and delete confirmation modal.
 * No prompt(), confirm(), or confidence fields.
 */

// ─── Color Utilities (reused from graph view) ─────────────────────────────────

// ─── Dialog plumbing ─────────────────────────────────────────────────────────
// The four graph dialogs are opened and closed by class changes in a dozen
// handlers. Focus, Escape and the Tab trap are wired once here rather than at
// every call site, and the CSS keeps a closed dialog out of the tab order.
const GRAPH_MODAL_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';

let graphFocusOutside = null;

/** The topmost open dialog — later in DOM order wins when one stacks on another. */
function openGraphModal() {
  const open = document.querySelectorAll(".gv-modal.gv-modal-open");
  return open.length ? open[open.length - 1] : null;
}

document.addEventListener("focusin", (e) => {
  if (!e.target.closest(".gv-modal")) graphFocusOutside = e.target;
});

document.addEventListener("keydown", (e) => {
  const modal = openGraphModal();
  if (!modal) return;

  if (e.key === "Escape") {
    e.preventDefault();
    modal.classList.remove("gv-modal-open");
    return;
  }
  if (e.key !== "Tab") return;

  const items = [...modal.querySelectorAll(GRAPH_MODAL_FOCUSABLE)];
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;

  if (!modal.contains(active)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
});

// Opening a dialog moves focus into it; closing it hands focus back to whatever
// the user was on before (the row or button that opened it). Re-observed on
// every initGraph because the dialogs are re-rendered with the fragment.
//
// A closed dialog is taken out of the tab order with inert, not with
// visibility:hidden: a child inherits a visibility flip two to four frames
// late, so focus() into a just-opened dialog is a silent no-op and focus stayed
// on the card behind it (Playwright probe, 2026-09-28). inert is read straight
// off the DOM, so moving focus in works in the same task.
const graphModalObserver = new MutationObserver((records) => {
  for (const record of records) {
    const modal = record.target;
    const open = modal.classList.contains("gv-modal-open");
    modal.inert = !open;
    if (!open) {
      if (graphFocusOutside?.isConnected) graphFocusOutside.focus();
      continue;
    }
    if (!modal.contains(document.activeElement)) {
      modal.querySelector(GRAPH_MODAL_FOCUSABLE)?.focus();
    }
  }
});

function watchGraphModals() {
  // The dialogs are re-rendered with the fragment, so drop the previous set
  // before observing the new one.
  graphModalObserver.disconnect();
  for (const modal of document.querySelectorAll(".gv-modal")) {
    modal.inert = !modal.classList.contains("gv-modal-open");
    graphModalObserver.observe(modal, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }
}

function getNodeTypeConfig() {
  return {
    self:       { hue: 160, label: 'Self' },
    person:     { hue: 200, label: 'Person' },
    emotion:    { hue: 340, label: 'Emotion' },
    event:      { hue: 220, label: 'Event' },
    memory_ref: { hue: 280, label: 'Memory' },
    topic:      { hue: 35,  label: 'Topic' },
    preference: { hue: 180, label: 'Preference' },
    place:      { hue: 25,  label: 'Place' },
    goal:       { hue: 55,  label: 'Goal' },
    health:     { hue: 0,   label: 'Health' },
    boundary:   { hue: 210, label: 'Boundary' },
    tradition:  { hue: 90,  label: 'Tradition' },
    insight:    { hue: 45,  label: 'Insight' },
    default:    { hue: 0,   label: 'Other' }
  };
}

function hslColor(hue, s, l, a) {
  if (a !== undefined) return `hsla(${hue}, ${s}%, ${l}%, ${a})`;
  return `hsl(${hue}, ${s}%, ${l}%)`;
}

function getNodeColor(type) {
  const config = getNodeTypeConfig();
  const info = config[type] || config.default;
  return {
    background: hslColor(info.hue, 55, 35),
    border: hslColor(info.hue, 55, 50),
    highlight: {
      background: hslColor(info.hue, 60, 45),
      border: hslColor(info.hue, 70, 60)
    },
    hover: {
      background: hslColor(info.hue, 55, 40),
      border: hslColor(info.hue, 60, 55)
    }
  };
}

function getEdgeColor(type) {
  const map = {
    loves: { h: 340, s: 50 }, dislikes: { h: 25, s: 40 },
    respects: { h: 200, s: 40 }, proud_of: { h: 45, s: 50 },
    worried_about: { h: 0, s: 50 }, nostalgic_for: { h: 30, s: 40 },
    intrigued_by: { h: 270, s: 40 }, frustrated_with: { h: 15, s: 50 },
    family_of: { h: 30, s: 40 }, friend_of: { h: 200, s: 40 },
    works_with: { h: 210, s: 35 }, close_to: { h: 210, s: 40 },
    estranged_from: { h: 0, s: 40 }, works_at: { h: 210, s: 30 },
    lives_in: { h: 140, s: 35 }, studies: { h: 270, s: 30 },
    values: { h: 45, s: 45 }, believes_in: { h: 200, s: 45 },
    skilled_at: { h: 270, s: 40 }, interested_in: { h: 55, s: 40 },
    caused: { h: 0, s: 35 }, led_to: { h: 25, s: 30 },
    part_of: { h: 200, s: 30 }, reminds_of: { h: 270, s: 30 },
    associated_with: { h: 0, s: 0 }, similar_to: { h: 210, s: 25 },
    mentions: { h: 270, s: 30 }, mentioned_in: { h: 270, s: 25 },
  };
  const info = map[type] || { h: 0, s: 0 };
  const color = hslColor(info.h, info.s, 45, 0.7);
  return { color, highlight: hslColor(info.h, info.s + 10, 55), hover: color };
}

// ─── State ───────────────────────────────────────────────────────────────────

let network = null;
let graphData = { nodes: [], edges: [] };
let currentView = 'list';       // 'list' | 'graph'
let expandedNodeId = null;
let filteredNodes = [];
let connectionCounts = new Map();
let initialized = false;
let deleteTargetNodeId = null;
let eventListenersAbort = null;

const NODE_LIMIT_STORAGE_KEY = 'psycheros:graphNodeLimit';
const DEFAULT_NODE_LIMIT = 500;

// ─── Node Limit ──────────────────────────────────────────────────────────────

function getNodeLimit() {
  const el = document.getElementById('graph-node-limit');
  const v = el ? parseInt(el.value, 10) : NaN;
  return Number.isInteger(v) && v >= 1 ? v : DEFAULT_NODE_LIMIT;
}

function applyStoredNodeLimit() {
  const el = document.getElementById('graph-node-limit');
  if (!el) return;
  const saved = parseInt(localStorage.getItem(NODE_LIMIT_STORAGE_KEY) || '', 10);
  if (Number.isInteger(saved) && saved >= 1) el.value = String(saved);
}

function updateShownHint(announce) {
  const countEl = document.getElementById('gv-shown-count');
  if (!countEl) return;
  const total = graphData.stats?.totalNodes ?? 0;
  const shown = graphData.nodes?.length ?? 0;
  const truncated = total > shown && shown > 0;
  countEl.textContent = truncated ? `showing ${shown}` : '';
  countEl.title = truncated
    ? `Showing ${shown} of ${total} nodes — raise "Max" to load more`
    : '';
  document.querySelectorAll('.gv-shown-row').forEach((el) => {
    el.classList.toggle('gv-hidden', !truncated);
  });
  if (!announce) return;
  // The visible hint collapses to display:none unless the load is truncated,
  // so speak the result through the shared persistent status region instead.
  let message;
  if (total === 0) {
    message = 'The knowledge graph is empty.';
  } else if (truncated) {
    message = `Showing ${shown} of ${total} nodes. Raise Max to load more.`;
  } else {
    message = `Showing all ${total} nodes.`;
  }
  globalThis.announceStatus?.(message);
}

// ─── Initialization ──────────────────────────────────────────────────────────

async function initGraph() {
  if (initialized) {
    if (network) { network.destroy(); network = null; }
    expandedNodeId = null;
  }
  initialized = true;
  currentView = 'list';
  applyStoredNodeLimit();
  await loadGraphData();
  setupEventListeners();
  watchGraphModals();
}

// ─── Data Loading ────────────────────────────────────────────────────────────

async function loadGraphData({ announce = false } = {}) {
  const listView = document.getElementById('gv-list-view');
  const graphView = document.getElementById('gv-graph-view');

  try {
    const response = await fetch(`/api/graph?limit=${getNodeLimit()}`);
    if (!response.ok) throw new Error('Failed to load graph data');
    graphData = await response.json();

    buildConnectionCounts();
    populateTypeFilter();
    getFilteredNodes();
    updateShownHint(announce);

    if (!graphData.nodes || graphData.nodes.length === 0) {
      const emptyHtml = `
        <div class="gv-empty">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3">
            <circle cx="12" cy="12" r="3"/>
            <circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/>
            <circle cx="5" cy="18" r="2"/><circle cx="19" cy="18" r="2"/>
            <line x1="7" y1="7" x2="10" y2="10"/><line x1="17" y1="7" x2="14" y2="10"/>
            <line x1="7" y1="17" x2="10" y2="14"/><line x1="17" y1="17" x2="14" y2="14"/>
          </svg>
          <p>Knowledge graph is empty</p>
          <p class="gv-empty-hint">Create nodes during conversation or use the Add Node button</p>
        </div>`;
      if (listView) listView.innerHTML = emptyHtml;
      return;
    }

    renderListView();

    // If graph was visible, re-render it
    if (currentView === 'graph' && graphView) {
      renderGraph();
    }
  } catch (error) {
    const errorHtml = `
      <div class="gv-empty">
        <p>Failed to load graph data</p>
        <p class="gv-empty-hint">${escapeHtml(error.message)}</p>
        <button onclick="initGraph()" class="btn btn--ghost" style="margin-top: var(--sp-3)">Retry</button>
      </div>`;
    if (listView) listView.innerHTML = errorHtml;
  }
}

// ─── Connection Counts ────────────────────────────────────────────────────────

function buildConnectionCounts() {
  connectionCounts = new Map();
  for (const node of graphData.nodes) {
    connectionCounts.set(node.id, 0);
  }
  for (const edge of graphData.edges) {
    connectionCounts.set(edge.fromId, (connectionCounts.get(edge.fromId) || 0) + 1);
    connectionCounts.set(edge.toId, (connectionCounts.get(edge.toId) || 0) + 1);
  }
}

// ─── Filtering ────────────────────────────────────────────────────────────────

function getFilteredNodes() {
  const searchEl = document.getElementById('graph-search');
  const filterEl = document.getElementById('graph-filter-type');
  const query = searchEl ? searchEl.value.toLowerCase().trim() : '';
  const typeFilter = filterEl ? filterEl.value : '';

  filteredNodes = graphData.nodes.filter(n => {
    if (typeFilter && n.type !== typeFilter) return false;
    if (query && !n.label.toLowerCase().includes(query) &&
        !(n.description && n.description.toLowerCase().includes(query))) return false;
    return true;
  });

  // Sort by label
  filteredNodes.sort((a, b) => a.label.localeCompare(b.label));
  return filteredNodes;
}

// ─── List View ────────────────────────────────────────────────────────────────

function renderListView() {
  const container = document.getElementById('gv-list-view');
  if (!container) return;

  if (filteredNodes.length === 0) {
    container.innerHTML = `
      <div class="gv-empty">
        <p>No matching nodes</p>
        <p class="gv-empty-hint">Try adjusting your search or filter</p>
      </div>`;
    return;
  }

  container.innerHTML = filteredNodes.map(renderNodeCard).join('');
}

// ─── Card Rendering ───────────────────────────────────────────────────────────

// Flex containers drop whitespace-only text nodes, so badge + label + conn
// count would be announced as one run ("Selfme2 conns"). A real character in
// an sr-only span restores the boundaries.
const SPEECH_SEP = '<span class="sr-only">, </span>';

function renderNodeCard(node) {
  if (node.id === expandedNodeId) return renderNodeDetail(node);
  const config = getNodeTypeConfig();
  const typeInfo = config[node.type] || config.default;
  const conns = connectionCounts.get(node.id) || 0;
  const detailId = nodeDetailId(node.id);

  return `<div class="gv-card" data-node-id="${escapeHtml(node.id)}">
    <button type="button" class="gv-card-header" aria-expanded="false" aria-controls="${detailId}" onclick="toggleNodeCard('${escapeHtml(node.id)}')">
      <span class="gv-badge" style="background:${hslColor(typeInfo.hue, 55, 35)};color:${hslColor(typeInfo.hue, 55, 70)}">${escapeHtml(typeInfo.label)}</span>
      <span class="gv-card-label">${SPEECH_SEP}${escapeHtml(node.label)}</span>
      <span class="gv-card-conns">${conns > 0 ? SPEECH_SEP + conns + ' conn' + (conns > 1 ? 's' : '') : ''}</span>
    </button>
    <div class="gv-card-detail" id="${detailId}" hidden></div>
  </div>`;
}

function renderNodeDetail(node) {
  const config = getNodeTypeConfig();
  const typeInfo = config[node.type] || config.default;
  const conns = connectionCounts.get(node.id) || 0;
  const detailId = nodeDetailId(node.id);

  const edges = graphData.edges.filter(e => e.fromId === node.id || e.toId === node.id);
  const connHtml = edges.map(edge => {
    const isFrom = edge.fromId === node.id;
    const otherId = isFrom ? edge.toId : edge.fromId;
    const otherNode = graphData.nodes.find(n => n.id === otherId);
    const dir = isFrom ? '&rarr;' : '&larr;';
    return `<li><span class="gv-conn-dir">${dir}</span> <span class="gv-conn-type">${escapeHtml(edge.customType || edge.type)}</span> <span class="gv-conn-label">${escapeHtml(otherNode?.label || '?')}</span></li>`;
  }).join('');

  return `<div class="gv-card gv-card--expanded" data-node-id="${escapeHtml(node.id)}">
    <button type="button" class="gv-card-header" aria-expanded="true" aria-controls="${detailId}" onclick="toggleNodeCard('${escapeHtml(node.id)}')">
      <span class="gv-badge" style="background:${hslColor(typeInfo.hue, 55, 35)};color:${hslColor(typeInfo.hue, 55, 70)}">${escapeHtml(typeInfo.label)}</span>
      <span class="gv-card-label">${SPEECH_SEP}${escapeHtml(node.label)}</span>
      <span class="gv-card-conns">${SPEECH_SEP}${conns} conn${conns !== 1 ? 's' : ''}</span>
    </button>
    <div class="gv-card-detail" id="${detailId}">
      ${node.description ? `<div class="gv-card-desc">${escapeHtml(node.description)}</div>` : ''}
      ${connHtml ? `
        <div class="gv-card-section">
          <div class="gv-detail-label">Connections (${edges.length})</div>
          <ul class="gv-conn-list">${connHtml}</ul>
        </div>` : ''}
      <div class="gv-card-actions">
        <button class="btn btn--ghost btn--sm" onclick="event.stopPropagation(); openEdgeModalFromNode('${escapeHtml(node.id)}')">Connect</button>
        <button class="btn btn--ghost btn--sm" onclick="event.stopPropagation(); openEditModal('${escapeHtml(node.id)}')">Edit</button>
        <button class="btn btn--ghost btn--sm gv-action-danger" onclick="event.stopPropagation(); renderDeleteConfirmModal('${escapeHtml(node.id)}')">Delete</button>
      </div>
    </div>
  </div>`;
}

function nodeDetailId(nodeId) {
  return `gv-node-detail-${encodeURIComponent(nodeId)}`;
}

function focusNodeHeader(nodeId) {
  const container = document.getElementById('gv-list-view');
  if (!container) return;
  const header = [...container.querySelectorAll('.gv-card-header')]
    .find(button => button.closest('.gv-card')?.dataset.nodeId === nodeId);
  if (header) header.focus({ preventScroll: true });
  else document.getElementById('graph-search')?.focus();
}

function toggleNodeCard(nodeId) {
  expandedNodeId = expandedNodeId === nodeId ? null : nodeId;
  renderListView();
  focusNodeHeader(nodeId);
}

// ─── View Toggle ──────────────────────────────────────────────────────────────

async function toggleView(view) {
  if (view === currentView) return;
  currentView = view;

  const listView = document.getElementById('gv-list-view');
  const graphView = document.getElementById('gv-graph-view');
  const toggle = document.getElementById('gv-view-toggle');

  // Update toggle buttons
  if (toggle) {
    toggle.querySelectorAll('.gv-view-toggle-btn').forEach(btn => {
      const active = btn.dataset.view === view;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  if (view === 'list') {
    if (graphView) graphView.classList.add('gv-hidden');
    if (listView) listView.classList.remove('gv-hidden');
    renderListView();
  } else {
    if (listView) listView.classList.add('gv-hidden');
    if (graphView) graphView.classList.remove('gv-hidden');

    // Lazy-load vis-network on first toggle
    if (!network && typeof vis === 'undefined') {
      const container = document.getElementById('graph-container');
      if (container) {
        container.innerHTML = '<div class="gv-loading"><div class="gv-spinner"></div></div>';
      }
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://unpkg.com/vis-network/standalone/umd/vis-network.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
    }

    renderGraph();
  }
}

// ─── Graph Rendering (vis-network) ───────────────────────────────────────────

function renderGraph() {
  if (typeof vis === 'undefined') return;
  const container = document.getElementById('graph-container');
  if (!container) return;
  container.innerHTML = '';

  const nodes = new vis.DataSet(
    graphData.nodes.map(node => {
      const colors = getNodeColor(node.type);
      return {
        id: node.id,
        label: node.label.length > 20 ? node.label.substring(0, 17) + '...' : node.label,
        title: `${node.type}: ${node.label}\n${node.description || ''}`,
        color: colors,
        borderWidth: 2,
        borderWidthSelected: 3,
        font: { color: '#e8e8e8', size: 13, face: 'IBM Plex Sans, Inter, sans-serif' },
        shadow: { enabled: true, color: 'rgba(0,0,0,0.5)', size: 8, x: 0, y: 2 },
        data: node
      };
    })
  );

  const edges = new vis.DataSet(
    graphData.edges.map(edge => {
      const colors = getEdgeColor(edge.type);
      return {
        id: edge.id,
        from: edge.fromId,
        to: edge.toId,
        label: edge.customType || edge.type,
        title: edge.type,
        color: colors,
        width: 1 + (edge.weight || 0.5) * 1.5,
        font: { size: 9, color: 'rgba(232,232,232,0.5)', strokeWidth: 0, face: 'IBM Plex Mono, monospace' },
        smooth: { type: 'curvedCW', roundness: 0.15 },
        data: edge
      };
    })
  );

  const options = {
    physics: {
      enabled: true,
      barnesHut: {
        gravitationalConstant: -2500,
        centralGravity: 0.25,
        springLength: 160,
        springConstant: 0.04,
        damping: 0.12
      },
      stabilization: { iterations: 150, fit: true }
    },
    interaction: {
      hover: true,
      tooltipDelay: 300,
      zoomView: true,
      dragView: true,
      multiselect: true,
      navigationButtons: false,
      keyboard: {
        enabled: true,
        bindToWindow: false,
        autoFocus: false
      }
    },
    nodes: { shape: 'dot', size: 18, scaling: { min: 12, max: 28 } },
    edges: { arrows: { to: { enabled: true, scaleFactor: 0.6 } }, smooth: { enabled: true, type: 'continuous' } }
  };

  network = new vis.Network(container, { nodes, edges }, options);
  const surface = container.querySelector('.vis-network');
  if (surface) {
    surface.setAttribute('role', 'group');
    surface.setAttribute('aria-label', 'Knowledge graph network');
    surface.setAttribute('aria-describedby', 'graph-network-help');
  }
  network.on('click', handleNetworkClick);
  network.on('doubleClick', handleNetworkDoubleClick);
  network.on('stabilizationIterationsDone', () => {
    network.setOptions({ physics: { enabled: false } });
    network.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
  });
}

function handleNetworkClick(params) {
  if (params.nodes && params.nodes.length === 1) {
    showNodePanel(params.nodes[0]);
  } else {
    hideNodePanel();
  }
}

function handleNetworkDoubleClick(params) {
  if (params.nodes && params.nodes.length === 1) {
    network.focus(params.nodes[0], { animation: true, scale: 1.5 });
  }
}

// ─── Node Panel (graph view) ─────────────────────────────────────────────────

function showNodePanel(nodeId) {
  const node = graphData.nodes.find(n => n.id === nodeId);
  if (!node) return;

  const panel = document.getElementById('graph-node-panel');
  const label = document.getElementById('panel-node-label');
  const content = document.getElementById('panel-content');
  if (!panel || !label || !content) return;

  const connectedEdges = graphData.edges.filter(e => e.fromId === nodeId || e.toId === nodeId);
  const typeConfig = getNodeTypeConfig();
  const typeInfo = typeConfig[node.type] || typeConfig.default;
  const typeColor = hslColor(typeInfo.hue, 55, 50);

  const connections = connectedEdges.map(edge => {
    const isFrom = edge.fromId === nodeId;
    const otherNodeId = isFrom ? edge.toId : edge.fromId;
    const otherNode = graphData.nodes.find(n => n.id === otherNodeId);
    const dir = isFrom ? '&rarr;' : '&larr;';
    return `<li><span class="gv-conn-dir">${dir}</span> <span class="gv-conn-type">${escapeHtml(edge.customType || edge.type)}</span> <span class="gv-conn-label">${escapeHtml(otherNode?.label || '?')}</span></li>`;
  }).join('');

  label.textContent = node.label;
  content.innerHTML = `
    <div class="gv-detail-row">
      <span class="gv-detail-label">Type</span>
      <span class="gv-detail-value" style="color: ${typeColor}">${escapeHtml(node.type)}</span>
    </div>
    ${node.description ? `
      <div class="gv-detail-section">
        <div class="gv-detail-label">Description</div>
        <p class="gv-detail-desc">${escapeHtml(node.description)}</p>
      </div>` : ''}
    ${connections ? `
      <div class="gv-detail-section">
        <div class="gv-detail-label">Connections (${connectedEdges.length})</div>
        <ul class="gv-conn-list">${connections}</ul>
      </div>` : ''}
    <div class="gv-detail-section">
      <div class="gv-detail-label">ID</div>
      <code class="gv-node-id">${escapeHtml(node.id)}</code>
    </div>
    <div class="gv-panel-actions">
      <button class="btn btn--ghost gv-edit-btn" onclick="openEdgeModalFromNode('${escapeHtml(node.id)}')">Connect</button>
      <button class="btn btn--ghost gv-edit-btn" onclick="openEditModal('${escapeHtml(node.id)}')">Edit</button>
      <button class="btn btn--ghost gv-edit-btn gv-action-danger" onclick="renderDeleteConfirmModal('${escapeHtml(node.id)}')">Delete</button>
    </div>`;

  panel.classList.add('gv-panel-open');
  // A closed panel is translated off-canvas but still in the DOM, so without
  // this its buttons stay tabbable (audit: off-canvas but focusable).
  panel.inert = false;
}

function hideNodePanel() {
  const panel = document.getElementById('graph-node-panel');
  panel?.classList.remove('gv-panel-open');
  if (panel) panel.inert = true;
}

// ─── Type Filter ──────────────────────────────────────────────────────────────

function populateTypeFilter() {
  const select = document.getElementById('graph-filter-type');
  if (!select) return;
  while (select.options.length > 1) select.remove(1);
  const types = [...new Set(graphData.nodes.map(n => n.type))].sort();
  const config = getNodeTypeConfig();
  types.forEach(type => {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = config[type]?.label || type;
    select.appendChild(option);
  });
}

// ─── Edge Modal ──────────────────────────────────────────────────────────────

function openEdgeModal(fromId, toId) {
  const modal = document.getElementById('graph-edge-modal');
  if (!modal) return;

  const fromPicker = document.getElementById('edge-from-picker');
  const toPicker = document.getElementById('edge-to-picker');
  const fromHidden = document.getElementById('edge-from');
  const toHidden = document.getElementById('edge-to');
  const fromInput = fromPicker?.querySelector('.gv-node-search-input');
  const toInput = toPicker?.querySelector('.gv-node-search-input');

  // Reset
  fromHidden.value = '';
  toHidden.value = '';
  if (fromInput) { fromInput.value = ''; fromInput.dataset.nodeId = ''; }
  if (toInput) { toInput.value = ''; toInput.dataset.nodeId = ''; }
  if (fromPicker) fromPicker.querySelector('.gv-node-search-results').innerHTML = '';
  if (toPicker) toPicker.querySelector('.gv-node-search-results').innerHTML = '';

  // Pre-fill from node
  if (fromId) {
    const fromNode = graphData.nodes.find(n => n.id === fromId);
    if (fromNode && fromInput) {
      fromInput.value = fromNode.label;
      fromInput.dataset.nodeId = fromNode.id;
      fromHidden.value = fromNode.id;
    }
  }

  modal.classList.add('gv-modal-open');
}

function openEdgeModalFromNode(nodeId) {
  openEdgeModal(nodeId, '');
}

function setupEdgeModalListeners(opts) {
  const modal = document.getElementById('graph-edge-modal');
  const form = document.getElementById('edge-create-form');
  const cancelBtn = document.getElementById('cancel-edge');

  cancelBtn?.addEventListener('click', () => modal?.classList.remove('gv-modal-open'), opts);
  modal?.addEventListener('click', (e) => {
    if (e.target.id === 'graph-edge-modal') modal.classList.remove('gv-modal-open');
  }, opts);

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fromId = document.getElementById('edge-from').value;
    const toId = document.getElementById('edge-to').value;
    const type = document.getElementById('edge-type').value;
    const evidence = document.getElementById('edge-evidence').value;

    if (!fromId || !toId || !type) return;
    if (fromId === toId) { showToast('Cannot connect a node to itself'); return; }

    try {
      const body = { fromId, toId, type };
      if (evidence) body.evidence = evidence;
      const response = await fetch('/api/graph/edges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const result = await response.json();
      if (result.success) {
        modal.classList.remove('gv-modal-open');
        form.reset();
        showToast('Connection created');
        await loadGraphData();
        focusNodeHeader(fromId);
      } else {
        showToast('Failed: ' + (result.error || 'unknown error'));
      }
    } catch (error) {
      showToast('Error: ' + error.message);
    }
  }, opts);
}

// ─── Searchable Node Picker ────────────────────────────────────────────────

function setupNodePickers(opts) {
  document.querySelectorAll('.gv-node-picker').forEach(picker => {
    const input = picker.querySelector('.gv-node-search-input');
    const results = picker.querySelector('.gv-node-search-results');
    const hidden = picker.querySelector('input[type="hidden"]');
    if (!input || !results || !hidden) return;

    input.addEventListener('input', () => {
      const query = input.value.toLowerCase().trim();
      if (query.length === 0) {
        results.innerHTML = '';
        results.classList.remove('gv-node-search-results--open');
        return;
      }
      const matches = graphData.nodes.filter(n =>
        n.label.toLowerCase().includes(query) || n.type.toLowerCase().includes(query)
      ).slice(0, 20);

      if (matches.length === 0) {
        results.innerHTML = '<div class="gv-node-search-empty">No matches</div>';
        results.classList.add('gv-node-search-results--open');
        return;
      }

      results.innerHTML = matches.map(n => {
        const config = getNodeTypeConfig();
        const info = config[n.type] || config.default;
        return `<div class="gv-node-search-item" data-node-id="${escapeHtml(n.id)}">
          <span class="gv-badge" style="background:${hslColor(info.hue, 55, 35)};color:${hslColor(info.hue, 55, 70)}">${escapeHtml(info.label)}</span>
          <span class="gv-node-search-label">${escapeHtml(n.label)}</span>
        </div>`;
      }).join('');
      results.classList.add('gv-node-search-results--open');
    }, opts);

    input.addEventListener('focus', () => {
      if (input.value.length > 0) input.dispatchEvent(new Event('input'));
    }, opts);

    results.addEventListener('click', (e) => {
      const item = e.target.closest('.gv-node-search-item');
      if (!item) return;
      const nodeId = item.dataset.nodeId;
      const node = graphData.nodes.find(n => n.id === nodeId);
      if (!node) return;
      input.value = node.label;
      input.dataset.nodeId = node.id;
      hidden.value = node.id;
      results.innerHTML = '';
      results.classList.remove('gv-node-search-results--open');
    }, opts);

    // Clear hidden when user edits text after selecting
    input.addEventListener('input', () => {
      if (input.dataset.nodeId && input.value !== graphData.nodes.find(n => n.id === input.dataset.nodeId)?.label) {
        input.dataset.nodeId = '';
        hidden.value = '';
      }
    }, opts);
  });

  // Close pickers on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.gv-node-picker')) {
      document.querySelectorAll('.gv-node-search-results--open').forEach(r => {
        r.classList.remove('gv-node-search-results--open');
      });
    }
  }, opts);
}

// ─── Edit Connections ───────────────────────────────────────────────────────

function renderEditConnections(nodeId) {
  const field = document.getElementById('edit-connections-field');
  const list = document.getElementById('edit-connections-list');
  if (!field || !list) return;

  const edges = graphData.edges.filter(e => e.fromId === nodeId || e.toId === nodeId);
  if (edges.length === 0) {
    field.style.display = 'none';
    return;
  }

  field.style.display = '';
  list.innerHTML = edges.map(edge => {
    const isFrom = edge.fromId === nodeId;
    const otherId = isFrom ? edge.toId : edge.fromId;
    const otherNode = graphData.nodes.find(n => n.id === otherId);
    const dir = isFrom ? '&rarr;' : '&larr;';
    return `<div class="gv-edit-conn-row" data-edge-id="${escapeHtml(edge.id)}">
      <span class="gv-edit-conn-info">
        <span class="gv-conn-dir">${dir}</span>
        <span class="gv-conn-type">${escapeHtml(edge.customType || edge.type)}</span>
        <span class="gv-conn-label">${escapeHtml(otherNode?.label || '?')}</span>
      </span>
      <button class="btn btn--ghost btn--sm gv-edit-conn-del" data-edge-id="${escapeHtml(edge.id)}" title="Remove">&times;</button>
    </div>`;
  }).join('');

  // Wire delete buttons
  list.querySelectorAll('.gv-edit-conn-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const edgeId = btn.dataset.edgeId;
      btn.disabled = true;
      try {
        const response = await fetch(`/api/graph/edges/${edgeId}`, { method: 'DELETE' });
        const result = await response.json();
        if (result.success) {
          btn.closest('.gv-edit-conn-row').remove();
          const remaining = list.querySelectorAll('.gv-edit-conn-row');
          if (remaining.length === 0) field.style.display = 'none';
          showToast('Connection removed');
          // Also refresh the main data
          buildConnectionCounts();
        } else {
          showToast('Failed: ' + (result.error || 'unknown error'));
          btn.disabled = false;
        }
      } catch (err) {
        showToast('Error: ' + err.message);
        btn.disabled = false;
      }
    });
  });
}

// ─── Delete Confirmation Modal ────────────────────────────────────────────────

function renderDeleteConfirmModal(nodeId) {
  const node = graphData.nodes.find(n => n.id === nodeId);
  if (!node) return;
  deleteTargetNodeId = nodeId;

  const msg = document.getElementById('delete-confirm-msg');
  const modal = document.getElementById('graph-delete-modal');
  if (msg) msg.textContent = `Delete "${node.label}"? This will also remove all its connections.`;
  if (modal) modal.classList.add('gv-modal-open');
}

function setupDeleteModalListeners(opts) {
  const modal = document.getElementById('graph-delete-modal');
  const cancelBtn = document.getElementById('cancel-delete');
  const confirmBtn = document.getElementById('confirm-delete');

  cancelBtn?.addEventListener('click', () => {
    modal?.classList.remove('gv-modal-open');
    deleteTargetNodeId = null;
  }, opts);
  modal?.addEventListener('click', (e) => {
    if (e.target.id === 'graph-delete-modal') {
      modal.classList.remove('gv-modal-open');
      deleteTargetNodeId = null;
    }
  }, opts);
  confirmBtn?.addEventListener('click', async () => {
    if (!deleteTargetNodeId) return;
    const nodeId = deleteTargetNodeId;
    modal?.classList.remove('gv-modal-open');
    deleteTargetNodeId = null;

    try {
      const response = await fetch(`/api/graph/nodes/${nodeId}`, { method: 'DELETE' });
      const result = await response.json();
      if (result.success) {
        hideNodePanel();
        expandedNodeId = null;
        showToast('Node deleted');
        await loadGraphData();
        // loadGraphData() re-renders the list, which takes the card and its
        // Delete button with it, so the focus the dialog observer restored is
        // gone by now. Hand it to a control that outlives the re-render.
        document.getElementById('gv-add-node')?.focus();
      } else {
        showToast('Failed: ' + (result.error || 'unknown error'));
      }
    } catch (err) {
      showToast('Delete failed: ' + err.message);
    }
  }, opts);
}

// ─── Edit Modal ──────────────────────────────────────────────────────────────

function openEditModal(nodeId) {
  const node = graphData.nodes.find(n => n.id === nodeId);
  if (!node) return;
  const modal = document.getElementById('graph-edit-modal');
  if (!modal) return;
  document.getElementById('edit-node-id').value = node.id;
  document.getElementById('edit-node-type').value = node.type;
  document.getElementById('edit-node-label').value = node.label;
  document.getElementById('edit-node-description').value = node.description || '';
  renderEditConnections(node.id);
  modal.classList.add('gv-modal-open');
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

let searchDebounce = null;

function setupEventListeners() {
  // Tear down any previously attached listeners
  if (eventListenersAbort) eventListenersAbort.abort();
  eventListenersAbort = new AbortController();
  const opts = { signal: eventListenersAbort.signal };

  // View toggle
  document.getElementById('gv-view-toggle')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.gv-view-toggle-btn');
    if (btn) toggleView(btn.dataset.view);
  }, opts);

  // Search — debounced, filters list view
  document.getElementById('graph-search')?.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      getFilteredNodes();
      if (currentView === 'list') renderListView();
      else if (network) {
        const query = document.getElementById('graph-search').value.toLowerCase().trim();
        if (!query) { network.selectNodes([]); return; }
        const matches = filteredNodes.map(n => n.id);
        if (matches.length > 0) {
          network.selectNodes(matches);
          network.focus(matches[0], { animation: true, scale: 1.2 });
        }
      }
    }, 200);
  }, opts);

  // Type filter
  document.getElementById('graph-filter-type')?.addEventListener('change', () => {
    getFilteredNodes();
    if (currentView === 'list') renderListView();
    else if (network) {
      const type = document.getElementById('graph-filter-type').value;
      if (!type) { network.selectNodes([]); return; }
      const ids = graphData.nodes.filter(n => n.type === type).map(n => n.id);
      network.selectNodes(ids);
      if (ids.length > 0) network.focus(ids[0], { animation: true });
    }
  }, opts);

  // Node limit — persist and reload with the new bound
  document.getElementById('graph-node-limit')?.addEventListener('change', () => {
    const limit = getNodeLimit();
    const el = document.getElementById('graph-node-limit');
    if (el) el.value = String(limit);
    localStorage.setItem(NODE_LIMIT_STORAGE_KEY, String(limit));
    loadGraphData({ announce: true });
  }, opts);

  // Refresh
  document.getElementById('graph-refresh')?.addEventListener('click', () => loadGraphData({ announce: true }), opts);

  // Add node button
  document.getElementById('gv-add-node')?.addEventListener('click', () => {
    document.getElementById('graph-create-modal')?.classList.add('gv-modal-open');
  }, opts);

  // Close panel (graph view)
  document.getElementById('panel-close')?.addEventListener('click', hideNodePanel, opts);

  // ─── Create Modal ──────────────────────────────────────────────────────
  document.getElementById('cancel-create')?.addEventListener('click', () => {
    document.getElementById('graph-create-modal')?.classList.remove('gv-modal-open');
  }, opts);
  document.getElementById('graph-create-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'graph-create-modal') e.target.classList.remove('gv-modal-open');
  }, opts);

  document.getElementById('create-node-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = {
      type: form.type.value,
      label: form.label.value,
      description: form.description.value,
    };
    if (!data.label.trim()) {
      showToast('Label is required');
      form.label.focus();
      return;
    }
    try {
      const response = await fetch('/api/graph/nodes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const result = await response.json();
      if (result.success) {
        document.getElementById('graph-create-modal').classList.remove('gv-modal-open');
        form.reset();
        showToast('Node created');
        await loadGraphData();
      } else {
        showToast('Failed to create node: ' + result.error);
      }
    } catch (error) {
      showToast('Error: ' + error.message);
    }
  }, opts);

  // ─── Edit Modal ────────────────────────────────────────────────────────
  document.getElementById('cancel-edit')?.addEventListener('click', () => {
    document.getElementById('graph-edit-modal')?.classList.remove('gv-modal-open');
  }, opts);
  document.getElementById('graph-edit-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'graph-edit-modal') e.target.classList.remove('gv-modal-open');
  }, opts);
  document.getElementById('edit-add-conn')?.addEventListener('click', () => {
    const nodeId = document.getElementById('edit-node-id').value;
    if (nodeId) openEdgeModal(nodeId, '');
  }, opts);

  document.getElementById('edit-node-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nodeId = document.getElementById('edit-node-id').value;
    const data = {
      type: document.getElementById('edit-node-type').value,
      label: document.getElementById('edit-node-label').value,
      description: document.getElementById('edit-node-description').value,
    };
    if (!data.label.trim()) {
      showToast('Label is required');
      document.getElementById('edit-node-label').focus();
      return;
    }
    try {
      const response = await fetch(`/api/graph/nodes/${nodeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const result = await response.json();
      if (result.success) {
        document.getElementById('graph-edit-modal').classList.remove('gv-modal-open');
        showToast('Node updated');
        await loadGraphData();
        focusNodeHeader(nodeId);
      } else {
        showToast('Failed to update node: ' + result.error);
      }
    } catch (error) {
      showToast('Error: ' + error.message);
    }
  }, opts);

  // ─── Edge Modal ────────────────────────────────────────────────────────
  setupEdgeModalListeners(opts);
  setupNodePickers(opts);

  // ─── Delete Modal ──────────────────────────────────────────────────────
  setupDeleteModalListeners(opts);
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(msg) {
  let container = document.getElementById('gv-toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'gv-toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'gv-toast';
  // role=status is the whole reason the message is announced at all, and a
  // region that arrives already populated is not announced either, so it goes
  // in empty and is filled on the next tick - the same
  // contract as the app's toast in psycheros.js. This is a separate function
  // from that one because the graph panel is also rendered in the launcher,
  // where the app toast does not exist.
  toast.setAttribute('role', 'status');
  container.appendChild(toast);
  setTimeout(() => {
    toast.textContent = msg;
  }, 50);
  requestAnimationFrame(() => toast.classList.add('gv-toast-visible'));
  setTimeout(() => {
    toast.classList.remove('gv-toast-visible');
    setTimeout(() => toast.remove(), 200);
  }, 4000);
}

// ─── HTML Escaping ────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (typeof str !== 'string') str = String(str);
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

// ─── Global Exports ───────────────────────────────────────────────────────────

globalThis.initGraph = initGraph;
globalThis.openEditModal = openEditModal;
globalThis.toggleNodeCard = toggleNodeCard;
globalThis.openEdgeModal = openEdgeModal;
globalThis.openEdgeModalFromNode = openEdgeModalFromNode;
globalThis.renderDeleteConfirmModal = renderDeleteConfirmModal;
// showToast deliberately stays local: assigning it here shadowed the app's
// role=status toast in psycheros.js for every other caller on the page
// (reindex-banner.js and the discord inline handler go through the global).
