/**
 * Embedding Settings Persistence
 *
 * I manage the active embedding model configuration: which HuggingFace repo to
 * pull weights from, the chunking parameters I use when embedding long
 * memories and vault documents, and the resolved dimension that the rest of
 * the system reads at vec0-table-creation time.
 *
 * Stored at `.psycheros/embedding-settings.json`. Defaults match the
 * pre-configurability hardcoded values so existing installs upgrade without
 * any re-embedding on first boot.
 */

import { join } from "@std/path";
import {
  DEFAULT_EMBEDDING_REPO_ID,
  findPreset,
  getDimensionForRepo,
} from "./presets.ts";

// =============================================================================
// Types
// =============================================================================

/**
 * Chunking parameters I use when embedding long content. Mirrors the historical
 * hardcoded constants in `packages/entity-core/src/embeddings/chunker.ts` so the
 * defaults preserve existing behavior.
 */
export interface ChunkParams {
  /** Content length above which chunking kicks in. */
  thresholdChars: number;
  /** Target chunk size in characters. */
  targetChars: number;
  /** Minimum chunk size — smaller chunks get merged into neighbors. */
  minChars: number;
  /** Hard maximum per chunk. Oversized segments get hard-split. */
  maxChars: number;
  /** Overlap between consecutive chunks for boundary coverage. */
  overlapChars: number;
}

/**
 * User-configurable embedding settings persisted to disk.
 *
 * `modelRepoId` may be any HuggingFace repo ID (curated preset or custom).
 * `chunkParams` are stored explicitly so the user's tuning survives model
 * switches — the UI offers a separate "use recommended" action rather than
 * silently overwriting on preset change.
 */
export interface EmbeddingSettings {
  /** HuggingFace repo ID of the active model. */
  modelRepoId: string;
  /** Chunking parameters. */
  chunkParams: ChunkParams;
}

// =============================================================================
// Defaults
// =============================================================================

/**
 * Historical chunk sizes. These match the values that were hardcoded in
 * `packages/entity-core/src/embeddings/chunker.ts:13-25` before
 * configurability landed, so existing installs keep their existing chunk
 * boundaries after upgrade.
 */
export const DEFAULT_CHUNK_PARAMS: ChunkParams = {
  thresholdChars: 3000,
  targetChars: 2048,
  minChars: 400,
  maxChars: 2800,
  overlapChars: 200,
};

/**
 * Build default embedding settings. Matches the pre-configurability behavior
 * exactly: MiniLM with the historical chunk sizes.
 */
export function getDefaultEmbeddingSettings(): EmbeddingSettings {
  return {
    modelRepoId: DEFAULT_EMBEDDING_REPO_ID,
    chunkParams: { ...DEFAULT_CHUNK_PARAMS },
  };
}

// =============================================================================
// Load / Save
// =============================================================================

const SETTINGS_DIR = ".psycheros";
const SETTINGS_FILENAME = "embedding-settings.json";

function settingsPath(dataRoot: string): string {
  return join(dataRoot, SETTINGS_DIR, SETTINGS_FILENAME);
}

/**
 * Load embedding settings from disk. Falls back to defaults if the file is
 * missing, unparseable, or missing fields — every setting is optional at the
 * JSON level and merged over defaults, so partial files left by aborted
 * writes never break startup.
 */
export async function loadEmbeddingSettings(
  dataRoot: string,
): Promise<EmbeddingSettings> {
  const defaults = getDefaultEmbeddingSettings();

  try {
    const text = await Deno.readTextFile(settingsPath(dataRoot));
    const saved = JSON.parse(text) as Partial<EmbeddingSettings>;

    return {
      modelRepoId: typeof saved.modelRepoId === "string" && saved.modelRepoId
        ? saved.modelRepoId
        : defaults.modelRepoId,
      chunkParams: mergeChunkParams(saved.chunkParams, defaults.chunkParams),
    };
  } catch {
    return defaults;
  }
}

/**
 * Save embedding settings to disk. Creates the `.psycheros/` directory if it
 * doesn't exist. Atomic write via temp file + rename — the orchestrator
 * reads this file on the re-embed path and a half-written file would leave
 * the active model and the persisted state divergent.
 */
export async function saveEmbeddingSettings(
  dataRoot: string,
  settings: EmbeddingSettings,
): Promise<void> {
  const dir = join(dataRoot, SETTINGS_DIR);
  await Deno.mkdir(dir, { recursive: true });

  const finalPath = settingsPath(dataRoot);
  const tempPath = `${finalPath}.tmp`;
  await Deno.writeTextFile(tempPath, JSON.stringify(settings, null, 2) + "\n");
  await Deno.rename(tempPath, finalPath);
}

// =============================================================================
// Resolution helpers
// =============================================================================

/**
 * Resolve the effective dimension for the active model. Callers that need an
 * exact dimension for a custom (non-preset) repo should call the
 * probe-dimension API endpoint to fetch it from the model's config — this
 * function falls back to 384 for unknown repos so vec0 table creation always
 * has a usable value.
 */
export function resolveDimension(settings: EmbeddingSettings): number {
  return getDimensionForRepo(settings.modelRepoId);
}

/**
 * Whether the active model is one of the curated presets. UI uses this to
 * decide whether to show the preset dropdown or the custom-repo field as the
 * active selection.
 */
export function isPresetRepo(settings: EmbeddingSettings): boolean {
  return findPreset(settings.modelRepoId) !== undefined;
}

// =============================================================================
// Internal helpers
// =============================================================================

function mergeChunkParams(
  saved: Partial<ChunkParams> | undefined,
  defaults: ChunkParams,
): ChunkParams {
  if (!saved) return { ...defaults };

  const picked: ChunkParams = { ...defaults };
  if (typeof saved.thresholdChars === "number") {
    picked.thresholdChars = saved.thresholdChars;
  }
  if (typeof saved.targetChars === "number") {
    picked.targetChars = saved.targetChars;
  }
  if (typeof saved.minChars === "number") {
    picked.minChars = saved.minChars;
  }
  if (typeof saved.maxChars === "number") {
    picked.maxChars = saved.maxChars;
  }
  if (typeof saved.overlapChars === "number") {
    picked.overlapChars = saved.overlapChars;
  }
  return picked;
}
