/**
 * HTTP endpoints for my in-app trusted plugin manager.
 */

import { type PluginInstaller, PluginInstallerError } from "../plugins/mod.ts";

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
