import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { PluginManager } from "../../src/plugins/mod.ts";

const FAKE_LLM = () => ({}) as never;

/**
 * Build a four-directory layout for testing both installed and bundled
 * discovery in one PluginManager:
 *
 *   <parent>/
 *     dataRoot/                              # arbitrary user data dir
 *       .psycheros/
 *         plugins/                           # installed plugin root
 *           <id>/
 *         plugin-state/                      # where bundled state lives
 *         plugin-secrets/                    # uniform secrets dir
 *     bundledRoot/                           # bundled plugin source root
 *       <id>/
 */
async function buildDualTree(): Promise<{
  dataRoot: string;
  bundledRoot: string;
  installedRoot: string;
}> {
  const parent = await Deno.makeTempDir({ prefix: "psycheros-dual-" });
  const dataRoot = join(parent, "data");
  const installedRoot = join(dataRoot, ".psycheros", "plugins");
  const bundledRoot = join(parent, "bundled-plugins");
  await Deno.mkdir(installedRoot, { recursive: true });
  await Deno.mkdir(bundledRoot, { recursive: true });
  return { dataRoot, bundledRoot, installedRoot };
}

async function writePluginAt(
  root: string,
  id: string,
  manifestExtras: Record<string, unknown> = {},
  entrypointSource = `export default {};`,
): Promise<void> {
  const directory = join(root, id);
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    join(directory, "plugin.json"),
    JSON.stringify({
      id,
      name: id,
      version: "1.0.0",
      apiVersion: 1,
      entrypoints: { psycheros: "./psycheros.ts" },
      ...manifestExtras,
    }),
  );
  await Deno.writeTextFile(join(directory, "psycheros.ts"), entrypointSource);
}

Deno.test("PluginManager discovers plugins from both bundled and installed roots", async () => {
  const { dataRoot, bundledRoot, installedRoot } = await buildDualTree();
  await writePluginAt(bundledRoot, "first-party-plugin", {
    capabilities: { settings: true },
  });
  await writePluginAt(installedRoot, "user-installed-plugin");

  const manager = new PluginManager(
    installedRoot,
    FAKE_LLM,
    bundledRoot,
    dataRoot,
  );
  await manager.load();
  try {
    const statuses = manager.getStatuses();
    const ids = statuses.map((s) => s.id).sort();
    assertEquals(ids, ["first-party-plugin", "user-installed-plugin"]);

    const firstParty = statuses.find((s) => s.id === "first-party-plugin");
    assertEquals(firstParty?.origin, "builtin");
    assertEquals(firstParty?.declaresSettings, true);

    const userInstalled = statuses.find((s) =>
      s.id === "user-installed-plugin"
    );
    assertEquals(userInstalled?.origin, "installed");
  } finally {
    await manager.stop();
  }
});

Deno.test("bundled plugin state path lives under dataRoot, not source tree", async () => {
  const { dataRoot, bundledRoot, installedRoot } = await buildDualTree();
  await writePluginAt(bundledRoot, "bundled-state");

  const manager = new PluginManager(
    installedRoot,
    FAKE_LLM,
    bundledRoot,
    dataRoot,
  );
  await manager.load();
  try {
    const services = manager.getServices("bundled-state");
    assertEquals(services !== undefined, true);
    // Bundled state path: <dataRoot>/.psycheros/plugin-state/<id>
    assertEquals(
      services!.statePath,
      join(dataRoot, ".psycheros", "plugin-state", "bundled-state"),
    );
  } finally {
    await manager.stop();
  }
});

Deno.test("installed plugin state path stays at <plugin-dir>/state (unchanged)", async () => {
  const { dataRoot, bundledRoot, installedRoot } = await buildDualTree();
  await writePluginAt(installedRoot, "installed-state");

  const manager = new PluginManager(
    installedRoot,
    FAKE_LLM,
    bundledRoot,
    dataRoot,
  );
  await manager.load();
  try {
    const services = manager.getServices("installed-state");
    assertEquals(services !== undefined, true);
    // Installed state path: <plugin-dir>/state (preserves existing behavior).
    assertEquals(
      services!.statePath,
      join(installedRoot, "installed-state", "state"),
    );
  } finally {
    await manager.stop();
  }
});

