#!/usr/bin/env -S deno run -A
/**
 * Batch populate knowledge graph from memory files.
 *
 * Reads memory files from disk, extracts entities and relationships via LLM,
 * and creates graph nodes/edges. Matches the real-time extraction path in
 * src/graph/memory-integration.ts.
 *
 * Idempotent: re-running may create duplicate edges (harmless) but
 * semantic dedup prevents duplicate entity nodes.
 *
 * Usage:
 *   deno run -A scripts/batch-populate-graph.ts [flags]
 *
 * Flags:
 *   --days N         Process memories from the last N days (default: 7)
 *   --granularity G  Target granularity: daily|weekly|monthly|yearly|significant|all (default: daily)
 *   --file PATH      Process a single specific file (e.g. daily/2026-03-17.md)
 *                    Overrides --days and --granularity
 *   --instance ID    Set sourceInstance on created nodes/edges (default: batch-populate-script)
 *   --dry-run        Extract but don't write to graph
 *   --verbose        Show per-entity detail
 */

import { GraphStore } from "../src/graph/store.ts";
import { FileStore } from "../src/storage/file-store.ts";
import { createLLMClient } from "../src/llm/mod.ts";
import { getEmbedder } from "../src/embeddings/mod.ts";
import type { Granularity, MemoryEntry } from "../src/types.ts";
import {
  buildExtractionPrompt,
  confirmNode,
  type ExtractionType,
  findSemanticDuplicate,
  MIN_CONFIDENCE,
} from "../src/graph/extraction-prompt.ts";

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

const DATA_DIR = Deno.env.get("ENTITY_CORE_DATA_DIR") || "./data";
const DRY_RUN = Deno.args.includes("--dry-run");
const VERBOSE = Deno.args.includes("--verbose");

function getArgValue(flag: string): string | null {
  const idx = Deno.args.indexOf(flag);
  if (idx === -1 || idx + 1 >= Deno.args.length) return null;
  return Deno.args[idx + 1];
}

const DAYS_ARG = getArgValue("--days");
const DAYS = DAYS_ARG ? parseInt(DAYS_ARG, 10) : 7;
const GRANULARITY_ARG = getArgValue("--granularity") || "daily";
const FILE_ARG = getArgValue("--file");
const INSTANCE_ID = getArgValue("--instance") || "batch-populate-script";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID_GRANULARITIES: Array<Granularity | "all"> = [
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "significant",
  "all",
];

if (!VALID_GRANULARITIES.includes(GRANULARITY_ARG as Granularity | "all")) {
  console.error(`Invalid granularity: "${GRANULARITY_ARG}"`);
  console.error(`Valid values: ${VALID_GRANULARITIES.join(", ")}`);
  Deno.exit(1);
}

if (DAYS_ARG && (isNaN(DAYS) || DAYS <= 0)) {
  console.error(`Invalid --days value: "${DAYS_ARG}"`);
  Deno.exit(1);
}

// ---------------------------------------------------------------------------
// Date filtering
// ---------------------------------------------------------------------------

