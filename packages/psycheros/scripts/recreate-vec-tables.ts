#!/usr/bin/env -npx ts-node
/**
 * Recreate vector tables with cosine distance metric.
 *
 * Usage: deno run -A scripts/recreate-vec-tables.ts
 */

import { Database } from "@db/sqlite";
import { join } from "@std/path";
import { loadVectorExtension } from "../src/db/vector.ts";

const projectRoot = join(import.meta.dirname!, "..");
const dbPath = join(projectRoot, ".psycheros", "psycheros.db");

console.log("Recreating vector tables with cosine distance...");
console.log("Database:", dbPath);

const db = new Database(dbPath);

// Load the sqlite-vec extension
loadVectorExtension(db);
console.log("[DB] sqlite-vec extension loaded");

// Drop old tables
console.log("\nDropping old vector tables...");
try {
  db.exec("DROP TABLE IF EXISTS vec_messages");
  console.log("  - Dropped vec_messages");
} catch (e) {
  console.log("  - vec_messages not found or error:", e);
}

try {
  db.exec("DROP TABLE IF EXISTS vec_memory_chunks");
  console.log("  - Dropped vec_memory_chunks");
} catch (e) {
  console.log("  - vec_memory_chunks not found or error:", e);
}

// Clear message embeddings
console.log("\nClearing message_embeddings...");
db.exec("DELETE FROM message_embeddings");
console.log("  - Cleared");

// Clear memory chunks
console.log("Clearing memory_chunks...");
db.exec("DELETE FROM memory_chunks WHERE embedding IS NOT NULL");
console.log("  - Cleared");

console.log(
  "\nDone! The tables will be recreated with distance=cosine when the server starts.",
);
console.log("Now run: deno run -A scripts/index-messages.ts --force");

db.close();
