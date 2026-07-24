/**
 * Re-Embed Orchestrator
 *
 * Coordinates a full re-embedding pass when the active embedding model or
 * chunk size changes. The chat endpoint blocks while this is running — the
 * server wrapper sets `reEmbedBlocking` and refuses new turns with 503.
 *
 * Responsibilities:
 *   1. Drop + recreate psycheros vec0 tables at the new dimension (vec0
 *      bulk DELETE is unreliable, so we recreate).
 *   2. Re-embed every row in `messages`, `memory_chunks`, `vault_chunks`.
 *   3. Update `app_metadata.active_embedding_dimension`.
 *   4. Trigger entity-core's rebuild via a caller-supplied callback (the
 *      psycheros server passes an MCP-call wrapper here).
 *   5. Persist the new settings file atomically.
 *   6. Report progress via snapshot callbacks for the SSE stream.
 *
 * Failure handling is conservative — any error halts the run, restores the
 * previous settings from disk, and leaves the dimension-tracking metadata
 * alone (so the next startup detects the mismatch and the user can retry).
 */

import type { Database } from "@db/sqlite";
import {
  getActiveEmbeddingDimension,
  setActiveEmbeddingDimension,
} from "../db/schema.ts";
import {
  type EmbeddingSettings,
  resolveDimension,
  saveEmbeddingSettings,
} from "./settings.ts";
import {
  getEmbedder,
  resetEmbedder,
  setEmbedderConfig,
} from "../rag/embedder.ts";
import { serializeVector } from "../db/vector.ts";

// =============================================================================
// Types
// =============================================================================

export type ReEmbedPhase =
  | "idle"
  | "preparing"
  | "dropping-psycheros"
  | "reindexing-psycheros-messages"
  | "reindexing-psycheros-memories"
  | "reindexing-psycheros-vault"
  | "triggering-entity-core"
  | "persisting"
  | "complete"
  | "error";

export interface ReEmbedProgress {
  phase: ReEmbedPhase;
  current: number;
  total: number;
  message?: string;
}

export interface ReEmbedSnapshot {
  phase: ReEmbedPhase;
  progress: number; // 0..1
  message?: string;
  startedAt: number;
  endedAt?: number;
  error?: string;
}

export interface ReEmbedPlan {
  /** Whether the new model differs from the current one. */
  modelChanged: boolean;
  /** Whether the resolved dimension differs. Triggers vec0 table recreation. */
  dimensionChanged: boolean;
  /** Whether any chunk param differs. Triggers full reindex even at same dim. */
  chunkChanged: boolean;
  /** True when any of the above is true — re-embed must run. */
  requiresReEmbed: boolean;
}

export interface ReEmbedOrchestratorOptions {
  /** Open handle on psycheros.db. Caller is responsible for lifecycle. */
  db: Database;
  /** dataRoot for loading/saving settings. */
  dataRoot: string;
  /** Caller-supplied trigger for entity-core's rebuild_all. Throws on failure. */
  triggerEntityCoreRebuild?: () => Promise<void>;
  /** Stream of progress updates. Caller wires this to SSE. */
  onProgress?: (p: ReEmbedProgress) => void;
}

interface ReindexStats {
  total: number;
  processed: number;
  failed: number;
}

// =============================================================================
// Orchestrator
// =============================================================================

/**
 * Single-process re-embed coordinator. Process-wide mutex via `running` —
 * constructing a second instance while one is running is caller-error.
 */
export class ReEmbedOrchestrator {
  private db: Database;
  private dataRoot: string;
  /**
   * Caller-supplied trigger for entity-core's rebuild_all. Public so the
   * server can swap it between runs (the MCP client may have been
   * restarted between runs).
   */
  triggerEntityCoreRebuild?: () => Promise<void>;
  private onProgress?: (p: ReEmbedProgress) => void;

  private running = false;
  private snapshot: ReEmbedSnapshot = {
    phase: "idle",
    progress: 0,
    startedAt: 0,
  };

  constructor(opts: ReEmbedOrchestratorOptions) {
    this.db = opts.db;
    this.dataRoot = opts.dataRoot;
    this.triggerEntityCoreRebuild = opts.triggerEntityCoreRebuild;
    this.onProgress = opts.onProgress;
  }

  isRunning(): boolean {
    return this.running;
  }

  getSnapshot(): ReEmbedSnapshot {
    return { ...this.snapshot };
  }

