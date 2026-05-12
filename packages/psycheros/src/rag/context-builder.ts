/**
 * Context Builder
 *
 * Formats retrieved memories and graph context for injection into the LLM context.
 */

import type { RetrievalResult } from "./types.ts";
import type { MCPClient } from "../mcp-client/mod.ts";

/**
 * Format retrieved memory chunks into a context section.
 *
 * @param results - The retrieval results to format
 * @returns Formatted string for inclusion in system message
 */
export function formatMemories(results: RetrievalResult[]): string {
  if (results.length === 0) {
    return "";
  }

  const sections = results.map((result, index) => {
    const score = (result.score * 100).toFixed(0);
    const source = result.chunk.sourceFile;
    return `[${
      index + 1
    }] (from ${source}, ${score}% relevant)\n${result.chunk.content}`;
  });

  return `

---
Relevant Memories via RAG:

${sections.join("\n\n")}`;
}

/**
 * Build a RAG context section from retrieved results.
 * Returns empty string if no results.
 *
 * @param results - The retrieval results
 * @returns Formatted context string or empty string
 */
export function buildRAGContext(results: RetrievalResult[]): string {
  return formatMemories(results);
}

/**
 * Options for building graph context.
 */
export interface BuildGraphContextOptions {
  /** Maximum nodes to include */
  maxNodes?: number;
  /** Minimum similarity score for node search (0-1) */
  minScore?: number;
  /** Include connected nodes via traversal */
  includeRelated?: boolean;
  /** Maximum traversal depth when including related nodes */
  traversalDepth?: number;
  /** Maximum related nodes to keep per primary node */
  maxRelatedPerNode?: number;
  /** Minimum similarity score for related nodes (0-1) */
  relatedMinScore?: number;
}

/**
 * Result of building graph context.
 */
export interface GraphContextResult {
  /** Formatted context string */
  context: string;
  /** Number of nodes included */
  nodeCount: number;
  /** Number of edges/relationships included */
  edgeCount: number;
}

/**
 * Compute cosine similarity between two L2-normalized vectors.
 * Since both vectors are already normalized, this is just the dot product.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Build a knowledge graph context section from a query.
 * Searches for relevant nodes and optionally traverses to find connected concepts.
 *
 * Related nodes are scored against the original query using local embeddings.
 * Only related nodes above `relatedMinScore` are included, up to `maxRelatedPerNode`
 * per primary node. This prevents irrelevant neighbors from flooding the context.
 *
 * Falls back to including all related nodes (current behavior) if the local
 * embedder is unavailable.
 *
 * @param query - The search query
 * @param mcpClient - The MCP client for entity-core connection
 * @param options - Build options
 * @returns Formatted graph context or empty result if no matches
 */
