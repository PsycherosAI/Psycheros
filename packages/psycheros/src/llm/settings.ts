/**
 * LLM Settings Persistence
 *
 * Manages loading and saving LLM connection profile settings to disk.
 * Settings are stored in `.psycheros/llm-settings.json`.
 *
 * Supports automatic migration from the old flat LLMSettings format
 * to the new multi-profile LLMProfileSettings format.
 */

import { join } from "@std/path";
import {
  createDefaultProfile,
  inferProvider,
  inferProviderName,
  type LLMConnectionProfile,
  type LLMProfileSettings,
} from "./provider-presets.ts";

// =============================================================================
// Legacy Type (kept for backward compatibility)
// =============================================================================

/**
 * User-configurable LLM settings persisted to disk.
 * @deprecated Use LLMConnectionProfile instead. Kept for backward compatibility.
 */
export interface LLMSettings {
  /** Base URL for the API endpoint */
  baseUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Model identifier to use */
  model: string;
  /** Worker model for lightweight tasks (auto-titling, summarization) */
  workerModel: string;
  /** Sampling temperature (0-2) */
  temperature: number;
  /** Top-p (nucleus) sampling (0-1) */
  topP: number;
  /** Top-k sampling (0 = disabled) */
  topK: number;
  /** Frequency penalty (-2 to 2) */
  frequencyPenalty: number;
  /** Presence penalty (-2 to 2) */
  presencePenalty: number;
  /** Maximum tokens for response generation */
  maxTokens: number;
  /** Context window size in tokens (used for context budget management) */
  contextLength: number;
  /** Whether chain-of-thought reasoning is enabled */
  thinkingEnabled: boolean;
}

// =============================================================================
// Defaults
// =============================================================================

/**
 * Hardcoded fallback defaults when no env vars or settings file exists.
 * @deprecated Use createDefaultProfile() instead.
 */
const FALLBACK_DEFAULTS: LLMSettings = {
  baseUrl: "https://api.z.ai/api/coding/paas/v4/chat/completions",
  apiKey: "",
  model: "glm-4.7",
  workerModel: "GLM-4.5-Air",
  temperature: 0.7,
  topP: 1,
  topK: 0,
  frequencyPenalty: 0,
  presencePenalty: 0,
  maxTokens: 4096,
  contextLength: 128000,
  thinkingEnabled: true,
};

/**
 * Build default settings from environment variables, falling back to hardcoded defaults.
 * @deprecated Use profile-based settings instead.
 */
export function getDefaultSettings(): LLMSettings {
  return {
    baseUrl: Deno.env.get("ZAI_BASE_URL") || FALLBACK_DEFAULTS.baseUrl,
    apiKey: Deno.env.get("ZAI_API_KEY") || FALLBACK_DEFAULTS.apiKey,
    model: Deno.env.get("ZAI_MODEL") || FALLBACK_DEFAULTS.model,
    workerModel: Deno.env.get("ZAI_WORKER_MODEL") ||
      FALLBACK_DEFAULTS.workerModel,
    temperature: FALLBACK_DEFAULTS.temperature,
    topP: FALLBACK_DEFAULTS.topP,
    topK: FALLBACK_DEFAULTS.topK,
    frequencyPenalty: FALLBACK_DEFAULTS.frequencyPenalty,
    presencePenalty: FALLBACK_DEFAULTS.presencePenalty,
    maxTokens: FALLBACK_DEFAULTS.maxTokens,
    contextLength: FALLBACK_DEFAULTS.contextLength,
    thinkingEnabled: FALLBACK_DEFAULTS.thinkingEnabled,
  };
}

// =============================================================================
// Profile Helpers
// =============================================================================

/**
 * Derive a flat LLMSettings from a connection profile.
 * Used for backward compatibility with code that expects LLMSettings.
 */
export function profileToLLMSettings(
  profile: LLMConnectionProfile,
): LLMSettings {
  return {
    baseUrl: profile.baseUrl,
    apiKey: profile.apiKey,
    model: profile.model,
    workerModel: profile.workerModel,
    temperature: profile.temperature,
    topP: profile.topP,
    topK: profile.topK,
    frequencyPenalty: profile.frequencyPenalty,
    presencePenalty: profile.presencePenalty,
    maxTokens: profile.maxTokens,
    contextLength: profile.contextLength,
    thinkingEnabled: profile.thinkingEnabled,
  };
}

/**
 * Get the active profile from profile settings.
 * Returns the first profile if the active ID doesn't match any profile.
 */
export function getActiveProfile(
  settings: LLMProfileSettings,
): LLMConnectionProfile | null {
  const active = settings.profiles.find((p) =>
    p.id === settings.activeProfileId
  );
  return active || settings.profiles[0] || null;
}

// =============================================================================
// Masking
// =============================================================================

/**
 * Mask an API key for safe display (shows first 3 and last 4 chars).
 * Returns the key unchanged if it's too short to mask.
 */
export function maskApiKey(key: string): string {
  if (!key || key.length <= 8) {
    return key ? "••••••••" : "";
  }
  return key.slice(0, 3) + "••••••••" + key.slice(-4);
}

/**
 * Get a masked version of profile settings for safe display.
 * All API keys across all profiles are masked.
 */
export function maskProfileSettings(
  settings: LLMProfileSettings,
): LLMProfileSettings {
  return {
    ...settings,
    profiles: settings.profiles.map((p) => ({
      ...p,
      apiKey: maskApiKey(p.apiKey),
    })),
  };
}

// =============================================================================
// Migration
// =============================================================================

