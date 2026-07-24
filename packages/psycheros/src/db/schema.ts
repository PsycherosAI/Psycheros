/**
 * Psycheros Database Schema
 *
 * Defines the SQLite database schema and initialization function
 * for persisting conversations and messages.
 */

import type { Database } from "@db/sqlite";
import { getVecVersion, loadVectorExtension } from "./vector.ts";
import { initSchedulerTables } from "../scheduler/mod.ts";

/**
 * SQL schema for the Psycheros database.
 * Creates tables for conversations and messages with proper indexes.
 */
export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
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

  CREATE TABLE IF NOT EXISTS turn_metrics (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    message_id TEXT,
    request_started_at TEXT NOT NULL,
    ttfb INTEGER,
    ttfc INTEGER,
    max_chunk_gap INTEGER,
    slow_chunk_count INTEGER NOT NULL DEFAULT 0,
    total_duration INTEGER,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    finish_reason TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_turn_metrics_conversation
    ON turn_metrics(conversation_id, created_at DESC);

  -- RAG Memory Tables
  -- Track indexed memory files for change detection
  CREATE TABLE IF NOT EXISTS indexed_memories (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    chunk_count INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );

  -- Store memory chunks with their embeddings
  -- Note: embedding BLOB is kept for backward compatibility but vec_memory_chunks is used for search
  CREATE TABLE IF NOT EXISTS memory_chunks (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    source_file TEXT NOT NULL,
    token_count INTEGER NOT NULL,
    metadata TEXT,
    embedding BLOB,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memory_chunks_source
    ON memory_chunks(source_file);

  -- Message Embeddings Table
  -- Stores embeddings for chat messages for conversational RAG
  CREATE TABLE IF NOT EXISTS message_embeddings (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    embedding BLOB,
    created_at TEXT NOT NULL,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_message_embeddings_message
    ON message_embeddings(message_id);

  CREATE INDEX IF NOT EXISTS idx_message_embeddings_conversation
    ON message_embeddings(conversation_id);

  -- Memory Summarization Tables
  -- Track memory summarization state
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

  CREATE INDEX IF NOT EXISTS idx_memory_summaries_granularity
    ON memory_summaries(granularity);

  -- Track which chats have been summarized (to avoid re-summarizing)
  CREATE TABLE IF NOT EXISTS summarized_chats (
    chat_id TEXT NOT NULL,
    message_date TEXT NOT NULL,
    summary_id TEXT NOT NULL,
    summarized_at TEXT NOT NULL,
    PRIMARY KEY (chat_id, message_date),
    FOREIGN KEY (summary_id) REFERENCES memory_summaries(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_summarized_chats_chat
    ON summarized_chats(chat_id);

  CREATE INDEX IF NOT EXISTS idx_summarized_chats_date
    ON summarized_chats(message_date);

  -- Lorebook Tables
  -- Lorebooks are collections of world info entries
  CREATE TABLE IF NOT EXISTS lorebooks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    enabled INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_lorebooks_enabled
    ON lorebooks(enabled);

  -- Lorebook entries contain the actual trigger/content pairs
  CREATE TABLE IF NOT EXISTS lorebook_entries (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    triggers TEXT NOT NULL,
    trigger_mode TEXT DEFAULT 'substring',
    case_sensitive INTEGER DEFAULT 0,
    sticky INTEGER DEFAULT 0,
    sticky_duration INTEGER DEFAULT 0,
    non_recursable INTEGER DEFAULT 0,
    prevent_recursion INTEGER DEFAULT 0,
    re_trigger_resets_timer INTEGER DEFAULT 1,
    enabled INTEGER DEFAULT 1,
    priority INTEGER DEFAULT 0,
    scan_depth INTEGER DEFAULT 5,
    max_tokens INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (book_id) REFERENCES lorebooks(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_lorebook_entries_book
    ON lorebook_entries(book_id);

  CREATE INDEX IF NOT EXISTS idx_lorebook_entries_enabled
    ON lorebook_entries(enabled);

  -- Lorebook state tracks sticky entries per conversation
  CREATE TABLE IF NOT EXISTS lorebook_state (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    turns_remaining INTEGER NOT NULL,
    triggered_at_message INTEGER NOT NULL,
    triggered_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (entry_id) REFERENCES lorebook_entries(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_lorebook_state_conversation
    ON lorebook_state(conversation_id);

  CREATE UNIQUE INDEX IF NOT EXISTS idx_lorebook_state_conversation_entry
    ON lorebook_state(conversation_id, entry_id);

  -- Context Inspector Snapshots
  -- Persists the full LLM context for each conversation turn
  CREATE TABLE IF NOT EXISTS context_snapshots (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    iteration INTEGER NOT NULL DEFAULT 1,
    timestamp TEXT NOT NULL,
    user_message TEXT NOT NULL,
    system_message TEXT NOT NULL,
    base_instructions_content TEXT,
    self_content TEXT,
    user_content TEXT,
    relationship_content TEXT,
    custom_content TEXT,
    memories_content TEXT,
    chat_history_content TEXT,
    lorebook_content TEXT,
    graph_content TEXT,
    messages_json TEXT NOT NULL,
    tool_definitions_json TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    plugin_hooks_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_context_snapshots_conversation
    ON context_snapshots(conversation_id, turn_index DESC);
`;

/**
 * Embedding dimension I fall back to when no explicit dimension has been
 * recorded in `app_metadata`. Matches the historical all-MiniLM-L6-v2 value
 * so existing installs keep working without re-embedding on upgrade.
 */
export const DEFAULT_EMBEDDING_DIMENSION = 384;

const EMBEDDING_DIMENSION_META_KEY = "active_embedding_dimension";

/**
 * Read the dimension the vec0 tables were created with (or will be created
 * with on next init). Falls back to DEFAULT_EMBEDDING_DIMENSION when no row
 * exists yet — e.g. on the very first init before `ensureAppMetadata` runs.
 */
export function getActiveEmbeddingDimension(db: Database): number {
  try {
    const stmt = db.prepare(
      "SELECT value FROM app_metadata WHERE key = ?",
    );
    const row = stmt.get<{ value: string }>(EMBEDDING_DIMENSION_META_KEY);
    stmt.finalize();
    if (!row) return DEFAULT_EMBEDDING_DIMENSION;
    const dim = parseInt(row.value, 10);
    return Number.isFinite(dim) && dim > 0 ? dim : DEFAULT_EMBEDDING_DIMENSION;
  } catch {
    // app_metadata doesn't exist yet (pre-ensureAppMetadata call)
    return DEFAULT_EMBEDDING_DIMENSION;
  }
}

/**
 * Record the active embedding dimension. Called by the re-embed orchestrator
 * after dropping + recreating vec0 tables with a new model's dimension.
 */
export function setActiveEmbeddingDimension(db: Database, dim: number): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO app_metadata (key, value) VALUES (?, ?)`,
  );
  stmt.run(EMBEDDING_DIMENSION_META_KEY, String(dim));
  stmt.finalize();
}

/**
 * Ensure the app_metadata table exists and the dimension row is populated.
 * Called from `initializeSchema` before any vec0 DDL so the getter returns a
 * stable value during init.
 */
function ensureAppMetadata(db: Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
  );
  if (getActiveEmbeddingDimension(db) === DEFAULT_EMBEDDING_DIMENSION) {
    // Only seed if no row exists — preserves orchestrator-set values across
    // restarts.
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO app_metadata (key, value) VALUES (?, ?)`,
    );
    stmt.run(
      EMBEDDING_DIMENSION_META_KEY,
      String(DEFAULT_EMBEDDING_DIMENSION),
    );
    stmt.finalize();
  }
}

/**
 * Initializes the database schema by executing the schema SQL.
 * This is idempotent - safe to call multiple times.
 *
 * @param db - The SQLite database instance
 */
export function initializeSchema(db: Database): void {
  db.exec(SCHEMA);
  ensureAppMetadata(db);
  runMigrations(db);
  initializeVectorTables(db);
}

/**
 * Run schema migrations for backward compatibility.
 * Each migration checks if it's needed before applying.
 */
function runMigrations(db: Database): void {
  // Migration: Add message_id column to turn_metrics if missing
  const hasMessageId = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('turn_metrics') WHERE name = 'message_id'",
    )
    .get();

  if (!hasMessageId) {
    db.exec(
      "ALTER TABLE turn_metrics ADD COLUMN message_id TEXT REFERENCES messages(id) ON DELETE CASCADE",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_turn_metrics_message ON turn_metrics(message_id)",
    );
  }

  // Migration: Add RAG tables if missing
  const hasRagTables = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'indexed_memories'",
    )
    .get();

  if (!hasRagTables) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS indexed_memories (
        path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        chunk_count INTEGER NOT NULL,
        indexed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_chunks (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source_file TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        metadata TEXT,
        embedding BLOB,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_chunks_source
        ON memory_chunks(source_file);
    `);
  }

  // Migration: Add memory summarization tables if missing
  const hasMemorySummaryTables = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_summaries'",
    )
    .get();

  if (!hasMemorySummaryTables) {
    db.exec(`
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

      CREATE INDEX IF NOT EXISTS idx_memory_summaries_granularity
        ON memory_summaries(granularity);

      CREATE TABLE IF NOT EXISTS summarized_chats (
        chat_id TEXT NOT NULL,
        message_date TEXT NOT NULL,
        summary_id TEXT NOT NULL,
        summarized_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, message_date),
        FOREIGN KEY (summary_id) REFERENCES memory_summaries(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_summarized_chats_chat
        ON summarized_chats(chat_id);

      CREATE INDEX IF NOT EXISTS idx_summarized_chats_date
        ON summarized_chats(message_date);
    `);
  }

  // Migration: Add message embeddings table if missing
  const hasMessageEmbeddings = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_embeddings'",
    )
    .get();

  if (!hasMessageEmbeddings) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS message_embeddings (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB,
        created_at TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_message_embeddings_message
        ON message_embeddings(message_id);

      CREATE INDEX IF NOT EXISTS idx_message_embeddings_conversation
        ON message_embeddings(conversation_id);
    `);
  }

  // Migration: Add edited_at column to messages if missing
  const hasEditedAt = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('messages') WHERE name = 'edited_at'",
    )
    .get();

  if (!hasEditedAt) {
    db.exec("ALTER TABLE messages ADD COLUMN edited_at TEXT");
    console.log("[DB] Added edited_at column to messages table");
  }

  // Migration: Add lorebook tables if missing
  const hasLorebookTables = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'lorebooks'",
    )
    .get();

  if (!hasLorebookTables) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lorebooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_lorebooks_enabled
        ON lorebooks(enabled);

      CREATE TABLE IF NOT EXISTS lorebook_entries (
        id TEXT PRIMARY KEY,
        book_id TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        triggers TEXT NOT NULL,
        trigger_mode TEXT DEFAULT 'substring',
        case_sensitive INTEGER DEFAULT 0,
        sticky INTEGER DEFAULT 0,
        sticky_duration INTEGER DEFAULT 0,
        non_recursable INTEGER DEFAULT 0,
        prevent_recursion INTEGER DEFAULT 0,
        re_trigger_resets_timer INTEGER DEFAULT 1,
        enabled INTEGER DEFAULT 1,
        priority INTEGER DEFAULT 0,
        scan_depth INTEGER DEFAULT 5,
        max_tokens INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (book_id) REFERENCES lorebooks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_lorebook_entries_book
        ON lorebook_entries(book_id);

      CREATE INDEX IF NOT EXISTS idx_lorebook_entries_enabled
        ON lorebook_entries(enabled);

      CREATE TABLE IF NOT EXISTS lorebook_state (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        turns_remaining INTEGER NOT NULL,
        triggered_at_message INTEGER NOT NULL,
        triggered_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (entry_id) REFERENCES lorebook_entries(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_lorebook_state_conversation
        ON lorebook_state(conversation_id);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_lorebook_state_conversation_entry
        ON lorebook_state(conversation_id, entry_id);
    `);
    console.log("[DB] Created lorebook tables");
  }

  // Migration: Add context_snapshots table if missing
  const hasContextSnapshots = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_snapshots'",
    )
    .get();

  if (!hasContextSnapshots) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS context_snapshots (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        iteration INTEGER NOT NULL DEFAULT 1,
        timestamp TEXT NOT NULL,
        user_message TEXT NOT NULL,
        system_message TEXT NOT NULL,
        base_instructions_content TEXT,
        self_content TEXT,
        user_content TEXT,
        relationship_content TEXT,
        custom_content TEXT,
        memories_content TEXT,
        chat_history_content TEXT,
        lorebook_content TEXT,
        graph_content TEXT,
        messages_json TEXT NOT NULL,
        tool_definitions_json TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_context_snapshots_conversation
        ON context_snapshots(conversation_id, turn_index DESC);
    `);
    console.log("[DB] Created context_snapshots table");
  }

  // Migration: Add base_instructions_content column to context_snapshots if missing
  const hasBaseInstructionsCol = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('context_snapshots') WHERE name = 'base_instructions_content'",
    )
    .get();

  if (!hasBaseInstructionsCol) {
    db.exec(
      `ALTER TABLE context_snapshots ADD COLUMN base_instructions_content TEXT`,
    );
    console.log(
      "[DB] Added base_instructions_content column to context_snapshots",
    );
  }

  // Migration: Add vault tables if missing
  const hasVaultTables = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vault_documents'",
    )
    .get();

  if (!hasVaultTables) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS vault_documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        filename TEXT NOT NULL,
        file_type TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global' CHECK(scope IN ('global','chat')),
        conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'upload' CHECK(source IN ('upload','entity')),
        enabled INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_vault_documents_scope
        ON vault_documents(scope);

      CREATE INDEX IF NOT EXISTS idx_vault_documents_conversation
        ON vault_documents(conversation_id);

      CREATE TABLE IF NOT EXISTS vault_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES vault_documents(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        metadata TEXT,
        embedding BLOB,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_vault_chunks_document
        ON vault_chunks(document_id);

      ALTER TABLE context_snapshots ADD COLUMN vault_content TEXT;
    `);
    console.log("[DB] Created vault tables");
  }

  // Migration: Add vault_content column to context_snapshots if missing
  const hasVaultContentCol = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('context_snapshots') WHERE name = 'vault_content'",
    )
    .get();

  if (!hasVaultContentCol) {
    db.exec("ALTER TABLE context_snapshots ADD COLUMN vault_content TEXT");
    console.log("[DB] Added vault_content column to context_snapshots");
  }

  // Migration: Add situational_awareness_content column to context_snapshots if missing
  const hasSACol = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('context_snapshots') WHERE name = 'situational_awareness_content'",
    )
    .get();
  if (!hasSACol) {
    db.exec(
      "ALTER TABLE context_snapshots ADD COLUMN situational_awareness_content TEXT",
    );
    console.log(
      "[DB] Added situational_awareness_content column to context_snapshots",
    );
  }

  // Migration: Add custom_content column to context_snapshots if missing
  const hasCustomContentCol = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('context_snapshots') WHERE name = 'custom_content'",
    )
    .get();

  if (!hasCustomContentCol) {
    db.exec("ALTER TABLE context_snapshots ADD COLUMN custom_content TEXT");
    console.log("[DB] Added custom_content column to context_snapshots");
  }

  // Migration: Add plugin_hooks_json column to context_snapshots if missing
  // Per-hook detail (id, name, priority, output, charsUsed, truncated, degraded,
  // budgetSkipped, elapsedMs) for the Context Inspector's Plugin Hooks tab.
  const hasPluginHooksCol = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('context_snapshots') WHERE name = 'plugin_hooks_json'",
    )
    .get();

  if (!hasPluginHooksCol) {
    db.exec(
      "ALTER TABLE context_snapshots ADD COLUMN plugin_hooks_json TEXT",
    );
    console.log(
      "[DB] Added plugin_hooks_json column to context_snapshots",
    );
  }

  // Migration: Add Pulse tables if missing
  const hasPulseTables = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pulses'",
    )
    .get();

  if (!hasPulseTables) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pulses (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        prompt_text TEXT NOT NULL,
        chat_mode TEXT NOT NULL DEFAULT 'visible' CHECK (chat_mode IN ('visible', 'silent')),
        conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        trigger_type TEXT NOT NULL DEFAULT 'cron' CHECK (trigger_type IN ('cron', 'inactivity', 'webhook', 'filesystem')),
        cron_expression TEXT,
        interval_seconds INTEGER,
        random_interval_min INTEGER,
        random_interval_max INTEGER,
        run_at TEXT,
        inactivity_threshold_seconds INTEGER,
        chain_pulse_ids TEXT,
        max_chain_depth INTEGER NOT NULL DEFAULT 3,
        source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'entity')),
        auto_delete INTEGER NOT NULL DEFAULT 0,
        webhook_token TEXT,
        filesystem_watch_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pulses_enabled
        ON pulses(enabled);

      CREATE INDEX IF NOT EXISTS idx_pulses_trigger_type
        ON pulses(trigger_type);

      CREATE INDEX IF NOT EXISTS idx_pulses_conversation
        ON pulses(conversation_id);
    `);
    console.log("[DB] Created pulse tables");
  }

  // Migration: Add source column to pulses if missing (for existing installs)
  const hasPulseSourceCol = db
    .prepare("SELECT 1 FROM pragma_table_info('pulses') WHERE name = 'source'")
    .get();

  if (!hasPulseSourceCol && hasPulseTables) {
    db.exec(
      "ALTER TABLE pulses ADD COLUMN source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'entity'))",
    );
    console.log("[DB] Added source column to pulses");
  }

  // Migration: Add auto_delete column to pulses if missing
  const hasPulseAutoDeleteCol = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('pulses') WHERE name = 'auto_delete'",
    )
    .get();

  if (!hasPulseAutoDeleteCol && hasPulseTables) {
    db.exec(
      "ALTER TABLE pulses ADD COLUMN auto_delete INTEGER NOT NULL DEFAULT 0",
    );
    console.log("[DB] Added auto_delete column to pulses");
  }

  // Migration: Add inactivity_threshold_seconds column to pulses if missing
  const hasInactivityCol = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('pulses') WHERE name = 'inactivity_threshold_seconds'",
    )
    .get();

  if (!hasInactivityCol && hasPulseTables) {
    db.exec(
      "ALTER TABLE pulses ADD COLUMN inactivity_threshold_seconds INTEGER",
    );
    console.log("[DB] Added inactivity_threshold_seconds column to pulses");
  }

  // Migration: Add pulse_id and pulse_name columns to messages if missing
  const hasPulseIdCol = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('messages') WHERE name = 'pulse_id'",
    )
    .get();

  if (!hasPulseIdCol) {
    db.exec(
      "ALTER TABLE messages ADD COLUMN pulse_id TEXT REFERENCES pulses(id) ON DELETE SET NULL",
    );
    db.exec("ALTER TABLE messages ADD COLUMN pulse_name TEXT");
    console.log("[DB] Added pulse_id and pulse_name columns to messages");
  }

  // is_voice migration: column is authoritative for voice attribution,
  // prefix is derived on read. Backfill scans legacy content for the
  // prefix, tags the message, strips prefix (substr 14 = len "[Voice Chat] ").
  const hasIsVoiceCol = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('messages') WHERE name = 'is_voice'",
    )
    .get();

  if (!hasIsVoiceCol) {
    db.exec("ALTER TABLE messages ADD COLUMN is_voice INTEGER DEFAULT 0");
    console.log("[DB] Added is_voice column to messages table");
    db.exec(
      "UPDATE messages SET is_voice = 1, content = substr(content, 14) " +
        "WHERE content LIKE '[Voice Chat] %'",
    );
    console.log("[DB] Backfilled is_voice from legacy prefix");
  }

  // metadata migration: nullable JSON column on messages. Tool-result rows
  // use it to carry sidecar data (e.g. generate_image's image metadata) so
  // the LLM-visible content stays plain text without `[IMAGE:...]` markers.
  // No backfill — legacy messages keep their markers in content and render
  // via the retained legacy parser in templates.ts.
  const hasMetadataCol = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('messages') WHERE name = 'metadata'",
    )
    .get();

  if (!hasMetadataCol) {
    db.exec("ALTER TABLE messages ADD COLUMN metadata TEXT");
    console.log("[DB] Added metadata column to messages table");
  }

  // Migration: Add push_subscriptions table if missing
  const hasPushSubscriptions = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'push_subscriptions'",
    )
    .get();

  if (!hasPushSubscriptions) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        keys_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    console.log("[DB] Created push_subscriptions table");
  }

  // Migration: Add anchor_images table if missing
  const hasAnchorImages = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'anchor_images'",
    )
    .get();

  if (!hasAnchorImages) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS anchor_images (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        filename TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    console.log("[DB] Created anchor_images table");
  }

  // Migration: Move vault document files from data/vault/ to .psycheros/vault/
  // Vault files were stored in the container writable layer (data/vault/documents/)
  // which is lost on container recreation. Move them to .psycheros/vault/documents/
  // which lives on the persisted .psycheros/ volume mount.
  try {
    const oldRows = db
      .prepare(
        "SELECT id, file_path FROM vault_documents WHERE file_path LIKE '%/data/vault/documents/%'",
      )
      .all<{ id: string; file_path: string }>();

    if (oldRows.length > 0) {
      let moved = 0;
      let missing = 0;

      for (const row of oldRows) {
        const newPath = row.file_path.replace(
          /\/data\/vault\/documents\//,
          "/.psycheros/vault/documents/",
        );

        try {
          // Ensure target directory exists
          const parentDir = newPath.substring(0, newPath.lastIndexOf("/"));
          Deno.mkdirSync(parentDir, { recursive: true });

          // Move file if it exists on disk
          try {
            Deno.copyFileSync(row.file_path, newPath);
            Deno.removeSync(row.file_path);
            moved++;
          } catch {
            // File doesn't exist on disk (already lost) — just update the path
            missing++;
          }

          // Update the DB record regardless
          db.exec("UPDATE vault_documents SET file_path = ? WHERE id = ?", [
            newPath,
            row.id,
          ]);
        } catch {
          // Skip this row if migration fails
        }
      }

      console.log(
        `[DB] Migrated ${moved} vault file(s) to .psycheros/vault/, ${missing} file(s) missing (path updated only)`,
      );
    }
  } catch {
    // vault_documents table doesn't exist yet — skip
  }

  // Migration: Add source tracking columns to conversations (for Discord gateway)
  const hasSourceType = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('conversations') WHERE name = 'source_type'",
    )
    .get();

  if (!hasSourceType) {
    db.exec(
      "ALTER TABLE conversations ADD COLUMN source_type TEXT DEFAULT 'web'",
    );
    db.exec("ALTER TABLE conversations ADD COLUMN source_server_id TEXT");
    db.exec("ALTER TABLE conversations ADD COLUMN source_server_name TEXT");
    db.exec("ALTER TABLE conversations ADD COLUMN source_channel_id TEXT");
    db.exec("ALTER TABLE conversations ADD COLUMN source_channel_name TEXT");
    console.log("[DB] Added source tracking columns to conversations");
  }

  // Migration: Add Discord DM whitelist table
  const hasDmWhitelist = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dm_whitelist'",
    )
    .get();

  if (!hasDmWhitelist) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dm_whitelist (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        added_at TEXT NOT NULL
      );
    `);
    // Migrate approved users from legacy DM queue
    const hasDmQueue = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'discord_dm_queue'",
      )
      .get();
    if (hasDmQueue) {
      const approved = db.prepare(
        "SELECT user_id, username FROM discord_dm_queue WHERE status = 'approved'",
      ).all() as Array<{ user_id: string; username: string }>;
      const insert = db.prepare(
        "INSERT OR IGNORE INTO dm_whitelist (user_id, username, notes, added_at) VALUES (?, ?, ?, datetime('now'))",
      );
      for (const entry of approved) {
        insert.run(entry.user_id, entry.username, "");
      }
      db.exec("DROP TABLE discord_dm_queue");
      console.log(
        `[DB] Migrated ${approved.length} user(s) to dm_whitelist, dropped discord_dm_queue`,
      );
    }
    console.log("[DB] Created dm_whitelist table");
  }

  // Scheduler tables (durable job queue + schedule definitions)
  // and the one-time migration from the legacy cron_job_runs + pulse_runs
  // tables into the unified job_runs table.
  initSchedulerTables(db);
  migrateLegacyJobRuns(db);
}

