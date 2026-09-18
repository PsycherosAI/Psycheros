/**
 * Vault Tool (Omni)
 *
 * Unified tool for managing Data Vault documents — create, read, append,
 * list, and search. Replaces the previous 5 separate vault tools with a
 * single tool using an operation discriminator.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import { VaultManager } from "../vault/mod.ts";
import { findNearDuplicateTitle } from "../vault/title-match.ts";

/**
 * Helper to get the VaultManager from the tool context.
 */
function getVaultManager(ctx: ToolContext): VaultManager | null {
  const config = ctx.config as unknown as Record<string, unknown>;
  const vm = config.vaultManager;
  return vm instanceof VaultManager ? vm : null;
}

// =============================================================================
// Tool Definition
// =============================================================================

export const vaultTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "vault",
      description:
        "Manage documents in my Data Vault — create, read, append, rewrite, list, and search. I use this to store reference material, notes, or any persistent content I want to search later. All vault documents are global — available across every chat.\n\nOperations:\n- 'write': create a NEW document. Errors if a document with the same title already exists — use 'append' or 'rewrite' instead.\n- 'append': add content to an existing document (creates it if missing). This is the DEFAULT for adding information.\n- 'rewrite': DESTRUCTIVE — replaces the entire document content. Only use when existing content is actively wrong or redundant and needs to be removed, not just to reorganize.\n- 'read': get full document content.\n- 'list': see all documents.\n- 'search': find relevant content by semantic search.\n\nPrefer 'append' over 'rewrite' in almost all cases. 'rewrite' should only be used as a last resort.",
      parameters: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["write", "read", "append", "rewrite", "list", "search"],
            description:
              "The operation to perform. 'write' creates a new document (errors if it exists), 'read' gets full content, 'append' adds content (creates if missing), 'rewrite' replaces entire document (DESTRUCTIVE — use sparingly), 'list' shows all documents, 'search' finds relevant content.",
          },
          title: {
            type: "string",
            description:
              "Document title (for write, read, append, rewrite, search)",
          },
          content: {
            type: "string",
            description:
              "Document content in markdown (for write, append, rewrite)",
          },
          // Scope selection disabled — all vault documents are global. To revive,
          // uncomment this block and restore the args.scope reads in each op below.
          // scope: {
          //   type: "string",
          //   enum: ["global", "chat", "all"],
          //   description:
          //     "Document scope. 'global' (all chats), 'chat' (this conversation), 'all' (list only, shows both). Default: 'global' for write/read/append/rewrite, 'all' for list.",
          // },
          query: {
            type: "string",
            description: "Search query (for search operation)",
          },
          max_results: {
            type: "number",
            description: "Max search results (default: 5)",
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
          "Error: 'operation' is required. Use one of: write, read, append, rewrite, list, search.",
        isError: true,
      };
    }

    const vaultManager = getVaultManager(ctx);
    if (!vaultManager) {
      return {
        toolCallId: ctx.toolCallId,
        content: "Error: Data Vault is not available",
        isError: true,
      };
    }

    try {
      switch (operation) {
        case "write":
          return await executeWrite(args, ctx, vaultManager);
        case "read":
          return await executeRead(args, ctx, vaultManager);
        case "append":
          return await executeAppend(args, ctx, vaultManager);
        case "rewrite":
          return await executeRewrite(args, ctx, vaultManager);
        case "list":
          return executeList(args, ctx, vaultManager);
        case "search":
          return await executeSearch(args, ctx, vaultManager);
        default:
          return {
            toolCallId: ctx.toolCallId,
            content:
              `Error: Unknown operation '${operation}'. Use one of: write, read, append, rewrite, list, search.`,
            isError: true,
          };
      }
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      console.error(`[Vault] ${operation} failed:`, errorMessage);
      return {
        toolCallId: ctx.toolCallId,
        content: `Error: ${errorMessage}`,
        isError: true,
      };
    }
  },
};

// =============================================================================
// Operation Implementations
// =============================================================================

