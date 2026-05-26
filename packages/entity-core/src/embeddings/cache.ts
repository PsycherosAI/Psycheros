/**
 * Embedding Cache
 *
 * Caches memory embeddings in SQLite (graph.db) to avoid re-computing them
 * on every search query. Uses content-hash invalidation so embeddings
 * stay in sync with file content.
 *
 * Long memories (>3000 chars) are split into overlapping chunks, each
 * embedded independently. Short memories get a single embedding. All
 * chunks for a memory share a `parent_key` for deduplication at search time.
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
import { chunkContent, shouldChunk } from "./chunker.ts";

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
  parentKey: string;
  memoryId: string;
  granularity: string;
  date: string;
  contentHash: string;
  embedding: number[];
  chunkIndex: number;
  totalChunks: number;
}

export interface EmbeddingCacheStats {
  totalCached: number;
  totalChunks: number;
  byGranularity: Record<string, number>;
}

export interface CacheSearchResult {
  memoryKey: string;
  score: number;
  chunkIndex: number;
}

// ---- Schema (v2 — chunk support) ----
//
// Split into table DDL and index DDL so the migration can run
// between them. A v1 database has the table but not parent_key;
// CREATE TABLE IF NOT EXISTS is a no-op for existing tables, so
// the index on parent_key would fail before migrateSchema() gets
// a chance to add the column.

const CACHE_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS memory_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_key TEXT NOT NULL UNIQUE,
    parent_key TEXT NOT NULL DEFAULT '',
    memory_id TEXT NOT NULL,
    granularity TEXT NOT NULL,
    date TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    chunk_index INTEGER NOT NULL DEFAULT 0,
    total_chunks INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const CACHE_INDEX_DDL = `
  CREATE INDEX IF NOT EXISTS idx_memory_embeddings_memory_key
    ON memory_embeddings(memory_key);

  CREATE INDEX IF NOT EXISTS idx_memory_embeddings_parent_key
    ON memory_embeddings(parent_key);

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
   * Initialize the cache: create tables, run migrations, and load sqlite-vec.
   * Must be called before any operations.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    await ensureDir(join(this.dbPath, ".."));

    // Create table (no-op if it already exists). Indexes are created
    // AFTER the migration so the parent_key index doesn't fail on a
    // v1 table that lacks the column.
    this.db.exec(CACHE_TABLE_DDL);

    // Auto-download sqlite-vec extension into entity-core/lib/ if missing.
    const moduleDir = dirname(fromFileUrl(import.meta.url));
    const projectRoot = join(moduleDir, "..", "..");
    await ensureVectorExtension(projectRoot);

    // Load sqlite-vec extension and create vector table
    this.loadVectorExtension();
    this.vectorAvailable = this.initializeVectorTable();

    // Migrate v1 schema (no parent_key column) to v2 — must run
    // before index creation so parent_key is guaranteed to exist.
    this.migrateSchema();

    // Now safe to create indexes (parent_key is present)
    this.db.exec(CACHE_INDEX_DDL);

    this.initialized = true;
  }

  /**
   * Check if vector search is available (sqlite-vec loaded and table exists).
   */
  isAvailable(): boolean {
    return this.vectorAvailable;
  }

  /**
   * Look up cached embeddings by parent key and content hash.
   * Returns all matching chunk embeddings, or null if hash mismatch or missing.
   */
  getByParent(
    parentKey: string,
    currentContentHash: string,
  ): CachedEmbedding[] {
    if (!this.initialized) return [];

    const stmt = this.db.prepare(
      "SELECT id, memory_key, parent_key, memory_id, granularity, date, content_hash, chunk_index, total_chunks FROM memory_embeddings WHERE parent_key = ? LIMIT 1",
    );
    const row = stmt.get<{
      id: number;
      memory_key: string;
      parent_key: string;
      memory_id: string;
      granularity: string;
      date: string;
      content_hash: string;
      chunk_index: number;
      total_chunks: number;
    }>(parentKey);
    stmt.finalize();

    if (!row || row.content_hash !== currentContentHash) {
      return [];
    }

    // Hash matches — retrieve all chunk embeddings for this parent
    const idsStmt = this.db.prepare(
      "SELECT id, memory_key, parent_key, memory_id, granularity, date, content_hash, chunk_index, total_chunks FROM memory_embeddings WHERE parent_key = ? ORDER BY chunk_index",
    );
    const rows = idsStmt.all<
      {
        id: number;
        memory_key: string;
        parent_key: string;
        memory_id: string;
        granularity: string;
        date: string;
        content_hash: string;
        chunk_index: number;
        total_chunks: number;
      }
    >(parentKey);
    idsStmt.finalize();

    if (rows.length === 0) return [];

    const results: CachedEmbedding[] = [];
    for (const r of rows) {
      const embStmt = this.db.prepare(
        "SELECT embedding FROM vec_memory_embeddings WHERE rowid = ?",
      );
      const embRow = embStmt.get<{ embedding: Uint8Array }>(r.id);
      embStmt.finalize();

      if (!embRow) continue;

      results.push({
        memoryKey: r.memory_key,
        parentKey: r.parent_key,
        memoryId: r.memory_id,
        granularity: r.granularity,
        date: r.date,
        contentHash: r.content_hash,
        embedding: Array.from(
          new Float32Array(
            embRow.embedding.buffer,
            embRow.embedding.byteOffset,
            embRow.embedding.byteLength / 4,
          ),
        ),
        chunkIndex: r.chunk_index,
        totalChunks: r.total_chunks,
      });
    }

    return results;
  }

  /**
   * Store an embedding for a memory chunk. Upserts by memory_key.
   */
  put(
    memoryKey: string,
    parentKey: string,
    memoryId: string,
    granularity: string,
    date: string,
    contentHash: string,
    embedding: number[],
    chunkIndex: number,
    totalChunks: number,
  ): void {
    if (!this.initialized) return;

    const now = new Date().toISOString();

    // Upsert metadata row
    this.db.exec(
      `INSERT INTO memory_embeddings (memory_key, parent_key, memory_id, granularity, date, content_hash, chunk_index, total_chunks, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(memory_key) DO UPDATE SET
         parent_key = excluded.parent_key,
         content_hash = excluded.content_hash,
         chunk_index = excluded.chunk_index,
         total_chunks = excluded.total_chunks,
         updated_at = excluded.updated_at`,
      [
        memoryKey,
        parentKey,
        memoryId,
        granularity,
        date,
        contentHash,
        chunkIndex,
        totalChunks,
        now,
        now,
      ],
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
   * Remove all cached embeddings for a parent key (all chunks).
   */
  delete(parentKey: string): void {
    if (!this.initialized) return;

    // Get all rowids for this parent
    const rowidStmt = this.db.prepare(
      "SELECT id FROM memory_embeddings WHERE parent_key = ?",
    );
    const rows = rowidStmt.all<{ id: number }>(parentKey);
    rowidStmt.finalize();

    if (rows.length > 0) {
      for (const row of rows) {
        this.db.exec("DELETE FROM vec_memory_embeddings WHERE rowid = ?", [
          row.id,
        ]);
      }
    }

    this.db.exec("DELETE FROM memory_embeddings WHERE parent_key = ?", [
      parentKey,
    ]);
  }

  /**
   * KNN search on cached embeddings.
   * Returns top-k results deduplicated by parent_key, sorted by similarity.
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
      SELECT m.parent_key, m.chunk_index, v.distance
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
      parent_key: string;
      chunk_index: number;
      distance: number;
    }>(serialized, k, distance, k);
    stmt.finalize();

    // Deduplicate by parent_key, keeping best score and its chunk index
    const bestByParent = new Map<
      string,
      { memoryKey: string; score: number; chunkIndex: number }
    >();

    for (const row of rows) {
      const score = Math.max(0, 1 - row.distance / 2);
      const existing = bestByParent.get(row.parent_key);
      if (!existing || score > existing.score) {
        bestByParent.set(row.parent_key, {
          memoryKey: row.parent_key,
          score,
          chunkIndex: row.chunk_index,
        });
      }
    }

    return Array.from(bestByParent.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /**
   * Get or compute embeddings for a memory.
   * Handles chunking for long memories transparently.
   * Returns the first chunk's embedding for backward compatibility.
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

    const parentKey = computeMemoryKey(entry);
    const contentHash = await sha256Hex(entry.content);

    // Check cache validity by parent key with full content hash
    const cached = this.getByParent(parentKey, contentHash);
    if (cached.length > 0) {
      return { memoryKey: parentKey, embedding: cached[0].embedding };
    }

    // Cache miss — delete any stale chunks
    this.delete(parentKey);

    if (!shouldChunk(entry.content)) {
      // SHORT PATH: single embedding (unchanged behavior)
      const embedding = await embedder.embed(entry.content);
      if (!embedding) return null;

      this.put(
        parentKey,
        parentKey,
        `${entry.granularity}-${entry.date}`,
        entry.granularity,
        entry.date,
        contentHash,
        embedding,
        0,
        1,
      );
      return { memoryKey: parentKey, embedding };
    }

    // LONG PATH: chunk and embed each chunk
    const chunks = chunkContent(entry.content);
    let firstEmbedding: number[] | null = null;

    for (const chunk of chunks) {
      const embedding = await embedder.embed(chunk.content);
      if (!embedding) continue;

      if (!firstEmbedding) firstEmbedding = embedding;

      const memoryKey = chunks.length === 1
        ? parentKey
        : `${parentKey}#${chunk.index}`;

      this.put(
        memoryKey,
        parentKey,
        `${entry.granularity}-${entry.date}`,
        entry.granularity,
        entry.date,
        contentHash,
        embedding,
        chunk.index,
        chunks.length,
      );
    }

    return firstEmbedding
      ? { memoryKey: parentKey, embedding: firstEmbedding }
      : null;
  }

  /**
   * Get cache statistics.
   */
  getStats(): EmbeddingCacheStats {
    if (!this.initialized) {
      return { totalCached: 0, totalChunks: 0, byGranularity: {} };
    }

    const stmt = this.db.prepare(
      "SELECT granularity, COUNT(DISTINCT parent_key) as count, COUNT(*) as chunk_count FROM memory_embeddings GROUP BY granularity",
    );
    const rows = stmt.all<
      { granularity: string; count: number; chunk_count: number }
    >();
    stmt.finalize();

    const byGranularity: Record<string, number> = {};
    let totalCached = 0;
    let totalChunks = 0;
    for (const row of rows) {
      byGranularity[row.granularity] = row.count;
      totalCached += row.count;
      totalChunks += row.chunk_count;
    }

    return { totalCached, totalChunks, byGranularity };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
    this.initialized = false;
  }

  /**
   * Close and recreate the database connection.
   * Used after graph.db is replaced on disk (entity_import) so
   * the new file is picked up without discarding the cache instance.
   */
  reopen(): void {
    try {
      this.db.close();
    } catch {
      // Already closed — safe to ignore
    }
    this.db = new Database(this.dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.initialized = false;
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

  /**
   * Migrate v1 schema (no parent_key) to v2 (with chunk support).
   *
   * All existing single-row embeddings become unchunked:
   * parent_key = memory_key, chunk_index = 0, total_chunks = 1.
   * Vec rowids are preserved through the copy.
   *
   * The content hash change (full content vs truncated 3000) will
   * cause all entries to be invalidated on next getOrCompute(),
   * triggering re-embedding with proper chunking.
   */
  private migrateSchema(): void {
    const colInfo = this.db.prepare("PRAGMA table_info(memory_embeddings)");
    const columns = colInfo.all<{ name: string }>().map((r) => r.name);
    colInfo.finalize();

    if (columns.includes("parent_key")) return;

    console.error("[EmbeddingCache] Migrating schema: adding chunk support");

    this.db.exec(
      "ALTER TABLE memory_embeddings RENAME TO memory_embeddings_old",
    );

    this.db.exec(CACHE_TABLE_DDL);
    this.db.exec(CACHE_INDEX_DDL);

    // Migrate data: existing rows become unchunked
    this.db.exec(`
      INSERT INTO memory_embeddings
        (memory_key, parent_key, memory_id, granularity, date, content_hash, chunk_index, total_chunks, created_at, updated_at)
      SELECT memory_key, memory_key, memory_id, granularity, date, content_hash, 0, 1, created_at, updated_at
      FROM memory_embeddings_old
    `);

    this.db.exec("DROP TABLE memory_embeddings_old");

    console.error("[EmbeddingCache] Schema migration complete");
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
