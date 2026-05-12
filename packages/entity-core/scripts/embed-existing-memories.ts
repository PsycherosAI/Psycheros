#!/usr/bin/env -S deno run -A
/**
 * Retroactively embed existing memory_ref nodes that lack embeddings.
 *
 * Reads the full memory content from disk for each memory_ref node,
 * generates an embedding, and stores it in vec_graph_nodes.
 *
 * Usage:
 *   deno run -A scripts/embed-existing-memories.ts [--dry-run] [--verbose]
 */

import { join } from "@std/path/join";
import { GraphStore } from "../src/graph/store.ts";
import { getEmbedder } from "../src/embeddings/mod.ts";

const DATA_DIR = Deno.env.get("ENTITY_CORE_DATA_DIR") || "./data";
const DRY_RUN = Deno.args.includes("--dry-run");
const VERBOSE = Deno.args.includes("--verbose");

async function main() {
  console.error(`[Migration] Data directory: ${DATA_DIR}`);
  if (DRY_RUN) {
    console.error("[Migration] Dry run mode — no changes will be made");
  }

  // Initialize graph store
  const graphStore = new GraphStore(DATA_DIR);
  await graphStore.initialize();

  if (!graphStore.isVectorSearchAvailable()) {
    console.error(
      "[Migration] Vector search is not available. Cannot embed memories.",
    );
    Deno.exit(1);
  }

  // Initialize embedder
  const embedder = getEmbedder();
  await embedder.initialize();

  if (!embedder.isReady()) {
    console.error(
      "[Migration] Failed to load embedding model. Cannot proceed.",
    );
    Deno.exit(1);
  }

  // Find all memory_ref nodes (using SQL directly since there's no listNodesByType)
  // deno-lint-ignore no-explicit-any
  const db = (graphStore as any).db;
  const stmt = db.prepare(
    "SELECT id, source_memory_id, description, properties FROM graph_nodes WHERE type = 'memory_ref' AND deleted = 0",
  );
  // deno-lint-ignore no-explicit-any
  const rawNodes = stmt.all() as any;
  const nodes: Array<{
    id: string;
    source_memory_id: string | null;
    description: string;
    properties: string;
  }> = rawNodes;
  stmt.finalize();

  console.error(`[Migration] Found ${nodes.length} memory_ref nodes`);

  let embedded = 0;
  let skipped = 0;
  let failed = 0;

  for (const node of nodes) {
    const memoryId = node.source_memory_id;
    if (!memoryId) {
      if (VERBOSE) console.error(`  Skipping ${node.id} — no source_memory_id`);
      skipped++;
      continue;
    }

    // Check if embedding already exists
    try {
      const existingStmt = db.prepare(
        "SELECT rowid FROM vec_graph_nodes WHERE rowid = (SELECT rowid FROM graph_nodes WHERE id = ?)",
      );
      const existing = existingStmt.get(node.id) as
        | { rowid: number }
        | undefined;
      existingStmt.finalize();

      if (existing) {
        if (VERBOSE) {
          console.error(`  Skipping ${memoryId} — already has embedding`);
        }
        skipped++;
        continue;
      }
    } catch {
      // Table might not exist yet, proceed with embedding
    }

    // Read full memory content from disk
    const dashIndex = memoryId.indexOf("-");
    if (dashIndex === -1) {
      if (VERBOSE) {
        console.error(`  Skipping ${memoryId} — can't parse granularity/date`);
      }
      skipped++;
      continue;
    }

    const granularity = memoryId.slice(0, dashIndex);
    const date = memoryId.slice(dashIndex + 1);
    const filePath = join(DATA_DIR, "memories", granularity, `${date}.md`);

    let content: string;
    try {
      content = await Deno.readTextFile(filePath);
    } catch {
      if (VERBOSE) {
        console.error(`  Skipping ${memoryId} — file not found at ${filePath}`);
      }
      skipped++;
      continue;
    }

    if (!DRY_RUN) {
      try {
        const embedding = await embedder.embed(content);
        if (embedding) {
          graphStore.updateNodeEmbedding(node.id, embedding);
          embedded++;
          if (VERBOSE) {
            console.error(`  Embedded ${memoryId} (${content.length} chars)`);
          }
        } else {
          failed++;
          console.error(`  Failed to generate embedding for ${memoryId}`);
        }
      } catch (error) {
        failed++;
        console.error(
          `  Error embedding ${memoryId}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    } else {
      embedded++;
      if (VERBOSE) {
        console.error(`  Would embed ${memoryId} (${content.length} chars)`);
      }
    }
  }

  console.error(`\n[Migration] Complete:`);
  console.error(`  Embedded: ${embedded}`);
  console.error(`  Skipped:  ${skipped}`);
  console.error(`  Failed:   ${failed}`);

  graphStore.close();
}

main().catch((error) => {
  console.error("[Migration] Fatal error:", error);
  Deno.exit(1);
});
