/**
 * Local Embedder
 *
 * Generates embeddings using Hugging Face Transformers via @xenova/transformers.
 * Runs entirely locally — no API calls required.
 *
 * The active model is supplied by my Psycheros parent via the
 * `ENTITY_CORE_EMBEDDING_*` env vars (see `./settings.ts`); I fall back to
 * MiniLM defaults when I'm running standalone without Psycheros. Whichever
 * model is in use, it must match Psycheros's choice — different dimensions
 * break the cross-package graph search.
 */

import { loadEmbeddingRuntimeConfig } from "./settings.ts";

// Type for the feature extraction pipeline result
interface FeatureExtractionResult {
  data: Float32Array;
  dims: number[];
}

// Type for the pipeline function
type PipelineFunction = (
  inputs: string,
  options?: { pooling?: "mean" | "cls" | "none"; normalize?: boolean },
) => Promise<FeatureExtractionResult>;

/** Maximum retries after ONNX runtime failures before giving up. */
const EMBEDDER_MAX_RETRIES = 1;

/**
 * Local embedder using Hugging Face Transformers. Constructed with an
 * explicit `{ modelRepoId, dimension }` so callers can pick the model at
 * runtime. The singleton below defaults from `loadEmbeddingRuntimeConfig()`.
 */
export class LocalEmbedder {
  private readonly modelId: string;
  private readonly dimension: number;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private initFailed = false;
  /** Pipeline bound to this embedder's model. Distinct from sibling instances. */
  private extractor: PipelineFunction | null = null;

  constructor(modelRepoId: string, dimension: number) {
    this.modelId = modelRepoId;
    this.dimension = dimension;
  }

  /**
   * Get the output dimension of this embedder's model.
   */
  getDimension(): number {
    return this.dimension;
  }

  /**
   * Check if the model is loaded and ready.
   */
  isReady(): boolean {
    return this.initialized && this.extractor !== null;
  }

  /**
   * Check if initialization has been attempted and failed.
   */
  hasFailed(): boolean {
    return this.initFailed;
  }

  /**
   * Reset the embedder state so the next call will re-initialize.
   */
  private reset(): void {
    this.extractor = null;
    this.initialized = false;
    this.initFailed = false;
    this.initPromise = null;
  }

