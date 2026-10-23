/**
 * Mindfulness Tool — conscious → surfaces ambient texture (receptive attention).
 *
 * The entity surveys the felt texture of its recent experience. Returns both
 * texture scales (15-minute close-up + 1-hour landscape) plus the current mood
 * state. This is the ambient/receptive attentional mode vs pay_attention's
 * focused/directed mode — "what's the texture of the last while?" not "look at
 * this specific thing." Gives the entity a moment of reflection on its own
 * interior before responding.
 */

import type { Tool, ToolContext } from "./types.ts";
import type { ToolResult } from "../types.ts";
import { getFluxHostConversationId } from "../flux/host-state.ts";

export const mindfulnessTool: Tool = {
  // Flux Space-only — this tool surveys the noticing layer, which is
  // meaningless outside the Flux context.
  visibleIn: (ctx) => ctx.conversationId === getFluxHostConversationId(),

  definition: {
    type: "function",
    function: {
      name: "mindfulness",
      description:
        "I take a moment to feel the texture of my recent experience — the felt quality of the last while, not any one thing in it. What's the shape of my attention, my mood, my interior right now? This is receptive, ambient attention — surveying where I am, not directing where I look.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },

  execute: async (
    _args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const fluxManager = ctx.config.fluxManager;
    if (!fluxManager) {
      return {
        toolCallId: ctx.toolCallId,
        content: "Flux is not running — I can't survey my interior right now.",
      };
    }

    const recent = fluxManager.getTextureSummary();
    const longform = fluxManager.getLongformTextureSummary();
    // Felt render: models see band words,
    // never the numeric readout.
    const mood = fluxManager.renderMoodFelt();

    const sections: string[] = [];

    if (longform) {
      sections.push(`My texture of the last hour:\n${longform}`);
    }
    if (recent) {
      sections.push(`My texture of the last 15 minutes:\n${recent}`);
    }
    if (mood) {
      // Attribution is load-bearing: a possessor-less mood render gets
      // attributed to the user. The feeling is the entity's own.
      sections.push(mood);
    }

    if (sections.length === 0) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "I don't have enough experience yet to feel a texture — my interior is quiet, nothing has accumulated.",
      };
    }

    return {
      toolCallId: ctx.toolCallId,
      content: sections.join("\n\n---\n\n"),
    };
  },
};
