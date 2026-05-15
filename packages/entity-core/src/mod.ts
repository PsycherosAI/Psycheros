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
import { ConsolidationRunner } from "./consolidation/mod.ts";
import { consolidateGraph } from "./graph/mod.ts";

// Re-export public API
export { createServer, startServer } from "./server.ts";
export { createFileStore, FileStore } from "./storage/mod.ts";
export * from "./types.ts";
export * from "./tools/mod.ts";
export * from "./sync/mod.ts";
export * from "./consolidation/mod.ts";
export { VERSION as ENTITY_CORE_VERSION } from "./version.ts";

// Main entry point
if (import.meta.main) {
  const dataDir = Deno.env.get("ENTITY_CORE_DATA_DIR") ?? "./data";

  await ensureDir(dataDir);
  console.error(`Starting Entity Core with data directory: ${dataDir}`);

  // Construct the storage stack once and share it with both surfaces
  // that need it: the MCP server (via startServer config) and the
  // local consolidation runner. Sharing a single GraphStore is what
  // makes `entity_import` work end-to-end — the import handler closes
  // and reinitializes this same instance, then re-arms the runner via
  // `runner.replaceDatabase(graphStore.getRawDb())`, so all sides
  // converge on the new SQLite connection after a graph.db swap.
  const store = new FileStore(dataDir);
  const graphStore = new GraphStore(dataDir);
  await store.initialize();
  await graphStore.initialize();

  // Local consolidation runner — owns its own table in graph.db and
  // fires weekly/monthly/yearly memory consolidation at 5 AM UTC on the
  // appropriate boundary. Missed fires during downtime catch up on the
  // first tick after boot (runs immediately as part of `start()`).
  const runner = new ConsolidationRunner(
    graphStore.getRawDb(),
    store,
    graphStore,
  );

  await startServer({
    ...DEFAULT_SERVER_CONFIG,
    dataDir,
    store,
    graphStore,
    consolidationRunner: runner,
  });

  runner.start();
  console.error(
    "[ConsolidationRunner] Memory consolidation scheduled (weekly/monthly/yearly at 5 AM UTC)",
  );

  // Remaining startup work: graph consolidation + embedding-cache
  // backfill. Fire-and-forget so stdio MCP startup isn't gated on heavy
  // work. Memory-consolidation catch-up is no longer here — the runner
  // owns that path now and fires it on its own first tick.
  (async () => {
    try {
      consolidateGraph(dataDir);
    } catch (error) {
      console.error(
        "[Graph] Consolidation failed:",
        error instanceof Error ? error.message : String(error),
      );
    }

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
}
