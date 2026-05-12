/**
 * Pulse UI Templates
 *
 * HTML template functions for the Pulse settings UI,
 * including the settings hub card, prompt list, editor, and execution log.
 *
 * @module
 */

import type { PulseRow, PulseRunRow } from "../types.ts";
import {
  formatUtcIsoToLocalDatetimeLocal,
  getDisplayTimezone,
  utcCronToLocalMonthly,
  utcCronToLocalTime,
  utcCronToLocalWeekly,
} from "./timezone.ts";

// =============================================================================
// Helpers
// =============================================================================

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "Never";
  try {
    const d = new Date(iso);
    const tz = getDisplayTimezone();
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      ...(tz ? { timeZone: tz } : {}),
    });
  } catch {
    return iso;
  }
}

function formatDuration(ms: number | null): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function formatTriggerType(pulse: PulseRow): string {
  switch (pulse.triggerType) {
    case "cron":
      if (pulse.runAt) return `Once at ${formatTimestamp(pulse.runAt)}`;
      if (pulse.intervalSeconds) {
        if (pulse.intervalSeconds >= 3600) {
          return `Every ${pulse.intervalSeconds / 3600}h`;
        }
        return `Every ${pulse.intervalSeconds / 60}m`;
      }
      if (pulse.cronExpression) {
        // Try to humanize common cron patterns
        return humanizeCron(pulse.cronExpression);
      }
      return "Scheduled";
    case "inactivity":
      return pulse.inactivityThresholdSeconds
        ? `After ${
          pulse.inactivityThresholdSeconds >= 3600
            ? `${pulse.inactivityThresholdSeconds / 3600}h`
            : `${pulse.inactivityThresholdSeconds / 60}m`
        } inactive`
        : "When inactive";
    case "webhook":
      return "Webhook";
    case "filesystem":
      return `File watch`;
    default:
      return pulse.triggerType;
  }
}

function humanizeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, day, month, weekday] = parts;

  const tz = getDisplayTimezone();

  // Once a day at specific time
  if (
    day === "*" && month === "*" && weekday === "*" && /^\d+$/.test(min) &&
    /^\d+$/.test(hour)
  ) {
    if (tz) {
      const local = utcCronToLocalTime(parseInt(hour), parseInt(min), tz);
      return `Daily at ${String(local.localHour).padStart(2, "0")}:${
        String(local.localMin).padStart(2, "0")
      }`;
    }
    return `Daily at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
  }

  // Weekly
  if (
    /^\d+$/.test(min) && /^\d+$/.test(hour) && day === "*" && month === "*" &&
    /^\d+$/.test(weekday)
  ) {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    if (tz) {
      const local = utcCronToLocalWeekly(
        parseInt(weekday),
        parseInt(hour),
        parseInt(min),
        tz,
      );
      return `Weekly on ${days[local.localDayOfWeek]} at ${
        String(local.localHour).padStart(2, "0")
      }:${String(local.localMin).padStart(2, "0")}`;
    }
    return `Weekly on ${days[parseInt(weekday)]} at ${hour.padStart(2, "0")}:${
      min.padStart(2, "0")
    }`;
  }

  // Monthly
  if (
    /^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(day) &&
    month === "*" && weekday === "*"
  ) {
    if (tz) {
      const local = utcCronToLocalMonthly(
        parseInt(day),
        parseInt(hour),
        parseInt(min),
        tz,
      );
      return `Monthly on the ${local.localDayOfMonth}${
        ordinalSuffix(local.localDayOfMonth)
      } at ${String(local.localHour).padStart(2, "0")}:${
        String(local.localMin).padStart(2, "0")
      }`;
    }
    return `Monthly on the ${parseInt(day)}${ordinalSuffix(parseInt(day))} at ${
      hour.padStart(2, "0")
    }:${min.padStart(2, "0")}`;
  }

  return expr;
}

function ordinalSuffix(n: number): string {
  if (n >= 11 && n <= 13) return "th";
  const last = n % 10;
  if (last === 1) return "st";
  if (last === 2) return "nd";
  if (last === 3) return "rd";
  return "th";
}

function formatCronToTime(cronExpr: string | null): string | null {
  if (!cronExpr) return null;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [min, hour] = parts;
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return null;
  const tz = getDisplayTimezone();
  if (tz) {
    const local = utcCronToLocalTime(parseInt(hour), parseInt(min), tz);
    return `${String(local.localHour).padStart(2, "0")}:${
      String(local.localMin).padStart(2, "0")
    }`;
  }
  return `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
}

