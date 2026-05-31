import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  applyPluginEnv,
  getPluginEnvPath,
  isPluginSecretFilename,
  validatePluginDirectory,
  validatePluginManifest,
  validatePluginRelativePath,
} from "../src/mod.ts";
import { createPluginFixture } from "../src/testing.ts";

Deno.test("plugin manifest defaults enabled and validates relative assets", () => {
  const manifest = validatePluginManifest({
    id: "artifact-search",
    name: "Artifact Search",
    version: "1.0.0",
    apiVersion: 1,
    entrypoints: { psycheros: "./psycheros.ts" },
    browser: { scripts: ["./web/index.js"] },
  }, "artifact-search");

  assertEquals(manifest.enabled, true);
  assertEquals(manifest.browser?.scripts, ["./web/index.js"]);
});

Deno.test("portable plugin archives reject conventional credential files", () => {
  assertEquals(isPluginSecretFilename("speech/.env"), true);
  assertEquals(isPluginSecretFilename("speech/secrets.env"), true);
  assertEquals(isPluginSecretFilename("speech/secrets.json"), true);
  assertEquals(isPluginSecretFilename("speech/state/cache.json"), false);
});

Deno.test("plugin manifest id must match its directory", () => {
  assertThrows(() =>
    validatePluginManifest({
      id: "one",
      name: "One",
      version: "1.0.0",
      apiVersion: 1,
    }, "two")
  );
});

Deno.test("plugin paths reject traversal", () => {
  assertThrows(() => validatePluginRelativePath("./../outside.ts"));
  assertThrows(() => validatePluginRelativePath("web/index.js"));
});

Deno.test("plugin entrypoints allow TypeScript and JavaScript only", () => {
  assertThrows(() =>
    validatePluginManifest({
      id: "speech",
      name: "Speech",
      version: "1.0.0",
      apiVersion: 1,
      entrypoints: { psycheros: "./psycheros.mjs" },
    }, "speech")
  );
});

Deno.test("plugin directory validator checks declared files", async () => {
  const parent = await Deno.makeTempDir();
  const directory = join(parent, "speech");
  await Deno.mkdir(directory);
  await Deno.writeTextFile(
    join(directory, "plugin.json"),
    JSON.stringify({
      id: "speech",
      name: "Speech",
      version: "1.0.0",
      apiVersion: 1,
      entrypoints: { psycheros: "./psycheros.ts" },
    }),
  );
  await Deno.writeTextFile(
    join(directory, "psycheros.ts"),
    "export default {};",
  );
  assertEquals((await validatePluginDirectory(directory)).id, "speech");
  await Deno.remove(join(directory, "psycheros.ts"));
  await assertRejects(() => validatePluginDirectory(directory));
});

Deno.test("plugin env files apply temporarily outside the executable tree", async () => {
  const parent = await Deno.makeTempDir();
  const root = join(parent, "plugins");
  const secretPath = getPluginEnvPath(root, "speech");
  await Deno.mkdir(join(secretPath, ".."), { recursive: true });
  await Deno.writeTextFile(
    secretPath,
    "PSYCHEROS_PLUGIN_SPEECH_API_KEY=secret",
  );

  const applied = await applyPluginEnv(root, "speech");
  try {
    assertEquals(
      applied.env.require("PSYCHEROS_PLUGIN_SPEECH_API_KEY"),
      "secret",
    );
  } finally {
    applied.restore();
  }
  assertEquals(Deno.env.has("PSYCHEROS_PLUGIN_SPEECH_API_KEY"), false);
});

Deno.test("plugin fixture helper writes isolated code and secrets trees", async () => {
  const fixture = await createPluginFixture(
    {
      id: "speech-fixture",
      name: "Speech Fixture",
      version: "1.0.0",
      apiVersion: 1,
      entrypoints: { psycheros: "./psycheros.ts" },
    },
    { "psycheros.ts": "export default {};" },
    { PSYCHEROS_PLUGIN_SPEECH_FIXTURE_KEY: "test-only" },
  );

  assertEquals(
    await Deno.readTextFile(join(fixture.directory, "psycheros.ts")),
    "export default {};",
  );
  assertEquals(
    await Deno.readTextFile(
      join(fixture.secretsDirectory, "speech-fixture.env"),
    ),
    "PSYCHEROS_PLUGIN_SPEECH_FIXTURE_KEY=test-only",
  );
});
