/**
 * Tier 1 store — the ambient working stream.
 *
 * A separate SQLite file (`.psycheros/flux-working.db`) holding the
 * high-volume small-model observations, raw perception metadata, and
 * texture ticks. This is the security-footage layer: rolling retention
 * (default ~1 week, configurable), timestamp-indexed for time-windowed
 * lookback and replay. No RAG — direct-read by the noticing layer and
 * the promotion filter; the small model reads the recent window off the
 * buffer rather than retrieving against it.
 *
 * Flux owns this file top to bottom. It is deliberately separate from
 * `psycheros.db` so the high-volume write path doesn't burden the main
 * database, and so a constrained-storage operator can tune retention
 * without touching conversation history.
 */

import { Database } from "@db/sqlite";
import type { FluxObservation } from "./types.ts";
import { cosineSimilarity } from "./vector-math.ts";

// Re-exported for backward compatibility — the canonical home is vector-math.
export { cosineSimilarity };

// =============================================================================
// Source filter (for system isolation — Noticing vs Reverie)
// =============================================================================

/**
 * Optional filter for tier-1 queries. Uses the existing `source_organ_id`
 * column to separate observations by which system produced them.
 * `"reverie"` identifies reverie observations; everything else is noticing.
 */
export interface SourceFilter {
  /** Exclude observations from this source (e.g. `"reverie"` for noticing-only). */
  excludeSource?: string;
  /** Only observations from this source (e.g. `"reverie"` for reverie-only). */
  onlySource?: string;
}

/** Build a SQL fragment + params for the source filter, or empty if no filter. */
function sourceClause(
  filter?: SourceFilter,
): { clause: string; param?: string } {
  if (filter?.excludeSource) {
    return { clause: "AND source_organ_id != ?", param: filter.excludeSource };
  }
  if (filter?.onlySource) {
    return { clause: "AND source_organ_id = ?", param: filter.onlySource };
  }
  return { clause: "" };
}

// =============================================================================
// Schema
// =============================================================================

const TIER1_SCHEMA = `
  CREATE TABLE IF NOT EXISTS flux_observations (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    source_organ_id TEXT NOT NULL,
    source_organ_ids TEXT,
    content TEXT NOT NULL,
    salience REAL NOT NULL DEFAULT 0,
    embedding BLOB,
    tags TEXT NOT NULL DEFAULT '[]',
    promoted INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_flux_obs_timestamp
    ON flux_observations(timestamp);

  CREATE INDEX IF NOT EXISTS idx_flux_obs_salience
    ON flux_observations(salience DESC);

  CREATE INDEX IF NOT EXISTS idx_flux_obs_promoted
    ON flux_observations(promoted, timestamp);
`;

// =============================================================================
// Row type
// =============================================================================

interface FluxObservationRow {
  id: string;
  timestamp: string;
  source_organ_id: string;
  source_organ_ids: string | null;
  content: string;
  salience: number;
  embedding: Uint8Array | null;
  tags: string;
  promoted: number;
}

// =============================================================================
// Embedding serialization
// =============================================================================

/** Serialize a number[] embedding into a BLOB (Float32Array buffer). */
function embeddingToBlob(embedding: number[] | undefined): Uint8Array | null {
  if (!embedding || embedding.length === 0) return null;
  return new Uint8Array(new Float32Array(embedding).buffer);
}

/** Deserialize a BLOB back into a number[] embedding. */
function blobToEmbedding(blob: Uint8Array | null): number[] | undefined {
  if (!blob || blob.byteLength === 0) return undefined;
  const view = new Float32Array(
    blob.buffer,
    blob.byteOffset,
    blob.byteLength / 4,
  );
  return Array.from(view);
}

// =============================================================================
// Store
// =============================================================================