  /**
   * Initialize the embedder by loading the model.
   * Downloads the model on first use (size depends on the chosen preset).
   */
  async initialize(): Promise<void> {
    // Return existing promise if already initializing
    if (this.initPromise) {
      return this.initPromise;
    }

    // Return immediately if already initialized
    if (this.initialized && this.extractor) {
      return;
    }

    // Don't retry if init has failed
    if (this.initFailed) {
      return;
    }

    this.initPromise = this.doInitialize();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async doInitialize(): Promise<void> {
    console.error(
      `[Embeddings] Loading embedding model ${this.modelId} (this may take a moment on first run)...`,
    );

    try {
      // Import Hugging Face Transformers v3
      // deno-lint-ignore no-explicit-any
      const { pipeline, env } = await import("@xenova/transformers") as any;

      // Cache models under ENTITY_CORE_DATA_DIR so the same cache Psycheros
      // uses (when it spawned me) is reused — avoids redownloading on every
      // MCP restart.
      const dataDir = Deno.env.get("ENTITY_CORE_DATA_DIR") ?? "./data";
      const { join } = await import("@std/path");
      const { ensureDir } = await import("@std/fs");
      const cacheDir = join(dataDir, ".model-cache");
      try {
        await ensureDir(cacheDir);
        env.cacheDir = cacheDir;
        // Critical in Deno: the Web Cache API (`caches`) is available, so
        // Xenova defaults to using it and skips the filesystem cache
        // entirely. That puts models in Deno's opaque cache under
        // ~/.cache/deno — not in our configured cacheDir — and breaks the
        // isDownloaded check the UI relies on. Force the filesystem cache.
        env.useBrowserCache = false;
      } catch {
        // Non-fatal — fall back to transformers.js default cache.
      }

      // Create the feature extraction pipeline
      // v3 uses ONNX Runtime Web which doesn't require native bindings
      this.extractor = await pipeline("feature-extraction", this.modelId, {
        quantized: true,
        dtype: "fp32",
        progress_callback: (
          progress: { status: string; progress?: number; file?: string },
        ) => {
          if (
            progress.status === "downloading" && progress.progress !== undefined
          ) {
            const pct = progress.progress.toFixed(0);
            const file = progress.file
              ? ` (${progress.file.split("/").pop()})`
              : "";
            console.error(`[Embeddings] Downloading model${file}... ${pct}%`);
          } else if (progress.status === "loading") {
            console.error(`[Embeddings] Loading model into memory...`);
          }
        },
      });

      this.initialized = true;
      this.initFailed = false;
      console.error("[Embeddings] Embedding model loaded successfully");
    } catch (error) {
      this.initFailed = true;
      console.error("[Embeddings] Failed to load embedding model:", error);
      // Don't throw — allow graceful degradation
    }
  }

  /**
   * Generate an embedding for the given text.
   * On ONNX runtime failure, re-initializes the model and retries once.
   *
   * @param text - The text to embed
   * @returns A dimensional embedding vector, or null if the embedder is not available
   */
  async embed(text: string): Promise<number[] | null> {
    for (let attempt = 0; attempt <= EMBEDDER_MAX_RETRIES; attempt++) {
      if (!this.isReady()) {
        await this.initialize();
      }

      if (!this.extractor) {
        return null;
      }

      try {
        // Generate embedding with mean pooling and normalization
        const result = await this.extractor(text, {
          pooling: "mean",
          normalize: true,
        });

        // Convert Float32Array to regular array
        return Array.from(result.data);
      } catch (error) {
        const isONNXFailure = error instanceof Error &&
          (error.message.includes("reading 'constructor'") ||
            error.message.includes("onnxruntime") ||
            error.message.includes("Tensor"));

        if (isONNXFailure && attempt < EMBEDDER_MAX_RETRIES) {
          console.error(
            `[Embeddings] ONNX runtime error on attempt ${
              attempt + 1
            }, re-initializing: ${error.message}`,
          );
          this.reset();
          continue;
        }

        console.error("[Embeddings] Failed to generate embedding:", error);
        return null;
      }
    }

    return null;
  }
}

/**
 * Singleton instance of the local embedder. Lazily constructed on first
 * `getEmbedder()` call from the resolved runtime config. Call `resetEmbedder()`
 * when the env vars change (e.g. after a Psycheros MCP restart with a new
 * model) — ONNX holds the previous model's weights in memory.
 */
let embedderInstance: LocalEmbedder | null = null;

/**
 * Get the singleton embedder instance. Reads `ENTITY_CORE_EMBEDDING_*` env
 * vars at construction time to pick the model. Construction is deferred to
 * first call so that env-var changes from a Psycheros MCP restart are
 * reflected without me having to restart my own process — provided
 * `resetEmbedder()` was called between the env-var change and the next
 * `getEmbedder()`.
 */
export function getEmbedder(): LocalEmbedder {
  if (!embedderInstance) {
    const cfg = loadEmbeddingRuntimeConfig();
    embedderInstance = new LocalEmbedder(cfg.modelRepoId, cfg.dimension);
  }
  return embedderInstance;
}

/**
 * Tear down the singleton so the next `getEmbedder()` call instantiates with
 * whatever the env vars now say. Called by the rebuild-all tooling when my
 * Psycheros parent has restarted me with new embedding config.
 */
export function resetEmbedder(): void {
  embedderInstance = null;
}

export { EmbeddingCache } from "./cache.ts";
export type {
  CachedEmbedding,
  CacheSearchResult,
  EmbeddingCacheStats,
} from "./cache.ts";
export { computeMemoryKey } from "./cache.ts";
export { chunkContent, shouldChunk } from "./chunker.ts";
export type { MemoryChunk } from "./chunker.ts";
export type {
  ChunkParams,
  EntityCoreEmbeddingRuntimeConfig,
} from "./settings.ts";
export { loadEmbeddingRuntimeConfig } from "./settings.ts";
