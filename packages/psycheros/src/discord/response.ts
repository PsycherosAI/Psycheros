/**
 * Discord Response Handler
 *
 * Posts entity responses back to Discord channels.
 * Handles message splitting, rate limiting, reply threading.
 */

const DISCORD_MAX_MESSAGE_LENGTH = 2000;

// =============================================================================
// Shared utilities (exported for use by the act_in_discord tool)
// =============================================================================

/**
 * Build a reverse lookup: shortcode name → unicode character.
 * Loaded from emojilib at module init — covers all standard emoji.
 */
import emojiData from "emojilib" with { type: "json" };

const EMOJI_BY_NAME: Record<string, string> = {};
for (const [char, names] of Object.entries(emojiData)) {
  for (const name of names as string[]) {
    EMOJI_BY_NAME[name.toLowerCase()] = char;
  }
}

/**
 * Encode an emoji for the Discord reactions API URL.
 * Accepts unicode characters, shortcode names, and custom emoji (name:id).
 */
export function encodeEmojiForApi(emoji: string): string {
  // Custom emoji: name:id (e.g. rofl:123456789)
  if (/^[a-zA-Z0-9_]+:\d+$/.test(emoji)) return emoji;

  // Strip wrapping colons if present (:smile: → smile)
  let name = emoji;
  if (name.startsWith(":") && name.endsWith(":")) {
    name = name.slice(1, -1);
  }

  // If it's already a unicode emoji, encode directly
  if (/[^ -~\n\r\t]/.test(name)) {
    return encodeURIComponent(name);
  }

  // Try shortcode name lookup
  const resolved = EMOJI_BY_NAME[name.toLowerCase()];
  if (resolved) return encodeURIComponent(resolved);

  // Fall through — URL-encode as-is
  return encodeURIComponent(name);
}

/**
 * Split a message into chunks that fit within Discord's 2000 char limit.
 * Tries to split at natural boundaries (newlines, then spaces).
 */
export function splitMessage(content: string, maxLength: number): string[] {
  if (content.length <= maxLength) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to find a good split point
    let splitIndex = maxLength;

    // Prefer splitting at double newlines (paragraph breaks)
    const paragraphBreak = remaining.lastIndexOf("\n\n", maxLength);
    if (paragraphBreak > maxLength * 0.3) {
      splitIndex = paragraphBreak + 2;
    } else {
      // Fall back to single newline
      const lineBreak = remaining.lastIndexOf("\n", maxLength);
      if (lineBreak > maxLength * 0.3) {
        splitIndex = lineBreak + 1;
      } else {
        // Fall back to space
        const spaceBreak = remaining.lastIndexOf(" ", maxLength);
        if (spaceBreak > maxLength * 0.3) {
          splitIndex = spaceBreak + 1;
        }
      }
    }

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks.filter((c) => c.length > 0);
}

// =============================================================================
// ResponseHandler
// =============================================================================

interface ParsedResponse {
  content: string;
  replyToId: string | null;
  reactions: Array<{ messageId: string; emoji: string }>;
}

export class ResponseHandler {
  private token: string;
  private _botUserId: string | null;

  constructor(token: string, botUserId: string | null) {
    this.token = token;
    this._botUserId = botUserId;
  }

  updateBotUserId(botUserId: string | null): void {
    this._botUserId = botUserId;
  }

  getBotUserId(): string | null {
    return this._botUserId;
  }

