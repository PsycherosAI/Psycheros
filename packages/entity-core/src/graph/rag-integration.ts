/**
 * RAG Integration
 *
 * Combines vector search with graph traversal for hybrid retrieval.
 * Provides rich context for LLM queries by including related concepts.
 */

import type { GraphStore } from "./store.ts";
import type { GraphEdge, GraphNode, Subgraph } from "./types.ts";

/**
 * Options for graph-enhanced retrieval.
 */
export interface GraphRAGOptions {
  /** Maximum nodes to retrieve via vector search */
  maxVectorResults?: number;
  /** Maximum depth for graph traversal */
  traversalDepth?: number;
  /** Maximum related nodes to include */
  maxRelatedNodes?: number;
  /** Minimum similarity score for vector search */
  minScore?: number;
  /** Include evidence for relationships */
  includeEvidence?: boolean;
}

/**
 * Result of graph-enhanced retrieval.
 */
export interface GraphRAGResult {
  /** Primary nodes found via vector search */
  primaryNodes: Array<{
    node: GraphNode;
    score: number;
  }>;
  /** Related nodes found via graph traversal */
  relatedNodes: Array<{
    node: GraphNode;
    relationship: string;
    viaNode: string;
  }>;
  /** Relationships between found nodes */
  relationships: Array<{
    edge: GraphEdge;
    fromLabel: string;
    toLabel: string;
  }>;
  /** Formatted context string for LLM */
  contextString: string;
}

/**
 * Graph RAG provides hybrid retrieval combining vector search with graph traversal.
 */
export class GraphRAG {
  constructor(private store: GraphStore) {}

  /**
   * Perform graph-enhanced retrieval.
   * First finds nodes via vector search, then expands via graph traversal.
   */
  retrieve(
    queryEmbedding: number[],
    options: GraphRAGOptions = {},
  ): GraphRAGResult {
    const {
      maxVectorResults = 5,
      traversalDepth = 2,
      maxRelatedNodes = 10,
      minScore = 0.3,
    } = options;

    // Step 1: Vector search for primary nodes
    const searchResults = this.store.searchNodes({
      queryEmbedding,
      minScore,
      limit: maxVectorResults,
    });

    const primaryNodes = searchResults.map((r) => ({
      node: r.node,
      score: r.score,
    }));

    // Step 2: Expand via graph traversal
    const relatedNodes: GraphRAGResult["relatedNodes"] = [];
    const visitedIds = new Set(primaryNodes.map((p) => p.node.id));
    const relationshipEdges: GraphEdge[] = [];

    for (const primary of primaryNodes) {
      const subgraph = this.store.getSubgraph(primary.node.id, traversalDepth);

      // Collect relationships involving primary node
      for (const edge of subgraph.edges) {
        if (
          edge.fromId === primary.node.id ||
          edge.toId === primary.node.id
        ) {
          relationshipEdges.push(edge);
        }
      }

      // Collect related nodes
      for (const node of subgraph.nodes) {
        if (visitedIds.has(node.id)) continue;
        if (relatedNodes.length >= maxRelatedNodes) break;

        // Find the relationship connecting this node
        const connectingEdge = subgraph.edges.find(
          (e) =>
            (e.fromId === primary.node.id && e.toId === node.id) ||
            (e.toId === primary.node.id && e.fromId === node.id),
        );

        if (connectingEdge) {
          relatedNodes.push({
            node,
            relationship: connectingEdge.type,
            viaNode: primary.node.label,
          });
          visitedIds.add(node.id);
        }
      }
    }

    // Step 3: Build relationships array
    const relationships = relationshipEdges.map((edge) => {
      const fromNode = this.store.getNode(edge.fromId);
      const toNode = this.store.getNode(edge.toId);
      return {
        edge,
        fromLabel: fromNode?.label ?? edge.fromId,
        toLabel: toNode?.label ?? edge.toId,
      };
    });

    // Step 4: Build context string
    const contextString = this.buildContextString(
      primaryNodes,
      relatedNodes,
      relationships,
      options.includeEvidence ?? false,
    );

    return {
      primaryNodes,
      relatedNodes,
      relationships,
      contextString,
    };
  }

  /**
   * Retrieve context for a specific node and its neighborhood.
   */
  retrieveNodeContext(
    nodeId: string,
    depth: number = 2,
  ): { subgraph: Subgraph; contextString: string } {
    const subgraph = this.store.getSubgraph(nodeId, depth);
    const contextString = this.buildSubgraphContextString(subgraph);
    return { subgraph, contextString };
  }

