/**
 * Discord Settings Persistence
 *
 * Manages loading and saving Discord bot configuration settings to disk.
 * Settings are stored in `.psycheros/discord-settings.json` and fall back
 * to environment variables when the file doesn't exist.
 *
 * Gateway configuration (server/channel configs) is stored in
 * `.psycheros/discord-gateway.json`.
 */

import { join } from "@std/path";
import { maskApiKey } from "./settings.ts";

// =============================================================================
// Types — Base Settings
// =============================================================================

export interface DiscordSettings {
  botToken: string;
  defaultChannelId: string;
  enabled: boolean;
  gatewayEnabled: boolean;
  globalInstructions: string;
  showHubInSidebar: boolean;
}

// =============================================================================
// Types — Gateway Configuration
// =============================================================================

export type ChannelMode = "active" | "lurk" | "strict";

export interface DiscordChannelConfig {
  channelId: string;
  mode: ChannelMode;
  instructions: string;
}

export interface DiscordServerConfig {
  serverId: string;
  serverName: string;
  channels: DiscordChannelConfig[];
}

export interface DmWhitelistEntry {
  userId: string;
  username: string;
  notes: string;
}

export interface DiscordGatewayConfig {
  servers: DiscordServerConfig[];
  dmWhitelist: DmWhitelistEntry[];
  blockedBotIds: string[];
  respondToEveryoneHere: boolean;
  allowedTools: string[];
  debounceWindowMs: number;
  maxBufferSize: number;
  activeModeTiers: ActiveModeTierConfig;
  includeInDailyMemories: boolean;
  memoryInstructions: string;
}

// =============================================================================
// Types — Active Mode Tiers
// =============================================================================

export type ActiveTier = "slow" | "medium" | "fast";

export interface ActiveModeTierConfig {
  /** Message rate (per hour) above which the tier becomes medium (> this value) */
  slowToMediumThreshold: number;
  /** Message rate (per hour) at or above which the tier becomes fast */
  mediumToFastThreshold: number;
  /** Rolling window in minutes for rate calculation */
  rateWindowMinutes: number;
  /** Digest interval for medium tier in milliseconds */
  mediumDigestIntervalMs: number;
  /** Number of buffered messages that triggers an immediate flush in fast tier */
  fastBufferFlushSize: number;
  /** Short debounce for mention/reply-triggered flushes in milliseconds */
  mentionDebounceMs: number;
}

// =============================================================================
// Defaults — Base Settings
// =============================================================================

export function getDefaultDiscordSettings(): DiscordSettings {
  return {
    botToken: Deno.env.get("DISCORD_BOT_TOKEN") || "",
    defaultChannelId: Deno.env.get("DISCORD_DEFAULT_CHANNEL_ID") || "",
    enabled: !!(Deno.env.get("DISCORD_BOT_TOKEN")),
    gatewayEnabled: false,
    globalInstructions: "",
    showHubInSidebar: true,
  };
}

// =============================================================================
// Defaults — Gateway Config
// =============================================================================

export function getDefaultDiscordGatewayConfig(): DiscordGatewayConfig {
  return {
    servers: [],
    dmWhitelist: [],
    blockedBotIds: [],
    respondToEveryoneHere: true,
    allowedTools: [
      "web_search",
      "generate_image",
      "describe_image",
      "look_closer",
      "create_significant_memory",
      "vault",
      "act_in_discord",
    ],
    debounceWindowMs: 5000,
    maxBufferSize: 50,
    activeModeTiers: {
      slowToMediumThreshold: 2,
      mediumToFastThreshold: 6,
      rateWindowMinutes: 60,
      mediumDigestIntervalMs: 30 * 60 * 1000,
      fastBufferFlushSize: 10,
      mentionDebounceMs: 1500,
    },
    includeInDailyMemories: true,
    memoryInstructions: "",
  };
}

// =============================================================================
// Helpers — Load / Save
// =============================================================================

