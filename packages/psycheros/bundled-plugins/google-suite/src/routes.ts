/**
 * HTTP routes for the Google Suite plugin's settings UI.
 *
 * All mounted under `/api/plugins/google-suite/*` by PluginManager. Each
 * handler receives `(request, services)` and returns a Response — either
 * JSON (for status endpoints) or HTML fragment (for HTMX swaps).
 *
 * Module-level state:
 *   - `flowState` tracks an in-progress OAuth flow so /start-oauth can be
 *     idempotent (second call while first is in flight = rejected).
 *   - `lastError` surfaces the most recent flow failure to /oauth-status
 *     polling for the "Connection failed: ..." UI message.
 */

import type {
  PluginRoute,
  PsycherosPluginServices,
} from "../../../src/plugins/plugin-manager.ts";
import { enabledServices, loadConfig, saveConfig } from "./config.ts";
import { runOAuthFlow } from "./oauth/flow.ts";
import { revokeToken } from "./oauth/refresh.ts";
import { missingScopes } from "./oauth/scopes.ts";

const SECRET_PREFIX = "PSYCHEROS_PLUGIN_GOOGLE_SUITE_";
const CLIENT_ID_KEY = `${SECRET_PREFIX}CLIENT_ID`;
const CLIENT_SECRET_KEY = `${SECRET_PREFIX}CLIENT_SECRET`;
const REFRESH_TOKEN_KEY = `${SECRET_PREFIX}REFRESH_TOKEN`;

// Module-level state for in-progress OAuth flows. Singleton assumption:
// PluginManager instantiates the entrypoint once per daemon start; module
// state survives for the daemon's lifetime.
interface FlowState {
  inProgress: boolean;
  startedAt?: number;
  lastError?: string;
}
const flowState: FlowState = { inProgress: false };

export const googleSuiteRoutes: PluginRoute[] = [
  {
    method: "POST",
    path: "/save-credentials",
    handler: handleSaveCredentials,
  },
  {
    method: "GET",
    path: "/oauth-status",
    handler: handleOauthStatus,
  },
  {
    method: "POST",
    path: "/start-oauth",
    handler: handleStartOauth,
  },
  {
    method: "POST",
    path: "/disconnect",
    handler: handleDisconnect,
  },
  {
    method: "POST",
    path: "/save-service-toggles",
    handler: handleSaveServiceToggles,
  },
  {
    method: "POST",
    path: "/save-settings",
    handler: handleSaveSettings,
  },
  {
    method: "GET",
    path: "/load-settings",
    handler: handleLoadSettings,
  },
];

async function handleSaveCredentials(
  request: Request,
  services: PsycherosPluginServices,
): Promise<Response> {
  const form = await request.formData();
  const clientId = stringOrNull(form.get("clientId"));
  const clientSecret = stringOrNull(form.get("clientSecret"));

  const messages: string[] = [];
  if (clientId) {
    await services.writeSecret(CLIENT_ID_KEY, clientId);
    messages.push("Client ID saved.");
  }
  if (clientSecret) {
    await services.writeSecret(CLIENT_SECRET_KEY, clientSecret);
    messages.push("Client secret saved.");
  }

  if (messages.length === 0) {
    return html(
      `<p class="settings-note" style="color: var(--c-text-muted);">No changes — both fields were empty.</p>`,
    );
  }
  return html(
    `<p class="settings-note" style="color: var(--c-success);">${
      messages.join(" ")
    } Click <strong>Connect Account</strong> below to authorize.</p>`,
  );
}

async function handleOauthStatus(
  _request: Request,
  services: PsycherosPluginServices,
): Promise<Response> {
  const config = await loadConfig(services.statePath);
  const connected = services.env.has(REFRESH_TOKEN_KEY) &&
    config.connectedEmail !== undefined;

  if (flowState.inProgress) {
    // Still waiting for the browser callback. Return HTML with a self-polling
    // div using `every 3s` — the standard HTMX repeating trigger. When the
    // flow completes, the connected response below replaces this div with
    // plain HTML (no polling div), so polling stops naturally.
    return html(
      `<p class="settings-note">Waiting for browser sign-in to complete...</p>
       <div hx-get="/api/plugins/google-suite/oauth-status" hx-trigger="every 3s" hx-target="#gs-connect-status" hx-swap="innerHTML"></div>`,
    );
  }

  if (connected) {
    const enabled = enabledServices(config);
    const missing = missingScopes(enabled, config.grantedScopes);
    const reconnectNote = connected && missing.length > 0
      ? `<p class="settings-note" style="color: var(--c-warning, #f59e0b);">Re-connect required — some enabled services need additional scopes. Click Connect Account again.</p>`
      : "";
    const scopes = config.grantedScopes.length > 0
      ? `<details style="margin-top: var(--sp-1);"><summary style="cursor: pointer; color: var(--c-accent); font-size: 0.85em;">Granted scopes (${config.grantedScopes.length})</summary><ul style="font-size: 0.8em; color: var(--c-text-muted);">${
        config.grantedScopes.map((s) => `<li><code>${s}</code></li>`).join("")
      }</ul></details>`
      : "";
    return html(
      `<p class="settings-note" style="color: var(--c-success);">Connected as <strong>${
        config.connectedEmail ?? "?"
      }</strong></p>${reconnectNote}${scopes}`,
    );
  }

  if (flowState.lastError) {
    return html(
      `<p class="settings-note" style="color: var(--c-error);">Connection failed: ${flowState.lastError}</p>`,
    );
  }

  return html(
    `<p class="settings-note">Not connected. Configure credentials above, then click Connect Account.</p>`,
  );
}