  /**
   * Post a message to a Discord channel.
   * Automatically splits messages longer than 2000 characters.
   */
  async sendMessage(
    channelId: string,
    content: string,
    _replyToMessageId?: string,
  ): Promise<void> {
    if (!content.trim()) return;

    // Strip entity timestamp tags — they're visually hidden in the web UI but render raw in Discord
    content = content.replace(/<t>[^<]*<\/t>/g, "").replace(
      /<t:\d+[^\s>]*>/g,
      "",
    ).trim();

    // Parse structured directives from entity output
    const parsed = this.parseDirectives(content);

    if (!parsed.content.trim() && parsed.reactions.length === 0) return;

    // Send text content (if any remains after stripping directives)
    if (parsed.content.trim()) {
      const chunks = splitMessage(
        parsed.content,
        DISCORD_MAX_MESSAGE_LENGTH,
      );
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const reference = i === 0 ? (parsed.replyToId ?? undefined) : undefined;
        await this.sendSingleMessage(channelId, chunk, reference);
        if (i < chunks.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }

    // Fire reactions asynchronously (non-blocking)
    if (parsed.reactions.length > 0) {
      this.executeReactions(channelId, parsed.reactions).catch((err) => {
        console.error("[Discord] Reaction execution failed:", err);
      });
    }
  }

  /**
   * Post a message to a Discord channel.
   */
  async sendSingleMessage(
    channelId: string,
    content: string,
    replyToMessageId?: string,
  ): Promise<string | null> {
    const body: Record<string, unknown> = { content };
    if (replyToMessageId) {
      body.message_reference = {
        message_id: replyToMessageId,
        channel_id: channelId,
      };
    }

    const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
    const payload = JSON.stringify(body);
    console.log(
      `[Discord] HTTP POST begins: channel=${channelId}, bytes=${payload.length}, hasReply=${
        Boolean(replyToMessageId)
      }`,
    );
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bot ${this.token}`,
        "Content-Type": "application/json",
      },
      body: payload,
    });
    console.log(`[Discord] HTTP response: status=${resp.status}`);

    if (!resp.ok) {
      await resp.body?.cancel();
      console.error(`[Discord] Failed to send message: status=${resp.status}`);
      if (resp.status === 429) {
        const retryAfter = resp.headers.get("Retry-After");
        const delay = retryAfter ? parseFloat(retryAfter) * 1000 : 5000;
        console.log(
          `[Discord] Rate limited, retrying after ${Math.round(delay)}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.sendSingleMessage(channelId, content, replyToMessageId);
      }
      return null;
    }

    const data = await resp.json() as { id: string };
    console.log(`[Discord] HTTP send succeeded: messageId=${data.id}`);
    return data.id;
  }

  /**
   * Send a DM to a user.
   */
  async sendDm(userId: string, content: string): Promise<string | null> {
    // Create or get DM channel
    const channelResp = await fetch(
      "https://discord.com/api/v10/users/@me/channels",
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ recipient_id: userId }),
      },
    );

    if (!channelResp.ok) {
      console.error(
        `[Discord] Failed to create DM channel: ${channelResp.status}`,
      );
      return null;
    }

    const channel = await channelResp.json() as { id: string };
    return this.sendSingleMessage(channel.id, content);
  }

  /**
   * Parse ::react and ::reply directives from entity output.
   * Directives must be on their own line. Everything else passes through.
   */
  private parseDirectives(content: string): ParsedResponse {
    const reactions: ParsedResponse["reactions"] = [];
    let replyToId: string | null = null;
    let cleaned = content;

    // Extract ::react messageId :emoji: from anywhere in the text
    const reactRegex = /::react\s+(\d+)\s+:(\S+):/g;
    let match;
    while ((match = reactRegex.exec(cleaned)) !== null) {
      reactions.push({ messageId: match[1], emoji: match[2] });
    }
    cleaned = cleaned.replace(/::react\s+\d+\s+:\S+:/g, "").trim();

    // Extract ::reply messageId from anywhere
    const replyMatch = cleaned.match(/::reply\s+(\d+)/);
    if (replyMatch) {
      replyToId = replyMatch[1];
    }
    cleaned = cleaned.replace(/::reply\s+\d+/g, "").trim();

    // Collapse multiple blank lines created by stripping
    cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

    return { content: cleaned, replyToId, reactions };
  }

  /**
   * Add emoji reactions to Discord messages.
   * PUT /channels/{channelId}/messages/{messageId}/reactions/{emoji}/@me
   */
  private async executeReactions(
    channelId: string,
    reactions: Array<{ messageId: string; emoji: string }>,
  ): Promise<void> {
    for (const reaction of reactions) {
      try {
        const encoded = encodeEmojiForApi(reaction.emoji);
        await new Promise((resolve) => setTimeout(resolve, 250));

        const resp = await fetch(
          `https://discord.com/api/v10/channels/${channelId}/messages/${reaction.messageId}/reactions/${encoded}/@me`,
          { method: "PUT", headers: { Authorization: `Bot ${this.token}` } },
        );

        if (!resp.ok && resp.status !== 204) {
          const errorBody = await resp.text().catch(() => "");
          console.error(
            `[Discord] Failed to react ${reaction.emoji} on ${reaction.messageId}: ${resp.status} ${errorBody}`,
          );
        }
      } catch (err) {
        console.error(`[Discord] Reaction error:`, err);
      }
    }
  }

  /**
   * Set bot presence (typing indicator).
   */
  async triggerTyping(channelId: string): Promise<void> {
    try {
      await fetch(`https://discord.com/api/v10/channels/${channelId}/typing`, {
        method: "POST",
        headers: { Authorization: `Bot ${this.token}` },
      });
    } catch {
      // Ignore typing indicator failures
    }
  }
}