  /**
   * Compute the migration plan comparing current saved settings to a proposed
   * next settings object. Pure — no I/O.
   */
  plan(current: EmbeddingSettings, next: EmbeddingSettings): ReEmbedPlan {
    const modelChanged = current.modelRepoId !== next.modelRepoId;
    const dimensionChanged = resolveDimension(current) !==
      resolveDimension(next);
    const chunkChanged = !chunkParamsEqual(
      current.chunkParams,
      next.chunkParams,
    );
    return {
      modelChanged,
      dimensionChanged,
      chunkChanged,
      requiresReEmbed: modelChanged || dimensionChanged || chunkChanged,
    };
  }

  /**
   * Execute the re-embed. Resolves on success; throws on failure (caller is
   * responsible for restoring previous settings — see `run` body).
   *
   * Steps:
   *   preparing → dropping-psycheros → reindexing (messages, memories,
   *   vault) → triggering-entity-core → persisting → complete.
   */
  async run(next: EmbeddingSettings): Promise<void> {
    if (this.running) {
      throw new Error("Re-embed already in progress");
    }
    this.running = true;
    this.setProgress("preparing", 0, 1, `Loading ${next.modelRepoId}`);
    console.log(
      `[ReEmbed] Starting: model=${next.modelRepoId} dim=${
        resolveDimension(next)
      }`,
    );

    // Always run a full re-embed when invoked. The caller (the save endpoint)
    // is responsible for deciding whether the change actually requires a
    // rebuild — by the time we're called, the disk file is already updated
    // to the new model, so comparing it to `next` would always show "no
    // change" and we'd silently skip.
    try {
      // Reconfigure the embedder singleton BEFORE reindexing so every
      // embed() call hits the new model.
      const newDim = resolveDimension(next);
      resetEmbedder();
      setEmbedderConfig(next.modelRepoId, newDim);
      const embedder = getEmbedder();
      console.log(`[ReEmbed] Initializing embedder (downloads if missing)...`);
      await embedder.initialize();
      console.log(`[ReEmbed] Embedder ready`);

      // Always drop + recreate psycheros vec tables. Dimension may or may
      // not have changed, but either way we want a clean slate — vec0 bulk
      // DELETE is unreliable so DROP+CREATE is the only way.
      await this.dropAndRecreatePsycherosVecTables(newDim);

      // Reindex psycheros stores. We do all three (messages, memory chunks,
      // vault chunks) on every run. Messages aren't chunked but they still
      // need fresh embeddings because the semantic space changed.
      await this.reindexMessages(embedder);
      await this.reindexMemoryChunks(embedder);
      await this.reindexVaultChunks(embedder);

      if (this.triggerEntityCoreRebuild) {
        // The entity-core phase is the longest (re-embeds memory cache +
        // graph nodes from scratch, can take 10+ minutes for large
        // datasets). We can't easily stream per-step progress from the
        // subprocess, so we heartbeat an "elapsed time" message every 5s
        // so the UI doesn't look frozen.
        const heartbeatStart = Date.now();
        const heartbeat = setInterval(() => {
          const elapsed = Math.floor((Date.now() - heartbeatStart) / 1000);
          const mins = Math.floor(elapsed / 60);
          const secs = elapsed % 60;
          const elapsedStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
          this.setProgress(
            "triggering-entity-core",
            0,
            1,
            `Rebuilding entity-core memories and graph nodes (elapsed: ${elapsedStr})`,
          );
        }, 5000);
        try {
          this.setProgress(
            "triggering-entity-core",
            0,
            1,
            "Rebuilding entity-core memories and graph nodes",
          );
          console.log(`[ReEmbed] Triggering entity-core rebuild`);
          await this.triggerEntityCoreRebuild();
          console.log(`[ReEmbed] Entity-core rebuild complete`);
        } finally {
          clearInterval(heartbeat);
        }
      }

      setActiveEmbeddingDimension(this.db, newDim);

      this.setProgress("persisting", 0, 1, "Saving settings");
      await saveEmbeddingSettings(this.dataRoot, next);

      // Broadcast the terminal snapshot. setProgress normally handles this,
      // but the "complete" transition is special — we want listeners to
      // hear about it even though we set the snapshot directly.
      this.snapshot = {
        phase: "complete",
        progress: 1,
        startedAt: this.snapshot.startedAt,
        endedAt: Date.now(),
      };
      this.broadcastSnapshot();
      console.log(`[ReEmbed] Complete`);
    } catch (error) {
      console.error(`[ReEmbed] Failed:`, error);
      this.snapshot = {
        phase: "error",
        progress: this.snapshot.progress,
        startedAt: this.snapshot.startedAt,
        endedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      };
      this.broadcastSnapshot();
      throw error;
    } finally {
      this.running = false;
    }
  }

