/**
 * Embeddings Module
 *
 * Configuration surface for the embedding model I (and entity-core) use to
 * vectorize memories, chat history, vault documents, and graph nodes. The
 * actual embedder runtime lives at `src/rag/embedder.ts` for historical
 * reasons; this module owns the settings + presets + download management.
 */

export type { ChunkParams, EmbeddingSettings } from "./settings.ts";
export {
  DEFAULT_CHUNK_PARAMS,
  getDefaultEmbeddingSettings,
  isPresetRepo,
  loadEmbeddingSettings,
  resolveDimension,
  saveEmbeddingSettings,
} from "./settings.ts";

export type { EmbeddingModelPreset } from "./presets.ts";
export {
  DEFAULT_EMBEDDING_REPO_ID,
  EMBEDDING_PRESETS,
  findPreset,
  getDimensionForRepo,
  getRecommendedChunkTargetChars,
} from "./presets.ts";

export type { EntityCoreEmbeddingSettings } from "./entity-core-embedding-settings.ts";
export {
  getDefaultEntityCoreEmbeddingSettings,
  loadEntityCoreEmbeddingSettings,
  saveEntityCoreEmbeddingSettings,
} from "./entity-core-embedding-settings.ts";

export {
  computeEntityCoreEmbeddingEnv,
  resolveEntityCoreEmbeddingConfig,
} from "./entity-core-env.ts";

export type {
  DownloadProgressEvent,
  DownloadState,
  DownloadStatus,
} from "./download-manager.ts";
export {
  DownloadManager,
  getDownloadManager,
  resetDownloadManager,
} from "./download-manager.ts";

export type {
  ReEmbedOrchestratorOptions,
  ReEmbedPhase,
  ReEmbedPlan,
  ReEmbedProgress,
  ReEmbedSnapshot,
} from "./re-embed.ts";
export { readActiveDimension, ReEmbedOrchestrator } from "./re-embed.ts";
