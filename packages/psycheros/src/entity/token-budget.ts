/**
 * Context Window Budget Management
 *
 * Estimates token usage for LLM context and trims conversation history
 * (FIFO from oldest) to fit within the model's context window.
 *
 * The system message (index 0) is never truncated. Only conversation
 * history messages are trimmed, keeping the most recent ones.
 */

import type { ChatContent, ChatMessage } from "../llm/mod.ts";
import type { ToolDefinition } from "../types.ts";

/**
 * Character-to-token ratio for conservative estimation.
 * 3.5 chars/token overestimates slightly vs. the typical 4.0,
 * which prevents sending payloads that exceed the actual context window.
 */
const CHARS_PER_TOKEN = 3.5;

/**
 * Safety margin as a fraction of the context window.
 * Accounts for estimation inaccuracy, role tokens, formatting overhead.
 */
const SAFETY_MARGIN_FRACTION = 0.05;

/** Role/structure overhead tokens per message */
const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Result of context budget trimming.
 */
export interface BudgetResult {
  /** The messages array (possibly truncated) */
  messages: ChatMessage[];
  /** Whether any messages were truncated */
  truncated: boolean;
  /** Number of messages removed */
  messagesRemoved: number;
  /** Estimated total tokens in the final payload */
  estimatedTotalTokens: number;
  /** Estimated tokens consumed by the system message */
  systemMessageTokens: number;
  /** Estimated tokens consumed by tool definitions */
  toolTokens: number;
  /** Estimated tokens consumed by history messages (after trimming) */
  historyTokens: number;
  /** Available budget for history messages */
  availableBudget: number;
  /** The full context window size */
  contextLength: number;
  /**
   * How many assistant messages had their reasoning_content stripped to
   * fit budget (the message itself was retained). Surfaces in the
   * Context Inspector so a user who enabled persistent reasoning can
   * see when budget pressure is silently undoing their preference.
   */
  reasoningStripped: number;
  /** How many assistant messages retained their reasoning_content. */
  reasoningRetained: number;
}

/**
 * Estimate token count for a text string.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateContentTokens(content: ChatContent): number {
  if (typeof content === "string") return estimateTokens(content);
  return content.reduce((sum, part) => {
    if (part.type === "text") return sum + estimateTokens(part.text);
    // Multimodal providers account for images separately. I reserve a
    // conservative image budget while keeping transient data URL bytes out of
    // the text-token estimate.
    return sum + 1200;
  }, 0);
}

/**
 * Estimate the token cost of a single ChatMessage, including tool_calls,
 * tool_call_id overhead, and any reasoning_content attached to outbound
 * assistant messages.
 */
function estimateMessageTokens(msg: ChatMessage): number {
  let tokens = estimateContentTokens(msg.content);
  if (msg.reasoning_content) {
    tokens += estimateTokens(msg.reasoning_content);
  }
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    tokens += estimateTokens(JSON.stringify(msg.tool_calls));
  }
  if (msg.tool_call_id) {
    tokens += estimateTokens(msg.tool_call_id);
  }
  tokens += MESSAGE_OVERHEAD_TOKENS;
  return tokens;
}

/**
 * Same as `estimateMessageTokens` but excludes any reasoning_content.
 * Used by the two-pass trim: when a message doesn't fit with reasoning
 * intact, we check whether it fits without — and if so, keep the message
 * while stripping its reasoning_content from the outgoing payload.
 */
function estimateMessageTokensWithoutReasoning(msg: ChatMessage): number {
  let tokens = estimateContentTokens(msg.content);
  // Intentionally skip msg.reasoning_content
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    tokens += estimateTokens(JSON.stringify(msg.tool_calls));
  }
  if (msg.tool_call_id) {
    tokens += estimateTokens(msg.tool_call_id);
  }
  tokens += MESSAGE_OVERHEAD_TOKENS;
  return tokens;
}

/**
 * Estimate token count for tool definitions JSON.
 */
function estimateToolDefinitionsTokens(tools: ToolDefinition[]): number {
  if (!tools || tools.length === 0) return 0;
  return estimateTokens(JSON.stringify(tools));
}

/**
 * Validate and fix a message sequence for LLM API compatibility.
 *
 * Most APIs require a specific role alternation pattern:
 * - First message after system must be "user"
 * - user -> assistant (normal response)
 * - assistant (with tool_calls) -> tool (one or more results)
 * - assistant (without tool_calls) -> user
 * - tool -> tool (more results) | assistant (continuation) | user (end of chain)
 *
 * Messages that don't fit the expected pattern are dropped.
 * The system message (index 0) is always preserved.
 */
