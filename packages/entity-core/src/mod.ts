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
import { releaseRebuild, tryAcquireRebuild } from "./embeddings/mod.ts";
import { ConsolidationRunner } from "./consolidation/mod.ts";
import { consolidateGraph } from "./graph/mod.ts";

// Re-export public API
export { createServer, startServer } from "./server.ts";
export { createFileStore, FileStore } from "./storage/mod.ts";
export { InstanceRegistry } from "./registry/mod.ts";
export type { RegisteredInstance } from "./registry/mod.ts";
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
  // both the GraphStore and the EmbeddingCache before renaming
  // `graph.db`, then reopens and reinitializes both. It also re-arms
  // the runner via `runner.replaceDatabase(graphStore.getRawDb())`,
  // so all sides converge on the new SQLite connection after a
  // graph.db swap.
  const store = new FileStore(dataDir);
  const graphStore = new GraphStore(dataDir);
  await store.initialize();
  await graphStore.initialize();

  // One shared EmbeddingCache for the whole process. The boot rebuild runs
  // in the background now — a second cache connection here would race it
  // on the vec tables (that race is why the backfill previously ran only
  // after the awaited rebuild; sharing one instance keeps the
  // single-connection invariant without the await).
  const embeddingCache = new EmbeddingCache(dataDir);
  await embeddingCache.initialize();

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
    embeddingCache,
    consolidationRunner: runner,
  });

  runner.start();
  console.error(
    "[ConsolidationRunner] Memory consolidation scheduled (weekly/monthly/yearly at 5 AM UTC)",
  );

  // Embedding sweep — my guarantee that memory files written by other
  // processes sharing this data dir (another harness's entity-core, or a
  // plain drop-in) become searchable without waiting for my next boot.
  // Same loop as the original startup backfill, now on an interval;
  // unchanged files cost one content-hash lookup each, so a sweep with
  // nothing to do is cheap. Embed-only by design — the sweep never
  // triggers graph extraction.
  const sweepMissingEmbeddings = async (): Promise<void> => {
    try {
      // When a rebuild is pending (or running in the background), skip —
      // the rebuild re-embeds everything, and running both is redundant
      // work on the same cache.
      if (embeddingCache.getRebuildReason() !== "none") return;
      if (!tryAcquireRebuild("backfill")) return;
      if (!embeddingCache.isAvailable()) return;

      // Initialize rather than skip when the embedder is cold — a fresh
      // process that hasn't searched yet is exactly the one whose sweep
      // must not silently no-op.
      const embedder = getEmbedder();
      await embedder.initialize();

      const granularities:
        ("daily" | "weekly" | "monthly" | "yearly" | "significant")[] = [
          "daily",
          "weekly",
          "monthly",
          "yearly",
          "significant",
        ];

      // getOrCompute returns the same shape on cache hit and fresh
      // compute, so count new work by the cache-size delta, not by
      // result truthiness.
      const before = embeddingCache.getStats().totalCached;

      for (const granularity of granularities) {
        const memories = await store.listMemories(granularity);
        for (const memory of memories) {
          await embeddingCache.getOrCompute(
            {
              granularity,
              date: memory.date,
              sourceInstance: memory.sourceInstance,
              slug: memory.slug,
              content: memory.content,
            },
            embedder,
          );
        }
      }

      const added = embeddingCache.getStats().totalCached - before;
      if (added > 0) {
        console.error(
          `[EmbeddingCache] Sweep embedded ${added} new/changed memory embedding(s)`,
        );
      }
    } catch (error) {
      console.error(
        "[EmbeddingCache] Embedding sweep failed:",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      releaseRebuild();
    }
  };

  // Sweep cadence: often enough that a dropped-in memory becomes
  // searchable within minutes, rarely enough that the hash-only pass
  // over an unchanged tree stays trivial.
  const EMBEDDING_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

  // Remaining startup work: graph consolidation + first embedding sweep.
  // Fire-and-forget so stdio MCP startup isn't gated on heavy work.
  // Memory-consolidation catch-up is no longer here — the runner owns
  // that path now and fires it on its own first tick.
  (async () => {
    try {
      consolidateGraph(dataDir);
    } catch (error) {
      console.error(
        "[Graph] Consolidation failed:",
        error instanceof Error ? error.message : String(error),
      );
    }

    await sweepMissingEmbeddings();
  })();

  // Re-sweep on an interval so externally-written memories are picked up
  // while I run, not just at boot.
  setInterval(() => void sweepMissingEmbeddings(), EMBEDDING_SWEEP_INTERVAL_MS);
}
