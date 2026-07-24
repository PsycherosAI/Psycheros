/**
 * Settings fragment for the Google Suite plugin.
 *
 * Returns HTML for the plugin's settings page, wrapped in standard chrome by
 * `renderPluginOwnedSettings()` in the daemon. Four sections:
 *   1. Google Cloud OAuth Client — credentials input + help
 *   2. Connection Status — connect/disconnect + granted scopes
 *   3. Services — per-service toggles (Calendar on by default, others opt-in)
 *   4. Calendar Label — phrasing the entity uses in today-schedule context
 *
 * Copy is operator-perspective (matches existing settings tone). Entity-facing
 * copy (tool descriptions, hook output) is first-person per CLAUDE.md.
 *
 * No custom JS — all interactivity uses HTMX attrs (hx-post, hx-trigger=change,
 * hx-target) which the existing psycheros.js already loads.
 */

import type { PluginSettingsContext } from "../../../../src/plugins/plugin-manager.ts";
import { join } from "@std/path";
import { loadConfig } from "../config.ts";
import {
  missingScopes,
  type ServiceId,
  serviceScopeLabel,
} from "../oauth/scopes.ts";

const FIRST_PORT = 8765;
const LAST_PORT = 8785;

const API_ENABLE_URLS: Record<string, string> = {
  calendar:
    "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com",
  gmail: "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
  drive: "https://console.cloud.google.com/apis/library/drive.googleapis.com",
  contacts:
    "https://console.cloud.google.com/apis/library/people.googleapis.com",
  tasks: "https://console.cloud.google.com/apis/library/tasks.googleapis.com",
  fit: "https://console.cloud.google.com/apis/library/fitness.googleapis.com",
};

const API_NAMES: Record<string, string> = {
  calendar: "Google Calendar API",
  gmail: "Gmail API",
  drive: "Google Drive API",
  contacts: "Google People API",
  tasks: "Google Tasks API",
  fit: "Google Fitness API",
};

/** Read hook-cache.json and extract which services have API errors. */
async function getApiErrors(
  statePath: string,
): Promise<Record<string, boolean>> {
  try {
    const raw = await Deno.readTextFile(join(statePath, "hook-cache.json"));
    const cache = JSON.parse(raw) as Record<string, { lastError?: string }>;
    const errors: Record<string, boolean> = {};
    for (const [, entry] of Object.entries(cache)) {
      if (
        entry?.lastError?.includes("accessNotConfigured") ||
        entry?.lastError?.includes("SERVICE_DISABLED")
      ) {
        // Map hook cache keys back to service IDs
        for (const svc of Object.keys(API_ENABLE_URLS)) {
          if (
            entry.lastError.includes(API_NAMES[svc].toLowerCase()) ||
            entry.lastError.includes(svc)
          ) {
            errors[svc] = true;
          }
        }
      }
    }
    return errors;
  } catch {
    return {};
  }
}