function formatCronToMonthlyDate(cronExpr: string | null): string | null {
  if (!cronExpr) return null;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const day = parts[2];
  if (!/^\d+$/.test(day)) return null;
  const tz = getDisplayTimezone();
  if (tz) {
    const hour = parseInt(parts[1]);
    const min = parseInt(parts[0]);
    const local = utcCronToLocalMonthly(parseInt(day), hour, min, tz);
    return String(local.localDayOfMonth);
  }
  return day;
}

function formatCronToWeeklyDay(cronExpr: string | null): string | null {
  if (!cronExpr) return null;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const weekday = parts[4];
  if (!/^\d+$/.test(weekday)) return null;
  const tz = getDisplayTimezone();
  if (tz) {
    const hour = parseInt(parts[1]);
    const min = parseInt(parts[0]);
    const local = utcCronToLocalWeekly(parseInt(weekday), hour, min, tz);
    return String(local.localDayOfWeek);
  }
  return weekday;
}

/**
 * The Pulse icon SVG (EKG-style heartbeat monitor line).
 */
export function pulseIconSvg(size = 20): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
  </svg>`;
}

/**
 * Small inline pulse indicator for chat names.
 */
export function pulseIndicatorSvg(): string {
  return `<svg class="pulse-indicator" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" title="Active Pulse">
    <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
  </svg>`;
}

// =============================================================================
// Settings Hub Card
// =============================================================================

/**
 * Renders just the card HTML for the settings hub.
 * This gets embedded into renderSettingsHub().
 */
export function renderPulseHubCard(): string {
  return `<a class="settings-hub-card"
    hx-get="/fragments/settings/pulse"
    hx-target="#chat"
    hx-swap="innerHTML">
    <div class="settings-hub-card-icon">
      ${pulseIconSvg()}
    </div>
    <div class="settings-hub-card-body">
      <span class="settings-hub-card-title">Pulse</span>
      <span class="settings-hub-card-desc">Schedule autonomous entity prompts and reminders</span>
    </div>
    <svg class="settings-hub-card-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  </a>`;
}

// =============================================================================
// Main Pulse View
// =============================================================================

export function renderPulseSettings(pulses: PulseRow[]): string {
  return `<div class="settings-view">
  <div class="settings-header">
    <a class="settings-back-btn" onclick="htmx.ajax('GET', '/fragments/settings', {target: '#chat', swap: 'innerHTML'})">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
      <span>Settings</span>
    </a>
    <div class="settings-tabs" style="padding: 0; border: none;">
      <button class="settings-tab active" id="pulse-tab-prompts"
        onclick="Psycheros.switchTab('pulse', 'prompts')">Prompts</button>
      <button class="settings-tab" id="pulse-tab-log"
        onclick="Psycheros.switchTab('pulse', 'log')">Execution Log</button>
    </div>
    <div class="settings-header-actions">
      <button class="btn btn--primary"
        hx-get="/fragments/settings/pulse/new"
        hx-target="#chat"
        hx-swap="innerHTML">+ New Pulse</button>
    </div>
  </div>
  <div class="settings-content" id="settings-content">
  <div id="pulse-prompts" class="tab-content">
    ${renderPulseList(pulses)}
  </div>
  <div id="pulse-log" class="tab-content" style="display:none">
    <div id="pulse-log-content"
      hx-get="/fragments/settings/pulse/log"
      hx-trigger="load"></div>
  </div>
  </div>
</div>`;
}

