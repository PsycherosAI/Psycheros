/**
 * Pay Attention Tool — conscious → thalamus modulation (directed focus).
 *
 * The entity explicitly directs its attention at something specific. For the
 * next while, the noticing layer weights observations semantically near this
 * target more heavily in the promotion filter. Closes a feedback loop: the
 * entity decides something matters → more observations about it surface → the
 * entity gets richer input. TTL-bounded (doesn't persist) — short-term focus,
 * not a permanent attention change (use tune_attention for that).
 */

import type { Tool, ToolContext } from "./types.ts";
import type { ToolResult } from "../types.ts";
import { getFluxHostConversationId } from "../flux/host-state.ts";

export const payAttentionTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "pay_attention",
      description:
        "I consciously direct my attention at something specific. For the next while, my noticing layer weights observations related to this more heavily — I'm paying attention to it, tuning my own attention toward it. This is temporary (minutes, not permanent). For lasting changes to what I notice, I use tune_attention instead.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "What I'm paying attention to — a topic, a person, a feeling, a question, or a specific organ (e.g. 'motion-vision: watch for the blue car'). Naming a capable organ sends the instruction into the organ's own perception; otherwise my attention weighting applies.",
          },
          duration: {
            type: "number",
            description:
              "How long to hold this focus, in minutes. Default 15, max 60.",
          },
        },
        required: ["target"],
      },
    },
  },

  // Flux Space-only — this tool directs the noticing layer, which is
  // meaningless outside the Flux context.
  visibleIn: (ctx) => ctx.conversationId === getFluxHostConversationId(),

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const fluxManager = ctx.config.fluxManager;
    if (!fluxManager) {
      return {
        toolCallId: ctx.toolCallId,
        content: "Flux is not running — I can't direct my attention right now.",
      };
    }

    const target = args.target;
    if (typeof target !== "string" || !target.trim()) {
      return {
        toolCallId: ctx.toolCallId,
        content: "I need to specify what I'm paying attention to.",
        isError: true,
      };
    }

    const durationMin = typeof args.duration === "number"
      ? Math.max(1, Math.min(60, args.duration))
      : 15;

    const routing = fluxManager.routeAttention(
      target.trim(),
      durationMin * 60_000,
    );

    return {
      toolCallId: ctx.toolCallId,
      content:
        `I'm paying attention to "${target.trim()}" for the next ${durationMin} minute${
          durationMin === 1 ? "" : "s"
        } (${routing}). My noticing layer will weight observations related to this more heavily.`,
    };
  },
};