export async function renderSettingsFragment(
  ctx: PluginSettingsContext,
): Promise<string> {
  const config = await loadConfig(ctx.statePath);
  const clientIdSet = ctx.env.has("PSYCHEROS_PLUGIN_GOOGLE_SUITE_CLIENT_ID");
  const clientSecretSet = ctx.env.has(
    "PSYCHEROS_PLUGIN_GOOGLE_SUITE_CLIENT_SECRET",
  );
  const hasRefreshToken = ctx.env.has(
    "PSYCHEROS_PLUGIN_GOOGLE_SUITE_REFRESH_TOKEN",
  );
  const connected = hasRefreshToken && config.connectedEmail !== undefined;

  const enabled: ServiceId[] = [];
  if (config.services.calendar) enabled.push("calendar");
  if (config.services.gmail) enabled.push("gmail");
  if (config.services.drive) enabled.push("drive");
  if (config.services.contacts) enabled.push("contacts");
  const missing = missingScopes(enabled, config.grantedScopes);
  const needsReconnect = connected && missing.length > 0;
  const targetId = ctx.targetElementId;
  const apiErrors = await getApiErrors(ctx.statePath);

  return `
    <style>
      .gs-switch { position: relative; display: inline-block; width: 44px; height: 24px; flex-shrink: 0; }
      .gs-switch input { opacity: 0; width: 0; height: 0; }
      .gs-slider { position: absolute; cursor: pointer; inset: 0; background: var(--c-surface-3, #4a5568); transition: 0.2s; border-radius: 24px; }
      .gs-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background: white; transition: 0.2s; border-radius: 50%; }
      .gs-switch input:checked + .gs-slider { background: var(--c-accent, #3b82f6); }
      .gs-switch input:checked + .gs-slider:before { transform: translateX(20px); }
      .gs-switch input:disabled + .gs-slider { opacity: 0.35; cursor: not-allowed; }
    </style>

    ${
    !clientIdSet
      ? `<section class="theme-section" style="border-left: 3px solid var(--c-accent, #3b82f6);">
          <details open>
            <summary style="cursor: pointer; font-weight: 600; color: var(--c-accent);">First-time setup guide</summary>
            <ol style="margin-top: var(--sp-3); padding-left: var(--sp-4); line-height: 1.8;">
              <li>Create a project in the <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud Console</a></li>
              <li>Go to <strong>APIs & Services → OAuth consent screen</strong> → set User type to <strong>External</strong> → fill in app name + your email</li>
              <li>Under <strong>Data access / Scopes</strong>, add scopes for services you want (search "calendar", "gmail", etc.)</li>
              <li>Under <strong>Test users</strong>, add your own Google account email</li>
              <li>Go to <strong>APIs & Services → Library</strong> and <strong>Enable</strong> each API you want to use (direct links below each service toggle)</li>
              <li>Go to <strong>Credentials → Create Credentials → OAuth client ID</strong> → type: <strong>Desktop app</strong></li>
              <li>Copy the <strong>Client ID</strong> and <strong>Client Secret</strong>, paste them below, click Save</li>
              <li>Toggle on the services you want, then click <strong>Connect Account</strong></li>
              <li>Restart Psycheros</li>
            </ol>
            <p class="settings-note" style="margin-top: var(--sp-2);">Each service below has a direct link to enable its API in Google Cloud — you don't have to hunt for them.</p>
          </details>
        </section>`
      : ""
  }

    ${
    Object.keys(apiErrors).length > 0
      ? `<section class="theme-section" style="border-left: 3px solid var(--c-error, #ef4444); margin-bottom: var(--sp-3);">
          <p style="font-weight: 600; color: var(--c-error, #ef4444);">API not enabled</p>
          <p class="settings-note">Some APIs returned 403 — they need to be activated in your Google Cloud project. Click each link below:</p>
          <ul style="margin-top: var(--sp-2);">${
        Object.keys(apiErrors).map((svc) =>
          `<li><a href="${
            API_ENABLE_URLS[svc]
          }" target="_blank" rel="noopener" style="color: var(--c-accent);">Enable ${
            API_NAMES[svc]
          }</a></li>`
        ).join("")
      }</ul>
        </section>`
      : ""
  }
    <section class="theme-section">
      <h3 class="theme-section-title">Google Cloud OAuth Client</h3>
      <p class="theme-section-desc">Create an OAuth 2.0 Client ID of type <strong>Desktop app</strong> in the
        <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud Console</a>.
        Add the following ${
    LAST_PORT - FIRST_PORT + 1
  } redirect URIs to the client's Authorized redirect URIs:</p>
      <details style="margin: var(--sp-2) 0;">
        <summary style="cursor: pointer; color: var(--c-accent);">Show redirect URIs</summary>
        <pre style="margin-top: var(--sp-2); padding: var(--sp-2); background: var(--c-surface-2); border-radius: 4px; overflow-x: auto; font-size: 0.85em;">${redirectUriList()}</pre>
      </details>
      <form class="llm-fields" hx-post="/api/plugins/google-suite/save-credentials" hx-target="#gs-credentials-status" hx-swap="innerHTML">
        <div class="llm-field">
          <label for="gs-client-id">Client ID</label>
          <input type="password" id="gs-client-id" name="clientId" class="input-field llm-input"
                 placeholder="${
    clientIdSet
      ? "•••••••• (already set — paste to replace)"
      : "Paste your OAuth client ID"
  }" autocomplete="off" />
          <p class="settings-note">Status: ${
    clientIdSet
      ? "<strong style='color: var(--c-success);'>set</strong>"
      : "not set"
  }</p>
        </div>
        <div class="llm-field">
          <label for="gs-client-secret">Client Secret</label>
          <input type="password" id="gs-client-secret" name="clientSecret" class="input-field llm-input"
                 placeholder="${
    clientSecretSet
      ? "•••••••• (already set — paste to replace)"
      : "Paste your OAuth client secret"
  }" autocomplete="off" />
          <p class="settings-note">Status: ${
    clientSecretSet
      ? "<strong style='color: var(--c-success);'>set</strong>"
      : "not set"
  }</p>
        </div>
        <button type="submit" class="btn btn--primary">Save credentials</button>
        <div id="gs-credentials-status" style="margin-top: var(--sp-2);"></div>
      </form>
    </section>

    <section class="theme-section">
      <h3 class="theme-section-title">Services</h3>
      <p class="theme-section-desc">Pick the Google services you want, then click Connect Account below. One OAuth flow covers all enabled services — no need to re-connect for each one.</p>
      <form id="gs-services-form">
        ${
    renderServiceToggle(
      targetId,
      "calendar",
      "Calendar",
      "Read and manage events on your Google Calendar.",
      config.services.calendar,
    )
  }
        ${
    renderServiceToggle(
      targetId,
      "gmail",
      "Gmail",
      "Read, send, and label your email. Significant privacy implication — review carefully.",
      config.services.gmail,
    )
  }
        ${
    renderServiceToggle(
      targetId,
      "drive",
      "Drive",
      "Manage files this app created or that you've opened via it. Does NOT see your entire Drive.",
      config.services.drive,
    )
  }
        ${
    renderServiceToggle(
      targetId,
      "contacts",
      "Contacts",
      "Read and manage your Google Contacts.",
      config.services.contacts,
    )
  }
        ${
    renderServiceToggle(
      targetId,
      "tasks",
      "Tasks",
      "Manage your default Google Tasks list. Enables the google_tasks tool and a pending_tasks ambient hook (due ≤ tomorrow + undated, capped).",
      config.services.tasks,
    )
  }
        ${
    renderServiceToggle(
      targetId,
      "fit",
      "Fit",
      "Read health data (steps, heart rate, sleep, activity) from Google Fit. Requires 4 read scopes. Per-metric opt-in below.",
      config.services.fit,
    )
  }
      </form>
      <div id="${targetId}-toggle-result" style="margin-top: var(--sp-2);"></div>
    </section>

    <section class="theme-section">
      <h3 class="theme-section-title">Connection</h3>
      <p class="theme-section-desc">${
    connected
      ? `Connected as <strong>${
        escapeHtml(config.connectedEmail ?? "")
      }</strong>`
      : "Connect your Google account to grant scopes for all enabled services above."
  }</p>
      <div style="display: flex; gap: var(--sp-2); flex-wrap: wrap;">
        <button type="button" class="btn btn--primary"
                hx-post="/api/plugins/google-suite/start-oauth"
                hx-target="#gs-connect-status"
                hx-swap="innerHTML">Connect Account</button>
        ${
    connected
      ? `<button type="button" class="btn btn--ghost"
                hx-post="/api/plugins/google-suite/disconnect"
                hx-target="#gs-connect-status"
                hx-swap="innerHTML"
                hx-confirm="Disconnect from Google? Your refresh token will be revoked. Client ID and secret are preserved so re-connect is one click.">Disconnect</button>`
      : ""
  }
      </div>
      <div id="gs-connect-status" style="margin-top: var(--sp-2);">${
    // Initial content: show re-connect banner or connected status so the
    // user sees the right state on page load. Polling replaces this.
    needsReconnect
      ? `<div class="settings-note" style="background: var(--c-warning-bg, #fff7ed); padding: var(--sp-2); border-left: 3px solid var(--c-warning, #f59e0b);">
           <strong>Re-connect required.</strong> You enabled new services that need additional Google permissions. Click Connect Account to grant them.
         </div>`
      : connected
      ? `<p class="settings-note" style="color: var(--c-success);">Connected. All enabled services are authorized.</p>`
      : ""}</div>
    </section>

    <section class="theme-section">
      <h3 class="theme-section-title">Calendar & Tasks Display</h3>
      <p class="theme-section-desc">How the entity refers to this calendar in its today's-schedule context. The label is fully free-form — use whatever fits. Examples: "Sarah's calendar", "Our family schedule", "Band practice times", "Work calendar". Use <code>{'{userName}'}</code> as a placeholder for the configured user name if you want substitution. Default "Today's schedule" doesn't presume whose calendar this is.</p>
      <form class="llm-fields" hx-post="/api/plugins/google-suite/save-settings" hx-target="#gs-settings-status" hx-swap="innerHTML">
        <div class="llm-field">
          <label for="gs-calendar-label">Calendar label</label>
          <input type="text" id="gs-calendar-label" name="calendarLabel" class="input-field llm-input"
                 value="${
    escapeAttr(config.calendarLabel)
  }" placeholder="Today's schedule" />
        </div>
        <div class="llm-field">
          <label for="gs-calendar-lookahead">Calendar lookahead (days)</label>
          <input type="number" id="gs-calendar-lookahead" name="calendarLookaheadDays" class="input-field llm-input" min="1" max="30"
                 value="${escapeAttr(String(config.calendarLookaheadDays))}" />
          <p class="settings-note">How many days ahead the entity sees in its ambient context. Default 1 (today only). Set to 7 for a week-ahead view. Events are grouped by day when > 1.</p>
        </div>
        <div class="llm-field">
          <label for="gs-pending-tasks-cap">Pending tasks cap</label>
          <input type="number" id="gs-pending-tasks-cap" name="pendingTasksCap" class="input-field llm-input" min="1" max="50"
                 value="${escapeAttr(String(config.pendingTasksCap))}" />
          <p class="settings-note">Maximum number of pending tasks the ambient hook shows. Default 5.</p>
        </div>
        <button type="submit" class="btn btn--primary">Save</button>
        <div id="gs-settings-status" style="margin-top: var(--sp-2);"></div>
      </form>
    </section>

    <section class="theme-section">
      <h3 class="theme-section-title">About</h3>
      <p class="theme-section-desc">Google Suite plugin v0.1.0 — bundled with Psycheros. Calendar, Gmail, Drive, Contacts, Tasks, and Fit integration. Each service is enabled individually. Updates arrive with Psycheros itself.</p>
    </section>
  `;
}

