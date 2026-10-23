/**
 * Sensory Organ plugin loader tests — discovery, connector validation,
 * built-in shadowing, and the enabledOrgans gate.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  discoverSensoryOrganPlugins,
  getSensoryOrganPluginDescriptors,
  pluginWantsEnabling,
} from "../src/flux/sensory-organ-plugins.ts";

const SINK = () => {};

const GOOD_PLUGIN = `
export function createSensoryOrgan(sink, context) {
  return {
    config: { id: "test-sense", tickIntervalMs: 1000, enabled: true },
    tick: async () => null,
    start() {},
    stop() {},
  };
}
`;

const NO_FACTORY = `export const nothing = true;`;

const BAD_SHAPE = `
export function createSensoryOrgan() {
  return { config: { id: "broken" }, tick: "not a function" };
}
`;

const SHADOW_BUILTIN = `
export function createSensoryOrgan() {
  return {
    config: { id: "motion-vision", tickIntervalMs: 1000, enabled: true },
    tick: async () => null,
    start() {},
    stop() {},
  };
}
`;

function tempDataRoot(): string {
  return Deno.makeTempDirSync({ prefix: "sensory-organ-plugins-test-" });
}

function writePlugin(dataRoot: string, name: string, body: string): void {
  Deno.mkdirSync(join(dataRoot, ".psycheros", "sensory-organs"), {
    recursive: true,
  });
  Deno.writeTextFileSync(
    join(dataRoot, ".psycheros", "sensory-organs", name),
    body,
  );
}

Deno.test("sensory-organ plugins: missing directory discovers nothing", async () => {
  const root = tempDataRoot();
  assertEquals(await discoverSensoryOrganPlugins(root, SINK), []);
  Deno.removeSync(root, { recursive: true });
});

Deno.test("sensory-organ plugins: valid module passes the connector check", async () => {
  const root = tempDataRoot();
  writePlugin(root, "test-sense.ts", GOOD_PLUGIN);
  const found = await discoverSensoryOrganPlugins(root, SINK);
  assertEquals(found.length, 1);
  assertEquals(found[0].organ.config.id, "test-sense");
  Deno.removeSync(root, { recursive: true });
});

Deno.test("sensory-organ plugins: no-factory and bad-shape modules are skipped", async () => {
  const root = tempDataRoot();
  writePlugin(root, "no-factory.ts", NO_FACTORY);
  writePlugin(root, "bad-shape.js", BAD_SHAPE);
  writePlugin(root, "good.ts", GOOD_PLUGIN);
  const found = await discoverSensoryOrganPlugins(root, SINK);
  assertEquals(found.length, 1);
  assertEquals(found[0].organ.config.id, "test-sense");
  Deno.removeSync(root, { recursive: true });
});

Deno.test("sensory-organ plugins: built-in ids cannot be shadowed", async () => {
  const root = tempDataRoot();
  writePlugin(root, "impostor.ts", SHADOW_BUILTIN);
  assertEquals(await discoverSensoryOrganPlugins(root, SINK), []);
  Deno.removeSync(root, { recursive: true });
});

Deno.test("sensory-organ plugins: enabledOrgans gates registration", () => {
  const discovered = [
    {
      organ: {
        config: { id: "alpha", tickIntervalMs: 1, enabled: true },
        tick: async () => null,
        start() {},
        stop() {},
      },
      sourceFile: "/tmp/alpha.ts",
      settingsFields: [],
    },
    {
      organ: {
        config: { id: "beta", tickIntervalMs: 1, enabled: true },
        tick: async () => null,
        start() {},
        stop() {},
      },
      sourceFile: "/tmp/beta.ts",
      settingsFields: [],
    },
  ];
  const wanted = pluginWantsEnabling(discovered, ["beta"]);
  assertEquals(wanted.length, 1);
  assertEquals(wanted[0].organ.config.id, "beta");
});

const SETTINGS_PLUGIN = `
export const sensoryOrganSettings = [
  { key: "url", label: "URL", type: "text", default: "http://localhost:1" },
  { key: "rate", label: "Rate", type: "number", default: 5 },
  { key: "verbose", label: "Verbose", type: "toggle", default: false },
  { key: "broken", label: "No type", help: "malformed — dropped at load" },
  null,
];
export function createSensoryOrgan(sink, context) {
  // Stash on globalThis: the loader cache-busts imports (?t=...) and the
  // verifier's plain re-import would create a SECOND module instance with
  // its own unset module state — the captured settings must cross that
  // instance boundary.
  globalThis.__lastSenseSettings = context.settings;
  return {
    config: { id: "settings-sense", tickIntervalMs: 1000, enabled: true },
    tick: async () => null,
    start() {},
    stop() {},
  };
}
`;

Deno.test("sensory-organ plugins: descriptor fields reach the factory, saved values win", async () => {
  const root = tempDataRoot();
  writePlugin(root, "settings-sense.ts", SETTINGS_PLUGIN);
  const found = await discoverSensoryOrganPlugins(root, SINK, {
    "settings-sense": { url: "http://override:2", verbose: true },
  });
  assertEquals(found.length, 1);
  // Malformed entries (no type, nulls) are dropped; valid ones survive.
  assertEquals(found[0].settingsFields.length, 3);
  // Defaults applied, saved values override, untouched defaults hold —
  // verified through the plugin module's own captured context.
  const s = (globalThis as Record<string, unknown>)
    .__lastSenseSettings as Record<string, unknown>;
  assertEquals(s.url, "http://override:2");
  assertEquals(s.rate, 5);
  assertEquals(s.verbose, true);
  // Descriptors are cached for the Settings fragment.
  const descriptors = getSensoryOrganPluginDescriptors();
  assertEquals(
    descriptors.some((d) => d.id === "settings-sense" && d.fields.length === 3),
    true,
  );
  Deno.removeSync(root, { recursive: true });
});
