/**
 * Consolidation MCP Tool
 *
 * Provides the memory_consolidate tool for manual/catch-up consolidation.
 */

import { z } from "zod";
import type { FileStore } from "../storage/file-store.ts";
import type { GraphStore } from "../graph/store.ts";
import {
  findUnconsolidatedPeriods,
  runAllConsolidations,
  runConsolidation,
} from "../consolidation/mod.ts";
import type { ConsolidationResult } from "../consolidation/mod.ts";

/**
 * Input schema for the memory_consolidate tool.
 */
export const MemoryConsolidateSchema = z.object({
  granularity: z.enum(["weekly", "monthly", "yearly"]).optional().describe(
    "The granularity level to consolidate. If omitted with all=true, runs all levels.",
  ),
  targetDate: z.string().optional().describe(
    "Specific period to consolidate (e.g., '2026-W13', '2026-03', '2026'). " +
      "If omitted, consolidates the previous period.",
  ),
  all: z.boolean().optional().describe(
    "If true, run catch-up consolidation for all unconsolidated periods across all granularities.",
  ),
});

export type MemoryConsolidateInput = z.infer<typeof MemoryConsolidateSchema>;

/**
 * Output for a single consolidation result.
 */
interface ConsolidationOutput {
  granularity: "weekly" | "monthly" | "yearly";
  dateStr: string;
  success: boolean;
  error?: string;
}

/**
 * Handler for the memory_consolidate tool.
 */
export function createMemoryConsolidateHandler(
  store: FileStore,
  graphStore: GraphStore,
) {
  return async (input: MemoryConsolidateInput): Promise<{
    success: boolean;
    consolidations: ConsolidationOutput[];
    message: string;
  }> => {
    await store.initialize();
    await graphStore.initialize();

    // Catch-up mode: run all unconsolidated periods
    if (input.all) {
      const results = await runAllConsolidations(store, graphStore);
      const successful = results.filter((r) => r.success).length;
      return {
        success: successful > 0,
        consolidations: results.map((r) => ({
          granularity: r.granularity,
          dateStr: r.dateStr,
          success: r.success,
          error: r.error,
        })),
        message: successful > 0
          ? `Consolidated ${successful} period(s), ${
            results.length - successful
          } skipped or failed`
          : "No periods needed consolidation",
      };
    }

    // Specific granularity mode
    if (!input.granularity) {
      return {
        success: false,
        consolidations: [],
        message: "Must specify either granularity or all=true",
      };
    }

    // Status check mode: just check what needs consolidation
    if (!input.targetDate) {
      const periods = await findUnconsolidatedPeriods(store, input.granularity);
      if (periods.length === 0) {
        return {
          success: true,
          consolidations: [],
          message: `No unconsolidated ${input.granularity} periods found`,
        };
      }

      // Consolidate all unconsolidated periods for this granularity
      const results: ConsolidationResult[] = [];
      for (const dateStr of periods) {
        const result = await runConsolidation(
          store,
          graphStore,
          input.granularity,
          dateStr,
        );
        results.push(result);
      }
      const successful = results.filter((r) => r.success).length;

      return {
        success: successful > 0,
        consolidations: results.map((r) => ({
          granularity: r.granularity,
          dateStr: r.dateStr,
          success: r.success,
          error: r.error,
        })),
        message:
          `${input.granularity}: consolidated ${successful}/${periods.length} periods`,
      };
    }

    // Specific period mode
    const result = await runConsolidation(
      store,
      graphStore,
      input.granularity,
      input.targetDate,
    );
    return {
      success: result.success,
      consolidations: [{
        granularity: result.granularity,
        dateStr: result.dateStr,
        success: result.success,
        error: result.error,
      }],
      message: result.success
        ? `${result.granularity} consolidation complete: ${result.dateStr}`
        : `${result.granularity} consolidation failed: ${result.error}`,
    };
  };
}

/**
 * Tool description for memory_consolidate.
 */
export const memoryConsolidateDescription =
  "I consolidate my memories across time periods. Merges daily→weekly, weekly→monthly, monthly→yearly. " +
  "Use all=true for catch-up consolidation of everything that's behind. " +
  "Use granularity+targetDate for a specific period. Without targetDate, checks and runs all unconsolidated periods for that granularity.";
