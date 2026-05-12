/**
 * Entity Loom — Stage Lock
 *
 * Ensures only one processing stage runs at a time.
 * Provides abort support via a shared AbortController.
 */

import type { StageName } from "../types.ts";

let runningStage: StageName | null = null;
let abortController: AbortController | null = null;

/** Try to acquire the lock for a stage. Returns AbortSignal if successful, null if another stage is running. */
export function acquireStageLock(stage: StageName): AbortSignal | null {
  if (runningStage) {
    return null;
  }
  runningStage = stage;
  abortController = new AbortController();
  return abortController.signal;
}

/** Release the stage lock */
export function releaseStageLock(): void {
  runningStage = null;
  abortController = null;
}

/** Get the currently running stage */
export function getRunningStage(): StageName | null {
  return runningStage;
}

/** Abort the currently running stage */
export function abortRunningStage(): void {
  if (abortController) {
    abortController.abort();
  }
}
