/**
 * Embedding Model Download Manager
 *
 * Wraps @xenova/transformers `pipeline()` so the UI can pre-fetch an embedding
 * model and show download progress before the user commits to switching.
 *
 * Without this, the first attempt to use a new model happens inside an active
 * entity turn — the user sees a long pause with no feedback while Xenova
 * downloads the ONNX weights. Pre-fetching via this manager lets the settings
 * page show a progress bar and a "ready to switch" badge instead.
 *
 * The actual cache directory is configured in `src/rag/embedder.ts` and
 * `packages/entity-core/src/embeddings/mod.ts` — both already set
 * `env.cacheDir` to `${dataRoot}/.psycheros/model-cache/` before any pipeline
 * call. This module reads from that cache to check if a model is already
 * present.
 */

import { join } from "@std/path";
import { exists } from "@std/fs/exists";

// =============================================================================
// Types
// =============================================================================

export type DownloadState = "idle" | "downloading" | "ready" | "error";

export interface DownloadStatus {
  repoId: string;
  state: DownloadState;
  /** Current file being fetched, if downloading. */
  currentFile?: string;
  /** 0..100 percent of the current file. */
  percent?: number;
  /** Error message if state === "error". */
  error?: string;
}

export interface DownloadProgressEvent {
  repoId: string;
  status: DownloadStatus;
}

// =============================================================================
// Manager
// =============================================================================

/**
 * Singleton. Tracks in-flight and completed downloads for the settings UI.
 *
 * Not a queue — concurrent downloads of different models are allowed, but
 * the UI is expected to serialize them to keep bandwidth reasonable.
 */
export class DownloadManager {
  private dataRoot: string;
  private statuses = new Map<string, DownloadStatus>();
  private listeners = new Set<(e: DownloadProgressEvent) => void>();
  private inFlight = new Map<string, Promise<void>>();
  /**
   * Repo IDs that have been successfully downloaded via this manager. Loaded
   * from `.psycheros/downloaded-models.json` at construction so the state
   * survives daemon restarts.
   *
   * Note: this is a record of intent ("user clicked Download and it
   * completed"), not a guarantee the model is still on disk. Xenova's
   * filesystem cache in Deno is unreliable, so we treat this list as the
   * source of truth for UI display.
   */
  private downloadedRepos: Set<string> = new Set();
  private downloadedLogLoaded = false;

  constructor(dataRoot: string) {
    this.dataRoot = dataRoot;
  }