// =============================================================================
// Pulse List
// =============================================================================

export function renderPulseList(pulses: PulseRow[]): string {
  if (pulses.length === 0) {
    return `<div class="empty-state">
      <p>No Pulses yet. Create one to schedule autonomous entity behavior.</p>
    </div>`;
  }

  const items = pulses.map((p) => renderPulseItem(p)).join("\n");
  return `<div class="pulse-list">${items}</div>`;
}

function renderPulseItem(pulse: PulseRow): string {
  const statusBadge = pulse.enabled
    ? `<span class="badge badge-success">Active</span>`
    : `<span class="badge badge-muted">Disabled</span>`;

  const sourceBadge = pulse.source === "entity"
    ? `<span class="badge badge-info">Entity</span>`
    : "";

  const triggerBadge = `<span class="badge badge-secondary">${
    escapeHtml(formatTriggerType(pulse))
  }</span>`;
  const modeBadge = `<span class="badge badge-${
    pulse.chatMode === "visible" ? "primary" : "muted"
  }">${pulse.chatMode}</span>`;

  return `<div class="autoprompt-item">
    <div class="autoprompt-header">
      <span class="autoprompt-name">${escapeHtml(pulse.name)}</span>
      ${statusBadge} ${triggerBadge} ${modeBadge} ${sourceBadge}
    </div>
    ${
    pulse.description
      ? `<p class="autoprompt-desc">${escapeHtml(pulse.description)}</p>`
      : ""
  }
    <div class="autoprompt-meta">
      <span>Last run: ${formatTimestamp(pulse.lastRunAt)}</span>
      <span>OK: ${pulse.successCount} | Err: ${pulse.errorCount}</span>
      ${
    pulse.chainPulseIds.length > 0
      ? `<span>Chain: ${pulse.chainPulseIds.length} linked</span>`
      : ""
  }
      ${pulse.autoDelete ? `<span>Auto-delete</span>` : ""}
    </div>
    <div class="autoprompt-actions">
      <button class="btn"
        hx-get="/fragments/settings/pulse/${pulse.id}/edit"
        hx-target="#chat">Edit</button>
      <button class="btn"
        hx-post="/api/pulses/${pulse.id}/trigger"
        hx-swap="none">Run Now</button>
      <button class="btn btn--danger"
        hx-delete="/api/pulses/${pulse.id}"
        hx-target="#chat"
        hx-confirm="Delete this Pulse? This cannot be undone.">Delete</button>
    </div>
  </div>`;
}

// =============================================================================
// Pulse Editor
// =============================================================================