Deno.test("id collision: bundled plugin wins, installed copy is shadowed", async () => {
  const { dataRoot, bundledRoot, installedRoot } = await buildDualTree();
  // Both roots have a plugin with the same id.
  await writePluginAt(bundledRoot, "conflict", {
    description: "I am the bundled one",
  });
  await writePluginAt(installedRoot, "conflict", {
    description: "I am the installed one",
  });

  const manager = new PluginManager(
    installedRoot,
    FAKE_LLM,
    bundledRoot,
    dataRoot,
  );
  await manager.load();
  try {
    const statuses = manager.getStatuses();
    const conflict = statuses.find((s) => s.id === "conflict");
    assertEquals(conflict?.origin, "builtin");
    assertStringIncludes(
      conflict?.description ?? "",
      "I am the bundled one",
    );
  } finally {
    await manager.stop();
  }
});

Deno.test("secrets resolve to dataRoot-relative path for both origins", async () => {
  const { dataRoot, bundledRoot, installedRoot } = await buildDualTree();
  await writePluginAt(bundledRoot, "bundled-secret");
  await writePluginAt(installedRoot, "installed-secret");

  const manager = new PluginManager(
    installedRoot,
    FAKE_LLM,
    bundledRoot,
    dataRoot,
  );
  await manager.load();
  try {
    // Both plugins should be able to write secrets to the same directory:
    // <dataRoot>/.psycheros/plugin-secrets/<id>.env
    const bundled = manager.getServices("bundled-secret");
    const installed = manager.getServices("installed-secret");
    assertEquals(bundled !== undefined && installed !== undefined, true);

    await bundled!.writeSecret(
      "PSYCHEROS_PLUGIN_BUNDLED_SECRET_KEY",
      "bundling",
    );
    await installed!.writeSecret(
      "PSYCHEROS_PLUGIN_INSTALLED_SECRET_KEY",
      "installer",
    );

    // Both secrets files live under <dataRoot>/.psycheros/plugin-secrets/.
    const secretsDir = join(dataRoot, ".psycheros", "plugin-secrets");
    const bundledFile = await Deno.readTextFile(
      join(secretsDir, "bundled-secret.env"),
    );
    const installedFile = await Deno.readTextFile(
      join(secretsDir, "installed-secret.env"),
    );
    assertStringIncludes(bundledFile, "bundling");
    assertStringIncludes(installedFile, "installer");
  } finally {
    Deno.env.delete("PSYCHEROS_PLUGIN_BUNDLED_SECRET_KEY");
    Deno.env.delete("PSYCHEROS_PLUGIN_INSTALLED_SECRET_KEY");
    await manager.stop();
  }
});

Deno.test("bundled plugin with enabled:false stays inactive but is discoverable + configurable", async () => {
  const { dataRoot, bundledRoot, installedRoot } = await buildDualTree();
  await writePluginAt(
    bundledRoot,
    "opt-in-plugin",
    {
      enabled: false,
      capabilities: { settings: true },
    },
    `export default {
      settingsFragment: () => "<section>opt-in form</section>",
    };`,
  );

  const manager = new PluginManager(
    installedRoot,
    FAKE_LLM,
    bundledRoot,
    dataRoot,
  );
  await manager.load();
  try {
    // Discovered (appears in statuses)...
    const status = manager.getStatuses().find((s) => s.id === "opt-in-plugin");
    assertEquals(status?.origin, "builtin");
    assertEquals(status?.active, false);
    assertEquals(status?.enabled, false);
    assertEquals(status?.declaresSettings, true);

    // ...but reachable for configuration before enable.
    assertEquals(manager.hasSettings("opt-in-plugin"), true);
    const services = manager.getServices("opt-in-plugin");
    const fragment = await manager.renderSettingsFragment(
      "opt-in-plugin",
      {
        statePath: services!.statePath,
        env: services!.env,
        targetElementId: "test",
      },
    );
    assertStringIncludes(fragment, "opt-in form");
  } finally {
    await manager.stop();
  }
});

Deno.test("PluginManager without bundledRoot behaves as before (installed-only)", async () => {
  const parent = await Deno.makeTempDir({ prefix: "psycheros-legacy-" });
  const installedRoot = join(parent, "plugins");
  await Deno.mkdir(installedRoot, { recursive: true });
  await writePluginAt(installedRoot, "legacy-plugin");

  // 2-arg constructor: no bundledRoot, no dataRoot. Backward-compat.
  const manager = new PluginManager(installedRoot, FAKE_LLM);
  await manager.load();
  try {
    const statuses = manager.getStatuses();
    assertEquals(statuses.length, 1);
    // origin defaults to "installed" — bundledRoot absent means no bundled
    // discovery, so all plugins found are tagged installed.
    assertEquals(statuses[0].origin, "installed");
  } finally {
    await manager.stop();
  }
});
