/**
 * Update Title Tool
 *
 * Allows the entity to update the title of the current conversation.
 * Uses the centralized state change function for consistent behavior.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import { updateConversationTitle } from "../server/state-changes.ts";

/**
 * The update_title tool allows the entity to set the conversation title.
 *
 * This is useful for:
 * - Naming conversations based on their topic
 * - Helping users identify conversations in the sidebar
 * - Organizing conversation history
 */
export const updateTitleTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "update_title",
      description:
        "Update the title of the current conversation. I use this to give the conversation a descriptive name based on what's being discussed. I keep titles concise but descriptive (under 50 characters is ideal).",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "The new title for the conversation. Should be concise and descriptive.",
          },
        },
        required: ["title"],
      },
    },
  },

  execute: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const title = args.title;

    if (typeof title !== "string") {
      return Promise.resolve({
        toolCallId: ctx.toolCallId,
        content: "Error: 'title' argument is required and must be a string",
        isError: true,
      });
    }

    // Use the centralized state change function
    const result = updateConversationTitle(ctx.db, ctx.conversationId, title);

    if (!result.success) {
      return Promise.resolve({
        toolCallId: ctx.toolCallId,
        content: `Error: ${result.error}`,
        isError: true,
      });
    }

    return Promise.resolve({
      toolCallId: ctx.toolCallId,
      content: `Conversation title updated to: "${result.data?.title}"`,
      isError: false,
      affectedRegions: result.affectedRegions,
    });
  },
};
