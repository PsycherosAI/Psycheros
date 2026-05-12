/**
 * Home Automation Settings Persistence
 *
 * Manages loading and saving home device configuration settings to disk.
 * Settings are stored in `.psycheros/home-settings.json`.
 */

import { join } from "@std/path";

// =============================================================================
// Types
// =============================================================================

/**
 * A configured home automation device.
 */
export interface HomeDevice {
  /** User-friendly name, e.g. "Coffee Maker" */
  name: string;
  /** Device protocol type, e.g. "shelly-plug" */
  type: string;
  /** IP address or hostname */
  address: string;
  /** Whether this device is active */
  enabled: boolean;
}

/**
 * User-configurable home automation settings persisted to disk.
 */
export interface HomeSettings {
  /** List of configured home devices */
  devices: HomeDevice[];
}

// =============================================================================
// Defaults
// =============================================================================

/**
 * Build default home settings.
 */
export function getDefaultHomeSettings(): HomeSettings {
  return {
    devices: [],
  };
}

// =============================================================================
// Load / Save
// =============================================================================

/**
 * Load home settings from the settings file.
 * Falls back to defaults if the file doesn't exist.
 */
export async function loadHomeSettings(
  projectRoot: string,
): Promise<HomeSettings> {
  const defaults = getDefaultHomeSettings();
  const settingsPath = join(projectRoot, ".psycheros", "home-settings.json");

  try {
    const text = await Deno.readTextFile(settingsPath);
    const saved = JSON.parse(text) as Partial<HomeSettings>;
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

/**
 * Save home settings to the settings file.
 * Creates the `.psycheros/` directory if it doesn't exist.
 */
export async function saveHomeSettings(
  projectRoot: string,
  settings: HomeSettings,
): Promise<void> {
  const settingsDir = join(projectRoot, ".psycheros");
  const settingsPath = join(settingsDir, "home-settings.json");

  await Deno.mkdir(settingsDir, { recursive: true });
  await Deno.writeTextFile(
    settingsPath,
    JSON.stringify(settings, null, 2) + "\n",
  );
}