function renderServiceToggle(
  targetId: string,
  serviceId: ServiceId,
  displayName: string,
  description: string,
  enabled: boolean,
): string {
  const scopeUrl = serviceScopeLabel(serviceId);
  // Toggles are always usable — operator picks services first, then
  // connects with all scopes at once. No need to gate on credentials.
  const disabledAttr = "";
  const checkedAttr = enabled ? "checked" : "";
  return `
    <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-3); padding: var(--sp-2) 0; border-bottom: 1px solid var(--c-border);">
      <div>
        <strong>${escapeHtml(displayName)}</strong>
        <p class="settings-note" style="margin: var(--sp-1) 0 0 0;">${
    escapeHtml(description)
  } Scope: <code>${escapeHtml(scopeUrl)}</code></p>
        <a href="${
    API_ENABLE_URLS[serviceId] ?? "#"
  }" target="_blank" rel="noopener"
           style="font-size: 0.8em; color: var(--c-accent);">Enable ${
    escapeHtml(API_NAMES[serviceId] ?? displayName)
  } in Google Cloud →</a>
      </div>
      <label class="gs-switch">
        <input type="checkbox" name="${serviceId}" ${checkedAttr} ${disabledAttr}
               hx-post="/api/plugins/google-suite/save-service-toggles"
               hx-trigger="change"
               hx-include="closest form"
               hx-target="#${targetId}-toggle-result"
               hx-swap="innerHTML" />
        <span class="gs-slider"></span>
      </label>
    </div>
  `;
}

function redirectUriList(): string {
  const ports: number[] = [];
  for (let p = FIRST_PORT; p <= LAST_PORT; p++) ports.push(p);
  return ports.map((p) => `http://127.0.0.1:${p}/callback`).join("\n");
}

function escapeHtml(s: string): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
