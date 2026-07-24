import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { PluginManager } from "../../src/plugins/mod.ts";

/**
 * Helpers for building minimal plugin trees on disk. The standard
 * createPluginFixture in plugin-api assumes the historical pluginRoot layout;
 * for these tests we want explicit control over the plugin's contents and
 * where it lives.
 */
async function writePlugin(
  root: string,
  id: string,
  manifest: Record<string, unknown>,
  entrypointSource: string,
): Promise<void> {
  const directory = join(root, id);
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    join(directory, "plugin.json"),
    JSON.stringify({ id, apiVersion: 1, ...manifest }),
  );
  await Deno.writeTextFile(join(directory, "psycheros.ts"), entrypointSource);
}

const FAKE_LLM = () => ({}) as never;

Deno.test("hasSettings returns true for plugin declaring capabilities.settings", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-test-" });
  await writePlugin(
    root,
    "with-settings",
    {
      name: "With Settings",
      version: "1.0.0",
      enabled: false,
      entrypoints: { psycheros: "./psycheros.ts" },
      capabilities: { settings: true },
    },
    `export default {
      settingsFragment: () => "<section>my form</section>",
    };`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    assertEquals(manager.hasSettings("with-settings"), true);
    assertEquals(manager.hasSettings("nonexistent"), false);
  } finally {
    await manager.stop();
  }
});

Deno.test("hasSettings returns false when manifest omits capabilities.settings", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-test-" });
  await writePlugin(
    root,
    "no-settings",
    {
      name: "No Settings",
      version: "1.0.0",
      enabled: false,
      entrypoints: { psycheros: "./psycheros.ts" },
    },
    `export default {};`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    assertEquals(manager.hasSettings("no-settings"), false);
  } finally {
    await manager.stop();
  }
});

Deno.test("renderSettingsFragment works for disabled plugins (operator configures before enabling)", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-test-" });
  await writePlugin(
    root,
    "disabled-plugin",
    {
      name: "Disabled",
      version: "1.0.0",
      enabled: false, // explicit
      entrypoints: { psycheros: "./psycheros.ts" },
      capabilities: { settings: true },
    },
    `export default {
      settingsFragment: (ctx) => \`<section data-target="\${ctx.targetElementId}">form for \${ctx.statePath}</section>\`,
    };`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    // Plugin stays inactive (enabled: false in manifest) — but we can still
    // render its settings form. This is what the settings route relies on
    // so operators can configure credentials BEFORE enabling.
    const statuses = manager.getStatuses();
    const status = statuses.find((s) => s.id === "disabled-plugin");
    assertEquals(status?.active, false);
    assertEquals(status?.declaresSettings, true);

    const services = manager.getServices("disabled-plugin");
    assertEquals(services !== undefined, true);

    const fragment = await manager.renderSettingsFragment(
      "disabled-plugin",
      {
        statePath: services!.statePath,
        env: services!.env,
        targetElementId: "test-target",
      },
    );
    assertStringIncludes(fragment, "form for ");
    assertStringIncludes(fragment, "test-target");
  } finally {
    await manager.stop();
  }
});

Deno.test("renderSettingsFragment throws clear error when entrypoint lacks settingsFragment export", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-test-" });
  await writePlugin(
    root,
    "missing-export",
    {
      name: "Missing Export",
      version: "1.0.0",
      enabled: true,
      entrypoints: { psycheros: "./psycheros.ts" },
      capabilities: { settings: true },
    },
    `export default {};`, // declares settings but doesn't export settingsFragment
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    const services = manager.getServices("missing-export");
    assertEquals(services !== undefined, true);
    await assertRejects(
      () =>
        manager.renderSettingsFragment("missing-export", {
          statePath: services!.statePath,
          env: services!.env,
          targetElementId: "test-target",
        }),
      Error,
      "does not export settingsFragment",
    );
  } finally {
    await manager.stop();
  }
});

Deno.test("renderSettingsFragment throws for unknown plugin id", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-test-" });
  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    await assertRejects(
      () =>
        manager.renderSettingsFragment("does-not-exist", {
          statePath: "/tmp",
          env: {
            get: () => undefined,
            has: () => false,
            require: () => "",
          },
          targetElementId: "test",
        }),
      Error,
      "unknown plugin",
    );
  } finally {
    await manager.stop();
  }
});

Deno.test("writeSecret rejects names that don't match PSYCHEROS_PLUGIN_<ID>_* prefix", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-test-" });
  await writePlugin(
    root,
    "secret-test",
    {
      name: "Secret Test",
      version: "1.0.0",
      enabled: true,
      entrypoints: { psycheros: "./psycheros.ts" },
    },
    `export default {};`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    const services = manager.getServices("secret-test");
    assertEquals(services !== undefined, true);

    // Wrong: doesn't match prefix at all.
    await assertRejects(
      () => services!.writeSecret("FOO_BAR", "value"),
      Error,
      "must match",
    );
    // Wrong: prefix is for a different plugin id.
    await assertRejects(
      () =>
        services!.writeSecret(
          "PSYCHEROS_PLUGIN_OTHER_PLUGIN_KEY",
          "value",
        ),
      Error,
      "must match",
    );
    // Wrong: empty value.
    await assertRejects(
      () => services!.writeSecret("PSYCHEROS_PLUGIN_SECRET_TEST_KEY", ""),
      Error,
      "non-empty",
    );
  } finally {
    await manager.stop();
  }
});

Deno.test("writeSecret round-trips: write → readSecrets → env.get sees live value", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-test-" });
  await writePlugin(
    root,
    "round-trip",
    {
      name: "Round Trip",
      version: "1.0.0",
      enabled: true,
      entrypoints: { psycheros: "./psycheros.ts" },
    },
    `export default {};`,
  );

  const manager = new PluginManager(root, FAKE_LLM);
  await manager.load();
  try {
    const services = manager.getServices("round-trip");
    assertEquals(services !== undefined, true);

    // Initially empty.
    assertEquals(await services!.readSecrets(), {});

    // Write a secret.
    await services!.writeSecret(
      "PSYCHEROS_PLUGIN_ROUND_TRIP_TOKEN",
      "abc123",
    );

    // readSecrets returns it.
    const secrets = await services!.readSecrets();
    assertEquals(secrets.PSYCHEROS_PLUGIN_ROUND_TRIP_TOKEN, "abc123");

    // Live env sees it without a restart.
    assertEquals(
      services!.env.get("PSYCHEROS_PLUGIN_ROUND_TRIP_TOKEN"),
      "abc123",
    );

    // Update preserves other keys and overwrites the one written.
    await services!.writeSecret(
      "PSYCHEROS_PLUGIN_ROUND_TRIP_SECOND",
      "def456",
    );
    const after = await services!.readSecrets();
    assertEquals(after.PSYCHEROS_PLUGIN_ROUND_TRIP_TOKEN, "abc123");
    assertEquals(after.PSYCHEROS_PLUGIN_ROUND_TRIP_SECOND, "def456");
  } finally {
    // Clean up env vars so they don't leak across tests.
    Deno.env.delete("PSYCHEROS_PLUGIN_ROUND_TRIP_TOKEN");
    Deno.env.delete("PSYCHEROS_PLUGIN_ROUND_TRIP_SECOND");
    await manager.stop();
  }
});
