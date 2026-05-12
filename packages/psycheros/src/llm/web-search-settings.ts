/**
 * Web Search Settings Persistence
 *
 * Manages loading and saving web search configuration settings to disk.
 * Settings are stored in `.psycheros/web-search-settings.json` and fall back
 * to environment variables when the file doesn't exist.
 */

import { join } from "@std/path";
import { maskApiKey } from "./settings.ts";

// =============================================================================
// Types
// =============================================================================

/**
 * User-configurable web search settings persisted to disk.
 */
export interface WebSearchSettings {
  /** Which web search provider to use */
  provider: "disabled" | "tavily" | "brave";
  /** API key for Tavily (only used when provider is "tavily") */
  tavilyApiKey?: string;
  /** API key for Brave Search (only used when provider is "brave") */
  braveApiKey?: string;
}

// =============================================================================
// Defaults
// =============================================================================

/**
 * Build default web search settings from environment variables.
 * Returns disabled if PSYCHEROS_WEB_SEARCH is not set.
 */
export function getDefaultWebSearchSettings(): WebSearchSettings {
  const provider = parseProvider(Deno.env.get("PSYCHEROS_WEB_SEARCH"));

  return {
    provider,
    tavilyApiKey: Deno.env.get("TAVILY_API_KEY") || "",
    braveApiKey: Deno.env.get("BRAVE_SEARCH_API_KEY") || "",
  };
}

/**
 * Parse a provider string from env var into the typed union.
 */
function parseProvider(
  value: string | undefined,
): WebSearchSettings["provider"] {
  switch (value?.toLowerCase()) {
    case "tavily":
      return "tavily";
    case "brave":
      return "brave";
    case "disabled":
      return "disabled";
    default:
      return "disabled";
  }
}

// =============================================================================
// Load / Save
// =============================================================================

/**
 * Load web search settings from the settings file.
 * Falls back to environment variable defaults if the file doesn't exist.
 */
export async function loadWebSearchSettings(
  projectRoot: string,
): Promise<WebSearchSettings> {
  const defaults = getDefaultWebSearchSettings();
  const settingsPath = join(
    projectRoot,
    ".psycheros",
    "web-search-settings.json",
  );

  try {
    const text = await Deno.readTextFile(settingsPath);
    const saved = JSON.parse(text) as Partial<WebSearchSettings>;
    // Merge saved settings over defaults (saved values take priority)
    return { ...defaults, ...saved };
  } catch {
    // File doesn't exist or is invalid - use defaults
    return defaults;
  }
}

/**
 * Save web search settings to the settings file.
 * Creates the `.psycheros/` directory if it doesn't exist.
 */
export async function saveWebSearchSettings(
  projectRoot: string,
  settings: WebSearchSettings,
): Promise<void> {
  const settingsDir = join(projectRoot, ".psycheros");
  const settingsPath = join(settingsDir, "web-search-settings.json");

  await Deno.mkdir(settingsDir, { recursive: true });
  await Deno.writeTextFile(
    settingsPath,
    JSON.stringify(settings, null, 2) + "\n",
  );
}

/**
 * Get a masked version of web search settings for safe display.
 * API keys are masked using the same logic as LLM settings.
 */
export function maskWebSearchSettings(
  settings: WebSearchSettings,
): WebSearchSettings {
  return {
    ...settings,
    tavilyApiKey: maskApiKey(settings.tavilyApiKey || ""),
    braveApiKey: maskApiKey(settings.braveApiKey || ""),
  };
}
