/**
 * State Changes Module
 *
 * Centralized functions for state changes that affect UI.
 * All code paths (tools, API endpoints, etc.) should use these functions
 * to ensure consistent behavior and reactive UI updates.
 *
 * Each function:
 * - Performs the database operation
 * - Returns success/error status
 * - Returns which UI regions are affected (for reactive updates)
 *
 * @module
 */

import type { DBClient } from "../db/mod.ts";
import { MAX_TITLE_LENGTH } from "../constants.ts";

/**
 * Ensure a title is unique across all conversations by appending
 * a suffix like " (2)", " (3)" if needed (case-insensitive).
 */
function deduplicateTitle(
  db: DBClient,
  title: string,
  excludeConversationId: string,
): string {
  const conversations = db.listConversations();
  const normalizedTitle = title.toLowerCase();

  const otherMatches = conversations.filter(
    (c) =>
      c.id !== excludeConversationId &&
      c.title?.toLowerCase() === normalizedTitle,
  );

  if (otherMatches.length === 0) {
    return title;
  }

  // If this conversation already has this exact title, keep it unchanged
  const self = conversations.find((c) => c.id === excludeConversationId);
  if (self?.title?.toLowerCase() === normalizedTitle) {
    return title;
  }

  // Find next available suffix
  let suffix = 2;
  while (true) {
    const candidate = `${title} (${suffix})`;
    if (
      !conversations.some(
        (c) =>
          c.id !== excludeConversationId &&
          c.title?.toLowerCase() === candidate.toLowerCase(),
      )
    ) {
      return candidate;
    }
    suffix++;
  }
}

/**
 * Result of a state change operation.
 */
export interface StateChangeResult<T = unknown> {
  /** Whether the operation succeeded */
  success: boolean;
  /** Error message if operation failed */
  error?: string;
  /** Data returned by the operation (type varies by operation) */
  data?: T;
  /** UI regions affected by this change (for reactive updates) */
  affectedRegions: string[];
}

/**
 * Update the title of a conversation.
 *
 * Affects UI regions: conv-list, header-title
 *
 * @param db - Database client
 * @param conversationId - The conversation to update
 * @param title - The new title
 * @returns StateChangeResult with the updated title
 */
export function updateConversationTitle(
  db: DBClient,
  conversationId: string,
  title: string,
): StateChangeResult<{ title: string }> {
  // Validate title
  const trimmedTitle = title.trim();

  if (trimmedTitle.length === 0) {
    return {
      success: false,
      error: "Title cannot be empty",
      affectedRegions: [],
    };
  }

  if (trimmedTitle.length > MAX_TITLE_LENGTH) {
    return {
      success: false,
      error: `Title exceeds maximum length of ${MAX_TITLE_LENGTH} characters`,
      affectedRegions: [],
    };
  }

  // Deduplicate the title before storing
  const uniqueTitle = deduplicateTitle(db, trimmedTitle, conversationId);

  // Perform the update
  const updated = db.updateConversationTitle(conversationId, uniqueTitle);

  if (!updated) {
    return {
      success: false,
      error: `Conversation not found: ${conversationId}`,
      affectedRegions: [],
    };
  }

  return {
    success: true,
    data: { title: uniqueTitle },
    affectedRegions: ["conv-list", "header-title"],
  };
}

/**
 * Delete a single conversation.
 *
 * Affects UI regions: conv-list
 *
 * @param db - Database client
 * @param conversationId - The conversation to delete
 * @returns StateChangeResult with the deleted ID
 */
export function deleteConversation(
  db: DBClient,
  conversationId: string,
): StateChangeResult<{ deletedId: string }> {
  const deleted = db.deleteConversation(conversationId);

  if (!deleted) {
    return {
      success: false,
      error: `Conversation not found: ${conversationId}`,
      affectedRegions: [],
    };
  }

  return {
    success: true,
    data: { deletedId: conversationId },
    affectedRegions: ["conv-list"],
  };
}

/**
 * Delete multiple conversations.
 *
 * Affects UI regions: conv-list
 *
 * @param db - Database client
 * @param ids - Array of conversation IDs to delete
 * @returns StateChangeResult with deleted count and IDs
 */
export function deleteConversations(
  db: DBClient,
  ids: string[],
): StateChangeResult<{ deletedCount: number; deletedIds: string[] }> {
  if (ids.length === 0) {
    return {
      success: false,
      error: "No conversation IDs provided",
      affectedRegions: [],
    };
  }

  const deletedCount = db.deleteConversations(ids);

  return {
    success: true,
    data: { deletedCount, deletedIds: ids },
    affectedRegions: ["conv-list"],
  };
}

/**
 * Update the content of a message.
 *
 * Affects UI regions: chat-view
 *
 * @param db - Database client
 * @param conversationId - The conversation ID
 * @param messageId - The message ID
 * @param content - The new content
 * @returns StateChangeResult with the updated message info
 */
export function updateMessageContent(
  db: DBClient,
  conversationId: string,
  messageId: string,
  content: string,
): StateChangeResult<{ messageId: string; conversationId: string }> {
  // Validate content
  const trimmedContent = content.trim();

  if (trimmedContent.length === 0) {
    return {
      success: false,
      error: "Message content cannot be empty",
      affectedRegions: [],
    };
  }

  // Perform the update
  const updated = db.updateMessage(messageId, trimmedContent);

  if (!updated) {
    return {
      success: false,
      error: `Message not found: ${messageId}`,
      affectedRegions: [],
    };
  }

  return {
    success: true,
    data: { messageId, conversationId },
    affectedRegions: ["chat-view"],
  };
}
