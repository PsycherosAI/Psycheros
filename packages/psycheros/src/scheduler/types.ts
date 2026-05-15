/**
 * Scheduler Types
 *
 * Shared type definitions for my durable job scheduler. Every daemon that
 * needs background work owns its own scheduler instance with its own SQLite
 * tables — the library is shared, the state is not.
 *
 * @module
 */

/**
 * What the scheduler should do with fire times that elapsed while I was down.
 *
 * - `fire_once_then_align`: if any fires were missed, run once now then resume
 *   on the normal schedule. The right choice for daily summaries and snapshots
 *   — I want to catch up but I do not want a flood after a long downtime.
 * - `skip_missed`: silently drop missed fires and resume on the next scheduled
 *   time. The right choice for "every hour: remind me to stretch" — a flood
 *   of 50 reminders after a week of downtime would be hostile.
 * - `fire_all_missed`: enqueue one job per missed fire. The right choice when
 *   each fire processes a discrete unit of work and missing one means missing
 *   data — rare in this codebase.
 */
export type CatchupPolicy =
  | "fire_once_then_align"
  | "skip_missed"
  | "fire_all_missed";

/**
 * Lifecycle status of a single job run.
 */
export type JobStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "dead"
  | "skipped";

/**
 * Definition of a recurring or one-shot schedule.
 *
 * Exactly one timing source must be provided:
 * - `cronExpr` for standard cron-style schedules
 * - `intervalSeconds` for fixed-interval recurring schedules
 * - `randomMinSeconds` + `randomMaxSeconds` for jittered recurring schedules
 * - `runAt` for one-shot schedules
 */
export interface ScheduleDef {
  /** Stable identifier — same id on re-define updates in place. */
  id: string;
  /** Recurring schedules fire on a cadence; one-shot schedules fire once then disable. */
  kind: "recurring" | "oneshot";
  /** Registered handler name to invoke when this schedule fires. */
  handler: string;
  /** Opaque payload passed to the handler on each fire. */
  payload?: Record<string, unknown>;
  /** Standard 5-field cron expression (min hour dom month dow), UTC. */
  cronExpr?: string | null;
  /** Fixed interval in seconds between fires (alternative to cron). */
  intervalSeconds?: number | null;
  /** Lower bound (inclusive) of random interval between fires, in seconds. */
  randomMinSeconds?: number | null;
  /** Upper bound (inclusive) of random interval between fires, in seconds. */
  randomMaxSeconds?: number | null;
  /** ISO timestamp for one-shot schedules. */
  runAt?: string | null;
  /** What to do with fires I missed while down. */
  catchupPolicy?: CatchupPolicy;
  /** Maximum attempts per fire before marking the run `dead`. */
  maxAttempts?: number;
  /** Whether this schedule is active. Disabled schedules never materialize fires. */
  enabled?: boolean;
  /** Extra fields the consumer wants to carry alongside the definition. */
  metadata?: Record<string, unknown>;
}

/**
 * A persisted schedule row, hydrated from the schedules table.
 */
export interface ScheduleRow {
  id: string;
  kind: "recurring" | "oneshot";
  handler: string;
  payload: Record<string, unknown>;
  cronExpr: string | null;
  intervalSeconds: number | null;
  randomMinSeconds: number | null;
  randomMaxSeconds: number | null;
  runAt: string | null;
  catchupPolicy: CatchupPolicy;
  maxAttempts: number;
  enabled: boolean;
  nextFireAt: string | null;
  lastFireAt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * A persisted job run row, hydrated from the job_runs table.
 */
export interface JobRunRow {
  id: string;
  scheduleId: string | null;
  handler: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempt: number;
  maxAttempts: number;
  scheduledFor: string;
  claimedAt: string | null;
  leaseUntil: string | null;
  workerId: string | null;
  checkpoint: Record<string, unknown> | null;
  idempotencyKey: string | null;
  nextAttemptAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  resultSummary: string | null;
  errorMessage: string | null;
  createdAt: string;
}

/**
 * Options for enqueueing an ad-hoc job (no associated schedule).
 */
export interface EnqueueOptions {
  handler: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  maxAttempts?: number;
  /** Earliest time this job is eligible to run (default: now). */
  runAt?: string;
}

/**
 * Context passed to a handler when it executes.
 */
export interface HandlerContext {
  jobId: string;
  scheduleId: string | null;
  handler: string;
  payload: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  workerId: string;
  /** Checkpoint state from a previous attempt (null on first attempt). */
  checkpoint: Record<string, unknown> | null;
  /** Persist progress so the next attempt can resume from here. */
  setCheckpoint(checkpoint: Record<string, unknown>): void;
  /** Refresh this job's lease — call from long-running handlers periodically. */
  renewLease(): void;
}

/**
 * Return value from a handler. Throw to mark the run as `error`.
 */
export type HandlerResult =
  | { status: "success"; result?: string }
  | { status: "skipped"; result?: string };

/**
 * A registered handler function.
 */
export type Handler = (ctx: HandlerContext) => Promise<HandlerResult>;

/**
 * Logger callback for scheduler-internal events.
 */
export type SchedulerLogger = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
) => void;

/**
 * Aggregated stats for a handler — derived on demand from job_runs.
 */
export interface HandlerStats {
  successCount: number;
  errorCount: number;
  lastRunAt: string | null;
  lastCompletedAt: string | null;
  lastStatus: JobStatus | null;
  lastDurationMs: number | null;
  lastResult: string | null;
  lastError: string | null;
}
