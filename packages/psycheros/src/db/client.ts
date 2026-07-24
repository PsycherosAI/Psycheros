/**
 * Psycheros Database Client
 *
 * Provides a clean interface for database operations including
 * conversation and message management.
 */

import { type BindValue, Database } from "@db/sqlite";
import { initializeSchema } from "./schema.ts";
import { getVecVersion } from "./vector.ts";
import type {
  ContextSnapshotRecord,
  Conversation,
  CreatePulseInput,
  Message,
  PulseRow,
  PulseRunRow,
  PulseStats,
  ToolCall,
  TurnMetrics,
  UpdatePulseInput,
} from "../types.ts";

/**
 * Valid message roles that can be stored in the database.
 */
const VALID_ROLES = new Set(["system", "user", "assistant", "tool"]);

/**
 * Row type for conversations as stored in SQLite.
 */
interface ConversationRow {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  source_type: string | null;
  source_server_id: string | null;
  source_server_name: string | null;
  source_channel_id: string | null;
  source_channel_name: string | null;
}

/**
 * Row type for messages as stored in SQLite.
 */
interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  reasoning_content: string | null;
  tool_call_id: string | null;
  tool_calls: string | null;
  created_at: string;
  edited_at: string | null;
  pulse_id: string | null;
  pulse_name: string | null;
  is_voice: number | null;
  metadata: string | null;
}

/**
 * Row type for turn_metrics as stored in SQLite.
 */
interface TurnMetricsRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  request_started_at: string;
  ttfb: number | null;
  ttfc: number | null;
  max_chunk_gap: number | null;
  slow_chunk_count: number;
  total_duration: number | null;
  chunk_count: number;
  finish_reason: string | null;
  created_at: string;
}

/**
 * Row type for context_snapshots as stored in SQLite.
 */
interface ContextSnapshotRow {
  id: string;
  conversation_id: string;
  turn_index: number;
  iteration: number;
  timestamp: string;
  user_message: string;
  system_message: string;
  base_instructions_content: string | null;
  self_content: string | null;
  user_content: string | null;
  relationship_content: string | null;
  custom_content: string | null;
  memories_content: string | null;
  chat_history_content: string | null;
  lorebook_content: string | null;
  graph_content: string | null;
  vault_content: string | null;
  situational_awareness_content: string | null;
  messages_json: string;
  tool_definitions_json: string;
  metrics_json: string;
  plugin_hooks_json: string | null;
  created_at: string;
}

/**
 * Input type for creating a new message (without auto-generated fields).
 */
type MessageInput = Omit<Message, "id" | "createdAt">;

/**
 * Database client for Psycheros persistence operations.
 */
export class DBClient {
  private db: Database;

  /**
   * Creates a new database client.
   *
   * @param dbPath - Path to the SQLite database file
   * @throws Error if database initialization fails
   */
  constructor(dbPath: string) {
    // Ensure parent directory exists
    this.ensureDirectory(dbPath);

    // Open or create the database
    this.db = new Database(dbPath);

    try {
      // Enable foreign key constraints (off by default in SQLite)
      this.db.exec("PRAGMA foreign_keys = ON");

      // Initialize schema (idempotent)
      initializeSchema(this.db);
    } catch (error) {
      // Clean up on initialization failure
      this.db.close();
      throw error;
    }
  }

  /**
   * Ensures the parent directory for the database file exists.
   */
  private ensureDirectory(dbPath: string): void {
    const lastSlash = dbPath.lastIndexOf("/");
    if (lastSlash > 0) {
      const dir = dbPath.substring(0, lastSlash);
      try {
        Deno.mkdirSync(dir, { recursive: true });
      } catch (error) {
        // Directory might already exist, which is fine
        if (!(error instanceof Deno.errors.AlreadyExists)) {
          throw error;
        }
      }
    }
  }

  // ===========================================================================
  // Conversation Operations
  // ===========================================================================