export async function buildGraphContext(
  query: string,
  mcpClient: MCPClient,
  options: BuildGraphContextOptions = {},
): Promise<GraphContextResult> {
  const {
    maxNodes = 10,
    minScore = 0.3,
    includeRelated = true,
    traversalDepth = 1,
    maxRelatedPerNode = 5,
    relatedMinScore = 0.2,
  } = options;

  const emptyResult = { context: "", nodeCount: 0, edgeCount: 0 };

  try {
    // Search for nodes matching the query
    const searchResults = await mcpClient.searchGraphNodes(
      query,
      undefined, // no type filter
      maxNodes,
      minScore,
    );

    if (searchResults.length === 0) {
      return emptyResult;
    }

    // Collect all nodes and edges
    const nodesById = new Map<string, typeof searchResults[0]>();
    const allEdges: Array<{
      id: string;
      fromId: string;
      toId: string;
      type: string;
      customType?: string;
      weight: number;
    }> = [];

    // Add search results to nodes
    for (const node of searchResults) {
      nodesById.set(node.id, node);
    }

    // Optionally traverse to find related nodes
    if (includeRelated) {
      // Try to load the local embedder for relevance scoring.
      // If unavailable, fall back to including all related nodes.
      let queryEmbedding: number[] | null = null;
      let embedderAvailable = false;
      try {
        const { getEmbedder } = await import("./embedder.ts");
        const embedder = getEmbedder();
        if (embedder.isReady() || query.trim()) {
          queryEmbedding = await embedder.embed(query);
          embedderAvailable = true;
        }
      } catch {
        // Embedder not available — fall back to unfiltered traversal
      }

      // Relevance scoring only applies at depth > 1 (deeper hops).
      // First-hop neighbors are always included because they provide
      // essential relationship context for the primary nodes.
      const scoreRelated = traversalDepth > 1 && embedderAvailable &&
        !!queryEmbedding;

      for (const node of searchResults.slice(0, 3)) { // Limit traversal to top 3
        const subgraph = await mcpClient.getGraphSubgraph(
          node.id,
          traversalDepth,
        );

        if (scoreRelated) {
          // Score each related node against the query
          const scored: Array<
            {
              id: string;
              label: string;
              type: string;
              description: string;
              score: number;
            }
          > = [];
          for (const relatedNode of subgraph.nodes) {
            if (nodesById.has(relatedNode.id)) continue;
            const text = `${relatedNode.label} ${relatedNode.description || ""}`
              .trim();
            if (!text) continue;
            try {
              const { getEmbedder } = await import("./embedder.ts");
              const nodeEmbedding = await getEmbedder().embed(text);
              const score = cosineSimilarity(queryEmbedding!, nodeEmbedding);
              scored.push({
                id: relatedNode.id,
                label: relatedNode.label,
                type: relatedNode.type,
                description: relatedNode.description || "",
                score,
              });
            } catch {
              // Skip nodes that fail to embed
            }
          }

          // Keep only relevant nodes, sorted by score
          scored.sort((a, b) => b.score - a.score);
          const included = scored
            .filter((s) => s.score >= relatedMinScore)
            .slice(0, maxRelatedPerNode);

          for (const entry of included) {
            nodesById.set(entry.id, {
              id: entry.id,
              type: entry.type,
              label: entry.label,
              description: entry.description,
              confidence: 0.5,
              createdAt: "",
              updatedAt: "",
              score: entry.score,
            });
          }

          // Only add edges where both endpoints are included
          for (const edge of subgraph.edges) {
            if (nodesById.has(edge.fromId) && nodesById.has(edge.toId)) {
              if (!allEdges.find((e) => e.id === edge.id)) {
                allEdges.push(edge);
              }
            }
          }
        } else {
          // Unfiltered traversal (depth 1 or no embedder): include all related nodes
          for (const relatedNode of subgraph.nodes) {
            if (!nodesById.has(relatedNode.id)) {
              nodesById.set(relatedNode.id, {
                id: relatedNode.id,
                type: relatedNode.type,
                label: relatedNode.label,
                description: relatedNode.description || "",
                confidence: 0.5,
                createdAt: "",
                updatedAt: "",
                score: 0,
              });
            }
          }

          for (const edge of subgraph.edges) {
            if (!allEdges.find((e) => e.id === edge.id)) {
              allEdges.push(edge);
            }
          }
        }
      }
    }

    // Include connected nodes referenced by edges but not yet in results
    for (const edge of allEdges) {
      for (const refId of [edge.fromId, edge.toId]) {
        if (!nodesById.has(refId)) {
          try {
            const node = await mcpClient.getGraphNode(refId);
            if (node) {
              nodesById.set(node.id, {
                id: node.id,
                type: node.type,
                label: node.label,
                description: node.description || "",
                confidence: node.confidence,
                createdAt: "",
                updatedAt: "",
                score: 0,
              });
            }
          } catch {
            // Skip if lookup fails
          }
        }
      }
    }

    // Format the context
    const nodesArray = Array.from(nodesById.values());
    const context = formatGraphContext(nodesArray, allEdges);

    return {
      context,
      nodeCount: nodesArray.length,
      edgeCount: allEdges.length,
    };
  } catch (error) {
    console.error("[RAG] Failed to build graph context:", error);
    return emptyResult;
  }
}

/**
 * Format graph nodes and edges into a context section.
 * Uses compact one-line-per-relationship format.
 */
function formatGraphContext(
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    description: string;
    confidence: number;
    score: number;
  }>,
  edges: Array<{
    fromId: string;
    toId: string;
    type: string;
    customType?: string;
    weight: number;
  }>,
): string {
  if (nodes.length === 0) {
    return "";
  }

  // Build maps for quick lookup
  const nodeLabels = new Map<string, string>();
  const nodeDescriptions = new Map<string, string>();
  for (const node of nodes) {
    nodeLabels.set(node.id, node.label);
    nodeDescriptions.set(node.id, node.description);
  }

  const lines: string[] = [];
  const edgeNodeIds = new Set<string>();

  // Format edges as compact one-liners
  for (const edge of edges) {
    const fromLabel = nodeLabels.get(edge.fromId) || "Unknown";
    const toLabel = nodeLabels.get(edge.toId) || "Unknown";
    const relType = edge.customType || edge.type;
    const parts = [`${fromLabel} ${relType} ${toLabel}`];

    // Add parenthetical context from target node description
    const targetDesc = nodeDescriptions.get(edge.toId);
    if (targetDesc) {
      parts.push(`(${targetDesc})`);
    }

    edgeNodeIds.add(edge.fromId);
    edgeNodeIds.add(edge.toId);
    lines.push(parts.join(" "));
  }

  // Add standalone nodes (no edges in this context)
  for (const node of nodes) {
    if (!edgeNodeIds.has(node.id)) {
      const desc = node.description ? `: ${node.description}` : "";
      lines.push(`${node.label} (type: ${node.type}${desc})`);
    }
  }

  return `

---
Relevant Knowledge from Graph:
${lines.join("\n")}`;
}
