/**
 * HTTP routes for the Google Suite plugin's settings UI + OAuth callback.
 *
 * All mounted under `/api/plugins/google-suite/*` by PluginManager. Each
 * handler receives `(request, services)` and returns a Response — either
 * JSON (for status endpoints), HTML fragment (for HTMX swaps), or a full HTML
 * page (for the OAuth callback result shown in the browser).
 *
 * Module-level state:
 *   - `flowState` tracks an in-progress OAuth flow so /start-oauth can be
 *     idempotent (second call while first is in flight = rejected).
 *   - `lastError` surfaces the most recent flow failure to /oauth-status
 *     polling for the "Connection failed: ..." UI message.
 *   - `pendingAuthUrl` holds the Google consent URL between /start-oauth
 *     (generates it) and /oauth-status (surfaces it to the UI for the
 *     operator to click).
 *
 * OAuth callback design: Google redirects back to
 * `GET /api/plugins/google-suite/oauth-callback?code=...&state=...`
 * which is handled by `handleOauthCallback`. This route serves a full HTML
 * page to the operator's browser showing success/failure — no HTMX swap,
 * just a standalone page they see after completing Google sign-in.
 */

import type {
  PluginRoute,
  PsycherosPluginServices,
} from "../../../src/plugins/plugin-manager.ts";
import { enabledServices, loadConfig, saveConfig } from "./config.ts";
import { completeFlow, prepareAuthUrl } from "./oauth/flow.ts";
import { revokeToken } from "./oauth/refresh.ts";
import { missingScopes } from "./oauth/scopes.ts";

const SECRET_PREFIX = "PSYCHEROS_PLUGIN_GOOGLE_SUITE_";
const CLIENT_ID_KEY = `${SECRET_PREFIX}CLIENT_ID`;
const CLIENT_SECRET_KEY = `${SECRET_PREFIX}CLIENT_SECRET`;
const REFRESH_TOKEN_KEY = `${SECRET_PREFIX}REFRESH_TOKEN`;

// Module-level state for in-progress OAuth flows.
interface FlowState {
  inProgress: boolean;
  startedAt?: number;
  lastError?: string;
  /** Google consent URL — surfaced as a clickable link in the status UI. */
  authUrl?: string;
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
    method: "GET",
    path: "/oauth-callback",
    handler: handleOauthCallback,
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
    // Show the clickable auth link while the flow is waiting for the callback.
    const linkHtml = flowState.authUrl
      ? `<div style="margin-top: var(--sp-2); padding: var(--sp-2); background: var(--c-surface-2, #f0f0f0); border-radius: 4px;">
           <p style="margin: 0 0 var(--sp-1) 0; font-weight: 600;">Click here to sign in with Google:</p>
           <a href="${
        escapeAttr(flowState.authUrl)
      }" target="_blank" rel="noopener" style="color: var(--c-accent); word-break: break-all; font-size: 0.9em;">${
        escapeHtml(flowState.authUrl)
      }</a>
         </div>`
      : "";
    return html(
      `<p class="settings-note">Waiting for Google sign-in to complete...</p>${linkHtml}
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

/**
 * Derive the callback URL from the incoming request. The operator reaches
 * Psycheros's server at some origin (e.g. http://voyager.local:3000 or
 * https://echo.example.com). The OAuth callback must route back to that same
 * origin so Google's redirect lands on this server.
 *
 * Uses the Origin header first (set by proxies like Cloudflare/Nginx), then
 * falls back to constructing from Host + protocol.
 */
function deriveCallbackUrl(request: Request): string {
  // Try standard reverse-proxy headers first
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (forwardedHost) {
    const proto = forwardedProto ?? "https";
    return `${proto}://${forwardedHost}/api/plugins/google-suite/oauth-callback`;
  }

  // Try the Origin header
  const origin = request.headers.get("origin");
  if (origin) {
    return `${origin}/api/plugins/google-suite/oauth-callback`;
  }

  // Fall back to Host header
  const host = request.headers.get("host");
  if (host) {
    // Assume https if standard ports aren't present, http if port 3000
    const isLocalDev = host.includes(":3000") || host.includes("localhost") ||
      host.includes("127.0.0.1");
    const proto = forwardedProto ?? (isLocalDev ? "http" : "https");
    return `${proto}://${host}/api/plugins/google-suite/oauth-callback`;
  }

  // Last-resort fallback (shouldn't happen in practice)
  return "http://localhost:3000/api/plugins/google-suite/oauth-callback";
}

