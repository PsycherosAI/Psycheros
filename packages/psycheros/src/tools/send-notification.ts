/**
 * Send Notification Tool
 *
 * Allows the entity to send push notifications to the user's device.
 * Works even when the app is closed — tapping the notification
 * opens Psycheros directly to the conversation.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import {
  deleteSubscription,
  getSubscriptions,
  loadOrGenerateKeys,
  parseSubscription,
  type PushPayload,
  sendPushNotification,
} from "../push/mod.ts";

/**
 * The send_notification tool lets the entity push notifications to the user.
 */
export const sendNotificationTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "send_notification",
      description:
        "Send a push notification to the user's device. I use this when I have something important to share and the user may not be actively looking at my chat interface.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "A short notification title (e.g., 'Thinking of you', 'Check this out')",
          },
          body: {
            type: "string",
            description:
              "The notification body text, up to ~200 characters. This is what the user sees on their lock screen.",
          },
          conversation_id: {
            type: "string",
            description:
              "Optional conversation ID to link the notification to. Tapping the notification will open this conversation.",
          },
        },
        required: ["title", "body"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const title = args.title;
    const body = args.body;
    const conversationId = args.conversation_id;

    // Validate arguments
    if (typeof title !== "string" || title.trim().length === 0) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "Error: 'title' argument is required and must be a non-empty string",
        isError: true,
      };
    }

    if (typeof body !== "string" || body.trim().length === 0) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "Error: 'body' argument is required and must be a non-empty string",
        isError: true,
      };
    }

    try {
      const db = ctx.db.getRawDb();
      const subscriptions = getSubscriptions(db);
      console.log(
        `[Push] send_notification called — ${subscriptions.length} subscription(s) found`,
      );

      if (subscriptions.length === 0) {
        return {
          toolCallId: ctx.toolCallId,
          content:
            "No devices are subscribed to push notifications. The user hasn't granted notification permission or the app hasn't registered for push.",
          isError: false,
        };
      }

      // Load VAPID keys
      const vapidKeys = await loadOrGenerateKeys(ctx.config.dataRoot);

      const payload: PushPayload = {
        title: title.trim().substring(0, 100),
        body: body.trim().substring(0, 200),
        ...(conversationId ? { conversationId: String(conversationId) } : {}),
      };

      let successCount = 0;
      let failedCount = 0;

      for (const record of subscriptions) {
        try {
          const subscription = parseSubscription(record);
          const sent = await sendPushNotification(
            subscription,
            payload,
            vapidKeys,
          );
          if (sent) {
            successCount++;
          } else {
            // Subscription expired — clean up
            deleteSubscription(db, record.endpoint);
            failedCount++;
          }
        } catch {
          failedCount++;
        }
      }

      const parts = [
        `Sent notification to ${successCount} device${
          successCount !== 1 ? "s" : ""
        }`,
      ];
      if (failedCount > 0) {
        parts.push(
          `(cleaned up ${failedCount} expired subscription${
            failedCount !== 1 ? "s" : ""
          })`,
        );
      }

      return {
        toolCallId: ctx.toolCallId,
        content: parts.join(" "),
        isError: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      console.error("[Push] Failed to send notification:", errorMessage);
      return {
        toolCallId: ctx.toolCallId,
        content: `Error sending notification: ${errorMessage}`,
        isError: true,
      };
    }
  },
};
