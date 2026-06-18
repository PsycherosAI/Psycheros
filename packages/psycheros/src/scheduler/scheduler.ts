/**
 * Scheduler
 *
 * My durable, in-process job scheduler. Owns two SQLite tables —
 * `schedules` (definitions) and `job_runs` (every fire, past or pending) —
 * and a 5-second ticker that materializes due fires, reclaims expired
 * leases, and dispatches handlers.
 *
 * Designed for the single-process, single-tenant Psycheros / entity-core
 * daemons. Leases exist for crash recovery, not multi-worker arbitration —
 * if I die mid-execution, the next boot will reclaim my in-flight rows
 * after `lease_until` expires and retry up to `max_attempts`.
 *
 * Handlers are registered in-process. They receive a {@link HandlerContext}
 * with payload + checkpoint state. Return `{status: 'success', result}` or
 * `{status: 'skipped', result}`; throw to mark the run `error` and trigger
 * retry / dead-letter.
 *
 * @module
 */

import type { BindValue, Database } from "@db/sqlite";
import { nextFireAtFromCron } from "./cron.ts";
import type {
  CatchupPolicy,
  EnqueueOptions,
  Handler,
  HandlerContext,
  HandlerStats,
  JobRunRow,
  JobStatus,
  ScheduleDef,
  SchedulerLogger,
  ScheduleRow,
} from "./types.ts";

/**
 * Configuration for instantiating a {@link Scheduler}.
 */
export interface SchedulerConfig {
  /** SQLite database the scheduler owns its tables on. */
  db: Database;
  /** Unique identifier for this process (e.g. `<pid>-<bootTs>`). */
  workerId: string;
  /** How often the ticker runs, in milliseconds. Default 5000. */
  tickIntervalMs?: number;
  /** Lease window for in-flight jobs, in milliseconds. Default 60000. */
  leaseDurationMs?: number;
  /** Maximum concurrent in-flight jobs across all handlers. Default 4. */
  concurrency?: number;
  /** Default backoff for retries on error, in milliseconds. Default 60000. */
  retryBackoffMs?: number;
  /** Logger for scheduler-internal events. Defaults to console-with-prefix. */
  logger?: SchedulerLogger;
}

const DEFAULT_TICK_INTERVAL_MS = 5_000;
const DEFAULT_LEASE_DURATION_MS = 60_000;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RETRY_BACKOFF_MS = 60_000;