function isWithinDays(memoryId: string, cutoffDate: Date): boolean {
  const dashIndex = memoryId.indexOf("-");
  if (dashIndex === -1) return false;
  const granularity = memoryId.slice(0, dashIndex);
  const datePart = memoryId.slice(dashIndex + 1);

  switch (granularity) {
    case "daily": {
      const memDate = new Date(datePart + "T00:00:00Z");
      return memDate >= cutoffDate;
    }
    case "weekly": {
      const yearWeekMatch = datePart.match(/^(\d{4})-W(\d{2})$/);
      if (!yearWeekMatch) return false;
      const year = parseInt(yearWeekMatch[1], 10);
      const week = parseInt(yearWeekMatch[2], 10);
      const jan1 = new Date(`${year}-01-01T00:00:00Z`);
      const dayOfWeek = jan1.getUTCDay();
      const weekStart = new Date(jan1);
      weekStart.setUTCDate(
        jan1.getUTCDate() + (week - 1) * 7 - ((dayOfWeek + 6) % 7),
      );
      return weekStart >= cutoffDate;
    }
    case "monthly": {
      const [year, month] = datePart.split("-").map(Number);
      const memDate = new Date(
        `${year}-${String(month).padStart(2, "0")}-01T00:00:00Z`,
      );
      return memDate >= cutoffDate;
    }
    case "yearly": {
      const year = parseInt(datePart, 10);
      return new Date(`${year}-01-01T00:00:00Z`) >= cutoffDate;
    }
    case "significant":
      // Significant memories have no temporal filter
      return true;
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Per-memory result tracking
// ---------------------------------------------------------------------------

interface MemoryResult {
  memoryId: string;
  nodesCreated: number;
  edgesCreated: number;
  skipped: boolean;
  skippedReason?: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Batch Populate Knowledge Graph ===\n");
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Dry run: ${DRY_RUN}`);
  console.log(`Verbose: ${VERBOSE}`);
  console.log(`Instance: ${INSTANCE_ID}`);
  console.log(`Granularity: ${GRANULARITY_ARG}`);
  console.log(`Days: ${FILE_ARG ? "(single file mode)" : DAYS}\n`);

  // 1. Create LLM client
  const llm = createLLMClient();
  if (!llm) {
    console.error(
      "Failed to create LLM client. Set ENTITY_CORE_LLM_API_KEY or ZAI_API_KEY.",
    );
    Deno.exit(1);
  }
  console.log("LLM client created.\n");

  // 2. Open graph store
  const graphStore = new GraphStore(DATA_DIR);
  await graphStore.initialize();
  console.log(`Graph store opened.\n`);

  // 3. Initialize embedder (start loading model)
  const embedder = getEmbedder();
  const embedderInitPromise = embedder.initialize();
  console.log("Embedder model loading...\n");

  // 4. Build label-to-id map from existing nodes
  const labelToId = new Map<string, string>();
  const existingNodes = graphStore.listNodes({ limit: 10000 });
  for (const node of existingNodes) {
    labelToId.set(node.label.toLowerCase(), node.id);
  }
  console.log(`Pre-loaded ${labelToId.size} existing node labels.\n`);

  // 5. Discover memories to process
  const fileStore = new FileStore(DATA_DIR);
  const memoriesToProcess: MemoryEntry[] = [];

  if (FILE_ARG) {
    // Single file mode
    const parts = FILE_ARG.replace(/\.md$/, "").split("/");
    if (parts.length >= 2) {
      const granularity = parts[0] as Granularity;
      const date = parts.slice(1).join("/");
      const memory = await fileStore.readMemory(granularity, date);
      if (memory) {
        memoriesToProcess.push(memory);
      } else {
        console.error(`File not found: ${FILE_ARG}`);
      }
    } else {
      console.error(
        `Invalid --file format. Use e.g. --file daily/2026-03-17.md`,
      );
    }
  } else {
    // Batch mode — determine granularities to scan
    const granularities: Granularity[] = GRANULARITY_ARG === "all"
      ? ["daily", "weekly", "monthly", "yearly", "significant"]
      : [GRANULARITY_ARG as Granularity];

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - DAYS);
    cutoffDate.setHours(0, 0, 0, 0);

    for (const granularity of granularities) {
      const memories = await fileStore.listMemories(granularity);
      for (const memory of memories) {
        if (isWithinDays(memory.id, cutoffDate)) {
          memoriesToProcess.push(memory);
        }
      }
    }
  }

  console.log(`Found ${memoriesToProcess.length} memories to process.\n`);

  if (memoriesToProcess.length === 0) {
    console.log("No memories to process.");
    graphStore.close();
    return;
  }

  // 6. Process each memory
  const results: MemoryResult[] = [];
  let totalNodesCreated = 0;
  let totalEdgesCreated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (const memory of memoriesToProcess) {
    const result: MemoryResult = {
      memoryId: memory.id,
      nodesCreated: 0,
      edgesCreated: 0,
      skipped: false,
    };

    // Skip short/trivial content
    if (memory.content.trim().length < 100) {
      result.skipped = true;
      result.skippedReason =
        `content too short (${memory.content.trim().length} chars)`;
      totalSkipped++;
      if (VERBOSE) console.log(`  Skipping ${memory.id} — content too short`);
      results.push(result);
      continue;
    }

    // Skip test memories
    if (memory.content.includes("memory_test")) {
      result.skipped = true;
      result.skippedReason = "test memory";
      totalSkipped++;
      if (VERBOSE) console.log(`  Skipping ${memory.id} — test memory`);
      results.push(result);
      continue;
    }

    console.log(`\nProcessing: ${memory.id} (${memory.content.length} chars)`);

    // Build extraction prompt from shared module
    const prompt = buildExtractionPrompt(memory.content, memory.date);

    try {
      console.log("  Calling LLM...");
      const extraction: ExtractionType = await llm.completeJSON<ExtractionType>(
        prompt,
        {
          temperature: 0.3,
        },
      );

      // Apply confidence floor — silently drop low-confidence extractions
      const rawEntities = extraction.entities ?? [];
      const rawRelationships = extraction.relationships ?? [];
      const confidenceDroppedEntities =
        rawEntities.filter((e: ExtractionType["entities"][number]) =>
          e.confidence < MIN_CONFIDENCE
        ).length;
      const confidenceDroppedRelationships =
        rawRelationships.filter((r: ExtractionType["relationships"][number]) =>
          r.confidence < MIN_CONFIDENCE
        ).length;
      const entities = rawEntities.filter((
        e: ExtractionType["entities"][number],
      ) => e.confidence >= MIN_CONFIDENCE);
      const relationships = rawRelationships.filter((
        r: ExtractionType["relationships"][number],
      ) => r.confidence >= MIN_CONFIDENCE);

      console.log(
        `  Extracted ${entities.length} entities, ${relationships.length} relationships` +
          (confidenceDroppedEntities + confidenceDroppedRelationships > 0
            ? ` (${confidenceDroppedEntities} entities, ${confidenceDroppedRelationships} relations below confidence floor)`
            : ""),
      );

      if (entities.length === 0 && relationships.length === 0) {
        if (VERBOSE) console.log("  No entities or relationships found");
        results.push(result);
        continue;
      }

      if (DRY_RUN) {
        if (VERBOSE) {
          for (const e of entities) {
            console.log(
              `    [entity] ${e.label} (${e.type}) conf=${e.confidence}`,
            );
          }
          for (const r of relationships) {
            console.log(
              `    [rel] ${r.fromLabel} --${r.type}--> ${r.toLabel}`,
            );
          }
        }
        result.nodesCreated = entities.length;
        result.edgesCreated = relationships.length;
        results.push(result);
        continue;
      }

      // Resolve entities to existing node IDs via semantic dedup (async)
      await embedderInitPromise; // Ensure model is loaded for dedup
      const localLabelToId = new Map<string, string>();
      const newEntities: ExtractionType["entities"] = [];
      let semanticDedupCount = 0;

      for (const entity of entities) {
        const labelLower = entity.label.toLowerCase();
        if (localLabelToId.has(labelLower)) continue;

        // Check global label map first (fast path for already-seen labels)
        let existingId = labelToId.get(labelLower);

        if (!existingId) {
          const existing = await findSemanticDuplicate(graphStore, embedder, {
            label: entity.label,
            type: entity.type,
          });

          if (existing) {
            existingId = existing.id;
            labelToId.set(labelLower, existingId);
            // Confirm-and-boost the existing node
            confirmNode(
              graphStore,
              existing.id,
              entity.confidence,
              existing.confidence,
              INSTANCE_ID,
            );
            semanticDedupCount++;
            if (VERBOSE) {
              console.log(
                `    [semantic dedup] ${entity.label} -> existing ${existing.id}`,
              );
            }
          }
        }

        if (existingId) {
          localLabelToId.set(labelLower, existingId);
          if (!VERBOSE || semanticDedupCount === 0) {
            if (VERBOSE) console.log(`    [exists] ${entity.label}`);
          }
          continue;
        }

        newEntities.push(entity);
      }

      if (VERBOSE && semanticDedupCount > 0) {
        console.log(`  Semantic dedup resolved ${semanticDedupCount} entities`);
      }

      // Write to graph inside a transaction
      const { nodesCreated, edgesCreated } = graphStore.transaction(() => {
        let nc = 0;
        let ec = 0;

        // Create new entity nodes (ones not resolved by dedup)
        for (const entity of newEntities) {
          const labelLower = entity.label.toLowerCase();
          if (localLabelToId.has(labelLower)) continue;

          const node = graphStore.createNode({
            type: entity.type,
            label: entity.label,
            description: entity.description,
            sourceInstance: INSTANCE_ID,
            confidence: entity.confidence,
            properties: {},
          });

          localLabelToId.set(labelLower, node.id);
          labelToId.set(labelLower, node.id);
          nc++;
          if (VERBOSE) {
            console.log(
              `    [created] ${entity.label} (${entity.type}) -> ${node.id}`,
            );
          }
        }

        // Create relationship edges
        for (const rel of relationships) {
          const fromId = localLabelToId.get(rel.fromLabel.toLowerCase()) ??
            labelToId.get(rel.fromLabel.toLowerCase()) ??
            graphStore.findNodeByLabel(rel.fromLabel)?.id;
          const toId = localLabelToId.get(rel.toLabel.toLowerCase()) ??
            labelToId.get(rel.toLabel.toLowerCase()) ??
            graphStore.findNodeByLabel(rel.toLabel)?.id;

          if (!fromId || !toId) {
            if (VERBOSE) {
              console.log(
                `    [skip edge] ${rel.fromLabel} -> ${rel.toLabel} (missing node)`,
              );
            }
            continue;
          }

          try {
            graphStore.createEdge({
              fromId,
              toId,
              type: rel.type,
              sourceInstance: INSTANCE_ID,
              weight: rel.confidence,
              evidence: rel.evidence,
            });
            ec++;
            if (VERBOSE) {
              console.log(
                `    [edge] ${rel.fromLabel} --${rel.type}--> ${rel.toLabel}`,
              );
            }
          } catch {
            // Edge might already exist
          }
        }

        return { nodesCreated: nc, edgesCreated: ec };
      });

      result.nodesCreated = nodesCreated;
      result.edgesCreated = edgesCreated;

      totalNodesCreated += nodesCreated;
      totalEdgesCreated += edgesCreated;
    } catch (error) {
      console.error(
        `  Error processing ${memory.id}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      totalErrors++;
    }

    results.push(result);

    // Rate limiting between LLM calls
    if (!DRY_RUN) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  // 7. Summary
  console.log("\n\n=== Batch Populate Summary ===\n");
  console.log(`Memories scanned:      ${memoriesToProcess.length}`);
  console.log(
    `Memories processed:    ${results.filter((r) => !r.skipped).length}`,
  );
  console.log(`Memories skipped:      ${totalSkipped}`);
  console.log(`Errors:                ${totalErrors}`);
  console.log(`Entity nodes created:  ${totalNodesCreated}`);
  console.log(`Relationship edges:    ${totalEdgesCreated}`);
  if (DRY_RUN) console.log(`\n[DRY RUN] No changes made to graph.`);

  if (totalNodesCreated > 0 || totalEdgesCreated > 0 || DRY_RUN) {
    console.log("\nMemories with extractions:");
    for (const r of results) {
      if (r.nodesCreated > 0 || r.edgesCreated > 0) {
        console.log(
          `  ${r.memoryId}: +${r.nodesCreated} entities, +${r.edgesCreated} edges`,
        );
      }
    }
  }

  if (totalSkipped > 0 && VERBOSE) {
    console.log("\nSkipped memories:");
    for (const r of results) {
      if (r.skipped && r.skippedReason) {
        console.log(`  ${r.memoryId}: ${r.skippedReason}`);
      }
    }
  }

  // Final graph stats
  const stats = graphStore.getStats();
  console.log("\nFinal graph stats:");
  console.log(`  Total nodes: ${stats.totalNodes}`);
  console.log(`  Total edges: ${stats.totalEdges}`);
  console.log(`  Nodes by type: ${JSON.stringify(stats.nodesByType)}`);
  console.log(`  Edges by type: ${JSON.stringify(stats.edgesByType)}`);

  graphStore.close();
}

main().catch(console.error);