  /**
   * Subscribe to progress updates. Returns an unsubscribe function.
   * The SSE endpoint wraps this with an EventSource sink.
   */
  onProgress(listener: (e: DownloadProgressEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Get the current status for a repo. Returns "idle" if no download has been
   * attempted in this session. To check whether the model is on disk (across
   * sessions), use `isDownloaded()`.
   */
  getStatus(repoId: string): DownloadStatus {
    return this.statuses.get(repoId) ?? { repoId, state: "idle" };
  }

  /**
   * Check whether a model has been downloaded. We check two places:
   *
   *   1. The on-disk Xenova cache at `${dataRoot}/.psycheros/model-cache/${repoId}/`.
   *      Xenova writes here when `env.useBrowserCache = false` (forced by the
   *      embedder init) — without that, files go into Deno's opaque Web Cache.
   *
   *   2. The `downloaded-models.json` log, which records successful UI-triggered
   *      downloads. Belt-and-suspenders for cases where the filesystem check
   *      fails or the cache was cleared.
   *
   * The active model is always treated as downloaded by the caller (server).
   */
  async isDownloaded(repoId: string): Promise<boolean> {
    await this.ensureDownloadedLogLoaded();
    if (this.downloadedRepos.has(repoId)) return true;
    const cacheDir = join(
      this.dataRoot,
      ".psycheros",
      "model-cache",
      repoId,
    );
    try {
      return await exists(cacheDir);
    } catch {
      return false;
    }
  }

  /**
   * Trigger a download. Resolves when the model is fully downloaded and
   * loaded into a pipeline (which is then disposed — we don't keep it
   * resident; the embedder singleton will re-instantiate on demand).
   *
   * Safe to call multiple times for the same repoId — concurrent calls
   * share a single underlying promise.
   */
  async download(repoId: string): Promise<void> {
    if (this.inFlight.has(repoId)) {
      return this.inFlight.get(repoId);
    }

    const promise = this.doDownload(repoId).catch((error) => {
      this.setStatus({
        repoId,
        state: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't keep the failed promise cached — allow retry.
      this.inFlight.delete(repoId);
      throw error;
    });

    this.inFlight.set(repoId, promise);
    return promise;
  }

  private async doDownload(repoId: string): Promise<void> {
    this.setStatus({ repoId, state: "downloading", percent: 0 });

    // deno-lint-ignore no-explicit-any
    const { pipeline, env } = await import("@xenova/transformers") as any;

    const cacheDir = join(this.dataRoot, ".psycheros", "model-cache");
    try {
      await Deno.mkdir(cacheDir, { recursive: true });
      env.cacheDir = cacheDir;
    } catch {
      // Non-fatal — Xenova will fall back to its default cache.
    }

    const extractor = await pipeline("feature-extraction", repoId, {
      quantized: true,
      dtype: "fp32",
      progress_callback: (progress: {
        status: string;
        progress?: number;
        file?: string;
      }) => {
        if (
          progress.status === "downloading" && progress.progress !== undefined
        ) {
          this.setStatus({
            repoId,
            state: "downloading",
            percent: progress.progress,
            currentFile: progress.file?.split("/").pop(),
          });
        } else if (progress.status === "ready") {
          this.setStatus({ repoId, state: "ready" });
        }
      },
    });

    // Dispose the pipeline immediately — the embedder singleton will
    // re-instantiate on next use. Keeping it resident here would waste RAM
    // for models the user hasn't switched to yet.
    try {
      // deno-lint-ignore no-explicit-any
      await (extractor as any).dispose?.();
    } catch {
      // dispose may not be implemented in all versions — non-fatal.
    }

    // Persist the download record so the badge survives daemon restarts.
    // Xenova's filesystem cache isn't reliably written in Deno, so this
    // log is the source of truth for "has the user downloaded this?".
    this.downloadedRepos.add(repoId);
    await this.persistDownloadedLog();

    this.setStatus({ repoId, state: "ready" });
  }

  private setStatus(status: DownloadStatus): void {
    this.statuses.set(status.repoId, status);
    const event: DownloadProgressEvent = { repoId: status.repoId, status };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors are non-fatal.
      }
    }
  }

  /**
   * Lazy-load the downloaded-models log on first `isDownloaded` call. Keeps
   * cold start fast if the user never opens the embeddings tab.
   */
  private async ensureDownloadedLogLoaded(): Promise<void> {
    if (this.downloadedLogLoaded) return;
    this.downloadedLogLoaded = true;
    try {
      const text = await Deno.readTextFile(this.downloadedLogPath());
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        for (const repoId of parsed) {
          if (typeof repoId === "string") this.downloadedRepos.add(repoId);
        }
      }
    } catch {
      // File doesn't exist yet — fine, start empty.
    }
  }

  private async persistDownloadedLog(): Promise<void> {
    try {
      const dir = join(this.dataRoot, ".psycheros");
      await Deno.mkdir(dir, { recursive: true });
      const text = JSON.stringify([...this.downloadedRepos].sort(), null, 2);
      const tmp = `${this.downloadedLogPath()}.tmp`;
      await Deno.writeTextFile(tmp, text);
      await Deno.rename(tmp, this.downloadedLogPath());
    } catch (err) {
      console.warn("[DownloadManager] Failed to persist log:", err);
    }
  }

  private downloadedLogPath(): string {
    return join(this.dataRoot, ".psycheros", "downloaded-models.json");
  }
}

// =============================================================================
// Singleton
// =============================================================================

let downloadManagerInstance: DownloadManager | null = null;

export function getDownloadManager(dataRoot: string): DownloadManager {
  if (!downloadManagerInstance) {
    downloadManagerInstance = new DownloadManager(dataRoot);
  }
  return downloadManagerInstance;
}

/**
 * Test-only: reset the singleton. Production code should never call this.
 */
export function resetDownloadManager(): void {
  downloadManagerInstance = null;
}
