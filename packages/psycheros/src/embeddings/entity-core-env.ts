/**
 * Entity-Core Embedding Env Vars
 *
 * Computes the `ENTITY_CORE_EMBEDDING_*` env-var map that Psycheros pushes
 * to the entity-core subprocess at spawn time (and on MCP restart). Encodes
 * the resolved model, dimension, and chunk params — entity-core reads these
 * via `loadEmbeddingRuntimeConfig()` on its end.
 *
 * Extracted as a standalone helper so both `main.ts` (initial spawn) and
 * `server.ts` (restart on save) compute the env consistently.
 */

import type { ChunkParams, EmbeddingSettings } from "./settings.ts";
import type { EntityCoreEmbeddingSettings } from "./entity-core-embedding-settings.ts";
import { resolveDimension } from "./settings.ts";

/**
 * Merge entity-core overrides onto Psycheros's active settings, producing
 * the effective config entity-core should use. Empty/undefined override
 * fields inherit from Psycheros.
 */
export function resolveEntityCoreEmbeddingConfig(
  psycheros: EmbeddingSettings,
  override: EntityCoreEmbeddingSettings,
): { modelRepoId: string; dimension: number; chunkParams: ChunkParams } {
  const modelRepoId = override.modelRepoId ?? psycheros.modelRepoId;
  const dimension = resolveDimension({ ...psycheros, modelRepoId });
  const chunkParams: ChunkParams = { ...psycheros.chunkParams };
  if (override.chunkParams) {
    const o = override.chunkParams;
    if (typeof o.thresholdChars === "number") {
      chunkParams.thresholdChars = o.thresholdChars;
    }
    if (typeof o.targetChars === "number") {
      chunkParams.targetChars = o.targetChars;
    }
    if (typeof o.minChars === "number") chunkParams.minChars = o.minChars;
    if (typeof o.maxChars === "number") chunkParams.maxChars = o.maxChars;
    if (typeof o.overlapChars === "number") {
      chunkParams.overlapChars = o.overlapChars;
    }
  }
  return { modelRepoId, dimension, chunkParams };
}

/**
 * Build the env-var map to push to entity-core. Caller spreads this into
 * `createMCPClient({ env })` or `mcpClient.restart(env)`.
 */
export function computeEntityCoreEmbeddingEnv(
  psycheros: EmbeddingSettings,
  override: EntityCoreEmbeddingSettings,
): Record<string, string> {
  const resolved = resolveEntityCoreEmbeddingConfig(psycheros, override);
  return {
    ENTITY_CORE_EMBEDDING_MODEL: resolved.modelRepoId,
    ENTITY_CORE_EMBEDDING_DIMENSION: String(resolved.dimension),
    ENTITY_CORE_EMBEDDING_CHUNK_THRESHOLD: String(
      resolved.chunkParams.thresholdChars,
    ),
    ENTITY_CORE_EMBEDDING_CHUNK_TARGET_CHARS: String(
      resolved.chunkParams.targetChars,
    ),
    ENTITY_CORE_EMBEDDING_CHUNK_MIN_CHARS: String(
      resolved.chunkParams.minChars,
    ),
    ENTITY_CORE_EMBEDDING_CHUNK_MAX_CHARS: String(
      resolved.chunkParams.maxChars,
    ),
    ENTITY_CORE_EMBEDDING_OVERLAP_CHARS: String(
      resolved.chunkParams.overlapChars,
    ),
  };
}
