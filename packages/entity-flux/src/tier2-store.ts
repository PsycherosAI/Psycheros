/**
 * Tier 2 store — query helpers for the flux tables in the shared DB.
 *
 * Unlike `Tier1Store`, this does not own a database connection — it
 * operates on the shared `psycheros.db` handle obtained via
 * `DBClient.getRawDb()`. Single DB, single lock, single backup; flux
 * just queries its own tables.
 */

import type { Database } from "@db/sqlite";
import type {
  FluxDurableEntry,
  FluxEntryRole,
  FluxPromotedObservation,
} from "./types.ts";

// =============================================================================
// Row types
// =============================================================================

interface FluxDurableEntryRow {
  id: string;
  timestamp: string;
  role: string;
  content: string;
  source_observation_id: string | null;
  source_conversation_id: string | null;
  metadata: string | null;
}

interface FluxPromotedObservationRow {
  id: string;
  timestamp: string;
  original_observation_id: string;
  content: string;
  salience: number;
  promotion_reason: string;
  consolidated: number;
}

// =============================================================================
// Durable entries
// =============================================================================

/** Insert a durable-stream entry (a row on the Flux Space timeline).
 * Entries that carry an observation id are one-per-observation by the
 * partial unique index (schema.ts): when another writer already posted
 * the same observation, the insert is skipped and null returns — the
 * caller drops the row's downstream carriage (broadcast, briefing) so
 * the same observation never reaches the Ego twice. Entries without an
 * observation id (musing, reverie, markers) always insert. */
export function insertDurableEntry(
  db: Database,
  entry: FluxDurableEntry,
): FluxDurableEntry | null {
  db.exec(
    `INSERT OR IGNORE INTO flux_durable_entries
       (id, timestamp, role, content, source_observation_id, source_conversation_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.id,
      entry.timestamp,
      entry.role,
      entry.content,
      entry.sourceObservationId ?? null,
      entry.sourceConversationId ?? null,
      entry.metadata ? JSON.stringify(entry.metadata) : null,
    ],
  );
  // OR IGNORE swallows the index hit silently — read our own row back
  // to tell "inserted" from "another writer's row already exists".
  const check = db.prepare(
    `SELECT 1 FROM flux_durable_entries WHERE id = ?`,
  );
  const inserted = check.get(entry.id) !== undefined;
  check.finalize();
  return inserted ? entry : null;
}

/** Whether an ambient entry already exists for an observation. The
 * signaling wire posts its observation to the timeline at wake time;
 * when promotion later reaches the same observation, that post must
 * not be duplicated. */
export function hasDurableEntryForObservation(
  db: Database,
  observationId: string,
): boolean {
  const stmt = db.prepare(
    `SELECT 1 FROM flux_durable_entries
     WHERE source_observation_id = ?
     LIMIT 1`,
  );
  const row = stmt.get(observationId);
  stmt.finalize();
  return row !== undefined;
}

/** Flip the escalated tint on an existing timeline row: the signaling
 * wire posted the observation untinted (its own wake bid was damped),
 * and a later promotion wake fired for it. Returns the updated entry
 * for broadcast, or null when no row exists or it was already tinted. */
export function escalateDurableEntryForObservation(
  db: Database,
  observationId: string,
): FluxDurableEntry | null {
  const stmt = db.prepare(
    `SELECT id, timestamp, role, content, source_observation_id,
            source_conversation_id, metadata
     FROM flux_durable_entries
     WHERE source_observation_id = ?
     LIMIT 1`,
  );
  const row = stmt.get(observationId) as FluxDurableEntryRow | undefined;
  stmt.finalize();
  if (!row) return null;
  let metadata: Record<string, unknown>;
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : {};
  } catch {
    metadata = {};
  }
  if (metadata.escalated === true) return null;
  metadata.escalated = true;
  const upd = db.prepare(
    `UPDATE flux_durable_entries SET metadata = ? WHERE id = ?`,
  );
  upd.run(JSON.stringify(metadata), row.id);
  upd.finalize();
  return {
    id: row.id,
    timestamp: row.timestamp,
    role: row.role as FluxEntryRole,
    content: row.content,
    sourceObservationId: row.source_observation_id ?? undefined,
    sourceConversationId: row.source_conversation_id ?? undefined,
    metadata,
  };
}

/** The most recent N durable entries (the timeline view). Oldest-first. */
export function getRecentDurableEntries(
  db: Database,
  limit: number,
): FluxDurableEntry[] {
  const stmt = db.prepare(
    `SELECT * FROM flux_durable_entries
     ORDER BY timestamp DESC
     LIMIT ?`,
  );
  const rows = stmt.all<FluxDurableEntryRow>(limit);
  stmt.finalize();
  return rows.reverse().map(rowToDurableEntry);
}

/** Entries newer than `sinceISO` — for live (SSE-driven) timeline append. */
export function getDurableEntriesSince(
  db: Database,
  sinceISO: string,
  limit = 100,
): FluxDurableEntry[] {
  const stmt = db.prepare(
    `SELECT * FROM flux_durable_entries
     WHERE timestamp > ?
     ORDER BY timestamp ASC
     LIMIT ?`,
  );
  const rows = stmt.all<FluxDurableEntryRow>(sinceISO, limit);
  stmt.finalize();
  return rows.map(rowToDurableEntry);
}

/**
 * My own recent sayings — ambient entries the musing pass produced
 * (organId "musing"), newest `limit` within the window, oldest-first.
 * The musing voice layer's backing query.
 */
export function getRecentMusingEntries(
  db: Database,
  sinceISO: string,
  limit = 6,
): FluxDurableEntry[] {
  const stmt = db.prepare(
    `SELECT * FROM flux_durable_entries
     WHERE role = 'ambient'
       AND json_extract(metadata, '$.organId') = 'musing'
       AND timestamp > ?
     ORDER BY timestamp DESC
     LIMIT ?`,
  );
  const rows = stmt.all<FluxDurableEntryRow>(sinceISO, limit);
  stmt.finalize();
  return rows.reverse().map(rowToDurableEntry);
}

/** Whether any user-role entry exists newer than `sinceISO` (driver uses this). */
export function hasPendingUserMessage(
  db: Database,
  sinceISO: string,
): FluxDurableEntry | null {
  const stmt = db.prepare(
    `SELECT * FROM flux_durable_entries
     WHERE role = 'user' AND timestamp > ?
     ORDER BY timestamp ASC
     LIMIT 1`,
  );
  const row = stmt.get<FluxDurableEntryRow>(sinceISO);
  stmt.finalize();
  return row ? rowToDurableEntry(row) : null;
}

/** Timestamp (ms epoch) of the newest user entry in the Flux Space, or null. */
export function getLastUserEntryAt(db: Database): number | null {
  const stmt = db.prepare(
    `SELECT timestamp FROM flux_durable_entries
     WHERE role = 'user'
     ORDER BY timestamp DESC
     LIMIT 1`,
  );
  const row = stmt.get<{ timestamp: string }>();
  stmt.finalize();
  return row ? Date.parse(row.timestamp) : null;
}

// =============================================================================
// Promoted observations
// =============================================================================

/** Record a promoted observation (survived the promotion filter). */
export function insertPromotedObservation(
  db: Database,
  obs: FluxPromotedObservation,
): void {
  db.exec(
    `INSERT OR IGNORE INTO flux_promoted_observations
       (id, timestamp, original_observation_id, content, salience, promotion_reason, consolidated)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [
      obs.id,
      obs.timestamp,
      obs.originalObservationId,
      obs.content,
      obs.salience,
      obs.promotionReason,
    ],
  );
}

