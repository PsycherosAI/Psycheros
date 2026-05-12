/**
 * Graph Mutate Tool (Omni) + Graph Write Batch Tool
 *
 * Unified write tool for knowledge graph mutations (create, update, delete
 * nodes and edges). Uses an operation discriminator instead of separate tools.
 * graph_write_batch remains separate because its interface (arrays, label-based
 * references, transactional semantics) is structurally different.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";

// =============================================================================
// Graph Mutate Tool Definition
// =============================================================================

export const graphMutateTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "graph_mutate",
      description:
        "Create, update, or delete nodes and edges in my knowledge graph. I use this to remember people, concepts, emotions, and how they connect. For recording several related facts at once, prefer graph_write_batch instead. IMPORTANT: Use first-person perspective.",
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: [
              "create_node",
              "create_edge",
              "update_node",
              "update_edge",
              "delete_node",
              "delete_edge",
            ],
            description: "The mutation to perform",
          },
          // create_node fields
          node_type: {
            type: "string",
            description:
              "For create_node: type (person, emotion, topic, preference, place, goal, health, boundary, tradition, insight, or any custom type)",
          },
          node_label: {
            type: "string",
            description:
              "For create_node: human-readable label (e.g., 'my partner', 'anxiety', 'hiking')",
          },
          node_description: {
            type: "string",
            description:
              "For create_node/update_node: detailed description of what this node represents",
          },
          node_confidence: {
            type: "number",
            description:
              "For create_node/update_node: how certain I am (0-1, default: 0.5)",
          },
          // create_edge / update_edge fields
          edge_type: {
            type: "string",
            description:
              "For create_edge/update_edge: relationship type — any natural language string (e.g., loves, works_at, values, respects)",
          },
          edge_weight: {
            type: "number",
            description:
              "For create_edge/update_edge: relationship strength (0-1, default: 0.5)",
          },
          edge_evidence: {
            type: "string",
            description:
              "For create_edge/update_edge: why I believe this relationship exists",
          },
          edge_valid_until: {
            type: "string",
            description:
              "For update_edge: ISO date when this relationship ends",
          },
          // create_edge: source/target by ID or label
          from_id: {
            type: "string",
            description: "For create_edge: source node ID",
          },
          to_id: {
            type: "string",
            description: "For create_edge: target node ID",
          },
          from_label: {
            type: "string",
            description:
              "For create_edge: source node label — looked up if from_id not provided",
          },
          to_label: {
            type: "string",
            description:
              "For create_edge: target node label — looked up if to_id not provided",
          },
          // update / delete fields
          id: {
            type: "string",
            description:
              "For update_node/update_edge/delete_node/delete_edge: the entity ID to target",
          },
          // update_node only
          label: {
            type: "string",
            description: "For update_node: updated label",
          },
        },
        required: ["operation"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const operation = args.operation as string;

    if (!operation) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "Error: 'operation' is required. Use one of: create_node, create_edge, update_node, update_edge, delete_node, delete_edge.",
        isError: true,
      };
    }

    if (!ctx.config.mcpClient) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "I cannot mutate my knowledge graph - MCP connection to entity-core is not available.",
        isError: true,
      };
    }

    try {
      switch (operation) {
        case "create_node":
          return await executeCreateNode(args, ctx);
        case "create_edge":
          return await executeCreateEdge(args, ctx);
        case "update_node":
          return await executeUpdateNode(args, ctx);
        case "update_edge":
          return await executeUpdateEdge(args, ctx);
        case "delete_node":
          return await executeDeleteNode(args, ctx);
        case "delete_edge":
          return await executeDeleteEdge(args, ctx);
        default:
          return {
            toolCallId: ctx.toolCallId,
            content:
              `Error: Unknown operation '${operation}'. Use one of: create_node, create_edge, update_node, update_edge, delete_node, delete_edge.`,
            isError: true,
          };
      }
    } catch (error) {
      return {
        toolCallId: ctx.toolCallId,
        content: `Failed to mutate knowledge graph: ${
          error instanceof Error ? error.message : String(error)
        }`,
        isError: true,
      };
    }
  },
};

// =============================================================================
// Graph Write Batch Tool Definition (unchanged interface)
// =============================================================================

export const graphWriteBatchTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "graph_write_batch",
      description:
        "Create multiple nodes and edges at once. I use this when I learn several related facts and want to record them together. Edges can reference existing nodes by label (like 'me' or 'user'). IMPORTANT: Use first-person perspective.",
      parameters: {
        type: "object",
        properties: {
          nodes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string" },
                label: { type: "string" },
                description: { type: "string" },
                confidence: { type: "number" },
              },
              required: ["type", "label"],
            },
            description: "Nodes to create",
          },
          edges: {
            type: "array",
            items: {
              type: "object",
              properties: {
                fromLabel: {
                  type: "string",
                  description: "Source node label (new or existing)",
                },
                toLabel: {
                  type: "string",
                  description: "Target node label (new or existing)",
                },
                type: { type: "string" },
                weight: { type: "number" },
                evidence: { type: "string" },
              },
              required: ["fromLabel", "toLabel", "type"],
            },
            description: "Edges to create (reference nodes by label)",
          },
        },
        required: [],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const { nodes, edges } = args as unknown as {
      nodes?: Array<
        {
          type: string;
          label: string;
          description?: string;
          confidence?: number;
        }
      >;
      edges?: Array<
        {
          fromLabel: string;
          toLabel: string;
          type: string;
          weight?: number;
          evidence?: string;
        }
      >;
    };

    if (!ctx.config.mcpClient) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "I cannot write to my knowledge graph - MCP connection to entity-core is not available.",
        isError: true,
      };
    }

    try {
      const result = await ctx.config.mcpClient.writeGraphTransaction({
        nodes,
        edges,
      });

      if (!result.success) {
        return {
          toolCallId: ctx.toolCallId,
          content: `Batch write failed: ${result.error}`,
          isError: true,
        };
      }

      return {
        toolCallId: ctx.toolCallId,
        content:
          `I recorded ${result.nodesCreated} node(s) and ${result.edgesCreated} edge(s) in my knowledge graph.`,
        isError: false,
      };
    } catch (error) {
      return {
        toolCallId: ctx.toolCallId,
        content: `Failed to write graph batch: ${
          error instanceof Error ? error.message : String(error)
        }`,
        isError: true,
      };
    }
  },
};

// =============================================================================
// Operation Implementations
// =============================================================================

async function executeCreateNode(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const nodeType = args.node_type as string;
  const nodeLabel = args.node_label as string;
  const nodeDescription = args.node_description as string | undefined;
  const nodeConfidence = args.node_confidence as number | undefined;

  if (!nodeType || !nodeLabel) {
    return {
      toolCallId: ctx.toolCallId,
      content:
        "Error: 'node_type' and 'node_label' are required for create_node.",
      isError: true,
    };
  }

  const mcp = ctx.config.mcpClient!;

  // Check for existing node with same label and type (duplicate prevention)
  const existingByType = await mcp.getGraphNodes({
    type: nodeType,
    limit: 100,
  });
  const duplicate = existingByType.find(
    (n) => n.label.toLowerCase() === nodeLabel.toLowerCase(),
  );

  if (duplicate) {
    const conf = Math.round(duplicate.confidence * 100);
    return {
      toolCallId: ctx.toolCallId,
      content:
        `I already have a "${duplicate.label}" (${duplicate.type}) node [${conf}% confidence]. ID: ${duplicate.id}\n\n${
          duplicate.description || "No description yet."
        }`,
      isError: false,
    };
  }

  const result = await mcp.createGraphNode({
    type: nodeType,
    label: nodeLabel,
    description: nodeDescription,
    confidence: nodeConfidence,
  });

  if (!result.success) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Failed to create node: ${result.error}`,
      isError: true,
    };
  }

  return {
    toolCallId: ctx.toolCallId,
    content:
      `I created a new "${nodeLabel}" (${nodeType}) node in my knowledge graph. ID: ${result.nodeId}`,
    isError: false,
  };
}

async function executeCreateEdge(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const fromId = args.from_id as string | undefined;
  const toId = args.to_id as string | undefined;
  const fromLabel = args.from_label as string | undefined;
  const toLabel = args.to_label as string | undefined;
  const edgeType = args.edge_type as string;
  const edgeWeight = args.edge_weight as number | undefined;
  const edgeEvidence = args.edge_evidence as string | undefined;

  if (!edgeType) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: 'edge_type' is required for create_edge.",
      isError: true,
    };
  }

  const mcp = ctx.config.mcpClient!;

  // Fetch node list once if we need to resolve any labels
  const needsLabelLookup = (!fromId && fromLabel) || (!toId && toLabel);
  const allNodes = needsLabelLookup
    ? await mcp.getGraphNodes({ limit: 500 })
    : [];

  // Resolve source node
  let resolvedFromId = fromId;
  if (!resolvedFromId && fromLabel) {
    const match = allNodes.find(
      (n) => n.label.toLowerCase() === fromLabel.toLowerCase(),
    );
    if (match) {
      resolvedFromId = match.id;
    } else {
      return {
        toolCallId: ctx.toolCallId,
        content:
          `I couldn't find a node with label "${fromLabel}". I should use graph_query to find the correct node first, or create it with graph_mutate.`,
        isError: true,
      };
    }
  }

  // Resolve target node
  let resolvedToId = toId;
  if (!resolvedToId && toLabel) {
    const match = allNodes.find(
      (n) => n.label.toLowerCase() === toLabel.toLowerCase(),
    );
    if (match) {
      resolvedToId = match.id;
    } else {
      return {
        toolCallId: ctx.toolCallId,
        content:
          `I couldn't find a node with label "${toLabel}". I should use graph_query to find the correct node first, or create it with graph_mutate.`,
        isError: true,
      };
    }
  }

  if (!resolvedFromId || !resolvedToId) {
    const missing: string[] = [];
    if (!resolvedFromId) missing.push("from_id or from_label");
    if (!resolvedToId) missing.push("to_id or to_label");
    return {
      toolCallId: ctx.toolCallId,
      content: `I need to specify the source and target nodes. Missing: ${
        missing.join(", ")
      }. I can use either node IDs (from_id/to_id) or node labels (from_label/to_label).`,
      isError: true,
    };
  }

  const result = await mcp.createGraphEdge({
    fromId: resolvedFromId,
    toId: resolvedToId,
    type: edgeType,
    weight: edgeWeight,
    evidence: edgeEvidence,
  });

  if (!result.success) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Failed to create edge: ${result.error}`,
      isError: true,
    };
  }

  return {
    toolCallId: ctx.toolCallId,
    content:
      `I created a "${edgeType}" relationship in my knowledge graph. Edge ID: ${result.edgeId}`,
    isError: false,
  };
}

async function executeUpdateNode(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const id = args.id as string;
  const label = args.label as string | undefined;
  const nodeDescription = args.node_description as string | undefined;
  const nodeConfidence = args.node_confidence as number | undefined;

  if (!id) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: 'id' is required for update_node.",
      isError: true,
    };
  }

  const result = await ctx.config.mcpClient!.updateGraphNode(id, {
    label,
    description: nodeDescription,
    confidence: nodeConfidence,
    lastConfirmedAt: new Date().toISOString(),
  });

  if (!result.success) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Failed to update node: ${result.error}`,
      isError: true,
    };
  }

  return {
    toolCallId: ctx.toolCallId,
    content: `I updated node ${id} in my knowledge graph.`,
    isError: false,
  };
}

async function executeUpdateEdge(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const id = args.id as string;
  const edgeType = args.edge_type as string | undefined;
  const edgeWeight = args.edge_weight as number | undefined;
  const edgeEvidence = args.edge_evidence as string | undefined;
  const edgeValidUntil = args.edge_valid_until as string | undefined;

  if (!id) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: 'id' is required for update_edge.",
      isError: true,
    };
  }

  const result = await ctx.config.mcpClient!.updateGraphEdge(id, {
    type: edgeType,
    weight: edgeWeight,
    evidence: edgeEvidence,
    validUntil: edgeValidUntil,
    lastConfirmedAt: new Date().toISOString(),
  });

  if (!result.success) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Failed to update edge: ${result.error}`,
      isError: true,
    };
  }

  return {
    toolCallId: ctx.toolCallId,
    content: `I updated edge ${id} in my knowledge graph.`,
    isError: false,
  };
}

async function executeDeleteNode(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const id = args.id as string;

  if (!id) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: 'id' is required for delete_node.",
      isError: true,
    };
  }

  const mcp = ctx.config.mcpClient!;

  // Look up the node first so we can show its label
  const node = await mcp.getGraphNode(id);
  if (!node) {
    return {
      toolCallId: ctx.toolCallId,
      content: `I could not find a node with ID "${id}" in my knowledge graph.`,
      isError: false,
    };
  }

  const result = await mcp.deleteGraphNode(id);

  if (!result.success) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Failed to delete node: ${result.error}`,
      isError: true,
    };
  }

  return {
    toolCallId: ctx.toolCallId,
    content:
      `I removed "${node.label}" (${node.type}) from my knowledge graph.`,
    isError: false,
  };
}

async function executeDeleteEdge(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const id = args.id as string;

  if (!id) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: 'id' is required for delete_edge.",
      isError: true,
    };
  }

  const result = await ctx.config.mcpClient!.deleteGraphEdge(id);

  if (!result.success) {
    return {
      toolCallId: ctx.toolCallId,
      content: `Failed to delete edge: ${result.error}`,
      isError: true,
    };
  }

  return {
    toolCallId: ctx.toolCallId,
    content: `I removed edge ${id} from my knowledge graph.`,
    isError: false,
  };
}
