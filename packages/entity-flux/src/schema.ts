/**
 * Tier 2 schema — flux-owned tables in the shared `psycheros.db`.
 *
 * These tables live in the main Psycheros database (single DB, single
 * lock, single backup) but are flux-owned: flux defines them, flux
 * queries them via `DBClient.getRawDb()`. The host calls
 * `initializeFluxSchema` during startup when flux is enabled. The
 * function is idempotent (`CREATE TABLE IF NOT EXISTS`) so repeated
 * calls on restart are safe.
 *
 * Two tables:
 *   - flux_durable_entries — the Flux Space timeline. Durable entries
 *     (role "user" / "entity") are permanent, the relational record of
 *     what was said; ambient entries (role "ambient") are promoted
 *     observations and thoughtstream summaries that surfaced there.
 *   - flux_promoted_observations — promoted tier-1 observations, kept
 *     as a distinct record so the promotion decision is queryable
 *     independently of the timeline view.
 */

import type { Database } from "@db/sqlite";

/** The flux-shared-DB schema, applied idempotently. */
const FLUX_SHARED_SCHEMA = `
  CREATE TABLE IF NOT EXISTS flux_durable_entries (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'entity', 'ambient')),
    content TEXT NOT NULL,
    source_observation_id TEXT,
    source_conversation_id TEXT,
    metadata TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_flux_durable_timestamp
    ON flux_durable_entries(timestamp);

  CREATE INDEX IF NOT EXISTS idx_flux_durable_role
    ON flux_durable_entries(role, timestamp);

  CREATE TABLE IF NOT EXISTS flux_promoted_observations (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    original_observation_id TEXT NOT NULL,
    content TEXT NOT NULL,
    salience REAL NOT NULL,
    promotion_reason TEXT NOT NULL,
    consolidated INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_flux_promoted_timestamp
    ON flux_promoted_observations(timestamp);

  CREATE INDEX IF NOT EXISTS idx_flux_promoted_consolidated
    ON flux_promoted_observations(consolidated, timestamp);
`;

/**
 * Initialize flux tables in the shared Psycheros database. Idempotent —
 * safe to call on every startup. Called by the host when flux is enabled.
 */
export function initializeFluxSchema(db: Database): void {
  db.exec(FLUX_SHARED_SCHEMA);
  // ONE observation, ONE timeline row (the double-post repair). Two
  // writers can race the same observation onto the timeline — the
  // engagement wire posts at wake-verdict time while a promotion batch
  // that already passed its "already posted?" check inserts behind it
  // (check-then-insert across concurrent paths; the guard in
  // tier2-store consults only one side). The unique index below makes
  // the insertion itself the arbiter. First, sweep the race's
  // historical rows — the index cannot be created over duplicates.
  // The earliest row of each pair survives; the tint-flip path can
  // still promote it later if its own wake fires.
  db.exec(
    `DELETE FROM flux_durable_entries
     WHERE source_observation_id IS NOT NULL
       AND rowid NOT IN (
         SELECT MIN(rowid) FROM flux_durable_entries
         WHERE source_observation_id IS NOT NULL
         GROUP BY source_observation_id
       )`,
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_flux_durable_one_row_per_obs
     ON flux_durable_entries(source_observation_id)
     WHERE source_observation_id IS NOT NULL`,
  );
}