/**
 * Recursively merge a saved (possibly partial) config over defaults.
 *
 * Psycheros's config files are nested objects (e.g. DiscordGatewayConfig has
 * an activeModeTiers sub-object). A shallow `{ ...defaults, ...saved }` merge
 * replaces top-level keys wholesale: if a saved file was written by an older
 * Psycheros version whose nested object had a different shape (or lacked
 * fields added later), the saved nested object overwrites the default one
 * entirely — and downstream code dereferences fields that don't exist, which
 * can crash the daemon. Deep-merging per key means saved values win where
 * present, but new default fields survive even when the saved file predates
 * them.
 *
 * Arrays and primitives from `saved` always replace `defaults` (no element-
 * level merge — that would surprise users who explicitly removed a list
 * entry). Only plain objects recurse.
 */
function deepMerge<T>(defaults: T, saved: Partial<T> | undefined): T {
  if (saved === undefined || saved === null) return defaults;
  if (typeof defaults !== "object" || defaults === null) return saved as T;
  if (Array.isArray(defaults)) return saved as T;

  const result: Record<string, unknown> = {
    ...defaults as Record<string, unknown>,
  };
  for (
    const [key, savedValue] of Object.entries(saved as Record<string, unknown>)
  ) {
    const defaultValue = (defaults as Record<string, unknown>)[key];
    if (
      savedValue !== null &&
      typeof savedValue === "object" &&
      !Array.isArray(savedValue) &&
      typeof defaultValue === "object" &&
      defaultValue !== null &&
      !Array.isArray(defaultValue)
    ) {
      result[key] = deepMerge(
        defaultValue as Record<string, unknown>,
        savedValue as Record<string, unknown>,
      );
    } else if (savedValue !== undefined) {
      result[key] = savedValue;
    }
  }
  return result as T;
}

// =============================================================================
// Load / Save — Base Settings
// =============================================================================

export async function loadDiscordSettings(
  dataRoot: string,
): Promise<DiscordSettings> {
  const defaults = getDefaultDiscordSettings();
  const settingsPath = join(dataRoot, ".psycheros", "discord-settings.json");

  try {
    const text = await Deno.readTextFile(settingsPath);
    const saved = JSON.parse(text) as Partial<DiscordSettings>;
    return deepMerge(defaults, saved);
  } catch {
    return defaults;
  }
}

export async function saveDiscordSettings(
  dataRoot: string,
  settings: DiscordSettings,
): Promise<void> {
  const settingsDir = join(dataRoot, ".psycheros");
  const settingsPath = join(settingsDir, "discord-settings.json");

  await Deno.mkdir(settingsDir, { recursive: true });
  await Deno.writeTextFile(
    settingsPath,
    JSON.stringify(settings, null, 2) + "\n",
  );
}

export function maskDiscordSettings(
  settings: DiscordSettings,
): DiscordSettings {
  return {
    ...settings,
    botToken: maskApiKey(settings.botToken || ""),
  };
}

// =============================================================================
// Load / Save — Gateway Config
// =============================================================================

export async function loadDiscordGatewayConfig(
  dataRoot: string,
): Promise<DiscordGatewayConfig> {
  const defaults = getDefaultDiscordGatewayConfig();
  const settingsPath = join(dataRoot, ".psycheros", "discord-gateway.json");

  try {
    const text = await Deno.readTextFile(settingsPath);
    const saved = JSON.parse(text) as Partial<DiscordGatewayConfig>;
    return deepMerge(defaults, saved);
  } catch {
    return defaults;
  }
}

export async function saveDiscordGatewayConfig(
  dataRoot: string,
  config: DiscordGatewayConfig,
): Promise<void> {
  const settingsDir = join(dataRoot, ".psycheros");
  const settingsPath = join(settingsDir, "discord-gateway.json");

  await Deno.mkdir(settingsDir, { recursive: true });
  await Deno.writeTextFile(
    settingsPath,
    JSON.stringify(config, null, 2) + "\n",
  );
}
