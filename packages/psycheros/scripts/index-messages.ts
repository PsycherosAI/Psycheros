#!/usr/bin/env -S deno run -A
/**
 * Index Existing Messages
 *
 * One-time migration script to embed all existing messages
 * and populate the message_embeddings tables for chat RAG.
 *
 * Usage:
 *   deno run -A scripts/index-messages.ts           # Index all messages
 *   deno run -A scripts/index-messages.ts --dry-run # Preview without indexing
 *   deno run -A scripts/index-messages.ts --limit 100 # Limit to 100 messages
 */

import { join } from "@std/path";
import { DBClient } from "../src/db/mod.ts";
import { getVecVersion, loadVectorExtension } from "../src/db/vector.ts";
import { getEmbedder } from "../src/rag/embedder.ts";
import { serializeVector } from "../src/db/vector.ts";

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
}

interface Args {
  dryRun: boolean;
  limit: number | null;
  batchSize: number;
  force: boolean;
}

function parseArgs(): Args {
  const args: Args = {
    dryRun: false,
    limit: null,
    batchSize: 50,
    force: false,
  };

  for (let i = 0; i < Deno.args.length; i++) {
    const arg = Deno.args[i];
    switch (arg) {
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--limit":
        args.limit = parseInt(Deno.args[++i]) || null;
        break;
      case "--batch-size":
        args.batchSize = parseInt(Deno.args[++i]) || 50;
        break;
      case "--force":
        args.force = true;
        break;
      case "--help":
      case "-h":
        console.log(`
Index existing messages for chat RAG.

Usage:
  deno run -A scripts/index-messages.ts [options]

Options:
  --dry-run         Preview messages to index without actually indexing
  --limit N         Only index N messages (useful for testing)
  --batch-size N    Process N messages at a time (default: 50)
  --force           Re-index even if already indexed
  --help, -h        Show this help message
`);
        Deno.exit(0);
    }
  }

  return args;
}

