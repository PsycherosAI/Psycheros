/**
 * HTTP endpoints for my in-app trusted plugin manager.
 */

import { basename } from "@std/path";
import {
  applyPluginUpdate,
  checkPluginUpdate,
  type PluginInstaller,
  PluginInstallerError,
  type PluginManager,
  UpdateCheckError,
} from "../plugins/mod.ts";

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

function errorResponse(error: unknown): Response {
  if (error instanceof PluginInstallerError) {
    return json({ success: false, error: error.message }, error.status);
  }
  const message = error instanceof Error ? error.message : String(error);
  return json({ success: false, error: message }, 500);
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PluginInstallerError("Could not read that plugin request.");
  }
  return body as Record<string, unknown>;
}

export async function handleInspectPluginZip(
  installer: PluginInstaller,
  request: Request,
): Promise<Response> {
  try {
    const formData = await request.formData();
    const file = formData.get("plugin") ?? formData.get("zip");
    if (!(file instanceof File)) {
      throw new PluginInstallerError("A plugin zip file is required.");
    }
    if (!file.name.toLowerCase().endsWith(".zip")) {
      throw new PluginInstallerError(
        "Only plugin zip files are accepted here.",
      );
    }
    if (file.size === 0) {
      throw new PluginInstallerError(
        "Could not inspect an empty plugin zip.",
      );
    }
    const preview = await installer.inspectZip(
      new Uint8Array(await file.arrayBuffer()),
      file.name,
    );
    return json({ success: true, preview });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleInspectPluginGit(
  installer: PluginInstaller,
  request: Request,
): Promise<Response> {
  try {
    const body = await readJsonObject(request);
    const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl : "";
    const ref = typeof body.ref === "string" ? body.ref : undefined;
    const preview = await installer.inspectGit(repoUrl, ref);
    return json({ success: true, preview });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleInstallPluginDraft(
  installer: PluginInstaller,
  request: Request,
): Promise<Response> {
  try {
    const body = await readJsonObject(request);
    const draftId = typeof body.draftId === "string" ? body.draftId : "";
    const result = await installer.installDraft(draftId);
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleRemoveInstalledPlugin(
  installer: PluginInstaller,
  encodedId: string,
): Promise<Response> {
  try {
    const result = await installer.removePlugin(decodeURIComponent(encodedId));
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Aggregate plugin health summary for the Plugins Settings health card.
 * Pulls together counts, last-turn budget accounting, denied-env-var
 * totals, and the most recent failure per plugin so the UI can render an
 * at-a-glance view without N+1 plugin-detail fetches.
 */
export function handlePluginManagerHealth(manager: PluginManager): Response {
  const statuses = manager.getStatuses();
  const budget = manager.getLastBudgetReport();
  const counts = {
    total: statuses.length,
    active: statuses.filter((s) => s.active).length,
    degraded: statuses.filter((s) => s.degraded).length,
    pendingRestart: statuses.filter((s) => s.restartRequired).length,
    disabled: statuses.filter((s) => !s.enabled).length,
  };
  // Surface denied env vars across all plugins (sum of warn events in the
  // env category over the ring buffer). Captured per-plugin in the buffer
  // so the UI can show "plugin X tried to set HTTP_PROXY" drill-downs.
  const deniedEnv: Array<
    { pluginId: string; names: string[]; timestamp: string }
  > = [];
  for (const status of statuses) {
    for (const event of manager.getRecentEvents(status.id)) {
      if (event.category === "env" && event.details?.names) {
        deniedEnv.push({
          pluginId: status.id,
          timestamp: event.timestamp,
          names: event.details.names as string[],
        });
      }
    }
  }
  return json({
    success: true,
    counts,
    lastBudget: budget,
    deniedEnvVars: deniedEnv,
  });
}

/**
 * Recent in-memory events for one plugin — feeds the per-plugin "Recent
 * activity" panel. The optional `limit` query param caps the response;
 * without it the full ring buffer (default 200 events) is returned.
 *
 * Note: this reads the in-memory ring buffer only. For the full file
 * history, use `handlePluginLogDownload`.
 */
export function handlePluginEvents(
  manager: PluginManager,
  encodedId: string,
  url: URL,
): Response {
  const pluginId = decodeURIComponent(encodedId);
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw
    ? Math.max(1, Math.min(500, parseInt(limitRaw, 10)))
    : undefined;
  let events = manager.getRecentEvents(pluginId);
  if (limit !== undefined && events.length > limit) {
    events = events.slice(events.length - limit);
  }
  return json({
    success: true,
    pluginId,
    events,
    logPath: manager.getEventLogPath(pluginId),
  });
}

/**
 * Serve a plugin's plain-text log file as a downloadable attachment. The
 * file is the one users paste into support chats, so Content-Disposition
 * forces a download with a sensible filename rather than inline rendering
 * (which a browser may try to reflow). Returns 404 when no events have
 * been written yet — the UI shouldn't offer a download button in that
 * case, but this defends against direct fetches.
 */
export async function handlePluginLogDownload(
  manager: PluginManager,
  encodedId: string,
): Promise<Response> {
  const pluginId = decodeURIComponent(encodedId);
  const logPath = manager.getEventLogPath(pluginId);
  try {
    const content = await Deno.readTextFile(logPath);
    return new Response(content, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${basename(logPath)}"`,
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return json(
        { success: false, error: "No log file exists yet for this plugin." },
        404,
      );
    }
    return errorResponse(error);
  }
}

/**
 * Check a single plugin for an available update via its declared
 * `update.repoUrl`. Reads the manifest fresh from disk so the check works
 * even before PluginManager.load() has run. Returns a structured result
 * the UI renders inline; check-level failures (no repoUrl, unsupported
 * host, rate limit, network) come back as 200 with `success: true, result:
 * { ..., reason: ... }` rather than 4xx/5xx — they're legitimate outcomes
 * of the check, not request failures.
 */
export async function handlePluginCheckUpdate(
  pluginRoot: string,
  encodedId: string,
): Promise<Response> {
  const pluginId = decodeURIComponent(encodedId);
  const result = await checkPluginUpdate(pluginRoot, pluginId);
  return json({ success: true, pluginId, result });
}

/**
 * Apply a previously-checked update. Body: `{ tag, repoUrl }` — both come
 * straight from the prior check-update response, so the UI just hands them
 * back. Hands off to PluginInstaller which handles backup + atomic replace
 * + restartRequired. Refuses if the update target's manifest id doesn't
 * match the installed plugin id — defends against a tag pointing at a
 * renamed/forked repo.
 */
export async function handlePluginApplyUpdate(
  installer: PluginInstaller,
  encodedId: string,
  request: Request,
): Promise<Response> {
  try {
    const pluginId = decodeURIComponent(encodedId);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return json({ success: false, error: "Request body required." }, 400);
    }
    const { tag, repoUrl } = body as { tag?: string; repoUrl?: string };
    if (typeof tag !== "string" || typeof repoUrl !== "string") {
      return json({
        success: false,
        error: "Body must include 'tag' and 'repoUrl'.",
      }, 400);
    }
    const result = await applyPluginUpdate(installer, pluginId, tag, repoUrl);
    return json({
      success: true,
      pluginId,
      backupPath: result.backupPath,
      restartRequired: true,
    });
  } catch (error) {
    if (error instanceof UpdateCheckError) {
      return json({ success: false, error: error.message }, 400);
    }
    return errorResponse(error);
  }
}
