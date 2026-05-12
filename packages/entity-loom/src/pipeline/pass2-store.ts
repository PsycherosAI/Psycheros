/**
 * Entity Loom — Pass 2: Store
 *
 * Writes parsed conversations and messages to the package-local SQLite database.
 */

import { dirname } from "@std/path";
import type {
  CheckpointState,
  ImportedConversation,
  ProgressCallback,
} from "../types.ts";
import { DBWriter } from "../writers/db-writer.ts";

/**
 * Store conversations in the package database.
 */
export async function storeConversations(
  conversations: ImportedConversation[],
  dbPath: string,
  checkpoint: CheckpointState,
  onProgress?: ProgressCallback,
): Promise<{ conversationsStored: number; messagesStored: number }> {
  // Ensure parent directory exists
  await Deno.mkdir(dirname(dbPath), { recursive: true });

  const db = new DBWriter(dbPath);
  db.init();

  const existingIds = db.getExistingConversationIds();
  let conversationsStored = 0;
  let messagesStored = 0;

  for (const conv of conversations) {
    // Skip if already stored
    if (
      existingIds.has(conv.id) || checkpoint.pass2.storedIds.includes(conv.id)
    ) {
      continue;
    }

    try {
      const msgCount = db.writeConversation(conv);
      conversationsStored++;
      messagesStored += msgCount;
      checkpoint.pass2.storedIds.push(conv.id);
    } catch (error) {
      onProgress?.(
        `Failed to store conversation ${conv.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  db.close();
  onProgress?.(
    `Stored ${conversationsStored} conversations (${messagesStored} messages)`,
  );

  return { conversationsStored, messagesStored };
}
