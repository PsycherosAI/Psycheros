/**
 * Entity Loom — DB Writer
 *
 * Writes conversations and messages to the Psycheros SQLite database.
 * Matches the exact schema from Psycheros src/db/schema.ts.
 */

import { Database } from "@db/sqlite";
import type { ImportedConversation } from "../types.ts";

/** Schema SQL for the tables entity-loom writes to */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    platform TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    reasoning_content TEXT,
    tool_call_id TEXT,
    tool_calls TEXT,
    created_at TEXT NOT NULL,
    is_voice INTEGER DEFAULT 0,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON messages(conversation_id);

  CREATE INDEX IF NOT EXISTS idx_messages_created_at
    ON messages(conversation_id, created_at);

  CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
    ON conversations(updated_at);

  CREATE TABLE IF NOT EXISTS memory_summaries (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    granularity TEXT NOT NULL CHECK (granularity IN ('daily', 'weekly', 'monthly', 'yearly')),
    file_path TEXT NOT NULL,
    chat_ids TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memory_summaries_date
    ON memory_summaries(date);

  CREATE TABLE IF NOT EXISTS summarized_chats (
    chat_id TEXT NOT NULL,
    message_date TEXT NOT NULL,
    summary_id TEXT NOT NULL,
    summarized_at TEXT NOT NULL,
    PRIMARY KEY (chat_id, message_date),
    FOREIGN KEY (summary_id) REFERENCES memory_summaries(id) ON DELETE CASCADE
  );
`;

export class DBWriter {
  private db: Database;
  private dbPath: string;
  /**
   * Cached result of the conversations-table schema probe. Null until
   * probed on first need, then sticky for the life of this DBWriter.
   * Pre-finalize databases have the column; finalized ones don't.
   */
  private hasPlatformColumnCache: boolean | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = new Database(this.dbPath);
  }

  /** Initialize the database schema (idempotent) */
  init(): void {
    this.db.exec(SCHEMA_SQL);
  }

  /** Get a list of conversation IDs already in the database */
  getExistingConversationIds(): Set<string> {
    const rows = this.db.prepare("SELECT id FROM conversations").all() as Array<
      { id: string }
    >;
    return new Set(rows.map((row) => row.id));
  }

  /**
   * Detect whether the `conversations` table currently has a `platform`
   * column. Pre-finalize databases do (entity-loom's schema creates it so
   * memory writers can emit `[via:platform]` tags); post-finalize databases
   * don't (stripPlatformColumn drops it to match the Psycheros schema
   * exactly). Result is cached per DBWriter instance.
   */
  hasPlatformColumn(): boolean {
    if (this.hasPlatformColumnCache !== null) {
      return this.hasPlatformColumnCache;
    }
    const rows = this.db.prepare(
      "SELECT name FROM pragma_table_info('conversations') WHERE name = ?",
    ).all("platform") as Array<{ name: string }>;
    this.hasPlatformColumnCache = rows.length > 0;
    return this.hasPlatformColumnCache;
  }

  /**
   * Write a conversation and its messages to the database, replacing any
   * prior rows for the same conversation id.
   *
   * Replacing (not just INSERT OR IGNORE) is required so an updated reimport
   * of the same thread — same ID, more messages accrued since the first
   * export — actually refreshes the stored row and message list. Otherwise
   * the entity's view of that conversation is frozen at whatever the
   * first-import snapshot contained.
   *
   * Message timestamps are written exactly as the import supplied them
   * (`msg.createdAt.toISOString()`). Daily-memory grouping depends on these
   * timestamps; if a reimport round-trip mutated them, the entity's
   * "what happened on date X" view would silently shift.
   *
   * Returns the number of messages written.
   */
  writeConversation(conv: ImportedConversation): number {
    const createdAt = conv.createdAt.toISOString();
    const updatedAt = conv.updatedAt.toISOString();

    // Upsert conversation row. ON CONFLICT refreshes title/updated_at/
    // platform so an updated reimport overwrites the stale snapshot rather
    // than being silently ignored.
    if (this.hasPlatformColumn()) {
      this.db.prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at, platform)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           platform = excluded.platform`,
      ).run(
        conv.id,
        conv.title || null,
        createdAt,
        updatedAt,
        conv.platform || null,
      );
    } else {
      this.db.prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      ).run(
        conv.id,
        conv.title || null,
        createdAt,
        updatedAt,
      );
    }

    // Clear any prior messages for this conversation before re-inserting.
    // Safe for first-write (no rows match) and required for reimport (so
    // stale messages don't linger alongside the new ones). Foreign keys
    // are ON; the message_edits and FVT triggers cascade-clean.
    this.db.prepare(
      "DELETE FROM messages WHERE conversation_id = ?",
    ).run(conv.id);

    let messageCount = 0;

    const insertMsg = this.db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, reasoning_content, created_at, is_voice)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const msg of conv.messages) {
      if (msg.role === "system" || msg.role === "tool") continue;

      insertMsg.run(
        msg.id,
        conv.id,
        msg.role,
        msg.content,
        msg.reasoning || null,
        msg.createdAt.toISOString(),
        msg.isVoice ? 1 : 0,
      );
      messageCount++;
    }

    return messageCount;
  }

  /**
   * Record a memory summary in the database for tracking.
   * Matches Psycheros' pattern so the consolidation system recognizes it.
   */
  recordMemorySummary(
    date: string,
    granularity: string,
    filePath: string,
    chatIds: string[],
  ): void {
    const summaryId = `loom-${granularity}-${date}`;
    const chatIdsStr = chatIds.join(",");

    this.db.prepare(
      `INSERT OR IGNORE INTO memory_summaries (id, date, granularity, file_path, chat_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      summaryId,
      date,
      granularity,
      filePath,
      chatIdsStr,
      new Date().toISOString(),
    );

    const markSummarized = this.db.prepare(
      `INSERT OR IGNORE INTO summarized_chats (chat_id, message_date, summary_id, summarized_at)
       VALUES (?, ?, ?, ?)`,
    );

    for (const chatId of chatIds) {
      markSummarized.run(chatId, date, summaryId, new Date().toISOString());
    }
  }

  /** Get all messages for a specific date */
  getMessagesByDate(date: string): Array<{
    id: string;
    conversationId: string;
    role: string;
    content: string;
    createdAt: string;
  }> {
    const startOfDay = `${date}T00:00:00.000Z`;
    const endOfDay = `${date}T23:59:59.999Z`;

    const rows = this.db.prepare(
      `SELECT id, conversation_id, role, content, created_at
       FROM messages
       WHERE created_at >= ? AND created_at <= ? AND role IN ('user', 'assistant')
       ORDER BY created_at`,
    ).all(startOfDay, endOfDay) as Array<
      {
        id: string;
        conversation_id: string;
        role: string;
        content: string;
        created_at: string;
      }
    >;

    return rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  /** Get conversation title by ID */
  getConversationTitle(convId: string): string | null {
    const rows = this.db.prepare("SELECT title FROM conversations WHERE id = ?")
      .all(convId) as Array<{ title: string }>;
    return rows[0]?.title || null;
  }

  /** Get conversation platform by ID. Returns null post-finalize. */
  getConversationPlatform(convId: string): string | null {
    if (!this.hasPlatformColumn()) return null;
    const rows = this.db.prepare(
      "SELECT platform FROM conversations WHERE id = ?",
    ).all(convId) as Array<{ platform: string }>;
    return rows[0]?.platform || null;
  }

  /** Strip the platform column to make the DB Psycheros-compatible.
   *  Recreates the conversations table without the platform column.
   *
   *  We disable foreign_keys for the duration of the swap because
   *  `messages.conversation_id` has `ON DELETE CASCADE` — and `@db/sqlite`
   *  enables PRAGMA foreign_keys by default (unlike vanilla SQLite). Without
   *  this guard, `DROP TABLE conversations` cascades and wipes every message
   *  in the final package.
   *
   *  No-op if the column has already been stripped (e.g. committing an
   *  updated reimport into a finalized package).
   */
  stripPlatformColumn(): void {
    if (!this.hasPlatformColumn()) return;
    this.db.exec(`
      PRAGMA foreign_keys=OFF;
      CREATE TABLE IF NOT EXISTS conversations_clean (
        id TEXT PRIMARY KEY,
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO conversations_clean (id, title, created_at, updated_at)
        SELECT id, title, created_at, updated_at FROM conversations;
      DROP TABLE conversations;
      ALTER TABLE conversations_clean RENAME TO conversations;
      PRAGMA foreign_keys=ON;
    `);
    // Invalidate the cache — the column is gone now.
    this.hasPlatformColumnCache = false;
  }

  /** Close the database connection */
  close(): void {
    this.db.close();
  }

  /**
   * Execute a parameterized query and return rows as objects.
   */
  query(sql: string, params?: string[]): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql);
    return (params ? stmt.all(...params as []) : stmt.all()) as Record<
      string,
      unknown
    >[];
  }
}
