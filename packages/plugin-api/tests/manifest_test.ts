import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  applyPluginEnv,
  contentTypeMatchesGlob,
  getPluginEnvPath,
  isDeniedPluginEnvVar,
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

Deno.test("plugin manifest accepts review metadata", () => {
  const manifest = validatePluginManifest({
    id: "artifact-search",
    name: "Artifact Search",
    version: "1.0.0",
    apiVersion: 1,
    description: "Adds artifact lookup.",
    homepage_url: "https://example.test/artifact-search",
    compatibility: {
      psycheros: ">=0.8.20 <0.9.0",
      entity_core: ">=0.4.5",
      launcher: ">=0.2.42",
    },
    update: {
      repo_url: "https://github.com/example/artifact-search",
      tag_prefix: "v",
    },
    dependencies: {
      "example.shared": "^1.0.0",
    },
    entrypoints: { psycheros: "./psycheros.ts" },
  }, "artifact-search");

  assertEquals(manifest.description, "Adds artifact lookup.");
  assertEquals(manifest.homepageUrl, "https://example.test/artifact-search");
  assertEquals(manifest.compatibility?.entityCore, ">=0.4.5");
  assertEquals(
    manifest.update?.repoUrl,
    "https://github.com/example/artifact-search",
  );
  assertEquals(manifest.update?.tagPrefix, "v");
  assertEquals(manifest.dependencies?.["example.shared"], "^1.0.0");
});

Deno.test("plugin manifest rejects invalid review metadata", () => {
  const base = {
    id: "artifact-search",
    name: "Artifact Search",
    version: "1.0.0",
    apiVersion: 1,
    entrypoints: { psycheros: "./psycheros.ts" },
  };

  assertThrows(() =>
    validatePluginManifest({
      ...base,
      compatibility: ">=0.8.20",
    }, "artifact-search")
  );
  assertThrows(() =>
    validatePluginManifest({
      ...base,
      update: { repo_url: 5 },
    }, "artifact-search")
  );
  assertThrows(() =>
    validatePluginManifest({
      ...base,
      dependencies: { "example.shared": 5 },
    }, "artifact-search")
  );
});

Deno.test("plugin manifest parses capabilities.settings flag", () => {
  const base = {
    id: "calendar-caldav",
    name: "Calendar (CalDAV)",
    version: "0.1.0",
    apiVersion: 1,
    entrypoints: { psycheros: "./psycheros.ts" },
  };

  // Declared true → surfaced as true.
  const enabled = validatePluginManifest({
    ...base,
    capabilities: { settings: true },
  }, "calendar-caldav");
  assertEquals(enabled.capabilities?.settings, true);

  // Declared false → surfaced as false (distinct from undefined).
  const disabled = validatePluginManifest({
    ...base,
    capabilities: { settings: false },
  }, "calendar-caldav");
  assertEquals(disabled.capabilities?.settings, false);

  // Omitted entirely → undefined.
  const omitted = validatePluginManifest(base, "calendar-caldav");
  assertEquals(omitted.capabilities, undefined);

  // Wrong shape → rejected.
  assertThrows(() =>
    validatePluginManifest({
      ...base,
      capabilities: "yes",
    }, "calendar-caldav")
  );
});

Deno.test("plugin manifest accepts apiVersion 2 with discordMedia capability", () => {
  const base = {
    id: "discord-media",
    name: "Discord Media",
    version: "1.0.0",
    entrypoints: { psycheros: "./psycheros.ts" },
  };

  const manifest = validatePluginManifest({
    ...base,
    apiVersion: 2,
    capabilities: {
      discordMedia: {
        attachmentTypes: ["audio/*", "image/gif"],
        send: true,
      },
    },
  }, "discord-media");

  assertEquals(manifest.apiVersion, 2);
  assertEquals(manifest.capabilities?.discordMedia?.attachmentTypes, [
    "audio/*",
    "image/gif",
  ]);
  assertEquals(manifest.capabilities?.discordMedia?.send, true);

  // Version 2 without discordMedia is fine — the capability is optional.
  const plain = validatePluginManifest({
    ...base,
    apiVersion: 2,
  }, "discord-media");
  assertEquals(plain.capabilities, undefined);

  // Version 3 is not (yet) a thing.
  assertThrows(() =>
    validatePluginManifest({ ...base, apiVersion: 3 }, "discord-media")
  );
});