  /**
   * Creates a new conversation.
   *
   * @param title - Optional title for the conversation
   * @param source - Optional source metadata (type, server, channel)
   * @returns The created conversation
   */
  createConversation(
    title?: string,
    source?: {
      sourceType?: string;
      sourceServerId?: string;
      sourceServerName?: string;
      sourceChannelId?: string;
      sourceChannelName?: string;
    },
  ): Conversation {
    const id = crypto.randomUUID();
    const now = new Date();
    const nowISO = now.toISOString();

    this.db.exec(
      `INSERT INTO conversations (id, title, created_at, updated_at, source_type, source_server_id, source_server_name, source_channel_id, source_channel_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        title ?? null,
        nowISO,
        nowISO,
        source?.sourceType ?? "web",
        source?.sourceServerId ?? null,
        source?.sourceServerName ?? null,
        source?.sourceChannelId ?? null,
        source?.sourceChannelName ?? null,
      ],
    );

    return {
      id,
      title: title ?? undefined,
      createdAt: now,
      updatedAt: now,
      sourceType: (source?.sourceType as Conversation["sourceType"]) ?? "web",
      sourceServerId: source?.sourceServerId,
      sourceServerName: source?.sourceServerName,
      sourceChannelId: source?.sourceChannelId,
      sourceChannelName: source?.sourceChannelName,
    };
  }

  /**
   * Retrieves a conversation by ID.
   *
   * @param id - The conversation ID
   * @returns The conversation or null if not found
   */
  getConversation(id: string): Conversation | null {
    const stmt = this.db.prepare(
      `SELECT id, title, created_at, updated_at, source_type, source_server_id, source_server_name, source_channel_id, source_channel_name
       FROM conversations
       WHERE id = ?`,
    );

    const row = stmt.get<ConversationRow>(id);
    stmt.finalize();

    if (!row) {
      return null;
    }

    return this.rowToConversation(row);
  }

  /**
   * Lists all conversations, ordered by most recently updated.
   *
   * @returns Array of conversations
   */
  listConversations(): Conversation[] {
    const stmt = this.db.prepare(
      `SELECT id, title, created_at, updated_at, source_type, source_server_id, source_server_name, source_channel_id, source_channel_name
       FROM conversations
       ORDER BY updated_at DESC`,
    );

    const rows = stmt.all<ConversationRow>();
    stmt.finalize();

    return rows.map((row) => this.rowToConversation(row));
  }

  /**
   * Lists conversations shown in the main Psycheros sidebar — web/null plus
   * entity-loom imports. Discord conversations live in their own hub.
   */
  listSidebarConversations(): Conversation[] {
    const stmt = this.db.prepare(
      `SELECT id, title, created_at, updated_at, source_type, source_server_id, source_server_name, source_channel_id, source_channel_name
       FROM conversations
       WHERE source_type IS NULL OR source_type IN ('web', 'import')
       ORDER BY updated_at DESC`,
    );

    const rows = stmt.all<ConversationRow>();
    stmt.finalize();

    return rows.map((row) => this.rowToConversation(row));
  }

  /**
   * Lists conversations filtered by source type.
   */
  listConversationsBySource(sourceType: string): Conversation[] {
    const stmt = this.db.prepare(
      `SELECT id, title, created_at, updated_at, source_type, source_server_id, source_server_name, source_channel_id, source_channel_name
       FROM conversations
       WHERE source_type = ?
       ORDER BY updated_at DESC`,
    );

    const rows = stmt.all<ConversationRow>(sourceType);
    stmt.finalize();
    return rows.map((row) => this.rowToConversation(row));
  }

  /**
   * Finds a conversation by Discord channel ID.
   */
  getConversationByChannel(channelId: string): Conversation | null {
    const stmt = this.db.prepare(
      `SELECT id, title, created_at, updated_at, source_type, source_server_id, source_server_name, source_channel_id, source_channel_name
       FROM conversations
       WHERE source_channel_id = ? AND source_type = 'discord'`,
    );

    const row = stmt.get<ConversationRow>(channelId);
    stmt.finalize();
    return row ? this.rowToConversation(row) : null;
  }

  /**
   * Updates the title of a conversation.
   *
   * @param id - The conversation ID
   * @param title - The new title (or undefined to clear)
   * @returns The updated conversation or null if not found
   */
  updateConversationTitle(
    id: string,
    title: string | undefined,
  ): Conversation | null {
    const now = new Date();
    const nowISO = now.toISOString();

    // Check if conversation exists first
    const conversation = this.getConversation(id);
    if (!conversation) {
      return null;
    }

    this.db.exec(
      `UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`,
      [title ?? null, nowISO, id],
    );

    return {
      ...conversation,
      title,
      updatedAt: now,
    };
  }

  /**
   * Deletes a conversation and all associated data.
   *
   * Manually deletes related records first to handle databases
   * created before CASCADE constraints were added.
   *
   * @param id - The conversation ID to delete
   * @returns true if a conversation was deleted, false if not found
   */
  deleteConversation(id: string): boolean {
    this.db.exec("BEGIN TRANSACTION");

    try {
      // Clean up vec_messages (vec0 virtual table has no CASCADE support)
      this.cleanupVecMessages(id);

      // Manually cascade: delete metrics first (references both conversations and messages)
      this.db.exec(
        `DELETE FROM turn_metrics WHERE conversation_id = ?`,
        [id],
      );

      // Delete message embeddings (before messages, to avoid FK issues)
      this.db.exec(
        `DELETE FROM message_embeddings WHERE conversation_id = ?`,
        [id],
      );

      // Delete messages
      this.db.exec(
        `DELETE FROM messages WHERE conversation_id = ?`,
        [id],
      );

      // Delete the conversation
      const result = this.db.exec(
        `DELETE FROM conversations WHERE id = ?`,
        [id],
      );

      this.db.exec("COMMIT");
      return result > 0;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Deletes multiple conversations and all associated data.
   *
   * Manually deletes related records first to handle databases
   * created before CASCADE constraints were added.
   *
   * @param ids - Array of conversation IDs to delete
   * @returns Number of conversations actually deleted
   */
  deleteConversations(ids: string[]): number {
    if (ids.length === 0) {
      return 0;
    }

    this.db.exec("BEGIN TRANSACTION");

    try {
      let deletedCount = 0;

      for (const id of ids) {
        // Clean up vec_messages (vec0 virtual table has no CASCADE support)
        this.cleanupVecMessages(id);

        // Manually cascade: delete metrics first
        this.db.exec(
          `DELETE FROM turn_metrics WHERE conversation_id = ?`,
          [id],
        );

        // Delete message embeddings (before messages, to avoid FK issues)
        this.db.exec(
          `DELETE FROM message_embeddings WHERE conversation_id = ?`,
          [id],
        );

        // Delete messages
        this.db.exec(
          `DELETE FROM messages WHERE conversation_id = ?`,
          [id],
        );

        // Delete the conversation
        const result = this.db.exec(
          `DELETE FROM conversations WHERE id = ?`,
          [id],
        );
        deletedCount += result;
      }

      this.db.exec("COMMIT");
      return deletedCount;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Remove vec_messages entries for a conversation's message_embeddings.
   * vec0 virtual tables don't support CASCADE, so this must be done manually.
   */
  private cleanupVecMessages(conversationId: string): void {
    // Only needed if sqlite-vec is loaded
    if (!getVecVersion(this.db)) return;

    const stmt = this.db.prepare(
      "SELECT rowid FROM message_embeddings WHERE conversation_id = ?",
    );
    const rows = stmt.all<{ rowid: number }>(conversationId);
    stmt.finalize();

    for (const row of rows) {
      this.db.exec("DELETE FROM vec_messages WHERE rowid = ?", [row.rowid]);
    }
  }

  /**
   * Converts a database row to a Conversation object.
   */
  private rowToConversation(row: ConversationRow): Conversation {
    return {
      id: row.id,
      title: row.title ?? undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      sourceType: (row.source_type as Conversation["sourceType"]) ?? "web",
      sourceServerId: row.source_server_id ?? undefined,
      sourceServerName: row.source_server_name ?? undefined,
      sourceChannelId: row.source_channel_id ?? undefined,
      sourceChannelName: row.source_channel_name ?? undefined,
    };
  }

  // ===========================================================================
  // Message Operations
  // ===========================================================================

  /**
   * Adds a message to a conversation.
   *
   * Uses a transaction to ensure both the message insert and
   * conversation timestamp update succeed or fail together.
   *
   * @param conversationId - The conversation ID
   * @param message - The message data (without id and createdAt)
   * @param messageId - Optional pre-generated ID (useful for linking to metrics)
   * @returns The created message with generated fields
   * @throws Error if conversation doesn't exist or insert fails
   */
  addMessage(
    conversationId: string,
    message: MessageInput,
    messageId?: string,
  ): Message {
    // Defense-in-depth: validate role at runtime even though TypeScript
    // enforces it at compile time and the DB schema has a CHECK constraint.
    // This catches bugs from type assertions or corrupted data.
    if (!VALID_ROLES.has(message.role)) {
      throw new Error(`Invalid message role: ${message.role}`);
    }

    const id = messageId ?? crypto.randomUUID();
    const now = new Date();
    const nowISO = now.toISOString();

    // Serialize tool_calls to JSON if present
    const toolCallsJson = message.toolCalls
      ? JSON.stringify(message.toolCalls)
      : null;

    // Use transaction to ensure atomicity
    this.db.exec("BEGIN TRANSACTION");

    try {
      // Verify conversation exists
      const checkStmt = this.db.prepare(
        "SELECT 1 FROM conversations WHERE id = ?",
      );
      const exists = checkStmt.get(conversationId);
      checkStmt.finalize();

      if (!exists) {
        throw new Error(`Conversation not found: ${conversationId}`);
      }

      this.db.exec(
        `INSERT INTO messages
         (id, conversation_id, role, content, reasoning_content, tool_call_id, tool_calls, created_at, pulse_id, pulse_name, is_voice, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          conversationId,
          message.role,
          message.content,
          message.reasoningContent ?? null,
          message.toolCallId ?? null,
          toolCallsJson,
          nowISO,
          message.pulseId ?? null,
          message.pulseName ?? null,
          message.isVoice ? 1 : 0,
          message.metadata ? JSON.stringify(message.metadata) : null,
        ],
      );

      // Update conversation's updated_at timestamp
      this.db.exec(
        `UPDATE conversations SET updated_at = ? WHERE id = ?`,
        [nowISO, conversationId],
      );

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      id,
      role: message.role,
      content: message.content,
      reasoningContent: message.reasoningContent,
      toolCallId: message.toolCallId,
      toolCalls: message.toolCalls,
      createdAt: now,
      pulseId: message.pulseId,
      pulseName: message.pulseName,
      isVoice: !!message.isVoice,
      metadata: message.metadata,
    };
  }

  /**
   * Insert a system message (e.g. context divider) without triggering an entity turn.
   */
  insertSystemMessage(conversationId: string, content: string): Message {
    return this.addMessage(conversationId, { role: "system", content });
  }

  /**
   * Retrieves all messages for a conversation.
   *
   * @param conversationId - The conversation ID
   * @returns Array of messages ordered by creation time
   */
  getMessages(conversationId: string): Message[] {
    const stmt = this.db.prepare(
      `SELECT id, conversation_id, role, content, reasoning_content,
              tool_call_id, tool_calls, created_at, edited_at,
              pulse_id, pulse_name, is_voice, metadata
       FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC`,
    );

    const rows = stmt.all<MessageRow>(conversationId);
    stmt.finalize();

    return rows.map((row) => this.rowToMessage(row));
  }

  /**
   * Retrieves messages for a conversation with cursor-based pagination.
   * Uses created_at as the cursor. Fetches limit+1 rows to determine hasMore.
   *
   * @param conversationId - The conversation ID
   * @param options.before - If provided, fetch messages created BEFORE this timestamp (exclusive)
   * @param options.limit - Max messages to return (default 50)
   */
  getMessagesPaginated(
    conversationId: string,
    options?: { before?: string; beforeId?: string; limit?: number },
  ): { messages: Message[]; hasMore: boolean } {
    const limit = options?.limit ?? 50;

    let query: string;
    let params: (string | number)[];

    if (options?.before) {
      // Scroll-back load: fetch the N most recent messages strictly older than
      // the cursor (DESC), so the batch hugs the cursor instead of jumping to
      // the oldest end of the range. Reversed below for display order.
      // Uses id as a tiebreaker when messages share the same created_at.
      const hasTiebreaker = !!options.beforeId;
      query = `SELECT id, conversation_id, role, content, reasoning_content,
                      tool_call_id, tool_calls, created_at, edited_at,
                      pulse_id, pulse_name, is_voice, metadata
               FROM messages
               WHERE conversation_id = ?
                 AND (created_at < ?${
        hasTiebreaker ? " OR (created_at = ? AND id < ?)" : ""
      })
               ORDER BY created_at DESC
               LIMIT ?`;
      params = hasTiebreaker
        ? [
          conversationId,
          options.before,
          options.before,
          options.beforeId!,
          limit + 1,
        ]
        : [conversationId, options.before, limit + 1];
    } else {
      // Initial load: fetch the most recent messages (DESC). Reversed below.
      query = `SELECT id, conversation_id, role, content, reasoning_content,
                      tool_call_id, tool_calls, created_at, edited_at,
                      pulse_id, pulse_name, is_voice, metadata
               FROM messages
               WHERE conversation_id = ?
               ORDER BY created_at DESC
               LIMIT ?`;
      params = [conversationId, limit + 1];
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all<MessageRow>(...params);
    stmt.finalize();

    const hasMore = rows.length > limit;
    const limitedRows = hasMore ? rows.slice(0, limit) : rows;

    // Both branches query DESC (newest-first); reverse to ASC for display so
    // orderedRows[0] is the oldest in the batch — which the route uses as the
    // next `oldestCreatedAt` cursor for further scroll-back.
    const orderedRows = [...limitedRows].reverse();

    return {
      messages: orderedRows.map((row) => this.rowToMessage(row)),
      hasMore,
    };
  }

  /**
   * Converts a database row to a Message object.
   *
   * @throws Error if the row contains invalid data (corrupted role or tool_calls)
   */
  private rowToMessage(row: MessageRow): Message {
    // Validate role from database
    if (!VALID_ROLES.has(row.role)) {
      throw new Error(
        `Corrupted data: invalid role "${row.role}" for message ${row.id}`,
      );
    }

    // Parse tool_calls JSON if present
    let toolCalls: ToolCall[] | undefined;
    if (row.tool_calls) {
      try {
        toolCalls = JSON.parse(row.tool_calls) as ToolCall[];
      } catch (error) {
        throw new Error(
          `Corrupted data: invalid tool_calls JSON for message ${row.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    // Parse metadata JSON if present (tool-result sidecar data)
    let metadata: Message["metadata"] | undefined;
    if (row.metadata) {
      try {
        metadata = JSON.parse(row.metadata) as Message["metadata"];
      } catch (error) {
        throw new Error(
          `Corrupted data: invalid metadata JSON for message ${row.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return {
      id: row.id,
      role: row.role as Message["role"],
      content: row.content,
      reasoningContent: row.reasoning_content ?? undefined,
      toolCallId: row.tool_call_id ?? undefined,
      toolCalls,
      createdAt: new Date(row.created_at),
      editedAt: row.edited_at ? new Date(row.edited_at) : undefined,
      pulseId: row.pulse_id ?? undefined,
      pulseName: row.pulse_name ?? undefined,
      isVoice: !!row.is_voice,
      metadata,
    };
  }

  /**
   * Updates a message's content.
   *
   * @param id - The message ID
   * @param content - The new content
   * @returns The updated message or null if not found
   */
  updateMessage(id: string, content: string): Message | null {
    const now = new Date();
    const nowISO = now.toISOString();

    this.db.exec("BEGIN TRANSACTION");

    try {
      // Check if message exists
      const checkStmt = this.db.prepare(
        "SELECT conversation_id FROM messages WHERE id = ?",
      );
      const existing = checkStmt.get<{ conversation_id: string }>(id);
      checkStmt.finalize();

      if (!existing) {
        this.db.exec("ROLLBACK");
        return null;
      }

      // Update the message
      this.db.exec(
        `UPDATE messages SET content = ?, edited_at = ? WHERE id = ?`,
        [content, nowISO, id],
      );

      // Update conversation's updated_at timestamp
      this.db.exec(
        `UPDATE conversations SET updated_at = ? WHERE id = ?`,
        [nowISO, existing.conversation_id],
      );

      this.db.exec("COMMIT");

      // Return the updated message by re-fetching it
      const getUpdatedStmt = this.db.prepare(
        `SELECT id, conversation_id, role, content, reasoning_content,
                tool_call_id, tool_calls, created_at, edited_at,
                pulse_id, pulse_name, is_voice, metadata
         FROM messages WHERE id = ?`,
      );
      const updatedRow = getUpdatedStmt.get<MessageRow>(id);
      getUpdatedStmt.finalize();

      if (!updatedRow) {
        // Should not happen, but handle gracefully
        return null;
      }

      return this.rowToMessage(updatedRow);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ===========================================================================
  // Metrics Operations
  // ===========================================================================

  /**
   * Adds turn metrics to the database.
   *
   * Non-fatal on error - logs warning and returns false.
   * Metrics are nice-to-have, not critical for operation.
   *
   * @param metrics - The metrics to persist
   * @returns true if successful, false on error
   */
  addTurnMetrics(metrics: TurnMetrics): boolean {
    try {
      this.db.exec(
        `INSERT INTO turn_metrics
         (id, conversation_id, message_id, request_started_at, ttfb, ttfc, max_chunk_gap,
          slow_chunk_count, total_duration, chunk_count, finish_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          metrics.id,
          metrics.conversationId,
          metrics.messageId ?? null,
          metrics.requestStartedAt,
          metrics.ttfb,
          metrics.ttfc,
          metrics.maxChunkGap,
          metrics.slowChunkCount,
          metrics.totalDuration,
          metrics.chunkCount,
          metrics.finishReason,
          metrics.createdAt,
        ],
      );
      return true;
    } catch (error) {
      console.warn(
        "Failed to persist turn metrics:",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  /**
   * Retrieves recent turn metrics for a conversation.
   *
   * @param conversationId - The conversation ID
   * @param limit - Maximum number of metrics to return (default 10)
   * @returns Array of metrics, newest first
   */
  getTurnMetrics(conversationId: string, limit = 10): TurnMetrics[] {
    const stmt = this.db.prepare(
      `SELECT id, conversation_id, message_id, request_started_at, ttfb, ttfc,
              max_chunk_gap, slow_chunk_count, total_duration, chunk_count,
              finish_reason, created_at
       FROM turn_metrics
       WHERE conversation_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    );

    const rows = stmt.all<TurnMetricsRow>(conversationId, limit);
    stmt.finalize();

    return rows.map((row) => this.rowToTurnMetrics(row));
  }

  /**
   * Retrieves metrics for a specific message.
   *
   * @param messageId - The message ID
   * @returns The metrics or null if none exist
   */
  getMetricsByMessageId(messageId: string): TurnMetrics | null {
    const stmt = this.db.prepare(
      `SELECT id, conversation_id, message_id, request_started_at, ttfb, ttfc,
              max_chunk_gap, slow_chunk_count, total_duration, chunk_count,
              finish_reason, created_at
       FROM turn_metrics
       WHERE message_id = ?`,
    );

    const row = stmt.get<TurnMetricsRow>(messageId);
    stmt.finalize();

    return row ? this.rowToTurnMetrics(row) : null;
  }

  /**
   * Retrieves the most recent turn metrics for a conversation.
   *
   * @param conversationId - The conversation ID
   * @returns The latest metrics or null if none exist
   */
  getLatestTurnMetrics(conversationId: string): TurnMetrics | null {
    const metrics = this.getTurnMetrics(conversationId, 1);
    return metrics.length > 0 ? metrics[0] : null;
  }

  /**
   * Converts a database row to a TurnMetrics object.
   */
  private rowToTurnMetrics(row: TurnMetricsRow): TurnMetrics {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      messageId: row.message_id ?? undefined,
      requestStartedAt: row.request_started_at,
      ttfb: row.ttfb,
      ttfc: row.ttfc,
      maxChunkGap: row.max_chunk_gap,
      slowChunkCount: row.slow_chunk_count,
      totalDuration: row.total_duration,
      chunkCount: row.chunk_count,
      finishReason: row.finish_reason,
      createdAt: row.created_at,
    };
  }

  // ===========================================================================
  // Date-based Message Operations (for Memory Summarization)
  // ===========================================================================

  /**
   * Retrieves all messages for a specific date.
   *
   * @param date - The date to query (Date object or ISO date string YYYY-MM-DD)
   * @param modifier - Optional SQLite datetime() modifier string for timezone-aware
   *                   logical date grouping (e.g. '-13 hours' for PST with 5 AM cutoff).
   *                   When provided, uses date(datetime(created_at, modifier)) instead of date(created_at).
   * @returns Array of messages with conversation IDs, ordered by creation time
   */
  getMessagesByDate(
    date: Date | string,
    modifier?: string,
    sourceType?: string,
  ): Array<Message & { conversationId: string }> {
    // Normalize date to YYYY-MM-DD format
    let dateStr: string;
    if (typeof date === "string") {
      dateStr = date;
    } else {
      dateStr = date.toISOString().split("T")[0];
    }

    const dateExpr = modifier
      ? `date(datetime(m.created_at, ?))`
      : `date(m.created_at)`;

    const join = sourceType
      ? `FROM messages m JOIN conversations c ON c.id = m.conversation_id`
      : `FROM messages m`;
    const sourceFilter = sourceType ? ` AND c.source_type = ?` : "";

    const stmt = this.db.prepare(
      `SELECT m.id, m.conversation_id, m.role, m.content, m.reasoning_content,
              m.tool_call_id, m.tool_calls, m.created_at, m.edited_at,
              m.pulse_id, m.pulse_name, m.is_voice
       ${join}
       WHERE ${dateExpr} = ?${sourceFilter}
       ORDER BY m.created_at ASC`,
    );

    const rows = sourceType
      ? (modifier
        ? stmt.all<MessageRow>(modifier, dateStr, sourceType)
        : stmt.all<MessageRow>(dateStr, sourceType))
      : (modifier
        ? stmt.all<MessageRow>(modifier, dateStr)
        : stmt.all<MessageRow>(dateStr));
    stmt.finalize();

    return rows.map((row) => ({
      ...this.rowToMessage(row),
      conversationId: row.conversation_id,
    }));
  }

  /**
   * Gets the date of the most recent message across all conversations.
   * Used for day-change detection.
   *
   * @returns The date of the most recent message, or null if no messages exist
   */
  getLastMessageDate(): Date | null {
    const stmt = this.db.prepare(
      `SELECT created_at FROM messages ORDER BY created_at DESC LIMIT 1`,
    );

    const row = stmt.get<{ created_at: string }>();
    stmt.finalize();

    return row ? new Date(row.created_at) : null;
  }

  /**
   * Gets all unique conversation IDs that had messages on a specific date.
   *
   * @param date - The date to query (Date object or ISO date string YYYY-MM-DD)
   * @param modifier - Optional SQLite datetime() modifier for timezone-aware logical dates
   * @returns Array of conversation IDs
   */
  getConversationIdsByDate(
    date: Date | string,
    modifier?: string,
    sourceType?: string,
  ): string[] {
    // Normalize date to YYYY-MM-DD format
    let dateStr: string;
    if (typeof date === "string") {
      dateStr = date;
    } else {
      dateStr = date.toISOString().split("T")[0];
    }

    const dateExpr = modifier
      ? `date(datetime(m.created_at, ?))`
      : `date(m.created_at)`;

    const join = sourceType
      ? `FROM messages m JOIN conversations c ON c.id = m.conversation_id`
      : `FROM messages m`;
    const sourceFilter = sourceType ? ` AND c.source_type = ?` : "";

    const stmt = this.db.prepare(
      `SELECT DISTINCT m.conversation_id ${join} WHERE ${dateExpr} = ?${sourceFilter}`,
    );

    const rows = sourceType
      ? (modifier
        ? stmt.all<{ conversation_id: string }>(modifier, dateStr, sourceType)
        : stmt.all<{ conversation_id: string }>(dateStr, sourceType))
      : (modifier
        ? stmt.all<{ conversation_id: string }>(modifier, dateStr)
        : stmt.all<{ conversation_id: string }>(dateStr));
    stmt.finalize();

    return rows.map((row) => row.conversation_id);
  }

  /**
   * Gets all dates that have messages but no memory summary.
   * Used by the catch-up summarization to find missed days.
   *
   * @param modifier - Optional SQLite datetime() modifier for timezone-aware logical dates.
   *                   When provided, both the date extraction and the JOIN key use the modifier.
   * @returns Array of dates in YYYY-MM-DD format, oldest first
   */
  getUnsummarizedDates(modifier?: string): string[] {
    let stmt;
    let rows: Array<{ date: string }>;

    if (modifier) {
      stmt = this.db.prepare(
        `SELECT DISTINCT DATE(datetime(m.created_at, ?)) as date
         FROM messages m
         LEFT JOIN summarized_chats sc
           ON sc.chat_id = m.conversation_id
           AND sc.message_date = DATE(datetime(m.created_at, ?))
         WHERE sc.message_date IS NULL
         ORDER BY date ASC`,
      );
      rows = stmt.all<{ date: string }>(modifier, modifier);
    } else {
      stmt = this.db.prepare(
        `SELECT DISTINCT DATE(m.created_at) as date
         FROM messages m
         LEFT JOIN summarized_chats sc
           ON sc.chat_id = m.conversation_id
           AND sc.message_date = DATE(m.created_at)
         WHERE sc.message_date IS NULL
         ORDER BY date ASC`,
      );
      rows = stmt.all<{ date: string }>();
    }

    stmt.finalize();

    return rows.map((row) => row.date);
  }

  // ===========================================================================
  // Memory Summary Operations
  // ===========================================================================

  /**
   * Gets an existing memory summary record.
   *
   * @param date - The date being summarized
   * @param granularity - The granularity level
   * @returns The summary record or null if not found
   */
  getMemorySummary(
    date: string,
    granularity: "daily" | "weekly" | "monthly" | "yearly",
  ): { id: string; filePath: string; chatIds: string[] } | null {
    const stmt = this.db.prepare(
      `SELECT id, file_path, chat_ids FROM memory_summaries
       WHERE date = ? AND granularity = ?`,
    );
    const row = stmt.get<{ id: string; file_path: string; chat_ids: string }>(
      date,
      granularity,
    );
    stmt.finalize();
    if (!row) return null;
    return {
      id: row.id,
      filePath: row.file_path,
      chatIds: JSON.parse(row.chat_ids),
    };
  }

  /**
   * Creates a new memory summary record.
   *
   * @param date - The date being summarized
   * @param granularity - The granularity level
   * @param filePath - Path to the memory file
   * @param chatIds - Array of chat IDs included in the summary
   * @returns The summary ID
   */
  createMemorySummary(
    date: string,
    granularity: "daily" | "weekly" | "monthly" | "yearly",
    filePath: string,
    chatIds: string[],
  ): string {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    this.db.exec(
      `INSERT INTO memory_summaries (id, date, granularity, file_path, chat_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, date, granularity, filePath, JSON.stringify(chatIds), now],
    );

    return id;
  }

  /**
   * Creates a memory summary record or returns existing ID if one already exists.
   * Prevents duplicate records for the same (date, granularity) pair.
   *
   * @param date - The date being summarized
   * @param granularity - The granularity level
   * @param filePath - Path to the memory file
   * @param chatIds - Array of chat IDs included in the summary
   * @returns The summary ID (existing or newly created)
   */
  upsertMemorySummary(
    date: string,
    granularity: "daily" | "weekly" | "monthly" | "yearly",
    filePath: string,
    chatIds: string[],
  ): string {
    // Check for existing record first
    const existing = this.getMemorySummary(date, granularity);
    if (existing) {
      console.log(
        `[DB] Memory summary already exists for ${date} (${granularity}), reusing ID ${existing.id}`,
      );
      return existing.id;
    }
    // Insert new
    return this.createMemorySummary(date, granularity, filePath, chatIds);
  }

  /**
   * Records that a chat has been summarized.
   *
   * @param chatId - The chat ID
   * @param messageDate - The date of the messages
   * @param summaryId - The summary ID
   */
  markChatSummarized(
    chatId: string,
    messageDate: string,
    summaryId: string,
  ): void {
    const now = new Date().toISOString();
    this.db.exec(
      `INSERT OR REPLACE INTO summarized_chats (chat_id, message_date, summary_id, summarized_at)
       VALUES (?, ?, ?, ?)`,
      [chatId, messageDate, summaryId, now],
    );
  }

  /**
   * Checks if a chat has already been summarized for a specific date.
   *
   * @param chatId - The chat ID
   * @param messageDate - The date of the messages
   * @returns True if the chat has been summarized for this date
   */
  isChatSummarized(chatId: string, messageDate: string): boolean {
    const stmt = this.db.prepare(
      `SELECT 1 FROM summarized_chats WHERE chat_id = ? AND message_date = ?`,
    );
    const result = stmt.get(chatId, messageDate);
    stmt.finalize();
    return !!result;
  }

  /**
   * Marks every conversation that has messages on a given date as summarized.
   * Used by the catch-up skip path (entity-core already has the memory) to keep
   * summarized_chats consistent with memory_summaries so getUnsummarizedDates
   * stops re-listing the date on every restart.
   *
   * @param date - The logical date (YYYY-MM-DD) — must match what the modifier produces
   * @param summaryId - The memory_summaries.id to associate
   * @param modifier - Optional SQLite datetime() modifier, matching getUnsummarizedDates
   */
  markConversationsForDateSummarized(
    date: string,
    summaryId: string,
    modifier?: string,
  ): void {
    const now = new Date().toISOString();
    if (modifier) {
      this.db.exec(
        `INSERT OR IGNORE INTO summarized_chats (chat_id, message_date, summary_id, summarized_at)
         SELECT DISTINCT m.conversation_id, DATE(datetime(m.created_at, ?)), ?, ?
         FROM messages m
         WHERE DATE(datetime(m.created_at, ?)) = ?`,
        [modifier, summaryId, now, modifier, date],
      );
    } else {
      this.db.exec(
        `INSERT OR IGNORE INTO summarized_chats (chat_id, message_date, summary_id, summarized_at)
         SELECT DISTINCT m.conversation_id, DATE(m.created_at), ?, ?
         FROM messages m
         WHERE DATE(m.created_at) = ?`,
        [summaryId, now, date],
      );
    }
  }

  /**
   * Gets the most recent memory summary for a granularity level.
   *
   * @param granularity - The granularity level
   * @returns The most recent summary date, or null if none exist
   */
  getLastSummaryDate(
    granularity: "daily" | "weekly" | "monthly" | "yearly",
  ): string | null {
    const stmt = this.db.prepare(
      `SELECT date FROM memory_summaries WHERE granularity = ? ORDER BY date DESC LIMIT 1`,
    );
    const row = stmt.get<{ date: string }>(granularity);
    stmt.finalize();
    return row?.date ?? null;
  }

  /**
   * Find memory summary records where the file no longer exists on disk.
   * Used by the startup integrity check to detect lost files.
   *
   * @param projectRoot - Root directory of the project
   * @returns Array of orphaned records
   */
  findOrphanedSummaries(
    projectRoot: string,
  ): Array<
    { id: string; date: string; granularity: string; filePath: string }
  > {
    const stmt = this.db.prepare(
      `SELECT id, date, granularity, file_path FROM memory_summaries ORDER BY date ASC`,
    );
    const rows = stmt.all<
      { id: string; date: string; granularity: string; file_path: string }
    >();
    stmt.finalize();

    const orphaned: Array<
      { id: string; date: string; granularity: string; filePath: string }
    > = [];
    for (const row of rows) {
      const fullPath = `${projectRoot}/${row.file_path}`;
      try {
        Deno.statSync(fullPath);
      } catch {
        orphaned.push({
          id: row.id,
          date: row.date,
          granularity: row.granularity,
          filePath: row.file_path,
        });
      }
    }

    return orphaned;
  }

  /**
   * Get all memory summary records.
   *
   * @returns Array of all summary records
   */
  getAllMemorySummaries(): Array<
    { id: string; date: string; granularity: string; filePath: string }
  > {
    const stmt = this.db.prepare(
      `SELECT id, date, granularity, file_path FROM memory_summaries ORDER BY date ASC`,
    );
    const rows = stmt.all<
      { id: string; date: string; granularity: string; file_path: string }
    >();
    stmt.finalize();
    return rows.map((r) => ({ ...r, filePath: r.file_path }));
  }

  /**
   * Delete a memory summary record and its associated summarized_chats entries.
   * Used by the integrity check to clear orphaned records for regeneration.
   *
   * @param summaryId - The summary record ID to delete
   */
  deleteMemorySummary(summaryId: string): void {
    // Delete associated summarized_chats first (FK constraint)
    this.db.exec(
      `DELETE FROM summarized_chats WHERE summary_id = ?`,
      [summaryId],
    );
    this.db.exec(
      `DELETE FROM memory_summaries WHERE id = ?`,
      [summaryId],
    );
  }

  // ===========================================================================
  // Situational Awareness Operations
  // ===========================================================================

  /**
   * Get the most recent non-Pulse user message across all conversations.
   * Used to build the Situational Awareness block for entity context.
   * Excludes Pulse-triggered messages (pulse_id IS NULL).
   */
  getLatestUserInteraction(): {
    createdAt: string;
    conversationId: string;
    title: string | null;
  } | null {
    const stmt = this.db.prepare(`
      SELECT m.created_at, m.conversation_id, c.title
      FROM messages m
      LEFT JOIN conversations c ON c.id = m.conversation_id
      WHERE m.role = 'user' AND m.pulse_id IS NULL AND (c.source_type IS NULL OR c.source_type = 'web')
      ORDER BY m.created_at DESC
      LIMIT 1
    `);
    const row = stmt.get() as {
      created_at: string;
      conversation_id: string;
      title: string | null;
    } | undefined;
    stmt.finalize();
    if (!row) return null;
    return {
      createdAt: row.created_at,
      conversationId: row.conversation_id,
      title: row.title,
    };
  }

  // ===========================================================================
  // Context Snapshot Operations
  // ===========================================================================

  /**
   * Maximum number of context snapshots to retain per conversation.
   */
  private static readonly MAX_SNAPSHOTS_PER_CONVERSATION = 50;

  /**
   * Persists a context snapshot to the database.
   * Non-fatal — logs warnings on failure. Prunes old snapshots beyond the cap.
   *
   * @param snapshot - The snapshot record to persist
   * @returns True if the snapshot was persisted successfully
   */
  addContextSnapshot(
    snapshot: Omit<ContextSnapshotRecord, "id" | "createdAt">,
  ): boolean {
    try {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      this.db.exec(
        `INSERT INTO context_snapshots
         (id, conversation_id, turn_index, iteration, timestamp, user_message,
          system_message, base_instructions_content, self_content, user_content,
          relationship_content, custom_content, memories_content, chat_history_content,
          lorebook_content, graph_content, vault_content, situational_awareness_content,
          messages_json, tool_definitions_json, metrics_json, plugin_hooks_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          snapshot.conversationId,
          snapshot.turnIndex,
          snapshot.iteration,
          snapshot.timestamp,
          snapshot.userMessage,
          snapshot.systemMessage,
          snapshot.baseInstructionsContent ?? null,
          snapshot.selfContent ?? null,
          snapshot.userContent ?? null,
          snapshot.relationshipContent ?? null,
          snapshot.customContent ?? null,
          snapshot.memoriesContent ?? null,
          snapshot.chatHistoryContent ?? null,
          snapshot.lorebookContent ?? null,
          snapshot.graphContent ?? null,
          snapshot.vaultContent ?? null,
          snapshot.situationalAwarenessContent ?? null,
          snapshot.messagesJson,
          snapshot.toolDefinitionsJson,
          snapshot.metricsJson,
          snapshot.pluginHooksJson ?? null,
          now,
        ],
      );

      // Prune old snapshots beyond the cap
      this.db.exec(
        `DELETE FROM context_snapshots
         WHERE conversation_id = ?
           AND id NOT IN (
             SELECT id FROM context_snapshots
             WHERE conversation_id = ?
             ORDER BY turn_index DESC, iteration DESC
             LIMIT ?
           )`,
        [
          snapshot.conversationId,
          snapshot.conversationId,
          DBClient.MAX_SNAPSHOTS_PER_CONVERSATION,
        ],
      );

      return true;
    } catch (error) {
      console.warn(
        "Failed to persist context snapshot:",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  /**
   * Retrieves all context snapshots for a conversation.
   *
   * @param conversationId - The conversation ID
   * @returns Array of snapshots, ordered by turn index ascending
   */
  getContextSnapshots(conversationId: string): ContextSnapshotRecord[] {
    const stmt = this.db.prepare(
      `SELECT id, conversation_id, turn_index, iteration, timestamp, user_message,
              system_message, base_instructions_content, self_content, user_content,
              relationship_content, custom_content, memories_content, chat_history_content,
              lorebook_content, graph_content, vault_content, situational_awareness_content,
              messages_json, tool_definitions_json, metrics_json, plugin_hooks_json, created_at
       FROM context_snapshots
       WHERE conversation_id = ?
       ORDER BY turn_index ASC, iteration ASC`,
    );

    const rows = stmt.all<ContextSnapshotRow>(conversationId);
    stmt.finalize();

    return rows.map((row) => this.rowToContextSnapshot(row));
  }

  /**
   * Retrieves the most recent context snapshot for a conversation.
   *
   * @param conversationId - The conversation ID
   * @returns The latest snapshot or null if none exist
   */
  getLatestContextSnapshot(
    conversationId: string,
  ): ContextSnapshotRecord | null {
    const stmt = this.db.prepare(
      `SELECT id, conversation_id, turn_index, iteration, timestamp, user_message,
              system_message, base_instructions_content, self_content, user_content,
              relationship_content, custom_content, memories_content, chat_history_content,
              lorebook_content, graph_content, vault_content, situational_awareness_content,
              messages_json, tool_definitions_json, metrics_json, plugin_hooks_json, created_at
       FROM context_snapshots
       WHERE conversation_id = ?
       ORDER BY turn_index DESC, iteration DESC
       LIMIT 1`,
    );

    const row = stmt.get<ContextSnapshotRow>(conversationId);
    stmt.finalize();

    return row ? this.rowToContextSnapshot(row) : null;
  }

  /**
   * Converts a database row to a ContextSnapshotRecord.
   */
  private rowToContextSnapshot(row: ContextSnapshotRow): ContextSnapshotRecord {
    return {
      id: row.id,
      conversationId: row.conversation_id,
      turnIndex: row.turn_index,
      iteration: row.iteration,
      timestamp: row.timestamp,
      userMessage: row.user_message,
      systemMessage: row.system_message,
      baseInstructionsContent: row.base_instructions_content ?? undefined,
      selfContent: row.self_content ?? undefined,
      userContent: row.user_content ?? undefined,
      relationshipContent: row.relationship_content ?? undefined,
      customContent: row.custom_content ?? undefined,
      memoriesContent: row.memories_content ?? undefined,
      chatHistoryContent: row.chat_history_content ?? undefined,
      lorebookContent: row.lorebook_content ?? undefined,
      graphContent: row.graph_content ?? undefined,
      vaultContent: row.vault_content ?? undefined,
      situationalAwarenessContent: row.situational_awareness_content ??
        undefined,
      messagesJson: row.messages_json,
      toolDefinitionsJson: row.tool_definitions_json,
      metricsJson: row.metrics_json,
      pluginHooksJson: row.plugin_hooks_json ?? undefined,
      createdAt: row.created_at,
    };
  }

  // ===========================================================================
  // Pulse Operations
  // ===========================================================================

  /**
   * Row type for pulses as stored in SQLite. Run statistics are no longer
   * carried on this row — see {@link DBClient.getPulseStats}.
   */
  private static pulseRowToPulse(row: Record<string, unknown>): PulseRow {
    return {
      id: row.id as string,
      name: row.name as string,
      description: (row.description as string) ?? null,
      promptText: row.prompt_text as string,
      chatMode: row.chat_mode as "visible" | "silent",
      conversationId: (row.conversation_id as string) ?? null,
      enabled: (row.enabled as number) === 1,
      triggerType: row.trigger_type as
        | "cron"
        | "inactivity"
        | "webhook"
        | "filesystem",
      cronExpression: (row.cron_expression as string) ?? null,
      intervalSeconds: (row.interval_seconds as number) ?? null,
      randomIntervalMin: (row.random_interval_min as number) ?? null,
      randomIntervalMax: (row.random_interval_max as number) ?? null,
      runAt: (row.run_at as string) ?? null,
      inactivityThresholdSeconds:
        (row.inactivity_threshold_seconds as number) ?? null,
      chainPulseIds: row.chain_pulse_ids
        ? JSON.parse(row.chain_pulse_ids as string) as string[]
        : [],
      maxChainDepth: row.max_chain_depth as number,
      source: row.source as "user" | "entity",
      autoDelete: (row.auto_delete as number) === 1,
      webhookToken: (row.webhook_token as string) ?? null,
      filesystemWatchPath: (row.filesystem_watch_path as string) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }

  /**
   * List all pulses, optionally filtered.
   */
  listPulses(filter?: { enabled?: boolean }): PulseRow[] {
    if (filter?.enabled !== undefined) {
      const stmt = this.db.prepare(
        `SELECT * FROM pulses WHERE enabled = ? ORDER BY created_at DESC`,
      );
      const rows = stmt.all(filter.enabled ? 1 : 0) as Record<
        string,
        unknown
      >[];
      stmt.finalize();
      return rows.map((r) => DBClient.pulseRowToPulse(r));
    }

    const stmt = this.db.prepare(
      "SELECT * FROM pulses ORDER BY created_at DESC",
    );
    const rows = stmt.all() as Record<string, unknown>[];
    stmt.finalize();
    return rows.map((r) => DBClient.pulseRowToPulse(r));
  }

  /**
   * Get enabled pulses assigned to a specific conversation.
   */
  getActivePulsesForConversation(conversationId: string): PulseRow[] {
    const stmt = this.db.prepare(
      `SELECT * FROM pulses
       WHERE enabled = 1 AND conversation_id = ?
       ORDER BY created_at DESC`,
    );
    const rows = stmt.all(conversationId) as Record<string, unknown>[];
    stmt.finalize();
    return rows.map((r) => DBClient.pulseRowToPulse(r));
  }

  /**
   * Get a single pulse by ID.
   */
  getPulse(id: string): PulseRow | null {
    const stmt = this.db.prepare("SELECT * FROM pulses WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    stmt.finalize();
    return row ? DBClient.pulseRowToPulse(row) : null;
  }

  /**
   * Get a pulse by its webhook token.
   */
  getPulseByWebhookToken(token: string): PulseRow | null {
    const stmt = this.db.prepare(
      "SELECT * FROM pulses WHERE webhook_token = ?",
    );
    const row = stmt.get(token) as Record<string, unknown> | undefined;
    stmt.finalize();
    return row ? DBClient.pulseRowToPulse(row) : null;
  }

  /**
   * Create a new pulse.
   */
  createPulse(data: CreatePulseInput): PulseRow {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const webhookToken = data.webhookToken ??
      crypto.randomUUID().replace(/-/g, "");

    this.db.exec(
      `INSERT INTO pulses
       (id, name, description, prompt_text, chat_mode, conversation_id, enabled,
        trigger_type, cron_expression, interval_seconds, random_interval_min,
        random_interval_max, run_at, inactivity_threshold_seconds, chain_pulse_ids,
        max_chain_depth, source, auto_delete, webhook_token, filesystem_watch_path,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        data.name,
        data.description ?? null,
        data.promptText,
        data.chatMode ?? "visible",
        data.conversationId ?? null,
        data.enabled !== false ? 1 : 0,
        data.triggerType ?? "cron",
        data.cronExpression ?? null,
        data.intervalSeconds ?? null,
        data.randomIntervalMin ?? null,
        data.randomIntervalMax ?? null,
        data.runAt ?? null,
        data.inactivityThresholdSeconds ?? null,
        JSON.stringify(data.chainPulseIds ?? []),
        data.maxChainDepth ?? 3,
        data.source ?? "user",
        data.autoDelete ? 1 : 0,
        webhookToken,
        data.filesystemWatchPath ?? null,
        now,
        now,
      ],
    );

    return this.getPulse(id)!;
  }

  /**
   * Update a pulse. Returns true if a row was updated.
   */
  updatePulse(id: string, data: Partial<UpdatePulseInput>): boolean {
    const sets: string[] = [];
    const values: unknown[] = [];

    const fields: Array<[string, unknown]> = [
      ["name", data.name],
      ["description", data.description],
      ["prompt_text", data.promptText],
      ["chat_mode", data.chatMode],
      ["conversation_id", data.conversationId],
      [
        "enabled",
        data.enabled !== undefined ? (data.enabled ? 1 : 0) : undefined,
      ],
      ["trigger_type", data.triggerType],
      ["cron_expression", data.cronExpression],
      ["interval_seconds", data.intervalSeconds],
      ["random_interval_min", data.randomIntervalMin],
      ["random_interval_max", data.randomIntervalMax],
      ["run_at", data.runAt],
      ["inactivity_threshold_seconds", data.inactivityThresholdSeconds],
      [
        "chain_pulse_ids",
        data.chainPulseIds !== undefined
          ? JSON.stringify(data.chainPulseIds)
          : undefined,
      ],
      ["max_chain_depth", data.maxChainDepth],
      [
        "auto_delete",
        data.autoDelete !== undefined ? (data.autoDelete ? 1 : 0) : undefined,
      ],
      ["filesystem_watch_path", data.filesystemWatchPath],
    ];

    for (const [col, val] of fields) {
      if (val !== undefined) {
        sets.push(`${col} = ?`);
        values.push(val);
      }
    }

    if (sets.length === 0) return false;

    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);

    this.db.exec(
      `UPDATE pulses SET ${sets.join(", ")} WHERE id = ?`,
      values as BindValue[],
    );
    return true;
  }

  /**
   * Delete a pulse. Run history in `job_runs` is left in place (the
   * foreign key sets schedule_id to NULL); deleting the pulse only
   * cleans up the definition.
   */
  deletePulse(id: string): boolean {
    const result = this.db.exec("DELETE FROM pulses WHERE id = ?", [id]);
    return result > 0;
  }

  // ===========================================================================
  // Pulse Run Projections (over job_runs)
  // ===========================================================================
  //
  // The scheduler's `job_runs` table is the source of truth for every pulse
  // execution. These helpers project rows into the UI-facing PulseRunRow /
  // PulseStats shapes so existing routes and templates keep working without
  // change.

  private static pulseRunFromJobRun(
    row: Record<string, unknown>,
  ): PulseRunRow {
    const payload = row.payload_json
      ? JSON.parse(row.payload_json as string) as Record<string, unknown>
      : {};
    return {
      id: row.id as string,
      pulseId: (payload.pulseId as string) ?? "",
      conversationId: (payload.conversationId as string) ?? null,
      triggerSource: (payload.triggerSource as string) ?? "cron",
      startedAt: (row.started_at as string) ?? (row.scheduled_for as string),
      completedAt: (row.completed_at as string) ?? null,
      durationMs: (row.duration_ms as number) ?? null,
      status: row.status as string,
      resultSummary: (row.result_summary as string) ?? null,
      errorMessage: (row.error_message as string) ?? null,
      toolCallsCount: (payload.toolCallsCount as number) ?? 0,
      outputContent: (payload.outputContent as string) ?? null,
      chainDepth: (payload.chainDepth as number) ?? 0,
      chainParentRunId: (payload.chainParentRunId as string) ?? null,
      createdAt: row.created_at as string,
    };
  }

  /**
   * Fetch a single pulse run by job_run id.
   */
  getPulseRun(id: string): PulseRunRow | null {
    const stmt = this.db.prepare(
      "SELECT * FROM job_runs WHERE id = ? AND handler = 'pulse.execute'",
    );
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    stmt.finalize();
    return row ? DBClient.pulseRunFromJobRun(row) : null;
  }

  /**
   * List pulse runs with optional filtering. Projected from `job_runs`
   * where `handler = 'pulse.execute'`.
   */
  listPulseRuns(filter?: {
    pulseId?: string;
    status?: string;
    // Inclusion list of statuses. Takes precedence over `status` when set.
    // Used by the Pulse Logs UI to hide `skipped` ticks by default.
    statuses?: string[];
    limit?: number;
    offset?: number;
  }): { runs: PulseRunRow[]; total: number } {
    const limit = filter?.limit ?? 50;
    const offset = filter?.offset ?? 0;

    const where: string[] = ["handler = 'pulse.execute'"];
    const params: unknown[] = [];
    if (filter?.pulseId) {
      where.push("json_extract(payload_json, '$.pulseId') = ?");
      params.push(filter.pulseId);
    }
    if (filter?.statuses && filter.statuses.length > 0) {
      where.push(
        `status IN (${filter.statuses.map(() => "?").join(", ")})`,
      );
      params.push(...filter.statuses);
    } else if (filter?.statuses && filter.statuses.length === 0) {
      // Explicitly-empty inclusion list — user has cleared every filter
      // pill. Match nothing rather than falling through to "no status
      // filter" (which would return every run).
      where.push("1 = 0");
    } else if (filter?.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    const whereClause = `WHERE ${where.join(" AND ")}`;

    const countStmt = this.db.prepare(
      `SELECT COUNT(*) as count FROM job_runs ${whereClause}`,
    );
    const total =
      (countStmt.get(...(params as BindValue[])) as { count: number })?.count ??
        0;
    countStmt.finalize();

    const stmt = this.db.prepare(
      `SELECT * FROM job_runs ${whereClause}
       ORDER BY COALESCE(started_at, scheduled_for) DESC, id DESC
       LIMIT ? OFFSET ?`,
    );
    const rows = stmt.all(
      ...(params as BindValue[]),
      limit,
      offset,
    ) as Record<string, unknown>[];
    stmt.finalize();

    return { runs: rows.map(DBClient.pulseRunFromJobRun), total };
  }

  /**
   * Aggregate run statistics for a pulse, derived from `job_runs`.
   * Replaces the old denormalized columns on `pulses`. The `lastRunAt` /
   * `lastCompletedAt` fields reflect the most recent run regardless of
   * status, so the user-facing pulse UI surfaces failures and errors.
   * For the inactivity-pulse cooldown check (which must gate on success
   * only to avoid self-deadlocking on skipped ticks), call
   * {@link getLastSuccessfulPulseRunAt} instead.
   */
  getPulseStats(pulseId: string): PulseStats {
    const aggStmt = this.db.prepare(
      `SELECT
         SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS s,
         SUM(CASE WHEN status IN ('error', 'dead') THEN 1 ELSE 0 END) AS e
       FROM job_runs
       WHERE handler = 'pulse.execute'
         AND json_extract(payload_json, '$.pulseId') = ?`,
    );
    const agg = aggStmt.get(pulseId) as
      | { s: number | null; e: number | null }
      | undefined;
    aggStmt.finalize();

    const latestStmt = this.db.prepare(
      `SELECT started_at, completed_at, status, duration_ms,
              result_summary, error_message
       FROM job_runs
       WHERE handler = 'pulse.execute'
         AND json_extract(payload_json, '$.pulseId') = ?
         AND completed_at IS NOT NULL
       ORDER BY completed_at DESC LIMIT 1`,
    );
    const latest = latestStmt.get(pulseId) as
      | Record<string, unknown>
      | undefined;
    latestStmt.finalize();

    return {
      successCount: agg?.s ?? 0,
      errorCount: agg?.e ?? 0,
      lastRunAt: (latest?.started_at as string) ?? null,
      lastCompletedAt: (latest?.completed_at as string) ?? null,
      lastStatus: (latest?.status as string) ?? null,
      lastDurationMs: (latest?.duration_ms as number) ?? null,
      lastResult: (latest?.result_summary as string) ?? null,
      lastError: (latest?.error_message as string) ?? null,
    };
  }

  /**
   * Timestamp of the most recent successful run of a pulse, or null if
   * the pulse has never completed successfully. Scoped narrowly for the
   * inactivity-pulse cooldown check — the cooldown must not gate on
   * `skipped` ticks (the cooldown check itself produces skipped rows, so
   * gating on them would self-deadlock the pulse) or `error`/`dead`
   * runs (a failing pulse shouldn't be punished into permanent silence).
   */
  getLastSuccessfulPulseRunAt(pulseId: string): string | null {
    const stmt = this.db.prepare(
      `SELECT started_at
       FROM job_runs
       WHERE handler = 'pulse.execute'
         AND json_extract(payload_json, '$.pulseId') = ?
         AND status = 'success'
         AND completed_at IS NOT NULL
       ORDER BY completed_at DESC LIMIT 1`,
    );
    const row = stmt.get(pulseId) as { started_at: string } | undefined;
    stmt.finalize();
    return row?.started_at ?? null;
  }

  /**
   * Get the timestamp of the most recent user message across all
   * conversations. Used by the inactivity trigger eligibility check.
   */
  getLastUserMessageTimestamp(): string | null {
    const stmt = this.db.prepare(
      `SELECT m.created_at FROM messages m
       LEFT JOIN conversations c ON c.id = m.conversation_id
       WHERE m.role = 'user' AND m.pulse_id IS NULL AND (c.source_type IS NULL OR c.source_type = 'web')
       ORDER BY m.created_at DESC LIMIT 1`,
    );
    const row = stmt.get<{ created_at: string }>();
    stmt.finalize();
    return row?.created_at ?? null;
  }

  /**
   * Detect if a chain would create a cycle by walking the parent run chain.
   * Parent run IDs are scheduler job_run ids.
   */
  detectPulseChainCycle(pulseId: string, parentRunId: string | null): boolean {
    if (!parentRunId) return false;

    const visited = new Set<string>();
    let currentRunId: string | null = parentRunId;

    while (currentRunId) {
      if (visited.has(currentRunId)) return true;
      visited.add(currentRunId);

      const run = this.getPulseRun(currentRunId);
      if (!run) break;
      if (run.pulseId === pulseId) return true;
      currentRunId = run.chainParentRunId;
    }

    return false;
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  /**
   * Closes the database connection.
   * Should be called when the client is no longer needed.
   */
  close(): void {
    this.db.close();
  }

  // ===========================================================================
  // Discord DM Whitelist Operations
  // ===========================================================================

  addDmWhitelistEntry(userId: string, username: string, notes: string): void {
    this.db.exec(
      `INSERT OR REPLACE INTO dm_whitelist (user_id, username, notes, added_at)
       VALUES (?, ?, ?, ?)`,
      [userId, username, notes, new Date().toISOString()],
    );
  }

  removeDmWhitelistEntry(userId: string): void {
    this.db.exec(`DELETE FROM dm_whitelist WHERE user_id = ?`, [userId]);
  }

  updateDmWhitelistEntry(
    userId: string,
    username: string,
    notes: string,
  ): void {
    this.db.exec(
      `UPDATE dm_whitelist SET username = ?, notes = ? WHERE user_id = ?`,
      [username, notes, userId],
    );
  }

  getDmWhitelist(): Array<
    { userId: string; username: string; notes: string; addedAt: string }
  > {
    const stmt = this.db.prepare(
      `SELECT user_id, username, notes, added_at FROM dm_whitelist ORDER BY username ASC`,
    );
    const rows = stmt.all() as Array<
      { user_id: string; username: string; notes: string; added_at: string }
    >;
    stmt.finalize();
    return rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      notes: r.notes,
      addedAt: r.added_at,
    }));
  }

  isDmUserAllowed(userId: string): boolean {
    const stmt = this.db.prepare(
      `SELECT 1 FROM dm_whitelist WHERE user_id = ?`,
    );
    const row = stmt.get(userId);
    stmt.finalize();
    return !!row;
  }

  // ===========================================================================
  // Raw Database Access
  // ===========================================================================

  /**
   * Get the raw database connection for advanced operations.
   * Use with caution - bypasses the client's abstraction layer.
   *
   * @returns The raw SQLite database instance
   */
  getRawDb(): Database {
    return this.db;
  }
}
