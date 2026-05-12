/**
 * Memory Integration
 *
 * Auto-extracts entities and relationships from memory content
 * and links them to my knowledge graph.
 */

import type { GraphStore } from "./store.ts";
import type { MemoryEntry } from "../types.ts";
import type { ExtractionType } from "./extraction-prompt.ts";
import { createLLMClient } from "../llm/mod.ts";
import { getEmbedder } from "../embeddings/mod.ts";
import {
  buildExtractionPrompt,
  confirmNode,
  findSemanticDuplicate,
  MIN_CONFIDENCE,
} from "./extraction-prompt.ts";

/**
 * Result of extracting entities from a memory into the graph.
 */
export interface ExtractionResult {
  nodesCreated: number;
  edgesCreated: number;
}

/**
 * Health diagnostics for the extraction pipeline.
 * Tracked at module level so it persists across all extraction calls.
 */
export interface ExtractionHealth {
  /** Whether an LLM client can be created (API key + model + base URL all present) */
  llmAvailable: boolean;
  /** ISO timestamp of the last extraction attempt */
  lastAttempt: string | null;
  /** ISO timestamp of the last successful extraction (at least 1 node or edge created) */
  lastSuccess: string | null;
  /** Error message from the most recent failure, or null */
  lastError: string | null;
  /** Total extraction attempts since server start */
  attemptsTotal: number;
  /** Total successful extractions since server start */
  successesTotal: number;
  /** Cumulative nodes created across all extractions */
  nodesCreatedTotal: number;
  /** Cumulative edges created across all extractions */
  edgesCreatedTotal: number;
}

/**
 * Module-level extraction health state.
 */
const extractionHealth: ExtractionHealth = {
  llmAvailable: false,
  lastAttempt: null,
  lastSuccess: null,
  lastError: null,
  attemptsTotal: 0,
  successesTotal: 0,
  nodesCreatedTotal: 0,
  edgesCreatedTotal: 0,
};

/**
 * Get the current extraction health snapshot.
 */
export function getExtractionHealth(): ExtractionHealth {
  return { ...extractionHealth };
}

/**
 * Extract entities and relationships from a memory and create graph nodes/edges.
 *
 * This is designed to be called in the background (fire-and-forget) after a
 * memory is written, so it never blocks the memory_create response.
 */
