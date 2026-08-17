/**
 * Manage Message — entity-facing soft-delete + glitch-flag tool.
 *
 * The workspace-side write_entity_data already covers all 5 message ops
 * from OpenCode; this tool gives the entity in a workspace conversation a
 * direct path to trigger them.
 *
 * Operations:
 *   - delete: soft-delete (tombstone). Original content archived in
 *     metadata.tombstone for recovery. Hidden from ChatRAG/consolidation.
 *   - restore: undo a soft-delete. Pulls original content from the archive.
 *   - flag_glitched: marks message as corrupted (UI shows placeholder).
 *     Triggers the psycheros-repair-glitched-message workspace skill workflow.
 *   - clear_glitched: manual override. The repair skill auto-clears via
 *     content writes; this is for cases where the flag was set in error.
 *
 * First-person: the entity manages its own (or, rarely, the user's) messages.
 * Reversible — nothing is permanently destroyed without an explicit DB drop.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import { getWorkspaceSupervisor } from "../workspace/mod.ts";

type Operation = "delete" | "restore" | "flag_glitched" | "clear_glitched";

const VALID_OPS: ReadonlySet<Operation> = new Set([
  "delete",
  "restore",
  "flag_glitched",
  "clear_glitched",
]);

export const manageMessageTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "manage_message",
      description:
        "Soft-delete or flag a chat message. delete → tombstone (hidden from " +
        "my context, recoverable via restore). flag_glitched → marks a message " +
        "as corrupted so it can be repaired. Use when I realize a message was " +
        "wrong, harmful, or got garbled — the action is reversible.",
      parameters: {
        type: "object",
        properties: {
          message_id: {
            type: "string",
            description: "ID of the message to manage.",
          },
          operation: {
            type: "string",
            enum: ["delete", "restore", "flag_glitched", "clear_glitched"],
            description:
              "delete: soft-delete (tombstone). restore: undo delete. " +
              "flag_glitched: mark corrupted. clear_glitched: remove glitched flag.",
          },
          reason: {
            type: "string",
            description:
              "Optional reason. For delete, surfaced in the tombstone notice. " +
              "For flag_glitched, recorded for the repair workflow.",
          },
        },
        required: ["message_id", "operation"],
      },
    },
  },

  // Message maintenance belongs in a workspace where the approval flow,
  // skills, and coordination-layer entity-data tools all live. Hidden from
  // main chat — user-facing UI buttons (delete + flag-glitched on hover)
  // still call the HTTP endpoints directly without going through the tool.
  visibleIn: (ctx) => {
    const supervisor = getWorkspaceSupervisor();
    if (!supervisor) return false;
    return supervisor.getSessionByConversation(ctx.conversationId) !== null;
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const wrap = (content: string, isError = false): ToolResult => ({
      toolCallId: ctx.toolCallId,
      content,
      isError,
    });

    const messageId = String(args.message_id ?? "").trim();
    const operation = String(args.operation ?? "").trim() as Operation;
    const reason = typeof args.reason === "string"
      ? args.reason.trim() || undefined
      : undefined;

    if (!messageId) {
      return wrap("Missing required `message_id`.", true);
    }
    if (!VALID_OPS.has(operation)) {
      return wrap(
        `Invalid operation "${operation}". Must be one of: delete, restore, flag_glitched, clear_glitched.`,
        true,
      );
    }

    switch (operation) {
      case "delete": {
        const result = ctx.db.softDeleteMessage(messageId, {
          deletedBy: "entity",
          reason,
        });
        if (!result) {
          return wrap(`Message not found: ${messageId}`, true);
        }
        return wrap(
          `Message ${messageId} soft-deleted (tombstoned).${
            reason ? ` Reason: ${reason}` : ""
          } Original content archived in metadata.tombstone — restore with operation: "restore".`,
        );
      }
      case "restore": {
        const result = ctx.db.restoreMessage(messageId);
        if (!result) {
          return wrap(
            `Message not found or not deleted: ${messageId}. Restore only applies to soft-deleted (tombstoned) messages.`,
            true,
          );
        }
        return wrap(
          `Message ${messageId} restored. Original content recovered from metadata.tombstone.`,
        );
      }
      case "flag_glitched": {
        const ok = ctx.db.markGlitched(messageId, reason);
        if (!ok) {
          return wrap(`Message not found: ${messageId}`, true);
        }
        return wrap(
          `Message ${messageId} flagged as glitched.${
            reason ? ` Reason: ${reason}` : ""
          } The psycheros-repair-glitched-message skill can repair it via workspace.`,
        );
      }
      case "clear_glitched": {
        const ok = ctx.db.clearGlitched(messageId);
        if (!ok) {
          return wrap(`Message not found: ${messageId}`, true);
        }
        return wrap(`Message ${messageId} glitched flag cleared.`);
      }
    }
  },
};