/**
 * Migrate old flat LLMSettings format to the new LLMProfileSettings format.
 * Detects the old format by checking for a `baseUrl` string field without a `profiles` array.
 */
function migrateLegacySettings(
  parsed: Record<string, unknown>,
): LLMProfileSettings {
  const old = parsed as unknown as Partial<LLMSettings>;

  const profile: LLMConnectionProfile = {
    id: crypto.randomUUID(),
    name: old.baseUrl
      ? inferProviderName(old.baseUrl) + " (migrated)"
      : "Default (migrated)",
    provider: old.baseUrl ? inferProvider(old.baseUrl) : "custom",
    baseUrl: old.baseUrl || FALLBACK_DEFAULTS.baseUrl,
    apiKey: old.apiKey || "",
    model: old.model || FALLBACK_DEFAULTS.model,
    workerModel: old.workerModel || FALLBACK_DEFAULTS.workerModel,
    temperature: old.temperature ?? FALLBACK_DEFAULTS.temperature,
    topP: old.topP ?? FALLBACK_DEFAULTS.topP,
    topK: old.topK ?? FALLBACK_DEFAULTS.topK,
    frequencyPenalty: old.frequencyPenalty ??
      FALLBACK_DEFAULTS.frequencyPenalty,
    presencePenalty: old.presencePenalty ?? FALLBACK_DEFAULTS.presencePenalty,
    maxTokens: old.maxTokens ?? FALLBACK_DEFAULTS.maxTokens,
    contextLength: old.contextLength ?? FALLBACK_DEFAULTS.contextLength,
    thinkingEnabled: old.thinkingEnabled ?? FALLBACK_DEFAULTS.thinkingEnabled,
  };

  console.log(
    `[LLM Settings] Migrated legacy settings to profile: "${profile.name}" (${profile.provider})`,
  );

  return {
    profiles: [profile],
    activeProfileId: profile.id,
  };
}

// =============================================================================
// Profile Settings Load / Save
// =============================================================================

/**
 * Load LLM profile settings from the settings file.
 * Automatically migrates old flat format to the new profile array format.
 * Falls back to a default profile from environment variables if no file exists.
 */
export async function loadProfileSettings(
  dataRoot: string,
): Promise<LLMProfileSettings> {
  const settingsPath = join(dataRoot, ".psycheros", "llm-settings.json");

  try {
    const text = await Deno.readTextFile(settingsPath);
    const parsed = JSON.parse(text) as Record<string, unknown>;

    // Detect old flat format: has "baseUrl" string but no "profiles" array
    if (
      parsed && typeof parsed.baseUrl === "string" &&
      !Array.isArray(parsed.profiles)
    ) {
      const migrated = migrateLegacySettings(parsed);
      // Save migrated format back to disk
      await saveProfileSettings(dataRoot, migrated);
      return migrated;
    }

    // New format — validate activeProfileId points to an existing profile
    const settings = parsed as unknown as LLMProfileSettings;
    if (settings.profiles && settings.profiles.length > 0) {
      const activeExists = settings.profiles.some((p) =>
        p.id === settings.activeProfileId
      );
      if (!activeExists) {
        console.warn(
          "[LLM Settings] activeProfileId not found, falling back to first profile",
        );
        settings.activeProfileId = settings.profiles[0].id;
      }
      return settings;
    }

    // Empty profiles array — create a default
    console.log(
      "[LLM Settings] Empty profiles array, creating default from env",
    );
    const defaultProfile = createDefaultProfile();
    const settingsWithDefault: LLMProfileSettings = {
      profiles: [defaultProfile],
      activeProfileId: defaultProfile.id,
    };
    await saveProfileSettings(dataRoot, settingsWithDefault);
    return settingsWithDefault;
  } catch {
    // File doesn't exist or is invalid — create default from env
    const defaultProfile = createDefaultProfile();
    return {
      profiles: [defaultProfile],
      activeProfileId: defaultProfile.id,
    };
  }
}

/**
 * Save LLM profile settings to the settings file.
 * Creates the `.psycheros/` directory if it doesn't exist.
 */
export async function saveProfileSettings(
  dataRoot: string,
  settings: LLMProfileSettings,
): Promise<void> {
  const settingsDir = join(dataRoot, ".psycheros");
  const settingsPath = join(settingsDir, "llm-settings.json");

  await Deno.mkdir(settingsDir, { recursive: true });
  await Deno.writeTextFile(
    settingsPath,
    JSON.stringify(settings, null, 2) + "\n",
  );
}

// =============================================================================
// Legacy Load / Save (backward compatibility wrappers)
// =============================================================================

/**
 * Load LLM settings (legacy flat format).
 * @deprecated Use loadProfileSettings() and getActiveProfile() instead.
 */
export async function loadSettings(dataRoot: string): Promise<LLMSettings> {
  const profileSettings = await loadProfileSettings(dataRoot);
  const active = getActiveProfile(profileSettings);
  if (!active) {
    return getDefaultSettings();
  }
  return profileToLLMSettings(active);
}

/**
 * Save LLM settings (legacy flat format).
 * @deprecated Use saveProfileSettings() instead.
 */
export async function saveSettings(
  dataRoot: string,
  settings: LLMSettings,
): Promise<void> {
  const settingsDir = join(dataRoot, ".psycheros");
  const settingsPath = join(settingsDir, "llm-settings.json");

  await Deno.mkdir(settingsDir, { recursive: true });
  await Deno.writeTextFile(
    settingsPath,
    JSON.stringify(settings, null, 2) + "\n",
  );
}
