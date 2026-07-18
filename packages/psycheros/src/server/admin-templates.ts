/**
 * Admin Panel Templates
 *
 * HTML rendering functions for the admin/debug panel.
 * Returns server-rendered HTML fragments for HTMX swap.
 *
 * @module
 */

import type { LogEntry } from "./logger.ts";
import type { DiagnosticsSnapshot } from "./diagnostics.ts";
import type { Scheduler } from "../scheduler/mod.ts";
import { escapeHtml } from "./templates.ts";

/**
 * UI-facing view-model for the admin scheduled-jobs table. Materialized
 * from the scheduler's `schedules` + per-handler stats so the existing
 * HTMX surface stays unchanged.
 */
export interface AdminScheduledJob {
  id: string;
  name: string;
  schedule: string;
  description: string;
  status: "idle" | "running" | "success" | "error" | "dead" | "skipped";
  lastRunAt: string | null;
  lastCompletedAt: string | null;
  lastDurationMs: number | null;
  lastResult: string | null;
  lastError: string | null;
  successCount: number;
  errorCount: number;
  manualTrigger: boolean;
}

/**
 * Build the admin-jobs view model from the scheduler. Each schedule maps
 * to one row; per-handler run stats come from `job_runs`. Pulse schedules
 * (id starting with `pulse-`) are excluded — those have their own UI in
 * the Pulse settings tab.
 */
export function buildAdminJobsViewModel(
  scheduler: Scheduler,
): AdminScheduledJob[] {
  const schedules = scheduler.listSchedules()
    .filter((s) => !s.id.startsWith("pulse-"));
  return schedules.map((schedule) => {
    const stats = scheduler.getHandlerStats(schedule.handler);
    const meta = schedule.metadata as Record<string, unknown>;
    const name = typeof meta.name === "string" ? meta.name : schedule.id;
    const description = typeof meta.description === "string"
      ? meta.description
      : "";
    const manualTrigger = meta.manualTrigger === true;
    const cadence = schedule.cronExpr ??
      (schedule.intervalSeconds ? `every ${schedule.intervalSeconds}s` : "");

    let status: AdminScheduledJob["status"] = "idle";
    if (stats.lastStatus && stats.lastStatus !== "pending") {
      status = stats.lastStatus;
    }

    return {
      id: schedule.id,
      name,
      schedule: cadence,
      description,
      status,
      lastRunAt: stats.lastRunAt,
      lastCompletedAt: stats.lastCompletedAt,
      lastDurationMs: stats.lastDurationMs,
      lastResult: stats.lastResult,
      lastError: stats.lastError,
      successCount: stats.successCount,
      errorCount: stats.errorCount,
      manualTrigger,
    };
  });
}

/**
 * Render the admin hub — top-level view with sub-navigation cards.
 */
