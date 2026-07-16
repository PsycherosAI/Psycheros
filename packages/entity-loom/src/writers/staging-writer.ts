/**
 * Entity Loom — Staging Writer
 *
 * Manages the staging.db SQLite database for browsing, searching, tagging,
 * and curating conversations before committing them to chats.db.
 */

import { Database } from "@db/sqlite";
import type {
  ImportedConversation,
  PlatformType,
  StagedConversationSummary,
  StagedMessage,
  StagingFilters,
  StagingStats,
  TagSet,
  TagSetSnapshot,
} from "../types.ts";
import { hashConversation, sha256Hex } from "../dedup/content-hash.ts";

/**
 * Build a staging-local primary key for a message.
 *
 * Source platforms (especially ChatGPT) can reuse the same `message_id`
 * across different conversations in the same export. If we used the raw ID
 * directly as `staged_messages.id`, the second conversation to land would
 * crash with `UNIQUE constraint failed: staged_messages.id` and the import
 * would silently stall. Scoping the ID as `${conversationId}:${rawId}`
 * keeps source IDs visible inside the scoped key while guaranteeing global
 * uniqueness across staged conversations.
 *
 * Idempotent: if the raw ID is already scoped to this conversation (e.g.
 * re-populate path), it's returned unchanged.
 */
