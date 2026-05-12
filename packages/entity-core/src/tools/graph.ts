/**
 * Graph Tools
 *
 * MCP tools for managing my knowledge graph.
 */

import { z } from "zod";
import type { GraphStore } from "../graph/store.ts";

// ========================================
// SCHEMAS
// ========================================

// Node schemas
export const GraphNodeCreateSchema = z.object({
  type: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  properties: z.record(z.unknown()).optional(),
  instanceId: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
  sourceMemoryId: z.string().optional(),
  firstLearnedAt: z.string().optional(),
  embedding: z.array(z.number()).optional(),
});

export const GraphNodeGetSchema = z.object({
  id: z.string().min(1),
});

export const GraphNodeUpdateSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  description: z.string().optional(),
  properties: z.record(z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  lastConfirmedAt: z.string().optional(),
  instanceId: z.string().min(1),
  embedding: z.array(z.number()).optional(),
});

export const GraphNodeDeleteSchema = z.object({
  id: z.string().min(1),
  permanent: z.boolean().optional(),
});

export const GraphNodeSearchSchema = z.object({
  query: z.string().min(1).optional(),
  queryEmbedding: z.array(z.number()).optional(),
  type: z.string().optional(),
  minScore: z.number().min(0).max(1).optional(),
  limit: z.number().min(1).max(100).optional(),
});

export const GraphNodeListSchema = z.object({
  type: z.string().optional(),
  includeDeleted: z.boolean().optional(),
  limit: z.number().min(1).max(500).optional(),
  offset: z.number().min(0).optional(),
});

// Edge schemas
export const GraphEdgeCreateSchema = z.object({
  fromId: z.string().min(1),
  toId: z.string().min(1),
  type: z.string().min(1),
  properties: z.record(z.unknown()).optional(),
  weight: z.number().min(0).max(1).optional(),
  evidence: z.string().optional(),
  occurredAt: z.string().optional(),
  validUntil: z.string().optional(),
  instanceId: z.string().min(1),
});

export const GraphEdgeGetSchema = z.object({
  id: z.string().min(1).optional(),
  fromId: z.string().min(1).optional(),
  toId: z.string().min(1).optional(),
  type: z.string().optional(),
  includeDeleted: z.boolean().optional(),
  onlyValid: z.boolean().optional(),
});

export const GraphEdgeUpdateSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1).optional(),
  properties: z.record(z.unknown()).optional(),
  weight: z.number().min(0).max(1).optional(),
  evidence: z.string().optional(),
  validUntil: z.string().optional(),
  lastConfirmedAt: z.string().optional(),
  instanceId: z.string().min(1),
});

export const GraphEdgeDeleteSchema = z.object({
  id: z.string().min(1),
});

// Traversal schemas
export const GraphTraverseSchema = z.object({
  startNodeId: z.string().min(1),
  direction: z.enum(["out", "in", "both"]).optional(),
  maxDepth: z.number().min(1).max(5).optional(),
  edgeTypes: z.array(z.string()).optional(),
  limit: z.number().min(1).max(200).optional(),
});

export const GraphSubgraphSchema = z.object({
  nodeId: z.string().min(1),
  depth: z.number().min(1).max(3).optional(),
});

// Insights schemas
export const GraphInsightsSchema = z.object({});

export const GraphStatsSchema = z.object({});

// Transaction schemas
export const GraphWriteTransactionSchema = z.object({
  nodes: z.array(z.object({
    type: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    properties: z.record(z.unknown()).optional(),
    confidence: z.number().min(0).max(1).optional(),
    sourceMemoryId: z.string().optional(),
    firstLearnedAt: z.string().optional(),
    embedding: z.array(z.number()).optional(),
  })).optional(),
  edges: z.array(z.object({
    fromLabel: z.string().min(1),
    toLabel: z.string().min(1),
    type: z.string().min(1),
    properties: z.record(z.unknown()).optional(),
    weight: z.number().min(0).max(1).optional(),
    evidence: z.string().optional(),
    occurredAt: z.string().optional(),
    validUntil: z.string().optional(),
  })).optional(),
  instanceId: z.string().min(1),
});