export function renderAdminHub(): string {
  return `<div class="settings-view">
  <script src="/js/admin.js"></script>
  <div class="settings-header">
    <div class="settings-header-row">
      <a class="settings-back-btn"
        hx-get="/fragments/settings"
        hx-target="#chat"
        hx-swap="innerHTML">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15 18 9 12 15 6"/>
        </svg>
        <span>Settings</span>
      </a>
      <div>
        <h1 class="settings-title">System Admin</h1>
        <p class="settings-desc">System health monitoring, logs, and diagnostics</p>
      </div>
    </div>
  </div>
  <div class="settings-content" id="settings-content">
    <div class="admin-nav">
      <button class="admin-nav-tab active"
        hx-get="/fragments/admin/diagnostics"
        hx-target="#admin-content"
        hx-swap="innerHTML"
        onclick="document.querySelectorAll('.admin-nav-tab').forEach(t => t.classList.remove('active')); this.classList.add('active')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="20" x2="18" y2="10"/>
          <line x1="12" y1="20" x2="12" y2="4"/>
          <line x1="6" y1="20" x2="6" y2="14"/>
          <line x1="2" y1="20" x2="22" y2="20"/>
        </svg>
        Diagnostics
      </button>
      <button class="admin-nav-tab"
        hx-get="/fragments/admin/jobs"
        hx-target="#admin-content"
        hx-swap="innerHTML"
        onclick="document.querySelectorAll('.admin-nav-tab').forEach(t => t.classList.remove('active')); this.classList.add('active')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        Scheduled Jobs
      </button>
      <button class="admin-nav-tab"
        hx-get="/fragments/admin/logs"
        hx-target="#admin-content"
        hx-swap="innerHTML"
        onclick="document.querySelectorAll('.admin-nav-tab').forEach(t => t.classList.remove('active')); this.classList.add('active')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
        Logs
      </button>
      <button class="admin-nav-tab"
        hx-get="/fragments/admin/actions"
        hx-target="#admin-content"
        hx-swap="innerHTML"
        onclick="document.querySelectorAll('.admin-nav-tab').forEach(t => t.classList.remove('active')); this.classList.add('active')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>
        Actions
      </button>
      <button class="admin-nav-tab"
        hx-get="/fragments/admin/entity-data"
        hx-target="#admin-content"
        hx-swap="innerHTML"
        onclick="document.querySelectorAll('.admin-nav-tab').forEach(t => t.classList.remove('active')); this.classList.add('active')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Entity Data
      </button>
    </div>
    <div id="admin-content">
      <div hx-get="/fragments/admin/diagnostics" hx-trigger="load" hx-swap="outerHTML"></div>
    </div>
  </div>
</div>`;
}

/**
 * Format bytes into a human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Format seconds into a human-readable uptime string.
 */
function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (parts.length === 0) parts.push(`${s}s`);
  return parts.join(" ");
}

/**
 * Render a status indicator dot.
 */
function statusDot(ok: boolean): string {
  return `<span class="admin-status-dot ${
    ok ? "admin-status-ok" : "admin-status-error"
  }"></span>`;
}

/**
 * Render the diagnostics dashboard.
 */
