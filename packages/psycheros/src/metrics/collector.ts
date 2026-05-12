/**
 * Metrics Collector
 *
 * Functions for collecting streaming performance metrics during an LLM turn.
 * Designed to be non-intrusive - callers pass the collector to track points.
 */

import type { TurnMetrics } from "../types.ts";
import type { MetricsCollector } from "./types.ts";
import { SLOW_CHUNK_THRESHOLD_MS } from "./types.ts";

/**
 * Create a new metrics collector for a conversation turn.
 *
 * @param conversationId - The conversation this turn belongs to
 * @returns A new MetricsCollector initialized with start time
 */
export function createCollector(conversationId: string): MetricsCollector {
  return {
    conversationId,
    requestStartedAt: new Date(),
    firstByteAt: null,
    firstContentAt: null,
    lastChunkAt: null,
    maxChunkGap: 0,
    slowChunkCount: 0,
    chunkCount: 0,
    finishReason: null,
  };
}

/**
 * Record when the first byte arrived from the API.
 * Call this immediately after makeRequest() returns successfully.
 *
 * @param collector - The metrics collector to update
 */
export function recordFirstByte(collector: MetricsCollector): void {
  if (!collector.firstByteAt) {
    collector.firstByteAt = new Date();
  }
}

/**
 * Record a chunk arriving from the stream.
 * Updates gap statistics and content timing.
 *
 * @param collector - The metrics collector to update
 * @param isContent - True if this chunk contains actual content (not just metadata)
 */
export function recordChunk(
  collector: MetricsCollector,
  isContent: boolean,
): void {
  const now = new Date();
  collector.chunkCount++;

  // Track gap from previous chunk
  if (collector.lastChunkAt) {
    const gap = now.getTime() - collector.lastChunkAt.getTime();
    if (gap > collector.maxChunkGap) {
      collector.maxChunkGap = gap;
    }
    if (gap > SLOW_CHUNK_THRESHOLD_MS) {
      collector.slowChunkCount++;
    }
  }

  collector.lastChunkAt = now;

  // Track first content timestamp
  if (isContent && !collector.firstContentAt) {
    collector.firstContentAt = now;
  }
}

/**
 * Set the finish reason for the stream.
 *
 * @param collector - The metrics collector to update
 * @param finishReason - The reason the stream ended
 */
export function setFinishReason(
  collector: MetricsCollector,
  finishReason: string,
): void {
  collector.finishReason = finishReason;
}

/**
 * Options for finalizing metrics.
 */
export interface FinalizeOptions {
  /** Final finish reason (overrides any set during stream) */
  finishReason?: string;
  /** Message ID to link metrics to */
  messageId?: string;
}

/**
 * Finalize the collector and produce a TurnMetrics object.
 * Calculates derived values like TTFB and total duration.
 *
 * @param collector - The metrics collector to finalize
 * @param options - Optional finalize options (finish reason, message ID)
 * @returns A TurnMetrics object ready for persistence
 */
export function finalize(
  collector: MetricsCollector,
  options?: FinalizeOptions | string,
): TurnMetrics {
  // Support legacy signature: finalize(collector, finishReason)
  const opts: FinalizeOptions = typeof options === "string"
    ? { finishReason: options }
    : options ?? {};

  const now = new Date();
  const startMs = collector.requestStartedAt.getTime();

  // Calculate time to first byte
  const ttfb = collector.firstByteAt
    ? collector.firstByteAt.getTime() - startMs
    : null;

  // Calculate time to first content
  const ttfc = collector.firstContentAt
    ? collector.firstContentAt.getTime() - startMs
    : null;

  // Calculate total duration
  const totalDuration = now.getTime() - startMs;

  return {
    id: crypto.randomUUID(),
    conversationId: collector.conversationId,
    messageId: opts.messageId,
    requestStartedAt: collector.requestStartedAt.toISOString(),
    ttfb,
    ttfc,
    maxChunkGap: collector.maxChunkGap > 0 ? collector.maxChunkGap : null,
    slowChunkCount: collector.slowChunkCount,
    totalDuration,
    chunkCount: collector.chunkCount,
    finishReason: opts.finishReason ?? collector.finishReason,
    createdAt: now.toISOString(),
  };
}
