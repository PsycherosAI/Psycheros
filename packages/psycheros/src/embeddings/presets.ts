/**
 * Embedding Model Presets
 *
 * Catalog of vetted HuggingFace embedding models I (the entity) can run locally
 * via @xenova/transformers. Each preset carries the metadata the UI needs to
 * render a useful picker: dimensions, download size, max context, and a
 * recommended chunk target sized to the model's context window.
 *
 * Curated for companion-chat work — longer-context models (jina, nomic) are
 * marked recommended because they preserve narrative continuity across chunk
 * boundaries that would otherwise split mid-scene.
 */

export interface EmbeddingModelPreset {
  /** HuggingFace repo ID, e.g. "sentence-transformers/all-MiniLM-L6-v2". */
  repoId: string;
  /** Short display name for the dropdown, e.g. "MiniLM L6 v2". */
  label: string;
  /** Output vector dimension (384, 768, etc.). */
  dimension: number;
  /** Approximate download size in megabytes (ONNX quantized weights). */
  downloadSizeMb: number;
  /** Maximum input tokens the model accepts before truncating. */
  maxContextTokens: number;
  /** Chunk target in chars I recommend when this model is active. */
  recommendedChunkTargetChars: number;
  /** One-line description for the UI tooltip / advanced view. */
  description: string;
  /** Highlight in the UI as a recommended pick. */
  recommended?: boolean;
}

/**
 * The seven curated presets. Ordered smallest-footprint first within each
 * dimension tier so the dropdown reads naturally.
 */
export const EMBEDDING_PRESETS: readonly EmbeddingModelPreset[] = [
  {
    repoId: "sentence-transformers/all-MiniLM-L6-v2",
    label: "MiniLM L6 v2",
    dimension: 384,
    downloadSizeMb: 80,
    maxContextTokens: 512,
    recommendedChunkTargetChars: 2048,
    description:
      "Small and fast. Ships as the default so I run well on low-resource hardware.",
  },
  {
    repoId: "Xenova/all-MiniLM-L6-v2",
    label: "MiniLM L6 v2 (Xenova)",
    dimension: 384,
    downloadSizeMb: 80,
    maxContextTokens: 512,
    recommendedChunkTargetChars: 2048,
    description:
      "Same model as above, pre-converted by Xenova. Useful fallback if the sentence-transformers repo has ONNX fetch issues.",
  },
  {
    repoId: "BAAI/bge-small-en-v1.5",
    label: "BGE small v1.5",
    dimension: 384,
    downloadSizeMb: 120,
    maxContextTokens: 512,
    recommendedChunkTargetChars: 2048,
    description:
      "Same footprint as MiniLM with stronger retrieval quality on emotional and conversational text.",
  },
  {
    repoId: "Cohee/jina-embeddings-v2-base-en",
    label: "Jina v2 base (EN)",
    dimension: 768,
    downloadSizeMb: 320,
    maxContextTokens: 8192,
    recommendedChunkTargetChars: 4096,
    description:
      "SillyTavern's default. Long context (8192 tokens) means chunk boundaries don't split mid-scene.",
    recommended: true,
  },
  {
    repoId: "nomic-ai/nomic-embed-text-v1.5",
    label: "Nomic Embed v1.5",
    dimension: 768,
    downloadSizeMb: 270,
    maxContextTokens: 8192,
    recommendedChunkTargetChars: 4096,
    description:
      "Strong retrieval benchmarks with 8192-token context. Smaller than jina, similar quality.",
    recommended: true,
  },
  {
    repoId: "Xenova/all-mpnet-base-v2",
    label: "MPNet base v2",
    dimension: 768,
    downloadSizeMb: 420,
    maxContextTokens: 384,
    recommendedChunkTargetChars: 2048,
    description:
      "Strong general-purpose baseline. Short context (384) means chunk sizes stay modest.",
  },
  {
    repoId: "BAAI/bge-base-en-v1.5",
    label: "BGE base v1.5",
    dimension: 768,
    downloadSizeMb: 420,
    maxContextTokens: 512,
    recommendedChunkTargetChars: 2048,
    description:
      "Higher-quality than MPNet on most benchmarks. Mid-size footprint, mid-size context.",
  },
];

/**
 * The repo I use on fresh installs and whenever no setting has been chosen.
 * Matches the pre-configurability default so existing installs keep working
 * without re-embedding on first boot after upgrade.
 */
export const DEFAULT_EMBEDDING_REPO_ID: string =
  "sentence-transformers/all-MiniLM-L6-v2";

/**
 * Find a preset by repo ID. Returns undefined for custom repos that aren't
 * in the curated list — callers should treat that as a valid "custom model"
 * case, not an error.
 */
export function findPreset(repoId: string): EmbeddingModelPreset | undefined {
  return EMBEDDING_PRESETS.find((p) => p.repoId === repoId);
}

/**
 * Look up the output dimension for a repo ID. Falls back to 384 (MiniLM) when
 * the repo isn't a known preset — callers that need an exact dimension for a
 * custom repo should use the probe-dimension API endpoint instead.
 */
export function getDimensionForRepo(repoId: string): number {
  return findPreset(repoId)?.dimension ?? 384;
}

/**
 * Look up the recommended chunk target for a repo ID. Falls back to 2048
 * (the historical hardcoded value) for custom repos.
 */
export function getRecommendedChunkTargetChars(repoId: string): number {
  return findPreset(repoId)?.recommendedChunkTargetChars ?? 2048;
}
