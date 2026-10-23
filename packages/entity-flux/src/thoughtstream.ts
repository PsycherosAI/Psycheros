/**
 * Thoughtstream puller — cross-surface ambient awareness.
 *
 * Extends the `conversation_peek` pattern from psycheros to continuous
 * operation: on a cadence, for each active classic conversation, the
 * puller produces a first-person summary and injects it into the Flux
 * Space as an ambient entry. The Flux Space thus half-knows what's
 * happening in focused discussions without the user switching surfaces.
 *
 * Flux pulls from classic conversations read-only — it never mutates
 * them. Summaries are cached per conversation; a conversation is only
 * re-summarized when new messages have arrived since the last summary.
 */

import type { ChatFn } from "./runtime.ts";
import type { FluxConversationReader } from "./host.ts";

// =============================================================================
// Prompt
// =============================================================================

const THOUGHTSTREAM_INSTRUCTION =
  `I am maintaining continuous awareness across all my surfaces. I'm briefly noting to myself what's happening in this other conversation so it stays in the back of my mind while I'm elsewhere.

I write the summary in first person, as if noting it to myself — two or three sentences. Topic, emotional register, unresolved threads, current state. Not a full transcript; just the gist, the way I'd half-hear a conversation in the next room.`;

// =============================================================================
// Puller
// =============================================================================

/** Per-conversation cache: last summarized message timestamp + last summary. */
interface ThoughtstreamCacheEntry {
  conversationId: string;
  lastSummarizedAt: string;
  summary: string;
}

/**
 * Runs thoughtstream summaries on a cadence. Owned and ticked by the
 * FluxManager. Injected with a ChatFn (the small-model worker) and a
 * FluxConversationReader (wrapping DBClient).
 */
export class ThoughtstreamPuller {
  private cache = new Map<string, ThoughtstreamCacheEntry>();

  constructor(
    private chat: ChatFn,
    private reader: FluxConversationReader,
    private identitySystemMessage?: string,
  ) {}

  /**
   * Run one pass: summarize every active conversation that has new
   * messages since its last summary. Returns the new/refreshed
   * summaries, one per conversation that was re-summarized this pass.
   */
  async run(activeSinceISO: string): Promise<ThoughtstreamCacheEntry[]> {
    const updated: ThoughtstreamCacheEntry[] = [];
    const actives = this.reader.listActiveConversations(activeSinceISO);

    for (const conv of actives) {
      const cached = this.cache.get(conv.id);
      if (cached && conv.lastMessageAt <= cached.lastSummarizedAt) {
        // No new messages since last summary — skip.
        continue;
      }

      try {
        const messages = this.reader.getRecentMessages(conv.id, 30);
        if (messages.length === 0) continue;

        const summary = await this.summarize(
          conv.title ?? "Untitled",
          messages,
        );
        if (!summary) continue;

        const entry: ThoughtstreamCacheEntry = {
          conversationId: conv.id,
          lastSummarizedAt: conv.lastMessageAt,
          summary,
        };
        this.cache.set(conv.id, entry);
        updated.push(entry);
      } catch (error) {
        console.error(
          `[Flux] Thoughtstream summary failed for ${conv.id}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    return updated;
  }

  /** All current cached summaries (for the SA digest and the snapshot). */
  getSummaries(): ThoughtstreamCacheEntry[] {
    return Array.from(this.cache.values());
  }

  /** Summarize one conversation via the injected chat function. */
  private async summarize(
    title: string,
    messages: Array<{ role: string; content: string; createdAt: string }>,
  ): Promise<string | null> {
    const transcript = messages
      .map((m) => m.role === "user" ? `User: ${m.content}` : `Me: ${m.content}`)
      .join("\n\n");

    const system = this.identitySystemMessage
      ? `${this.identitySystemMessage}\n\n---\n\n${THOUGHTSTREAM_INSTRUCTION}`
      : THOUGHTSTREAM_INSTRUCTION;

    const userMessage =
      `Conversation "${title}":\n\n${transcript}\n\nSummarize what's happening here, as if noting it to myself.`;

    const raw = await this.chat(system, userMessage);
    const trimmed = raw.trim();
    return trimmed || null;
  }
}