export function renderAdminDiagnostics(snapshot: DiagnosticsSnapshot): string {
  const dbSize = snapshot.database.dbSizeBytes !== null
    ? formatBytes(snapshot.database.dbSizeBytes)
    : "unknown";

  const graphInfo = snapshot.knowledgeGraph.stats
    ? `${snapshot.knowledgeGraph.stats.totalNodes} nodes, ${snapshot.knowledgeGraph.stats.totalEdges} edges`
    : "unavailable";

  const psycherosVersionCell = snapshot.versions.isStaging
    ? `${snapshot.versions.psycherosBase} <span class="admin-version-flavor">· staging</span>`
    : snapshot.versions.psycheros;
  const psycherosFullVersion = snapshot.versions.psycheros;

  return `<div class="admin-diagnostics">

  <div class="admin-section">
    <h3 class="admin-section-title">Versions</h3>
    <div class="admin-stats-grid">
      <div class="admin-stat">
        <span class="admin-stat-label">psycheros</span>
        <span class="admin-stat-value" title="${psycherosFullVersion}">${psycherosVersionCell}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">entity-core</span>
        <span class="admin-stat-value">${snapshot.versions.entityCore}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">sqlite-vec</span>
        <span class="admin-stat-value">${
    statusDot(snapshot.vector.available)
  } ${snapshot.vector.version ?? "not loaded"}</span>
      </div>
    </div>
  </div>

  <div class="admin-section">
    <h3 class="admin-section-title">Overview</h3>
    <div class="admin-stats-grid">
      <div class="admin-stat">
        <span class="admin-stat-label">Uptime</span>
        <span class="admin-stat-value">${formatUptime(snapshot.uptime)}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">SSE Clients</span>
        <span class="admin-stat-value">${snapshot.sse.connectedClients}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Database Size</span>
        <span class="admin-stat-value">${dbSize}</span>
      </div>
    </div>
  </div>

  <div class="admin-section">
    <h3 class="admin-section-title">Database</h3>
    <table class="admin-table">
      <thead><tr><th>Table</th><th>Rows</th></tr></thead>
      <tbody>
        <tr><td>conversations</td><td>${snapshot.database.conversations}</td></tr>
        <tr><td>messages</td><td>${snapshot.database.messages}</td></tr>
        <tr><td>lorebooks</td><td>${snapshot.database.lorebooks}</td></tr>
        <tr><td>lorebook_entries</td><td>${snapshot.database.lorebookEntries}</td></tr>
        <tr><td>memory_summaries</td><td>${snapshot.database.memorySummaries}</td></tr>
      </tbody>
    </table>
  </div>

  <div class="admin-section">
    <h3 class="admin-section-title">Vector System</h3>
    <table class="admin-table">
      <thead><tr><th>Table Pair</th><th>Main</th><th>Vec</th><th>Sync</th></tr></thead>
      <tbody>
        <tr>
          <td>message_embeddings / vec_messages</td>
          <td>${snapshot.vector.messageEmbeddings}</td>
          <td>${snapshot.vector.vecMessages}</td>
          <td>${statusDot(snapshot.vector.messageSyncOk)} ${
    snapshot.vector.messageSyncOk ? "OK" : "DESYNC"
  }</td>
        </tr>
        <tr>
          <td>memory_chunks / vec_memory_chunks</td>
          <td>${snapshot.vector.memoryChunks}</td>
          <td>${snapshot.vector.vecMemoryChunks}</td>
          <td>${statusDot(snapshot.vector.memorySyncOk)} ${
    snapshot.vector.memorySyncOk ? "OK" : "DESYNC"
  }</td>
        </tr>
      </tbody>
    </table>
  </div>

  <div class="admin-section">
    <h3 class="admin-section-title">RAG</h3>
    <div class="admin-stats-grid">
      <div class="admin-stat">
        <span class="admin-stat-label">Status</span>
        <span class="admin-stat-value">${statusDot(snapshot.rag.enabled)} ${
    snapshot.rag.enabled ? "enabled" : "disabled"
  }</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Indexed Files</span>
        <span class="admin-stat-value">${snapshot.rag.indexedFiles}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Chunks</span>
        <span class="admin-stat-value">${snapshot.rag.indexedChunks}</span>
      </div>
    </div>
  </div>

  <div class="admin-section">
    <h3 class="admin-section-title">Memory Consolidation</h3>
    <div class="admin-stats-grid">
      <div class="admin-stat">
        <span class="admin-stat-label">Status</span>
        <span class="admin-stat-value">${statusDot(snapshot.memory.enabled)} ${
    snapshot.memory.enabled ? "enabled" : "disabled"
  }</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Daily</span>
        <span class="admin-stat-value">${snapshot.memory.dailySummaries}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Weekly</span>
        <span class="admin-stat-value">${snapshot.memory.weeklySummaries}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Monthly</span>
        <span class="admin-stat-value">${snapshot.memory.monthlySummaries}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Yearly</span>
        <span class="admin-stat-value">${snapshot.memory.yearlySummaries}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Chats Summarized</span>
        <span class="admin-stat-value">${snapshot.memory.summarizedChats}</span>
      </div>
    </div>
  </div>

  <div class="admin-section">
    <h3 class="admin-section-title">MCP (entity-core)</h3>
    <div class="admin-stats-grid">
      <div class="admin-stat">
        <span class="admin-stat-label">Status</span>
        <span class="admin-stat-value">${statusDot(snapshot.mcp.connected)} ${
    snapshot.mcp.enabled
      ? (snapshot.mcp.connected ? "connected" : "disconnected")
      : "disabled"
  }</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Last Sync</span>
        <span class="admin-stat-value">${
    snapshot.mcp.lastSync ?? "never"
  }</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Pending Identity</span>
        <span class="admin-stat-value">${snapshot.mcp.pendingIdentity}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Pending Identity Changes</span>
        <span class="admin-stat-value">${snapshot.mcp.pendingIdentity}</span>
      </div>
    </div>
  </div>

  <div class="admin-section">
    <h3 class="admin-section-title">Knowledge Graph</h3>
    <div class="admin-stats-grid">
      <div class="admin-stat">
        <span class="admin-stat-label">Graph Data</span>
        <span class="admin-stat-value">${graphInfo}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Graph Vec Search</span>
        <span class="admin-stat-value">${
    statusDot(snapshot.knowledgeGraph.vectorSearchAvailable)
  } ${snapshot.knowledgeGraph.vectorSearchAvailable ? "active" : "off"}</span>
      </div>
      <div class="admin-stat">
        <span class="admin-stat-label">Write Tools</span>
        <span class="admin-stat-value">${
    statusDot(snapshot.knowledgeGraph.writeToolsEnabled)
  } ${snapshot.knowledgeGraph.writeToolsEnabled ? "enabled" : "disabled"}</span>
      </div>
    </div>${
    snapshot.knowledgeGraph.stats
      ? `
    <table class="admin-table">
      <thead><tr><th>Node Type</th><th>Count</th></tr></thead>
      <tbody>
        ${
        Object.entries(snapshot.knowledgeGraph.stats.nodesByType).map((
          [type, count],
        ) => `<tr><td>${type}</td><td>${count}</td></tr>`).join("")
      }
      </tbody>
    </table>`
      : ""
  }
  </div>

  <div class="admin-footer">
    <span class="admin-footer-ts">Last updated: <time class="admin-local-time" datetime="${snapshot.timestamp}">${snapshot.timestamp}</time></span>
    <button class="admin-refresh-btn"
      hx-get="/fragments/admin/diagnostics"
      hx-target="#admin-content"
      hx-swap="innerHTML">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="23 4 23 10 17 10"/>
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
      </svg>
      Refresh
    </button>
    <button class="admin-refresh-btn" onclick="window.adminCopyDiagnostics(this)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>
      Copy
    </button>
  </div>
</div>`;
}

