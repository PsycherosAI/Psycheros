/**
 * Ask User — standalone tool for escalating questions to the user from
 * inside an engaged workspace session.
 *
 * In engaged mode, the entity (workspace-context) mediates between OpenCode
 * and the user. When the entity needs input only the user can provide, it
 * calls this tool — NOT the workspace omni-tool's ask_origin_conversation
 * action (too buried as one of 9 enum actions to reliably trigger).
 *
 * This tool does NOT block on the answer. It enqueues the query + broadcasts
 * a toast via SSE, then returns immediately. The engaged-runner detects the
 * pending query after this turn ends and suspends the loop. The user's answer
 * resumes the session via /api/workspace/sessions/:id/respond →
 * supervisor.resumeSession.
 *
 * Only functional when the entity is running inside a workspace conversation
 * (sourceType: "workspace") with mode "engaged". Graceful no-op otherwise.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import { getWorkspaceSupervisor } from "../workspace/mod.ts";

export const askUserTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user a question directly. Only works inside an engaged workspace " +
        "session — the question appears as a toast in their browser, their answer " +
        "comes back to me immediately. Use when I need info only the user has " +
        "(real-time state, preferences, decisions). This is the only way to reach " +
        "the user from inside the workspace.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to ask the user.",
          },
        },
        required: ["question"],
      },
    },
  },

  // Hide from main chat and from sync/async workspace turns — ask_user only
  // resolves correctly when an engaged-runner is on the other end to suspend
  // and resume the loop on the pending query.
  visibleIn: (ctx) => {
    const supervisor = getWorkspaceSupervisor();
    if (!supervisor) return false;
    const session = supervisor.getSessionByConversation(ctx.conversationId);
    return !!session && session.mode === "engaged";
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

    const question = String(args.question ?? "").trim();
    if (!question) {
      return wrap("Missing required `question` for ask_user.", true);
    }

    const supervisor = getWorkspaceSupervisor();
    if (!supervisor) {
      return wrap(
        "ask_user requires the workspace supervisor to be initialized.",
        true,
      );
    }

    // Look up the workspace session by the current conversation. No session_id
    // needed from the entity — the handler uses the conversation context.
    const session = supervisor.getSessionByConversation(ctx.conversationId);
    if (!session) {
      return wrap(
        "ask_user only works inside an engaged workspace session. " +
          "This conversation is not a workspace conversation.",
      );
    }
    if (session.mode !== "engaged") {
      return wrap(
        `ask_user is only meaningful in engaged mode. This session is mode=${session.mode}.`,
      );
    }

    // Enqueue the query and block on the response. The workspace stays
    // RUNNING with the OpenCode process alive on this tool call while the
    // user answers. The toast idle timer drives the suspend — if the user
    // doesn't engage for 5 min, the client POSTs /suspend, which calls
    // signalSuspend() to resolve this wait with the query still pending. The
    // 30-min hard cap is a safety net.
    const { getQueryQueue } = await import("../workspace/mod.ts");
    const queue = getQueryQueue();
    const query = queue.enqueue({
      sessionId: session.id,
      conversationId: session.conversationId,
      originConversationId: session.originConversationId ?? null,
      question,
    });

    const resolved = await queue.waitForAnswer(query.id, 30 * 60_000);

    if (resolved.status === "answered" && resolved.answer) {
      return wrap(`User answered: ${resolved.answer}`);
    }
    // Query still pending after wait resolved = signalSuspend was called
    // (toast idle timer fired). My turn will end naturally; the engaged-runner
    // detects the pending query and suspends the loop. The user can still
    // answer via the FAB `!` recovery path.
    return wrap(
      `Question timed out — workspace suspending until the user answers via the workspace indicator. ` +
        `(session ${session.id})`,
      true,
    );
  },
};
