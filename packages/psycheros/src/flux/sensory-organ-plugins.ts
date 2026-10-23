/**
 * Sensory Organ plugins — out-of-tree senses, loaded at composition time.
 *
 * Users write bespoke Sensory Organs without touching the Psycheros source:
 * one module per sense under `<dataRoot>/.psycheros/sensory-organs/`,
 * exporting `createSensoryOrgan(sink, context)`. A discovered organ
 * registers like a built-in when its id appears in Flux settings'
 * `enabledOrgans` — same Thalamus heartbeat, same health dot, same
 * promotion path. Same seam, same discipline
 * (`entity-flux/docs/sensory-organ-template.md` is the authoring guide).
 *
 * Deliberately local-file only — no remote/URL modules: sharing a
 * Sensory Organ means sharing the file. Loading is
 * a non-literal dynamic import, so these modules are never type-checked by
 * `deno check`; the connector is held by structural typing and validated
 * here at load time instead — loudly, per file, with a skip, never a crash.
 */

import { join, toFileUrl } from "@std/path";
import type {
  EnvelopeSink,
  SensoryOrgan,
  SensoryOrganSettingField,
} from "../../../entity-flux/src/mod.ts";

/** The canonical subdirectory for Sensory Organ plugin files. */
export const SENSORY_ORGANS_SUBDIR = join(".psycheros", "sensory-organs");

// The descriptor shape lives in entity-flux (types.ts) so shipped
// Sensory Organs declare identical fields; re-exported here for the
// plugin authoring guide's import path.
export type { SensoryOrganSettingField };

/** What a plugin module's factory receives besides the sink. */
export interface SensoryOrganPluginContext {
  /** The daemon's data root — state files belong under `.psycheros/`. */
  dataRoot: string;
  /**
   * This plugin's setting values (descriptor defaults merged under
   * whatever was saved in flux-settings.json). Restart-to-apply, same
   * as every other flux setting.
   */
  settings: Record<string, unknown>;
}

/** The out-of-tree hookup contract: envelopes out is the whole seam. */
export type SensoryOrganFactory = (
  sink: EnvelopeSink,
  context: SensoryOrganPluginContext,
) => SensoryOrgan;

/** A discovered plugin: the organ plus where it came from. */
export interface DiscoveredSensoryOrgan {
  organ: SensoryOrgan;
  sourceFile: string;
  /** The plugin's declared settings fields (empty when it declares none). */
  settingsFields: SensoryOrganSettingField[];
}

/** Shape-check a declared settings field (a bad field is dropped, not fatal). */
function validSettingField(value: unknown): value is SensoryOrganSettingField {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  return typeof f.key === "string" && f.key.length > 0 &&
    typeof f.label === "string" &&
    ["text", "number", "toggle", "select"].includes(f.type as string) &&
    (f.type !== "select" || Array.isArray(f.options));
}

/** Built-in Sensory Organ ids a plugin may never shadow. */
const BUILTIN_IDS = new Set(["motion-vision", "system-state"]);

/**
 * The last discovery's declared settings descriptors — what the Settings
 * fragment renders from. Module-level because the fragment renders
 * without composing flux; populated whenever a composition runs. Empty
 * until the first Flux start of a boot (the fragment says so). Shipped
 * senses register their descriptors at composition too — one uniform
 * surface: every Sensory Organ, shipped or plugin, renders from the
 * same list.
 */
let lastDescriptors: Array<{
  id: string;
  fields: SensoryOrganSettingField[];
}> = [];

/**
 * Shipped Sensory Organs' descriptors — called by the composition root
 * (they're compiled constants, not discovered files). Merged ahead of
 * plugin descriptors so the Settings UI lists the shipped senses first.
 */
export function setShippedSensoryOrganDescriptors(
  shipped: Array<{ id: string; fields: SensoryOrganSettingField[] }>,
) {
  const shippedIds = new Set(shipped.map((s) => s.id));
  lastDescriptors = [
    ...shipped,
    ...lastDescriptors.filter((d) => !shippedIds.has(d.id)),
  ];
}

/** The discovered plugins' settings descriptors, for the Settings UI. */
export function getSensoryOrganPluginDescriptors() {
  return lastDescriptors;
}