export function renderPulseEditor(
  pulse: PulseRow | null,
  conversations: Array<{ id: string; title?: string }>,
): string {
  const isEdit = pulse !== null;
  const p = pulse ?? {
    name: "",
    description: "",
    promptText: "",
    chatMode: "visible" as const,
    conversationId: null,
    enabled: true,
    triggerType: "cron" as const,
    cronExpression: "",
    intervalSeconds: null,
    randomIntervalMin: null,
    randomIntervalMax: null,
    runAt: "",
    inactivityThresholdSeconds: null,
    chainPulseIds: [] as string[],
    maxChainDepth: 3,
    autoDelete: false,
    filesystemWatchPath: "",
    webhookToken: "",
  };

  const conversationOptions = conversations.map((c) =>
    `<option value="${c.id}" ${c.id === p.conversationId ? "selected" : ""}>${
      escapeHtml(c.title ?? c.id)
    }</option>`
  ).join("\n");

  return `<div class="settings-view">
  <div class="settings-header">
    <a class="settings-back-btn" onclick="htmx.ajax('GET', '/fragments/settings/pulse', {target: '#chat', swap: 'innerHTML'})">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
      <span>Pulses</span>
    </a>
    <h1 class="settings-title">${isEdit ? "Edit" : "New"} Pulse</h1>
  </div>
  <div class="settings-content" id="settings-content">
    <form id="pulse-editor-form"
      onsubmit="Psycheros.savePulse(event, ${
    isEdit ? `'${pulse!.id}'` : "null"
  })">

      <div class="form-group">
        <label for="pulse-name">Name</label>
        <input type="text" id="pulse-name" name="name" value="${
    escapeHtml(p.name)
  }" required
          placeholder="e.g., Morning Check-in">
      </div>

      <div class="form-group">
        <label for="pulse-description">Description</label>
        <input type="text" id="pulse-description" name="description" value="${
    escapeHtml(p.description ?? "")
  }"
          placeholder="What does this Pulse do?">
      </div>

      <div class="form-group">
        <label for="pulse-prompt-text">Prompt Text</label>
        <textarea id="pulse-prompt-text" name="promptText" rows="5" required
          placeholder="Instructions for the entity when this Pulse fires...">${
    escapeHtml(p.promptText)
  }</textarea>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label for="pulse-chat-mode">Chat Mode</label>
          <select id="pulse-chat-mode" name="chatMode">
            <option value="visible" ${
    p.chatMode === "visible" ? "selected" : ""
  }>Visible (appears in chat)</option>
            <option value="silent" ${
    p.chatMode === "silent" ? "selected" : ""
  }>Silent (background only)</option>
          </select>
        </div>
        <div class="form-group">
          <label for="pulse-conversation">Conversation</label>
          <select id="pulse-conversation" name="conversationId">
            <option value="" ${
    !p.conversationId ? "selected" : ""
  }>Auto-create</option>
            ${conversationOptions}
          </select>
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label for="pulse-trigger-type">When should this Pulse fire?</label>
          <select id="pulse-trigger-type" name="triggerType"
            onchange="Psycheros.updatePulseTriggerFields(this.value)">
            <option value="scheduled" ${
    p.triggerType === "cron" && !p.runAt ? "selected" : ""
  }>On a schedule</option>
            <option value="oneshot" ${
    p.triggerType === "cron" && p.runAt ? "selected" : ""
  }>Once at a specific time</option>
            <option value="inactivity" ${
    p.triggerType === "inactivity" ? "selected" : ""
  }>After you've been inactive</option>
            <option value="webhook" ${
    p.triggerType === "webhook" ? "selected" : ""
  }>When something else triggers it (webhook)</option>
            <option value="filesystem" ${
    p.triggerType === "filesystem" ? "selected" : ""
  }>When a file changes</option>
          </select>
        </div>
        <div class="form-group" style="justify-content: flex-end;">
          <label class="toggle-label">
            <input type="checkbox" name="enabled" ${p.enabled ? "checked" : ""}>
            <span class="toggle-slider"></span>
            <span class="toggle-text">Enabled</span>
          </label>
        </div>
      </div>

      <!-- Scheduled trigger fields (friendly presets) -->
      <div id="pulse-trigger-scheduled" class="trigger-fields" ${
    !(p.triggerType === "cron" && !p.runAt) ? "style='display:none'" : ""
  }>
        <div class="form-group">
          <label for="pulse-schedule-preset">How often?</label>
          <select id="pulse-schedule-preset" name="schedulePreset"
            onchange="Psycheros.updatePulseSchedulePreset(this.value)">
            <option value="interval" ${
    (p.intervalSeconds && p.intervalSeconds >= 60) ? "selected" : ""
  }>Every...</option>
            <option value="daily" ${
    p.cronExpression && /^\d+ \d+ \* \* \*$/.test(p.cronExpression)
      ? "selected"
      : ""
  }>Once a day</option>
            <option value="weekly" ${
    p.cronExpression && /\d+ \d+ \* \* \d+/.test(p.cronExpression) &&
      !/^\d+ \d+ \* \* \*$/.test(p.cronExpression)
      ? "selected"
      : ""
  }>Once a week</option>
            <option value="monthly" ${
    p.cronExpression && /\d+ \d+ \d+ \* \*/.test(p.cronExpression)
      ? "selected"
      : ""
  }>Once a month</option>
            <option value="advanced" ${
    p.cronExpression && !/^\d+ \d+ \* \* \*$/.test(p.cronExpression) &&
      !/\d+ \d+ \* \* \d+/.test(p.cronExpression) &&
      !/\d+ \d+ \d+ \* \*/.test(p.cronExpression)
      ? "selected"
      : ""
  }>Custom (advanced)</option>
          </select>
        </div>

        <!-- Interval: Every N minutes/hours -->
        <div id="pulse-schedule-interval" class="schedule-fields" ${
    !(p.intervalSeconds && p.intervalSeconds >= 60)
      ? "style='display:none'"
      : ""
  }>
          <div class="form-row">
            <div class="form-group">
              <label for="pulse-interval-amount">Repeat every</label>
              <input type="number" id="pulse-interval-amount" name="intervalAmount"
                value="${
    p.intervalSeconds
      ? (p.intervalSeconds >= 3600
        ? Math.round(p.intervalSeconds / 3600)
        : Math.round(p.intervalSeconds / 60))
      : "30"
  }" min="1">
            </div>
            <div class="form-group form-group--small" style="justify-content: flex-end;">
              <select id="pulse-interval-unit" name="intervalUnit">
                <option value="minutes" ${
    (p.intervalSeconds && p.intervalSeconds < 3600) ? "selected" : ""
  }>minutes</option>
                <option value="hours" ${
    (!p.intervalSeconds || p.intervalSeconds >= 3600) ? "selected" : ""
  }>hours</option>
              </select>
            </div>
          </div>
        </div>

        <!-- Daily: at specific time -->
        <div id="pulse-schedule-daily" class="schedule-fields" ${
    !(p.cronExpression && /^\d+ \d+ \* \* \*$/.test(p.cronExpression))
      ? "style='display:none'"
      : ""
  }>
          <div class="form-row">
            <div class="form-group">
              <label for="pulse-daily-time">At time</label>
              <input type="time" id="pulse-daily-time" name="dailyTime"
                value="${formatCronToTime(p.cronExpression) || "09:00"}">
            </div>
          </div>
        </div>

        <!-- Weekly: on specific day at time -->
        <div id="pulse-schedule-weekly" class="schedule-fields" ${
    !(p.cronExpression && /\d+ \d+ \* \* \d+/.test(p.cronExpression) &&
        !/^\d+ \d+ \* \* \*$/.test(p.cronExpression))
      ? "style='display:none'"
      : ""
  }>
          <div class="form-row">
            <div class="form-group">
              <label for="pulse-weekly-day">On</label>
              <select id="pulse-weekly-day" name="weeklyDay">
                <option value="1" ${
    formatCronToWeeklyDay(p.cronExpression) === "1" ? "selected" : ""
  }>Monday</option>
                <option value="2" ${
    formatCronToWeeklyDay(p.cronExpression) === "2" ? "selected" : ""
  }>Tuesday</option>
                <option value="3" ${
    formatCronToWeeklyDay(p.cronExpression) === "3" ? "selected" : ""
  }>Wednesday</option>
                <option value="4" ${
    formatCronToWeeklyDay(p.cronExpression) === "4" ? "selected" : ""
  }>Thursday</option>
                <option value="5" ${
    formatCronToWeeklyDay(p.cronExpression) === "5" ? "selected" : ""
  }>Friday</option>
                <option value="6" ${
    formatCronToWeeklyDay(p.cronExpression) === "6" ? "selected" : ""
  }>Saturday</option>
                <option value="0" ${
    formatCronToWeeklyDay(p.cronExpression) === "0" ? "selected" : ""
  }>Sunday</option>
              </select>
            </div>
            <div class="form-group">
              <label for="pulse-weekly-time">At time</label>
              <input type="time" id="pulse-weekly-time" name="weeklyTime"
                value="${formatCronToTime(p.cronExpression) || "09:00"}">
            </div>
          </div>
        </div>

        <!-- Monthly: on specific date at time -->
        <div id="pulse-schedule-monthly" class="schedule-fields" ${
    !(p.cronExpression && /\d+ \d+ \d+ \* \*/.test(p.cronExpression))
      ? "style='display:none'"
      : ""
  }>
          <div class="form-row">
            <div class="form-group">
              <label for="pulse-monthly-date">On day of month</label>
              <input type="number" id="pulse-monthly-date" name="monthlyDate"
                value="${
    formatCronToMonthlyDate(p.cronExpression) || "1"
  }" min="1" max="31">
            </div>
            <div class="form-group">
              <label for="pulse-monthly-time">At time</label>
              <input type="time" id="pulse-monthly-time" name="monthlyTime"
                value="${formatCronToTime(p.cronExpression) || "09:00"}">
            </div>
          </div>
        </div>

        <!-- Advanced: raw cron expression -->
        <div id="pulse-schedule-advanced" class="schedule-fields" ${
    !(p.cronExpression && !/^\d+ \d+ \* \* \*$/.test(p.cronExpression) &&
        !/\d+ \d+ \* \* \d+/.test(p.cronExpression) &&
        !/\d+ \d+ \d+ \* \*/.test(p.cronExpression))
      ? "style='display:none'"
      : ""
  }>
          <div class="form-group">
            <label for="pulse-cron-advanced">Cron Expression</label>
            <input type="text" id="pulse-cron-advanced" name="cronExpression"
              value="${escapeHtml(p.cronExpression ?? "")}"
              placeholder="0 8 * * *">
            <small>Standard cron format: minute hour day month weekday. Interpreted in UTC.</small>
          </div>
        </div>
      </div>

      <!-- One-shot trigger fields -->
      <div id="pulse-trigger-oneshot" class="trigger-fields" ${
    !(p.triggerType === "cron" && p.runAt) ? "style='display:none'" : ""
  }>
        <div class="form-group">
          <label for="pulse-run-at">When?</label>
          <input type="datetime-local" id="pulse-run-at" name="runAt"
            value="${
    p.runAt && getDisplayTimezone()
      ? formatUtcIsoToLocalDatetimeLocal(p.runAt, getDisplayTimezone()!)
      : p.runAt
      ? new Date(p.runAt).toISOString().slice(0, 16)
      : ""
  }">
          <small>Fire once at this date and time, then disable.</small>
        </div>
      </div>

      <!-- Inactivity trigger fields -->
      <div id="pulse-trigger-inactivity" class="trigger-fields" ${
    p.triggerType !== "inactivity" ? "style='display:none'" : ""
  }>
        <div class="form-row">
          <div class="form-group">
            <label for="pulse-inactivity-amount">Fire after you've been inactive for at least</label>
            <input type="number" id="pulse-inactivity-amount" name="inactivityAmount"
              value="${
    p.inactivityThresholdSeconds
      ? (p.inactivityThresholdSeconds >= 3600
        ? Math.round(p.inactivityThresholdSeconds / 3600)
        : Math.round(p.inactivityThresholdSeconds / 60))
      : "30"
  }" min="1">
          </div>
          <div class="form-group form-group--small" style="justify-content: flex-end;">
            <select id="pulse-inactivity-unit" name="inactivityUnit">
              <option value="minutes" ${
    (p.inactivityThresholdSeconds && p.inactivityThresholdSeconds < 3600)
      ? "selected"
      : ""
  }>minutes</option>
              <option value="hours" ${
    (!p.inactivityThresholdSeconds || p.inactivityThresholdSeconds >= 3600)
      ? "selected"
      : ""
  }>hours</option>
            </select>
          </div>
        </div>
        <div class="form-group" style="margin-top: var(--sp-2);">
          <label class="checkbox-label">
            <input type="checkbox" id="pulse-inactivity-random" name="inactivityRandom" ${
    p.randomIntervalMin ? "checked" : ""
  }>
            <span>Add some randomness (makes it feel more natural)</span>
          </label>
        </div>
        <small>Triggers when you haven't sent any messages across all chats for the set duration.</small>
      </div>

      <!-- Webhook trigger fields -->
      <div id="pulse-trigger-webhook" class="trigger-fields" ${
    p.triggerType !== "webhook" ? "style='display:none'" : ""
  }>
        <div class="form-group">
          <label>Webhook URL</label>
          <div class="input-with-copy">
            <input type="text" readonly value="/api/webhook/pulse/${
    pulse?.id ?? "..."
  }" class="readonly-field">
            <button type="button" class="btn btn--sm" onclick="navigator.clipboard.writeText(this.previousElementSibling.value)">Copy</button>
          </div>
          ${
    isEdit && p.webhookToken
      ? `
          <div class="form-group" style="margin-top: 0.5rem">
            <label>Token</label>
            <div class="input-with-copy">
              <input type="text" readonly value="${p.webhookToken}" class="readonly-field">
              <button type="button" class="btn btn--sm" onclick="navigator.clipboard.writeText(this.previousElementSibling.value)">Copy</button>
            </div>
            <small>Use as Bearer token: <code>Authorization: Bearer ${p.webhookToken}</code></small>
          </div>`
      : ""
  }
        </div>
      </div>

      <!-- Filesystem trigger fields -->
      <div id="pulse-trigger-filesystem" class="trigger-fields" ${
    p.triggerType !== "filesystem" ? "style='display:none'" : ""
  }>
        <div class="form-group">
          <label for="pulse-fs-path">Watch Path</label>
          <input type="text" id="pulse-fs-path" name="filesystemWatchPath"
            value="${escapeHtml(p.filesystemWatchPath ?? "")}"
            placeholder="/path/to/watch">
          <small>Directory to watch for file creation/modification events.</small>
        </div>
      </div>

      <div class="form-actions">
        <button type="submit" class="btn btn--primary" id="pulse-save-btn">${
    isEdit ? "Save Changes" : "Create Pulse"
  }</button>
        <button type="button" class="btn" onclick="htmx.ajax('GET', '/fragments/settings/pulse', {target: '#chat', swap: 'innerHTML'})">Cancel</button>
      </div>
      <div id="pulse-save-status" class="settings-status"></div>
    </form>
  </div>
</div>`;
}