/**
 * Render the log viewer fragment.
 * The shell includes filter controls; log data is loaded via HTMX from /api/admin/logs.
 */
export function renderAdminLogs(
  entries: LogEntry[],
  components: string[],
): string {
  const componentOptions = components
    .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)
    .join("");

  return `<div class="admin-logs">
  <div class="admin-log-controls">
    <select id="admin-log-level" class="admin-select"
      onchange="window.adminRefreshLogs()">
      <option value="">All Levels</option>
      <option value="error">Error</option>
      <option value="warn">Warning</option>
      <option value="info">Info</option>
    </select>
    <select id="admin-log-component" class="admin-select"
      onchange="window.adminRefreshLogs()">
      <option value="">All Components</option>
      ${componentOptions}
    </select>
    <select id="admin-log-limit" class="admin-select"
      onchange="window.adminRefreshLogs()">
      <option value="50">50 entries</option>
      <option value="100" selected>100 entries</option>
      <option value="250">250 entries</option>
      <option value="500">500 entries</option>
    </select>
    <button class="admin-refresh-btn" onclick="window.adminRefreshLogs()">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="23 4 23 10 17 10"/>
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
      </svg>
      Refresh
    </button>
    <button class="admin-refresh-btn" onclick="window.adminCopyLogs(this)">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
      </svg>
      Copy
    </button>
  </div>
  <div class="admin-log-list" id="admin-log-entries">
    ${renderLogEntries(entries)}
  </div>
</div>`;
}

/**
 * Render the scheduled jobs dashboard.
 */
export function renderAdminJobs(jobs: AdminScheduledJob[]): string {
  if (jobs.length === 0) {
    return `<div class="admin-jobs">
      <div class="admin-empty">No scheduled jobs registered. Memory system may be disabled.</div>
    </div>`;
  }

  return `<div class="admin-jobs">
  <div class="admin-section">
    <h3 class="admin-section-title">Scheduled Jobs</h3>
    <div class="admin-table-wrap">
      <table class="admin-table admin-jobs-table">
        <thead>
          <tr>
            <th>Job</th>
            <th>Schedule</th>
            <th>Status</th>
            <th>Last Run</th>
            <th>Duration</th>
            <th>OK / Err</th>
            <th>Last Result</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="admin-jobs-rows" hx-ext="morph">
          ${renderAdminJobRows(jobs)}
        </tbody>
      </table>
    </div>
  </div>

  <div class="admin-footer">
    <span class="admin-footer-ts">Execution history persisted across restarts</span>
    <button class="admin-refresh-btn"
      hx-get="/api/admin/jobs/rows"
      hx-target="#admin-jobs-rows"
      hx-swap="morph:innerHTML">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="23 4 23 10 17 10"/>
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
      </svg>
      Refresh
    </button>
  </div>
</div>`;
}

