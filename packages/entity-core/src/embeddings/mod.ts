/**
 * Local Embedder
 *
 * Generates embeddings using Hugging Face Transformers with the all-MiniLM-L6-v2 model.
 * Runs entirely locally — no API calls required.
 *
 * Uses the same model and pipeline as Psycheros for embedding consistency
 * across the entity's systems.
 */

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

// Singleton pipeline instance
let extractor: PipelineFunction | null = null;

/** Maximum retries after ONNX runtime failures before giving up. */
const EMBEDDER_MAX_RETRIES = 1;

/**
 * Local embedder using Hugging Face Transformers.
 * Uses the all-MiniLM-L6-v2 model (384 dimensions, ~80MB download on first use).
 */
export class LocalEmbedder {
  private readonly modelId = "sentence-transformers/all-MiniLM-L6-v2";
  private readonly dimension = 384;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private initFailed = false;

  /**
   * Get the dimension of embeddings (384 for all-MiniLM-L6-v2).
   */
  getDimension(): number {
    return this.dimension;
  }

  /**
   * Check if the model is loaded and ready.
   */
  isReady(): boolean {
    return this.initialized && extractor !== null;
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
    extractor = null;
    this.initialized = false;
    this.initFailed = false;
    this.initPromise = null;
  }

  /**
   * Initialize the embedder by loading the model.
   * This downloads the model on first use (~80MB) and caches it locally.
   */
  async initialize(): Promise<void> {
    // Return existing promise if already initializing
    if (this.initPromise) {
      return this.initPromise;
    }

    // Return immediately if already initialized
    if (this.initialized && extractor) {
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
      "[Embeddings] Loading embedding model (this may take a moment on first run)...",
    );

    try {
      // Import Hugging Face Transformers v3
      // deno-lint-ignore no-explicit-any
      const { pipeline } = await import("@xenova/transformers") as any;

      // Create the feature extraction pipeline
      // v3 uses ONNX Runtime Web which doesn't require native bindings
      extractor = await pipeline("feature-extraction", this.modelId, {
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
   * @returns A 384-dimensional embedding vector, or null if the embedder is not available
   */
  async embed(text: string): Promise<number[] | null> {
    for (let attempt = 0; attempt <= EMBEDDER_MAX_RETRIES; attempt++) {
      if (!this.isReady()) {
        await this.initialize();
      }

      if (!extractor) {
        return null;
      }

      try {
        // Generate embedding with mean pooling and normalization
        const result = await extractor(text, {
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
 * Singleton instance of the local embedder.
 */
let embedderInstance: LocalEmbedder | null = null;

/**
 * Get the singleton embedder instance.
 */
export function getEmbedder(): LocalEmbedder {
  if (!embedderInstance) {
    embedderInstance = new LocalEmbedder();
  }
  return embedderInstance;
}

export { EmbeddingCache } from "./cache.ts";
export type { CachedEmbedding, EmbeddingCacheStats } from "./cache.ts";
export { computeMemoryKey } from "./cache.ts";
