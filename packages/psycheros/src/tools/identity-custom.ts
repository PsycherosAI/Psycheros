/**
 * Custom Identity File Tool
 *
 * Allows the entity to create and modify custom identity files.
 * Custom files are freeform files in identity/custom/ for topics that
 * don't fit the predefined self/user/relationship structure.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import { IdentityFileManager } from "./identity-helpers.ts";

// =============================================================================
// custom_identity_file Tool
// =============================================================================

const VALID_OPERATIONS = [
  "create",
  "append",
  "prepend",
  "update_section",
  "rewrite_section",
];

export const customFileTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "custom_identity_file",
      description:
        "Create or modify a custom identity file. Custom files are freeform files in identity/custom/ that load into my context every turn alongside my other identity files. I use these for topics that don't fit the predefined self/user/relationship structure. The same selectivity applies — only store identity-level, durable knowledge.",
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            description:
              "The operation to perform: 'create' (new file), 'append' (add to end), 'prepend' (add to beginning), 'update_section' (append content under a heading), 'rewrite_section' (replace a section's content entirely). XML wrapper tags are handled automatically by the system.",
            enum: VALID_OPERATIONS,
          },
          filename: {
            type: "string",
            description:
              "The custom filename with .md extension. Use only letters, numbers, and underscores (e.g., my_project.md).",
          },
          content: {
            type: "string",
            description:
              "The content to add or replace with. Write concisely — these files load every turn. XML wrapper tags are handled automatically by the system.",
          },
          section: {
            type: "string",
            description:
              "Required for update_section and rewrite_section: the heading name (without ##) of the section to modify.",
          },
        },
        required: ["operation", "filename"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const operation = args.operation as string;
    const filename = args.filename as string;
    const content = args.content as string | undefined;
    const section = args.section as string | undefined;

    // Validate operation
    if (!operation || !VALID_OPERATIONS.includes(operation)) {
      return {
        toolCallId: ctx.toolCallId,
        content: `Error: Invalid operation '${operation}'. Valid operations: ${
          VALID_OPERATIONS.join(", ")
        }`,
        isError: true,
      };
    }

    // Validate filename
    if (!filename || typeof filename !== "string") {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'filename' is required and must be a string",
        isError: true,
      };
    }

    // Validate content is present
    if (!content || typeof content !== "string") {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'content' is required",
        isError: true,
      };
    }

    // Validate section for update_section and rewrite_section
    if (
      (operation === "update_section" || operation === "rewrite_section") &&
      !section
    ) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          `Error: 'section' is required when operation is '${operation}'`,
        isError: true,
      };
    }

    const manager = new IdentityFileManager(
      ctx.config.mcpClient ?? null,
      ctx.config.projectRoot,
    );

    switch (operation) {
      case "create": {
        const result = await manager.create(
          "custom",
          filename,
          content!.trim(),
        );
        return {
          toolCallId: ctx.toolCallId,
          content: result.message,
          isError: !result.success,
        };
      }

      case "append": {
        const result = await manager.append(
          "custom",
          filename,
          content!.trim(),
        );
        return {
          toolCallId: ctx.toolCallId,
          content: result.message,
          isError: !result.success,
        };
      }

      case "prepend": {
        const result = await manager.prepend(
          "custom",
          filename,
          content!.trim(),
        );
        return {
          toolCallId: ctx.toolCallId,
          content: result.message,
          isError: !result.success,
        };
      }

      case "update_section": {
        const result = await manager.updateSection(
          "custom",
          filename,
          section!,
          content!.trim(),
        );
        return {
          toolCallId: ctx.toolCallId,
          content: result.message,
          isError: !result.success,
        };
      }

      case "rewrite_section": {
        const result = await manager.rewriteSection(
          "custom",
          filename,
          section!,
          content!.trim(),
        );
        return {
          toolCallId: ctx.toolCallId,
          content: result.message,
          isError: !result.success,
        };
      }

      default: {
        return {
          toolCallId: ctx.toolCallId,
          content: `Error: Unhandled operation '${operation}'`,
          isError: true,
        };
      }
    }
  },
};