  /**
   * Build a formatted context string for LLM consumption.
   * Uses compact one-line-per-relationship format.
   */
  private buildContextString(
    _primaryNodes: Array<{ node: GraphNode; score: number }>,
    _relatedNodes: Array<{
      node: GraphNode;
      relationship: string;
      viaNode: string;
    }>,
    relationships: Array<{
      edge: GraphEdge;
      fromLabel: string;
      toLabel: string;
    }>,
    _includeEvidence: boolean,
  ): string {
    if (relationships.length === 0) return "";

    // Collect all node IDs referenced in relationships for standalone entity formatting
    const nodeIds = new Set<string>();
    for (const { edge } of relationships) {
      nodeIds.add(edge.fromId);
      nodeIds.add(edge.toId);
    }

    // Collect all nodes we know about (primary + related) for standalone formatting
    const knownNodes = new Map<string, GraphNode>();
    for (const { node } of _primaryNodes) {
      knownNodes.set(node.id, node);
    }
    for (const { node } of _relatedNodes) {
      knownNodes.set(node.id, node);
    }

    const lines: string[] = [];

    // Format relationships as compact one-liners
    for (const { edge, fromLabel, toLabel } of relationships) {
      const relType = edge.type;
      const parts = [`${fromLabel} ${relType} ${toLabel}`];

      // Add parenthetical context from edge evidence or node descriptions
      if (edge.evidence) {
        parts.push(`(${edge.evidence})`);
      } else {
        // Try to get context from the target node's description
        const targetNode = knownNodes.get(edge.toId);
        if (targetNode?.description) {
          parts.push(`(${targetNode.description})`);
        }
      }

      lines.push(parts.join(" "));
    }

    // Add standalone entity nodes (those without relationships in this context)
    for (const { node } of _primaryNodes) {
      if (!nodeIds.has(node.id)) {
        const desc = node.description ? `: ${node.description}` : "";
        lines.push(`${node.label} (type: ${node.type}${desc})`);
      }
    }
    for (const { node } of _relatedNodes) {
      if (!nodeIds.has(node.id) && !knownNodes.has(node.id)) {
        const desc = node.description ? `: ${node.description}` : "";
        lines.push(`${node.label} (type: ${node.type}${desc})`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Build a context string for a subgraph.
   * Uses compact one-line-per-relationship format.
   */
  private buildSubgraphContextString(subgraph: Subgraph): string {
    if (subgraph.nodes.length === 0) return "";

    const nodeLabels = new Map<string, string>();
    const nodeDescriptions = new Map<string, string>();
    for (const node of subgraph.nodes) {
      nodeLabels.set(node.id, node.label);
      nodeDescriptions.set(node.id, node.description);
    }

    const lines: string[] = [];
    const edgeNodeIds = new Set<string>();

    // Format edges as compact one-liners
    for (const edge of subgraph.edges) {
      const fromLabel = nodeLabels.get(edge.fromId) || edge.fromId;
      const toLabel = nodeLabels.get(edge.toId) || edge.toId;
      const relType = edge.type;
      const parts = [`${fromLabel} ${relType} ${toLabel}`];

      if (edge.evidence) {
        parts.push(`(${edge.evidence})`);
      } else {
        const targetDesc = nodeDescriptions.get(edge.toId);
        if (targetDesc) {
          parts.push(`(${targetDesc})`);
        }
      }

      edgeNodeIds.add(edge.fromId);
      edgeNodeIds.add(edge.toId);
      lines.push(parts.join(" "));
    }

    // Add standalone nodes (no edges)
    for (const node of subgraph.nodes) {
      if (!edgeNodeIds.has(node.id)) {
        const desc = node.description ? `: ${node.description}` : "";
        lines.push(`${node.label} (type: ${node.type}${desc})`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Find paths between two nodes.
   * Returns all paths up to a maximum length.
   */
  findPaths(
    fromNodeId: string,
    toNodeId: string,
    maxDepth: number = 4,
  ): Array<Array<{ node: GraphNode; edge?: GraphEdge }>> {
    const paths: Array<Array<{ node: GraphNode; edge?: GraphEdge }>> = [];
    const startNode = this.store.getNode(fromNodeId);
    const endNode = this.store.getNode(toNodeId);

    if (!startNode || !endNode) return paths;

    const visited = new Set<string>();
    const queue: Array<{
      nodeId: string;
      path: Array<{ node: GraphNode; edge?: GraphEdge }>;
    }> = [
      {
        nodeId: fromNodeId,
        path: [{ node: startNode }],
      },
    ];

    while (queue.length > 0 && paths.length < 10) {
      const current = queue.shift()!;
      const currentPath = current.path;

      if (current.nodeId === toNodeId && currentPath.length > 1) {
        paths.push(currentPath);
        continue;
      }

      if (currentPath.length > maxDepth) continue;

      visited.add(current.nodeId);

      // Get outgoing edges
      const outEdges = this.store.getEdges({
        fromId: current.nodeId,
        onlyValid: true,
      });
      // Get incoming edges
      const inEdges = this.store.getEdges({
        toId: current.nodeId,
        onlyValid: true,
      });

      for (const edge of [...outEdges, ...inEdges]) {
        const nextNodeId = edge.fromId === current.nodeId
          ? edge.toId
          : edge.fromId;
        if (visited.has(nextNodeId)) continue;

        const nextNode = this.store.getNode(nextNodeId);
        if (!nextNode) continue;

        queue.push({
          nodeId: nextNodeId,
          path: [...currentPath, { node: nextNode, edge }],
        });
      }
    }

    return paths;
  }

  /**
   * Get the "neighborhood" context for a query.
   * Returns nodes that are semantically similar and their immediate neighbors.
   */
  getNeighborhood(
    queryEmbedding: number[],
    options: GraphRAGOptions = {},
  ): {
    nodes: GraphNode[];
    edges: GraphEdge[];
    contextString: string;
  } {
    const result = this.retrieve(queryEmbedding, {
      ...options,
      traversalDepth: 1,
    });

    const nodeIds = new Set<string>();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    // Collect all nodes
    for (const { node } of result.primaryNodes) {
      if (!nodeIds.has(node.id)) {
        nodeIds.add(node.id);
        nodes.push(node);
      }
    }
    for (const { node } of result.relatedNodes) {
      if (!nodeIds.has(node.id)) {
        nodeIds.add(node.id);
        nodes.push(node);
      }
    }

    // Collect edges between these nodes
    for (const nodeId of nodeIds) {
      const outEdges = this.store.getEdges({
        fromId: nodeId,
        onlyValid: true,
      });
      for (const edge of outEdges) {
        if (nodeIds.has(edge.toId)) {
          edges.push(edge);
        }
      }
    }

    return {
      nodes,
      edges,
      contextString: result.contextString,
    };
  }
}

/**
 * Create a Graph RAG instance.
 */
export function createGraphRAG(store: GraphStore): GraphRAG {
  return new GraphRAG(store);
}