async function executeWrite(
  args: Record<string, unknown>,
  ctx: ToolContext,
  vaultManager: VaultManager,
): Promise<ToolResult> {
  const title = args.title;
  const content = args.content;
  // Scope is locked to global. To revive chat/all scope, restore:
  //   const scope = (args.scope as "global" | "chat") || "global";
  const scope = "global";

  if (typeof title !== "string" || title.trim().length === 0) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: 'title' is required and must be non-empty",
      isError: true,
    };
  }
  if (typeof content !== "string" || content.trim().length === 0) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: 'content' is required and must be non-empty",
      isError: true,
    };
  }

  const duplicateTitle = findNearDuplicateTitle(
    title.trim(),
    vaultManager.listDocuments({ scope }).map((d) => d.title),
  );

  if (duplicateTitle !== null) {
    return {
      toolCallId: ctx.toolCallId,
      content:
        `Error: A document titled "${duplicateTitle}" already covers this title. Use 'append' to add content or 'rewrite' to replace it - writing with a near-identical title forks the document and loses history.`,
      isError: true,
    };
  }

  const result = await vaultManager.createFromContent(
    title.trim(),
    content.trim(),
    {
      scope,
      // conversationId: scope === "chat" ? ctx.conversationId : undefined,
    },
  );

  return {
    toolCallId: ctx.toolCallId,
    content:
      `Created vault document "${title.trim()}" (${result.chunkCount} chunks)`,
    isError: false,
  };
}

async function executeRead(
  args: Record<string, unknown>,
  _ctx: ToolContext,
  vaultManager: VaultManager,
): Promise<ToolResult> {
  const title = args.title;
  // Scope is locked to global. To revive:
  //   const scope = (args.scope as "global" | "chat") || "global";
  const scope = "global";

  if (typeof title !== "string" || title.trim().length === 0) {
    return {
      toolCallId: _ctx.toolCallId,
      content: "Error: 'title' is required and must be non-empty",
      isError: true,
    };
  }

  const existing = vaultManager.listDocuments({ scope }).find(
    (d) => d.title === title.trim(),
  );

  if (!existing) {
    return {
      toolCallId: _ctx.toolCallId,
      content: `Document "${title.trim()}" not found.`,
      isError: true,
    };
  }

  const content = await Deno.readTextFile(existing.filePath);

  return {
    toolCallId: _ctx.toolCallId,
    content:
      `"${existing.title}" (${existing.chunkCount} chunks):\n\n${content}`,
    isError: false,
  };
}

async function executeAppend(
  args: Record<string, unknown>,
  ctx: ToolContext,
  vaultManager: VaultManager,
): Promise<ToolResult> {
  const title = args.title;
  const content = args.content;
  // Scope is locked to global. To revive:
  //   const scope = (args.scope as "global" | "chat") || "global";
  const scope = "global";

  if (typeof title !== "string" || title.trim().length === 0) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: 'title' is required and must be non-empty",
      isError: true,
    };
  }
  if (typeof content !== "string" || content.trim().length === 0) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: 'content' is required and must be non-empty",
      isError: true,
    };
  }

  // Near-duplicate resolution: append targeting a title that differs only
  // cosmetically ("(updated 4/5)" vs "(started 4/3/2026)") must land on the
  // existing document, not fork a new one. The matched title is reported so
  // the model can see which document it actually hit.
  const duplicateTitle = findNearDuplicateTitle(
    title.trim(),
    vaultManager.listDocuments({ scope }).map((d) => d.title),
  );
  const existing = duplicateTitle === null
    ? undefined
    : vaultManager.listDocuments({ scope }).find((d) =>
      d.title === duplicateTitle
    );

  if (!existing) {
    const result = await vaultManager.createFromContent(
      title.trim(),
      content.trim(),
      {
        scope,
        // conversationId: scope === "chat" ? ctx.conversationId : undefined,
      },
    );
    return {
      toolCallId: ctx.toolCallId,
      content:
        `Created vault document "${title.trim()}" (${result.chunkCount} chunks)`,
      isError: false,
    };
  }

  const currentContent = await Deno.readTextFile(existing.filePath);
  const combined = `${currentContent}\n\n${content.trim()}`;
  const result = await vaultManager.updateDocument(existing.id, {
    content: combined,
  });

  const appendedTo = existing.title;
  return {
    toolCallId: ctx.toolCallId,
    content: `Appended to vault document "${appendedTo}" (${
      result?.chunkCount ?? 0
    } chunks)`,
    isError: false,
  };
}