async function handleStartOauth(
  request: Request,
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
    // Re-surface the existing auth URL rather than saying "check your browser"
    const linkHtml = flowState.authUrl
      ? `<div style="margin-top: var(--sp-2); padding: var(--sp-2); background: var(--c-surface-2, #f0f0f0); border-radius: 4px;">
           <p style="margin: 0 0 var(--sp-1) 0; font-weight: 600;">Click here to sign in with Google:</p>
           <a href="${
        escapeAttr(flowState.authUrl)
      }" target="_blank" rel="noopener" style="color: var(--c-accent); word-break: break-all; font-size: 0.9em;">${
        escapeHtml(flowState.authUrl)
      }</a>
         </div>`
      : "";
    return html(
      `<p class="settings-note">Authorization flow is in progress. Complete sign-in via the link below:</p>${linkHtml}
       <div hx-get="/api/plugins/google-suite/oauth-status" hx-trigger="every 3s" hx-target="#gs-connect-status" hx-swap="innerHTML"></div>`,
    );
  }

  const config = await loadConfig(services.statePath);
  const enabled = enabledServices(config);

  // Derive the callback URL from the request origin so Google redirects
  // back to this server, not to a loopback address inside a container.
  const redirectUri = deriveCallbackUrl(request);

  let prepared;
  try {
    prepared = await prepareAuthUrl({
      clientId,
      enabledServices: enabled,
      statePath: services.statePath,
      redirectUri,
    });
  } catch (error) {
    flowState.lastError = error instanceof Error
      ? error.message
      : String(error);
    return html(
      `<p class="settings-note" style="color: var(--c-error);">Failed to start OAuth flow: ${flowState.lastError}</p>`,
    );
  }

  flowState.inProgress = true;
  flowState.startedAt = Date.now();
  flowState.lastError = undefined;
  flowState.authUrl = prepared.authUrl;

  return html(
    `<div style="padding: var(--sp-2); background: var(--c-surface-2, #f0f0f0); border-radius: 4px;">
       <p style="margin: 0 0 var(--sp-1) 0; font-weight: 600;">Click here to open Google sign-in:</p>
       <a href="${
      escapeAttr(prepared.authUrl)
    }" target="_blank" rel="noopener" style="color: var(--c-accent); word-break: break-all; font-size: 0.9em;">${
      escapeHtml(prepared.authUrl)
    }</a>
       <p style="margin: var(--sp-1) 0 0 0; font-size: 0.85em; color: var(--c-text-muted);">Complete sign-in in the new tab — this page refreshes automatically when done.</p>
     </div>
     <div hx-get="/api/plugins/google-suite/oauth-status" hx-trigger="every 3s" hx-target="#gs-connect-status" hx-swap="innerHTML"></div>`,
  );
}

/**
 * OAuth callback handler — Google redirects here after the operator completes
 * (or denies) the consent flow. Returns a full HTML page (not an HTMX fragment)
 * because this URL is opened in the operator's browser, not swapped into the
 * settings panel.
 *
 * On success, completes the token exchange in-line. The settings UI's polling
 * will pick up the new connected state within 3 seconds.
 */
async function handleOauthCallback(
  request: Request,
  services: PsycherosPluginServices,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // Google returned an OAuth error (user denied, etc.)
  if (error) {
    const errorDesc = url.searchParams.get("error_description") ?? "";
    flowState.inProgress = false;
    flowState.lastError = `${error}: ${errorDesc}`;
    return fullPage(
      "Connection failed",
      `<div class="x">\u00d7</div>`,
      `<p>Google returned an error: <code>${escapeHtml(error)}</code></p>` +
        (errorDesc ? `<p>${escapeHtml(errorDesc)}</p>` : "") +
        `<p>Close this tab and try again from Psycheros.</p>`,
    );
  }

  if (!code || !state) {
    return fullPage(
      "Connection failed",
      `<div class="x">\u00d7</div>`,
      `<p>Missing authorization code or state parameter.</p>`,
    );
  }

  const clientSecret = services.env.get(CLIENT_SECRET_KEY);
  if (!clientSecret) {
    return fullPage(
      "Connection failed",
      `<div class="x">\u00d7</div>`,
      `<p>Client secret is not configured. Close this tab and re-enter your credentials in Psycheros settings.</p>`,
    );
  }

  try {
    const result = await completeFlow({
      code,
      state,
      clientSecret,
      statePath: services.statePath,
      writeRefreshToken: (token) =>
        services.writeSecret(REFRESH_TOKEN_KEY, token),
    });

    if (result.success) {
      const refreshed = await loadConfig(services.statePath);
      await saveConfig(services.statePath, {
        ...refreshed,
        connectedEmail: result.email,
        grantedScopes: result.grantedScopes ?? [],
      });
      flowState.inProgress = false;
      flowState.lastError = undefined;
      flowState.authUrl = undefined;
      return fullPage(
        "Connected",
        `<div class="check">\u2713</div>`,
        `<h1>Connected</h1><p>Connected as <strong>${
          escapeHtml(result.email ?? "?")
        }</strong>. You can close this tab and return to Psycheros.</p>`,
      );
    } else {
      flowState.inProgress = false;
      flowState.lastError = result.error;
      return fullPage(
        "Connection failed",
        `<div class="x">\u00d7</div>`,
        `<p>${escapeHtml(result.error ?? "Unknown error")}</p>`,
      );
    }
  } catch (error) {
    flowState.inProgress = false;
    const msg = error instanceof Error ? error.message : String(error);
    flowState.lastError = msg;
    return fullPage(
      "Connection failed",
      `<div class="x">\u00d7</div>`,
      `<p>${escapeHtml(msg)}</p>`,
    );
  }
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
  flowState.inProgress = false;
  flowState.authUrl = undefined;

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
 * Re-write the plugin's secrets file without the named key.
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
      if (/[\s#"\']/.test(v)) {
        return `${k}="${v.replace(/["\\]/g, "\\$&")}"`;
      }
      return `${k}=${v}`;
    });
  await Deno.writeTextFile(
    secretsPath,
    lines.join("\n") + (lines.length > 0 ? "\n" : ""),
  );
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

/** Full standalone HTML page — for OAuth callback results shown in-browser. */
function fullPage(title: string, icon: string, bodyContent: string): Response {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; text-align: center; padding: 4rem 1rem; color: #1a1a1a; }
    h1 { font-weight: 500; }
    .check { font-size: 4rem; color: #22c55e; }
    .x { font-size: 4rem; color: #ef4444; }
    code { background: #f3f4f6; padding: 0.2em 0.4em; border-radius: 3px; }
  </style>
</head>
<body>
  ${icon}
  ${bodyContent}
</body>
</html>`,
    {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}

function stringOrNull(value: FormDataEntryValue | null): string | null {
  if (typeof value === "string") return value;
  return null;
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
