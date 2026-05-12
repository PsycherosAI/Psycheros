/**
 * Lorebook State Manager
 *
 * Manages sticky entry state persistence in SQLite.
 * Handles loading, saving, and cleaning up expired sticky states.
 */

import type { DBClient } from "../db/mod.ts";
import type { LorebookState, StickyEntryState } from "./types.ts";

/**
 * Row type for lorebook_state table.
 */
interface LorebookStateRow {
  id: string;
  conversation_id: string;
  entry_id: string;
  turns_remaining: number;
  triggered_at_message: number;
  triggered_at: string;
  created_at: string;
  updated_at: string;
}

/**
 * Load lorebook state for a conversation.
 *
 * @param db - Database client
 * @param conversationId - The conversation ID
 * @returns The current lorebook state, or undefined if no state exists
 */
export function loadState(
  db: DBClient,
  conversationId: string,
): LorebookState | undefined {
  const rawDb = db.getRawDb();
  const stmt = rawDb.prepare(
    `SELECT id, conversation_id, entry_id, turns_remaining, triggered_at_message,
            triggered_at, created_at, updated_at
     FROM lorebook_state
     WHERE conversation_id = ?`,
  );

  const rows = stmt.all<LorebookStateRow>(conversationId);
  stmt.finalize();

  if (rows.length === 0) {
    return undefined;
  }

  const activeEntries = new Map<string, StickyEntryState>();
  let maxMessageIndex = 0;

  for (const row of rows) {
    activeEntries.set(row.entry_id, {
      entryId: row.entry_id,
      turnsRemaining: row.turns_remaining,
      triggeredAtMessage: row.triggered_at_message,
      triggeredAt: row.triggered_at,
    });
    maxMessageIndex = Math.max(maxMessageIndex, row.triggered_at_message);
  }

  return {
    activeEntries,
    currentMessageIndex: maxMessageIndex,
    conversationId,
  };
}

/**
 * Save lorebook state for a conversation.
 * Replaces all existing state for the conversation.
 *
 * @param db - Database client
 * @param state - The state to save
 */
export function saveState(db: DBClient, state: LorebookState): void {
  const rawDb = db.getRawDb();
  const now = new Date().toISOString();

  rawDb.exec("BEGIN TRANSACTION");

  const insertStmt = rawDb.prepare(
    `INSERT INTO lorebook_state
     (id, conversation_id, entry_id, turns_remaining, triggered_at_message,
      triggered_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  try {
    // Delete existing state for this conversation
    rawDb.exec(
      `DELETE FROM lorebook_state WHERE conversation_id = ?`,
      [state.conversationId],
    );

    // Insert new state entries
    for (const [entryId, entryState] of state.activeEntries) {
      const id = crypto.randomUUID();
      insertStmt.run(
        id,
        state.conversationId,
        entryId,
        entryState.turnsRemaining,
        entryState.triggeredAtMessage,
        entryState.triggeredAt,
        now,
        now,
      );
    }

    rawDb.exec("COMMIT");
  } catch (error) {
    rawDb.exec("ROLLBACK");
    throw error;
  } finally {
    insertStmt.finalize();
  }
}

/**
 * Clear all lorebook state for a conversation.
 *
 * @param db - Database client
 * @param conversationId - The conversation ID
 */
export function clearState(db: DBClient, conversationId: string): void {
  const rawDb = db.getRawDb();
  rawDb.exec(
    `DELETE FROM lorebook_state WHERE conversation_id = ?`,
    [conversationId],
  );
}

/**
 * Clean up expired sticky entries from state.
 * Removes entries where turns_remaining <= 0.
 *
 * @param db - Database client
 * @param conversationId - The conversation ID
 */
export function cleanupExpiredState(
  db: DBClient,
  conversationId: string,
): void {
  const rawDb = db.getRawDb();
  rawDb.exec(
    `DELETE FROM lorebook_state WHERE conversation_id = ? AND turns_remaining <= 0`,
    [conversationId],
  );
}

/**
 * Get all conversations with active lorebook state.
 *
 * @param db - Database client
 * @returns Array of conversation IDs with active state
 */
export function getConversationsWithState(db: DBClient): string[] {
  const rawDb = db.getRawDb();
  const stmt = rawDb.prepare(
    `SELECT DISTINCT conversation_id FROM lorebook_state`,
  );

  const rows = stmt.all<{ conversation_id: string }>();
  stmt.finalize();

  return rows.map((row) => row.conversation_id);
}
