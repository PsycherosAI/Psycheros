/**
 * Entity-Core LLM Settings Persistence
 *
 * Manages loading and saving entity-core LLM override settings to disk.
 * Settings are stored in `.psycheros/entity-core-llm-settings.json`.
 *
 * When a field is empty, entity-core inherits that value from the active
 * Psycheros LLM profile. Non-empty values override the profile defaults.
 */

import { join } from "@std/path";

// =============================================================================
// Types
// =============================================================================

/**
 * User-configurable entity-core LLM overrides persisted to disk.
 * Empty/undefined fields inherit from the active Psycheros LLM profile.
 */
export interface EntityCoreLLMSettings {
  /** Override model for entity-core tasks (empty = use profile model) */
  model?: string;
  /** Override temperature for entity-core tasks (empty = use 0.3 default) */
  temperature?: number;
  /** Override max tokens for entity-core tasks (empty = use 8000 default) */
  maxTokens?: number;
}

// =============================================================================
// Defaults
// =============================================================================

/**
 * Build default entity-core LLM settings.
 * All fields are undefined, meaning entity-core inherits from the active profile.
 */
export function getDefaultEntityCoreLLMSettings(): EntityCoreLLMSettings {
  return {};
}

// =============================================================================
// Load / Save
// =============================================================================

/**
 * Load entity-core LLM settings from the settings file.
 * Falls back to defaults if the file doesn't exist.
 */
export async function loadEntityCoreLLMSettings(
  projectRoot: string,
): Promise<EntityCoreLLMSettings> {
  const defaults = getDefaultEntityCoreLLMSettings();
  const settingsPath = join(
    projectRoot,
    ".psycheros",
    "entity-core-llm-settings.json",
  );

  try {
    const text = await Deno.readTextFile(settingsPath);
    const saved = JSON.parse(text) as Partial<EntityCoreLLMSettings>;
    return { ...defaults, ...saved };
  } catch {
    return defaults;
  }
}

/**
 * Save entity-core LLM settings to the settings file.
 * Creates the `.psycheros/` directory if it doesn't exist.
 */
export async function saveEntityCoreLLMSettings(
  projectRoot: string,
  settings: EntityCoreLLMSettings,
): Promise<void> {
  const settingsDir = join(projectRoot, ".psycheros");
  const settingsPath = join(settingsDir, "entity-core-llm-settings.json");

  await Deno.mkdir(settingsDir, { recursive: true });
  await Deno.writeTextFile(
    settingsPath,
    JSON.stringify(settings, null, 2) + "\n",
  );
}
