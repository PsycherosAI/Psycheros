/**
 * Durable in-process job scheduler. I instantiate one per daemon and give
 * it a SQLite database to own two tables on: `schedules` (definitions) and
 * `job_runs` (every fire, past or pending). Handlers are registered by
 * name; a 5-second ticker materializes due fires, reclaims expired leases,
 * and dispatches handlers.
 *
 * See [`docs/scheduler.md`](../../docs/scheduler.md) for the full surface
 * and operational characteristics.
 *
 * @module
 */

export { Scheduler } from "./scheduler.ts";
export type { SchedulerConfig } from "./scheduler.ts";
export { initSchedulerTables } from "./tables.ts";
export { nextFireAtFromCron, parseCron, validateCron } from "./cron.ts";
export type {
  CatchupPolicy,
  EnqueueOptions,
  Handler,
  HandlerContext,
  HandlerResult,
  HandlerStats,
  JobRunRow,
  JobStatus,
  ScheduleDef,
  SchedulerLogger,
  ScheduleRow,
} from "./types.ts";
