/**
 * Conversation Peek Tool
 *
 * I use this to look into another conversation and get a summary of what's
 * been discussed. This helps me stay aware of context across conversations
 * that might be relevant to what we're talking about right now.
 */

import { createClientFromProfile, createWorkerClient } from "../llm/mod.ts";
import type { LLMClient } from "../llm/mod.ts";
import { getActiveProfile, loadProfileSettings } from "../llm/settings.ts";
import type { ToolResult } from "../types.ts";
import type { Tool, ToolContext } from "./types.ts";
import { buildIdentitySystemMessage } from "../entity/context.ts";
import { estimateTokens } from "../entity/token-budget.ts";
import type { Conversation, Message } from "../types.ts";

/** Tokens reserved for the summary output. */
const SUMMARY_RESERVE_TOKENS = 2048;

/** Default worker context window when profile is unavailable. */
const DEFAULT_WORKER_CONTEXT_LENGTH = 128_000;

// ---------------------------------------------------------------------------
// Summarizer prompt — first-person, appended to the identity system message
// ---------------------------------------------------------------------------

const PEEK_INSTRUCTION = `

---

I need to brief my other self in a different conversation about what's been happening here.

Focus especially on the most recent developments — new topics, recent decisions, things that just happened — since my daily memory system may not have caught up to those yet. But don't limit yourself to only recent events; cover the overall gist of what this conversation has been about so my other self has full context.

Write in first person. Keep it to 2-3 paragraphs.`;

/**
 * Compose the effective peek instruction, appending the entity's specific
 * focus guidance when provided. The default instruction's voice constraints
 * ("Write in first person. Keep it to 2-3 paragraphs.") come first; the
 * entity's instructions come last so more-specific later guidance wins.
 */