Deno.test("discordMedia capability requires apiVersion 2", () => {
  assertThrows(
    () =>
      validatePluginManifest({
        id: "discord-media",
        name: "Discord Media",
        version: "1.0.0",
        apiVersion: 1,
        entrypoints: { psycheros: "./psycheros.ts" },
        capabilities: { discordMedia: { send: true } },
      }, "discord-media"),
    Error,
    "requires apiVersion 2",
  );
});

Deno.test("discordMedia capability validates globs and shape", () => {
  const base = {
    id: "discord-media",
    name: "Discord Media",
    version: "1.0.0",
    apiVersion: 2,
    entrypoints: { psycheros: "./psycheros.ts" },
  };

  const withTypes = (attachmentTypes: unknown) =>
    validatePluginManifest({
      ...base,
      capabilities: { discordMedia: { attachmentTypes } },
    }, "discord-media");

  // Valid globs.
  assertEquals(
    withTypes(["audio/*", "image/gif", "*", "video/mp4", "*/*"])
      .capabilities?.discordMedia?.attachmentTypes?.length,
    5,
  );

  // Invalid: missing subtype, empty, whitespace, partial wildcards, non-strings.
  assertThrows(() => withTypes(["audio"]), Error, "invalid content-type glob");
  assertThrows(() => withTypes([""]), Error, "invalid content-type glob");
  assertThrows(() => withTypes(["a b/c"]), Error, "invalid content-type glob");
  assertThrows(() => withTypes(["audio/"]), Error, "invalid content-type glob");
  assertThrows(
    () => withTypes(["aud*o/mp3"]),
    Error,
    "invalid content-type glob",
  );
  assertThrows(() => withTypes([5]), Error, "invalid content-type glob");
  // Empty array and over-cap arrays are rejected.
  assertThrows(
    () => withTypes([]),
    Error,
    "non-empty array",
  );
  assertThrows(
    () => withTypes(Array<string>(33).fill("audio/*")),
    Error,
    "non-empty array",
  );

  // Empty discordMedia object declares neither claim — rejected.
  assertThrows(
    () =>
      validatePluginManifest({
        ...base,
        capabilities: { discordMedia: {} },
      }, "discord-media"),
    Error,
    "must declare attachmentTypes, send, or both",
  );

  // Wrong shape entirely.
  assertThrows(
    () =>
      validatePluginManifest({
        ...base,
        capabilities: { discordMedia: "audio/*" },
      }, "discord-media"),
    Error,
    "must be an object",
  );
});