// ========================================
// OUTPUT TYPES
// ========================================

export interface GraphNodeCreateOutput {
  success: boolean;
  message: string;
  node?: {
    id: string;
    type: string;
    label: string;
    description: string;
    properties: Record<string, unknown>;
    confidence: number;
    createdAt: string;
  };
}

export interface GraphNodeGetOutput {
  success: boolean;
  node?: {
    id: string;
    type: string;
    label: string;
    description: string;
    properties: Record<string, unknown>;
    sourceInstance: string;
    confidence: number;
    sourceMemoryId?: string;
    createdAt: string;
    updatedAt: string;
    firstLearnedAt?: string;
    lastConfirmedAt?: string;
    version: number;
  };
}

export interface GraphNodeUpdateOutput {
  success: boolean;
  message: string;
  node?: {
    id: string;
    type: string;
    label: string;
    description: string;
    properties: Record<string, unknown>;
    confidence: number;
    updatedAt: string;
    version: number;
  };
}

export interface GraphNodeDeleteOutput {
  success: boolean;
  message: string;
}

export interface GraphNodeSearchOutput {
  results: Array<{
    node: {
      id: string;
      type: string;
      label: string;
      description: string;
      confidence: number;
    };
    score: number;
  }>;
  vectorSearchUsed: boolean;
}

export interface GraphNodeListOutput {
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    description: string;
    confidence: number;
    createdAt: string;
    updatedAt: string;
  }>;
  total: number;
}

export interface GraphEdgeCreateOutput {
  success: boolean;
  message: string;
  edge?: {
    id: string;
    fromId: string;
    toId: string;
    type: string;
    weight: number;
    createdAt: string;
  };
}

export interface GraphEdgeGetOutput {
  edges: Array<{
    id: string;
    fromId: string;
    toId: string;
    type: string;
    weight: number;
    evidence?: string;
    occurredAt?: string;
    validUntil?: string;
    createdAt: string;
    updatedAt: string;
  }>;
}

export interface GraphEdgeUpdateOutput {
  success: boolean;
  message: string;
  edge?: {
    id: string;
    fromId: string;
    toId: string;
    type: string;
    weight: number;
    updatedAt: string;
    version: number;
  };
}

export interface GraphEdgeDeleteOutput {
  success: boolean;
  message: string;
}

export interface GraphTraverseOutput {
  startNode: {
    id: string;
    type: string;
    label: string;
  };
  results: Array<{
    node: {
      id: string;
      type: string;
      label: string;
      description: string;
    };
    path: string[];
    depth: number;
  }>;
}

export interface GraphSubgraphOutput {
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    description: string;
    confidence: number;
  }>;
  edges: Array<{
    id: string;
    fromId: string;
    toId: string;
    type: string;
    weight: number;
  }>;
}

export interface GraphInsightsOutput {
  insights: Array<{
    type: string;
    description: string;
    nodeIds: string[];
    edgeIds: string[];
    confidence: number;
  }>;
}

export interface GraphStatsOutput {
  totalNodes: number;
  totalEdges: number;
  nodesByType: Record<string, number>;
  edgesByType: Record<string, number>;
  oldestNode?: string;
  newestNode?: string;
  vectorSearchAvailable: boolean;
}

export interface GraphWriteTransactionOutput {
  success: boolean;
  message: string;
  nodesCreated: number;
  edgesCreated: number;
  nodes?: Array<{
    id: string;
    type: string;
    label: string;
  }>;
  edges?: Array<{
    id: string;
    type: string;
    fromLabel: string;
    toLabel: string;
  }>;
}

// ========================================
// HANDLERS
// ========================================

/**
 * Create the graph_node_create tool handler.
 */
