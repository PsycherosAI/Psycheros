/**
 * Entity-Core Embedding Runtime Config
 *
 * Resolves the embedding configuration I (entity-core) actually use at
 * runtime, by reading `ENTITY_CORE_EMBEDDING_*` env vars supplied by my
 * Psycheros parent at spawn time. When an env var is absent I fall back to
 * the historical hardcoded MiniLM defaults — this is what makes me usable as
 * a standalone subprocess without a Psycheros parent (e.g. for `deno task dev`
 * on my own).
 *
 * The Psycheros parent pushes these env vars from `.psycheros/embedding-settings.json`
 * (with optional overrides from `.psycheros/entity-core-embedding-settings.json`).
 * See `packages/psycheros/src/main.ts` for the spawn-time wiring.
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Chunking parameters. Structurally identical to Psycheros's ChunkParams so
 * chunk boundaries match across packages when the same model is in use.
 */
export interface ChunkParams {
  thresholdChars: number;
  targetChars: number;
  minChars: number;
  maxChars: number;
  overlapChars: number;
}

/**
 * Fully resolved embedding config. No optional fields — every field has a
 * concrete value by the time this is returned.
 */
export interface EntityCoreEmbeddingRuntimeConfig {
  /** HuggingFace repo ID, e.g. "sentence-transformers/all-MiniLM-L6-v2". */
  modelRepoId: string;
  /** Output vector dimension matching the active model. */
  dimension: number;
  /** Chunking parameters I use for long memories. */
  chunkParams: ChunkParams;
}

// =============================================================================
// Defaults (match historical hardcoded values)
// =============================================================================

const DEFAULT_MODEL_REPO_ID = "sentence-transformers/all-MiniLM-L6-v2";
const DEFAULT_DIMENSION = 384;
const DEFAULT_CHUNK_PARAMS: ChunkParams = {
  thresholdChars: 3000,
  targetChars: 2048,
  minChars: 400,
  maxChars: 2800,
  overlapChars: 200,
};

// =============================================================================
// Resolution
// =============================================================================

/**
 * Resolve my embedding runtime config from env vars. Falls back to MiniLM
 * defaults for any missing fields. Safe to call any number of times — pure
 * function of `Deno.env`.
 *
 * Values are read on every call so that a spawn-time env-var change (from a
 * Psycheros MCP restart) takes effect on next `getEmbedder()` instantiation
 * without restarting me.
 */
export function loadEmbeddingRuntimeConfig(): EntityCoreEmbeddingRuntimeConfig {
  const env = Deno.env;

  const modelRepoId = env.get("ENTITY_CORE_EMBEDDING_MODEL") ||
    DEFAULT_MODEL_REPO_ID;

  const dimRaw = env.get("ENTITY_CORE_EMBEDDING_DIMENSION");
  const dimension = dimRaw ? parseInt(dimRaw, 10) : DEFAULT_DIMENSION;

  const chunkParams: ChunkParams = { ...DEFAULT_CHUNK_PARAMS };
  const thresholdRaw = env.get("ENTITY_CORE_EMBEDDING_CHUNK_THRESHOLD");
  if (thresholdRaw) chunkParams.thresholdChars = parseInt(thresholdRaw, 10);
  const targetRaw = env.get("ENTITY_CORE_EMBEDDING_CHUNK_TARGET_CHARS");
  if (targetRaw) chunkParams.targetChars = parseInt(targetRaw, 10);
  const minRaw = env.get("ENTITY_CORE_EMBEDDING_CHUNK_MIN_CHARS");
  if (minRaw) chunkParams.minChars = parseInt(minRaw, 10);
  const maxRaw = env.get("ENTITY_CORE_EMBEDDING_CHUNK_MAX_CHARS");
  if (maxRaw) chunkParams.maxChars = parseInt(maxRaw, 10);
  const overlapRaw = env.get("ENTITY_CORE_EMBEDDING_OVERLAP_CHARS");
  if (overlapRaw) chunkParams.overlapChars = parseInt(overlapRaw, 10);

  return { modelRepoId, dimension, chunkParams };
}
