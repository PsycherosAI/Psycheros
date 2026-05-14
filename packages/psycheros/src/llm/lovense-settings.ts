/**
 * Lovense Device Control Settings
 *
 * Manages configuration for the Lovense toy integration. Settings are
 * stored in `.psycheros/lovense-settings.json`.
 *
 * The Lovense Connect app acts as a local bridge — Psycheros communicates
 * with it over the LAN via HTTPS. The domain uses the `*.lovense.club`
 * DNS resolver which provides valid TLS certificates.
 */

import { join } from "@std/path";

// =============================================================================
// Types
// =============================================================================

/**
 * Connection configuration for the Lovense Connect app bridge.
 */
export interface LovenseConnection {
  /** Bridge domain in lovense.club format, e.g. "192-168-1-44.lovense.club" */
  domain: string;
  /** Port (20010 for LAN mode, 34568 for mobile Game Mode, 30010 for PC Game Mode) */
  port: number;
  /** Whether to use HTTPS. Game Mode uses HTTPS; LAN Mode uses HTTP. */
  secure: boolean;
}

/**
 * User-configurable Lovense settings persisted to disk.
 */
export interface LovenseSettings {
  /** Whether Lovense integration is enabled */
  enabled: boolean;
  /** Bridge connection settings */
  connection: LovenseConnection;
}

// =============================================================================
// Defaults
// =============================================================================

/**
 * Build default Lovense settings.
 */
export function getDefaultLovenseSettings(): LovenseSettings {
  return {
    enabled: false,
    connection: {
      domain: "",
      port: 34568,
      secure: true,
    },
  };
}

// =============================================================================
// Load / Save
// =============================================================================

/**
 * Load Lovense settings from the settings file.
 * Falls back to defaults if the file doesn't exist.
 */
export async function loadLovenseSettings(
  dataRoot: string,
): Promise<LovenseSettings> {
  const defaults = getDefaultLovenseSettings();
  const settingsPath = join(dataRoot, ".psycheros", "lovense-settings.json");

  try {
    const text = await Deno.readTextFile(settingsPath);
    const saved = JSON.parse(text) as Partial<LovenseSettings>;
    const savedConn = saved.connection as
      | Partial<LovenseConnection>
      | undefined;
    return {
      ...defaults,
      ...saved,
      connection: {
        ...defaults.connection,
        ...savedConn,
        // Migrate legacy httpsPort field
        ...(savedConn && "httpsPort" in savedConn && !("port" in savedConn)
          ? { port: (savedConn as Record<string, unknown>).httpsPort as number }
          : {}),
      },
    };
  } catch {
    return defaults;
  }
}

/**
 * Save Lovense settings to the settings file.
 * Creates the `.psycheros/` directory if it doesn't exist.
 */
export async function saveLovenseSettings(
  dataRoot: string,
  settings: LovenseSettings,
): Promise<void> {
  const settingsDir = join(dataRoot, ".psycheros");
  const settingsPath = join(settingsDir, "lovense-settings.json");

  await Deno.mkdir(settingsDir, { recursive: true });
  await Deno.writeTextFile(
    settingsPath,
    JSON.stringify(settings, null, 2) + "\n",
  );
}