/**
 * One-time migration that folds two legacy tables into the unified
 * scheduler tables and strips four denormalized columns off `pulses`.
 *
 * - `cron_job_runs` rows become `job_runs` rows with the handler set to
 *   the new scheduler handler name (memory-daily → memory.summarize-daily,
 *   identity-snapshot → identity.snapshot).
 * - `pulse_runs` rows become `job_runs` rows with handler `pulse.execute`
 *   and the pulse-specific context (pulseId, triggerSource, chain info)
 *   carried in the JSON payload.
 * - The `pulses` table is rebuilt without `success_count`, `error_count`,
 *   `last_run_at`, and `last_status` — these are now derived from
 *   `job_runs` on demand. The rebuild preserves all other data.
 *
 * Once the legacy tables are migrated they are dropped — no shims, no
 * dual-write, no future cleanup pass needed.
 */
function migrateLegacyJobRuns(db: Database): void {
  const hasCronJobRuns = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cron_job_runs'",
    )
    .get();

  if (hasCronJobRuns) {
    const rows = db
      .prepare(
        `SELECT job_id, started_at, completed_at, duration_ms, status, result, error
         FROM cron_job_runs`,
      )
      .all<{
        job_id: string;
        started_at: string;
        completed_at: string;
        duration_ms: number;
        status: string;
        result: string | null;
        error: string | null;
      }>();

    const handlerForJobId: Record<string, string> = {
      "memory-daily": "memory.summarize-daily",
      "identity-snapshot": "identity.snapshot",
    };

    let migrated = 0;
    for (const row of rows) {
      const handler = handlerForJobId[row.job_id] ?? `legacy.${row.job_id}`;
      // schedule_id stays NULL on migrated rows — the live schedules
      // don't exist yet (they're created on startup by the daemon).
      // Setting them later would race with the daemon's defineSchedule
      // calls; leaving them NULL means run history shows up under the
      // handler column rather than linked to a schedule row. The admin
      // UI groups by handler anyway, so nothing is lost.
      db.exec(
        `INSERT INTO job_runs (
           id, schedule_id, handler, payload_json, status, attempt,
           max_attempts, scheduled_for, started_at, completed_at, duration_ms,
           result_summary, error_message, created_at
         ) VALUES (?, NULL, ?, '{}', ?, 1, 1, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          handler,
          row.status,
          row.started_at,
          row.started_at,
          row.completed_at,
          row.duration_ms,
          row.result,
          row.error,
          row.started_at,
        ],
      );
      migrated++;
    }
    db.exec("DROP TABLE cron_job_runs");
    console.log(
      `[DB] Migrated ${migrated} cron_job_runs row(s) into job_runs and dropped legacy table`,
    );
  }

  const hasPulseRuns = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pulse_runs'",
    )
    .get();

  if (hasPulseRuns) {
    const rows = db
      .prepare(
        `SELECT id, pulse_id, conversation_id, trigger_source, started_at,
                completed_at, duration_ms, status, result_summary, error_message,
                tool_calls_count, output_content, chain_depth, chain_parent_run_id,
                created_at
         FROM pulse_runs`,
      )
      .all<{
        id: string;
        pulse_id: string;
        conversation_id: string | null;
        trigger_source: string;
        started_at: string;
        completed_at: string | null;
        duration_ms: number | null;
        status: string;
        result_summary: string | null;
        error_message: string | null;
        tool_calls_count: number;
        output_content: string | null;
        chain_depth: number;
        chain_parent_run_id: string | null;
        created_at: string;
      }>();

    let migrated = 0;
    const now = new Date().toISOString();
    for (const row of rows) {
      // Pulses that were 'running' when the previous process died become
      // 'dead' with an explanatory message — they can't be safely retried
      // because the LLM may have streamed a partial message to the chat.
      const status = row.status === "running" ? "dead" : row.status;
      const errorMessage = row.status === "running"
        ? (row.error_message ??
          "Reclaimed during scheduler migration; previous process exited mid-run")
        : row.error_message;
      const completedAt = row.status === "running" ? now : row.completed_at;

      const payload = JSON.stringify({
        pulseId: row.pulse_id,
        triggerSource: row.trigger_source,
        chainDepth: row.chain_depth,
        chainParentRunId: row.chain_parent_run_id,
        conversationId: row.conversation_id,
        toolCallsCount: row.tool_calls_count,
        outputContent: row.output_content,
      });

      // schedule_id stays NULL — see comment in the cron_job_runs branch.
      db.exec(
        `INSERT INTO job_runs (
           id, schedule_id, handler, payload_json, status, attempt,
           max_attempts, scheduled_for, started_at, completed_at, duration_ms,
           result_summary, error_message, created_at
         ) VALUES (?, NULL, 'pulse.execute', ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          payload,
          status,
          row.started_at,
          row.started_at,
          completedAt,
          row.duration_ms,
          row.result_summary,
          errorMessage,
          row.created_at,
        ],
      );
      migrated++;
    }
    db.exec("DROP TABLE pulse_runs");
    console.log(
      `[DB] Migrated ${migrated} pulse_runs row(s) into job_runs and dropped legacy table`,
    );
  }

  // Strip the four denormalized columns off `pulses` if any remain.
  const dyingCols = [
    "success_count",
    "error_count",
    "last_run_at",
    "last_status",
  ];
  const hasAnyDyingCol = dyingCols.some((col) =>
    !!db
      .prepare(
        `SELECT 1 FROM pragma_table_info('pulses') WHERE name = '${col}'`,
      )
      .get()
  );

  if (hasAnyDyingCol) {
    // SQLite ALTER TABLE DROP COLUMN works in 3.35+, but we rebuild the
    // table to guarantee correctness on any SQLite version and to take
    // the opportunity to ensure column ordering matches a fresh install.
    db.exec("BEGIN");
    try {
      db.exec(`
        CREATE TABLE pulses__new (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          prompt_text TEXT NOT NULL,
          chat_mode TEXT NOT NULL DEFAULT 'visible' CHECK (chat_mode IN ('visible', 'silent')),
          conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          trigger_type TEXT NOT NULL DEFAULT 'cron' CHECK (trigger_type IN ('cron', 'inactivity', 'webhook', 'filesystem')),
          cron_expression TEXT,
          interval_seconds INTEGER,
          random_interval_min INTEGER,
          random_interval_max INTEGER,
          run_at TEXT,
          inactivity_threshold_seconds INTEGER,
          chain_pulse_ids TEXT,
          max_chain_depth INTEGER NOT NULL DEFAULT 3,
          source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'entity')),
          auto_delete INTEGER NOT NULL DEFAULT 0,
          webhook_token TEXT,
          filesystem_watch_path TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO pulses__new
          (id, name, description, prompt_text, chat_mode, conversation_id, enabled,
           trigger_type, cron_expression, interval_seconds, random_interval_min,
           random_interval_max, run_at, inactivity_threshold_seconds, chain_pulse_ids,
           max_chain_depth, source, auto_delete, webhook_token, filesystem_watch_path,
           created_at, updated_at)
          SELECT
            id, name, description, prompt_text, chat_mode, conversation_id, enabled,
            trigger_type, cron_expression, interval_seconds, random_interval_min,
            random_interval_max, run_at, inactivity_threshold_seconds, chain_pulse_ids,
            max_chain_depth, source, auto_delete, webhook_token, filesystem_watch_path,
            created_at, updated_at
          FROM pulses;

        DROP TABLE pulses;
        ALTER TABLE pulses__new RENAME TO pulses;

        CREATE INDEX IF NOT EXISTS idx_pulses_enabled ON pulses(enabled);
        CREATE INDEX IF NOT EXISTS idx_pulses_trigger_type ON pulses(trigger_type);
        CREATE INDEX IF NOT EXISTS idx_pulses_conversation ON pulses(conversation_id);
      `);
      db.exec("COMMIT");
      console.log(
        "[DB] Rebuilt pulses table without denormalized run-stat columns",
      );
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}

/**
 * Initialize sqlite-vec virtual tables for vector similarity search.
 * Called after schema initialization.
 */
function initializeVectorTables(db: Database): void {
  try {
    // Load the sqlite-vec extension — bail out if unavailable
    const loaded = loadVectorExtension(db);
    if (!loaded) {
      console.warn(
        "[DB] sqlite-vec extension not available. Vector search will fall back to in-memory calculation.",
      );
      return;
    }

    const version = getVecVersion(db);
    if (!version) {
      console.warn(
        "[DB] sqlite-vec extension not available (vec_version check failed). Vector search will fall back to in-memory calculation.",
      );
      return;
    }
    console.log(`[DB] sqlite-vec extension loaded (version ${version})`);

    // Create vec_memory_chunks virtual table for memory RAG
    const hasMemoryVecTable = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec_memory_chunks'",
      )
      .get();

    if (!hasMemoryVecTable) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory_chunks USING vec0(
          embedding FLOAT[${getActiveEmbeddingDimension(db)}] distance=cosine
        )
      `);
      console.log("[DB] Created vec_memory_chunks virtual table");
    }

    // Create vec_messages virtual table for chat RAG
    const hasMessageVecTable = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec_messages'",
      )
      .get();

    if (!hasMessageVecTable) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_messages USING vec0(
          embedding FLOAT[${getActiveEmbeddingDimension(db)}] distance=cosine
        )
      `);
      console.log("[DB] Created vec_messages virtual table");
    }

    // Create vec_vault_chunks virtual table for vault RAG
    const hasVaultVecTable = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec_vault_chunks'",
      )
      .get();

    if (!hasVaultVecTable) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_vault_chunks USING vec0(
          embedding FLOAT[${getActiveEmbeddingDimension(db)}] distance=cosine
        )
      `);
      console.log("[DB] Created vec_vault_chunks virtual table");
    }

    // Verify and repair vector table sync
    console.log("[DB] verifyVectorTableSync starting");
    verifyVectorTableSync(db);
    console.log("[DB] verifyVectorTableSync completed");
  } catch (error) {
    // Log warning but don't fail - vector search is optional
    console.warn(
      "[DB] Failed to initialize sqlite-vec extension. Vector search will fall back to in-memory calculation.",
      error instanceof Error ? error.message : String(error),
    );
    console.warn(
      "[DB] Error stack:",
      error instanceof Error ? error.stack : "no stack",
    );
  }
}

/**
 * Verify that virtual tables are in sync with main tables.
 * If out of sync, clear the tracking tables to force a full reindex.
 */
function verifyVectorTableSync(db: Database): void {
  // Guard: verify the vec0 virtual table module is actually functional,
  // not just that the scalar functions are available. vec_version() can
  // return a value even when the vec0 module isn't registered for
  // virtual table operations. Test by querying an existing vec0 table.
  try {
    db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_memory_chunks'",
    )
      .get();
    // Table exists in schema — try to actually read it
    db.prepare("SELECT COUNT(*) as count FROM vec_memory_chunks")
      .get<{ count: number }>();
  } catch {
    console.warn(
      "[DB] sqlite-vec vec0 module not functional, skipping vector table sync verification",
    );
    return;
  }

  // Check memory_chunks vs vec_memory_chunks
  const memoryChunksCount = db
    .prepare("SELECT COUNT(*) as count FROM memory_chunks")
    .get<{ count: number }>()?.count ?? 0;

  let vecMemoryCount = 0;
  try {
    vecMemoryCount = db
      .prepare("SELECT COUNT(*) as count FROM vec_memory_chunks")
      .get<{ count: number }>()?.count ?? 0;
  } catch {
    console.warn(
      "[DB] vec_memory_chunks is corrupted, dropping and recreating",
    );
    if (!loadVectorExtension(db)) return;
    // Verify extension is actually loaded before recreating
    if (!getVecVersion(db)) {
      console.warn(
        "[DB] Extension not available for vec_memory_chunks recovery, skipping",
      );
      return;
    }
    try {
      db.exec("DROP TABLE IF EXISTS vec_memory_chunks");
    } catch { /* ignore */ }
    db.exec(
      `CREATE VIRTUAL TABLE vec_memory_chunks USING vec0(embedding FLOAT[${
        getActiveEmbeddingDimension(db)
      }] distance=cosine)`,
    );
  }

  if (memoryChunksCount !== vecMemoryCount) {
    console.warn(
      `[DB] Vector table mismatch: memory_chunks=${memoryChunksCount}, vec_memory_chunks=${vecMemoryCount}. Rebuilding vec_memory_chunks.`,
    );
    db.exec("DELETE FROM vec_memory_chunks");

    const memRows = db
      .prepare(
        "SELECT rowid, embedding FROM memory_chunks WHERE embedding IS NOT NULL",
      )
      .all<{ rowid: number; embedding: Uint8Array }>();

    let memRebuilt = 0;
    for (const row of memRows) {
      try {
        db.exec(
          "INSERT INTO vec_memory_chunks(rowid, embedding) VALUES (?, ?)",
          [row.rowid, row.embedding],
        );
        memRebuilt++;
      } catch {
        // Skip rows that fail
      }
    }
    console.log(
      `[DB] Rebuilt vec_memory_chunks: ${memRebuilt}/${memRows.length} rows restored`,
    );
  }

  // Check message_embeddings vs vec_messages
  const messageEmbeddingsCount = db
    .prepare("SELECT COUNT(*) as count FROM message_embeddings")
    .get<{ count: number }>()?.count ?? 0;

  let vecMessagesCount = 0;
  try {
    vecMessagesCount = db
      .prepare("SELECT COUNT(*) as count FROM vec_messages")
      .get<{ count: number }>()?.count ?? 0;
  } catch {
    console.warn(
      "[DB] vec_messages is corrupted, dropping and recreating",
    );
    if (!loadVectorExtension(db)) return;
    // Verify extension is actually loaded before recreating
    if (!getVecVersion(db)) {
      console.warn(
        "[DB] Extension not available for vec_messages recovery, skipping",
      );
      return;
    }
    try {
      db.exec("DROP TABLE IF EXISTS vec_messages");
    } catch { /* ignore */ }
    db.exec(
      `CREATE VIRTUAL TABLE vec_messages USING vec0(embedding FLOAT[${
        getActiveEmbeddingDimension(db)
      }] distance=cosine)`,
    );
  }

  if (messageEmbeddingsCount !== vecMessagesCount) {
    console.warn(
      `[DB] Vector table mismatch: message_embeddings=${messageEmbeddingsCount}, vec_messages=${vecMessagesCount}. Rebuilding vec_messages from message_embeddings.`,
    );
    // Rebuild vec_messages from message_embeddings instead of destroying both
    db.exec("DELETE FROM vec_messages");

    const rows = db
      .prepare(
        "SELECT rowid, embedding FROM message_embeddings WHERE embedding IS NOT NULL",
      )
      .all<{ rowid: number; embedding: Uint8Array }>();

    let rebuilt = 0;
    for (const row of rows) {
      try {
        db.exec(
          "INSERT INTO vec_messages(rowid, embedding) VALUES (?, ?)",
          [row.rowid, row.embedding],
        );
        rebuilt++;
      } catch {
        // Skip rows that fail (corrupted embeddings, etc.)
      }
    }
    console.log(
      `[DB] Rebuilt vec_messages: ${rebuilt}/${rows.length} rows restored`,
    );
  }

  // Check vault_chunks vs vec_vault_chunks
  const vaultChunksCount = db
    .prepare("SELECT COUNT(*) as count FROM vault_chunks")
    .get<{ count: number }>()?.count ?? 0;

  let vecVaultCount = 0;
  try {
    vecVaultCount = db
      .prepare("SELECT COUNT(*) as count FROM vec_vault_chunks")
      .get<{ count: number }>()?.count ?? 0;
  } catch {
    console.warn(
      "[DB] vec_vault_chunks is corrupted, dropping and recreating",
    );
    if (!loadVectorExtension(db)) return;
    // Verify extension is actually loaded before recreating
    if (!getVecVersion(db)) {
      console.warn(
        "[DB] Extension not available for vec_vault_chunks recovery, skipping",
      );
      return;
    }
    try {
      db.exec("DROP TABLE IF EXISTS vec_vault_chunks");
    } catch { /* ignore */ }
    db.exec(
      `CREATE VIRTUAL TABLE vec_vault_chunks USING vec0(embedding FLOAT[${
        getActiveEmbeddingDimension(db)
      }] distance=cosine)`,
    );
  }

  if (vaultChunksCount !== vecVaultCount) {
    console.warn(
      `[DB] Vector table mismatch: vault_chunks=${vaultChunksCount}, vec_vault_chunks=${vecVaultCount}. Rebuilding vec_vault_chunks.`,
    );
    db.exec("DELETE FROM vec_vault_chunks");

    const vaultRows = db
      .prepare(
        "SELECT rowid, embedding FROM vault_chunks WHERE embedding IS NOT NULL",
      )
      .all<{ rowid: number; embedding: Uint8Array }>();

    let vaultRebuilt = 0;
    for (const row of vaultRows) {
      try {
        db.exec(
          "INSERT INTO vec_vault_chunks(rowid, embedding) VALUES (?, ?)",
          [row.rowid, row.embedding],
        );
        vaultRebuilt++;
      } catch {
        // Skip rows that fail
      }
    }
    console.log(
      `[DB] Rebuilt vec_vault_chunks: ${vaultRebuilt}/${vaultRows.length} rows restored`,
    );
  }

  // Migration: Tag entity-loom imported conversations as source_type='import'
  // Entity-loom prefixes all titles with [platform] (e.g. [chatgpt], [claude]).
  // Imported conversations have source_type=NULL, which the app treats as 'web'.
  // Without this tag, the daily summarizer tries to re-summarize them.
  const hasImportTag = db
    .prepare(
      "SELECT 1 FROM conversations WHERE source_type = 'import' LIMIT 1",
    )
    .get();

  if (!hasImportTag) {
    const tagged = db
      .prepare(
        "UPDATE conversations SET source_type = 'import' WHERE (source_type IS NULL OR source_type = 'web') AND title LIKE '[[]%'",
      )
      .run();
    if (tagged > 0) {
      console.log(
        `[DB] Tagged ${tagged} entity-loom imported conversation(s) with source_type='import'`,
      );
    }
  }
}
