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
 * Configuration for a single data stream from a BLE device.
 * Discovered from incoming data or a capabilities message.
 */
export interface BLEStreamConfig {
  /** Display label shown in UI */
  label: string;
  /** XML tag name used in the SA block */
  xmlTag: string;
  /** Whether this stream appears in SA context */
  enabled: boolean;
}

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
  /** Discovered/configured data streams, keyed by stream type ID */
  streams?: Record<string, BLEStreamConfig>;
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

/** Known stream type defaults for xmlTag and label. */
const STREAM_DEFAULTS: Record<
  string,
  { label: string; xmlTag: string }
> = {
  sleep: { label: "Sleep State", xmlTag: "sleep_state" },
  hr: { label: "Heart Rate", xmlTag: "heart_rate" },
  accel: { label: "Activity", xmlTag: "activity_level" },
  battery: { label: "Battery", xmlTag: "battery_level" },
  gps: { label: "Location", xmlTag: "gps_location" },
  screen: { label: "Screen", xmlTag: "screen_state" },
};

/**
 * Get default stream config for a stream type.
 * Known types get human-friendly labels and xml tags.
 * Unknown types use the stream ID as both label and xml tag.
 */
export function getDefaultStreamConfig(
  streamId: string,
): BLEStreamConfig {
  const defaults = STREAM_DEFAULTS[streamId];
  return {
    label: defaults?.label ?? streamId,
    xmlTag: defaults?.xmlTag ?? streamId,
    enabled: true,
  };
}

/**
 * Ensure a device's streams map has an entry for the given stream ID.
 * Does not overwrite existing configs. Returns the device's streams map.
 */
export function ensureStream(
  device: BLEDevice,
  streamId: string,
): Record<string, BLEStreamConfig> {
  if (!device.streams) {
    device.streams = {};
  }
  if (!device.streams[streamId]) {
    device.streams[streamId] = getDefaultStreamConfig(streamId);
  }
  return device.streams;
}

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
