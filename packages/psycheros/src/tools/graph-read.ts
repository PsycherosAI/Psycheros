/**
 * Graph Query Tool (Omni)
 *
 * Unified read-only tool for querying the knowledge graph.
 * Replaces the previous 6 separate read tools with a single tool
 * using a query_type discriminator.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";

// =============================================================================
// Tool Definition
// =============================================================================

export const graphQueryTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "graph_query",
      description:
        "Query my knowledge graph to search, inspect, and traverse nodes and relationships. Use this to find people, topics, emotions, and how they connect.",
      parameters: {
        type: "object",
        properties: {
          query_type: {
            type: "string",
            enum: [
              "search",
              "get_node",
              "get_edges",
              "traverse",
              "subgraph",
              "stats",
            ],
            description:
              "Type of query. 'search' for semantic node search, 'get_node' by ID, 'get_edges' for relationships, 'traverse' to walk from a node, 'subgraph' for full neighborhood, 'stats' for counts.",
          },
          // search params
          query: {
            type: "string",
            description:
              "For 'search': the search text (e.g., 'work stress', 'hobbies', 'family')",
          },
          type: {
            type: "string",
            description:
              "For 'search': optional filter by node type (person, emotion, topic, preference, place, goal, health, boundary, tradition, insight)",
          },
          limit: {
            type: "number",
            description: "For 'search': max results (default: 10)",
          },
          // get_node / traverse / subgraph params
          node_id: {
            type: "string",
            description: "For 'get_node', 'traverse', 'subgraph': the node ID",
          },
          // get_edges params
          from_id: {
            type: "string",
            description: "For 'get_edges': filter by source node ID",
          },
          to_id: {
            type: "string",
            description: "For 'get_edges': filter by target node ID",
          },
          edge_type: {
            type: "string",
            description: "For 'get_edges': filter by relationship type",
          },
          // traverse params
          direction: {
            type: "string",
            enum: ["out", "in", "both"],
            description: "For 'traverse': direction (default: both)",
          },
          max_depth: {
            type: "number",
            description: "For 'traverse': max depth (default: 2, max: 5)",
          },
          edge_types: {
            type: "array",
            items: { type: "string" },
            description:
              "For 'traverse': optional filter by edge types to follow",
          },
        },
        required: ["query_type"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const queryType = args.query_type as string;

    if (!queryType) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "Error: 'query_type' is required. Use one of: search, get_node, get_edges, traverse, subgraph, stats.",
        isError: true,
      };
    }

    if (!ctx.config.mcpClient) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "I cannot query my knowledge graph - MCP connection to entity-core is not available.",
        isError: true,
      };
    }

    try {
      switch (queryType) {
        case "search":
          return await executeSearch(args, ctx);
        case "get_node":
          return await executeGetNode(args, ctx);
        case "get_edges":
          return await executeGetEdges(args, ctx);
        case "traverse":
          return await executeTraverse(args, ctx);
        case "subgraph":
          return await executeSubgraph(args, ctx);
        case "stats":
          return await executeStats(args, ctx);
        default:
          return {
            toolCallId: ctx.toolCallId,
            content:
              `Error: Unknown query_type '${queryType}'. Use one of: search, get_node, get_edges, traverse, subgraph, stats.`,
            isError: true,
          };
      }
    } catch (error) {
      return {
        toolCallId: ctx.toolCallId,
        content: `Failed to query knowledge graph: ${
          error instanceof Error ? error.message : String(error)
        }`,
        isError: true,
      };
    }
  },
};

// =============================================================================
// Query Implementations
// =============================================================================

async function executeSearch(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const query = args.query as string;
  const type = args.type as string | undefined;
  const limit = (args.limit as number) ?? 10;

  if (!query) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: 'query' is required for search queries.",
      isError: true,
    };
  }

  const results = await ctx.config.mcpClient!.searchGraphNodes(
    query,
    type,
    limit,
  );

  if (results.length === 0) {
    return {
      toolCallId: ctx.toolCallId,
      content:
        `I searched my knowledge graph for "${query}" but found no matching nodes.`,
      isError: false,
    };
  }

  const formatted = results.map((r) => {
    const relevance = Math.round(r.score * 100);
    return `- **${r.label}** (${r.type}) [${relevance}% relevant]\n  ${
      r.description || "No description"
    }`;
  }).join("\n\n");

  return {
    toolCallId: ctx.toolCallId,
    content:
      `I found ${results.length} nodes matching "${query}":\n\n${formatted}`,
    isError: false,
  };
}

async function executeGetNode(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const id = args.node_id as string;

  if (!id) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: 'node_id' is required for get_node queries.",
      isError: true,
    };
  }

  const node = await ctx.config.mcpClient!.getGraphNode(id);

  if (!node) {
    return {
      toolCallId: ctx.toolCallId,
      content: `I could not find a node with ID "${id}" in my knowledge graph.`,
      isError: false,
    };
  }

  const confidence = Math.round(node.confidence * 100);
  return {
    toolCallId: ctx.toolCallId,
    content: `**${node.label}** (${node.type}) [${confidence}% confidence]\n\n${
      node.description || "No description"
    }`,
    isError: false,
  };
}

async function executeGetEdges(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const fromId = args.from_id as string | undefined;
  const toId = args.to_id as string | undefined;
  const type = args.edge_type as string | undefined;

  const edges = await ctx.config.mcpClient!.getGraphEdges({
    fromId,
    toId,
    type,
  });

  if (edges.length === 0) {
    return {
      toolCallId: ctx.toolCallId,
      content: "I found no relationships matching those criteria.",
      isError: false,
    };
  }

  const formatted = edges.map((e) => {
    const weight = Math.round(e.weight * 100);
    const relType = e.type;
    return `- ${e.fromId} --[${relType}]--> ${e.toId} [${weight}%]`;
  }).join("\n");

  return {
    toolCallId: ctx.toolCallId,
    content: `I found ${edges.length} relationships:\n\n${formatted}`,
    isError: false,
  };
}

async function executeTraverse(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const startNodeId = args.node_id as string;
  const direction = (args.direction as "out" | "in" | "both") ?? "both";
  const maxDepth = (args.max_depth as number) ?? 2;
  const edgeTypes = args.edge_types as string[] | undefined;

  if (!startNodeId) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: 'node_id' is required for traverse queries.",
      isError: true,
    };
  }

  const result = await ctx.config.mcpClient!.traverseGraph(
    startNodeId,
    direction,
    maxDepth,
    edgeTypes,
  );

  if (result.results.length === 0) {
    return {
      toolCallId: ctx.toolCallId,
      content: `I found no connected nodes starting from "${startNodeId}".`,
      isError: false,
    };
  }

  const formatted = result.results.map((r) => {
    const depth = "  ".repeat(r.depth);
    return `${depth}- **${r.node.label}** (${r.node.type}) at depth ${r.depth}`;
  }).join("\n");

  const startLabel = result.startNode?.label || startNodeId;
  return {
    toolCallId: ctx.toolCallId,
    content:
      `Starting from **${startLabel}**, I found ${result.results.length} connected nodes:\n\n${formatted}`,
    isError: false,
  };
}

async function executeSubgraph(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const nodeId = args.node_id as string;

  if (!nodeId) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: 'node_id' is required for subgraph queries.",
      isError: true,
    };
  }

  const subgraph = await ctx.config.mcpClient!.getGraphSubgraph(nodeId);

  if (!subgraph.nodes || subgraph.nodes.length === 0) {
    return {
      toolCallId: ctx.toolCallId,
      content: `I could not find a subgraph around node "${nodeId}".`,
      isError: false,
    };
  }

  const nodesFormatted = subgraph.nodes.map((n) => {
    return `- **${n.label}** (${n.type})`;
  }).join("\n");

  const edgesFormatted = subgraph.edges && subgraph.edges.length > 0
    ? "\n\nRelationships:\n" + subgraph.edges.map((e) => {
      const relType = e.type;
      const fromNode = subgraph.nodes.find((n) => n.id === e.fromId);
      const toNode = subgraph.nodes.find((n) => n.id === e.toId);
      return `- **${fromNode?.label || e.fromId}** → *${relType}* → **${
        toNode?.label || e.toId
      }**`;
    }).join("\n")
    : "";

  return {
    toolCallId: ctx.toolCallId,
    content:
      `Subgraph with ${subgraph.nodes.length} nodes:\n\n${nodesFormatted}${edgesFormatted}`,
    isError: false,
  };
}

async function executeStats(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const stats = await ctx.config.mcpClient!.getGraphStats();

  if (!stats) {
    return {
      toolCallId: ctx.toolCallId,
      content: "I could not retrieve graph statistics.",
      isError: false,
    };
  }

  const byType = Object.entries(stats.nodesByType || {})
    .map(([type, count]) => `- ${type}: ${count}`)
    .join("\n");

  const byEdge = Object.entries(stats.edgesByType || {})
    .map(([type, count]) => `- ${type}: ${count}`)
    .join("\n");

  return {
    toolCallId: ctx.toolCallId,
    content: `**Knowledge Graph Statistics**

Total nodes: ${stats.totalNodes || 0}
Total edges: ${stats.totalEdges || 0}

Nodes by type:
${byType || "- No nodes yet"}

Edges by type:
${byEdge || "- No edges yet"}

Vector search: ${stats.vectorSearchAvailable ? "Available" : "Not available"}`,
    isError: false,
  };
}
