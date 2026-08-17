/**
 * Embedding Re-index Event
 *
 * Mirrors entity-core's `notifications/embedding-rebuild` notification so the
 * re-index banner works identically whether the rebuild is entity-core-driven
 * (boot background rebuild) or orchestrator-driven (Settings re-embed).
 */

export type ReindexPhase =
  | "started"
  | "progress"
  | "done"
  | "failed"
  | "model_change_detected";

export interface EmbeddingReindexEvent {
  phase: ReindexPhase;
  scope?: "memory" | "all";
  done?: number;
  total?: number;
  message?: string;
}
