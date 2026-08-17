/**
 * Embedding Rebuild Notifications
 *
 * When I re-embed my memories, the work saturates the CPU and can starve my
 * stdio transport — my Psycheros parent used to mistake that for death and
 * kill me mid-rebuild, over and over. So while a rebuild runs I report
 * progress over MCP notifications: my parent pauses its health-ping watchdog
 * on `started`, refreshes the pause on every `progress`, and resumes on
 * `done`/`failed`. The same events drive the re-index banner the user sees.
 */

export type RebuildPhase =
  | "started"
  | "progress"
  | "done"
  | "failed"
  | "model_change_detected";

export interface RebuildNotification {
  phase: RebuildPhase;
  /** memory = memory cache only; all = memories + graph nodes. */
  scope?: "memory" | "all";
  /** Items completed so far (progress/done). */
  done?: number;
  /** Items planned (started/progress/done). */
  total?: number;
  /** Human-readable detail, for logs and the user-facing banner. */
  message?: string;
}

export const EMBEDDING_REBUILD_METHOD = "notifications/embedding-rebuild";

let notifier: ((n: RebuildNotification) => void) | null = null;

/**
 * Install the transport callback notifications flow through. Wired by the
 * server after `connect()` — before that, notifications are dropped silently
 * (a rebuild must never fail because nobody is listening yet).
 */
export function setRebuildNotifier(
  fn: ((n: RebuildNotification) => void) | null,
): void {
  notifier = fn;
}

export function notifyRebuild(n: RebuildNotification): void {
  if (!notifier) return;
  try {
    notifier(n);
  } catch (error) {
    console.error("[Embeddings] notification failed:", error);
  }
}

// ---- Rebuild mutex ----

let rebuildOwner: string | null = null;

/**
 * Claim the rebuild. Returns false when another rebuild is already running —
 * callers should back off gently rather than throw (the boot path and a
 * tool-invoked `embedding_rebuild_all` must never interleave on the vec
 * tables).
 */
export function tryAcquireRebuild(owner: string): boolean {
  if (rebuildOwner !== null) return false;
  rebuildOwner = owner;
  return true;
}

export function releaseRebuild(): void {
  rebuildOwner = null;
}

export function isRebuildRunning(): boolean {
  return rebuildOwner !== null;
}

/**
 * Yield to the event loop between rebuild items. A bare `await` of a resolved
 * promise only queues a microtask — the stdio read loop never runs. A
 * macrotask hop lets me answer requests (and pings) while re-embedding.
 */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