function buildPeekInstruction(instructions?: string): string {
  if (!instructions || !instructions.trim()) return PEEK_INSTRUCTION;
  return `${PEEK_INSTRUCTION}\n\n${instructions.trim()}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ConversationMatch {
  conversation: Conversation;
  label: string;
}

/**
 * Format a conversation as a human-readable label for disambiguation.
 */
function formatConversationLabel(c: Conversation): string {
  const title = c.title || "Untitled";
  const source = c.sourceType ? ` [${c.sourceType}]` : "";
  const time = formatRelativeTime(c.updatedAt);
  return `${title}${source} — last active ${time} (ID: ${c.id})`;
}

/**
 * Simple relative time string (e.g. "2 hours ago", "3 days ago").
 */
function formatRelativeTime(date: Date): string {
  const ms = Date.now() - date.getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

/**
 * Search conversations by case-insensitive partial match on title.
 * Skips conversations with no title.
 */
function searchConversations(
  all: Conversation[],
  query: string,
): ConversationMatch[] {
  const lower = query.toLowerCase();
  return all
    .filter((c) => c.title && c.title.toLowerCase().includes(lower))
    .map((c) => ({
      conversation: c,
      label: formatConversationLabel(c),
    }));
}

/**
 * Format conversation messages for the summarizer.
 * Only includes user and assistant messages — tool-role messages are skipped
 * (the assistant's text usually describes what it did with the tools).
 *
 * Truncates from the oldest messages when the formatted output exceeds
 * `maxTokens`. Returns a truncated indicator prefix if messages were dropped.
 */
function formatMessagesForSummary(
  messages: Message[],
  maxTokens?: number,
): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      parts.push(`User: ${msg.content}`);
    } else if (msg.role === "assistant" && msg.content) {
      const toolNote = msg.toolCalls?.length
        ? ` [called: ${msg.toolCalls.map((tc) => tc.function.name).join(", ")}]`
        : "";
      parts.push(`Me: ${msg.content}${toolNote}`);
    }
  }

  if (!maxTokens || parts.length === 0) {
    return parts.join("\n\n");
  }

  // Walk from newest to oldest, accumulating tokens until budget is full
  let tokens = 0;
  let fitCount = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const partTokens = estimateTokens(parts[i]);
    if (tokens + partTokens > maxTokens) break;
    tokens += partTokens;
    fitCount++;
  }

  if (fitCount === parts.length) {
    return parts.join("\n\n");
  }

  const kept = parts.slice(parts.length - fitCount);
  const dropped = parts.length - fitCount;
  const prefix =
    `[Note: ${dropped} older message(s) were truncated to fit the summarizer's context window. Showing the most recent messages.]\n\n`;
  return prefix + kept.join("\n\n");
}

/**
 * Create a worker LLM client from the saved profile settings.
 * Falls back to env-var-based worker client if no profile is saved.
 * Returns the client and the profile's context window size.
 */
async function createSummarizerClient(
  dataRoot: string,
): Promise<{ llm: LLMClient; contextLength: number }> {
  try {
    const settings = await loadProfileSettings(dataRoot);
    const profile = getActiveProfile(settings);
    if (profile) {
      return {
        llm: createClientFromProfile(profile, {
          useWorker: true,
          thinkingEnabled: false,
        }),
        contextLength: profile.contextLength,
      };
    }
  } catch {
    // Fall through to env-var client
  }
  return {
    llm: createWorkerClient(),
    contextLength: DEFAULT_WORKER_CONTEXT_LENGTH,
  };
}

/**
 * Call the worker LLM to produce a conversation summary.
 */
async function summarizeConversation(
  systemMessage: string,
  conversationMessages: string,
  conversationTitle: string,
  llm: LLMClient,
  instruction: string,
): Promise<string> {
  let summary = "";

  for await (
    const chunk of llm.chatStream([
      { role: "system", content: systemMessage + instruction },
      {
        role: "user",
        content:
          `Here is the conversation "${conversationTitle}":\n\n${conversationMessages}\n\nSummarize what's been discussed in this conversation.`,
      },
    ])
  ) {
    if (chunk.type === "content") {
      summary += chunk.content;
    }
  }

  return summary.trim();
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const conversationPeekTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "conversation_peek",
      description:
        "I use this to peek into another conversation and get a summary of what's been discussed there. I provide a search query to find the conversation by title, or a conversation ID if I already know it. The tool returns a compact summary I can use to stay aware of relevant context across my conversations.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "A search term to find the conversation by title (case-insensitive partial match). For example, 'Medical Results' or 'Discord general'.",
          },
          conversation_id: {
            type: "string",
            description:
              "The exact conversation ID to peek at. I use this if I already know the ID from a previous search.",
          },
          instructions: {
            type: "string",
            description:
              "Optional guidance for what to focus on in the summary — particular " +
              "topics, decisions, or wording to capture. Omit for a general overview; " +
              "use only when I have a specific need.",
          },
        },
      },
    },
  },

  execute: async (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const query = args.query as string | undefined;
    const conversationId = args.conversation_id as string | undefined;
    const instructions = args.instructions as string | undefined;

    if (!query && !conversationId) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          "I need either a query or a conversation_id to peek into another conversation.",
        isError: true,
      };
    }

    // Don't peek into the current conversation
    if (conversationId && conversationId === ctx.conversationId) {
      return {
        toolCallId: ctx.toolCallId,
        content: "I can't peek into the conversation I'm already in.",
        isError: true,
      };
    }

    // --- Resolve target conversation ---

    let target: Conversation | null = null;

    if (conversationId) {
      target = ctx.db.getConversation(conversationId);
      if (!target) {
        return {
          toolCallId: ctx.toolCallId,
          content: `No conversation found with ID "${conversationId}".`,
          isError: true,
        };
      }
    } else if (query) {
      const all = ctx.db.listConversations();
      const matches = searchConversations(all, query);

      if (matches.length === 0) {
        return {
          toolCallId: ctx.toolCallId,
          content:
            `No conversations found matching "${query}". The conversation might have a different title, or it might not have a title set yet.`,
          isError: true,
        };
      }

      if (matches.length > 1) {
        const list = matches
          .map((m, i) => `${i + 1}. ${m.label}`)
          .join("\n");
        return {
          toolCallId: ctx.toolCallId,
          content:
            `Multiple conversations matched "${query}". I need the user to clarify which one:\n\n${list}`,
          isError: false,
        };
      }

      target = matches[0].conversation;
    }

    if (!target) {
      return {
        toolCallId: ctx.toolCallId,
        content: "Could not resolve the target conversation.",
        isError: true,
      };
    }

    // Skip if targeting the current conversation (by search match)
    if (target.id === ctx.conversationId) {
      return {
        toolCallId: ctx.toolCallId,
        content: "I can't peek into the conversation I'm already in.",
        isError: true,
      };
    }

    // --- Summarize ---

    const title = target.title || "Untitled";
    const messages = ctx.db.getMessages(target.id);

    if (messages.length === 0) {
      return {
        toolCallId: ctx.toolCallId,
        content:
          `The conversation "${title}" (${target.id}) has no messages yet.`,
        isError: false,
      };
    }

    try {
      const identitySystem = await buildIdentitySystemMessage(
        ctx.config.dataRoot,
      );
      const { llm, contextLength } = await createSummarizerClient(
        ctx.config.dataRoot,
      );
      const effectiveInstruction = buildPeekInstruction(instructions);

      // Calculate token budget for conversation messages:
      // context window - system message - summary reserve - safety margin
      const safetyMargin = Math.floor(contextLength * 0.05);
      const systemTokens = estimateTokens(identitySystem) +
        estimateTokens(effectiveInstruction);
      const maxMessageTokens = contextLength - systemTokens -
        SUMMARY_RESERVE_TOKENS - safetyMargin;

      const formattedMessages = formatMessagesForSummary(
        messages,
        maxMessageTokens > 0 ? maxMessageTokens : undefined,
      );

      console.log(
        `[conversation_peek] Target: "${title}" (${target.id}), ` +
          `${messages.length} messages, formatted ${formattedMessages.length} chars ` +
          `(~${
            estimateTokens(formattedMessages)
          } tokens) within ${contextLength} budget`,
      );

      const summary = await summarizeConversation(
        identitySystem,
        formattedMessages,
        title,
        llm,
        effectiveInstruction,
      );

      if (!summary) {
        return {
          toolCallId: ctx.toolCallId,
          content:
            `Failed to get a summary for "${title}" — the summarizer returned empty output.`,
          isError: true,
        };
      }

      return {
        toolCallId: ctx.toolCallId,
        content:
          `Conversation peek: "${title}"\nChat ID: ${target.id}\n\n${summary}`,
        isError: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      console.error("[conversation_peek] Summarization failed:", errorMessage);
      return {
        toolCallId: ctx.toolCallId,
        content: `Error summarizing conversation "${title}": ${errorMessage}`,
        isError: true,
      };
    }
  },
};