async function executeRewrite(
  args: Record<string, unknown>,
  ctx: ToolContext,
  vaultManager: VaultManager,
): Promise<ToolResult> {
  const title = args.title;
  const content = args.content;
  // Scope is locked to global. To revive:
  //   const scope = (args.scope as "global" | "chat") || "global";
  const scope = "global";

  if (typeof title !== "string" || title.trim().length === 0) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: 'title' is required and must be non-empty",
      isError: true,
    };
  }
  if (typeof content !== "string" || content.trim().length === 0) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: 'content' is required and must be non-empty",
      isError: true,
    };
  }

  // Near-duplicate resolution (same rationale as append): a rewrite under a
  // cosmetically different title should replace the existing document, not
  // error as "not found" and push the model toward forking with write.
  const duplicateTitle = findNearDuplicateTitle(
    title.trim(),
    vaultManager.listDocuments({ scope }).map((d) => d.title),
  );
  const existing = duplicateTitle === null
    ? undefined
    : vaultManager.listDocuments({ scope }).find((d) =>
      d.title === duplicateTitle
    );

  if (!existing) {
    return {
      toolCallId: ctx.toolCallId,
      content:
        `Error: Document "${title.trim()}" not found. Use 'write' to create a new document.`,
      isError: true,
    };
  }

  const result = await vaultManager.updateDocument(existing.id, {
    title: title.trim(),
    content: content.trim(),
  });

  return {
    toolCallId: ctx.toolCallId,
    content: `Rewrote vault document "${existing.title}" (${
      result?.chunkCount ?? 0
    } chunks)`,
    isError: false,
  };
}

function executeList(
  args: Record<string, unknown>,
  ctx: ToolContext,
  vaultManager: VaultManager,
): ToolResult {
  const scope = (args.scope as "global" | "chat" | "all") || "all";

  const docs = vaultManager.listDocuments({
    scope,
    conversationId: ctx.conversationId,
  });

  if (docs.length === 0) {
    return {
      toolCallId: ctx.toolCallId,
      content: "No documents found in the Data Vault.",
      isError: false,
    };
  }

  const lines = docs.map((d, i) => {
    // Scope label suppressed — scope selection is disabled, so showing
    // [global]/[chat] tags would only invite questions about a scope the
    // entity can no longer pick. Restore when scope selection is revived.
    // const scopeLabel = d.scope === "global" ? "[global]" : "[chat]";
    const sourceLabel = d.source === "entity" ? "entity" : "upload";
    return `${
      i + 1
    }. "${d.title}" (${sourceLabel}, ${d.chunkCount} chunks, ${d.fileType})`;
  });

  return {
    toolCallId: ctx.toolCallId,
    content: `Data Vault (${docs.length} documents):\n${lines.join("\n")}`,
    isError: false,
  };
}

async function executeSearch(
  args: Record<string, unknown>,
  ctx: ToolContext,
  vaultManager: VaultManager,
): Promise<ToolResult> {
  const query = args.query;
  const maxResults = typeof args.max_results === "number"
    ? args.max_results
    : 5;

  if (typeof query !== "string" || query.trim().length === 0) {
    return {
      toolCallId: ctx.toolCallId,
      content: "Error: 'query' is required and must be non-empty",
      isError: true,
    };
  }

  const results = await vaultManager.search(query, {
    conversationId: ctx.conversationId,
    maxChunks: maxResults,
    minScore: 0.3,
  });

  if (results.length === 0) {
    return {
      toolCallId: ctx.toolCallId,
      content: "No relevant content found in the Data Vault.",
      isError: false,
    };
  }

  const parts = results.map((r, i) => {
    const pct = Math.round(r.score * 100);
    return `[${
      i + 1
    }] "${r.documentTitle}" (${pct}% relevant):\n${r.chunk.content}`;
  });

  return {
    toolCallId: ctx.toolCallId,
    content: `Found ${results.length} results:\n\n${parts.join("\n\n---\n\n")}`,
    isError: false,
  };
}
