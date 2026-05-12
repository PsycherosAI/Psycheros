/**
 * Psycheros Database Schema
 *
 * Defines the SQLite database schema and initialization function
 * for persisting conversations and messages.
 */

import type { Database } from "@db/sqlite";
import { getVecVersion, loadVectorExtension } from "./vector.ts";

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
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_context_snapshots_conversation
    ON context_snapshots(conversation_id, turn_index DESC);
`;

/**
 * Embedding dimension for all-MiniLM-L6-v2 model.
 */
export const EMBEDDING_DIMENSION = 384;

/**
 * Initializes the database schema by executing the schema SQL.
 * This is idempotent - safe to call multiple times.
 *
 * @param db - The SQLite database instance
 */
export function initializeSchema(db: Database): void {
  db.exec(SCHEMA);
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

  // Migration: Add cron_job_runs table if missing
  const hasCronJobRuns = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cron_job_runs'",
    )
    .get();

  if (!hasCronJobRuns) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS cron_job_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('success', 'error')),
        result TEXT,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_cron_job_runs_job
        ON cron_job_runs(job_id, completed_at DESC);
    `);
    console.log("[DB] Created cron_job_runs table");
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
        success_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT,
        last_status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pulses_enabled
        ON pulses(enabled);

      CREATE INDEX IF NOT EXISTS idx_pulses_trigger_type
        ON pulses(trigger_type);

      CREATE INDEX IF NOT EXISTS idx_pulses_conversation
        ON pulses(conversation_id);

      CREATE TABLE IF NOT EXISTS pulse_runs (
        id TEXT PRIMARY KEY,
        pulse_id TEXT NOT NULL REFERENCES pulses(id) ON DELETE CASCADE,
        conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        trigger_source TEXT NOT NULL CHECK (trigger_source IN ('cron', 'webhook', 'filesystem', 'chain', 'manual', 'inactivity')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER,
        status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error', 'skipped')),
        result_summary TEXT,
        error_message TEXT,
        tool_calls_count INTEGER DEFAULT 0,
        output_content TEXT,
        chain_depth INTEGER NOT NULL DEFAULT 0,
        chain_parent_run_id TEXT REFERENCES pulse_runs(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_pulse_runs_pulse
        ON pulse_runs(pulse_id, completed_at DESC);

      CREATE INDEX IF NOT EXISTS idx_pulse_runs_status
        ON pulse_runs(status);

      CREATE INDEX IF NOT EXISTS idx_pulse_runs_conversation
        ON pulse_runs(conversation_id);
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
}

/**
 * Initialize sqlite-vec virtual tables for vector similarity search.
 * Called after schema initialization.
 */
function initializeVectorTables(db: Database): void {
  try {
    // Load the sqlite-vec extension
    loadVectorExtension(db);

    // Check if extension loaded successfully
    const version = getVecVersion(db);
    if (version) {
      console.log(`[DB] sqlite-vec extension loaded (version ${version})`);
    }

    // Create vec_memory_chunks virtual table for memory RAG
    const hasMemoryVecTable = db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec_memory_chunks'",
      )
      .get();

    if (!hasMemoryVecTable) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory_chunks USING vec0(
          embedding FLOAT[${EMBEDDING_DIMENSION}] distance=cosine
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
          embedding FLOAT[${EMBEDDING_DIMENSION}] distance=cosine
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
          embedding FLOAT[${EMBEDDING_DIMENSION}] distance=cosine
        )
      `);
      console.log("[DB] Created vec_vault_chunks virtual table");
    }

    // Verify and repair vector table sync
    verifyVectorTableSync(db);
  } catch (error) {
    // Log warning but don't fail - vector search is optional
    console.warn(
      "[DB] Failed to initialize sqlite-vec extension. Vector search will fall back to in-memory calculation.",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Verify that virtual tables are in sync with main tables.
 * If out of sync, clear the tracking tables to force a full reindex.
 */
function verifyVectorTableSync(db: Database): void {
  // Check memory_chunks vs vec_memory_chunks
  const memoryChunksCount = db
    .prepare("SELECT COUNT(*) as count FROM memory_chunks")
    .get<{ count: number }>()?.count ?? 0;

  const vecMemoryCount = db
    .prepare("SELECT COUNT(*) as count FROM vec_memory_chunks")
    .get<{ count: number }>()?.count ?? 0;

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

  const vecMessagesCount = db
    .prepare("SELECT COUNT(*) as count FROM vec_messages")
    .get<{ count: number }>()?.count ?? 0;

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

  const vecVaultCount = db
    .prepare("SELECT COUNT(*) as count FROM vec_vault_chunks")
    .get<{ count: number }>()?.count ?? 0;

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
}