function sanitizeMessageSequence(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 1) return messages;

  const result: ChatMessage[] = [messages[0]]; // Always keep system
  let prevHadToolCalls = false;

  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i];
    const prev = result[result.length - 1];
    const prevRole = prev.role;

    let valid = false;

    switch (prevRole) {
      case "system":
        // After system, only user is valid
        valid = msg.role === "user";
        break;
      case "user":
        // After user, assistant is expected
        valid = msg.role === "assistant";
        break;
      case "assistant":
        if (prevHadToolCalls) {
          // Assistant had tool_calls — next must be a tool result
          valid = msg.role === "tool";
        } else {
          // Normal assistant — next must be user
          valid = msg.role === "user";
        }
        break;
      case "tool":
        // After tool result: more tools, or assistant/user (end of chain)
        valid = msg.role === "tool" || msg.role === "assistant" ||
          msg.role === "user";
        break;
    }

    if (valid) {
      result.push(msg);
      prevHadToolCalls = !!(msg.tool_calls && msg.tool_calls.length > 0);
    }
    // Invalid transition — skip this message, prevRole unchanged
  }

  // Final check: if the last message is an assistant with tool_calls but
  // no tool results follow, remove it (orphaned tool call at the boundary)
  if (result.length > 1) {
    const last = result[result.length - 1];
    if (
      last.role === "assistant" && last.tool_calls && last.tool_calls.length > 0
    ) {
      result.pop();
    }
  }

  return result;
}

/**
 * Apply context window budget to a messages array.
 *
 * The system message (index 0) is never truncated. History messages are
 * trimmed from oldest to newest until the payload fits within:
 *   contextLength - maxTokens - safetyMargin - systemTokens - toolTokens
 *
 * @param allMessages - Complete messages array [system, ...history, user]
 * @param toolDefinitions - Tool definitions being sent (consumes context)
 * @param contextLength - Model's context window in tokens
 * @param maxTokens - Tokens reserved for the response
 * @returns BudgetResult with trimmed messages and metrics
 */
