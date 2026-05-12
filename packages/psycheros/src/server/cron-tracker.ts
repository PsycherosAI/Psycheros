/**
 * Cron Job Tracker
 *
 * Tracks scheduled job execution with database persistence.
 * Execution history survives server restarts. Runtime status
 * (running/idle) is in-memory only.
 *
 * @module
 */

import type { DBClient } from "../db/mod.ts";

/**
 * Status of a scheduled job's last execution.
 */
export type JobStatus = "idle" | "running" | "success" | "error";

/**
 * A registered scheduled job with its execution history.
 */
export interface ScheduledJob {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Cron pattern or interval description */
  schedule: string;
  /** What this job does */
  description: string;
  /** Current status */
  status: JobStatus;
  /** When the job last started */
  lastRunAt: string | null;
  /** When the job last completed */
  lastCompletedAt: string | null;
  /** Duration of last run in milliseconds */
  lastDurationMs: number | null;
  /** Result message from last run */
  lastResult: string | null;
  /** Error message from last failed run */
  lastError: string | null;
  /** Total number of successful runs (persisted across restarts) */
  successCount: number;
  /** Total number of failed runs (persisted across restarts) */
  errorCount: number;
  /** Whether this job can be manually triggered */
  manualTrigger: boolean;
}

/**
 * Callback for manually triggering a job.
 */
type TriggerCallback = () => Promise<string>;

// Runtime state
const jobs = new Map<string, ScheduledJob>();
const triggers = new Map<string, TriggerCallback>();
let dbClient: DBClient | null = null;

/**
 * Initialize the tracker with a database client.
 * Must be called before registering jobs so history can be hydrated.
 */
export function initTracker(db: DBClient): void {
  dbClient = db;
}

/**
 * Register a scheduled job for tracking.
 * Hydrates last run state from the database if available.
 */
export function registerJob(
  id: string,
  name: string,
  schedule: string,
  description: string,
  manualTrigger = false,
): void {
  const job: ScheduledJob = {
    id,
    name,
    schedule,
    description,
    status: "idle",
    lastRunAt: null,
    lastCompletedAt: null,
    lastDurationMs: null,
    lastResult: null,
    lastError: null,
    successCount: 0,
    errorCount: 0,
    manualTrigger,
  };

  jobs.set(id, job);

  // Hydrate from DB if available
  if (dbClient) {
    hydrateJob(job);
  }
}

// Cache for getLatestJobRuns — populated once, used by all registerJob calls
let cachedLatestRuns: ReturnType<DBClient["getLatestJobRuns"]> | null = null;

function hydrateJob(job: ScheduledJob): void {
  if (!dbClient) return;
  if (!cachedLatestRuns) {
    cachedLatestRuns = dbClient.getLatestJobRuns();
  }
  const lastRun = cachedLatestRuns.find((r) => r.jobId === job.id);
  if (lastRun) {
    job.lastRunAt = lastRun.startedAt;
    job.lastCompletedAt = lastRun.completedAt;
    job.lastDurationMs = lastRun.durationMs;
    job.lastResult = lastRun.result;
    job.lastError = lastRun.error;
    job.status = lastRun.status;
    job.successCount = lastRun.successCount;
    job.errorCount = lastRun.errorCount;
  }
}

/**
 * Register a manual trigger callback for a job.
 */
export function registerTrigger(id: string, callback: TriggerCallback): void {
  triggers.set(id, callback);
}

/**
 * Mark a job as started.
 */
export function markJobStarted(id: string): void {
  const job = jobs.get(id);
  if (job) {
    job.status = "running";
    job.lastRunAt = new Date().toISOString();
  }
}

/**
 * Mark a job as successfully completed. Persists to database.
 */
export function markJobSuccess(id: string, result: string): void {
  const job = jobs.get(id);
  if (job) {
    const startTime = job.lastRunAt
      ? new Date(job.lastRunAt).getTime()
      : Date.now();
    job.status = "success";
    job.lastCompletedAt = new Date().toISOString();
    job.lastDurationMs = Date.now() - startTime;
    job.lastResult = result;
    job.lastError = null;
    job.successCount++;

    // Persist to database
    if (dbClient) {
      try {
        dbClient.addJobRun(
          id,
          job.lastRunAt!,
          job.lastCompletedAt,
          job.lastDurationMs,
          "success",
          result,
          null,
        );
      } catch (error) {
        console.error(
          "[CronTracker] Failed to persist job run:",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
}

/**
 * Mark a job as failed. Persists to database.
 */
export function markJobError(id: string, error: string): void {
  const job = jobs.get(id);
  if (job) {
    const startTime = job.lastRunAt
      ? new Date(job.lastRunAt).getTime()
      : Date.now();
    job.status = "error";
    job.lastCompletedAt = new Date().toISOString();
    job.lastDurationMs = Date.now() - startTime;
    job.lastResult = null;
    job.lastError = error;
    job.errorCount++;

    // Persist to database
    if (dbClient) {
      try {
        dbClient.addJobRun(
          id,
          job.lastRunAt!,
          job.lastCompletedAt,
          job.lastDurationMs,
          "error",
          null,
          error,
        );
      } catch (err) {
        console.error(
          "[CronTracker] Failed to persist job run:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }
}

/**
 * Get all registered jobs.
 */
export function getAllJobs(): ScheduledJob[] {
  return Array.from(jobs.values());
}

/**
 * Get a specific job by ID.
 */
export function getJob(id: string): ScheduledJob | undefined {
  return jobs.get(id);
}

/**
 * Manually trigger a job.
 * @returns Result message or error
 */
export async function triggerJob(
  id: string,
): Promise<{ success: boolean; message: string }> {
  const job = jobs.get(id);
  if (!job) {
    return { success: false, message: `Job not found: ${id}` };
  }

  if (!job.manualTrigger) {
    return {
      success: false,
      message: `Job ${id} does not support manual triggering`,
    };
  }

  const trigger = triggers.get(id);
  if (!trigger) {
    return { success: false, message: `No trigger registered for job: ${id}` };
  }

  if (job.status === "running") {
    return { success: false, message: `Job ${id} is already running` };
  }

  try {
    markJobStarted(id);
    const result = await trigger();
    markJobSuccess(id, result);
    return { success: true, message: result };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    markJobError(id, errorMsg);
    return { success: false, message: errorMsg };
  }
}

/**
 * Wrap a cron job handler with automatic tracking.
 * Returns a new handler that records start, success, and error.
 */
export function tracked(
  id: string,
  handler: () => Promise<string>,
): () => Promise<void> {
  return async () => {
    markJobStarted(id);
    try {
      const result = await handler();
      markJobSuccess(id, result);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      markJobError(id, errorMsg);
    }
  };
}