/**
 * Promoted observations for a time window — used by the consolidation
 * pass to build the daily memory.
 */
export function getPromotedObservationsBetween(
  db: Database,
  startISO: string,
  endISO: string,
): FluxPromotedObservation[] {
  const stmt = db.prepare(
    `SELECT * FROM flux_promoted_observations
     WHERE timestamp >= ? AND timestamp < ?
     ORDER BY timestamp ASC`,
  );
  const rows = stmt.all<FluxPromotedObservationRow>(startISO, endISO);
  stmt.finalize();
  return rows.map(rowToPromotedObservation);
}

/**
 * Durable entries for a time window — used by the consolidation pass
 * alongside promoted observations to build the daily memory.
 */
export function getDurableEntriesBetween(
  db: Database,
  startISO: string,
  endISO: string,
): FluxDurableEntry[] {
  const stmt = db.prepare(
    `SELECT * FROM flux_durable_entries
     WHERE timestamp >= ? AND timestamp < ?
     ORDER BY timestamp ASC`,
  );
  const rows = stmt.all<FluxDurableEntryRow>(startISO, endISO);
  stmt.finalize();
  return rows.map(rowToDurableEntry);
}

/** Mark promoted observations in a window as consolidated. */
export function markPromotedConsolidated(
  db: Database,
  startISO: string,
  endISO: string,
): void {
  db.exec(
    `UPDATE flux_promoted_observations
     SET consolidated = 1
     WHERE timestamp >= ? AND timestamp < ? AND consolidated = 0`,
    [startISO, endISO],
  );
}

// =============================================================================
// Row mappers
// =============================================================================

function rowToDurableEntry(row: FluxDurableEntryRow): FluxDurableEntry {
  let metadata: Record<string, unknown> | undefined;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = undefined;
    }
  }
  return {
    id: row.id,
    timestamp: row.timestamp,
    role: row.role as FluxEntryRole,
    content: row.content,
    sourceObservationId: row.source_observation_id ?? undefined,
    sourceConversationId: row.source_conversation_id ?? undefined,
    metadata,
  };
}

function rowToPromotedObservation(
  row: FluxPromotedObservationRow,
): FluxPromotedObservation {
  return {
    id: row.id,
    timestamp: row.timestamp,
    originalObservationId: row.original_observation_id,
    content: row.content,
    salience: row.salience,
    promotionReason: row.promotion_reason,
  };
}
