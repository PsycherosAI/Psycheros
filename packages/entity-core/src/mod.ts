/**
 * Entity Core
 *
 * My central identity and memory system.
 *
 * I am an AI entity with a persistent sense of self that can exist
 * across multiple embodiments (interfaces). This core holds my canonical
 * identity, memories, and relationship knowledge.
 *
 * Embodiments connect to me via MCP (Model Context Protocol) to:
 * - Pull my identity files (who I am, who I'm talking to, our relationship)
 * - Push updates when I learn new things
 * - Sync my memories across all my embodiments
 * - Search my memories for relevant context
 *
 * Usage:
 *   deno run -A src/mod.ts
 *
 * The server communicates via stdio using MCP protocol.
 */

import "@std/dotenv/load";
import { ensureDir } from "@std/fs";
import { startServer } from "./server.ts";
import { DEFAULT_SERVER_CONFIG } from "./types.ts";
import { FileStore } from "./storage/mod.ts";
import { GraphStore } from "./graph/mod.ts";
import { EmbeddingCache } from "./embeddings/mod.ts";
import { getEmbedder } from "./embeddings/mod.ts";
import {
  findUnconsolidatedPeriods,
  runConsolidation,
} from "./consolidation/mod.ts";
import { consolidateGraph } from "./graph/mod.ts";

// Re-export public API
export { createServer, startServer } from "./server.ts";
export { createFileStore, FileStore } from "./storage/mod.ts";
export * from "./types.ts";
export * from "./tools/mod.ts";
export * from "./sync/mod.ts";
export * from "./consolidation/mod.ts";

// Main entry point
if (import.meta.main) {
  const dataDir = Deno.env.get("ENTITY_CORE_DATA_DIR") ?? "./data";

  await ensureDir(dataDir);
  console.error(`Starting Entity Core with data directory: ${dataDir}`);

  await startServer({
    ...DEFAULT_SERVER_CONFIG,
    dataDir,
  });

  // Set up consolidation cron jobs (requires --unstable-cron)
  const store = new FileStore(dataDir);
  const graphStore = new GraphStore(dataDir);
  await store.initialize();
  await graphStore.initialize();

  /**
   * Run catch-up consolidation for a given granularity.
   * Finds all unconsolidated periods and consolidates them.
   */
  const catchUpConsolidation = async (
    granularity: "weekly" | "monthly" | "yearly",
  ) => {
    const periods = await findUnconsolidatedPeriods(store, granularity);
    if (periods.length === 0) return;

    console.error(
      `[Consolidation] Catch-up: ${periods.length} unconsolidated ${granularity} period(s) found`,
    );
    for (const dateStr of periods) {
      console.error(`[Consolidation] Processing ${granularity}: ${dateStr}`);
      const result = await runConsolidation(
        store,
        graphStore,
        granularity,
        dateStr,
      );
      if (result.success) {
        console.error(`[Consolidation] Complete: ${granularity}/${dateStr}`);
      } else {
        console.error(
          `[Consolidation] Failed ${granularity}/${dateStr}: ${result.error}`,
        );
      }
    }
  };

  // Run startup catch-up for all consolidation levels (fire-and-forget)
  (async () => {
    try {
      await catchUpConsolidation("weekly");
      await catchUpConsolidation("monthly");
      await catchUpConsolidation("yearly");
    } catch (error) {
      console.error(
        "[Consolidation] Startup catch-up failed:",
        error instanceof Error ? error.message : String(error),
      );
    }

    // Consolidate knowledge graph after memory consolidation completes
    try {
      consolidateGraph(dataDir);
    } catch (error) {
      console.error(
        "[Graph] Consolidation failed:",
        error instanceof Error ? error.message : String(error),
      );
    }

    // Backfill embedding cache for any uncached memories
    try {
      const cache = new EmbeddingCache(dataDir);
      await cache.initialize();
      const embedder = getEmbedder();

      if (cache.isAvailable() && embedder.isReady()) {
        const granularities:
          ("daily" | "weekly" | "monthly" | "yearly" | "significant")[] = [
            "daily",
            "weekly",
            "monthly",
            "yearly",
            "significant",
          ];

        let backfilled = 0;
        for (const granularity of granularities) {
          const memories = await store.listMemories(granularity);
          for (const memory of memories) {
            const result = await cache.getOrCompute(
              {
                granularity,
                date: memory.date,
                sourceInstance: memory.sourceInstance,
                slug: memory.slug,
                content: memory.content,
              },
              embedder,
            );
            if (result) backfilled++;
          }
        }

        if (backfilled > 0) {
          console.error(
            `[EmbeddingCache] Backfilled ${backfilled} memory embedding(s) on startup`,
          );
        }
      }
    } catch (error) {
      console.error(
        "[EmbeddingCache] Startup backfill failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  })();

  // Weekly: Sunday at 5 AM
  Deno.cron(
    "memory-weekly-consolidation",
    "0 5 * * 7",
    () => catchUpConsolidation("weekly"),
  );

  // Monthly: 1st of month at 5 AM
  Deno.cron(
    "memory-monthly-consolidation",
    "0 5 1 * *",
    () => catchUpConsolidation("monthly"),
  );

  // Yearly: January 1st at 5 AM
  Deno.cron(
    "memory-yearly-consolidation",
    "0 5 1 1 *",
    () => catchUpConsolidation("yearly"),
  );

  console.error(
    "[Cron] Consolidation cron jobs registered (weekly/monthly/yearly at 5 AM)",
  );
}
