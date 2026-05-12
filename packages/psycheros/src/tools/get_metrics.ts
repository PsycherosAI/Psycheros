/**
 * Get Metrics Tool
 *
 * Allows the entity to retrieve streaming performance metrics for the current
 * conversation. Useful for diagnosing API latency issues.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";

/**
 * Format milliseconds as a human-readable string.
 */
function formatMs(ms: number | null): string {
  if (ms === null) return "-";
  if (ms >= 1000) {
    return (ms / 1000).toFixed(1) + "s";
  }
  return Math.round(ms) + "ms";
}

/**
 * The get_metrics tool retrieves streaming performance metrics.
 *
 * This is useful for:
 * - Diagnosing slow API responses
 * - Understanding latency patterns
 * - Identifying problematic turns
 */
export const getMetricsTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "get_metrics",
      description:
        "Retrieve streaming performance metrics for recent turns in this conversation. " +
        "I use this to analyze API latency, identify slow responses, or diagnose streaming issues. " +
        "Metrics include TTFB (time to first byte), TTFC (time to first content), " +
        "chunk gaps, and total duration.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            description:
              "Maximum number of recent metrics to return (default: 5, max: 20)",
            minimum: 1,
            maximum: 20,
          },
        },
        required: [],
      },
    },
  },

  execute: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    // Validate and constrain limit
    let limit = 5;
    if (typeof args.limit === "number") {
      limit = Math.min(Math.max(1, Math.floor(args.limit)), 20);
    }

    // Retrieve metrics from database
    const metrics = ctx.db.getTurnMetrics(ctx.conversationId, limit);

    if (metrics.length === 0) {
      return Promise.resolve({
        toolCallId: ctx.toolCallId,
        content: "No metrics found for this conversation yet.",
        isError: false,
      });
    }

    // Format metrics for readability
    const formattedMetrics = metrics.map((m, i) => {
      const lines = [
        `Turn ${i + 1} (${m.finishReason || "unknown"}):`,
        `  TTFB: ${formatMs(m.ttfb)}`,
        `  TTFC: ${formatMs(m.ttfc)}`,
        `  Max Chunk Gap: ${formatMs(m.maxChunkGap)}`,
        `  Slow Chunks (>500ms): ${m.slowChunkCount}`,
        `  Total Duration: ${formatMs(m.totalDuration)}`,
        `  Chunk Count: ${m.chunkCount}`,
        `  Timestamp: ${m.requestStartedAt}`,
      ];
      return lines.join("\n");
    });

    const summary = [
      `Streaming Performance Metrics (${metrics.length} turns):`,
      "",
      ...formattedMetrics,
      "",
      "Legend:",
      "  TTFB = Time to First Byte (API connection established)",
      "  TTFC = Time to First Content (first meaningful token)",
      "  Slow = TTFB >2s, TTFC >3s, or gaps >1s indicate issues",
    ].join("\n");

    return Promise.resolve({
      toolCallId: ctx.toolCallId,
      content: summary,
      isError: false,
    });
  },
};
