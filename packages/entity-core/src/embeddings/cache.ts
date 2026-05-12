/**
 * Embedding Cache
 *
 * Caches memory embeddings in SQLite (graph.db) to avoid re-computing them
 * on every search query. Uses content-hash invalidation so embeddings
 * stay in sync with file content.
 *
 * Shares graph.db with GraphStore — SQLite WAL mode allows concurrent readers.
 * The sqlite-vec extension is loaded independently per connection.
 */

import { Database } from "@db/sqlite";
import { dirname, fromFileUrl, join } from "@std/path";
import { ensureDir } from "@std/fs";
import {
  ensureVectorExtension,
  getPlatformExtension,
} from "../vec-extension.ts";
import type { LocalEmbedder } from "./mod.ts";
import { EMBEDDING_DIMENSION } from "../graph/types.ts";
import type { Granularity } from "../types.ts";

/** Maximum content length to hash/embed (matches vectorSearch truncation). */
const MAX_CONTENT_LENGTH = 3000;

// ---- SHA-256 hash utility (Deno built-in) ----

async function sha256Hex(text: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---- Vector serialization (same as GraphStore) ----

function serializeVector(vec: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vec).buffer);
}

// ---- Types ----

export interface CachedEmbedding {
  memoryKey: string;
  memoryId: string;
  granularity: string;
  date: string;
  contentHash: string;
  embedding: number[];
}

export interface EmbeddingCacheStats {
  totalCached: number;
  byGranularity: Record<string, number>;
}

export interface CacheSearchResult {
  memoryKey: string;
  score: number;
}

// ---- Schema ----

const CACHE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_key TEXT NOT NULL UNIQUE,
    memory_id TEXT NOT NULL,
    granularity TEXT NOT NULL,
    date TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memory_embeddings_memory_key
    ON memory_embeddings(memory_key);

  CREATE INDEX IF NOT EXISTS idx_memory_embeddings_granularity
    ON memory_embeddings(granularity);
`;

const VECTOR_TABLE_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_memory_embeddings USING vec0(
    embedding FLOAT[${EMBEDDING_DIMENSION}] distance=cosine
  )
`;

// ---- Cache class ----

export class EmbeddingCache {
  private db: Database;
  private dbPath: string;
  private vectorAvailable = false;
  private initialized = false;

