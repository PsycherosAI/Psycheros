/**
 * BLE Device Bridge Settings Persistence
 *
 * Manages loading and saving BLE device configuration settings to disk.
 * Settings are stored in `.psycheros/ble-settings.json`.
 *
 * Each configured BLE device has a stable ID for routing commands through
 * the device bridge, a human-readable name, a device type (e.g. "banglejs",
 * "generic-ble"), and an enabled flag.
 */

import { join } from "@std/path";

// =============================================================================
// Types
// =============================================================================

/**
 * A configured BLE device.
 */
export interface BLEDevice {
  /** Stable identifier for routing commands, e.g. "banglejs-1" */
  id: string;
  /** User-friendly name, e.g. "My Bangle.js" */
  name: string;
  /** Device family, e.g. "banglejs", "generic-ble" */
  type: string;
  /** Whether this device is active */
  enabled: boolean;
}

/**
 * User-configurable BLE device bridge settings persisted to disk.
 */
export interface BLESettings {
  /** List of configured BLE devices */
  devices: BLEDevice[];
}

// =============================================================================
// Defaults
// =============================================================================

/**
 * Build default BLE settings.
 */
export function getDefaultBLESettings(): BLESettings {
  return {
    devices: [],
  };
}

// =============================================================================
// Load / Save
// =============================================================================

/**
 * Load BLE settings from the settings file.
 * Falls back to defaults if the file doesn't exist.
 */
export async function loadBLESettings(
  dataRoot: string,
): Promise<BLESettings> {
  const defaults = getDefaultBLESettings();
  const settingsPath = join(dataRoot, ".psycheros", "ble-settings.json");

  try {
    const text = await Deno.readTextFile(settingsPath);
    const saved = JSON.parse(text) as Partial<BLESettings>;
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

/**
 * Save BLE settings to the settings file.
 * Creates the `.psycheros/` directory if it doesn't exist.
 */
export async function saveBLESettings(
  dataRoot: string,
  settings: BLESettings,
): Promise<void> {
  const settingsDir = join(dataRoot, ".psycheros");
  const settingsPath = join(settingsDir, "ble-settings.json");

  await Deno.mkdir(settingsDir, { recursive: true });
  await Deno.writeTextFile(
    settingsPath,
    JSON.stringify(settings, null, 2) + "\n",
  );
}