/**
 * Render just the scheduled jobs table rows (for HTMX partial swap).
 */
export function renderAdminJobRows(jobs: AdminScheduledJob[]): string {
  if (jobs.length === 0) {
    return `<tr><td colspan="8" class="admin-empty">No scheduled jobs registered.</td></tr>`;
  }

  return jobs.map((job) => {
    // `dead` shares the error styling — both are terminal failure states
    // from the user's point of view. `skipped` is a neutral outcome.
    const statusClass = job.status === "success"
      ? "admin-status-ok"
      : job.status === "error" || job.status === "dead"
      ? "admin-status-error"
      : job.status === "running"
      ? "admin-status-running"
      : "admin-status-idle";

    const statusLabel = job.status === "success"
      ? "OK"
      : job.status === "error"
      ? "Error"
      : job.status === "dead"
      ? "Failed"
      : job.status === "running"
      ? "Running"
      : job.status === "skipped"
      ? "Skipped"
      : "Idle";

    const lastRun = job.lastCompletedAt
      ? `<time class="admin-local-time" datetime="${job.lastCompletedAt}">${job.lastCompletedAt}</time>`
      : "Never";

    const duration = job.lastDurationMs !== null
      ? job.lastDurationMs < 1000
        ? `${job.lastDurationMs}ms`
        : `${(job.lastDurationMs / 1000).toFixed(1)}s`
      : "—";

    const resultText = job.lastError
      ? `<span class="admin-job-error">${escapeHtml(job.lastError)}</span>`
      : job.lastResult
      ? escapeHtml(job.lastResult)
      : "—";

    const triggerBtn = job.manualTrigger
      ? `<button class="admin-job-trigger-btn"
          hx-post="/api/admin/jobs/${escapeHtml(job.id)}/trigger"
          hx-target="#admin-jobs-rows"
          hx-swap="morph:innerHTML"
          ${job.status === "running" ? "disabled" : ""}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
          Run Now
        </button>`
      : "";

    return `<tr class="admin-job-row">
      <td>
        <div class="admin-job-name">${escapeHtml(job.name)}</div>
        <div class="admin-job-desc">${escapeHtml(job.description)}</div>
      </td>
      <td><code>${escapeHtml(job.schedule)}</code></td>
      <td><span class="admin-status-dot ${statusClass}"></span> ${statusLabel}</td>
      <td>${lastRun}</td>
      <td>${duration}</td>
      <td><span class="admin-job-count-ok">${job.successCount}</span> / <span class="admin-job-count-err">${job.errorCount}</span></td>
      <td>${resultText}</td>
      <td>${triggerBtn}</td>
    </tr>`;
  }).join("");
}

/**
 * Render log entries as HTML row divs.
 * Used both in initial render and HTMX partial updates.
 */
export function renderLogEntries(entries: LogEntry[]): string {
  if (entries.length === 0) {
    return `<div class="admin-empty">No log entries match the current filters.</div>`;
  }

  const rows = entries.map((entry) => {
    const levelClass = `admin-log-${entry.level}`;
    return `<div class="admin-log-row ${levelClass}">
      <span class="admin-log-time"><time class="admin-local-time" datetime="${entry.timestamp}">${entry.timestamp}</time></span>
      <span class="admin-log-level-badge">${entry.level.toUpperCase()}</span>
      <span class="admin-log-component">${escapeHtml(entry.component)}</span>
      <span class="admin-log-message">${escapeHtml(entry.message)}</span>
    </div>`;
  }).join("");

  return rows;
}

/**
 * Render the actions panel — manual operations like batch-populate-graph.
 */