function stagingMessageId(
  conversationId: string,
  rawId: string | undefined,
  index: number,
): string {
  const fallback = `message-${index}`;
  const raw = rawId || fallback;
  if (raw.startsWith(`${conversationId}:`)) return raw;
  return `${conversationId}:${raw}`;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS staged_conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    platform TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL,
    included INTEGER NOT NULL DEFAULT 1,
    imported_at TEXT NOT NULL,
    source_file TEXT
  );

  CREATE TABLE IF NOT EXISTS staged_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    reasoning_content TEXT,
    created_at TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (conversation_id) REFERENCES staged_conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS message_edits (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    original_content TEXT NOT NULL,
    edited_content TEXT NOT NULL,
    edited_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES staged_conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS conversation_tags (
    conversation_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (conversation_id, tag),
    FOREIGN KEY (conversation_id) REFERENCES staged_conversations(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tag_sets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    snapshot_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tag_definitions (
    name TEXT PRIMARY KEY,
    color TEXT NOT NULL DEFAULT '#6b7280'
  );

  CREATE TABLE IF NOT EXISTS psycheros_matches (
    conversation_id TEXT PRIMARY KEY,
    match_status TEXT NOT NULL CHECK (match_status IN ('new', 'existing', 'changed')),
    remote_hash TEXT,
    matched_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_staged_messages_conv
    ON staged_messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_staged_messages_sort
    ON staged_messages(conversation_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_staged_conversations_platform
    ON staged_conversations(platform);
  CREATE INDEX IF NOT EXISTS idx_staged_conversations_included
    ON staged_conversations(included);
  CREATE INDEX IF NOT EXISTS idx_conversation_tags_tag
    ON conversation_tags(tag);
  CREATE INDEX IF NOT EXISTS idx_conversation_tags_conv
    ON conversation_tags(conversation_id);

  CREATE VIRTUAL TABLE IF NOT EXISTS staged_messages_fts USING fts5(
    content,
    reasoning_content,
    conversation_id UNINDEXED,
    role UNINDEXED,
    content='staged_messages',
    content_rowid='rowid',
    tokenize='porter unicode61'
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS staged_conversations_fts USING fts5(
    title,
    id UNINDEXED,
    content='staged_conversations',
    content_rowid='rowid',
    tokenize='porter unicode61'
  );

  CREATE TRIGGER IF NOT EXISTS staged_messages_ai AFTER INSERT ON staged_messages BEGIN
    INSERT INTO staged_messages_fts(rowid, content, reasoning_content, conversation_id, role)
      VALUES (new.rowid, new.content, COALESCE(new.reasoning_content, ''), new.conversation_id, new.role);
  END;
  CREATE TRIGGER IF NOT EXISTS staged_messages_ad AFTER DELETE ON staged_messages BEGIN
    INSERT INTO staged_messages_fts(staged_messages_fts, rowid, content, reasoning_content, conversation_id, role)
      VALUES ('delete', old.rowid, old.content, COALESCE(old.reasoning_content, ''), old.conversation_id, old.role);
  END;
  CREATE TRIGGER IF NOT EXISTS staged_messages_au AFTER UPDATE ON staged_messages BEGIN
    INSERT INTO staged_messages_fts(staged_messages_fts, rowid, content, reasoning_content, conversation_id, role)
      VALUES ('delete', old.rowid, old.content, COALESCE(old.reasoning_content, ''), old.conversation_id, old.role);
    INSERT INTO staged_messages_fts(rowid, content, reasoning_content, conversation_id, role)
      VALUES (new.rowid, new.content, COALESCE(new.reasoning_content, ''), new.conversation_id, new.role);
  END;

  CREATE TRIGGER IF NOT EXISTS staged_conv_ai AFTER INSERT ON staged_conversations BEGIN
    INSERT INTO staged_conversations_fts(rowid, title, id)
      VALUES (new.rowid, COALESCE(new.title, ''), new.id);
  END;
  CREATE TRIGGER IF NOT EXISTS staged_conv_ad AFTER DELETE ON staged_conversations BEGIN
    INSERT INTO staged_conversations_fts(staged_conversations_fts, rowid, title, id)
      VALUES ('delete', old.rowid, COALESCE(old.title, ''), old.id);
  END;
  CREATE TRIGGER IF NOT EXISTS staged_conv_au AFTER UPDATE ON staged_conversations BEGIN
    INSERT INTO staged_conversations_fts(staged_conversations_fts, rowid, title, id)
      VALUES ('delete', old.rowid, COALESCE(old.title, ''), old.id);
    INSERT INTO staged_conversations_fts(rowid, title, id)
      VALUES (new.rowid, COALESCE(new.title, ''), new.id);
  END;
`;

export class StagingWriter {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
  }

  init(): void {
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  // ─── Conversation Population ────────────────────────────────────────

  /**
   * Write a conversation and its messages into staging.
   * Skips if the conversation ID already exists with the same content hash.
   * Returns the number of messages written, or 0 if skipped.
   */
  async writeConversation(
    conv: ImportedConversation,
    sourceFile?: string,
  ): Promise<number> {
    const hash = await hashConversation(conv);
    const existing = this.db.prepare(
      "SELECT content_hash FROM staged_conversations WHERE id = ?",
    ).get(conv.id) as { content_hash: string } | undefined;

    if (existing && existing.content_hash === hash) return 0;

    const importedAt = new Date().toISOString();

    // originPlatform takes precedence for the same reason as db-writer:
    // Loom Standard imports carry the real source platform name, which
    // makes the staging platform filter show "ChatGPT", "Replika", etc.
    // instead of the transport format name.
    const platformValue = conv.originPlatform ?? conv.platform;

    this.db.prepare(
      `INSERT OR REPLACE INTO staged_conversations
        (id, title, platform, created_at, updated_at, message_count, content_hash, included, imported_at, source_file)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      conv.id,
      conv.title || null,
      platformValue,
      conv.createdAt.toISOString(),
      conv.updatedAt.toISOString(),
      conv.messages.length,
      hash,
      importedAt,
      sourceFile || null,
    );

    // Delete existing messages (in case of re-import with new content)
    this.db.prepare("DELETE FROM staged_messages WHERE conversation_id = ?")
      .run(conv.id);

    const insertMsg = this.db.prepare(
      `INSERT INTO staged_messages (id, conversation_id, role, content, reasoning_content, created_at, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    let count = 0;
    for (let i = 0; i < conv.messages.length; i++) {
      const msg = conv.messages[i];
      if (msg.role === "system" || msg.role === "tool") continue;
      const stagedId = stagingMessageId(conv.id, msg.id, i);
      insertMsg.run(
        stagedId,
        conv.id,
        msg.role,
        msg.content,
        msg.reasoning || null,
        msg.createdAt.toISOString(),
        i,
      );
      count++;
    }

    return count;
  }

  // ─── Conversation Listing ───────────────────────────────────────────

  listConversations(filters: StagingFilters = {}): {
    conversations: StagedConversationSummary[];
    total: number;
  } {
    const {
      tag,
      platform,
      included,
      psycherosStatus,
      offset = 0,
      limit = 50,
      sortBy = "importedAt",
      sortOrder = "desc",
    } = filters;

    const conditions: string[] = [];
    const params: string[] = [];

    if (tag) {
      conditions.push(
        "c.id IN (SELECT conversation_id FROM conversation_tags WHERE tag = ?)",
      );
      params.push(tag);
    }
    if (platform) {
      conditions.push("c.platform = ?");
      params.push(platform);
    }
    if (included !== undefined) {
      conditions.push("c.included = ?");
      params.push(included ? "1" : "0");
    }
    if (psycherosStatus) {
      conditions.push(
        "c.id IN (SELECT conversation_id FROM psycheros_matches WHERE match_status = ?)",
      );
      params.push(psycherosStatus);
    }

    const where = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const colMap: Record<string, string> = {
      date: "c.created_at",
      title: "c.title",
      messageCount: "c.message_count",
      importedAt: "c.imported_at",
    };
    const orderCol = colMap[sortBy] || "c.imported_at";
    const orderDir = sortOrder === "asc" ? "ASC" : "DESC";

    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM staged_conversations c ${where}`,
    )
      .get(...(params as [])) as { cnt: number };
    const total = countRow.cnt;

    const rows = this.db.prepare(
      `SELECT c.*, pm.match_status as psycheros_status
       FROM staged_conversations c
       LEFT JOIN psycheros_matches pm ON c.id = pm.conversation_id
       ${where}
       ORDER BY ${orderCol} ${orderDir}
       LIMIT ? OFFSET ?`,
    ).all(...(params as []), String(limit), String(offset)) as Array<
      Record<string, unknown>
    >;

    const conversations = rows.map((row) => this.rowToConversationSummary(row));
    return { conversations, total };
  }

  getConversation(id: string): StagedConversationSummary | null {
    const row = this.db.prepare(
      `SELECT c.*, pm.match_status as psycheros_status
       FROM staged_conversations c
       LEFT JOIN psycheros_matches pm ON c.id = pm.conversation_id
       WHERE c.id = ?`,
    ).get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToConversationSummary(row) : null;
  }

  // ─── Messages ───────────────────────────────────────────────────────

  getMessages(conversationId: string, offset = 0, limit = 100): {
    messages: StagedMessage[];
    total: number;
  } {
    const countRow = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM staged_messages WHERE conversation_id = ?",
    ).get(conversationId) as { cnt: number };

    const rows = this.db.prepare(
      `SELECT sm.*, me.edited_content, me.original_content
       FROM staged_messages sm
       LEFT JOIN message_edits me ON sm.id = me.message_id
       WHERE sm.conversation_id = ?
       ORDER BY sm.sort_order ASC
       LIMIT ? OFFSET ?`,
    ).all(conversationId, String(limit), String(offset)) as Array<
      Record<string, unknown>
    >;

    const messages = rows.map((row) => ({
      id: row.id as string,
      conversationId: row.conversation_id as string,
      role: row.role as string,
      content: (row.edited_content || row.content) as string,
      reasoningContent: (row.reasoning_content as string) || null,
      createdAt: row.created_at as string,
      sortOrder: row.sort_order as number,
      isEdited: row.edited_content !== null && row.edited_content !== undefined,
      originalContent: (row.original_content as string) || undefined,
    }));

    return { messages, total: countRow.cnt };
  }

  // ─── Inclusion ──────────────────────────────────────────────────────

  setIncluded(id: string, included: boolean): void {
    this.db.prepare("UPDATE staged_conversations SET included = ? WHERE id = ?")
      .run(included ? "1" : "0", id);
  }

  setIncludedBulk(ids: string[], included: boolean): void {
    const stmt = this.db.prepare(
      "UPDATE staged_conversations SET included = ? WHERE id = ?",
    );
    this.db.exec("BEGIN");
    for (const id of ids) {
      stmt.run(included ? "1" : "0", id);
    }
    this.db.exec("COMMIT");
  }

  setAllIncluded(included: boolean): void {
    this.db.prepare("UPDATE staged_conversations SET included = ?")
      .run(included ? "1" : "0");
  }

  /** Get all included conversation IDs with their messages, for committing. */
  getIncludedConversations(): Array<{
    id: string;
    title: string | null;
    platform: string;
    createdAt: string;
    updatedAt: string;
  }> {
    const rows = this.db.prepare(
      "SELECT id, title, platform, created_at, updated_at FROM staged_conversations WHERE included = 1",
    ).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as string,
      title: (r.title as string) || null,
      platform: r.platform as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    }));
  }

  // ─── Tags ───────────────────────────────────────────────────────────

  addTag(conversationId: string, tag: string): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO conversation_tags (conversation_id, tag) VALUES (?, ?)",
    ).run(conversationId, tag);
  }

  removeTag(conversationId: string, tag: string): void {
    this.db.prepare(
      "DELETE FROM conversation_tags WHERE conversation_id = ? AND tag = ?",
    ).run(conversationId, tag);
  }

  setTags(conversationId: string, tags: string[]): void {
    this.db.prepare("DELETE FROM conversation_tags WHERE conversation_id = ?")
      .run(conversationId);
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO conversation_tags (conversation_id, tag) VALUES (?, ?)",
    );
    for (const tag of tags) {
      stmt.run(conversationId, tag);
    }
  }

  getTags(conversationId: string): string[] {
    const rows = this.db.prepare(
      "SELECT tag FROM conversation_tags WHERE conversation_id = ? ORDER BY tag",
    ).all(conversationId) as Array<{ tag: string }>;
    return rows.map((r) => r.tag);
  }

  getAllTags(): string[] {
    const rows = this.db.prepare(
      "SELECT DISTINCT tag FROM conversation_tags ORDER BY tag",
    ).all() as Array<{ tag: string }>;
    return rows.map((r) => r.tag);
  }

  // ─── Tag Definitions (palette) ──────────────────────────────────────

  getTagDefinitions(): Array<{ name: string; color: string }> {
    return this.db.prepare(
      "SELECT name, color FROM tag_definitions ORDER BY name",
    ).all() as Array<{
      name: string;
      color: string;
    }>;
  }

  createTagDefinition(name: string, color: string): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO tag_definitions (name, color) VALUES (?, ?)",
    ).run(name, color);
  }

  deleteTagDefinition(name: string): void {
    this.db.prepare("DELETE FROM tag_definitions WHERE name = ?").run(name);
  }

  renameTagDefinition(oldName: string, newName: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE tag_definitions SET name = ? WHERE name = ?").run(
        newName,
        oldName,
      );
      this.db.prepare("UPDATE conversation_tags SET tag = ? WHERE tag = ?").run(
        newName,
        oldName,
      );
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ─── Message Editing ────────────────────────────────────────────────

  editMessage(
    messageId: string,
    conversationId: string,
    newContent: string,
  ): void {
    const existing = this.db.prepare(
      "SELECT content FROM staged_messages WHERE id = ?",
    ).get(messageId) as { content: string } | undefined;
    if (!existing) throw new Error(`Message not found: ${messageId}`);

    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT OR REPLACE INTO message_edits (message_id, conversation_id, original_content, edited_content, edited_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(messageId, conversationId, existing.content, newContent, now);
  }

  revertMessageEdit(messageId: string): void {
    this.db.prepare("DELETE FROM message_edits WHERE message_id = ?").run(
      messageId,
    );
  }

  /** Get the edited content for a message, or null if not edited. */
  getMessageEdit(
    messageId: string,
  ): { originalContent: string; editedContent: string } | null {
    const row = this.db.prepare(
      "SELECT original_content, edited_content FROM message_edits WHERE message_id = ?",
    ).get(messageId);
    if (!row) return null;
    const r = row as { original_content: string; edited_content: string };
    return {
      originalContent: r.original_content,
      editedContent: r.edited_content,
    };
  }

  // ─── Search ─────────────────────────────────────────────────────────

  search(query: string, opts?: {
    scope?: "all" | "titles" | "messages";
    offset?: number;
    limit?: number;
  }): Array<StagedConversationSummary & { matchCount: number }> {
    const scope = opts?.scope || "all";
    const limit = opts?.limit || 50;
    const offset = opts?.offset || 0;

    // Collect matching conversation IDs with counts
    const matchCounts = new Map<string, number>();

    if (scope === "all" || scope === "titles") {
      const rows = this.db.prepare(
        `SELECT fts.id
         FROM staged_conversations_fts fts
         WHERE staged_conversations_fts MATCH ?`,
      ).all(query) as Array<{ id: string }>;
      for (const row of rows) {
        matchCounts.set(row.id, (matchCounts.get(row.id) || 0) + 1);
      }
    }

    if (scope === "all" || scope === "messages") {
      const rows = this.db.prepare(
        `SELECT fts.conversation_id
         FROM staged_messages_fts fts
         WHERE staged_messages_fts MATCH ?`,
      ).all(query) as Array<{ conversation_id: string }>;
      for (const row of rows) {
        matchCounts.set(
          row.conversation_id,
          (matchCounts.get(row.conversation_id) || 0) + 1,
        );
      }
    }

    if (matchCounts.size === 0) return [];

    // Sort by match count descending
    const sortedIds = [...matchCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(offset, offset + limit)
      .map(([id]) => id);

    // Fetch full conversation summaries
    const placeholders = sortedIds.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT c.*, pm.match_status as psycheros_status
       FROM staged_conversations c
       LEFT JOIN psycheros_matches pm ON c.id = pm.conversation_id
       WHERE c.id IN (${placeholders})
       ORDER BY c.imported_at DESC`,
    ).all(...sortedIds) as Array<Record<string, unknown>>;

    // Restore match-count order and attach counts
    const byId = new Map(
      rows.map((r) => [r.id as string, this.rowToConversationSummary(r)]),
    );

    return sortedIds.map((id) => {
      const conv = byId.get(id);
      return conv ? { ...conv, matchCount: matchCounts.get(id)! } : null;
    }).filter(Boolean) as Array<
      StagedConversationSummary & { matchCount: number }
    >;
  }

  searchTotal(
    query: string,
    opts?: { scope?: "all" | "titles" | "messages" },
  ): number {
    const scope = opts?.scope || "all";
    const ids = new Set<string>();

    if (scope === "all" || scope === "titles") {
      const rows = this.db.prepare(
        `SELECT id FROM staged_conversations_fts WHERE staged_conversations_fts MATCH ?`,
      ).all(query) as Array<{ id: string }>;
      for (const r of rows) ids.add(r.id);
    }

    if (scope === "all" || scope === "messages") {
      const rows = this.db.prepare(
        `SELECT conversation_id FROM staged_messages_fts WHERE staged_messages_fts MATCH ?`,
      ).all(query) as Array<{ conversation_id: string }>;
      for (const r of rows) ids.add(r.conversation_id);
    }

    return ids.size;
  }

  // ─── Tag Sets ───────────────────────────────────────────────────────

  async saveTagSet(name: string, description?: string): Promise<string> {
    const id = await sha256Hex(`tagset:${name}:${Date.now()}`);
    const snapshot = this.buildSnapshot();

    this.db.prepare(
      `INSERT OR REPLACE INTO tag_sets (id, name, description, created_at, updated_at, snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      description || null,
      new Date().toISOString(),
      new Date().toISOString(),
      JSON.stringify(snapshot),
    );

    return id;
  }

  loadTagSet(id: string): TagSet | null {
    const row = this.db.prepare(
      "SELECT * FROM tag_sets WHERE id = ?",
    ).get(id) as {
      id: string;
      name: string;
      description: string;
      created_at: string;
      updated_at: string;
      snapshot_json: string;
    } | undefined;

    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      description: row.description || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      snapshot: JSON.parse(row.snapshot_json) as TagSetSnapshot,
    };
  }

  listTagSets(): TagSet[] {
    const rows = this.db.prepare(
      "SELECT * FROM tag_sets ORDER BY updated_at DESC",
    ).all() as Array<
      {
        id: string;
        name: string;
        description: string;
        created_at: string;
        updated_at: string;
        snapshot_json: string;
      }
    >;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      snapshot: JSON.parse(row.snapshot_json) as TagSetSnapshot,
    }));
  }

  deleteTagSet(id: string): void {
    this.db.prepare("DELETE FROM tag_sets WHERE id = ?").run(id);
  }

  /** Apply a tag set snapshot to current staging data. Returns count of conversations updated. */
  applyTagSet(id: string): number {
    const tagSet = this.loadTagSet(id);
    if (!tagSet) throw new Error(`Tag set not found: ${id}`);

    const { conversationTags, conversationInclusion } = tagSet.snapshot;
    let updated = 0;

    this.db.exec("BEGIN");

    try {
      // Apply inclusion state
      const inclStmt = this.db.prepare(
        "UPDATE staged_conversations SET included = ? WHERE id = ? AND included != ?",
      );
      for (const [convId, incl] of Object.entries(conversationInclusion)) {
        const val = incl ? "1" : "0";
        const result = inclStmt.run(val, convId, val);
        if ((result as unknown as { changes: number }).changes > 0) updated++;
      }

      // Clear existing tags for conversations in the snapshot
      const convIds = Object.keys(conversationTags);
      if (convIds.length > 0) {
        const placeholders = convIds.map(() => "?").join(",");
        this.db.prepare(
          `DELETE FROM conversation_tags WHERE conversation_id IN (${placeholders})`,
        ).run(...convIds);
      }

      // Apply tags
      const tagStmt = this.db.prepare(
        "INSERT OR IGNORE INTO conversation_tags (conversation_id, tag) VALUES (?, ?)",
      );
      for (const [convId, tags] of Object.entries(conversationTags)) {
        for (const tag of tags) {
          tagStmt.run(convId, tag);
        }
      }

      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }

    return updated;
  }

  // ─── Psycheros Comparison ───────────────────────────────────────────

  setPsycherosMatches(
    matches: Array<{
      conversationId: string;
      matchStatus: "new" | "existing" | "changed";
      remoteHash?: string;
    }>,
  ): void {
    this.db.exec("BEGIN");
    try {
      // Clear old matches
      this.db.prepare("DELETE FROM psycheros_matches").run();

      const stmt = this.db.prepare(
        `INSERT OR REPLACE INTO psycheros_matches (conversation_id, match_status, remote_hash, matched_at)
         VALUES (?, ?, ?, ?)`,
      );
      const now = new Date().toISOString();
      for (const m of matches) {
        stmt.run(m.conversationId, m.matchStatus, m.remoteHash || null, now);
      }

      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getPsycherosMatches(): Array<{
    conversationId: string;
    matchStatus: string;
    remoteHash: string | null;
  }> {
    return (this.db.prepare(
      "SELECT conversation_id, match_status, remote_hash FROM psycheros_matches",
    ).all() as Array<
      {
        conversation_id: string;
        match_status: string;
        remote_hash: string | null;
      }
    >).map((r) => ({
      conversationId: r.conversation_id,
      matchStatus: r.match_status,
      remoteHash: r.remote_hash,
    }));
  }

  // ─── Stats ──────────────────────────────────────────────────────────

  getStats(): StagingStats {
    const totalRow = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM staged_conversations",
    ).get() as { cnt: number };
    const includedRow = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM staged_conversations WHERE included = 1",
    ).get() as { cnt: number };

    const byPlatformRows = this.db.prepare(
      "SELECT platform, COUNT(*) as cnt FROM staged_conversations GROUP BY platform",
    ).all() as Array<{ platform: string; cnt: number }>;

    const byTagRows = this.db.prepare(
      "SELECT tag, COUNT(*) as cnt FROM conversation_tags GROUP BY tag",
    ).all() as Array<{ tag: string; cnt: number }>;

    const psycherosRows = this.db.prepare(
      "SELECT match_status, COUNT(*) as cnt FROM psycheros_matches GROUP BY match_status",
    ).all() as Array<{ match_status: string; cnt: number }>;

    const byPlatform: Record<string, number> = {};
    for (const r of byPlatformRows) byPlatform[r.platform] = r.cnt;

    const byTag: Record<string, number> = {};
    for (const r of byTagRows) byTag[r.tag] = r.cnt;

    const psycherosStatus = { new: 0, existing: 0, changed: 0 };
    for (const r of psycherosRows) {
      if (r.match_status in psycherosStatus) {
        (psycherosStatus as Record<string, number>)[r.match_status] = r.cnt;
      }
    }

    return {
      total: totalRow.cnt,
      included: includedRow.cnt,
      excluded: totalRow.cnt - includedRow.cnt,
      byPlatform,
      byTag,
      psycherosStatus,
    };
  }

  // ─── Utility ────────────────────────────────────────────────────────

  getExistingStagedIds(): Set<string> {
    const rows = this.db.prepare("SELECT id FROM staged_conversations")
      .all() as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  }

  clear(): void {
    this.db.exec(`
      DELETE FROM staged_messages;
      DELETE FROM message_edits;
      DELETE FROM conversation_tags;
      DELETE FROM psycheros_matches;
      DELETE FROM staged_conversations;
    `);
  }

  // ─── Private Helpers ────────────────────────────────────────────────

  private rowToConversationSummary(
    row: Record<string, unknown>,
  ): StagedConversationSummary {
    return {
      id: row.id as string,
      title: (row.title as string) || null,
      platform: row.platform as PlatformType,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      messageCount: row.message_count as number,
      contentHash: row.content_hash as string,
      included: row.included === 1 || row.included === "1",
      importedAt: row.imported_at as string,
      sourceFile: (row.source_file as string) || null,
      tags: this.getTags(row.id as string),
      psycherosStatus:
        (row.psycheros_status as "new" | "existing" | "changed") || undefined,
    };
  }

  private buildSnapshot(): TagSetSnapshot {
    const convs = this.db.prepare(
      "SELECT id, included FROM staged_conversations",
    ).all() as Array<{ id: string; included: number }>;

    const conversationInclusion: Record<string, boolean> = {};
    const conversationTags: Record<string, string[]> = {};

    for (const conv of convs) {
      conversationInclusion[conv.id] = conv.included === 1;
      conversationTags[conv.id] = this.getTags(conv.id);
    }

    return { conversationTags, conversationInclusion };
  }
}