// =============================================================================
// Execution Log
// =============================================================================

export function renderPulseLog(
  runs: PulseRunRow[],
  total: number,
  page: number,
): string {
  if (runs.length === 0) {
    return `<div class="empty-state">
      <p>No Pulse executions yet. Runs will appear here after Pulses fire.</p>
    </div>`;
  }

  const rows = runs.map((r) => {
    const statusClass = r.status === "success"
      ? "badge-success"
      : r.status === "error"
      ? "badge-error"
      : "badge-muted";

    return `<tr>
      <td>${formatTimestamp(r.startedAt)}</td>
      <td>${escapeHtml(r.pulseId.substring(0, 8))}</td>
      <td><span class="badge badge-secondary">${r.triggerSource}</span></td>
      <td><span class="badge ${statusClass}">${r.status}</span></td>
      <td>${formatDuration(r.durationMs)}</td>
      <td>${r.toolCallsCount}</td>
      <td class="log-result" title="${
      escapeHtml(r.resultSummary ?? r.errorMessage ?? "")
    }">${
      escapeHtml((r.resultSummary ?? r.errorMessage ?? "—").substring(0, 80))
    }</td>
    </tr>`;
  }).join("\n");

  const pageSize = 50;
  const totalPages = Math.ceil(total / pageSize);
  const hasMore = page < totalPages - 1;

  return `<div class="pulse-log">
    <div class="log-header">
      <span>${total} total run(s)</span>
    </div>
    <table class="log-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Pulse</th>
          <th>Trigger</th>
          <th>Status</th>
          <th>Duration</th>
          <th>Tools</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${
    hasMore
      ? `<div class="log-more"
      hx-get="/fragments/settings/pulse/log?page=${page + 1}"
      hx-trigger="click"
      hx-swap="outerHTML"
      hx-target="closest .pulse-log">
      Load more...
    </div>`
      : ""
  }
  </div>`;
}
