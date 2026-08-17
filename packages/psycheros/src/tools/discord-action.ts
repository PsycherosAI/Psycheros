/**
 * Discord Action Tool
 *
 * The entity uses this tool to act in the current Discord channel — send
 * messages, thread replies, and add emoji reactions. Each call takes an array
 * of actions. A single action can include content (reply), emoji (react), or
 * both — combined on the same target message. If I have nothing to add, I
 * simply don't call this tool — no message will be sent.
 */

import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import type { DiscordSettings } from "../llm/discord-settings.ts";
import { encodeEmojiForApi, splitMessage } from "../discord/response.ts";
import { resolveDiscordImagePath } from "./discord-image-path.ts";
import { sendDiscordAttachments } from "../plugins/mod.ts";

const DISCORD_MAX_MESSAGE_LENGTH = 2000;
/** A hung send must never stall the global tool mutex indefinitely. */
const SEND_TIMEOUT_MS = 15_000;

/**
 * The act_in_discord tool lets the entity interact with Discord during a turn.
 */
export const actInDiscordTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "act_in_discord",
      description:
        "I use this tool to act in the current Discord channel. I pass an 'actions' array — I should batch everything I want to do into a single call (reply to multiple messages, react to several, or mix both). Each action can include 'content' (to send a message), 'image_path' (to attach an image alongside or instead of text), 'emoji' (to react, one or more), or both on the same 'message_id'. If I have nothing to add, I simply don't call this tool — no message will be sent.",
      parameters: {
        type: "object",
        properties: {
          actions: {
            type: "array",
            description:
              "All the actions I want to take right now. I should include everything in one array rather than making multiple tool calls — for example: reply to one message, react to another, and send a plain message, all in one call.",
            items: {
              type: "object",
              properties: {
                message_id: {
                  type: "string",
                  description:
                    "The Discord message ID to target. If I include 'content', my reply threads under this message. If I include 'emoji', I react to this message. Omit to send a plain channel message (no threading).",
                },
                content: {
                  type: "string",
                  description:
                    "The text to send as a message. Discord has a 2000-character limit; I keep my messages concise. If 'message_id' is set, this replies under that message.",
                },
                image_path: {
                  type: "string",
                  description:
                    "Optional path to an image file to attach, relative to .psycheros/ (e.g. 'generated-images/abc.png'). When I just called generate_image, the tool result returns this path verbatim on a 'File path:' line — I pass that exact string through unchanged. Sent alongside 'content' (either may be omitted).",
                },
                emoji: {
                  oneOf: [
                    { type: "string" },
                    { type: "array", items: { type: "string" } },
                  ],
                  description:
                    "One or more emoji to react with on the target message. Requires 'message_id'. Custom server emoji: name:id format (e.g. rofl:123456789).",
                },
              },
            },
          },
        },
        required: ["actions"],
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const discordSettings = ctx.config.discordSettings as
      | DiscordSettings
      | undefined;
    const discordContext = ctx.config.discordContext;

    if (!discordContext) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "This tool is only available during Discord turns. I cannot use it here.",
        isError: true,
      };
    }

    if (!discordSettings?.botToken) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "Discord bot token is not configured. I cannot act in Discord without it.",
        isError: true,
      };
    }

    const actions = args.actions;
    if (!Array.isArray(actions) || actions.length === 0) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "I need to provide at least one action in the 'actions' array.",
        isError: true,
      };
    }

    const channelId = discordContext.channelId;
    const headers = {
      "Authorization": `Bot ${discordSettings.botToken}`,
      "Content-Type": "application/json",
    };

    const results: string[] = [];
    let hadError = false;

    for (let actionIndex = 0; actionIndex < actions.length; actionIndex++) {
      const action = actions[actionIndex];
      const hasContent = typeof action.content === "string" &&
        action.content.trim().length > 0;
      const emojis = normalizeEmojis(action.emoji);
      const messageId = typeof action.message_id === "string" &&
          action.message_id.trim()
        ? action.message_id.trim()
        : undefined;
      const imagePath = typeof action.image_path === "string" &&
          action.image_path.trim()
        ? action.image_path.trim()
        : undefined;

      if (!hasContent && emojis.length === 0 && !imagePath) {
        results.push(
          "Action has no 'content', 'image_path', or 'emoji' — nothing to do. Skipping.",
        );
        hadError = true;
        continue;
      }

      // Resolve the image (if any) before sending — a bad path or unreadable
      // file skips only this action, never the rest of the batch.
      let image:
        | {
          path: string;
          filename: string;
          contentType: string;
          data: Uint8Array;
        }
        | undefined;
      if (imagePath) {
        try {
          const resolved = resolveDiscordImagePath(
            ctx.config.dataRoot,
            imagePath,
          );
          image = {
            path: imagePath,
            filename: resolved.filename,
            contentType: resolved.mediaType,
            data: await Deno.readFile(resolved.absolutePath),
          };
        } catch (error) {
          results.push(
            `Image for this action is unavailable: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          hadError = true;
          continue;
        }
      }

      // Send reply if content (or an image) is present
      if (hasContent || image) {
        const result = await executeReply(
          action,
          channelId,
          headers,
          discordSettings.botToken,
          image,
          `${ctx.toolCallId}:${actionIndex}`,
        );
        results.push(result.content);
        if (result.isError) hadError = true;
      }

      // Add reactions if emoji is present
      if (emojis.length > 0) {
        if (!messageId) {
          results.push(
            "Reactions require 'message_id' to know which message to react to. Skipping.",
          );
          hadError = true;
        } else {
          for (const e of emojis) {
            const result = await executeReact(
              e,
              messageId,
              channelId,
              headers,
            );
            results.push(result.content);
            if (result.isError) hadError = true;
          }
        }
      }
    }

    return {
      toolCallId: ctx.toolCallId,
      content: results.join("\n"),
      isError: hadError,
    };
  },
};

/**
 * Normalize the emoji field — accept a string or array of strings.
 */
function normalizeEmojis(raw: unknown): string[] {
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  if (Array.isArray(raw)) {
    return raw.filter((e): e is string =>
      typeof e === "string" && e.trim() !== ""
    )
      .map((e) => e.trim());
  }
  return [];
}

/**
 * Send a message to the Discord channel, optionally with an image attachment
 * and threaded under a message.
 */
async function executeReply(
  action: Record<string, unknown>,
  channelId: string,
  headers: Record<string, string>,
  botToken: string,
  image?: {
    path: string;
    filename: string;
    contentType: string;
    data: Uint8Array;
  },
  idempotencyKey?: string,
): Promise<ToolResult> {
  const content = typeof action.content === "string"
    ? action.content.trim()
    : "";

  // Strip entity timestamp tags
  const cleaned = content.replace(/<t>[^<]*<\/t>/g, "").replace(
    /<t:\d+[^\s>]*>/g,
    "",
  ).trim();

  if (!cleaned && !image) {
    return {
      toolCallId: "",
      content: "Reply content is empty after cleaning.",
      isError: true,
    };
  }

  const messageId = typeof action.message_id === "string" &&
      action.message_id.trim()
    ? action.message_id.trim()
    : undefined;

  try {
    const chunks = cleaned
      ? splitMessage(cleaned, DISCORD_MAX_MESSAGE_LENGTH)
      : [""];
    const sentIds: string[] = [];

    for (let i = 0; i < chunks.length; i++) {
      // The image rides on the first chunk via the multipart sender.
      if (i === 0 && image) {
        const { messageIds } = await sendDiscordAttachments(
          {
            channelId,
            content: chunks[i] || undefined,
            messageReferenceId: messageId,
            idempotencyKey,
            files: [{
              filename: image.filename,
              contentType: image.contentType,
              data: image.data,
            }],
          },
          { token: botToken },
        );
        sentIds.push(...messageIds);
      } else {
        const body: Record<string, unknown> = { content: chunks[i] };
        // Only the first chunk gets the reply reference
        if (i === 0 && messageId) {
          body.message_reference = {
            message_id: messageId,
            channel_id: channelId,
          };
        }

        const resp = await fetch(
          `https://discord.com/api/v10/channels/${channelId}/messages`,
          {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          },
        );

        if (!resp.ok) {
          const errorBody = await resp.text();

          if (resp.status === 429) {
            const retryAfter = resp.headers.get("Retry-After");
            const delay = retryAfter ? parseFloat(retryAfter) * 1000 : 5000;
            return {
              toolCallId: "",
              content: `Reply rate limited (429). Retry after ${
                Math.round(delay)
              }ms.`,
              isError: true,
            };
          }

          return {
            toolCallId: "",
            content: `Reply failed: ${resp.status} ${
              errorBody.substring(0, 200)
            }`,
            isError: true,
          };
        }

        const data = await resp.json() as { id: string };
        sentIds.push(data.id);
      }

      // Delay between chunks
      if (i < chunks.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    const firstId = sentIds[0];
    const splitNote = sentIds.length > 1 ? ` (${sentIds.length} parts)` : "";
    const imageNote = image ? ` with image '${image.path}'` : "";
    console.log(
      `[Discord] Reply sent to channel ${channelId}, message ID: ${firstId}${splitNote}${imageNote}`,
    );

    return {
      toolCallId: "",
      content: `Reply sent${splitNote}${imageNote} (ID: ${firstId}).`,
      isError: false,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[Discord] Failed to send reply:", msg);
    return { toolCallId: "", content: `Reply error: ${msg}`, isError: true };
  }
}

/**
 * Add a single emoji reaction to a Discord message.
 */
async function executeReact(
  emoji: string,
  messageId: string,
  channelId: string,
  headers: Record<string, string>,
): Promise<ToolResult> {
  const encoded = encodeEmojiForApi(emoji);

  // Don't send Content-Type for react PUT — it's URL-encoded, not JSON
  const { "Content-Type": _, ...reactHeaders } = headers;

  try {
    const resp = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`,
      {
        method: "PUT",
        headers: reactHeaders,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      },
    );

    if (!resp.ok && resp.status !== 204) {
      const errorBody = await resp.text().catch(() => "");

      if (resp.status === 429) {
        const retryAfter = resp.headers.get("Retry-After");
        const delay = retryAfter ? parseFloat(retryAfter) * 1000 : 5000;
        return {
          toolCallId: "",
          content: `React rate limited (429). Retry after ${
            Math.round(delay)
          }ms.`,
          isError: true,
        };
      }

      return {
        toolCallId: "",
        content: `React failed ('${emoji}' on ${messageId}): ${resp.status} ${
          errorBody.substring(0, 200)
        }`,
        isError: true,
      };
    }

    console.log(
      `[Discord] Reacted with '${emoji}' on message ${messageId} in channel ${channelId}`,
    );

    return {
      toolCallId: "",
      content: `Reacted '${emoji}' on ${messageId}.`,
      isError: false,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("[Discord] Failed to add reaction:", msg);
    return { toolCallId: "", content: `React error: ${msg}`, isError: true };
  }
}
