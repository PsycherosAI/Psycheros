/**
 * Create Significant Memory Tool
 *
 * Allows the entity to create a significant memory for emotionally important
 * events that should be permanently remembered with clarity.
 * Writes exclusively to entity-core via MCP — no local files.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";

/**
 * Convert a title to a URL-safe filename slug.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "") // Remove special chars
    .replace(/\s+/g, "-") // Spaces to dashes
    .replace(/-+/g, "-") // Multiple dashes to single
    .replace(/^-|-$/g, "") // Trim dashes
    .substring(0, 50); // Limit length
}

/**
 * Get the current date string for MCP sync.
 */
function getCurrentDate(): string {
  const tz = Deno.env.get("PSYCHEROS_DISPLAY_TZ") || Deno.env.get("TZ");
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz || undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/**
 * The create_significant_memory tool allows the entity to save important memories.
 *
 * Use this for:
 * - Major life events (graduations, weddings, births)
 * - Significant traumas or challenges
 * - Spiritual experiences or realizations
 * - Major milestones or achievements
 * - Deeply meaningful conversations or connections
 * - Anything emotionally significant that should be permanently remembered
 *
 * Unlike daily/weekly/monthly memories, these are never consolidated or archived.
 * Stored in entity-core via MCP.
 */
export const createSignificantMemoryTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "create_significant_memory",
      description:
        "Create a significant memory for an emotionally important event that I want to permanently remember. I use this for major life events, traumas, spiritual experiences, meaningful connections, or anything that feels deeply significant. These memories are never consolidated or lost. Stored in entity-core.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "A short, identifying, descriptive title for the memory (e.g., 'First Conversation with User', 'Realization of Feelings about Home')",
          },
          content: {
            type: "string",
            description:
              "The full content of the memory. Write this with care and detail - describe what happened, how it felt, why it matters. This will be a permanent record.",
          },
        },
        required: ["title", "content"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const title = args.title;
    const content = args.content;

    // Validate arguments
    if (typeof title !== "string" || title.trim().length === 0) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "Error: 'title' argument is required and must be a non-empty string",
        isError: true,
      };
    }

    if (typeof content !== "string" || content.trim().length === 0) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "Error: 'content' argument is required and must be a non-empty string",
        isError: true,
      };
    }

    // MCP is required — no local fallback
    if (!ctx.config.mcpClient?.isConnected()) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "Error: entity-core is not connected. Significant memories require entity-core.",
        isError: true,
      };
    }

    const slug = slugify(title.trim()) || undefined;
    const formattedContent = `# ${title.trim()}\n\n${content.trim()}\n`;

    try {
      const success = await ctx.config.mcpClient.createMemory(
        "significant",
        getCurrentDate(),
        formattedContent,
        [],
        slug,
      );

      if (!success) {
        console.error(
          `[Memory] entity-core reported failure for significant memory: ${title.trim()}`,
        );
        return {
          toolCallId: ctx.toolCallId,
          content:
            `Error: entity-core failed to store the significant memory "${title.trim()}". The memory may not have been saved.`,
          isError: true,
        };
      }

      console.log(
        `[Memory] Created significant memory via MCP: ${title.trim()}`,
      );

      return {
        toolCallId: ctx.toolCallId,
        content:
          `Created significant memory "${title.trim()}" (stored in entity-core)`,
        isError: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      console.error(
        `[Memory] Failed to create significant memory:`,
        errorMessage,
      );
      return {
        toolCallId: ctx.toolCallId,
        content: `Error creating significant memory: ${errorMessage}`,
        isError: true,
      };
    }
  },
};
