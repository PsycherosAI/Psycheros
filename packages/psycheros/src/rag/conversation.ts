/**
 * Conversational RAG Module
 *
 * Provides semantic search over chat history for retrieving relevant
 * past messages from the current or all conversations.
 */

import type { Database } from "@db/sqlite";
import { getEmbedder } from "./embedder.ts";
import {
  deserializeVector,
  getVecVersion,
  serializeVector,
} from "../db/vector.ts";
import { formatMessageTimestamp } from "../entity/loop.ts";

/**
 * Options for chat history search.
 */
export interface ChatSearchOptions {
  /** The query text to search for */
  query: string;
  /** Limit to a specific conversation (undefined = search all) */
  conversationId?: string;
  /** Maximum number of results */
  limit: number;
  /** Minimum similarity score (0-1) */
  minScore: number;
}

/**
 * Options for tiered chat history search.
 */
export interface TieredSearchOptions {
  /** The query text to search for */
  query: string;
  /** Current conversation ID (searched first) */
  conversationId: string;
  /** Maximum number of results */
  limit: number;
  /** Minimum similarity score (0-1) */
  minScore: number;
  /** Score threshold for current chat results (default: 0.6) */
  currentThreshold?: number;
}

/**
 * A retrieved message from chat history.
 */
export interface RetrievedMessage {
  /** Message ID */
  messageId: string;
  /** Conversation ID */
  conversationId: string;
  /** Message role */
  role: "user" | "assistant" | "system" | "tool";
  /** Message content */
  content: string;
  /** Similarity score */
  score: number;
  /** When the message was created */
  createdAt: Date;
  /** True if this message was spoken via voice chat */
  isVoice?: boolean;
}

/**
 * Result from vector search join.
 */
interface MessageVectorSearchRow {
  id: string;
  message_id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
  distance: number;
  is_voice?: number | null;
}

/**
 * Message row with embedding from database.
 */
interface MessageEmbeddingRow {
  id: string;
  message_id: string;
  conversation_id: string;
  role: string;
  content: string;
  embedding: Uint8Array | null;
  created_at: string;
  is_voice?: number | null;
}

/**
 * Check if sqlite-vec is available.
 */
function isVectorExtensionAvailable(db: Database): boolean {
  return getVecVersion(db) !== null;
}

/**
 * Calculate cosine similarity between two vectors.
 * Used as fallback when sqlite-vec is not available.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Conversational RAG for searching chat history.
 */
export class ConversationRAG {
  private readonly db: Database;
  private readonly useVectorExt: boolean;

  constructor(db: Database) {
    this.db = db;
    this.useVectorExt = isVectorExtensionAvailable(db);
  }

  /**
   * Search chat history for relevant messages.
   *
   * @param options - Search options
   * @returns Array of retrieved messages sorted by relevance
   */
  async search(options: ChatSearchOptions): Promise<RetrievedMessage[]> {
    const embedder = getEmbedder();
    await embedder.initialize();
    const queryEmbedding = await embedder.embed(options.query);

    // Use sqlite-vec if available, otherwise fall back to in-memory
    if (this.useVectorExt) {
      return this.searchWithVectorExt(queryEmbedding, options);
    } else {
      return this.searchInMemory(queryEmbedding, options);
    }
  }

  /**
   * Tiered search: first search current conversation, then expand to all if needed.
   *
   * This provides the best of both worlds:
   * - Context continuity when relevant results exist in current chat
   * - Cross-chat memory when current chat doesn't have good matches
   *
   * @param options - Tiered search options
   * @returns Array of retrieved messages sorted by relevance
   */
  async searchTiered(
    options: TieredSearchOptions,
  ): Promise<RetrievedMessage[]> {
    const threshold = options.currentThreshold ?? 0.6;

    // Phase 1: Search current conversation
    const currentResults = await this.search({
      query: options.query,
      conversationId: options.conversationId,
      limit: options.limit,
      minScore: options.minScore,
    });

    // If we found good results above threshold, return them
    if (currentResults.length > 0 && currentResults[0].score >= threshold) {
      console.log(
        `[ChatRAG] Using current chat results (top score: ${
          currentResults[0].score.toFixed(2)
        } >= ${threshold})`,
      );
      return currentResults;
    }

    // Phase 2: Expand to all conversations
    console.log(
      `[ChatRAG] Expanding to all conversations (current chat score: ${
        currentResults[0]?.score.toFixed(2) ?? "none"
      } < ${threshold})`,
    );
    return await this.search({
      query: options.query,
      conversationId: undefined,
      limit: options.limit,
      minScore: options.minScore,
    });
  }