export function applyContextBudget(
  allMessages: ChatMessage[],
  toolDefinitions: ToolDefinition[],
  contextLength: number,
  maxTokens: number,
): BudgetResult {
  const safetyMargin = Math.floor(contextLength * SAFETY_MARGIN_FRACTION);
  const availableForInput = contextLength - maxTokens - safetyMargin;
  const toolTokens = estimateToolDefinitionsTokens(toolDefinitions);

  // System message is always at index 0 and is never truncated
  const systemMessage = allMessages[0];
  const systemMessageTokens = estimateMessageTokens(systemMessage);

  // Budget available for conversation history
  const availableBudget = availableForInput - systemMessageTokens - toolTokens;

  // The last message is always the current user message — it must never be dropped.
  // Even when budget is zero, we need system + current user for a valid request.
  const lastMessage = allMessages[allMessages.length - 1];
  const lastMessageTokens = estimateMessageTokens(lastMessage);
  const isLastMessageUser = lastMessage.role === "user";

  if (availableBudget <= 0) {
    if (isLastMessageUser) {
      return {
        messages: [systemMessage, lastMessage],
        truncated: allMessages.length > 2,
        messagesRemoved: allMessages.length - 2,
        estimatedTotalTokens: systemMessageTokens + lastMessageTokens +
          toolTokens,
        systemMessageTokens,
        toolTokens,
        historyTokens: lastMessageTokens,
        availableBudget,
        contextLength,
        reasoningStripped: 0,
        reasoningRetained: 0,
      };
    }
    // Last message isn't user (shouldn't happen in normal flow) — keep it anyway
    return {
      messages: [systemMessage, lastMessage],
      truncated: allMessages.length > 2,
      messagesRemoved: allMessages.length - 2,
      estimatedTotalTokens: systemMessageTokens + lastMessageTokens +
        toolTokens,
      systemMessageTokens,
      toolTokens,
      historyTokens: lastMessageTokens,
      availableBudget,
      contextLength,
      reasoningStripped: 0,
      reasoningRetained: 0,
    };
  }

  // Walk from newest to oldest, accumulating tokens until budget is full.
  // Two-pass trim: when a message with reasoning_content doesn't fit as-is,
  // retry without its reasoning_content before dropping it outright. This
  // preserves conversational continuity (the visible turn) when reasoning
  // alone was the budget offender — otherwise a single 5k-token reasoning
  // block could cascade into dropping a whole turn plus its preceding user
  // message via sanitization.
  const historyMessages = allMessages.slice(1);
  let historyTokens = 0;
  let fitCount = 0;
  const strippedIndices = new Set<number>();

  for (let i = historyMessages.length - 1; i >= 0; i--) {
    const isLastMessage = i === historyMessages.length - 1;
    const msg = historyMessages[i];
    const fullTokens = estimateMessageTokens(msg);
    if (isLastMessage) {
      // Always keep the last message (current user input) regardless.
      historyTokens += fullTokens;
      fitCount++;
      continue;
    }
    if (historyTokens + fullTokens <= availableBudget) {
      // Fits with reasoning intact.
      historyTokens += fullTokens;
      fitCount++;
      continue;
    }
    // Doesn't fit with reasoning — try without.
    if (msg.reasoning_content) {
      const strippedTokens = estimateMessageTokensWithoutReasoning(msg);
      if (historyTokens + strippedTokens <= availableBudget) {
        strippedIndices.add(i);
        historyTokens += strippedTokens;
        fitCount++;
        continue;
      }
    }
    // Doesn't fit even without reasoning — stop walking.
    break;
  }

  // Build trimmed array: system + last `fitCount` history messages
  const startIdx = historyMessages.length - fitCount;
  const trimmedHistory = startIdx > 0
    ? historyMessages.slice(startIdx)
    : historyMessages;

  // Apply reasoning_content stripping to messages that fit only by strip.
  // Track the stripped object references so the final counts can be
  // recomputed accurately after sanitization drops some of them.
  const strippedMsgRefs = new Set<ChatMessage>();
  if (strippedIndices.size > 0) {
    for (let i = 0; i < trimmedHistory.length; i++) {
      if (strippedIndices.has(startIdx + i)) {
        const stripped: ChatMessage = {
          ...trimmedHistory[i],
          reasoning_content: undefined,
        };
        trimmedHistory[i] = stripped;
        strippedMsgRefs.add(stripped);
      }
    }
  }

  // Drop leading non-user messages to ensure a valid message sequence.
  // APIs require the first message after system to be "user". After FIFO
  // trimming, we may be left with orphaned assistant or tool messages
  // at the start of history (e.g., the user message they were responding
  // to was trimmed away). Drop them until we hit a user message.
  let cleanupDropped = 0;
  while (trimmedHistory.length > 0 && trimmedHistory[0].role !== "user") {
    historyTokens -= estimateMessageTokens(trimmedHistory[0]);
    trimmedHistory.shift();
    cleanupDropped++;
  }

  // Sanitize the full sequence to catch remaining issues:
  // consecutive same-role messages, orphaned tool_calls without results, etc.
  const preSanitize = [systemMessage, ...trimmedHistory];
  const sanitizedMessages = sanitizeMessageSequence(preSanitize);
  const sanitizeDropped = preSanitize.length - sanitizedMessages.length;

  // Recalculate history tokens after sanitization
  historyTokens = 0;
  for (let i = 1; i < sanitizedMessages.length; i++) {
    historyTokens += estimateMessageTokens(sanitizedMessages[i]);
  }

  // Recompute reasoning strip/retain counts from the final sanitized
  // output — sanitization may have dropped messages that were originally
  // counted in either bucket, leaving the pre-sanitize counts stale.
  let reasoningStripped = 0;
  let reasoningRetained = 0;
  for (const m of sanitizedMessages) {
    if (m.role !== "assistant") continue;
    if (strippedMsgRefs.has(m)) {
      reasoningStripped++;
    } else if (m.reasoning_content) {
      reasoningRetained++;
    }
  }

  const budgetDropped = historyMessages.length - fitCount;
  const totalRemoved = budgetDropped + cleanupDropped + sanitizeDropped;
  const estimatedTotalTokens = systemMessageTokens + historyTokens + toolTokens;

  return {
    messages: sanitizedMessages,
    truncated: totalRemoved > 0,
    messagesRemoved: totalRemoved,
    estimatedTotalTokens,
    systemMessageTokens,
    toolTokens,
    historyTokens,
    availableBudget,
    contextLength,
    reasoningStripped,
    reasoningRetained,
  };
}
