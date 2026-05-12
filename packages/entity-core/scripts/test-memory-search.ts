#!/usr/bin/env -S deno run -A
/**
 * Integration test for memory search with vector embeddings.
 *
 * Tests the full pipeline:
 * 1. Create a memory
 * 2. Verify memory_ref node is created with embedding
 * 3. Search for the memory using vector search
 * 4. Verify multi-signal ranking returns expected results
 *
 * Usage:
 *   deno run -A scripts/test-memory-search.ts
 */

import { FileStore } from "../src/storage/mod.ts";
import { GraphStore } from "../src/graph/store.ts";
import { getEmbedder } from "../src/embeddings/mod.ts";
import { createMemorySearchHandler } from "../src/tools/memory.ts";

const DATA_DIR = Deno.env.get("ENTITY_CORE_DATA_DIR") || "./data";
const TEST_PREFIX = "test-vector-search";

interface TestCase {
  granularity: "daily";
  date: string;
  content: string;
  instanceId: string;
  searchQuery: string;
  expectFound: boolean;
}

// Clean up test data from previous runs
async function cleanup(_store: FileStore, graphStore: GraphStore) {
  console.error("[Test] Cleaning up previous test data...");

  // Remove test memory files
  try {
    const testFiles = [
      `${DATA_DIR}/memories/daily/2026-03-19.md`,
      `${DATA_DIR}/memories/daily/2026-03-18.md`,
      `${DATA_DIR}/memories/daily/2026-01-15.md`,
    ];
    for (const f of testFiles) {
      try {
        await Deno.remove(f);
      } catch {
        // File doesn't exist, that's fine
      }
    }
  } catch {
    // Ignore
  }

  // Remove test graph nodes via SQL
  // deno-lint-ignore no-explicit-any
  const db = (graphStore as any).db;
  try {
    db.exec(
      "DELETE FROM vec_graph_nodes WHERE rowid IN (SELECT rowid FROM graph_nodes WHERE label LIKE ?)",
      [`%${TEST_PREFIX}%`],
    );
    db.exec("DELETE FROM graph_nodes WHERE label LIKE ?", [`%${TEST_PREFIX}%`]);
  } catch {
    // Ignore
  }
}

