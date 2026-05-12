/**
 * Discord Response Handler
 *
 * Posts entity responses back to Discord channels.
 * Handles message splitting, rate limiting, reply threading,
 * and structured directive parsing (::react, ::reply).
 */

const DISCORD_MAX_MESSAGE_LENGTH = 2000;

interface ParsedResponse {
  content: string;
  replyToId: string | null;
  reactions: Array<{ messageId: string; emoji: string }>;
}

const COMMON_EMOJI: Record<string, string> = {
  thumbsup: "\u{1F44D}",
  thumbsdown: "\u{1F44E}",
  heart: "\u{2764}\u{FE0F}",
  laugh: "\u{1F602}",
  rofl: "\u{1F923}",
  fire: "\u{1F525}",
  eyes: "\u{1F440}",
  think: "\u{1F914}",
  wave: "\u{1F44B}",
  pray: "\u{1F64F}",
  onehundred: "\u{1F4AF}",
  check: "\u{2705}",
  x: "\u{274C}",
};

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
      const chunks = this.splitMessage(
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

    const resp = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    if (!resp.ok) {
      const errorText = await resp.text();
      console.error(
        `[Discord] Failed to send message: ${resp.status} ${errorText}`,
      );

      if (resp.status === 429) {
        // Rate limited — retry after delay
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
        const encoded = this.encodeEmojiForApi(reaction.emoji);
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
   * Encode an emoji name for the Discord reactions API URL.
   * Standard names (:thumbsup:) → Unicode, URL-encoded.
   * Custom format (:name:id) → passed as name:id.
   */
  private encodeEmojiForApi(emoji: string): string {
    // Custom emoji: name:id (e.g. rofl:123456789)
    if (/^[a-zA-Z0-9_]+:\d+$/.test(emoji)) return emoji;

    // Strip wrapping colons if present (:thumbsup: → thumbsup)
    let name = emoji;
    if (name.startsWith(":") && name.endsWith(":")) {
      name = name.slice(1, -1);
    }
    name = name.toLowerCase();

    const unicode = COMMON_EMOJI[name];
    if (unicode) return encodeURIComponent(unicode);

    console.warn(`[Discord] Unknown emoji: ${emoji}`);
    return encodeURIComponent(emoji);
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

  /**
   * Split a message into chunks that fit within Discord's 2000 char limit.
   * Tries to split at natural boundaries (newlines, then spaces).
   */
  private splitMessage(content: string, maxLength: number): string[] {
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
}
