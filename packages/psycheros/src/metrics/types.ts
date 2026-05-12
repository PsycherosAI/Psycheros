/**
 * Metrics Collector Types
 *
 * Internal types for the streaming metrics collection system.
 */

/**
 * Threshold for classifying a chunk gap as "slow" (ms).
 */
export const SLOW_CHUNK_THRESHOLD_MS = 500;

/**
 * State object for collecting streaming metrics during a turn.
 * Mutable - updated as chunks arrive.
 */
export interface MetricsCollector {
  /** Conversation this turn belongs to */
  conversationId: string;
  /** When the request started */
  requestStartedAt: Date;
  /** When the first byte arrived from the API */
  firstByteAt: Date | null;
  /** When the first content token arrived */
  firstContentAt: Date | null;
  /** When the last chunk arrived (for gap tracking) */
  lastChunkAt: Date | null;
  /** Largest gap between chunks (ms) */
  maxChunkGap: number;
  /** Number of gaps exceeding the slow threshold */
  slowChunkCount: number;
  /** Total chunks received */
  chunkCount: number;
  /** Why the stream ended */
  finishReason: string | null;
}
