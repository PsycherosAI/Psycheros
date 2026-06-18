/**
 * Consolidation Runner
 *
 * My local, single-purpose ticker for memory consolidation. Owns one
 * SQLite table — `consolidation_runs` — and a 5-minute interval that
 * fires the weekly / monthly / yearly catch-up flows once per missed
 * boundary.
 *
 * I split this off from `@psycheros/scheduler` because my use of that
 * package was vestigial: three hardcoded cron schedules, all
 * `fire_once_then_align`, all `maxAttempts=1`, no ad-hoc enqueue, no
 * retries, no checkpoints. The full Scheduler's surface is overkill —
 * the same behavior fits in ~150 lines with structural double-fire
 * prevention via the composite PK on `(period, scheduled_for)`.
 *
 * @module
 */

import type { Database } from "@db/sqlite";
import type { FileStore } from "../storage/mod.ts";
import type { GraphStore } from "../graph/mod.ts";
import { findUnconsolidatedPeriods, runConsolidation } from "./consolidator.ts";

/** Consolidation cadences this runner fires. */
export type ConsolidationPeriod = "weekly" | "monthly" | "yearly";

const PERIODS: readonly ConsolidationPeriod[] = ["weekly", "monthly", "yearly"];

const DEFAULT_TICK_INTERVAL_MS = 5 * 60 * 1000;

// Run-history loss on first boot after upgrade is acceptable — the old
// `schedules` / `job_runs` tables were never user-facing in entity-core.
const SCHEMA_SQL = `
  DROP INDEX IF EXISTS idx_schedules_next_fire;
  DROP INDEX IF EXISTS idx_schedules_handler;
  DROP INDEX IF EXISTS idx_job_runs_status_next_attempt;
  DROP INDEX IF EXISTS idx_job_runs_lease;
  DROP INDEX IF EXISTS idx_job_runs_schedule;
  DROP INDEX IF EXISTS idx_job_runs_handler_completed;
  DROP INDEX IF EXISTS uq_job_runs_idempotency_success;
  DROP INDEX IF EXISTS uq_job_runs_schedule_scheduled;
  DROP TABLE IF EXISTS job_runs;
  DROP TABLE IF EXISTS schedules;

  CREATE TABLE IF NOT EXISTS consolidation_runs (
    period TEXT NOT NULL CHECK (period IN ('weekly', 'monthly', 'yearly')),
    scheduled_for TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
    started_at TEXT NOT NULL,
    completed_at TEXT,
    result TEXT,
    error TEXT,
    PRIMARY KEY (period, scheduled_for)
  );
`;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Compute the most recent fire boundary at or before `now` for a period:
 *   - weekly:  the most recent Sunday at 05:00 UTC
 *   - monthly: the most recent 1st-of-month at 05:00 UTC
 *   - yearly:  the most recent Jan 1 at 05:00 UTC
 *
 * Exported for tests; the runner uses this internally to derive the
 * `scheduled_for` key on every tick.
 */
export function mostRecentFireAt(
  period: ConsolidationPeriod,
  now: Date,
): Date {
  switch (period) {
    case "weekly": {
      const candidate = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        5,
        0,
        0,
        0,
      ));
      const dow = candidate.getUTCDay(); // 0 = Sunday
      if (dow === 0 && candidate.getTime() <= now.getTime()) return candidate;
      const daysBack = dow === 0 ? 7 : dow;
      candidate.setUTCDate(candidate.getUTCDate() - daysBack);
      return candidate;
    }
    case "monthly": {
      const candidate = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        1,
        5,
        0,
        0,
        0,
      ));
      if (candidate.getTime() <= now.getTime()) return candidate;
      return new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth() - 1,
        1,
        5,
        0,
        0,
        0,
      ));
    }
    case "yearly": {
      const candidate = new Date(
        Date.UTC(now.getUTCFullYear(), 0, 1, 5, 0, 0, 0),
      );
      if (candidate.getTime() <= now.getTime()) return candidate;
      return new Date(
        Date.UTC(now.getUTCFullYear() - 1, 0, 1, 5, 0, 0, 0),
      );
    }
  }
}

/** Configuration for {@link ConsolidationRunner}. */
export interface ConsolidationRunnerOptions {
  /** How often I tick, in milliseconds. Default 5 minutes. */
  tickIntervalMs?: number;
}

/**
 * My local memory-consolidation runner. One instance per entity-core
 * process. Lifecycle: construct → `start()` → … → `stop()`.
 */
export class ConsolidationRunner {
  private db: Database;
  private readonly store: FileStore;
  private readonly graphStore: GraphStore;
  private readonly tickIntervalMs: number;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickInProgress = false;
  private stopping = false;

  constructor(
    db: Database,
    store: FileStore,
    graphStore: GraphStore,
    options?: ConsolidationRunnerOptions,
  ) {
    this.db = db;
    this.store = store;
    this.graphStore = graphStore;
    this.tickIntervalMs = options?.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.db.exec(SCHEMA_SQL);
  }