export async function extractMemoryToGraph(
  memory: MemoryEntry,
  graphStore: GraphStore,
  instanceId: string,
): Promise<ExtractionResult> {
  const empty: ExtractionResult = { nodesCreated: 0, edgesCreated: 0 };

  // Record attempt
  extractionHealth.lastAttempt = new Date().toISOString();
  extractionHealth.attemptsTotal++;
  extractionHealth.lastError = null;

  // Skip short/trivial content
  if (memory.content.trim().length < 100) {
    extractionHealth.lastError =
      `Content too short (${memory.content.trim().length} chars, minimum 100)`;
    return empty;
  }

  // Create LLM client — returns null if no API key configured
  const llm = createLLMClient();
  if (!llm) {
    extractionHealth.llmAvailable = false;
    extractionHealth.lastError =
      "No LLM client available (missing API key, base URL, or model)";
    return empty;
  }
  extractionHealth.llmAvailable = true;

  // Ensure graph store is initialized
  await graphStore.initialize();

  // Build extraction prompt from shared module
  const prompt = buildExtractionPrompt(memory.content, memory.date);

  let extraction: ExtractionType;

  try {
    extraction = await llm.completeJSON<ExtractionType>(prompt, {
      temperature: 0.3,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[Graph] LLM extraction failed for ${memory.id}:`, msg);
    extractionHealth.lastError = `LLM extraction failed: ${msg}`;
    return empty;
  }

  // Apply confidence floor — silently drop low-confidence extractions
  const entities = (extraction.entities || [])
    .filter((e) => e.confidence >= MIN_CONFIDENCE);
  const relationships = (extraction.relationships || [])
    .filter((r) => r.confidence >= MIN_CONFIDENCE);

  if (entities.length === 0 && relationships.length === 0) {
    extractionHealth.lastError =
      "All extracted entities/relationships below confidence threshold (0.5)";
    return empty;
  }

  // Resolve entities to existing node IDs via semantic dedup (async)
  // This must happen before the transaction since embedding is async
  const embedder = getEmbedder();
  const labelToId = new Map<string, string>();
  const newEntities: typeof entities = [];

  for (const entity of entities) {
    const labelLower = entity.label.toLowerCase();
    if (labelToId.has(labelLower)) continue;

    const existing = await findSemanticDuplicate(graphStore, embedder, {
      label: entity.label,
      type: entity.type,
    });

    if (existing) {
      labelToId.set(labelLower, existing.id);
      // Confirm-and-boost the existing node
      confirmNode(
        graphStore,
        existing.id,
        entity.confidence,
        existing.confidence,
        instanceId,
      );
    } else {
      newEntities.push(entity);
    }
  }

  // Use a transaction to atomically create new nodes and edges
  const result = graphStore.transaction(() => {
    let nodesCreated = 0;
    let edgesCreated = 0;

    // Create new entity nodes (ones not resolved by dedup)
    for (const entity of newEntities) {
      const labelLower = entity.label.toLowerCase();
      if (labelToId.has(labelLower)) continue;

      const node = graphStore.createNode({
        type: entity.type,
        label: entity.label,
        description: entity.description,
        sourceInstance: instanceId,
        confidence: entity.confidence,
        properties: {},
      });

      labelToId.set(labelLower, node.id);
      nodesCreated++;
    }

    // Create relationship edges
    for (const rel of relationships) {
      const fromId = labelToId.get(rel.fromLabel.toLowerCase());
      const toId = labelToId.get(rel.toLabel.toLowerCase());

      // Also check if the referenced nodes exist in the graph already
      const resolvedFrom = fromId ??
        graphStore.findNodeByLabel(rel.fromLabel)?.id;
      const resolvedTo = toId ?? graphStore.findNodeByLabel(rel.toLabel)?.id;

      if (!resolvedFrom || !resolvedTo) continue;

      try {
        graphStore.createEdge({
          fromId: resolvedFrom,
          toId: resolvedTo,
          type: rel.type,
          sourceInstance: instanceId,
          weight: rel.confidence,
          evidence: rel.evidence,
        });
        edgesCreated++;
      } catch {
        // Edge might already exist
      }
    }

    return { nodesCreated, edgesCreated };
  });

  // Update health stats with results
  if (result.nodesCreated > 0 || result.edgesCreated > 0) {
    extractionHealth.lastSuccess = extractionHealth.lastAttempt;
    extractionHealth.successesTotal++;
  } else {
    extractionHealth.lastError =
      "Transaction produced 0 nodes and 0 edges (all deduplicated)";
  }
  extractionHealth.nodesCreatedTotal += result.nodesCreated;
  extractionHealth.edgesCreatedTotal += result.edgesCreated;

  return result;
}

/**
 * Memory Integration handles connecting memories to the graph.
 *
 * The actual extraction of entities from memory content is designed
 * to be done by the entity itself (via LLM reasoning) using the
 * graph tools. This class provides helper methods for:
 * - Looking up existing nodes by label
 * - Creating or finding nodes by label
 */
export class MemoryIntegration {
  constructor(private store: GraphStore) {}

  /**
   * Find an existing node by label (case-insensitive).
   */
  findNodeByLabel(
    label: string,
    type?: string,
  ): { id: string; label: string } | null {
    const node = this.store.findNodeByLabel(label, type);
    return node ? { id: node.id, label: node.label } : null;
  }

  /**
   * Find or create a node by label.
   * If the node exists, returns it. Otherwise creates a new one.
   */
  findOrCreateNode(
    input: {
      type: string;
      label: string;
      description?: string;
      properties?: Record<string, unknown>;
      confidence?: number;
    },
    instanceId: string,
  ): { id: string; label: string; isNew: boolean } {
    // Try to find existing node
    const existing = this.findNodeByLabel(input.label, input.type);
    if (existing) {
      return { ...existing, isNew: false };
    }

    // Create new node
    const node = this.store.createNode({
      ...input,
      sourceInstance: instanceId,
    });

    return { id: node.id, label: node.label, isNew: true };
  }

  /**
   * Create an edge between two nodes, looking them up by label.
   * If either node doesn't exist, it will NOT be created automatically.
   */
  createEdgeByLabels(
    input: {
      fromLabel: string;
      toLabel: string;
      type: string;
      customType?: string;
      properties?: Record<string, unknown>;
      weight?: number;
      evidence?: string;
    },
    instanceId: string,
  ): { edgeId: string } | null {
    const fromNode = this.findNodeByLabel(input.fromLabel);
    const toNode = this.findNodeByLabel(input.toLabel);

    if (!fromNode || !toNode) {
      return null;
    }

    try {
      const edge = this.store.createEdge({
        fromId: fromNode.id,
        toId: toNode.id,
        type: input.type,
        properties: input.properties,
        weight: input.weight,
        evidence: input.evidence,
        sourceInstance: instanceId,
      });

      return { edgeId: edge.id };
    } catch {
      return null;
    }
  }
}

/**
 * Create a memory integration instance.
 */
export function createMemoryIntegration(store: GraphStore): MemoryIntegration {
  return new MemoryIntegration(store);
}