function defaultLogger(
  level: "debug" | "info" | "warn" | "error",
  message: string,
): void {
  const stream = level === "error" || level === "warn"
    ? console.error
    : console.log;
  stream(`[Scheduler] ${message}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function addMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function isoLte(a: string, b: string): boolean {
  return new Date(a).getTime() <= new Date(b).getTime();
}

function safeJsonParse(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function scheduleRowFromDb(row: Record<string, unknown>): ScheduleRow {
  return {
    id: row.id as string,
    kind: row.kind as "recurring" | "oneshot",
    handler: row.handler as string,
    payload: safeJsonParse((row.payload_json as string) ?? "{}"),
    cronExpr: (row.cron_expr as string) ?? null,
    intervalSeconds: (row.interval_seconds as number) ?? null,
    randomMinSeconds: (row.random_min_seconds as number) ?? null,
    randomMaxSeconds: (row.random_max_seconds as number) ?? null,
    runAt: (row.run_at as string) ?? null,
    catchupPolicy: row.catchup_policy as CatchupPolicy,
    maxAttempts: row.max_attempts as number,
    enabled: (row.enabled as number) === 1,
    nextFireAt: (row.next_fire_at as string) ?? null,
    lastFireAt: (row.last_fire_at as string) ?? null,
    metadata: safeJsonParse((row.metadata_json as string) ?? "{}"),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

function jobRunRowFromDb(row: Record<string, unknown>): JobRunRow {
  return {
    id: row.id as string,
    scheduleId: (row.schedule_id as string) ?? null,
    handler: row.handler as string,
    payload: safeJsonParse((row.payload_json as string) ?? "{}"),
    status: row.status as JobStatus,
    attempt: row.attempt as number,
    maxAttempts: row.max_attempts as number,
    scheduledFor: row.scheduled_for as string,
    claimedAt: (row.claimed_at as string) ?? null,
    leaseUntil: (row.lease_until as string) ?? null,
    workerId: (row.worker_id as string) ?? null,
    checkpoint: row.checkpoint_json
      ? safeJsonParse(row.checkpoint_json as string)
      : null,
    idempotencyKey: (row.idempotency_key as string) ?? null,
    nextAttemptAt: (row.next_attempt_at as string) ?? null,
    startedAt: (row.started_at as string) ?? null,
    completedAt: (row.completed_at as string) ?? null,
    durationMs: (row.duration_ms as number) ?? null,
    resultSummary: (row.result_summary as string) ?? null,
    errorMessage: (row.error_message as string) ?? null,
    createdAt: row.created_at as string,
  };
}

/**
 * Compute the next fire time for a schedule, given `after`.
 * Returns null when the schedule has no future fire (e.g. a one-shot
 * whose `runAt` has elapsed and already fired).
 */
function computeNextFireAt(
  schedule: {
    kind: "recurring" | "oneshot";
    cronExpr: string | null;
    intervalSeconds: number | null;
    randomMinSeconds: number | null;
    randomMaxSeconds: number | null;
    runAt: string | null;
  },
  after: Date,
): string | null {
  if (schedule.kind === "oneshot") {
    // The runAt is the fire time — past or future. The ticker
    // materializes it on the next tick if it's already past.
    return schedule.runAt ?? null;
  }

  if (schedule.cronExpr) {
    return nextFireAtFromCron(schedule.cronExpr, after);
  }

  if (schedule.intervalSeconds && schedule.intervalSeconds > 0) {
    return addMs(after.toISOString(), schedule.intervalSeconds * 1000);
  }

  if (
    schedule.randomMinSeconds && schedule.randomMaxSeconds &&
    schedule.randomMaxSeconds >= schedule.randomMinSeconds
  ) {
    const span = schedule.randomMaxSeconds - schedule.randomMinSeconds;
    const seconds = schedule.randomMinSeconds +
      Math.floor(Math.random() * (span + 1));
    return addMs(after.toISOString(), seconds * 1000);
  }

  throw new Error(
    `Recurring schedule has no timing source (cronExpr, intervalSeconds, or randomMinSeconds+randomMaxSeconds)`,
  );
}

/**
 * The durable scheduler. One instance per daemon.
 */
export class Scheduler {
  private db: Database;
  private readonly workerId: string;
  private readonly tickIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly concurrency: number;
  private readonly retryBackoffMs: number;
  private readonly log: SchedulerLogger;

  private readonly handlers = new Map<string, Handler>();
  private readonly inflight = new Map<string, AbortController>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickInProgress = false;
  private stopping = false;

  constructor(config: SchedulerConfig) {
    this.db = config.db;
    this.workerId = config.workerId;
    this.tickIntervalMs = config.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.leaseDurationMs = config.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
    this.retryBackoffMs = config.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.log = config.logger ?? defaultLogger;
  }

  /**
   * Replace the database connection. Used after an entity-core import
   * replaces graph.db on disk — the scheduler must operate on the new DB
   * or its stale handle will fail every tick.
   */
  replaceDatabase(db: Database): void {
    this.db = db;
  }

  // ===========================================================================
  // Registration
  // ===========================================================================

  /**
   * Register a handler function for a named handler key. Schedules and
   * enqueued jobs reference handlers by name; an unregistered handler
   * causes its job to be marked `error` with an explanatory message.
   */
  register(name: string, handler: Handler): void {
    this.handlers.set(name, handler);
  }

  // ===========================================================================
  // Schedule CRUD
  // ===========================================================================

  /**
   * Upsert a schedule definition. The schedule's `next_fire_at` is
   * computed from its timing source — unless the schedule already exists
   * with the same timing and an in-future `next_fire_at`, in which case
   * we preserve it so re-defines don't shift the firing rhythm.
   */
  defineSchedule(def: ScheduleDef): ScheduleRow {
    const existing = this.getSchedule(def.id);
    const now = nowIso();
    const payload = JSON.stringify(def.payload ?? {});
    const metadata = JSON.stringify(def.metadata ?? {});
    const catchup: CatchupPolicy = def.catchupPolicy ?? "fire_once_then_align";
    const maxAttempts = def.maxAttempts ?? 1;
    const enabled = def.enabled === false ? 0 : 1;

    // Preserve next_fire_at when the timing source hasn't changed —
    // otherwise re-defining a daily-3am schedule on every boot would
    // recompute it to "next 3am from now", which is the same answer
    // but avoidable churn. When timing changes (or this is a new
    // schedule), recompute.
    let nextFireAt: string | null;
    const timingChanged = !existing ||
      existing.kind !== def.kind ||
      existing.cronExpr !== (def.cronExpr ?? null) ||
      existing.intervalSeconds !== (def.intervalSeconds ?? null) ||
      existing.randomMinSeconds !== (def.randomMinSeconds ?? null) ||
      existing.randomMaxSeconds !== (def.randomMaxSeconds ?? null) ||
      existing.runAt !== (def.runAt ?? null);

    if (!timingChanged && existing && existing.nextFireAt) {
      nextFireAt = existing.nextFireAt;
    } else {
      nextFireAt = computeNextFireAt(
        {
          kind: def.kind,
          cronExpr: def.cronExpr ?? null,
          intervalSeconds: def.intervalSeconds ?? null,
          randomMinSeconds: def.randomMinSeconds ?? null,
          randomMaxSeconds: def.randomMaxSeconds ?? null,
          runAt: def.runAt ?? null,
        },
        new Date(),
      );
    }

    this.db.exec(
      `INSERT INTO schedules (
         id, kind, handler, payload_json, cron_expr, interval_seconds,
         random_min_seconds, random_max_seconds, run_at, catchup_policy,
         max_attempts, enabled, next_fire_at, last_fire_at, metadata_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         handler = excluded.handler,
         payload_json = excluded.payload_json,
         cron_expr = excluded.cron_expr,
         interval_seconds = excluded.interval_seconds,
         random_min_seconds = excluded.random_min_seconds,
         random_max_seconds = excluded.random_max_seconds,
         run_at = excluded.run_at,
         catchup_policy = excluded.catchup_policy,
         max_attempts = excluded.max_attempts,
         enabled = excluded.enabled,
         next_fire_at = excluded.next_fire_at,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
      [
        def.id,
        def.kind,
        def.handler,
        payload,
        def.cronExpr ?? null,
        def.intervalSeconds ?? null,
        def.randomMinSeconds ?? null,
        def.randomMaxSeconds ?? null,
        def.runAt ?? null,
        catchup,
        maxAttempts,
        enabled,
        nextFireAt,
        existing?.lastFireAt ?? null,
        metadata,
        existing?.createdAt ?? now,
        now,
      ],
    );

    return this.getSchedule(def.id)!;
  }

  /**
   * Delete a schedule. Pending job_runs referencing it have their
   * `schedule_id` set to NULL by the foreign key.
   */
  removeSchedule(id: string): boolean {
    const result = this.db.exec("DELETE FROM schedules WHERE id = ?", [id]);
    return result > 0;
  }

  /**
   * Fetch a schedule by id, or null if missing.
   */
  getSchedule(id: string): ScheduleRow | null {
    const stmt = this.db.prepare("SELECT * FROM schedules WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    stmt.finalize();
    return row ? scheduleRowFromDb(row) : null;
  }

  /**
   * List all schedules, ordered by id.
   */
  listSchedules(): ScheduleRow[] {
    const stmt = this.db.prepare(
      "SELECT * FROM schedules ORDER BY id ASC",
    );
    const rows = stmt.all() as Record<string, unknown>[];
    stmt.finalize();
    return rows.map(scheduleRowFromDb);
  }

  // ===========================================================================
  // Ad-hoc enqueue
  // ===========================================================================

  /**
   * Enqueue an ad-hoc job (not associated with a schedule). Returns the
   * created job_run row, or the existing successful run if the
   * idempotency key matches a completed job.
   */
  enqueue(opts: EnqueueOptions): JobRunRow {
    const handler = opts.handler;
    const payload = JSON.stringify(opts.payload ?? {});
    const idempotencyKey = opts.idempotencyKey ?? null;
    const maxAttempts = opts.maxAttempts ?? 1;
    const runAt = opts.runAt ?? nowIso();
    const now = nowIso();

    // Honor idempotency: if a successful run with this key exists, return it.
    if (idempotencyKey) {
      const stmt = this.db.prepare(
        `SELECT * FROM job_runs
         WHERE idempotency_key = ? AND status = 'success'
         ORDER BY completed_at DESC LIMIT 1`,
      );
      const existing = stmt.get(idempotencyKey) as
        | Record<string, unknown>
        | undefined;
      stmt.finalize();
      if (existing) return jobRunRowFromDb(existing);
    }

    const id = crypto.randomUUID();
    this.db.exec(
      `INSERT INTO job_runs (
         id, schedule_id, handler, payload_json, status, attempt,
         max_attempts, scheduled_for, idempotency_key, next_attempt_at,
         created_at
       ) VALUES (?, NULL, ?, ?, 'pending', 1, ?, ?, ?, ?, ?)`,
      [id, handler, payload, maxAttempts, runAt, idempotencyKey, runAt, now],
    );

    const row = this.getJobRun(id)!;
    return row;
  }

  // ===========================================================================
  // Job run inspection
  // ===========================================================================

  /**
   * Fetch a job run by id, or null if missing.
   */
  getJobRun(id: string): JobRunRow | null {
    const stmt = this.db.prepare("SELECT * FROM job_runs WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    stmt.finalize();
    return row ? jobRunRowFromDb(row) : null;
  }

  /**
   * List job runs with optional filtering and pagination.
   */
  listJobRuns(filter?: {
    handler?: string;
    scheduleId?: string;
    status?: JobStatus;
    payloadContains?: { key: string; value: string };
    limit?: number;
    offset?: number;
  }): { runs: JobRunRow[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter?.handler) {
      where.push("handler = ?");
      params.push(filter.handler);
    }
    if (filter?.scheduleId) {
      where.push("schedule_id = ?");
      params.push(filter.scheduleId);
    }
    if (filter?.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter?.payloadContains) {
      where.push("json_extract(payload_json, '$.' || ?) = ?");
      params.push(filter.payloadContains.key);
      params.push(filter.payloadContains.value);
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = filter?.limit ?? 50;
    const offset = filter?.offset ?? 0;

    const countStmt = this.db.prepare(
      `SELECT COUNT(*) as c FROM job_runs ${whereClause}`,
    );
    const total =
      (countStmt.get(...(params as BindValue[])) as { c: number })?.c ?? 0;
    countStmt.finalize();

    const stmt = this.db.prepare(
      `SELECT * FROM job_runs ${whereClause}
       ORDER BY COALESCE(started_at, scheduled_for) DESC, id DESC
       LIMIT ? OFFSET ?`,
    );
    const rows = stmt.all(
      ...(params as BindValue[]),
      limit,
      offset,
    ) as Record<string, unknown>[];
    stmt.finalize();

    return { runs: rows.map(jobRunRowFromDb), total };
  }

  /**
   * Aggregate stats for a handler (success/error counts, last run).
   * Used by the admin UI to show "OK/Err" columns.
   */
  getHandlerStats(handler: string, filter?: {
    payloadContains?: { key: string; value: string };
  }): HandlerStats {
    const extraWhere: string[] = [];
    const extraParams: unknown[] = [];
    if (filter?.payloadContains) {
      extraWhere.push("json_extract(payload_json, '$.' || ?) = ?");
      extraParams.push(filter.payloadContains.key);
      extraParams.push(filter.payloadContains.value);
    }
    const extra = extraWhere.length ? ` AND ${extraWhere.join(" AND ")}` : "";

    const aggStmt = this.db.prepare(
      `SELECT
         SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS s,
         SUM(CASE WHEN status IN ('error', 'dead') THEN 1 ELSE 0 END) AS e
       FROM job_runs WHERE handler = ?${extra}`,
    );
    const agg = aggStmt.get(handler, ...(extraParams as BindValue[])) as
      | { s: number | null; e: number | null }
      | undefined;
    aggStmt.finalize();

    const latestStmt = this.db.prepare(
      `SELECT started_at, completed_at, status, duration_ms,
              result_summary, error_message
       FROM job_runs
       WHERE handler = ? AND completed_at IS NOT NULL${extra}
       ORDER BY completed_at DESC LIMIT 1`,
    );
    const latest = latestStmt.get(
      handler,
      ...(extraParams as BindValue[]),
    ) as Record<string, unknown> | undefined;
    latestStmt.finalize();

    return {
      successCount: agg?.s ?? 0,
      errorCount: agg?.e ?? 0,
      lastRunAt: (latest?.started_at as string) ?? null,
      lastCompletedAt: (latest?.completed_at as string) ?? null,
      lastStatus: (latest?.status as JobStatus) ?? null,
      lastDurationMs: (latest?.duration_ms as number) ?? null,
      lastResult: (latest?.result_summary as string) ?? null,
      lastError: (latest?.error_message as string) ?? null,
    };
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Reclaim any rows left in `running` state from a previous process boot.
   * Called once on start before the ticker begins.
   *
   * Single-process invariant: when this process starts, any row left in
   * `running` state belongs to a dead worker — by definition, since I am
   * the only worker for this database. So I reclaim every `running` row
   * regardless of `lease_until` (the lease exists for the mid-tick
   * `reclaimExpiredLeases` path, where the running worker is *me*).
   */
  reclaimOnBoot(): number {
    const now = nowIso();
    const stmt = this.db.prepare(
      `SELECT id, attempt, max_attempts FROM job_runs
       WHERE status = 'running'`,
    );
    const stuck = stmt.all() as Array<
      { id: string; attempt: number; max_attempts: number }
    >;
    stmt.finalize();

    let reclaimed = 0;
    for (const row of stuck) {
      if (row.attempt >= row.max_attempts) {
        this.db.exec(
          `UPDATE job_runs
           SET status = 'dead', completed_at = ?, lease_until = NULL, worker_id = NULL,
               error_message = 'Reclaimed after worker crash; max attempts exhausted'
           WHERE id = ?`,
          [now, row.id],
        );
      } else {
        this.db.exec(
          `UPDATE job_runs
           SET status = 'pending', attempt = attempt + 1,
               claimed_at = NULL, lease_until = NULL, worker_id = NULL,
               next_attempt_at = ?
           WHERE id = ?`,
          [addMs(now, this.retryBackoffMs), row.id],
        );
      }
      reclaimed++;
    }

    if (reclaimed > 0) {
      this.log(
        "info",
        `Reclaimed ${reclaimed} in-flight job(s) from previous boot`,
      );
    }

    // Pending rows with `next_attempt_at` in the future are waiting on
    // backoff from a failure in the previous process. On a fresh boot
    // the user expects pending work to flush now — and the backoff
    // exists to space out retries in steady state, not to delay a
    // restart. Reset them to eligible-now.
    const expedited = this.db.exec(
      "UPDATE job_runs SET next_attempt_at = NULL WHERE status = 'pending' AND next_attempt_at > ?",
      [now],
    );
    if (expedited > 0) {
      this.log(
        "info",
        `Expedited ${expedited} pending retry job(s) deferred from previous boot`,
      );
    }

    return reclaimed;
  }

  /**
   * Start the ticker. Idempotent.
   */
  start(): void {
    if (this.tickTimer !== null) return;
    this.stopping = false;
    this.reclaimOnBoot();
    // Tick once immediately so missed fires from downtime catch up without
    // waiting for the first interval.
    this.tick().catch((err) =>
      this.log(
        "error",
        `Initial tick failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    );
    this.tickTimer = setInterval(() => {
      this.tick().catch((err) =>
        this.log(
          "error",
          `Tick failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      );
    }, this.tickIntervalMs);
    this.log(
      "info",
      `Started (worker=${this.workerId}, tick=${this.tickIntervalMs}ms, concurrency=${this.concurrency})`,
    );
  }

  /**
   * Stop the ticker and wait for in-flight handlers to finish. Aborts via
   * each handler's AbortController so cooperative handlers can shut down
   * quickly.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    for (const ctrl of this.inflight.values()) ctrl.abort();
    // Wait briefly for handlers to exit. We don't block indefinitely —
    // a stuck handler will be reclaimed on next boot.
    const deadline = Date.now() + 2000;
    while (this.inflight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.log("info", "Stopped");
  }

  // ===========================================================================
  // Tick
  // ===========================================================================

  /**
   * One tick of the scheduler:
   *   1. reclaim leases whose `lease_until` has passed
   *   2. materialize due fires from schedules into `job_runs`
   *   3. claim up to `concurrency` pending jobs and dispatch them
   */
  tick(): Promise<void> {
    if (this.tickInProgress || this.stopping) return Promise.resolve();
    this.tickInProgress = true;
    try {
      // Renew leases for every job still in flight in this process. The
      // single-process invariant means `inflight` is the source of truth:
      // anything not in it is genuinely orphaned and safe to reclaim.
      // This auto-renew lets handlers run arbitrarily long (LLM streams,
      // multi-step summarization) without authors having to remember
      // `ctx.renewLease()`.
      this.renewInflightLeases();
      this.reclaimExpiredLeases();
      this.materializeDueFires();
      const claimed = this.claimPending();
      for (const job of claimed) {
        // Fire-and-forget — the dispatch tracks itself in `inflight`.
        this.dispatch(job);
      }
    } catch (err) {
      this.log(
        "error",
        `Tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.tickInProgress = false;
    }
    return Promise.resolve();
  }

  private renewInflightLeases(): void {
    if (this.inflight.size === 0) return;
    const newLease = addMs(nowIso(), this.leaseDurationMs);
    const ids = Array.from(this.inflight.keys());
    // Build a parameterized IN clause so we update them in one round-trip.
    const placeholders = ids.map(() => "?").join(",");
    this.db.exec(
      `UPDATE job_runs SET lease_until = ?
       WHERE status = 'running' AND id IN (${placeholders})`,
      [newLease, ...ids],
    );
  }

  /**
   * Hint that there may be work to do — schedule a tick on the next event
   * loop turn rather than waiting for the regular interval. Safe to call
   * after `enqueue()` when low-latency dispatch matters (manual triggers,
   * webhooks). Idempotent; if a tick is already in flight, this becomes a
   * no-op on the next turn.
   */
  nudge(): void {
    if (this.stopping) return;
    queueMicrotask(() => {
      this.tick().catch((err) =>
        this.log(
          "error",
          `Nudged tick failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      );
    });
  }

  private reclaimExpiredLeases(): number {
    const now = nowIso();
    const stmt = this.db.prepare(
      `SELECT id, attempt, max_attempts FROM job_runs
       WHERE status = 'running' AND lease_until < ?`,
    );
    const stuck = stmt.all(now) as Array<
      { id: string; attempt: number; max_attempts: number }
    >;
    stmt.finalize();

    let reclaimed = 0;
    for (const row of stuck) {
      // The worker holding this row may still be running; we don't know.
      // We override anyway — single-process invariant means the only way
      // to reach this branch is if `tick` was called before stop and a
      // long handler ran past its lease without renewing. We re-arm.
      if (row.attempt >= row.max_attempts) {
        this.db.exec(
          `UPDATE job_runs
           SET status = 'dead', completed_at = ?, lease_until = NULL, worker_id = NULL,
               error_message = COALESCE(error_message, 'Lease expired before completion')
           WHERE id = ? AND status = 'running'`,
          [now, row.id],
        );
      } else {
        this.db.exec(
          `UPDATE job_runs
           SET status = 'pending', attempt = attempt + 1,
               claimed_at = NULL, lease_until = NULL, worker_id = NULL,
               next_attempt_at = ?,
               error_message = COALESCE(error_message, 'Lease expired before completion')
           WHERE id = ? AND status = 'running'`,
          [addMs(now, this.retryBackoffMs), row.id],
        );
      }
      reclaimed++;
    }
    return reclaimed;
  }

  private materializeDueFires(): number {
    const now = nowIso();
    const stmt = this.db.prepare(
      `SELECT * FROM schedules
       WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ?`,
    );
    const due = stmt.all(now) as Record<string, unknown>[];
    stmt.finalize();

    let materialized = 0;
    for (const dbRow of due) {
      const schedule = scheduleRowFromDb(dbRow);
      materialized += this.materializeFire(schedule, now);
    }
    return materialized;
  }

  private materializeFire(schedule: ScheduleRow, now: string): number {
    // Determine which scheduled_for value(s) to materialize based on
    // catchup_policy and how far behind we are.
    const fireTimes = this.computeCatchupFires(schedule, now);
    if (fireTimes.length === 0) {
      // Nothing to fire now — advance next_fire_at past `now`.
      const next = this.advanceNextFire(schedule, new Date(now));
      this.db.exec(
        "UPDATE schedules SET next_fire_at = ?, updated_at = ? WHERE id = ?",
        [next, now, schedule.id],
      );
      return 0;
    }

    let materialized = 0;
    for (const fireTime of fireTimes) {
      // The unique partial index on (schedule_id, scheduled_for) makes
      // double-materialization a constraint violation — caught below.
      const id = crypto.randomUUID();
      try {
        this.db.exec(
          `INSERT INTO job_runs (
             id, schedule_id, handler, payload_json, status, attempt,
             max_attempts, scheduled_for, next_attempt_at, created_at
           ) VALUES (?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?)`,
          [
            id,
            schedule.id,
            schedule.handler,
            JSON.stringify(schedule.payload),
            schedule.maxAttempts,
            fireTime,
            fireTime,
            now,
          ],
        );
        materialized++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE")) continue;
        throw err;
      }
    }

    // Advance the schedule pointer past the last fire we materialized.
    const lastFired = fireTimes[fireTimes.length - 1];
    const next = this.advanceNextFire(
      schedule,
      new Date(new Date(lastFired).getTime() + 1),
    );

    if (schedule.kind === "oneshot") {
      // One-shot schedules disable themselves after firing.
      this.db.exec(
        `UPDATE schedules
         SET enabled = 0, last_fire_at = ?, next_fire_at = NULL, updated_at = ?
         WHERE id = ?`,
        [lastFired, now, schedule.id],
      );
    } else {
      this.db.exec(
        `UPDATE schedules
         SET last_fire_at = ?, next_fire_at = ?, updated_at = ?
         WHERE id = ?`,
        [lastFired, next, now, schedule.id],
      );
    }
    return materialized;
  }

  private computeCatchupFires(
    schedule: ScheduleRow,
    now: string,
  ): string[] {
    const policy = schedule.catchupPolicy;
    const nextFire = schedule.nextFireAt;
    if (!nextFire || !isoLte(nextFire, now)) return [];

    if (schedule.kind === "oneshot") {
      // One-shot schedules always fire once, regardless of policy.
      return [nextFire];
    }

    if (policy === "fire_once_then_align" || policy === "skip_missed") {
      // Fire once at the most recent due time. The advance step will
      // realign next_fire_at to the next slot strictly after `now`.
      return [nextFire];
    }

    // fire_all_missed — enumerate every fire from next_fire_at up to now.
    const fires: string[] = [];
    let cursor = nextFire;
    while (isoLte(cursor, now) && fires.length < 1000) {
      fires.push(cursor);
      const advanced = this.advanceNextFireFrom(schedule, new Date(cursor));
      if (!advanced || advanced === cursor) break;
      cursor = advanced;
    }
    return fires;
  }

  /** Advance next_fire_at past `after`. */
  private advanceNextFire(schedule: ScheduleRow, after: Date): string | null {
    return computeNextFireAt(schedule, after);
  }

  /** One-step advance — used by fire_all_missed enumeration. */
  private advanceNextFireFrom(
    schedule: ScheduleRow,
    after: Date,
  ): string | null {
    return computeNextFireAt(schedule, after);
  }

  private claimPending(): JobRunRow[] {
    const now = nowIso();
    const available = Math.max(0, this.concurrency - this.inflight.size);
    if (available === 0) return [];

    const stmt = this.db.prepare(
      `SELECT * FROM job_runs
       WHERE status = 'pending'
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY scheduled_for ASC, id ASC
       LIMIT ?`,
    );
    const rows = stmt.all(now, available) as Record<string, unknown>[];
    stmt.finalize();

    const claimed: JobRunRow[] = [];
    for (const dbRow of rows) {
      const job = jobRunRowFromDb(dbRow);
      const leaseUntil = addMs(now, this.leaseDurationMs);
      const result = this.db.exec(
        `UPDATE job_runs
         SET status = 'running', claimed_at = ?, lease_until = ?,
             worker_id = ?, started_at = COALESCE(started_at, ?)
         WHERE id = ? AND status = 'pending'`,
        [now, leaseUntil, this.workerId, now, job.id],
      );
      if (result > 0) {
        claimed.push({
          ...job,
          status: "running",
          claimedAt: now,
          leaseUntil,
          workerId: this.workerId,
          startedAt: job.startedAt ?? now,
        });
      }
    }
    return claimed;
  }

  // ===========================================================================
  // Dispatch
  // ===========================================================================

  private dispatch(job: JobRunRow): void {
    const handler = this.handlers.get(job.handler);
    if (!handler) {
      this.failJob(job, `No handler registered for "${job.handler}"`);
      return;
    }

    const controller = new AbortController();
    this.inflight.set(job.id, controller);

    const ctx: HandlerContext = {
      jobId: job.id,
      scheduleId: job.scheduleId,
      handler: job.handler,
      payload: job.payload,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      workerId: this.workerId,
      checkpoint: job.checkpoint,
      setCheckpoint: (checkpoint) => {
        this.db.exec(
          "UPDATE job_runs SET checkpoint_json = ? WHERE id = ?",
          [JSON.stringify(checkpoint), job.id],
        );
      },
      renewLease: () => {
        const newLease = addMs(nowIso(), this.leaseDurationMs);
        this.db.exec(
          "UPDATE job_runs SET lease_until = ? WHERE id = ?",
          [newLease, job.id],
        );
      },
    };

    (async () => {
      try {
        const result = await handler(ctx);
        this.completeJob(job.id, {
          status: result.status,
          resultSummary: result.result ?? null,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.failJob(job, msg);
      } finally {
        this.inflight.delete(job.id);
      }
    })();
  }

  private completeJob(jobId: string, opts: {
    status: "success" | "skipped";
    resultSummary?: string | null;
  }): void {
    const now = nowIso();
    this.db.exec(
      `UPDATE job_runs
       SET status = ?, completed_at = ?,
           duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER),
           result_summary = ?, lease_until = NULL
       WHERE id = ?`,
      [opts.status, now, now, opts.resultSummary ?? null, jobId],
    );
    this.pruneCompletedRuns(jobId);
  }

  private failJob(job: JobRunRow, errorMessage: string): void {
    const now = nowIso();
    if (job.attempt >= job.maxAttempts) {
      this.db.exec(
        `UPDATE job_runs
         SET status = 'dead', completed_at = ?,
             duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER),
             error_message = ?, lease_until = NULL
         WHERE id = ?`,
        [now, now, errorMessage, job.id],
      );
      this.pruneCompletedRuns(job.id);
    } else {
      // Re-queue for another attempt.
      this.db.exec(
        `UPDATE job_runs
         SET status = 'pending', attempt = attempt + 1,
             claimed_at = NULL, lease_until = NULL, worker_id = NULL,
             next_attempt_at = ?,
             error_message = ?
         WHERE id = ?`,
        [addMs(now, this.retryBackoffMs), errorMessage, job.id],
      );
    }
  }

  // ===========================================================================
  // Retention
  // ===========================================================================
  //
  // Without pruning, recurring schedules (especially inactivity pulses that
  // fire every minute and usually return `skipped`) would grow the job_runs
  // table without bound. After every terminal completion I trim the cohort
  // this row belongs to — same handler, same logical group — back to its
  // retention limits.
  //
  // The cohort key is `(handler, schedule_id)` when the row was materialized
  // from a schedule, falling back to `(handler, payload.pulseId)` for
  // pulse.execute rows enqueued ad-hoc (manual / webhook / filesystem),
  // falling back to just `(handler)` for everything else.

  /** Skipped runs older than this are pruned. */
  private readonly skippedRetentionMs = 24 * 60 * 60 * 1000;
  /** Always keep at least this many of every cohort's terminal runs. */
  private readonly minRunsRetained = 200;

  private pruneCompletedRuns(jobId: string): void {
    const stmt = this.db.prepare(
      `SELECT handler, schedule_id, payload_json
       FROM job_runs WHERE id = ?`,
    );
    const row = stmt.get(jobId) as
      | {
        handler: string;
        schedule_id: string | null;
        payload_json: string;
      }
      | undefined;
    stmt.finalize();
    if (!row) return;

    let cohortWhere: string;
    let cohortParams: BindValue[];
    if (row.schedule_id) {
      cohortWhere = "handler = ? AND schedule_id = ?";
      cohortParams = [row.handler, row.schedule_id];
    } else if (row.handler === "pulse.execute") {
      // Ad-hoc pulse runs (manual / webhook / filesystem) carry the
      // pulseId in payload.
      let pulseId: string | undefined;
      try {
        pulseId =
          (JSON.parse(row.payload_json) as { pulseId?: string }).pulseId;
      } catch {
        pulseId = undefined;
      }
      if (!pulseId) return;
      cohortWhere =
        "handler = ? AND schedule_id IS NULL AND json_extract(payload_json, '$.pulseId') = ?";
      cohortParams = [row.handler, pulseId];
    } else {
      cohortWhere = "handler = ? AND schedule_id IS NULL";
      cohortParams = [row.handler];
    }

    // Prune skipped runs older than the retention window, but always
    // keep at least the most-recent few so a run-log query never shows
    // an empty page right after a quiet period.
    const skipCutoff = new Date(
      Date.now() - this.skippedRetentionMs,
    ).toISOString();
    this.db.exec(
      `DELETE FROM job_runs
       WHERE ${cohortWhere}
         AND status = 'skipped'
         AND COALESCE(completed_at, created_at) < ?
         AND id NOT IN (
           SELECT id FROM job_runs
           WHERE ${cohortWhere} AND status = 'skipped'
           ORDER BY COALESCE(completed_at, created_at) DESC
           LIMIT 50
         )`,
      [...cohortParams, skipCutoff, ...cohortParams],
    );

    // Prune all terminal runs beyond `minRunsRetained` per cohort.
    this.db.exec(
      `DELETE FROM job_runs
       WHERE ${cohortWhere}
         AND status IN ('success', 'error', 'dead', 'skipped')
         AND id NOT IN (
           SELECT id FROM job_runs
           WHERE ${cohortWhere}
             AND status IN ('success', 'error', 'dead', 'skipped')
           ORDER BY COALESCE(completed_at, created_at) DESC
           LIMIT ?
         )`,
      [...cohortParams, ...cohortParams, this.minRunsRetained],
    );
  }
}
