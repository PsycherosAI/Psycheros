/**
 * Entity-Core Embedding Settings Persistence
 *
 * Optional overrides for the embedding model entity-core uses, independent of
 * the model Psycheros uses for its own RAG. When a field is empty, entity-core
 * inherits that value from the active Psycheros embedding settings — same
 * pattern as `entity-core-llm-settings.ts`.
 *
 * Stored at `.psycheros/entity-core-embedding-settings.json`.
 *
 * Cross-package invariant: the *dimension* of entity-core's resolved model
 * must match Psycheros's resolved model. Different models with the same
 * dimension are allowed (e.g. user can override MiniLM with BGE-small — both
 * 384-dim). Different dimensions break graph search and are refused at save
 * time with a 400.
 */

import { join } from "@std/path";
import type { ChunkParams } from "./settings.ts";

// =============================================================================
// Types
// =============================================================================

/**
 * User-configurable entity-core embedding overrides persisted to disk.
 * All fields optional — empty/undefined inherits from Psycheros.
 */
export interface EntityCoreEmbeddingSettings {
  /**
   * Override model repo for entity-core. Empty/undefined = inherit from
   * Psycheros embedding settings.
   */
  modelRepoId?: string;
  /**
   * Per-field chunk parameter overrides. Unspecified fields inherit from
   * Psycheros. Allows fine-tuning (e.g. smaller chunks for entity-core
   * memories) without re-specifying the whole chunk config.
   */
  chunkParams?: Partial<ChunkParams>;
}

// =============================================================================
// Defaults
// =============================================================================

/**
 * Build default entity-core embedding settings. All fields undefined, meaning
 * entity-core inherits everything from Psycheros.
 */
export function getDefaultEntityCoreEmbeddingSettings(): EntityCoreEmbeddingSettings {
  return {};
}

// =============================================================================
// Load / Save
// =============================================================================

const SETTINGS_DIR = ".psycheros";
const SETTINGS_FILENAME = "entity-core-embedding-settings.json";

function settingsPath(dataRoot: string): string {
  return join(dataRoot, SETTINGS_DIR, SETTINGS_FILENAME);
}

/**
 * Load entity-core embedding overrides from disk. Falls back to defaults if
 * the file doesn't exist or is unparseable.
 */
export async function loadEntityCoreEmbeddingSettings(
  dataRoot: string,
): Promise<EntityCoreEmbeddingSettings> {
  const defaults = getDefaultEntityCoreEmbeddingSettings();

  try {
    const text = await Deno.readTextFile(settingsPath(dataRoot));
    const saved = JSON.parse(text) as Partial<EntityCoreEmbeddingSettings>;

    const out: EntityCoreEmbeddingSettings = {};
    if (typeof saved.modelRepoId === "string" && saved.modelRepoId) {
      out.modelRepoId = saved.modelRepoId;
    }
    if (
      saved.chunkParams && typeof saved.chunkParams === "object" &&
      Object.keys(saved.chunkParams).length > 0
    ) {
      const cp: Partial<ChunkParams> = {};
      const src = saved.chunkParams;
      if (typeof src.thresholdChars === "number") {
        cp.thresholdChars = src.thresholdChars;
      }
      if (typeof src.targetChars === "number") {
        cp.targetChars = src.targetChars;
      }
      if (typeof src.minChars === "number") cp.minChars = src.minChars;
      if (typeof src.maxChars === "number") cp.maxChars = src.maxChars;
      if (typeof src.overlapChars === "number") {
        cp.overlapChars = src.overlapChars;
      }
      if (Object.keys(cp).length > 0) out.chunkParams = cp;
    }
    return out;
  } catch {
    return defaults;
  }
}

/**
 * Save entity-core embedding overrides to disk. Creates the `.psycheros/`
 * directory if needed. Atomic write via temp + rename.
 */
export async function saveEntityCoreEmbeddingSettings(
  dataRoot: string,
  settings: EntityCoreEmbeddingSettings,
): Promise<void> {
  const dir = join(dataRoot, SETTINGS_DIR);
  await Deno.mkdir(dir, { recursive: true });

  const finalPath = settingsPath(dataRoot);
  const tempPath = `${finalPath}.tmp`;
  await Deno.writeTextFile(tempPath, JSON.stringify(settings, null, 2) + "\n");
  await Deno.rename(tempPath, finalPath);
}
