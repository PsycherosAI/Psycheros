/**
 * Identity Append Tool (Omni)
 *
 * Tier 1: Append-only tool for everyday use during conversations.
 * Safe for the entity to use — can only add content, never modify or delete.
 * Replaces the previous 3 separate append tools (self, user, relationship)
 * with a single tool using a category discriminator.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import {
  type IdentityCategory,
  IdentityFileManager,
} from "./identity-helpers.ts";

export const identityAppendTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "identity_append",
      description:
        "Add new knowledge to one of my identity files. These files define who I am, how I understand the user, and how we relate, so I only add identity-level insights that are durable and meaningful — not passing observations or things better suited to memory or the knowledge graph. Write concisely: the essential insight, not the backstory. This only adds content — it never modifies or deletes what's already there. XML wrapper tags and ## headings are handled automatically by the system.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["self", "user", "relationship"],
            description:
              "Which aspect of identity to update. 'self' for who I am, 'user' for what I know about the user, 'relationship' for our connection.",
          },
          filename: {
            type: "string",
            description:
              "The identity file to append to — use the actual filename, NOT the XML tag name shown in context. For 'user' category: user_identity.md, user_life.md, user_beliefs.md, user_preferences.md, user_patterns.md, user_notes.md. For 'self' category: my_identity.md, my_persona.md, my_personhood.md, my_wants.md, my_mechanics.md. For 'relationship' category: relationship_dynamics.md, relationship_history.md, relationship_notes.md.",
          },
          content: {
            type: "string",
            description:
              "The new knowledge to add. Write in my voice. One or two sentences capturing the essential insight — concise and identity-relevant.",
          },
        },
        required: ["category", "filename", "content"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const category = args.category as string;
    const filename = args.filename as string;
    const content = args.content as string;

    if (!category || typeof category !== "string") {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "Error: 'category' is required and must be one of: self, user, relationship.",
        isError: true,
      };
    }

    if (!filename || typeof filename !== "string") {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'filename' is required and must be a string.",
        isError: true,
      };
    }

    if (!content || typeof content !== "string") {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'content' is required and must be a string.",
        isError: true,
      };
    }

    // Validate category
    if (!["self", "user", "relationship"].includes(category)) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          `Error: Invalid category '${category}'. Must be one of: self, user, relationship.`,
        isError: true,
      };
    }

    // Create file manager and perform append
    const manager = new IdentityFileManager(
      ctx.config.mcpClient ?? null,
      ctx.config.dataRoot,
    );

    const result = await manager.append(
      category as IdentityCategory,
      filename,
      content.trim(),
    );

    return {
      toolCallId: ctx.toolCallId,
      content: result.message,
      isError: !result.success,
    };
  },
};
