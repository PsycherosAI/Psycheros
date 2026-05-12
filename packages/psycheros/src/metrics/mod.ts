/**
 * Metrics Module
 *
 * Streaming performance metrics collection for diagnosing API latency.
 *
 * @module
 */

export type { MetricsCollector } from "./types.ts";
export { SLOW_CHUNK_THRESHOLD_MS } from "./types.ts";

export {
  createCollector,
  finalize,
  recordChunk,
  recordFirstByte,
  setFinishReason,
} from "./collector.ts";
