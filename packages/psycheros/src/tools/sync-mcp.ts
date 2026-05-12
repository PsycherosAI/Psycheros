/**
 * MCP Sync Tool
 *
 * Allows the entity to manually trigger a sync with entity-core.
 * This pulls the latest identity files and pushes any pending changes.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";

/**
 * The sync_mcp tool allows the entity to sync with entity-core.
 */
export const syncMcpTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "sync_mcp",
      description:
        "Sync with entity-core to get my latest identity files and push any pending changes. " +
        "I use this when I want to ensure I have the most up-to-date identity information, " +
        "or after making changes that should be synced to the central entity-core server.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Optional reason for syncing (for logging)",
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
    const mcpClient = ctx.config.mcpClient;

    if (!mcpClient) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "MCP is not enabled. Set PSYCHEROS_MCP_ENABLED=true to use entity-core sync.",
        isError: true,
      };
    }

    const reason = args.reason as string | undefined;
    const logPrefix = reason ? `[sync_mcp: ${reason}]` : "[sync_mcp]";

    try {
      // Check if connected
      if (!mcpClient.isConnected()) {
        return {
          toolCallId: ctx.toolCallId,
          content:
            `${logPrefix} MCP client is not connected to entity-core. Changes remain queued for later sync.`,
          isError: false,
        };
      }

      // Pull latest from entity-core
      const identity = await mcpClient.pull();

      // Push any pending changes
      const pushSuccess = await mcpClient.push();

      // Get pending counts
      const pending = mcpClient.getPendingCount();

      const parts: string[] = [`${logPrefix} Sync completed.`];

      if (identity) {
        const selfCount = identity.self.length;
        const userCount = identity.user.length;
        const relationshipCount = identity.relationship.length;
        parts.push(
          `Pulled ${selfCount} self, ${userCount} user, ${relationshipCount} relationship files.`,
        );
      }

      if (pushSuccess) {
        parts.push("Pushed pending changes successfully.");
      } else {
        parts.push("Push returned false (may have conflicts).");
      }

      if (pending.identity > 0) {
        parts.push(`Still pending: ${pending.identity} identity changes.`);
      }

      return {
        toolCallId: ctx.toolCallId,
        content: parts.join(" "),
        isError: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      return {
        toolCallId: ctx.toolCallId,
        content: `${logPrefix} Sync failed: ${errorMessage}`,
        isError: true,
      };
    }
  },
};
