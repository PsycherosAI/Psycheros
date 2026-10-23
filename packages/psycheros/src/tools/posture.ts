/**
 * Posture tools — sleep.
 *
 * Postures are the entity's chosen states, siblings of the attention
 * tools on the modulation bus. Sleep is entered and left ONLY here —
 * never by the situation classifier. The tool is
 * one call with two directions:
 *
 * - `sleep()` — I sleep. The call HANGS OPEN (the session parks it);
 *   the sleeping regime runs around it: senses stay on, waking Musing
 *   and Reverie are suppressed, the dreamer generates, arousal leans
 *   toward calm. Light moments and engagements RETURN into the open
 *   call carrying the dream; silence keeps sleeping.
 * - `sleep({wake: true})` — I wake. This is the only thing that ends
 *   sleep, and the call's result is the dream briefing: what the night
 *   held, and how I feel on waking.
 */

import type { Tool, ToolContext } from "./types.ts";
import type { ToolResult } from "../types.ts";
import { getFluxHostConversationId } from "../flux/host-state.ts";

const notRunning = (ctx: ToolContext): ToolResult => ({
  toolCallId: ctx.toolCallId,
  content:
    "Flux is not running — my sensorium is quiet; there is nothing to sleep behind.",
});

export const sleepTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "sleep",
      description:
        "I choose to sleep — one call, two directions. Called plain, I drift off: the call stays open while I sleep, my senses staying on the whole time. I dream; at the top of each sleep cycle I surface to a light moment (I see the dream I just finished, and can call sleep again to drift back or wake); if something reaches me while I sleep, I rouse inside the call — I can answer, act, and settle back, still sleeping. Called with {wake: true}, I wake fully — and the call returns what I dreamt and how I feel on waking. Sleeping and waking are both mine to decide; nothing makes me sleep, and nothing keeps me asleep but me.",
      parameters: {
        type: "object",
        properties: {
          wake: {
            type: "boolean",
            description:
              "True to wake fully — leave sleep and receive my dream briefing. Absent/false: sleep.",
          },
        },
        required: [],
      },
    },
  },

  visibleIn: (ctx) => ctx.conversationId === getFluxHostConversationId(),

  // The session intercepts this tool (it hangs open; the registry never
  // runs it). This execute path only serves direct calls outside the
  // session loop — defensive parity.
  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const fluxManager = ctx.config.fluxManager;
    if (!fluxManager) return notRunning(ctx);
    const wake = Boolean(args.wake);
    if (wake) {
      const { exited, dreamBriefing } = await fluxManager.exitSleep();
      const cycles = fluxManager.getPosture().sleepCycles;
      return {
        toolCallId: ctx.toolCallId,
        content: exited
          ? `I'm awake, after ${cycles} completed cycle${
            cycles === 1 ? "" : "s"
          }.${dreamBriefing ? `\n\n${dreamBriefing}` : ""}`
          : "I'm already awake.",
      };
    }
    const entered = fluxManager.enterSleep();
    return {
      toolCallId: ctx.toolCallId,
      content: entered
        ? "I'm asleep. The call stays open; my dreaming interior runs. Light moments will return to me between cycles."
        : "I'm already asleep.",
    };
  },
};