  /**
   * Search using sqlite-vec extension for efficient vector search.
   */
  private searchWithVectorExt(
    queryEmbedding: number[],
    options: ChatSearchOptions,
  ): RetrievedMessage[] {
    const serialized = serializeVector(queryEmbedding);

    // Use subquery to apply LIMIT directly to vec0 query (required by sqlite-vec)
    // We fetch more results than needed and filter in memory if conversationId is specified
    const fetchLimit = options.conversationId
      ? options.limit * 3
      : options.limit;

    const sql = `
      SELECT e.id, e.message_id, e.conversation_id, e.role, e.content, e.created_at, v.distance, m.is_voice
      FROM (
        SELECT rowid, distance
        FROM vec_messages
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
      ) v
      JOIN message_embeddings e ON e.rowid = v.rowid
      LEFT JOIN messages m ON m.id = e.message_id
      ${options.conversationId ? "WHERE e.conversation_id = ?" : ""}
      ORDER BY v.distance
    `;

    const params: (string | Uint8Array | number)[] = [serialized, fetchLimit];
    if (options.conversationId) {
      params.push(options.conversationId);
    }

    const stmt = this.db.prepare(sql);
    const allRows = stmt.all<MessageVectorSearchRow>(...params);
    stmt.finalize();

    const results: RetrievedMessage[] = [];

    for (const row of allRows) {
      // Convert distance to similarity (cosine distance = 1 - similarity)
      const similarity = 1 - row.distance;

      if (similarity >= options.minScore) {
        results.push({
          messageId: row.message_id,
          conversationId: row.conversation_id,
          role: row.role as RetrievedMessage["role"],
          content: row.content,
          score: similarity,
          createdAt: new Date(row.created_at),
          isVoice: !!row.is_voice,
        });
      }

      // Stop if we have enough results
      if (results.length >= options.limit) {
        break;
      }
    }

    console.log(
      `[ChatRAG] Found ${results.length} relevant messages${
        options.conversationId
          ? ` in conversation ${options.conversationId}`
          : " across all conversations"
      } [sqlite-vec]`,
    );

    return results;
  }

  /**
   * Search using in-memory cosine similarity (fallback).
   */
  private searchInMemory(
    queryEmbedding: number[],
    options: ChatSearchOptions,
  ): RetrievedMessage[] {
    // Build query based on whether we're filtering by conversation
    let sql: string;
    let params: string[];

    if (options.conversationId) {
      sql = `
        SELECT e.id, e.message_id, e.conversation_id, e.role, e.content, e.embedding, e.created_at, m.is_voice
        FROM message_embeddings e
        LEFT JOIN messages m ON m.id = e.message_id
        WHERE e.conversation_id = ?
      `;
      params = [options.conversationId];
    } else {
      sql = `
        SELECT e.id, e.message_id, e.conversation_id, e.role, e.content, e.embedding, e.created_at, m.is_voice
        FROM message_embeddings e
        LEFT JOIN messages m ON m.id = e.message_id
      `;
      params = [];
    }

    const stmt = this.db.prepare(sql);
    const rows = params.length > 0
      ? stmt.all<MessageEmbeddingRow>(...params)
      : stmt.all<MessageEmbeddingRow>();
    stmt.finalize();

    const results: RetrievedMessage[] = [];

    for (const row of rows) {
      if (!row.embedding) continue;

      const storedEmbedding = deserializeVector(row.embedding);
      const similarity = cosineSimilarity(queryEmbedding, storedEmbedding);

      if (similarity >= options.minScore) {
        results.push({
          messageId: row.message_id,
          conversationId: row.conversation_id,
          role: row.role as RetrievedMessage["role"],
          content: row.content,
          score: similarity,
          createdAt: new Date(row.created_at),
          isVoice: !!row.is_voice,
        });
      }
    }

    // Sort by score descending and apply limit
    results.sort((a, b) => b.score - a.score);
    const limited = results.slice(0, options.limit);

    console.log(
      `[ChatRAG] Found ${limited.length} relevant messages${
        options.conversationId
          ? ` in conversation ${options.conversationId}`
          : " across all conversations"
      } [in-memory]`,
    );

    return limited;
  }

