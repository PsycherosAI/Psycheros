/**
 * Local Embedder
 *
 * Generates embeddings using HuggingFace Transformers (via @xenova/transformers).
 * Runs entirely locally — no API calls required. The active model is chosen by
 * the user (`.psycheros/embedding-settings.json`); defaults preserve the
 * historical all-MiniLM-L6-v2 behavior.
 */

import type { Embedder } from "./types.ts";
import {
  DEFAULT_EMBEDDING_REPO_ID,
  getDimensionForRepo,
} from "../embeddings/presets.ts";

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
 * Local embedder using Hugging Face Transformers.
 *
 * Constructed with an explicit `{ modelRepoId, dimension }` so callers can
 * pick the model at runtime. The singletons below default to MiniLM if no
 * setting has been chosen yet.
 */
export class LocalEmbedder implements Embedder {
  private readonly modelId: string;
  private readonly dimension: number;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  /** Pipeline bound to this embedder's model. Distinct from sibling instances. */
  private extractor: PipelineFunction | null = null;

  constructor(
    modelRepoId: string = DEFAULT_EMBEDDING_REPO_ID,
    dimension?: number,
  ) {
    this.modelId = modelRepoId;
    this.dimension = dimension ?? getDimensionForRepo(modelRepoId);
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
   * Reset the embedder state so the next call will re-initialize.
   */
  private reset(): void {
    this.extractor = null;
    this.initialized = false;
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

    this.initPromise = this.doInitialize();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async doInitialize(): Promise<void> {
    console.log(
      `[RAG] Loading embedding model ${this.modelId} (this may take a moment on first run)...`,
    );

    try {
      // Import Hugging Face Transformers v3
      // deno-lint-ignore no-explicit-any
      const { pipeline, env } = await import("@xenova/transformers") as any;

      // Cache models under dataRoot so Docker bind-mounts persist them.
      // Set before the pipeline() call so the first download lands here.
      // The dataRoot is resolved lazily from PSYCHEROS_DATA_DIR / cwd at
      // the call site that constructs the embedder.
      const dataRoot = Deno.env.get("PSYCHEROS_DATA_DIR") ?? Deno.cwd();
      const { join } = await import("@std/path");
      const { ensureDir } = await import("@std/fs");
      const cacheDir = join(dataRoot, ".psycheros", "model-cache");
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
            console.log(`[RAG] Downloading model${file}... ${pct}%`);
          } else if (progress.status === "loading") {
            console.log(`[RAG] Loading model into memory...`);
          }
        },
      });

      this.initialized = true;
      console.log("[RAG] Embedding model loaded successfully");
    } catch (error) {
      console.error("[RAG] Failed to load embedding model:", error);
      throw new Error(
        `Failed to load embedding model: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Generate an embedding for the given text.
   * On ONNX runtime failure (e.g. "Cannot read properties of undefined (reading 'constructor')"),
   * re-initializes the model and retries once.
   *
   * @param text - The text to embed
   * @returns A dimensional embedding vector matching the active model
   */
  async embed(text: string): Promise<number[]> {
    for (let attempt = 0; attempt <= EMBEDDER_MAX_RETRIES; attempt++) {
      if (!this.isReady()) {
        await this.initialize();
      }

      if (!this.extractor) {
        throw new Error("Embedder not initialized");
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
          console.warn(
            `[RAG] ONNX runtime error on attempt ${
              attempt + 1
            }, re-initializing embedder: ${error.message}`,
          );
          this.reset();
          continue;
        }

        console.error("[RAG] Failed to generate embedding:", error);
        throw new Error(
          `Failed to generate embedding: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Should not reach here, but satisfy the type checker
    throw new Error("Embedder failed after retries");
  }
}

/**
 * Singleton instance of the local embedder. Lazily constructed on first
 * `getEmbedder()` call. Call `resetEmbedder()` when the active model changes
 * — ONNX holds the previous model's weights in memory and a switch without
 * reset would silently embed against the wrong model.
 */
let embedderInstance: LocalEmbedder | null = null;

/**
 * Config used to construct the singleton. Defaults preserve historical
 * MiniLM behavior. Callers that need to switch models should call
 * `resetEmbedder()` first, then `setEmbedderConfig()`, then `getEmbedder()`.
 */
let embedderConfig: { modelRepoId: string; dimension: number } = {
  modelRepoId: DEFAULT_EMBEDDING_REPO_ID,
  dimension: getDimensionForRepo(DEFAULT_EMBEDDING_REPO_ID),
};

/**
 * Set the model the singleton will use on next instantiation. Does not
 * dispose an existing singleton — pair with `resetEmbedder()` to switch
 * an already-loaded model.
 */
export function setEmbedderConfig(
  modelRepoId: string,
  dimension: number,
): void {
  embedderConfig = { modelRepoId, dimension };
}

/**
 * Get the singleton embedder instance. Constructed on first call with the
 * active `embedderConfig`.
 */
export function getEmbedder(): LocalEmbedder {
  if (!embedderInstance) {
    embedderInstance = new LocalEmbedder(
      embedderConfig.modelRepoId,
      embedderConfig.dimension,
    );
  }
  return embedderInstance;
}

/**
 * Tear down the singleton so the next `getEmbedder()` call instantiates with
 * the current `embedderConfig`. The re-embed orchestrator calls this when
 * the active model changes — without it, ONNX's cached weights for the old
 * model would be reused for new embeddings.
 */
export function resetEmbedder(): void {
  embedderInstance = null;
}