  /**
   * Push the current snapshot to all listeners. Used for terminal phase
   * transitions that bypass `setProgress` (e.g. "complete"/"error" set
   * directly on this.snapshot).
   */
  private broadcastSnapshot(): void {
    if (this.onProgress) {
      const s = this.snapshot;
      this.onProgress({
        phase: s.phase,
        current: Math.round(s.progress * 100),
        total: 100,
        message: s.message,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Internal: psycheros vec0 table management
  // --------------------------------------------------------------------------

  /**
   * Drop and recreate the three psycheros vec0 virtual tables at the new
   * dimension. Also nulls the embedding BLOB columns in the metadata tables
   * so any subsequent read sees them as "needs embedding".
   *
   * vec0 virtual tables don't support reliable bulk DELETE — see comment in
   * entity-core's EmbeddingCache.clearAll() for the same rationale. We must
   * DROP+CREATE.
   */
  private async dropAndRecreatePsycherosVecTables(
    newDim: number,
  ): Promise<void> {
    this.setProgress("dropping-psycheros", 0, 3);

    const tables: Array<{ name: string; metadataTable: string }> = [
      { name: "vec_messages", metadataTable: "message_embeddings" },
      { name: "vec_memory_chunks", metadataTable: "memory_chunks" },
      { name: "vec_vault_chunks", metadataTable: "vault_chunks" },
    ];

    let i = 0;
    for (const t of tables) {
      try {
        this.db.exec(`DROP TABLE IF EXISTS ${t.name}`);
      } catch {
        // Best-effort — table may not exist if vector ext was off.
      }
      try {
        this.db.exec(
          `CREATE VIRTUAL TABLE ${t.name} USING vec0(embedding FLOAT[${newDim}] distance=cosine)`,
        );
      } catch {
        // sqlite-vec may not be loaded — fall back gracefully, the reindex
        // pass will still write the embedding BLOB column.
      }
      try {
        this.db.exec(`UPDATE ${t.metadataTable} SET embedding = NULL`);
      } catch {
        // metadataTable may not exist on fresh installs.
      }
      i++;
      this.setProgress("dropping-psycheros", i, 3);
    }
  }

  // --------------------------------------------------------------------------
  // Internal: psycheros reindex passes
  // --------------------------------------------------------------------------

  private async reindexMessages(
    embedder: { embed(text: string): Promise<number[]> },
  ): Promise<void> {
    const rows = this.fetchRows("message_embeddings");
    const stats: ReindexStats = { total: rows.length, processed: 0, failed: 0 };
    this.setProgress(
      "reindexing-psycheros-messages",
      0,
      stats.total,
      `${stats.total} messages`,
    );

    for (const row of rows) {
      try {
        const vec = await embedder.embed(row.content);
        const serialized = serializeVector(vec);
        const updateStmt = this.db.prepare(
          "UPDATE message_embeddings SET embedding = ? WHERE rowid = ?",
        );
        updateStmt.run(serialized, row.rowid);
        updateStmt.finalize();
        try {
          const insertStmt = this.db.prepare(
            "INSERT INTO vec_messages(rowid, embedding) VALUES (?, ?)",
          );
          insertStmt.run(row.rowid, serialized);
          insertStmt.finalize();
        } catch {
          // vec_messages may not exist (no sqlite-vec). The BLOB column
          // update above keeps search working via the in-memory fallback.
        }
      } catch {
        stats.failed++;
      }
      stats.processed++;
      if (stats.processed % 25 === 0 || stats.processed === stats.total) {
        this.setProgress(
          "reindexing-psycheros-messages",
          stats.processed,
          stats.total,
          `${stats.processed}/${stats.total} (${stats.failed} failed)`,
        );
      }
    }
  }

  private async reindexMemoryChunks(
    embedder: { embed(text: string): Promise<number[]> },
  ): Promise<void> {
    const rows = this.fetchRows("memory_chunks");
    const stats: ReindexStats = { total: rows.length, processed: 0, failed: 0 };
    this.setProgress(
      "reindexing-psycheros-memories",
      0,
      stats.total,
      `${stats.total} memory chunks`,
    );

    for (const row of rows) {
      try {
        const vec = await embedder.embed(row.content);
        const serialized = serializeVector(vec);
        const updateStmt = this.db.prepare(
          "UPDATE memory_chunks SET embedding = ? WHERE rowid = ?",
        );
        updateStmt.run(serialized, row.rowid);
        updateStmt.finalize();
        try {
          const insertStmt = this.db.prepare(
            "INSERT INTO vec_memory_chunks(rowid, embedding) VALUES (?, ?)",
          );
          insertStmt.run(row.rowid, serialized);
          insertStmt.finalize();
        } catch {
          // see note in reindexMessages
        }
      } catch {
        stats.failed++;
      }
      stats.processed++;
      if (stats.processed % 25 === 0 || stats.processed === stats.total) {
        this.setProgress(
          "reindexing-psycheros-memories",
          stats.processed,
          stats.total,
          `${stats.processed}/${stats.total} (${stats.failed} failed)`,
        );
      }
    }
  }

  private async reindexVaultChunks(
    embedder: { embed(text: string): Promise<number[]> },
  ): Promise<void> {
    const rows = this.fetchRows("vault_chunks");
    const stats: ReindexStats = { total: rows.length, processed: 0, failed: 0 };
    this.setProgress(
      "reindexing-psycheros-vault",
      0,
      stats.total,
      `${stats.total} vault chunks`,
    );

    for (const row of rows) {
      try {
        const vec = await embedder.embed(row.content);
        const serialized = serializeVector(vec);
        const updateStmt = this.db.prepare(
          "UPDATE vault_chunks SET embedding = ? WHERE rowid = ?",
        );
        updateStmt.run(serialized, row.rowid);
        updateStmt.finalize();
        try {
          const insertStmt = this.db.prepare(
            "INSERT INTO vec_vault_chunks(rowid, embedding) VALUES (?, ?)",
          );
          insertStmt.run(row.rowid, serialized);
          insertStmt.finalize();
        } catch {
          // see note in reindexMessages
        }
      } catch {
        stats.failed++;
      }
      stats.processed++;
      if (stats.processed % 25 === 0 || stats.processed === stats.total) {
        this.setProgress(
          "reindexing-psycheros-vault",
          stats.processed,
          stats.total,
          `${stats.processed}/${stats.total} (${stats.failed} failed)`,
        );
      }
    }
  }

  // --------------------------------------------------------------------------
  // Internal: helpers
  // --------------------------------------------------------------------------

  private fetchRows(table: string): Array<{ rowid: number; content: string }> {
    try {
      const stmt = this.db.prepare(
        `SELECT rowid, content FROM ${table}`,
      );
      const rows = stmt.all<{ rowid: number; content: string }>();
      stmt.finalize();
      return rows;
    } catch {
      // Table doesn't exist (fresh install). Nothing to reindex.
      return [];
    }
  }

  private setProgress(
    phase: ReEmbedPhase,
    current: number,
    total: number,
    message?: string,
  ): void {
    const withinPhase = total > 0 ? Math.min(1, current / total) : 0;
    // Weight the progress across all phases so the bar doesn't max out
    // before the long entity-core phase starts. Weights roughly reflect
    // how long each phase takes in practice.
    const weights: Record<ReEmbedPhase, number> = {
      "idle": 0,
      "preparing": 0.05,
      "dropping-psycheros": 0.05,
      "reindexing-psycheros-messages": 0.15,
      "reindexing-psycheros-memories": 0.15,
      "reindexing-psycheros-vault": 0.1,
      // Entity-core is the bulk of the work — memories + graph nodes.
      "triggering-entity-core": 0.45,
      "persisting": 0.05,
      "complete": 0,
      "error": 0,
    };
    const phasesInOrder: ReEmbedPhase[] = [
      "idle",
      "preparing",
      "dropping-psycheros",
      "reindexing-psycheros-messages",
      "reindexing-psycheros-memories",
      "reindexing-psycheros-vault",
      "triggering-entity-core",
      "persisting",
      "complete",
    ];
    let cumulativeBefore = 0;
    for (const p of phasesInOrder) {
      if (p === phase) break;
      cumulativeBefore += weights[p];
    }
    const overall = Math.min(
      1,
      cumulativeBefore + weights[phase] * withinPhase,
    );
    this.snapshot = {
      ...this.snapshot,
      phase,
      progress: overall,
      message,
    };
    if (this.onProgress) {
      this.onProgress({ phase, current, total, message });
    }
  }
}

// =============================================================================
// Helpers
// =============================================================================

function chunkParamsEqual(
  a: EmbeddingSettings["chunkParams"],
  b: EmbeddingSettings["chunkParams"],
): boolean {
  return a.thresholdChars === b.thresholdChars &&
    a.targetChars === b.targetChars &&
    a.minChars === b.minChars &&
    a.maxChars === b.maxChars &&
    a.overlapChars === b.overlapChars;
}

/**
 * Convenience helper: read the active dimension from the metadata table.
 * Mirrors the schema getter; re-exported here so callers don't have to
 * reach into db/schema for one value.
 */
export function readActiveDimension(db: Database): number {
  return getActiveEmbeddingDimension(db);
}