  constructor(dataDir: string) {
    this.dbPath = join(dataDir, "graph.db");
    this.db = new Database(this.dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  /**
   * Initialize the cache: create tables and load sqlite-vec extension.
   * Must be called before any operations.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await ensureDir(join(this.dbPath, ".."));

    // Create main metadata table (always succeeds)
    this.db.exec(CACHE_SCHEMA);

    // Auto-download sqlite-vec extension into entity-core/lib/ if missing.
    const moduleDir = dirname(fromFileUrl(import.meta.url));
    const projectRoot = join(moduleDir, "..", "..");
    await ensureVectorExtension(projectRoot);

    // Load sqlite-vec extension and create vector table
    this.loadVectorExtension();
    this.vectorAvailable = this.initializeVectorTable();

    this.initialized = true;
  }

  /**
   * Check if vector search is available (sqlite-vec loaded and table exists).
   */
  isAvailable(): boolean {
    return this.vectorAvailable;
  }

  /**
   * Look up a cached embedding by memory key and content hash.
   * Returns the embedding if found and hash matches, null otherwise.
   */
  get(memoryKey: string, currentContentHash: string): number[] | null {
    if (!this.initialized) return null;

    const stmt = this.db.prepare(
      "SELECT e.content_hash FROM memory_embeddings e WHERE e.memory_key = ?",
    );
    const row = stmt.get<{ content_hash: string }>(memoryKey);
    stmt.finalize();

    if (!row || row.content_hash !== currentContentHash) {
      return null; // Not cached or content changed
    }

    // Hash matches — retrieve embedding from vec table
    const vecStmt = this.db.prepare(
      "SELECT v.rowid FROM memory_embeddings m JOIN vec_memory_embeddings v ON m.id = v.rowid WHERE m.memory_key = ?",
    );
    const vecRow = vecStmt.get<{ rowid: number }>(memoryKey);
    vecStmt.finalize();

    if (!vecRow) return null;

    const embStmt = this.db.prepare(
      "SELECT embedding FROM vec_memory_embeddings WHERE rowid = ?",
    );
    const embRow = embStmt.get<{ embedding: Uint8Array }>(vecRow.rowid);
    embStmt.finalize();

    if (!embRow) return null;

    return Array.from(
      new Float32Array(
        embRow.embedding.buffer,
        embRow.embedding.byteOffset,
        embRow.embedding.byteLength / 4,
      ),
    );
  }

  /**
   * Store an embedding for a memory. Upserts by memory_key.
   */
  put(
    memoryKey: string,
    memoryId: string,
    granularity: string,
    date: string,
    contentHash: string,
    embedding: number[],
  ): void {
    if (!this.initialized) return;

    const now = new Date().toISOString();

    // Upsert metadata row
    this.db.exec(
      `INSERT INTO memory_embeddings (memory_key, memory_id, granularity, date, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_key) DO UPDATE SET
         content_hash = excluded.content_hash,
         updated_at = excluded.updated_at`,
      [memoryKey, memoryId, granularity, date, contentHash, now, now],
    );

    // Get the rowid for this memory_key
    const rowidStmt = this.db.prepare(
      "SELECT id FROM memory_embeddings WHERE memory_key = ?",
    );
    const row = rowidStmt.get<{ id: number }>(memoryKey);
    rowidStmt.finalize();

    if (!row) return;

    if (this.vectorAvailable) {
      const serialized = serializeVector(embedding);

      // Delete existing embedding, then insert new one
      this.db.exec("DELETE FROM vec_memory_embeddings WHERE rowid = ?", [
        row.id,
      ]);
      this.db.exec(
        "INSERT INTO vec_memory_embeddings(rowid, embedding) VALUES (?, ?)",
        [row.id, serialized],
      );
    }
  }

  /**
   * Remove a cached embedding by memory key.
   */
  delete(memoryKey: string): void {
    if (!this.initialized) return;

    // Get rowid before deleting metadata
    const rowidStmt = this.db.prepare(
      "SELECT id FROM memory_embeddings WHERE memory_key = ?",
    );
    const row = rowidStmt.get<{ id: number }>(memoryKey);
    rowidStmt.finalize();

    if (row) {
      this.db.exec("DELETE FROM vec_memory_embeddings WHERE rowid = ?", [
        row.id,
      ]);
    }

    this.db.exec("DELETE FROM memory_embeddings WHERE memory_key = ?", [
      memoryKey,
    ]);
  }

  /**
   * KNN search on cached embeddings.
   * Returns top-k results sorted by similarity (best first).
   */
  search(
    queryEmbedding: number[],
    k: number,
    maxDistance?: number,
  ): CacheSearchResult[] {
    if (!this.vectorAvailable) return [];

    const serialized = serializeVector(queryEmbedding);
    const distance = maxDistance ?? 2.0; // cosine distance max is 2.0
    const sql = `
      SELECT m.memory_key, m.memory_id, m.granularity, m.date, m.content_hash, v.distance
      FROM memory_embeddings m
      JOIN vec_memory_embeddings v ON m.id = v.rowid
      WHERE v.embedding MATCH ?
        AND v.k = ?
        AND v.distance <= ?
      ORDER BY v.distance ASC
      LIMIT ?
    `;

    const stmt = this.db.prepare(sql);
    const rows = stmt.all<{
      memory_key: string;
      memory_id: string;
      granularity: string;
      date: string;
      content_hash: string;
      distance: number;
    }>(serialized, k, distance, k);
    stmt.finalize();

    return rows.map((row) => ({
      memoryKey: row.memory_key,
      score: Math.max(0, 1 - row.distance / 2),
    }));
  }

  /**
   * Get or compute an embedding for a memory.
   * If cached and hash matches, returns cached embedding.
   * Otherwise computes, caches, and returns the new embedding.
   */
  async getOrCompute(
    entry: {
      granularity: string;
      date: string;
      sourceInstance?: string;
      slug?: string;
      content: string;
    },
    embedder: LocalEmbedder,
  ): Promise<{ memoryKey: string; embedding: number[] } | null> {
    if (!this.initialized) return null;

    const memoryKey = computeMemoryKey(entry);
    const contentToHash = entry.content.substring(0, MAX_CONTENT_LENGTH);
    const contentHash = await sha256Hex(contentToHash);

    // Check cache
    const cached = this.get(memoryKey, contentHash);
    if (cached) {
      return { memoryKey, embedding: cached };
    }

    // Compute embedding
    const embedding = await embedder.embed(contentToHash);
    if (!embedding) return null;

    // Cache it
    this.put(
      memoryKey,
      `${entry.granularity}-${entry.date}`,
      entry.granularity,
      entry.date,
      contentHash,
      embedding,
    );

    return { memoryKey, embedding };
  }

  /**
   * Get cache statistics.
   */
  getStats(): EmbeddingCacheStats {
    if (!this.initialized) return { totalCached: 0, byGranularity: {} };

    const stmt = this.db.prepare(
      "SELECT granularity, COUNT(*) as count FROM memory_embeddings GROUP BY granularity",
    );
    const rows = stmt.all<{ granularity: string; count: number }>();
    stmt.finalize();

    const byGranularity: Record<string, number> = {};
    let totalCached = 0;
    for (const row of rows) {
      byGranularity[row.granularity] = row.count;
      totalCached += row.count;
    }

    return { totalCached, byGranularity };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  // ---- Private helpers ----

  private loadVectorExtension(): void {
    const moduleDir = dirname(fromFileUrl(import.meta.url));
    const candidates = [
      join(moduleDir, "..", "..", "lib", getPlatformExtension()),
      join(moduleDir, "..", "..", "lib", "vec0"),
    ];

    try {
      this.db.enableLoadExtension = true;
      for (const extPath of candidates) {
        try {
          this.db.exec(`SELECT load_extension('${extPath}')`);
          this.db.enableLoadExtension = false;
          return;
        } catch {
          // Try next candidate
        }
      }
      this.db.enableLoadExtension = false;
      console.error(
        "[EmbeddingCache] sqlite-vec extension not found. Cache will be metadata-only.",
      );
    } catch {
      try {
        this.db.enableLoadExtension = false;
      } catch { /* ignore */ }
      console.error("[EmbeddingCache] Failed to load sqlite-vec extension.");
    }
  }

  private initializeVectorTable(): boolean {
    try {
      const stmt = this.db.prepare("SELECT vec_version() as version");
      const result = stmt.get<{ version: string }>();
      stmt.finalize();

      if (result?.version) {
        const hasTable = this.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec_memory_embeddings'",
          )
          .get();

        if (!hasTable) {
          this.db.exec(VECTOR_TABLE_SQL);
        }
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}

// ---- Utility functions ----

/**
 * Compute the memory_key (filename stem) for a memory entry.
 * Matches the file naming logic in FileStore.getMemoryPath().
 *
 * Examples:
 *   daily/2026-04-15_psycheros → "2026-04-15_psycheros"
 *   significant/2026-03-20_first-conversation → "2026-03-20_first-conversation"
 *   weekly/2026-W15 → "2026-W15"
 */
export function computeMemoryKey(entry: {
  granularity: string;
  date: string;
  sourceInstance?: string;
  slug?: string;
}): string {
  const { granularity, date, sourceInstance, slug } = entry;

  switch (granularity as Granularity) {
    case "daily":
      return sourceInstance ? `${date}_${sourceInstance}` : date;
    case "significant":
      return slug ? `${date}_${slug}` : date;
    default:
      return date;
  }
}
