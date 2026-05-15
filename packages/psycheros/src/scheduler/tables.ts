/**
 * Scheduler Schema
 *
 * Creates the `schedules` and `job_runs` tables in any SQLite database
 * I'm handed. Idempotent — safe to run on every startup.
 *
 * Two tables:
 * - `schedules`: definitions of recurring/oneshot work. The ticker reads
 *   `next_fire_at` to decide when to materialize a fire.
 * - `job_runs`: every fire that has ever been materialized — pending, in
 *   flight, completed, or dead. This is both the work queue and the
 *   execution history.
 *
 * @module
 */

import type { Database } from "@db/sqlite";

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('recurring', 'oneshot')),
    handler TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    cron_expr TEXT,
    interval_seconds INTEGER,
    random_min_seconds INTEGER,
    random_max_seconds INTEGER,
    run_at TEXT,
    catchup_policy TEXT NOT NULL DEFAULT 'fire_once_then_align'
      CHECK (catchup_policy IN ('fire_once_then_align', 'skip_missed', 'fire_all_missed')),
    max_attempts INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_fire_at TEXT,
    last_fire_at TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_schedules_next_fire
    ON schedules(next_fire_at) WHERE enabled = 1;

  CREATE INDEX IF NOT EXISTS idx_schedules_handler
    ON schedules(handler);

  CREATE TABLE IF NOT EXISTS job_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT REFERENCES schedules(id) ON DELETE SET NULL,
    handler TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'error', 'dead', 'skipped')),
    attempt INTEGER NOT NULL DEFAULT 1,
    max_attempts INTEGER NOT NULL DEFAULT 1,
    scheduled_for TEXT NOT NULL,
    claimed_at TEXT,
    lease_until TEXT,
    worker_id TEXT,
    checkpoint_json TEXT,
    idempotency_key TEXT,
    next_attempt_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    duration_ms INTEGER,
    result_summary TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_job_runs_status_next_attempt
    ON job_runs(status, next_attempt_at);

  CREATE INDEX IF NOT EXISTS idx_job_runs_lease
    ON job_runs(lease_until) WHERE status = 'running';

  CREATE INDEX IF NOT EXISTS idx_job_runs_schedule
    ON job_runs(schedule_id, scheduled_for DESC);

  CREATE INDEX IF NOT EXISTS idx_job_runs_handler_completed
    ON job_runs(handler, completed_at DESC);

  CREATE UNIQUE INDEX IF NOT EXISTS uq_job_runs_idempotency_success
    ON job_runs(idempotency_key)
    WHERE idempotency_key IS NOT NULL AND status = 'success';

  CREATE UNIQUE INDEX IF NOT EXISTS uq_job_runs_schedule_scheduled
    ON job_runs(schedule_id, scheduled_for)
    WHERE schedule_id IS NOT NULL;
`;

/**
 * Create the scheduler tables on the given database if they are missing.
 * Idempotent.
 */
export function initSchedulerTables(db: Database): void {
  db.exec(SCHEMA_SQL);
}
