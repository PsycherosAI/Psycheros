/**
 * Identity Maintenance Tools
 *
 * Tier 2: Full suite of tools for intentional identity reorganization.
 * Includes prepend, section updates, and section rewriting.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import {
  type IdentityCategory,
  IdentityFileManager,
} from "./identity-helpers.ts";

// =============================================================================
// Helper Constants
// =============================================================================

const CATEGORIES = ["self", "user", "relationship"] as const;

// =============================================================================
// maintain_identity Tool
// =============================================================================

/**
 * The maintain_identity tool allows comprehensive identity file maintenance.
 */
export const maintainIdentityTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "maintain_identity",
      description:
        "My primary tool for updating identity files — who I am, who the user is, and our relationship. I use this whenever I learn something durable and meaningful that belongs in my identity.\n\nIMPORTANT: Identity files are stored on disk with filenames like 'user_identity.md' — always use the actual filename, NOT the XML tag name shown in context (e.g., the file is 'user_identity.md' even if it displays as <human_identity> or any custom label in context). XML wrapper tags are handled automatically by the system.\n\nCHOOSING THE RIGHT SECTION:\nWhen using update_section or rewrite_section, I must read the file's existing ## headings first and pick the one that best fits the content I'm adding. If none of the existing headings are a good fit, I should create a new section by passing a descriptive heading name that doesn't exist yet — it will be created automatically at the end of the file. I must NOT force content under an unrelated heading.\n\nOperations:\n- 'append': add to the end of a file\n- 'prepend': add to the beginning of a file\n- 'update_section': add content UNDER a ## heading (existing content in that section is kept). If the section doesn't exist, it will be created automatically. This is the DEFAULT choice for section-level changes.\n- 'rewrite_section': DESTRUCTIVE — replaces ALL content under a ## heading. Existing content is removed. A snapshot is created automatically, but this should only be used as a last resort when update_section cannot achieve the goal (e.g., removing outdated/incorrect information, consolidating redundant entries). If the section doesn't exist, it will be created automatically.\n\nIMPORTANT — content format for section operations: The 'content' parameter must contain ONLY the body text for the section. Do NOT include the ## heading line — the system adds it automatically. For example, if section is \"Health\", pass content like \"**Dizziness:** ...\" NOT \"## Health\n**Dizziness:** ...\".\n\nPrefer 'update_section' over 'rewrite_section' in almost all cases. 'rewrite_section' should only be used when existing section content is actively wrong or redundant and needs to be removed, not just to reorganize or consolidate.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Which category of identity file to modify",
            enum: CATEGORIES,
          },
          filename: {
            type: "string",
            description:
              "The file to modify — use the actual filename, NOT the XML tag name shown in context. For 'self': my_identity.md, my_persona.md, my_personhood.md, my_wants.md, my_mechanics.md. For 'user': user_identity.md, user_life.md, user_beliefs.md, user_preferences.md, user_patterns.md, user_notes.md. For 'relationship': relationship_dynamics.md, relationship_history.md, relationship_notes.md.",
          },
          operation: {
            type: "string",
            description:
              "The operation to perform:\n- 'append': add to the end of the file\n- 'prepend': add to the beginning of the file\n- 'update_section': append content UNDER a specific ## heading (existing content in that section is kept)\n- 'rewrite_section': DESTRUCTIVE — replace all content under a specific ## heading (existing content is removed)",
            enum: ["append", "prepend", "update_section", "rewrite_section"],
          },
          content: {
            type: "string",
            description:
              "The content to add or replace with. For update_section and rewrite_section: the body text ONLY — do NOT include the ## heading line (the system adds it automatically).",
          },
          section: {
            type: "string",
            description:
              "Required for update_section and rewrite_section: the heading name (without ##) of the section to modify or create. Use an existing heading if it fits, or a new descriptive name to create a new section.",
          },
        },
        required: ["category", "filename", "operation", "content"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const category = args.category as IdentityCategory;
    const filename = args.filename as string;
    const operation = args.operation as string;
    const content = args.content as string;
    const section = args.section as string | undefined;

    // Validate required args
    if (!category || !CATEGORIES.includes(category as never)) {
      return {
        toolCallId: ctx.toolCallId,
        content: `Error: 'category' must be one of: ${CATEGORIES.join(", ")}`,
        isError: true,
      };
    }

    if (!filename || typeof filename !== "string") {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'filename' is required and must be a string",
        isError: true,
      };
    }

    if (!operation || typeof operation !== "string") {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'operation' is required",
        isError: true,
      };
    }

    if (!content || typeof content !== "string") {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: 'content' is required and must be a string",
        isError: true,
      };
    }

    // Validate operation-specific requirements
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

    // Create file manager
    const manager = new IdentityFileManager(
      ctx.config.mcpClient ?? null,
      ctx.config.dataRoot,
    );

    // Validate file first
    const validation = manager.validateFile(category, filename);
    if (validation) {
      return {
        toolCallId: ctx.toolCallId,
        content: validation.message,
        isError: true,
      };
    }

    // Perform the operation
    let result;

    switch (operation) {
      case "append":
        result = await manager.append(category, filename, content.trim());
        break;

      case "prepend":
        result = await manager.prepend(category, filename, content.trim());
        break;

      case "update_section":
        result = await manager.updateSection(
          category,
          filename,
          section!,
          content.trim(),
        );
        break;

      case "rewrite_section":
        result = await manager.rewriteSection(
          category,
          filename,
          section!,
          content.trim(),
        );
        break;

      default:
        return {
          toolCallId: ctx.toolCallId,
          content:
            `Error: Unknown operation '${operation}'. Valid operations: append, prepend, update_section, rewrite_section`,
          isError: true,
        };
    }

    return {
      toolCallId: ctx.toolCallId,
      content: result.message,
      isError: !result.success,
    };
  },
};

