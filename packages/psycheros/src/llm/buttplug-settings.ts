/**
 * Buttplug Device Control Settings
 *
 * Manages configuration for the Buttplug.io toy integration. Settings are
 * stored in `.psycheros/buttplug-settings.json`.
 *
 * Buttplug connects to an Intiface Central server (or any Buttplug protocol
 * server) over WebSocket. The default address is ws://127.0.0.1:12345.
 */

import { join } from "@std/path";

// =============================================================================
// Types
// =============================================================================

/**
 * User-configurable Buttplug settings persisted to disk.
 */
export interface ButtplugSettings {
  /** Whether Buttplug integration is enabled */
  enabled: boolean;
  /** WebSocket URL of the Buttplug server (Intiface Central) */
  websocketUrl: string;
}

// =============================================================================
// Defaults
// =============================================================================

/**
 * Build default Buttplug settings.
 */
export function getDefaultButtplugSettings(): ButtplugSettings {
  return {
    enabled: false,
    websocketUrl: "ws://127.0.0.1:12345",
  };
}

// =============================================================================
// Load / Save
// =============================================================================

/**
 * Load Buttplug settings from the settings file.
 * Falls back to defaults if the file doesn't exist.
 */
export async function loadButtplugSettings(
  dataRoot: string,
): Promise<ButtplugSettings> {
  const defaults = getDefaultButtplugSettings();
  const settingsPath = join(
    dataRoot,
    ".psycheros",
    "buttplug-settings.json",
  );

  try {
    const text = await Deno.readTextFile(settingsPath);
    const saved = JSON.parse(text) as Partial<ButtplugSettings>;
    return {
      ...defaults,
      ...saved,
    };
  } catch {
    return defaults;
  }
}

/**
 * Save Buttplug settings to the settings file.
 * Creates the `.psycheros/` directory if it doesn't exist.
 */
export async function saveButtplugSettings(
  dataRoot: string,
  settings: ButtplugSettings,
): Promise<void> {
  const settingsDir = join(dataRoot, ".psycheros");
  const settingsPath = join(settingsDir, "buttplug-settings.json");

  await Deno.mkdir(settingsDir, { recursive: true });
  await Deno.writeTextFile(
    settingsPath,
    JSON.stringify(settings, null, 2) + "\n",
  );
}