  /**
   * Replace the database handle. Called after the entity_import flow
   * swaps `graph.db` on disk — my old handle points at a closed
   * connection and would fail every tick. The new handle gets the
   * schema applied (idempotent) before I resume.
   */
  replaceDatabase(db: Database): void {
    this.db = db;
    this.db.exec(SCHEMA_SQL);
  }

  /**
   * Start the periodic ticker. Idempotent. Fires one tick immediately
   * so a missed boundary catches up without waiting the full interval.
   */
  start(): void {
    if (this.tickTimer !== null) return;
    this.stopping = false;
    this.reclaimRunningOnBoot();
    this.tick();
    this.tickTimer = setInterval(() => this.tick(), this.tickIntervalMs);
  }

  /**
   * Stop the ticker. In-flight handlers finish naturally; I don't abort
   * them. With my 5-minute cadence and the composite-PK guard, an
   * orphaned in-flight run is harmless on next boot — the
   * reclaim-on-boot step rewrites it to `error` and the next boundary
   * fires normally.
   */
  stop(): void {
    this.stopping = true;
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /**
   * Rewrite any `running` rows from a previous boot to `error`. With
   * `maxAttempts=1` there's no retry, but resetting the status keeps
   * the table honest for debugging.
   */
  private reclaimRunningOnBoot(): void {
    this.db.exec(
      `UPDATE consolidation_runs
       SET status = 'error',
           completed_at = ?,
           error = COALESCE(error, 'Reclaimed after worker crash')
       WHERE status = 'running'`,
      [nowIso()],
    );
  }

  /**
   * One tick: for each period, try to claim the current fire boundary
   * and run catch-up if I won the race. The composite PK on
   * `(period, scheduled_for)` makes double-fire a constraint violation
   * — caught and treated as "already handled this boundary."
   *
   * Wrapped in try/catch (not just try/finally) so a synchronous DB
   * error doesn't escape as Uncaught and crash the daemon — same class
   * of bug fixed in scheduler commit fcdbd75.
   */
  private async tick(): Promise<void> {
    if (this.tickInProgress || this.stopping) return;
    this.tickInProgress = true;
    try {
      const now = new Date();
      for (const period of PERIODS) {
        if (this.stopping) break;
        const scheduledFor = mostRecentFireAt(period, now).toISOString();
        if (!this.claim(period, scheduledFor)) continue;
        await this.runFire(period, scheduledFor);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ConsolidationRunner] Tick failed: ${msg}`);
    } finally {
      this.tickInProgress = false;
    }
  }

  /**
   * Atomically claim a fire by inserting a `running` row. Returns
   * `true` if this tick won the race; `false` if a row already exists
   * for that boundary.
   */
  private claim(period: ConsolidationPeriod, scheduledFor: string): boolean {
    try {
      this.db.exec(
        `INSERT INTO consolidation_runs
           (period, scheduled_for, status, started_at)
         VALUES (?, ?, 'running', ?)`,
        [period, scheduledFor, nowIso()],
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE") || msg.includes("PRIMARY KEY")) return false;
      throw err;
    }
  }

  private async runFire(
    period: ConsolidationPeriod,
    scheduledFor: string,
  ): Promise<void> {
    try {
      const summary = await this.catchUp(period);
      this.db.exec(
        `UPDATE consolidation_runs
         SET status = 'success', completed_at = ?, result = ?
         WHERE period = ? AND scheduled_for = ?`,
        [nowIso(), summary, period, scheduledFor],
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.db.exec(
        `UPDATE consolidation_runs
         SET status = 'error', completed_at = ?, error = ?
         WHERE period = ? AND scheduled_for = ?`,
        [nowIso(), msg, period, scheduledFor],
      );
      console.error(`[ConsolidationRunner] ${period} run failed: ${msg}`);
    }
  }

  /**
   * Find every unconsolidated period for the given granularity and
   * process them in date order. Idempotent —
   * `findUnconsolidatedPeriods` filters out already-consolidated dates.
   * Throws if any single period fails so the run row is marked `error`.
   */
  private async catchUp(period: ConsolidationPeriod): Promise<string> {
    const periods = await findUnconsolidatedPeriods(this.store, period);
    if (periods.length === 0) {
      return `No unconsolidated ${period} periods`;
    }
    console.error(
      `[ConsolidationRunner] Catch-up: ${periods.length} unconsolidated ${period} period(s)`,
    );
    let consolidated = 0;
    const failures: string[] = [];
    for (const dateStr of periods) {
      const result = await runConsolidation(
        this.store,
        this.graphStore,
        period,
        dateStr,
      );
      if (result.success) {
        consolidated++;
      } else {
        failures.push(`${dateStr}: ${result.error ?? "unknown"}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Consolidated ${consolidated}, failed ${failures.length}: ${
          failures.join("; ")
        }`,
      );
    }
    return `Consolidated ${consolidated} ${period} period(s)`;
  }
}