export function createGraphNodeCreateHandler(store: GraphStore) {
  return (
    input: z.infer<typeof GraphNodeCreateSchema>,
  ): GraphNodeCreateOutput => {
    try {
      // Duplicate prevention: check for existing node with same label+type
      const existing = store.findNodeByLabel(input.label, input.type);
      if (existing) {
        return {
          success: true,
          message:
            `A "${existing.label}" (${existing.type}) node already exists`,
          node: {
            id: existing.id,
            type: existing.type,
            label: existing.label,
            description: existing.description,
            properties: existing.properties,
            confidence: existing.confidence,
            createdAt: existing.createdAt,
          },
        };
      }

      const node = store.createNode({
        type: input.type,
        label: input.label,
        description: input.description,
        properties: input.properties,
        sourceInstance: input.instanceId,
        confidence: input.confidence,
        sourceMemoryId: input.sourceMemoryId,
        firstLearnedAt: input.firstLearnedAt,
      });

      // Store embedding if provided
      if (input.embedding) {
        store.updateNodeEmbedding(node.id, input.embedding);
      }

      return {
        success: true,
        message: `I have created a new ${node.type} node: "${node.label}"`,
        node: {
          id: node.id,
          type: node.type,
          label: node.label,
          description: node.description,
          properties: node.properties,
          confidence: node.confidence,
          createdAt: node.createdAt,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to create node: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  };
}

/**
 * Create the graph_node_get tool handler.
 */
export function createGraphNodeGetHandler(
  store: GraphStore,
): (input: z.infer<typeof GraphNodeGetSchema>) => GraphNodeGetOutput {
  return (input: z.infer<typeof GraphNodeGetSchema>): GraphNodeGetOutput => {
    const node = store.getNode(input.id);
    if (!node) {
      return ({ success: false });
    }
    return ({
      success: true,
      node: {
        id: node.id,
        type: node.type,
        label: node.label,
        description: node.description,
        properties: node.properties,
        sourceInstance: node.sourceInstance,
        confidence: node.confidence,
        sourceMemoryId: node.sourceMemoryId,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        firstLearnedAt: node.firstLearnedAt,
        lastConfirmedAt: node.lastConfirmedAt,
        version: node.version,
      },
    });
  };
}

/**
 * Create the graph_node_update tool handler.
 */
export function createGraphNodeUpdateHandler(store: GraphStore) {
  return (
    input: z.infer<typeof GraphNodeUpdateSchema>,
  ): GraphNodeUpdateOutput => {
    try {
      const node = store.updateNode(input.id, {
        type: input.type,
        label: input.label,
        description: input.description,
        properties: input.properties,
        confidence: input.confidence,
        lastConfirmedAt: input.lastConfirmedAt,
        sourceInstance: input.instanceId,
      });

      if (!node) {
        return {
          success: false,
          message: `Node not found: ${input.id}`,
        };
      }

      // Update embedding if provided
      if (input.embedding) {
        store.updateNodeEmbedding(node.id, input.embedding);
      }

      return {
        success: true,
        message: `I have updated the node "${node.label}"`,
        node: {
          id: node.id,
          type: node.type,
          label: node.label,
          description: node.description,
          properties: node.properties,
          confidence: node.confidence,
          updatedAt: node.updatedAt,
          version: node.version,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to update node: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  };
}

/**
 * Create the graph_node_delete tool handler.
 */
export function createGraphNodeDeleteHandler(
  store: GraphStore,
): (input: z.infer<typeof GraphNodeDeleteSchema>) => GraphNodeDeleteOutput {
  return (
    input: z.infer<typeof GraphNodeDeleteSchema>,
  ): GraphNodeDeleteOutput => {
    const node = store.getNode(input.id);
    if (!node) {
      return ({
        success: false,
        message: `Node not found: ${input.id}`,
      });
    }

    const deleted = input.permanent
      ? store.permanentlyDeleteNode(input.id)
      : store.deleteNode(input.id);

    return ({
      success: deleted,
      message: deleted
        ? `I have ${
          input.permanent ? "permanently " : ""
        }deleted the node "${node.label}"`
        : `Failed to delete node: ${input.id}`,
    });
  };
}

/**
 * Create the graph_node_search tool handler.
 */
export function createGraphNodeSearchHandler(store: GraphStore) {
  return (
    input: z.infer<typeof GraphNodeSearchSchema>,
  ): GraphNodeSearchOutput => {
    const results = store.searchNodes({
      query: input.query,
      queryEmbedding: input.queryEmbedding,
      type: input.type,
      minScore: input.minScore,
      limit: input.limit,
    });

    return {
      results: results.map((r) => ({
        node: {
          id: r.node.id,
          type: r.node.type,
          label: r.node.label,
          description: r.node.description,
          confidence: r.node.confidence,
        },
        score: r.score,
      })),
      vectorSearchUsed: store.isVectorSearchAvailable() &&
        !!input.queryEmbedding,
    };
  };
}

/**
 * Create the graph_node_list tool handler.
 */
export function createGraphNodeListHandler(
  store: GraphStore,
): (input: z.infer<typeof GraphNodeListSchema>) => GraphNodeListOutput {
  return (input: z.infer<typeof GraphNodeListSchema>): GraphNodeListOutput => {
    const nodes = store.listNodes({
      type: input.type,
      includeDeleted: input.includeDeleted,
      limit: input.limit,
      offset: input.offset,
    });

    // Get total count
    const stats = store.getStats();
    const total = input.type
      ? (stats.nodesByType[input.type] ?? 0)
      : stats.totalNodes;

    return ({
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.type,
        label: n.label,
        description: n.description,
        confidence: n.confidence,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
      })),
      total,
    });
  };
}

/**
 * Create the graph_edge_create tool handler.
 */
export function createGraphEdgeCreateHandler(
  store: GraphStore,
): (input: z.infer<typeof GraphEdgeCreateSchema>) => GraphEdgeCreateOutput {
  return (
    input: z.infer<typeof GraphEdgeCreateSchema>,
  ): GraphEdgeCreateOutput => {
    try {
      const edge = store.createEdge({
        fromId: input.fromId,
        toId: input.toId,
        type: input.type,
        properties: input.properties,
        weight: input.weight,
        evidence: input.evidence,
        occurredAt: input.occurredAt,
        validUntil: input.validUntil,
        sourceInstance: input.instanceId,
      });

      const fromNode = store.getNode(input.fromId);
      const toNode = store.getNode(input.toId);

      return {
        success: true,
        message: `I have created a "${edge.type}" relationship from "${
          fromNode?.label ?? input.fromId
        }" to "${toNode?.label ?? input.toId}"`,
        edge: {
          id: edge.id,
          fromId: edge.fromId,
          toId: edge.toId,
          type: edge.type,
          weight: edge.weight,
          createdAt: edge.createdAt,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to create edge: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  };
}

/**
 * Create the graph_edge_get tool handler.
 */
export function createGraphEdgeGetHandler(
  store: GraphStore,
): (input: z.infer<typeof GraphEdgeGetSchema>) => GraphEdgeGetOutput {
  return (input: z.infer<typeof GraphEdgeGetSchema>): GraphEdgeGetOutput => {
    if (input.id) {
      const edge = store.getEdge(input.id);
      if (!edge) {
        return ({ edges: [] });
      }
      return ({
        edges: [{
          id: edge.id,
          fromId: edge.fromId,
          toId: edge.toId,
          type: edge.type,
          weight: edge.weight,
          evidence: edge.evidence,
          occurredAt: edge.occurredAt,
          validUntil: edge.validUntil,
          createdAt: edge.createdAt,
          updatedAt: edge.updatedAt,
        }],
      });
    }

    const edges = store.getEdges({
      fromId: input.fromId,
      toId: input.toId,
      type: input.type,
      includeDeleted: input.includeDeleted,
      onlyValid: input.onlyValid,
    });

    return ({
      edges: edges.map((e) => ({
        id: e.id,
        fromId: e.fromId,
        toId: e.toId,
        type: e.type,
        weight: e.weight,
        evidence: e.evidence,
        occurredAt: e.occurredAt,
        validUntil: e.validUntil,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })),
    });
  };
}

/**
 * Create the graph_edge_update tool handler.
 */
export function createGraphEdgeUpdateHandler(
  store: GraphStore,
): (input: z.infer<typeof GraphEdgeUpdateSchema>) => GraphEdgeUpdateOutput {
  return (
    input: z.infer<typeof GraphEdgeUpdateSchema>,
  ): GraphEdgeUpdateOutput => {
    try {
      const edge = store.updateEdge(input.id, {
        type: input.type,
        properties: input.properties,
        weight: input.weight,
        evidence: input.evidence,
        validUntil: input.validUntil,
        lastConfirmedAt: input.lastConfirmedAt,
        sourceInstance: input.instanceId,
      });

      if (!edge) {
        return {
          success: false,
          message: `Edge not found: ${input.id}`,
        };
      }

      return {
        success: true,
        message: `I have updated the "${edge.type}" relationship`,
        edge: {
          id: edge.id,
          fromId: edge.fromId,
          toId: edge.toId,
          type: edge.type,
          weight: edge.weight,
          updatedAt: edge.updatedAt,
          version: edge.version,
        },
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to update edge: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  };
}

/**
 * Create the graph_edge_delete tool handler.
 */
export function createGraphEdgeDeleteHandler(
  store: GraphStore,
): (input: z.infer<typeof GraphEdgeDeleteSchema>) => GraphEdgeDeleteOutput {
  return (
    input: z.infer<typeof GraphEdgeDeleteSchema>,
  ): GraphEdgeDeleteOutput => {
    const edge = store.getEdge(input.id);
    if (!edge) {
      return ({
        success: false,
        message: `Edge not found: ${input.id}`,
      });
    }

    const deleted = store.deleteEdge(input.id);
    return ({
      success: deleted,
      message: deleted
        ? `I have deleted the "${edge.type}" relationship`
        : `Failed to delete edge: ${input.id}`,
    });
  };
}

/**
 * Create the graph_traverse tool handler.
 */
export function createGraphTraverseHandler(
  store: GraphStore,
): (input: z.infer<typeof GraphTraverseSchema>) => GraphTraverseOutput {
  return (input: z.infer<typeof GraphTraverseSchema>): GraphTraverseOutput => {
    const startNode = store.getNode(input.startNodeId);
    if (!startNode) {
      return ({
        startNode: { id: input.startNodeId, type: "unknown", label: "Unknown" },
        results: [],
      });
    }

    const results = store.traverse({
      startNodeId: input.startNodeId,
      direction: input.direction,
      maxDepth: input.maxDepth,
      edgeTypes: input.edgeTypes,
      limit: input.limit,
    });

    return ({
      startNode: {
        id: startNode.id,
        type: startNode.type,
        label: startNode.label,
      },
      results: results.map((r) => ({
        node: {
          id: r.node.id,
          type: r.node.type,
          label: r.node.label,
          description: r.node.description,
        },
        path: r.path,
        depth: r.depth,
      })),
    });
  };
}

/**
 * Create the graph_subgraph tool handler.
 */
export function createGraphSubgraphHandler(
  store: GraphStore,
): (input: z.infer<typeof GraphSubgraphSchema>) => GraphSubgraphOutput {
  return (input: z.infer<typeof GraphSubgraphSchema>): GraphSubgraphOutput => {
    const subgraph = store.getSubgraph(input.nodeId, input.depth);

    return ({
      nodes: subgraph.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        label: n.label,
        description: n.description,
        confidence: n.confidence,
      })),
      edges: subgraph.edges.map((e) => ({
        id: e.id,
        fromId: e.fromId,
        toId: e.toId,
        type: e.type,
        weight: e.weight,
      })),
    });
  };
}

/**
 * Create the graph_insights tool handler.
 */
export function createGraphInsightsHandler(
  store: GraphStore,
): (_input: z.infer<typeof GraphInsightsSchema>) => GraphInsightsOutput {
  return (_input: z.infer<typeof GraphInsightsSchema>): GraphInsightsOutput => {
    const insights = store.discoverInsights();
    return ({
      insights: insights.map((i) => ({
        type: i.type,
        description: i.description,
        nodeIds: i.nodeIds,
        edgeIds: i.edgeIds,
        confidence: i.confidence,
      })),
    });
  };
}

/**
 * Create the graph_stats tool handler.
 */
export function createGraphStatsHandler(
  store: GraphStore,
): (_input: z.infer<typeof GraphStatsSchema>) => GraphStatsOutput {
  return (_input: z.infer<typeof GraphStatsSchema>): GraphStatsOutput => {
    const stats = store.getStats();
    return ({
      ...stats,
      vectorSearchAvailable: store.isVectorSearchAvailable(),
    });
  };
}

/**
 * Create the graph_write_transaction tool handler.
 */
export function createGraphWriteTransactionHandler(
  store: GraphStore,
): (
  input: z.infer<typeof GraphWriteTransactionSchema>,
) => GraphWriteTransactionOutput {
  return (
    input: z.infer<typeof GraphWriteTransactionSchema>,
  ): GraphWriteTransactionOutput => {
    try {
      const createdNodes: Array<{ id: string; type: string; label: string }> =
        [];
      const createdEdges: Array<
        { id: string; type: string; fromLabel: string; toLabel: string }
      > = [];
      const skippedEdges: Array<
        { fromLabel: string; toLabel: string; reason: string }
      > = [];
      const labelToId = new Map<string, string>();

      store.transaction(() => {
        // Create nodes first (with duplicate prevention)
        if (input.nodes) {
          for (const nodeInput of input.nodes) {
            // Check for existing node with same label+type
            const existing = store.findNodeByLabel(
              nodeInput.label,
              nodeInput.type,
            );
            if (existing) {
              labelToId.set(existing.label, existing.id);
              createdNodes.push({
                id: existing.id,
                type: existing.type,
                label: existing.label,
              });
              continue;
            }

            const node = store.createNode({
              type: nodeInput.type,
              label: nodeInput.label,
              description: nodeInput.description,
              properties: nodeInput.properties,
              sourceInstance: input.instanceId,
              confidence: nodeInput.confidence,
              sourceMemoryId: nodeInput.sourceMemoryId,
              firstLearnedAt: nodeInput.firstLearnedAt,
            });

            // Store embedding if provided
            if (nodeInput.embedding) {
              store.updateNodeEmbedding(node.id, nodeInput.embedding);
            }

            labelToId.set(node.label, node.id);
            createdNodes.push({
              id: node.id,
              type: node.type,
              label: node.label,
            });
          }
        }

        // Create edges
        if (input.edges) {
          for (const edgeInput of input.edges) {
            let fromId = labelToId.get(edgeInput.fromLabel);
            let toId = labelToId.get(edgeInput.toLabel);

            // Fall back to looking up existing nodes by label
            if (!fromId) {
              const existing = store.findNodeByLabel(edgeInput.fromLabel);
              if (existing) fromId = existing.id;
            }
            if (!toId) {
              const existing = store.findNodeByLabel(edgeInput.toLabel);
              if (existing) toId = existing.id;
            }

            if (!fromId || !toId) {
              skippedEdges.push({
                fromLabel: edgeInput.fromLabel,
                toLabel: edgeInput.toLabel,
                reason: `Node not found: ${
                  !fromId ? edgeInput.fromLabel : edgeInput.toLabel
                }`,
              });
              continue;
            }

            const edge = store.createEdge({
              fromId,
              toId,
              type: edgeInput.type,
              properties: edgeInput.properties,
              weight: edgeInput.weight,
              evidence: edgeInput.evidence,
              occurredAt: edgeInput.occurredAt,
              validUntil: edgeInput.validUntil,
              sourceInstance: input.instanceId,
            });

            createdEdges.push({
              id: edge.id,
              type: edge.type,
              fromLabel: edgeInput.fromLabel,
              toLabel: edgeInput.toLabel,
            });
          }
        }
      });

      const skippedMsg = skippedEdges.length > 0
        ? ` ${skippedEdges.length} edge(s) skipped due to missing nodes.`
        : "";

      return {
        success: true,
        message:
          `I have created ${createdNodes.length} node(s) and ${createdEdges.length} edge(s) in a single transaction.${skippedMsg}`,
        nodesCreated: createdNodes.length,
        edgesCreated: createdEdges.length,
        nodes: createdNodes,
        edges: createdEdges,
      };
    } catch (error) {
      return {
        success: false,
        message: `Transaction failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
        nodesCreated: 0,
        edgesCreated: 0,
      };
    }
  };
}

// ========================================
// TOOL DEFINITIONS
// ========================================

export const graphTools = {
  "graph/node_create": {
    description:
      "Create a new node in my knowledge graph. I use this to remember durable state — people, preferences, places, goals, beliefs, health, and how things connect. IMPORTANT: Write from first-person perspective - use 'me' (type: self) for self-references, 'user' for the person I interact with.",
    inputSchema: GraphNodeCreateSchema,
  },
  "graph/node_get": {
    description: "Get a specific node from my knowledge graph by its ID.",
    inputSchema: GraphNodeGetSchema,
  },
  "graph/node_update": {
    description:
      "Update a node in my knowledge graph. I use this to refine or add to what I know.",
    inputSchema: GraphNodeUpdateSchema,
  },
  "graph/node_delete": {
    description:
      "Delete a node from my knowledge graph. I use this when something is no longer relevant or was created in error.",
    inputSchema: GraphNodeDeleteSchema,
  },
  "graph/node_search": {
    description:
      "Search my knowledge graph for relevant nodes. Uses semantic search with pre-computed embeddings for best results.",
    inputSchema: GraphNodeSearchSchema,
  },
  "graph/node_list": {
    description:
      "List nodes in my knowledge graph, optionally filtered by type.",
    inputSchema: GraphNodeListSchema,
  },
  "graph/edge_create": {
    description:
      "Create a relationship between two nodes. I use this to connect things like 'user feels anxious about work' or 'meditation helps with stress'. IMPORTANT: Use first-person perspective - relationships are how I see connections in my world.",
    inputSchema: GraphEdgeCreateSchema,
  },
  "graph/edge_get": {
    description:
      "Get edges (relationships) from my knowledge graph. Can filter by ID, source/target nodes, or type.",
    inputSchema: GraphEdgeGetSchema,
  },
  "graph/edge_update": {
    description:
      "Update a relationship in my knowledge graph. I use this to change weights, add evidence, or mark relationships as ended.",
    inputSchema: GraphEdgeUpdateSchema,
  },
  "graph/edge_delete": {
    description: "Delete a relationship from my knowledge graph.",
    inputSchema: GraphEdgeDeleteSchema,
  },
  "graph/traverse": {
    description:
      "Traverse my knowledge graph starting from a node. I use this to find related concepts and understand connections.",
    inputSchema: GraphTraverseSchema,
  },
  "graph/subgraph": {
    description:
      "Extract a subgraph centered on a node. I use this to get the full context around a concept.",
    inputSchema: GraphSubgraphSchema,
  },
  "graph/insights": {
    description:
      "Discover patterns and insights in my knowledge graph. I use this to find bridges, clusters, and interesting connections.",
    inputSchema: GraphInsightsSchema,
  },
  "graph/stats": {
    description:
      "Get statistics about my knowledge graph - total nodes, edges, breakdowns by type.",
    inputSchema: GraphStatsSchema,
  },
  "graph/write_transaction": {
    description:
      "Create multiple nodes and edges in a single transaction. I use this for batch updates to my knowledge graph. IMPORTANT: Write from first-person perspective - use 'me' (type: self) for self-references, 'user' for the person I interact with.",
    inputSchema: GraphWriteTransactionSchema,
  },
};