async function handleStartOauth(
  _request: Request,
  services: PsycherosPluginServices,
): Promise<Response> {
  const clientId = services.env.get(CLIENT_ID_KEY);
  const clientSecret = services.env.get(CLIENT_SECRET_KEY);
  if (!clientId || !clientSecret) {
    return html(
      `<p class="settings-note" style="color: var(--c-error);">Configure Client ID and Client Secret above first, then click Connect Account again.</p>`,
      400,
    );
  }
  if (flowState.inProgress) {
    return html(
      `<p class="settings-note">An authorization flow is already in progress. Check your browser.</p>`,
    );
  }

  const config = await loadConfig(services.statePath);
  const enabled = enabledServices(config);

  flowState.inProgress = true;
  flowState.startedAt = Date.now();
  flowState.lastError = undefined;

  // Fire-and-forget — UI polls /oauth-status. The promise resolves when
  // the operator completes the flow in their browser (or it times out).
  // The .then/.catch/.finally chain holds the runtime reference; we don't
  // need a module-level variable for GC purposes.
  runOAuthFlow({
    clientId,
    clientSecret,
    enabledServices: enabled,
    statePath: services.statePath,
    writeRefreshToken: (token) =>
      services.writeSecret(REFRESH_TOKEN_KEY, token),
  })
    .then(async (result) => {
      if (result.success) {
        const refreshed = await loadConfig(services.statePath);
        await saveConfig(services.statePath, {
          ...refreshed,
          connectedEmail: result.email,
          grantedScopes: result.grantedScopes ?? [],
        });
      } else {
        flowState.lastError = result.error;
      }
    })
    .catch((error) => {
      flowState.lastError = error instanceof Error
        ? error.message
        : String(error);
    })
    .finally(() => {
      flowState.inProgress = false;
    });

  return html(
    `<p class="settings-note">Opened your browser to Google. Complete the sign-in there — this page refreshes automatically when done.</p>
     <div hx-get="/api/plugins/google-suite/oauth-status" hx-trigger="every 3s" hx-target="#gs-connect-status" hx-swap="innerHTML"></div>`,
  );
}

async function handleDisconnect(
  _request: Request,
  services: PsycherosPluginServices,
): Promise<Response> {
  const refreshToken = services.env.get(REFRESH_TOKEN_KEY);
  if (refreshToken) {
    // Best-effort revoke — don't block local disconnect on Google's response.
    void revokeToken(refreshToken).catch(() => {});
  }
  // Rewrite the secrets file without the refresh token. Client ID/secret
  // stay so re-connect is one click.
  await removeSecret(services, REFRESH_TOKEN_KEY);

  const config = await loadConfig(services.statePath);
  await saveConfig(services.statePath, {
    ...config,
    connectedEmail: undefined,
    grantedScopes: [],
  });
  flowState.lastError = undefined;

  return html(
    `<p class="settings-note" style="color: var(--c-success);">Disconnected. Client ID and Client Secret are preserved so you can re-connect with one click.</p>`,
  );
}

