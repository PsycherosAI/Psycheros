import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import JSZip from "jszip";
import { emptyPluginCapabilityCounts } from "../../plugin-api/src/mod.ts";
import { PluginInstaller, PluginInstallerError } from "../src/plugins/mod.ts";
import {
  handleInspectPluginGit,
  handleInspectPluginZip,
  handleInstallPluginDraft,
  handleRemoveInstalledPlugin,
} from "../src/server/plugin-manager-routes.ts";

function pluginManifest(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: id,
    version: "1.0.0",
    apiVersion: 1,
    description: "Adds a test plugin.",
    compatibility: { psycheros: ">=0.0.1" },
    dependencies: { "example.shared": "^1.0.0" },
    entrypoints: { psycheros: "./psycheros.ts" },
    ...overrides,
  };
}

async function zipPackage(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) {
    zip.file(path, content);
  }
  return await zip.generateAsync({ type: "uint8array" });
}

function statusFixture(id: string) {
  return {
    id,
    name: id,
    version: "1.0.0",
    enabled: true,
    active: true,
    degraded: false,
    restartRequired: false,
    entrypoints: { psycheros: true, entityCore: false },
    capabilities: emptyPluginCapabilityCounts(),
  };
}

Deno.test("plugin installer stages singleton zip packages and installs drafts", async () => {
  const dataRoot = await Deno.makeTempDir({ prefix: "psycheros-plugin-ui-" });
  const installer = new PluginInstaller(dataRoot);
  const bytes = await zipPackage({
    "wrapped/plugin.json": JSON.stringify(pluginManifest("wrapped-plugin")),
    "wrapped/psycheros.ts": "export default {};",
  });

  const preview = await installer.inspectZip(bytes, "wrapped.zip");
  assertEquals(preview.manifest.id, "wrapped-plugin");
  assertEquals(preview.source.type, "zip");
  assertEquals(preview.restartRequired, true);
  assertStringIncludes(preview.warnings.join("\n"), "dependencies");
  assert(
    await Deno.stat(
      join(
        dataRoot,
        ".psycheros",
        "plugin-staging",
        preview.draftId,
        "wrapped-plugin",
        "plugin.json",
      ),
    ),
  );

  const result = await installer.installDraft(preview.draftId);
  assertEquals(result.pluginId, "wrapped-plugin");
  assert(
    await Deno.stat(
      join(dataRoot, ".psycheros", "plugins", "wrapped-plugin", "plugin.json"),
    ),
  );

  const statuses = await installer.enrichStatuses([]);
  assertEquals(statuses[0].id, "wrapped-plugin");
  assertEquals(statuses[0].pendingAction, "install");
  assertEquals(statuses[0].restartRequired, true);
});

Deno.test("plugin installer rejects traversal, secret files, and missing entrypoints", async () => {
  const dataRoot = await Deno.makeTempDir({ prefix: "psycheros-plugin-ui-" });
  const installer = new PluginInstaller(dataRoot);

  await assertRejects(
    async () =>
      await installer.inspectZip(
        await zipPackage({
          "../plugin.json": JSON.stringify(pluginManifest("escape-plugin")),
          "../psycheros.ts": "export default {};",
        }),
        "escape.zip",
      ),
    PluginInstallerError,
  );

  await assertRejects(
    async () =>
      await installer.inspectZip(
        await zipPackage({
          "plugin.json": JSON.stringify(pluginManifest("secret-plugin")),
          "psycheros.ts": "export default {};",
          ".env": "API_KEY=secret",
        }),
        "secret.zip",
      ),
    PluginInstallerError,
    "secret",
  );

  await assertRejects(
    async () =>
      await installer.inspectZip(
        await zipPackage({
          "plugin.json": JSON.stringify(pluginManifest("missing-plugin")),
        }),
        "missing.zip",
      ),
    PluginInstallerError,
  );
});

Deno.test("plugin installer backs up code on remove and leaves secrets in place", async () => {
  const dataRoot = await Deno.makeTempDir({ prefix: "psycheros-plugin-ui-" });
  const installer = new PluginInstaller(dataRoot);
  const preview = await installer.inspectZip(
    await zipPackage({
      "plugin.json": JSON.stringify(pluginManifest("remove-plugin")),
      "psycheros.ts": "export default {};",
    }),
    "remove.zip",
  );
  await installer.installDraft(preview.draftId);
  await Deno.mkdir(join(dataRoot, ".psycheros", "plugin-secrets"), {
    recursive: true,
  });
  await Deno.writeTextFile(
    join(dataRoot, ".psycheros", "plugin-secrets", "remove-plugin.env"),
    "PSYCHEROS_PLUGIN_REMOVE_KEY=secret",
  );

  const removed = await installer.removePlugin("remove-plugin");
  assertEquals(removed.pluginId, "remove-plugin");
  assert(
    await Deno.stat(join(removed.backupPath, "plugin.json")),
  );
  assertEquals(
    await Deno.readTextFile(
      join(dataRoot, ".psycheros", "plugin-secrets", "remove-plugin.env"),
    ),
    "PSYCHEROS_PLUGIN_REMOVE_KEY=secret",
  );

  const statuses = await installer.enrichStatuses([
    statusFixture("remove-plugin"),
  ]);
  assertEquals(statuses[0].pendingAction, "remove");
  assertEquals(statuses[0].restartRequired, true);
});

Deno.test("plugin manager routes inspect install remove and report failures", async () => {
  const dataRoot = await Deno.makeTempDir({ prefix: "psycheros-plugin-ui-" });
  const installer = new PluginInstaller(dataRoot);
  const formData = new FormData();
  const routeBytes = await zipPackage({
    "plugin.json": JSON.stringify(pluginManifest("route-plugin")),
    "psycheros.ts": "export default {};",
  });
  formData.set(
    "plugin",
    new File(
      [
        routeBytes.buffer as ArrayBuffer,
      ],
      "route.zip",
      { type: "application/zip" },
    ),
  );

  const inspectResponse = await handleInspectPluginZip(
    installer,
    new Request("http://localhost/api/plugin-manager/inspect-zip", {
      method: "POST",
      body: formData,
    }),
  );
  assertEquals(inspectResponse.status, 200);
  const inspectBody = await inspectResponse.json();
  assertEquals(inspectBody.success, true);

  const installResponse = await handleInstallPluginDraft(
    installer,
    new Request("http://localhost/api/plugin-manager/install-draft", {
      method: "POST",
      body: JSON.stringify({ draftId: inspectBody.preview.draftId }),
    }),
  );
  assertEquals(installResponse.status, 200);
  assertEquals((await installResponse.json()).pluginId, "route-plugin");

  const removeResponse = await handleRemoveInstalledPlugin(
    installer,
    "route-plugin",
  );
  assertEquals(removeResponse.status, 200);
  assertEquals((await removeResponse.json()).pluginId, "route-plugin");

  const gitFailure = await handleInspectPluginGit(
    installer,
    new Request("http://localhost/api/plugin-manager/inspect-git", {
      method: "POST",
      body: JSON.stringify({ repoUrl: "" }),
    }),
  );
  assertEquals(gitFailure.status, 400);

  const missingRemove = await handleRemoveInstalledPlugin(installer, "missing");
  assertEquals(missingRemove.status, 404);
});
