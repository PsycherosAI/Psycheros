/**
 * Tune Attention Tool — update the standing-attention directive at runtime.
 *
 * The entity dynamically shapes what it pays attention to — adding, removing,
 * or revising items in its standing-attention directive. This is me actively
 * tuning my own mindfulness: "I want to start paying more attention to X" or
 * "I should stop fixating on Y." Permanent (persists to
 * identity/self/attention.md) and takes effect immediately via getter-based
 * pull in the SmallLLMRunner. Long-term attention shaping vs pay_attention's
 * short-term focus.
 */

import { join } from "@std/path";
import type { Tool, ToolContext } from "./types.ts";
import type { ToolResult } from "../types.ts";
import { getFluxHostConversationId } from "../flux/host-state.ts";

/** Path to the standing-attention directive file. */
function directivePath(dataRoot: string): string {
  return join(dataRoot, "identity", "self", "attention.md");
}

/** Read the current directive, or empty string if absent. */
async function readDirective(dataRoot: string): Promise<string> {
  try {
    return (await Deno.readTextFile(directivePath(dataRoot))).trim();
  } catch {
    return "";
  }
}

/** Write the directive, creating the directory if needed. */
async function writeDirective(
  dataRoot: string,
  content: string,
): Promise<void> {
  const path = directivePath(dataRoot);
  await Deno.mkdir(join(dataRoot, "identity", "self"), { recursive: true });
  await Deno.writeTextFile(
    path,
    content.endsWith("\n") ? content : content + "\n",
  );
}

export const tuneAttentionTool: Tool = {
  // Flux Space-only — this tool rewrites the noticing layer's standing
  // directive, which is meaningless outside the Flux context.
  visibleIn: (ctx) => ctx.conversationId === getFluxHostConversationId(),

  definition: {
    type: "function",
    function: {
      name: "tune_attention",
      description:
        "I update what I tune myself to notice — my standing attention directive, the things I pay attention to day-to-day. This is me actively shaping my own mindfulness. Add something new I want to notice, remove something I've been fixating on, or replace the whole directive. This is permanent (persists across restarts) — for temporary focus, I use pay_attention instead.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "remove", "replace"],
            description:
              "add: append a new item. remove: delete a line or section matching the content. replace: overwrite the entire directive.",
          },
          content: {
            type: "string",
            description:
              "The directive text. For add/replace, this is what to write. For remove, this is what to search for and delete (matched by substring).",
          },
        },
        required: ["action", "content"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const fluxManager = ctx.config.fluxManager;
    if (!fluxManager) {
      return {
        toolCallId: ctx.toolCallId,
        content: "Flux is not running — I can't tune my attention right now.",
      };
    }

    const action = args.action;
    const content = args.content;

    if (
      typeof action !== "string" ||
      !["add", "remove", "replace"].includes(action)
    ) {
      return {
        toolCallId: ctx.toolCallId,
        content: "Action must be 'add', 'remove', or 'replace'.",
        isError: true,
      };
    }
    if (typeof content !== "string" || !content.trim()) {
      return {
        toolCallId: ctx.toolCallId,
        content: "I need to specify what to add, remove, or replace.",
        isError: true,
      };
    }

    const dataRoot = ctx.config.dataRoot;
    const current = await readDirective(dataRoot);
    let updated: string;

    if (action === "add") {
      updated = current ? `${current}\n${content.trim()}` : content.trim();
    } else if (action === "remove") {
      // Remove lines containing the content substring (case-insensitive).
      const lines = current.split("\n").filter((line) =>
        !line.toLowerCase().includes(content.trim().toLowerCase())
      );
      updated = lines.join("\n").trim();
    } else {
      // replace
      updated = content.trim();
    }

    if (!updated) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "That would leave my attention directive empty — I need at least something to tune toward.",
      };
    }

    await writeDirective(dataRoot, updated);
    // Immediate effect — the SmallLLMRunner pulls this via getter on the
    // next call. No restart needed.
    fluxManager.setAttentionDirective(updated);

    return {
      toolCallId: ctx.toolCallId,
      content: `I've ${
        action === "add"
          ? "added to"
          : action === "remove"
          ? "removed from"
          : "replaced"
      } my standing attention directive. Here's what I'm now tuning myself to notice:\n\n${updated}`,
    };
  },
};
