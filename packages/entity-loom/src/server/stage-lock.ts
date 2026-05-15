/**
 * Entity Loom — Stage Lock
 *
 * Ensures only one processing stage runs at a time.
 * Provides abort support via a shared AbortController.
 */

import type { StageName } from "../types.ts";

let runningStage: StageName | null = null;
let abortController: AbortController | null = null;

/** Snapshot of the last progress emitted by the running stage. */
let progressSnapshot:
  | { current: number; total: number; percent: number }
  | null = null;

/** Try to acquire the lock for a stage. Returns AbortSignal if successful, null if another stage is running. */
export function acquireStageLock(stage: StageName): AbortSignal | null {
  if (runningStage) {
    return null;
  }
  runningStage = stage;
  abortController = new AbortController();
  progressSnapshot = null;
  return abortController.signal;
}

/** Release the stage lock */
export function releaseStageLock(): void {
  runningStage = null;
  abortController = null;
  progressSnapshot = null;
}

/** Get the currently running stage */
export function getRunningStage(): StageName | null {
  return runningStage;
}

/** Update the progress snapshot for the running stage. */
export function setProgressSnapshot(
  snapshot: { current: number; total: number; percent: number },
): void {
  progressSnapshot = snapshot;
}

/** Get the current progress snapshot (null if no stage is running). */
export function getProgressSnapshot(): {
  current: number;
  total: number;
  percent: number;
} | null {
  return progressSnapshot;
}

/** Abort the currently running stage */
export function abortRunningStage(): void {
  if (abortController) {
    abortController.abort();
  }
}