function isSensoryOrganShape(value: unknown): value is SensoryOrgan {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  const config = o.config as Record<string, unknown> | undefined;
  return !!config &&
    typeof config.id === "string" && config.id.length > 0 &&
    typeof config.tickIntervalMs === "number" &&
    typeof config.enabled === "boolean" &&
    typeof o.tick === "function" &&
    typeof o.start === "function" &&
    typeof o.stop === "function";
}

/**
 * Scan `.psycheros/sensory-organs/` for plugin modules (.ts / .js),
 * import each, call its factory, validate the connector shape, and skip
 * anything shaped wrong — one malformed plugin never blocks the rest or
 * the built-ins. The sink handed to every factory is the caller's (the
 * manager's ingest), so envelopes emitted here flow the same path as
 * compiled-in senses.
 */
export async function discoverSensoryOrganPlugins(
  dataRoot: string,
  sink: EnvelopeSink,
  savedSettings: Record<string, Record<string, unknown>> = {},
): Promise<DiscoveredSensoryOrgan[]> {
  const dir = join(dataRoot, SENSORY_ORGANS_SUBDIR);
  let entries: Deno.DirEntry[];
  try {
    entries = Array.from(Deno.readDirSync(dir));
  } catch {
    return []; // No directory yet — the common case, not an error.
  }
  const found: DiscoveredSensoryOrgan[] = [];
  for (const entry of entries) {
    if (!entry.isFile) continue;
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".js")) continue;
    const path = join(dir, entry.name);
    const stem = entry.name.replace(/\.(ts|js)$/, "");
    try {
      // Cache-bust the import: Deno's module registry caches by URL for
      // the process lifetime, so without this a plugin file edited on
      // disk would keep serving its FIRST-loaded module on every Flux
      // restart — stale factories, stale descriptors. The query param
      // forces a fresh read per discovery (per Flux start), which is the
      // restart semantics plugin authors expect while tuning.
      const mod = await import(`${toFileUrl(path).href}?t=${Date.now()}`);
      const factory = mod.createSensoryOrgan as SensoryOrganFactory | undefined;
      if (typeof factory !== "function") {
        console.error(
          `[Flux] Sensory Organ plugin ${entry.name} skipped — no exported ` +
            `createSensoryOrgan(sink, context) function.`,
        );
        continue;
      }
      const settingsFields: SensoryOrganSettingField[] =
        (Array.isArray(mod.sensoryOrganSettings)
          ? mod.sensoryOrganSettings.filter(validSettingField)
          : []) as SensoryOrganSettingField[];
      // Saved values are keyed by file stem — the convention (warned on
      // below when id and stem disagree) is to name the file after the id.
      const settings = {
        ...Object.fromEntries(
          settingsFields.map((f) => [f.key, f.default]),
        ),
        ...(savedSettings[stem] ?? {}),
      };
      const organ = await factory(sink, { dataRoot, settings });
      if (!isSensoryOrganShape(organ)) {
        console.error(
          `[Flux] Sensory Organ plugin ${entry.name} skipped — the returned ` +
            `object doesn't match the Sensory Organ connector (config.id / ` +
            `tickIntervalMs / enabled + tick / start / stop). See ` +
            `entity-flux docs/sensory-organ-template.md.`,
        );
        continue;
      }
      if (BUILTIN_IDS.has(organ.config.id)) {
        console.error(
          `[Flux] Sensory Organ plugin ${entry.name} skipped — id ` +
            `"${organ.config.id}" belongs to a built-in sense; plugins may ` +
            `not shadow it.`,
        );
        continue;
      }
      if (organ.config.id !== stem) {
        console.warn(
          `[Flux] Sensory Organ plugin ${entry.name} declares id ` +
            `"${organ.config.id}" — file and id disagree; the enabledOrgans ` +
            `settings field wants the id.`,
        );
      }
      found.push({ organ, sourceFile: path, settingsFields });
    } catch (error) {
      console.error(
        `[Flux] Sensory Organ plugin ${entry.name} failed to load: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  lastDescriptors = found.map((d) => ({
    id: d.organ.config.id,
    fields: d.settingsFields,
  }));
  return found;
}

/**
 * The composition root's registration filter: a discovered plugin becomes
 * live only when its id is in `enabledOrgans`. Kept separate from
 * discovery so the settings gate is one obvious place.
 */
export function pluginWantsEnabling(
  discovered: DiscoveredSensoryOrgan[],
  enabledOrgans: string[],
): DiscoveredSensoryOrgan[] {
  return discovered.filter((d) => enabledOrgans.includes(d.organ.config.id));
}