async function handleSaveServiceToggles(
  request: Request,
  services: PsycherosPluginServices,
): Promise<Response> {
  // HTMX submits forms as form-encoded; unchecked checkboxes are absent
  // from the body. Treat presence = enabled, absence = disabled.
  const form = await request.formData();
  const updated = await loadConfig(services.statePath);
  updated.services = {
    calendar: form.get("calendar") === "on",
    gmail: form.get("gmail") === "on",
    drive: form.get("drive") === "on",
    contacts: form.get("contacts") === "on",
    tasks: form.get("tasks") === "on",
    fit: form.get("fit") === "on",
  };
  await saveConfig(services.statePath, updated);

  const enabled = enabledServices(updated);
  const missing = missingScopes(enabled, updated.grantedScopes);
  const connected = services.env.has(REFRESH_TOKEN_KEY) &&
    updated.connectedEmail !== undefined;

  if (connected && missing.length > 0) {
    return html(
      `<p class="settings-note" style="color: var(--c-warning, #f59e0b);"><strong>Re-connect required.</strong> Enabling ${
        missing.length === 1 ? "a new service" : "new services"
      } requires additional Google permissions. Click Connect Account to grant them.</p>`,
    );
  }
  return html(
    `<p class="settings-note" style="color: var(--c-success);">Service preferences saved. Restart Psycheros for tool changes to take effect.</p>`,
  );
}

async function handleSaveSettings(
  request: Request,
  services: PsycherosPluginServices,
): Promise<Response> {
  const form = await request.formData();
  const calendarLabel = stringOrNull(form.get("calendarLabel"));
  const pendingTasksCapRaw = stringOrNull(form.get("pendingTasksCap"));
  const lookaheadRaw = stringOrNull(form.get("calendarLookaheadDays"));

  const config = await loadConfig(services.statePath);
  const pendingTasksCap = pendingTasksCapRaw
    ? Math.min(Math.max(1, parseInt(pendingTasksCapRaw, 10) || 5), 50)
    : config.pendingTasksCap;
  const calendarLookaheadDays = lookaheadRaw
    ? Math.min(Math.max(1, parseInt(lookaheadRaw, 10) || 1), 30)
    : config.calendarLookaheadDays;

  await saveConfig(services.statePath, {
    ...config,
    calendarLabel: calendarLabel?.trim() || config.calendarLabel,
    pendingTasksCap,
    calendarLookaheadDays,
  });

  // Invalidate pending_tasks so the new cap takes effect on next hook read.
  // The refresh function reads cap from config at refresh time, so the
  // cache entry's stored `cap` value updates on next refresh.
  return html(
    `<p class="settings-note" style="color: var(--c-success);">Settings saved. Changes to pending tasks cap take effect within ${
      Math.ceil(10 * 60 / 1000)
    } minutes (next scheduled refresh), or immediately on next task mutation.</p>`,
  );
}

async function handleLoadSettings(
  _request: Request,
  services: PsycherosPluginServices,
): Promise<Response> {
  const config = await loadConfig(services.statePath);
  return json({
    clientIdSet: services.env.has(CLIENT_ID_KEY),
    clientSecretSet: services.env.has(CLIENT_SECRET_KEY),
    connected: services.env.has(REFRESH_TOKEN_KEY) &&
      config.connectedEmail !== undefined,
    email: config.connectedEmail,
    calendarLabel: config.calendarLabel,
    services: config.services,
    grantedScopes: config.grantedScopes,
  });
}

/**
 * Re-write the plugin's secrets file without the named key. We can't reach
 * into PluginManager's private serializePluginEnv from here, so we use the
 * public readSecrets + writeSecret round-trip: read all, delete the target,
 * write the file directly to override.
 *
 * Path assumption: bundled-plugin statePath is
 * `<dataRoot>/.psycheros/plugin-state/google-suite/`, so
 * `<statePath>/../../plugin-secrets/google-suite.env` resolves to the
 * Phase-A-uniform secrets dir. Correct for bundled plugins (which is what
 * google-suite is). If we ever support installing google-suite from a zip,
 * the path math differs and we'd need a `services.removeSecret` API — at
 * which point this whole function becomes one line.
 */
async function removeSecret(
  services: PsycherosPluginServices,
  name: string,
): Promise<void> {
  const remaining = await services.readSecrets();
  delete remaining[name];
  const { join } = await import("@std/path");
  const secretsPath = join(
    services.statePath,
    "..",
    "..",
    "plugin-secrets",
    "google-suite.env",
  );
  const lines = Object.entries(remaining)
    .filter(([, v]) => v && v.length > 0)
    .map(([k, v]) => {
      if (/[\s#"']/.test(v)) {
        return `${k}="${v.replace(/["\\]/g, "\\$&")}"`;
      }
      return `${k}=${v}`;
    });
  await Deno.writeTextFile(
    secretsPath,
    lines.join("\n") + (lines.length > 0 ? "\n" : ""),
  );
  // Clear from the live env so subsequent calls during this process lifetime
  // see "not connected."
  Deno.env.delete(name);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function stringOrNull(value: FormDataEntryValue | null): string | null {
  if (typeof value === "string") return value;
  return null;
}