async function main() {
  const args = parseArgs();

  console.log("=== Message Indexing Script ===\n");

  // Determine database path
  const projectRoot = Deno.cwd();
  const dbPath = join(projectRoot, ".psycheros", "psycheros.db");

  console.log(`Database: ${dbPath}`);
  console.log(`Dry run: ${args.dryRun}`);
  if (args.limit) {
    console.log(`Limit: ${args.limit} messages`);
  }
  console.log();

  // Open database
  const db = new DBClient(dbPath);
  const rawDb = db.getRawDb();

  // Check sqlite-vec availability (optional - we can work without it)
  let useVectorExt = false;
  try {
    loadVectorExtension(rawDb);
    const version = getVecVersion(rawDb);
    if (version) {
      console.log(`sqlite-vec version: ${version}`);
      useVectorExt = true;
    } else {
      console.log(
        "sqlite-vec not available. Using in-memory fallback for search.",
      );
    }
  } catch {
    console.log(
      "sqlite-vec not available. Using in-memory fallback for search.",
    );
    console.log(
      "(Embeddings will still be stored and searchable via in-memory calculation)",
    );
  }

  // Count total messages
  const countStmt = rawDb.prepare(`
    SELECT COUNT(*) as count FROM messages
    WHERE role IN ('user', 'assistant') AND LENGTH(content) >= 10
  `);
  const countRow = countStmt.get<{ count: number }>();
  countStmt.finalize();
  const totalMessages = countRow?.count ?? 0;

  console.log(`Total messages to process: ${totalMessages}`);

  if (totalMessages === 0) {
    console.log("No messages to index.");
    db.close();
    return;
  }

  // Count already indexed
  const indexedStmt = rawDb.prepare(
    "SELECT COUNT(*) as count FROM message_embeddings",
  );
  const indexedRow = indexedStmt.get<{ count: number }>();
  indexedStmt.finalize();
  const alreadyIndexed = indexedRow?.count ?? 0;

  console.log(`Already indexed: ${alreadyIndexed}`);

  if (!args.force && alreadyIndexed > 0) {
    console.log("\nMessages already indexed. Use --force to re-index.");
    db.close();
    return;
  }

  // Clear existing data if force mode
  if (args.force) {
    console.log("\nClearing existing indexed data...");
    rawDb.exec("DELETE FROM message_embeddings");
    if (useVectorExt) {
      // Drop and recreate the virtual table (DELETE doesn't work reliably on vec0 tables)
      rawDb.exec("DROP TABLE IF EXISTS vec_messages");
      rawDb.exec(
        `CREATE VIRTUAL TABLE vec_messages USING vec0(embedding FLOAT[384])`,
      );
    }
    console.log("Cleared.");
  }

  if (args.dryRun) {
    console.log("\n[DRY RUN] Would index the following messages:");
    const previewStmt = rawDb.prepare(`
      SELECT id, conversation_id, role, content, created_at
      FROM messages
      WHERE role IN ('user', 'assistant') AND LENGTH(content) >= 10
      ORDER BY created_at ASC
      LIMIT 10
    `);
    const previewRows = previewStmt.all<MessageRow>();
    previewStmt.finalize();

    for (const row of previewRows) {
      const preview = row.content.substring(0, 100) +
        (row.content.length > 100 ? "..." : "");
      console.log(`  [${row.role}] ${preview}`);
    }

    console.log(`\n... and ${Math.max(0, totalMessages - 10)} more messages.`);
    db.close();
    return;
  }

  // Initialize embedder
  console.log("\nInitializing embedding model...");
  const embedder = getEmbedder();
  await embedder.initialize();
  console.log(`Embedding dimension: ${embedder.getDimension()}`);

  // Process messages in batches
  const limit = args.limit ?? totalMessages;
  let processed = 0;
  let indexed = 0;
  let skipped = 0;
  let errors = 0;
  const effectiveLimit = Math.min(limit, totalMessages);

  console.log(
    `\nProcessing ${effectiveLimit} messages in batches of ${args.batchSize}...\n`,
  );

  // Get all messages (with optional limit)
  const messagesStmt = rawDb.prepare(`
    SELECT id, conversation_id, role, content, created_at
    FROM messages
    WHERE role IN ('user', 'assistant') AND LENGTH(content) >= 10
    ORDER BY created_at ASC
    ${args.limit ? `LIMIT ${args.limit}` : ""}
  `);
  const messages = messagesStmt.all<MessageRow>();
  messagesStmt.finalize();

  for (const msg of messages) {
    processed++;

    // Check if already indexed (unless force)
    if (!args.force) {
      const checkStmt = rawDb.prepare(
        "SELECT 1 FROM message_embeddings WHERE message_id = ?",
      );
      const exists = checkStmt.get(msg.id);
      checkStmt.finalize();
      if (exists) {
        skipped++;
        continue;
      }
    }

    try {
      // Generate embedding
      const embedding = await embedder.embed(msg.content);
      const serialized = serializeVector(embedding);

      // Insert into message_embeddings
      const id = crypto.randomUUID();
      rawDb.exec(
        `INSERT INTO message_embeddings (id, message_id, conversation_id, role, content, embedding, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          msg.id,
          msg.conversation_id,
          msg.role,
          msg.content,
          serialized,
          msg.created_at,
        ],
      );

      // Get rowid and insert into vector table
      const rowidStmt = rawDb.prepare(
        "SELECT rowid FROM message_embeddings WHERE id = ?",
      );
      const row = rowidStmt.get<{ rowid: number }>(id);
      rowidStmt.finalize();

      if (row) {
        // Only insert into virtual table if sqlite-vec is available
        if (useVectorExt) {
          rawDb.exec(
            `INSERT INTO vec_messages(rowid, embedding) VALUES (?, ?)`,
            [row.rowid, serialized],
          );
        }
      }

      indexed++;

      // Progress update
      if (indexed % args.batchSize === 0) {
        console.log(
          `Progress: ${processed}/${effectiveLimit} processed, ${indexed} indexed, ${skipped} skipped, ${errors} errors`,
        );
      }
    } catch (error) {
      errors++;
      console.error(
        `Error indexing message ${msg.id}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  console.log("\n=== Indexing Complete ===");
  console.log(`Processed: ${processed}`);
  console.log(`Indexed: ${indexed}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Errors: ${errors}`);

  // Verify counts
  const finalCountStmt = rawDb.prepare(
    "SELECT COUNT(*) as count FROM message_embeddings",
  );
  const finalCount = finalCountStmt.get<{ count: number }>();
  finalCountStmt.finalize();
  console.log(`\nTotal indexed messages: ${finalCount?.count ?? 0}`);

  db.close();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  Deno.exit(1);
});