export function renderAdminActions(): string {
  return `<div class="admin-actions">

  <div class="admin-section">
    <h3 class="admin-section-title">Batch Populate Knowledge Graph</h3>
    <p class="admin-action-desc">
      Runs <code>entity-core/scripts/batch-populate-graph.ts</code> to backfill
      the knowledge graph from existing memory files. Extracts entities and
      relationships via LLM, with semantic dedup to prevent duplicate nodes.
      Idempotent — semantic dedup prevents duplicate entities on re-runs.
    </p>
    <div class="admin-action-form">
      <div class="admin-action-fields">
        <label class="admin-action-label" for="admin-batch-days">Days</label>
        <input id="admin-batch-days" type="number" min="1" max="3650" value="30"
          class="admin-input" />
      </div>
      <div class="admin-action-fields">
        <label class="admin-action-label" for="admin-batch-granularity">Granularity</label>
        <select id="admin-batch-granularity" class="admin-select">
          <option value="daily" selected>daily</option>
          <option value="weekly">weekly</option>
          <option value="monthly">monthly</option>
          <option value="yearly">yearly</option>
          <option value="significant">significant</option>
          <option value="all">all</option>
        </select>
      </div>
      <div class="admin-action-fields">
        <label class="admin-action-label">
          <input id="admin-batch-dry-run" type="checkbox" class="admin-checkbox" />
          Dry run
        </label>
      </div>
      <div class="admin-action-fields">
        <label class="admin-action-label">
          <input id="admin-batch-verbose" type="checkbox" class="admin-checkbox" />
          Verbose
        </label>
      </div>
      <button id="admin-batch-run-btn" class="admin-action-btn" onclick="window.adminRunBatchPopulate()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
        Run Script
      </button>
    </div>
  </div>

  <div class="admin-section" id="admin-action-output-section" style="display:none">
    <h3 class="admin-section-title">Output</h3>
    <div class="admin-action-output" id="admin-action-output"></div>
  </div>

  <div class="admin-section">
    <h3 class="admin-section-title">Add Instance Suffix to Memory Files</h3>
    <p class="admin-action-desc">
      Retroactively appends the instance ID to memory filenames that lack one
      (e.g. <code>2026-04-01.md</code> becomes <code>2026-04-01_psycheros.md</code>).
      Handles both Psycheros and entity-core memory directories. Files that
      already have an underscore suffix are skipped to prevent double-suffixing.
      Use Dry Run first to preview, then Apply to rename.
    </p>
    <div class="admin-action-form">
      <div class="admin-action-fields">
        <label class="admin-action-label" for="admin-suffix-instance">Instance ID</label>
        <input id="admin-suffix-instance" type="text" class="admin-input"
          placeholder="psycheros" />
      </div>
      <div class="admin-action-fields">
        <label class="admin-action-label" for="admin-suffix-scopes">Scope</label>
        <select id="admin-suffix-scopes" class="admin-select">
          <option value="both" selected>Psycheros + entity-core</option>
          <option value="psycheros">Psycheros only</option>
          <option value="entity-core">entity-core only</option>
        </select>
      </div>
      <div class="admin-action-fields">
        <label class="admin-action-label">
          <input id="admin-suffix-apply" type="checkbox" class="admin-checkbox" />
          Apply
        </label>
      </div>
      <button id="admin-suffix-run-btn" class="admin-action-btn" onclick="window.adminRunAddInstanceSuffix()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
        Run
      </button>
    </div>
  </div>

</div>`;
}

/**
 * Render the entity data tab — export and import entity data.
 */