Deno.test("contentTypeMatchesGlob strips params, ignores case, honors wildcards", () => {
  assertEquals(contentTypeMatchesGlob("audio/*", "audio/ogg"), true);
  assertEquals(contentTypeMatchesGlob("audio/*", "audio/mpeg"), true);
  assertEquals(
    contentTypeMatchesGlob("audio/ogg", "audio/ogg; codecs=opus"),
    true,
  );
  assertEquals(contentTypeMatchesGlob("Image/GIF", "image/gif"), true);
  assertEquals(contentTypeMatchesGlob("*", "application/pdf"), true);
  assertEquals(contentTypeMatchesGlob("*/*", "application/pdf"), true);

  assertEquals(contentTypeMatchesGlob("image/*", "audio/ogg"), false);
  assertEquals(contentTypeMatchesGlob("image/gif", "image/png"), false);
  assertEquals(contentTypeMatchesGlob("audio/*", ""), false);
  assertEquals(contentTypeMatchesGlob("", "audio/ogg"), false);
  assertEquals(
    contentTypeMatchesGlob("audio/ogg", "audio/ogg; codecs=opus"),
    true,
  );
  assertEquals(contentTypeMatchesGlob("audio/*", "video/ogg"), false);
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

Deno.test("plugin env denylist flags process-global and host-owned names", () => {
  // Outbound traffic redirection — both cases because some libraries read lowercase.
  assertEquals(isDeniedPluginEnvVar("HTTP_PROXY"), true);
  assertEquals(isDeniedPluginEnvVar("https_proxy"), true);
  assertEquals(isDeniedPluginEnvVar("ALL_PROXY"), true);
  // TLS trust overrides.
  assertEquals(isDeniedPluginEnvVar("SSL_CERT_FILE"), true);
  assertEquals(isDeniedPluginEnvVar("NODE_TLS_REJECT_UNAUTHORIZED"), true);
  // Native injection.
  assertEquals(isDeniedPluginEnvVar("LD_PRELOAD"), true);
  assertEquals(isDeniedPluginEnvVar("DYLD_INSERT_LIBRARIES"), true);
  // Process identity / lookup.
  assertEquals(isDeniedPluginEnvVar("PATH"), true);
  assertEquals(isDeniedPluginEnvVar("HOME"), true);
  // Runtime behavior.
  assertEquals(isDeniedPluginEnvVar("NODE_OPTIONS"), true);
  assertEquals(isDeniedPluginEnvVar("DENO_DIR"), true);
  assertEquals(isDeniedPluginEnvVar("DENO_AUTH_TOKENS"), true);

  // Host-owned namespaces — plugins get PSYCHEROS_PLUGIN_<ID>_ instead.
  assertEquals(isDeniedPluginEnvVar("PSYCHEROS_DATA_DIR"), true);
  assertEquals(isDeniedPluginEnvVar("PSYCHEROS_MCP_ENABLED"), true);
  assertEquals(isDeniedPluginEnvVar("ENTITY_CORE_DATA_DIR"), true);

  // Plugin-namespaced vars are allowed (the whole point of the convention).
  assertEquals(isDeniedPluginEnvVar("PSYCHEROS_PLUGIN_SPEECH_API_KEY"), false);
  // Vendor library vars not on the denylist are allowed — a speech plugin
  // may set ELEVENLABS_API_KEY directly if that's what the library expects.
  assertEquals(isDeniedPluginEnvVar("ELEVENLABS_API_KEY"), false);
  assertEquals(isDeniedPluginEnvVar("OPENAI_API_KEY"), false);
});

Deno.test("applyPluginEnv refuses denied vars but still applies allowed ones", async () => {
  const parent = await Deno.makeTempDir();
  const root = join(parent, "plugins");
  const secretPath = getPluginEnvPath(root, "mixed");
  await Deno.mkdir(join(secretPath, ".."), { recursive: true });
  await Deno.writeTextFile(
    secretPath,
    [
      "PSYCHEROS_PLUGIN_MIXED_OK=value-allowed",
      "HTTP_PROXY=http://attacker.example:8080",
      "NODE_TLS_REJECT_UNAUTHORIZED=0",
      "PSYCHEROS_DATA_DIR=/etc",
      "PSYCHEROS_PLUGIN_MIXED_SECOND=also-allowed",
    ].join("\n"),
  );

  // Snapshot anything pre-existing on these names so the test is hermetic
  // regardless of the surrounding environment.
  const snapshotNames = [
    "PSYCHEROS_PLUGIN_MIXED_OK",
    "HTTP_PROXY",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "PSYCHEROS_DATA_DIR",
    "PSYCHEROS_PLUGIN_MIXED_SECOND",
  ];
  const snapshot = new Map<string, string | undefined>(
    snapshotNames.map((n) => [n, Deno.env.get(n)]),
  );

  const applied = await applyPluginEnv(root, "mixed");
  try {
    // Allowed vars were set.
    assertEquals(applied.env.get("PSYCHEROS_PLUGIN_MIXED_OK"), "value-allowed");
    assertEquals(
      applied.env.get("PSYCHEROS_PLUGIN_MIXED_SECOND"),
      "also-allowed",
    );
    // Denied vars were refused — the live env still reflects the snapshot
    // (whatever it was before the test), never the attacker value.
    assertEquals(Deno.env.get("HTTP_PROXY"), snapshot.get("HTTP_PROXY"));
    assertEquals(
      Deno.env.get("NODE_TLS_REJECT_UNAUTHORIZED"),
      snapshot.get("NODE_TLS_REJECT_UNAUTHORIZED"),
    );
    assertEquals(
      Deno.env.get("PSYCHEROS_DATA_DIR"),
      snapshot.get("PSYCHEROS_DATA_DIR"),
    );
    // Refused names are surfaced for the host to put in status.warnings.
    assertEquals(
      [...applied.skippedEnvVars].sort(),
      ["HTTP_PROXY", "NODE_TLS_REJECT_UNAUTHORIZED", "PSYCHEROS_DATA_DIR"],
    );
  } finally {
    applied.restore();
    // Restore didn't touch denied names (they were never overwritten).
    for (const name of snapshotNames) {
      assertEquals(Deno.env.get(name), snapshot.get(name));
    }
  }
});