  /**
   * Index a message for future retrieval.
   *
   * @param messageId - The message ID
   * @param conversationId - The conversation ID
   * @param role - Message role
   * @param content - Message content
   * @returns The embedding ID if successful, null otherwise
   */
  async indexMessage(
    messageId: string,
    conversationId: string,
    role: "user" | "assistant" | "system" | "tool",
    content: string,
  ): Promise<string | null> {
    // Skip empty or very short content
    if (!content || content.trim().length < 10) {
      return null;
    }

    // Skip tool messages (usually not useful for semantic search)
    if (role === "tool") {
      return null;
    }

    // Skip if already indexed
    const existingStmt = this.db.prepare(
      "SELECT 1 FROM message_embeddings WHERE message_id = ?",
    );
    const existing = existingStmt.get(messageId);
    existingStmt.finalize();
    if (existing) {
      return null;
    }

    try {
      const embedder = getEmbedder();
      await embedder.initialize();
      const embedding = await embedder.embed(content);
      const serialized = serializeVector(embedding);

      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      this.db.exec("BEGIN TRANSACTION");

      try {
        // Insert into message_embeddings (stores embedding for both modes)
        this.db.exec(
          `INSERT INTO message_embeddings (id, message_id, conversation_id, role, content, embedding, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, messageId, conversationId, role, content, serialized, now],
        );

        // If sqlite-vec is available, also insert into virtual table
        if (this.useVectorExt) {
          const rowidStmt = this.db.prepare(
            "SELECT rowid FROM message_embeddings WHERE id = ?",
          );
          const row = rowidStmt.get<{ rowid: number }>(id);
          rowidStmt.finalize();

          if (row) {
            this.db.exec(
              `INSERT INTO vec_messages(rowid, embedding) VALUES (?, ?)`,
              [row.rowid, serialized],
            );
          }
        }

        this.db.exec("COMMIT");
        return id;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      console.warn(
        `[ChatRAG] Failed to index message ${messageId}:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  /**
   * Remove a message's embedding.
   *
   * @param messageId - The message ID to remove
   */
  removeMessage(messageId: string): void {
    // If sqlite-vec is available, also delete from virtual table
    if (this.useVectorExt) {
      const stmt = this.db.prepare(
        "SELECT rowid FROM message_embeddings WHERE message_id = ?",
      );
      const rows = stmt.all<{ rowid: number }>(messageId);
      stmt.finalize();

      for (const row of rows) {
        this.db.exec("DELETE FROM vec_messages WHERE rowid = ?", [row.rowid]);
      }
    }

    // Always delete from main table
    this.db.exec("DELETE FROM message_embeddings WHERE message_id = ?", [
      messageId,
    ]);
  }

  /**
   * Remove all embeddings for a conversation.
   *
   * @param conversationId - The conversation ID
   */
  removeConversation(conversationId: string): void {
    // If sqlite-vec is available, also delete from virtual table
    if (this.useVectorExt) {
      const stmt = this.db.prepare(
        "SELECT rowid FROM message_embeddings WHERE conversation_id = ?",
      );
      const rows = stmt.all<{ rowid: number }>(conversationId);
      stmt.finalize();

      for (const row of rows) {
        this.db.exec("DELETE FROM vec_messages WHERE rowid = ?", [row.rowid]);
      }
    }

    // Always delete from main table
    this.db.exec("DELETE FROM message_embeddings WHERE conversation_id = ?", [
      conversationId,
    ]);
  }

  /**
   * Update the embedding for an edited message.
   *
   * @param messageId - The message ID
   * @param conversationId - The conversation ID
   * @param role - Message role
   * @param content - New message content
   * @returns true if successful, false otherwise
   */
  async updateMessageEmbedding(
    messageId: string,
    _conversationId: string,
    _role: "user" | "assistant" | "system" | "tool",
    content: string,
  ): Promise<boolean> {
    try {
      // Generate new embedding
      const embedder = getEmbedder();
      await embedder.initialize();
      const embedding = await embedder.embed(content);

      this.db.exec("BEGIN TRANSACTION");

      try {
        // Update the main embeddings table
        this.db.exec(
          `UPDATE message_embeddings SET embedding = ?, content = ? WHERE message_id = ?`,
          [serializeVector(embedding), content, messageId],
        );

        // If sqlite-vec is available, also update virtual table
        if (this.useVectorExt) {
          // First get the rowid
          const stmt = this.db.prepare(
            "SELECT rowid FROM message_embeddings WHERE message_id = ?",
          );
          const row = stmt.get<{ rowid: number }>(messageId);
          stmt.finalize();

          if (row) {
            // Delete old vector and insert new one
            this.db.exec("DELETE FROM vec_messages WHERE rowid = ?", [
              row.rowid,
            ]);
            this.db.exec(
              `INSERT INTO vec_messages (rowid, embedding) VALUES (?, ?)`,
              [row.rowid, serializeVector(embedding)],
            );
          }
        }

        this.db.exec("COMMIT");
        return true;
      } catch (error) {
        this.db.exec("ROLLBACK");
        console.error(
          `[ChatRAG] Failed to update message embedding for ${messageId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return false;
      }
    } catch (error) {
      console.error(
        `[ChatRAG] Failed to generate embedding for message ${messageId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /**
   * Get statistics about indexed messages.
   */
  getStats(): { messageCount: number; conversationCount: number } {
    const messageStmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM message_embeddings",
    );
    const messageRow = messageStmt.get<{ count: number }>();
    messageStmt.finalize();

    const convStmt = this.db.prepare(
      "SELECT COUNT(DISTINCT conversation_id) as count FROM message_embeddings",
    );
    const convRow = convStmt.get<{ count: number }>();
    convStmt.finalize();

    return {
      messageCount: messageRow?.count ?? 0,
      conversationCount: convRow?.count ?? 0,
    };
  }
}

/**
 * Singleton instance.
 */
let instance: ConversationRAG | null = null;

/**
 * Get the singleton ConversationRAG instance.
 *
 * @param db - The database instance (required on first call)
 */
export function getConversationRAG(db?: Database): ConversationRAG {
  if (!instance && db) {
    instance = new ConversationRAG(db);
  }
  if (!instance) {
    throw new Error(
      "ConversationRAG not initialized. Call getConversationRAG(db) first.",
    );
  }
  return instance;
}

/**
 * Format retrieved messages for context injection.
 *
 * @param messages - Retrieved messages
 * @param maxTokens - Maximum tokens to include
 * @returns Formatted string for context
 */
export function formatChatHistoryForContext(
  messages: RetrievedMessage[],
  maxTokens: number = 1000,
): string {
  if (messages.length === 0) {
    return "";
  }

  // Simple token estimation: ~4 chars per token
  const estimateTokens = (text: string) => Math.ceil(text.length / 4);

  const lines: string[] = ["Relevant Chat History via RAG:"];
  let totalTokens = estimateTokens(lines[0]);

  for (const msg of messages) {
    const timestamp = formatMessageTimestamp(msg.createdAt);
    // Strip any LLM-echoed <t>...</t> tags before adding the canonical one.
    // Also strip any stray [Voice Chat] prefix from content (defense-in-depth
    // — the authoritative source is msg.isVoice, derived below).
    const cleanContent = msg.content
      .replace(/<t>[^<]*<\/t>\s*/g, "")
      .replace(/\[Voice Chat\]\s*/g, "");
    const voicePrefix = msg.isVoice ? "[Voice Chat] " : "";
    const line =
      `[${msg.role}]: ${timestamp} ${voicePrefix}${cleanContent} [chat:${msg.conversationId}]`;
    const lineTokens = estimateTokens(line);

    if (totalTokens + lineTokens > maxTokens) {
      break;
    }

    lines.push(line);
    totalTokens += lineTokens;
  }

  return lines.join("\n");
}