export function renderAdminEntityData(): string {
  return `<div class="admin-actions">

  <div class="admin-section">
    <h3 class="admin-section-title">Export Entity Data</h3>
    <p class="admin-action-desc">
      Exports all entity data (identity, memories, knowledge graph, conversations,
      lorebooks, vault documents, images, and trusted local plugins) as a zip
      file. Entity-core data is fetched via MCP; Psycheros data is exported
      directly. Plugin code can access my filesystem, network, services, and
      local secrets available after restart.
    </p>
    <div class="admin-action-form">
      <button id="admin-export-btn" class="admin-action-btn" onclick="window.adminExportEntity()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="7 10 12 15 17 10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Export Entity
      </button>
    </div>
  </div>

  <div class="admin-section">
    <h3 class="admin-section-title">Psycheros Instance Transfer</h3>
    <p class="admin-action-desc">
      Transfer data from another Psycheros instance. Use the <strong>Full Overwrite</strong>
      to restore everything from a Psycheros export zip, or <strong>Restore Conversations</strong>
      to merge conversation history from a standalone conversations.json file.
      Restored plugins are executable local code and take effect after I restart.
    </p>

    <div class="admin-section">
      <h3 class="admin-section-title">Full Overwrite</h3>
      <p class="admin-action-desc">
        Performs a <strong>full overwrite</strong> of all entity data from a Psycheros
        entity zip file. A snapshot is taken before overwriting entity-core data.
        After import, stale RAG indexes are cleared and will be rebuilt on next access.
        The import requires MCP to be connected for entity-core data. Restored
        plugins are executable local code and take effect after I restart.
      </p>
      <div class="admin-action-form">
        <div class="admin-action-fields">
          <label class="admin-action-label" for="admin-import-file">Select zip file</label>
          <input id="admin-import-file" type="file" accept=".zip" class="admin-input" />
        </div>
        <button id="admin-import-btn" class="admin-action-btn admin-action-btn-danger" onclick="window.adminImportEntity()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Full Overwrite Import
        </button>
        <div class="import-progress" id="admin-entity-import-progress" style="display:none">
          <div class="import-progress-bar">
            <div class="import-progress-fill" id="admin-entity-import-fill"></div>
          </div>
          <div class="import-progress-text" id="admin-entity-import-text">Preparing...</div>
        </div>
        <div class="import-blocking-overlay" id="admin-entity-import-overlay" style="display:none">
          <div class="import-blocking-text">Importing entity data...</div>
          <div class="import-blocking-subtext">Do not close this page. The import will continue in the background.</div>
        </div>
      </div>
    </div>

    <div class="admin-section">
      <h3 class="admin-section-title">Restore Conversations</h3>
      <p class="admin-action-desc">
        Merge conversation history from a Psycheros conversations.json file
        (found inside an export zip). Existing conversations are preserved —
        new ones are added and duplicate IDs are skipped. This is an
        <strong>additive merge</strong>; no data is ever overwritten or deleted.
      </p>
      <div class="admin-action-form">
        <div class="admin-action-fields">
          <label class="admin-action-label" for="admin-restore-conv-file">Select conversations.json</label>
          <input id="admin-restore-conv-file" type="file" accept=".json" class="admin-input" />
        </div>
        <button id="admin-restore-conv-btn" class="admin-action-btn" onclick="window.adminRestoreConversations()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Restore Conversations
        </button>
      </div>
      <div class="import-progress" id="admin-restore-conv-progress" style="display:none">
        <div class="import-progress-bar">
          <div class="import-progress-fill" id="admin-restore-conv-fill"></div>
        </div>
        <div class="import-progress-text" id="admin-restore-conv-text">Preparing...</div>
      </div>
      <div class="admin-migration-output" id="admin-restore-conv-output" style="display:none"></div>
    </div>
  </div>

  <div class="admin-section">
    <h3 class="admin-section-title">entity-loom Data Migration</h3>
    <p class="admin-action-desc">
      Import data from external platforms (ChatGPT, SillyTavern, Claude, etc.)
      that was processed through <strong>entity-loom</strong>. Each data type is imported
      separately so failures are isolated. Imports are <strong>additive only</strong>
      — existing data is never overwritten. Requires entity-core data directory
      to be configured.
    </p>

    <div class="admin-section">
      <h3 class="admin-section-title">Significant Memories</h3>
      <p class="admin-action-desc">
        Import significant memory .md files from an entity-loom export. Each file
        is copied directly into entity-core's memory directory. Files are immediately
        available for RAG retrieval.
      </p>
      <div class="admin-action-form">
        <div class="admin-action-fields">
          <label class="admin-action-label" for="admin-migration-sig-files">Select .md files</label>
          <input id="admin-migration-sig-files" type="file" accept=".md" multiple class="admin-input" />
        </div>
        <button id="admin-migration-sig-btn" class="admin-action-btn" onclick="window.adminImportMemories('significant')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Import Significant Memories
        </button>
      </div>
      <div class="admin-migration-output" id="admin-migration-sig-output" style="display:none"></div>
    </div>

    <div class="admin-section">
      <h3 class="admin-section-title">Daily Memories</h3>
      <p class="admin-action-desc">
        Import daily memory .md files from an entity-loom export. Each file
        is copied directly into entity-core's memory directory. Files are immediately
        available for RAG retrieval.
      </p>
      <div class="admin-action-form">
        <div class="admin-action-fields">
          <label class="admin-action-label" for="admin-migration-daily-files">Select .md files</label>
          <input id="admin-migration-daily-files" type="file" accept=".md" multiple class="admin-input" />
        </div>
        <button id="admin-migration-daily-btn" class="admin-action-btn" onclick="window.adminImportMemories('daily')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Import Daily Memories
        </button>
      </div>
      <div class="admin-migration-output" id="admin-migration-daily-output" style="display:none"></div>
    </div>

    <div class="admin-section">
      <h3 class="admin-section-title">Chat / Conversations</h3>
      <p class="admin-action-desc">
        Merge conversation history from entity-loom's chats.db exports.
        Existing conversations are skipped by ID (additive only — nothing is overwritten).
        Messages are optionally embedded for RAG retrieval.
      </p>
      <div class="admin-action-form">
        <div class="admin-action-fields">
          <label class="admin-action-label" for="admin-migration-chat-files">Select .db file</label>
          <input id="admin-migration-chat-files" type="file" accept=".db" class="admin-input" />
        </div>
        <label class="admin-action-label admin-action-checkbox">
          <input type="checkbox" id="admin-migration-chat-embed" checked class="admin-checkbox" />
          Embed messages for RAG (may take several minutes for large imports)
        </label>
        <button id="admin-migration-chat-btn" class="admin-action-btn" onclick="window.adminImportChats()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Import Conversations
        </button>
      </div>
      <div class="import-progress" id="admin-migration-chat-progress" style="display:none">
        <div class="import-progress-bar">
          <div class="import-progress-fill" id="admin-migration-chat-fill"></div>
        </div>
        <div class="import-progress-text" id="admin-migration-chat-text">Preparing...</div>
      </div>
      <div class="admin-migration-output" id="admin-migration-chat-output" style="display:none"></div>
    </div>

    <div class="admin-section">
      <h3 class="admin-section-title">Knowledge Graph</h3>
      <p class="admin-action-desc">
        Merge knowledge graph data from entity-loom's graph.db exports.
        Entity-core will be temporarily stopped during import.
        Existing nodes and edges are skipped by ID (additive only).
        Missing vector embeddings are computed automatically.
      </p>
      <div class="admin-action-form">
        <div class="admin-action-fields">
          <label class="admin-action-label" for="admin-migration-graph-files">Select .db file</label>
          <input id="admin-migration-graph-files" type="file" accept=".db" class="admin-input" />
        </div>
        <label class="admin-action-label admin-action-checkbox">
          <input type="checkbox" id="admin-migration-graph-embed" checked class="admin-checkbox" />
          Embed nodes for vector search
        </label>
        <button id="admin-migration-graph-btn" class="admin-action-btn" onclick="window.adminImportGraph()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Import Knowledge Graph
        </button>
      </div>
      <div class="import-progress" id="admin-migration-graph-progress" style="display:none">
        <div class="import-progress-bar">
          <div class="import-progress-fill" id="admin-migration-graph-fill"></div>
        </div>
        <div class="import-progress-text" id="admin-migration-graph-text">Preparing...</div>
      </div>
      <div class="import-blocking-overlay" id="admin-migration-graph-overlay" style="display:none">
        <div class="import-blocking-text">Importing knowledge graph...</div>
        <div class="import-blocking-subtext">Entity-core is temporarily stopped. Please wait.</div>
      </div>
      <div class="admin-migration-output" id="admin-migration-graph-output" style="display:none"></div>
    </div>
  </div>

  <div class="admin-section" id="admin-entity-output-section" style="display:none">
    <h3 class="admin-section-title">Output</h3>
    <div class="admin-action-output" id="admin-entity-output"></div>
  </div>

</div>`;
}
