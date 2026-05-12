/**
 * Entity Loom — Context Window Chunker
 *
 * Splits conversation messages into chunks that fit within
 * the worker model's context window.
 */

import type { ImportedConversation } from "../types.ts";

/** ~4 characters per token for English text */
const CHARS_PER_TOKEN = 4;

export interface MessageChunk {
  messages: Array<{ role: string; content: string; conversationId: string }>;
  tokenEstimate: number;
  chunkIndex: number;
  totalChunks: number;
}

/**
 * Split messages into chunks that fit within the context window.
 * Leaves headroom for the system prompt and LLM response.
 */
export function chunkMessages(
  messages: Array<{ role: string; content: string; conversationId: string }>,
  maxContextTokens: number,
): MessageChunk[] {
  // Reserve 40% for system prompt + response
  const maxContentTokens = Math.floor(maxContextTokens * 0.6);
  const maxContentChars = maxContentTokens * CHARS_PER_TOKEN;

  // Calculate total content size
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);

  if (totalChars <= maxContentChars) {
    return [{
      messages,
      tokenEstimate: Math.ceil(totalChars / CHARS_PER_TOKEN),
      chunkIndex: 0,
      totalChunks: 1,
    }];
  }

  // Need to chunk — split by message boundaries
  const chunks: MessageChunk[] = [];
  let currentChunk: typeof messages = [];
  let currentChars = 0;

  for (const msg of messages) {
    if (
      currentChars + msg.content.length > maxContentChars &&
      currentChunk.length > 0
    ) {
      chunks.push({
        messages: currentChunk,
        tokenEstimate: Math.ceil(currentChars / CHARS_PER_TOKEN),
        chunkIndex: chunks.length,
        totalChunks: 0, // Will be updated at the end
      });
      currentChunk = [msg];
      currentChars = msg.content.length;
    } else {
      currentChunk.push(msg);
      currentChars += msg.content.length;
    }
  }

  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    chunks.push({
      messages: currentChunk,
      tokenEstimate: Math.ceil(currentChars / CHARS_PER_TOKEN),
      chunkIndex: chunks.length,
      totalChunks: 0,
    });
  }

  // Set totalChunks on each chunk
  const total = chunks.length;
  for (const chunk of chunks) {
    chunk.totalChunks = total;
  }

  return chunks;
}

/** A chunk of a conversation for significant memory evaluation */
export interface ConversationChunk {
  conversationId: string;
  title?: string;
  platform?: string;
  messages: Array<{ role: string; content: string }>;
  dateFrom: Date;
  dateTo: Date;
  chunkIndex: number;
  totalChunks: number;
}

/**
 * Split a conversation into overlapping chunks for significant memory evaluation.
 * Unlike chunkMessages, this preserves context across chunk boundaries by overlapping
 * messages, which is important for detecting multi-day event arcs.
 */
export function chunkConversationForSignificance(
  conv: ImportedConversation,
  maxContextTokens: number,
  overlapMessages = 10,
): ConversationChunk[] {
  // Filter to user/assistant messages only (system/tool aren't useful for significance)
  const messages = conv.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt }));

  if (messages.length === 0) return [];

  // Reserve 40% for prompt + response
  const maxContentTokens = Math.floor(maxContextTokens * 0.6);
  const maxContentChars = maxContentTokens * CHARS_PER_TOKEN;

  // If the whole conversation fits, return as single chunk
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars <= maxContentChars) {
    return [{
      conversationId: conv.id,
      title: conv.title,
      platform: conv.platform,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      dateFrom: messages[0].createdAt,
      dateTo: messages[messages.length - 1].createdAt,
      chunkIndex: 0,
      totalChunks: 1,
    }];
  }

  // Need to chunk with overlap for context preservation
  const chunks: ConversationChunk[] = [];
  let startIdx = 0;

  while (startIdx < messages.length) {
    let currentChars = 0;
    let endIdx = startIdx;

    // Fill chunk up to the limit
    while (
      endIdx < messages.length &&
      currentChars + messages[endIdx].content.length <= maxContentChars
    ) {
      currentChars += messages[endIdx].content.length;
      endIdx++;
    }

    // If we didn't include any messages (single message exceeds limit), include at least one
    if (endIdx === startIdx) {
      endIdx = startIdx + 1;
    }

    const chunkMessages = messages.slice(startIdx, endIdx).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    chunks.push({
      conversationId: conv.id,
      title: conv.title,
      platform: conv.platform,
      messages: chunkMessages,
      dateFrom: messages[startIdx].createdAt,
      dateTo: messages[endIdx - 1].createdAt,
      chunkIndex: chunks.length,
      totalChunks: 0, // set below
    });

    // Advance by (chunk size - overlap), but at least 1
    const advance = Math.max(1, (endIdx - startIdx) - overlapMessages);
    startIdx += advance;
  }

  // Set totalChunks
  for (const chunk of chunks) {
    chunk.totalChunks = chunks.length;
  }

  return chunks;
}