/** Cleanup cadence — hourly. */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Owns the tier-1 ambient working stream SQLite file. Single connection,
 * serialized within the event loop (same model as Psycheros's `DBClient`).
 */
export class Tier1Store {
  private db: Database;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(dbPath: string) {
    this.ensureDirectory(dbPath);
    this.db = new Database(dbPath);
    try {
      this.db.exec("PRAGMA foreign_keys = ON");
      // Transient contention is unlikely (single process) but busy_timeout
      // keeps cleanup-window overlaps from throwing — same defensive
      // pattern as entity-core's graph store.
      this.db.exec("PRAGMA busy_timeout = 5000");
      // Migration: full Sensory Organ provenance for mixed noticing
      // batches. Pre-existing rows read back as [source_organ_id].
      try {
        this.db.exec(
          "ALTER TABLE flux_observations ADD COLUMN source_organ_ids TEXT",
        );
      } catch {
        // Column exists — fine.
      }
      this.db.exec(TIER1_SCHEMA);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** Ensure the parent directory for the db file exists. */
  private ensureDirectory(dbPath: string): void {
    const lastSlash = dbPath.lastIndexOf("/");
    if (lastSlash > 0) {
      const dir = dbPath.substring(0, lastSlash);
      try {
        Deno.mkdirSync(dir, { recursive: true });
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) {
          throw error;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the rolling-retention cleanup timer. Observations older than
   * `retentionDays` are deleted on each tick. Call after construction.
   */
  startCleanupTimer(retentionDays: number): void {
    if (this.cleanupTimer !== null) return;
    const run = () => {
      try {
        const removed = this.cleanup(retentionDays);
        if (removed > 0) {
          console.log(
            `[Flux] Tier-1 cleanup removed ${removed} observations older than ${retentionDays}d`,
          );
        }
      } catch (error) {
        console.error(
          "[Flux] Tier-1 cleanup failed:",
          error instanceof Error ? error.message : String(error),
        );
      }
    };
    // Run once at start, then hourly.
    run();
    this.cleanupTimer = setInterval(run, CLEANUP_INTERVAL_MS);
  }

  /** Stop the cleanup timer. */
  stopCleanupTimer(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** Close the database connection. */
  close(): void {
    this.stopCleanupTimer();
    try {
      this.db.close();
    } catch {
      // Ignore close errors on shutdown.
    }
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  /** Insert an observation. Embedding is serialized to a BLOB. */
  insert(observation: FluxObservation): void {
    this.db.exec(
      `INSERT INTO flux_observations
        (id, timestamp, source_organ_id, source_organ_ids, content, salience, embedding, tags, promoted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        observation.id,
        observation.timestamp,
        observation.sourceOrganId,
        observation.sourceOrganIds
          ? JSON.stringify(observation.sourceOrganIds)
          : null,
        observation.content,
        observation.salience,
        embeddingToBlob(observation.embedding),
        JSON.stringify(observation.tags),
        observation.promoted ? 1 : 0,
      ],
    );
  }

  /** Mark an observation as promoted (so the filter doesn't re-scan it). */
  markPromoted(id: string): void {
    this.db.exec(
      `UPDATE flux_observations SET promoted = 1 WHERE id = ?`,
      [id],
    );
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Observations in a time window, oldest-first. For replay/lookback. */
  queryByTimeWindow(
    startISO: string,
    endISO: string,
    limit = 1000,
  ): FluxObservation[] {
    const stmt = this.db.prepare(
      `SELECT * FROM flux_observations
       WHERE timestamp >= ? AND timestamp <= ?
       ORDER BY timestamp ASC
       LIMIT ?`,
    );
    const rows = stmt.all<FluxObservationRow>(startISO, endISO, limit);
    stmt.finalize();
    return rows.map(rowToObservation);
  }

  /**
   * Top-N salient observations since a timestamp, most salient first.
   * Pass `{ excludeSource: "reverie" }` for noticing-only queries.
   */
  queryTopSalient(
    limit: number,
    sinceISO: string,
    filter?: SourceFilter,
  ): FluxObservation[] {
    const sc = sourceClause(filter);
    const stmt = this.db.prepare(
      `SELECT * FROM flux_observations
       WHERE timestamp >= ? ${sc.clause}
       ORDER BY salience DESC
       LIMIT ?`,
    );
    const rows = sc.param
      ? stmt.all<FluxObservationRow>(sinceISO, sc.param, limit)
      : stmt.all<FluxObservationRow>(sinceISO, limit);
    stmt.finalize();
    return rows.map(rowToObservation);
  }

  /**
   * The most recent N observations (newest first), for the SA presence field.
   * Pass `{ excludeSource: "reverie" }` for noticing-only.
   */
  queryMostRecent(limit: number, filter?: SourceFilter): FluxObservation[] {
    const sc = sourceClause(filter);
    const stmt = this.db.prepare(
      `SELECT * FROM flux_observations
       WHERE 1=1 ${sc.clause}
       ORDER BY timestamp DESC
       LIMIT ?`,
    );
    const rows = sc.param
      ? stmt.all<FluxObservationRow>(sc.param, limit)
      : stmt.all<FluxObservationRow>(limit);
    stmt.finalize();
    return rows.map(rowToObservation);
  }

  /**
   * Unpromoted observations since a timestamp, for the promotion filter
   * to scan. Ordered oldest-first so the filter sees them in arrival order.
   * Pass `{ excludeSource: "reverie" }` to exclude reverie (bypasses promotion).
   */
  queryUnpromoted(
    limit: number,
    sinceISO: string,
    filter?: SourceFilter,
  ): FluxObservation[] {
    const sc = sourceClause(filter);
    const stmt = this.db.prepare(
      `SELECT * FROM flux_observations
       WHERE promoted = 0 AND timestamp >= ? ${sc.clause}
       ORDER BY timestamp ASC
       LIMIT ?`,
    );
    const rows = sc.param
      ? stmt.all<FluxObservationRow>(sinceISO, sc.param, limit)
      : stmt.all<FluxObservationRow>(sinceISO, limit);
    stmt.finalize();
    return rows.map(rowToObservation);
  }

  /** Count of observations since a timestamp (or all, when omitted). */
  count(sinceISO?: string): number {
    const stmt = sinceISO
      ? this.db.prepare(
        `SELECT COUNT(*) as n FROM flux_observations WHERE timestamp >= ?`,
      )
      : this.db.prepare(`SELECT COUNT(*) as n FROM flux_observations`);
    const row =
      (sinceISO
        ? stmt.all<{ n: number }>(sinceISO)
        : stmt.all<{ n: number }>())[0];
    stmt.finalize();
    return row?.n ?? 0;
  }

  /**
   * Find observations whose content embedding is similar to a given
   * embedding (cosine ≥ threshold) within a time window — used by the
   * promotion filter's corroboration step. Returns matching observations.
   *
   * In-process cosine over the candidate set rather than sqlite-vec — the
   * corroboration window is small (default 5 min) so the scan is cheap,
   * and keeping tier 1 off the shared vec0 extension is deliberate (no
   * RAG on the high-volume tier).
   */
  querySimilar(
    embedding: number[],
    threshold: number,
    sinceISO: string,
    limit = 10,
    filter?: SourceFilter,
  ): FluxObservation[] {
    const sc = sourceClause(filter);
    const stmt = this.db.prepare(
      `SELECT * FROM flux_observations
       WHERE timestamp >= ? AND embedding IS NOT NULL ${sc.clause}
       ORDER BY timestamp DESC
       LIMIT 500`,
    );
    const rows = sc.param
      ? stmt.all<FluxObservationRow>(sinceISO, sc.param)
      : stmt.all<FluxObservationRow>(sinceISO);
    stmt.finalize();
    const candidates = rows.map(rowToObservation);
    const scored = candidates
      .map((obs) => ({
        obs,
        sim: obs.embedding ? cosineSimilarity(embedding, obs.embedding) : 0,
      }))
      .filter((x) => x.sim >= threshold)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, limit);
    return scored.map((x) => x.obs);
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  /**
   * Delete observations older than `maxAgeDays`. Returns the count removed.
   * Called from the cleanup timer.
   */
  cleanup(maxAgeDays: number): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
    this.db.exec(
      `DELETE FROM flux_observations WHERE timestamp < ?`,
      [cutoff],
    );
    return this.db.changes;
  }

  /**
   * Delete all observations — the workspace-clear path. Wipes the
   * ambient working stream so the entity starts with a clean sensory
   * slate. Tier-2 durable dialogue and Mood Organ state are cleared /
   * preserved separately by the caller (FluxManager.clearWorkspace).
   * Returns the count removed.
   */
  clear(): number {
    this.db.exec(`DELETE FROM flux_observations`);
    return this.db.changes;
  }
}

// =============================================================================
// Helpers
// =============================================================================

/** Convert a stored row into a FluxObservation. */
function rowToObservation(row: FluxObservationRow): FluxObservation {
  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags) as string[];
  } catch {
    tags = [];
  }
  return {
    id: row.id,
    timestamp: row.timestamp,
    sourceOrganId: row.source_organ_id,
    sourceOrganIds: row.source_organ_ids
      ? JSON.parse(row.source_organ_ids)
      : [row.source_organ_id],
    content: row.content,
    salience: row.salience,
    embedding: blobToEmbedding(row.embedding),
    tags,
    promoted: row.promoted === 1,
  };
}
