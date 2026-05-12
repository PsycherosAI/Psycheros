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
  /** Digest interval for fast tier in milliseconds */
  fastDigestIntervalMs: number;
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
    ],
    debounceWindowMs: 4000,
    maxBufferSize: 50,
    activeModeTiers: {
      slowToMediumThreshold: 2,
      mediumToFastThreshold: 6,
      rateWindowMinutes: 60,
      mediumDigestIntervalMs: 30 * 60 * 1000,
      fastDigestIntervalMs: 10 * 60 * 1000,
      mentionDebounceMs: 1500,
    },
    includeInDailyMemories: true,
    memoryInstructions: "",
  };
}

// =============================================================================
// Load / Save — Base Settings
// =============================================================================

export async function loadDiscordSettings(
  projectRoot: string,
): Promise<DiscordSettings> {
  const defaults = getDefaultDiscordSettings();
  const settingsPath = join(projectRoot, ".psycheros", "discord-settings.json");

  try {
    const text = await Deno.readTextFile(settingsPath);
    const saved = JSON.parse(text) as Partial<DiscordSettings>;
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

export async function saveDiscordSettings(
  projectRoot: string,
  settings: DiscordSettings,
): Promise<void> {
  const settingsDir = join(projectRoot, ".psycheros");
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
  projectRoot: string,
): Promise<DiscordGatewayConfig> {
  const defaults = getDefaultDiscordGatewayConfig();
  const settingsPath = join(projectRoot, ".psycheros", "discord-gateway.json");

  try {
    const text = await Deno.readTextFile(settingsPath);
    const saved = JSON.parse(text) as Partial<DiscordGatewayConfig>;
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

export async function saveDiscordGatewayConfig(
  projectRoot: string,
  config: DiscordGatewayConfig,
): Promise<void> {
  const settingsDir = join(projectRoot, ".psycheros");
  const settingsPath = join(settingsDir, "discord-gateway.json");

  await Deno.mkdir(settingsDir, { recursive: true });
  await Deno.writeTextFile(
    settingsPath,
    JSON.stringify(config, null, 2) + "\n",
  );
}