// =============================================================================
// list_identity_snapshots Tool
// =============================================================================

/**
 * The list_identity_snapshots tool allows viewing available snapshots for recovery.
 */
export const listIdentitySnapshotsTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "list_identity_snapshots",
      description:
        "View available snapshots of my identity files. Snapshots are created automatically by entity-core when identity files are written via MCP. I can use this to see what backups exist, or to find a previous version I might want to reference.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description:
              "Filter by category (self, user, or relationship). Omit to see all categories.",
            enum: CATEGORIES,
          },
          filename: {
            type: "string",
            description:
              "Filter by filename (e.g., 'my_identity.md'). Omit to see all files.",
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
    const category = args.category as IdentityCategory | undefined;
    const filename = args.filename as string | undefined;

    // Create file manager
    const manager = new IdentityFileManager(
      ctx.config.mcpClient ?? null,
      ctx.config.dataRoot,
    );

    try {
      const snapshots = await manager.listSnapshots(category, filename);

      if (snapshots.length === 0) {
        const filterDesc = category
          ? ` for ${category}${filename ? `/${filename}` : ""}`
          : "";
        return {
          toolCallId: ctx.toolCallId,
          content:
            `No snapshots found${filterDesc}. Snapshots are created automatically by entity-core when identity files are written.`,
          isError: false,
        };
      }

      // Format snapshot list
      const lines: string[] = ["Available identity file snapshots:\n"];

      let currentCategory = "";
      for (const snapshot of snapshots) {
        if (snapshot.category !== currentCategory) {
          currentCategory = snapshot.category;
          lines.push(`\n**${currentCategory}/**`);
        }
        lines.push(`  - ${snapshot.filename} (${snapshot.date})`);
      }

      lines.push(
        `\nTotal: ${snapshots.length} snapshot${
          snapshots.length === 1 ? "" : "s"
        }`,
      );

      return {
        toolCallId: ctx.toolCallId,
        content: lines.join("\n"),
        isError: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      return {
        toolCallId: ctx.toolCallId,
        content: `Error listing snapshots: ${errorMessage}`,
        isError: true,
      };
    }
  },
};