async function main() {
  console.error("=== Memory Search Integration Test ===\n");

  const store = new FileStore(DATA_DIR);
  await store.initialize();

  const graphStore = new GraphStore(DATA_DIR);
  await graphStore.initialize();

  const vectorAvailable = graphStore.isVectorSearchAvailable();
  console.error(`Vector search available: ${vectorAvailable}`);

  // Initialize embedder
  const embedder = getEmbedder();
  await embedder.initialize();
  console.error(`Embedder ready: ${embedder.isReady()}`);

  // Clean up first
  await cleanup(store, graphStore);

  // ---- Test 1: Create a memory and verify embedding ----
  console.error("\n--- Test 1: Memory creation with embedding ---");

  const testMemory = {
    id: "daily-2026-03-19",
    granularity: "daily" as const,
    date: "2026-03-19",
    content:
      `${TEST_PREFIX}: I had a wonderful conversation with the user about their cat named Whiskers. They told me Whiskers loves to sit on the keyboard and knock things off the table. The user seemed very happy and relaxed today.`,
    chatIds: [] as string[],
    sourceInstance: "test-instance",
    participatingInstances: ["test-instance"],
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Write the memory file
  await store.writeMemory(testMemory);
  console.error("  Written memory file: daily-2026-03-19.md");

  // Create memory_ref node with embedding
  const embedding = await embedder.embed(testMemory.content);
  if (!embedding) {
    console.error("  FAIL: Could not generate embedding for test memory");
    Deno.exit(1);
  }
  console.error(`  Generated embedding: ${embedding.length} dimensions`);

  if (!vectorAvailable) {
    console.error(
      "  SKIP: Vector table not available, storing node without embedding",
    );
  }

  const node = graphStore.createNode({
    type: "memory_ref",
    label: `${TEST_PREFIX}: daily memory (2026-03-19)`,
    description: testMemory.content,
    properties: { granularity: "daily", date: "2026-03-19", chatIds: [] },
    sourceInstance: "test-instance",
    confidence: 1.0,
    sourceMemoryId: "daily-2026-03-19",
  });

  if (vectorAvailable) {
    graphStore.updateNodeEmbedding(node.id, embedding);
    console.error("  Stored embedding in vec_graph_nodes");
  }

  // ---- Test 2: Vector search finds the memory ----
  console.error("\n--- Test 2: Vector search ---");

  const handler = createMemorySearchHandler(store, graphStore, {
    instanceBoost: 0.1,
    minScore: 0.1,
    maxResults: 10,
  });

  if (vectorAvailable) {
    // Test with a semantic query that should match
    const result = await handler({
      query: "user's cat that sits on the keyboard",
      instanceId: "test-instance",
    });

    console.error(`  Search method: ${result.searchMethod}`);
    console.error(`  Vector available: ${result.vectorAvailable}`);
    console.error(`  Results count: ${result.results.length}`);

    if (result.results.length > 0) {
      for (const r of result.results) {
        console.error(
          `    [${r.method}] ${r.date} score=${r.score} vectorScore=${r.vectorScore} tier=${r.tier} ageDays=${r.ageDays}`,
        );
      }
    }

    // Verify the test memory was found
    const found = result.results.some((r) => r.date === "2026-03-19");
    if (found) {
      console.error("  PASS: Test memory found via vector search");
    } else {
      console.error("  FAIL: Test memory not found in results");
    }

    // Verify output fields
    if (result.results.length > 0) {
      const first = result.results[0];
      const hasAllFields = "tier" in first && "ageDays" in first &&
        "vectorScore" in first && "method" in first;
      console.error(
        `  ${hasAllFields ? "PASS" : "FAIL"}: New output fields present`,
      );
    }
  } else {
    console.error("  SKIP: Vector search not available, testing text fallback");

    const result = await handler({
      query: "cat Whiskers keyboard",
      instanceId: "test-instance",
    });

    console.error(`  Search method: ${result.searchMethod}`);
    console.error(`  Results count: ${result.results.length}`);

    if (result.results.length > 0) {
      const found = result.results.some((r) => r.date === "2026-03-19");
      console.error(
        `  ${found ? "PASS" : "FAIL"}: Test memory found via text fallback`,
      );
    }
  }

  // ---- Test 3: Instance affinity ----
  console.error("\n--- Test 3: Instance affinity ---");

  if (vectorAvailable) {
    const sameInstance = await handler({
      query: "conversation about a cat",
      instanceId: "test-instance",
    });

    const otherInstance = await handler({
      query: "conversation about a cat",
      instanceId: "other-instance",
    });

    if (sameInstance.results.length > 0 && otherInstance.results.length > 0) {
      const sameScore = sameInstance.results[0].score;
      const otherScore = otherInstance.results[0].score;
      console.error(`  Same instance score: ${sameScore}`);
      console.error(`  Other instance score: ${otherScore}`);
      console.error(
        `  ${
          sameScore > otherScore ? "PASS" : "WARN"
        }: Same instance gets higher score`,
      );
    }
  }

  // ---- Test 4: Backward compatibility ----
  console.error("\n--- Test 4: Backward compatibility ---");

  if (vectorAvailable) {
    const result = await handler({
      query: "cat",
      instanceId: "test-instance",
    });

    if (result.results.length > 0) {
      const r = result.results[0];
      const hasOriginalFields = "granularity" in r && "date" in r &&
        "score" in r && "excerpt" in r && "sourceInstance" in r;
      console.error(
        `  ${
          hasOriginalFields ? "PASS" : "FAIL"
        }: Original output fields present`,
      );

      const hasNewFields = "searchMethod" in result &&
        "vectorAvailable" in result;
      console.error(
        `  ${hasNewFields ? "PASS" : "FAIL"}: New top-level fields present`,
      );
    }
  }

  // Clean up
  await cleanup(store, graphStore);

  console.error("\n=== Tests complete ===");
  graphStore.close();
}

main().catch((error) => {
  console.error("[Test] Fatal error:", error);
  Deno.exit(1);
});
