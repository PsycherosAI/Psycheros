/**
 * Memory Settings Persistence
 *
 * Manages loading and saving custom daily memory-writing instructions plus
 * the eager-RAG retrieval limit (how many memory chunks I pull into context
 * per turn). Settings are stored in `.psycheros/memory-settings.json`.
 *
 * Daily instructions are injected into the daily summarization prompt so the
 * entity can follow user-defined preferences when writing daily memories.
 * The RAG limit is passed as a per-call `maxResults` override to entity-core's
 * `memory_search` MCP tool — only affects the eager every-turn pull, not the
 * `memory_recall` tool, ChatRAG, or knowledge graph (those keep their own
 * limits). Written from the entity's first-person perspective.
 */

import { join } from "@std/path";

// =============================================================================
// Types
// =============================================================================

/** Min/max bounds for the eager-RAG chunk limit. */
export const RAG_MAX_CHUNKS_MIN = 1;
export const RAG_MAX_CHUNKS_MAX = 50;

/**
 * Memory settings — custom instructions for daily summarization plus the
 * eager-RAG retrieval limit.
 */
export interface MemorySettings {
  /** Custom instructions injected into the daily memory summarization prompt */
  dailyInstructions: string;
  /** How many memory chunks I pull into context per turn (1–50, default 10) */
  ragMaxChunks: number;
}

// =============================================================================
// Defaults
// =============================================================================

/**
 * Default memory settings — no custom instructions, 10-chunk RAG limit
 * (matches entity-core's fallback so behavior is unchanged for new installs).
 */
export function getDefaultMemorySettings(): MemorySettings {
  return {
    dailyInstructions: "",
    ragMaxChunks: 10,
  };
}

/**
 * Coerce a form-data value into a valid `ragMaxChunks` integer.
 * Out-of-range or unparseable input clamps silently to the bounds —
 * "integrations should just work", no error toast for bad input.
 */
export function clampRagMaxChunks(value: unknown): number {
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n)) return 10;
  return Math.max(RAG_MAX_CHUNKS_MIN, Math.min(RAG_MAX_CHUNKS_MAX, n));
}

// =============================================================================
// Load / Save
// =============================================================================

/**
 * Load memory settings from `.psycheros/memory-settings.json`.
 * Falls back to defaults when the file doesn't exist.
 */
export async function loadMemorySettings(
  dataRoot: string,
): Promise<MemorySettings> {
  const defaults = getDefaultMemorySettings();
  const settingsPath = join(dataRoot, ".psycheros", "memory-settings.json");

  try {
    const text = await Deno.readTextFile(settingsPath);
    const saved = JSON.parse(text) as Partial<MemorySettings>;
    return {
      ...defaults,
      ...saved,
      // Always sanitize the numeric field — corrupted/hand-edited files shouldn't
      // break the entity loop with NaN or out-of-range values.
      ragMaxChunks: clampRagMaxChunks(saved.ragMaxChunks),
    };
  } catch {
    return defaults;
  }
}

/**
 * Save memory settings to `.psycheros/memory-settings.json`.
 */
export async function saveMemorySettings(
  dataRoot: string,
  settings: MemorySettings,
): Promise<void> {
  const settingsDir = join(dataRoot, ".psycheros");
  const settingsPath = join(settingsDir, "memory-settings.json");

  await Deno.mkdir(settingsDir, { recursive: true });
  await Deno.writeTextFile(
    settingsPath,
    JSON.stringify(settings, null, 2) + "\n",
  );
}
