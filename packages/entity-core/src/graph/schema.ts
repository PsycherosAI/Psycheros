/**
 * Graph Schema
 *
 * SQLite table definitions for my knowledge graph.
 * Uses sqlite-vec for semantic search on nodes.
 */

import type { Database } from "@db/sqlite";
import { EMBEDDING_DIMENSION } from "./types.ts";

/**
 * SQL schema for the knowledge graph.
 * Creates tables for nodes and edges with proper indexes.
 */
export const GRAPH_SCHEMA = `
  -- Nodes table: stores entities, concepts, and things I know about
  CREATE TABLE IF NOT EXISTS graph_nodes (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    label TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    properties TEXT NOT NULL DEFAULT '{}',
    source_instance TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    source_memory_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    first_learned_at TEXT,
    last_confirmed_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    deleted INTEGER NOT NULL DEFAULT 0
  );

  -- Indexes for common queries
  CREATE INDEX IF NOT EXISTS idx_graph_nodes_type
    ON graph_nodes(type) WHERE deleted = 0;

  CREATE INDEX IF NOT EXISTS idx_graph_nodes_source_memory
    ON graph_nodes(source_memory_id) WHERE deleted = 0;

  CREATE INDEX IF NOT EXISTS idx_graph_nodes_deleted
    ON graph_nodes(deleted);

  -- Edges table: stores relationships between nodes
  CREATE TABLE IF NOT EXISTS graph_edges (
    id TEXT PRIMARY KEY,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    type TEXT NOT NULL,
    custom_type TEXT,
    properties TEXT NOT NULL DEFAULT '{}',
    weight REAL NOT NULL DEFAULT 0.5,
    evidence TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    occurred_at TEXT,
    valid_until TEXT,
    last_confirmed_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    deleted INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES graph_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (to_id) REFERENCES graph_nodes(id) ON DELETE CASCADE
  );

  -- Indexes for edge queries
  CREATE INDEX IF NOT EXISTS idx_graph_edges_from
    ON graph_edges(from_id) WHERE deleted = 0;

  CREATE INDEX IF NOT EXISTS idx_graph_edges_to
    ON graph_edges(to_id) WHERE deleted = 0;

  CREATE INDEX IF NOT EXISTS idx_graph_edges_type
    ON graph_edges(type) WHERE deleted = 0;

  CREATE INDEX IF NOT EXISTS idx_graph_edges_valid
    ON graph_edges(valid_until) WHERE deleted = 0;

  CREATE INDEX IF NOT EXISTS idx_graph_edges_deleted
    ON graph_edges(deleted);

  -- Memory-Node links: tracks which memories mention which nodes
  CREATE TABLE IF NOT EXISTS memory_node_links (
    memory_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (memory_id, node_id),
    FOREIGN KEY (node_id) REFERENCES graph_nodes(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_memory_node_links_memory
    ON memory_node_links(memory_id);

  CREATE INDEX IF NOT EXISTS idx_memory_node_links_node
    ON memory_node_links(node_id);
`;

/**
 * SQL to create the vector virtual table for semantic search.
 * This is run separately after checking for sqlite-vec availability.
 */
export const VECTOR_TABLE_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_graph_nodes USING vec0(
    embedding FLOAT[${EMBEDDING_DIMENSION}] distance=cosine
  )
`;

/**
 * Initialize the graph schema in the database.
 * This is idempotent - safe to call multiple times.
 *
 * @param db - The SQLite database instance
 * @returns true if vector tables were created successfully
 */
export function initializeGraphSchema(db: Database): boolean {
  // Create main tables first (needed by migrations that query them)
  db.exec(GRAPH_SCHEMA);

  // Run migrations after tables exist
  runMigrations(db);

  // Try to create vector tables
  return initializeVectorTables(db);
}

/**
 * Run database migrations for schema updates.
 *
 * @param db - The SQLite database instance
 */
function runMigrations(db: Database): void {
  // Migration: Remove memory_ref nodes and memory_node_links table
  // memory_ref nodes were redundant copies of memory content — the memory
  // filesystem and Psycheros' RAG system handle substance. The graph is now
  // a relational index of durable state only.
  //
  // This migration only runs if there are existing memory_ref nodes to clean up.
  // On fresh databases, there are no memory_ref nodes, so this is a no-op.

  // Check if any memory_ref nodes exist (only then do we need to migrate)
  const memoryRefCount = db
    .prepare(
      "SELECT COUNT(*) as count FROM graph_nodes WHERE type = 'memory_ref' AND deleted = 0",
    )
    .get<{ count: number }>()?.count ?? 0;

  if (memoryRefCount > 0) {
    const now = new Date().toISOString();

    // Drop the memory_node_links table if it exists
    try {
      db.exec("DROP TABLE IF EXISTS memory_node_links");
      console.log("[Graph] Migration: dropped memory_node_links table");
    } catch {
      // Table may not exist
    }

    // Drop the source_memory index if it exists
    try {
      db.exec("DROP INDEX IF EXISTS idx_graph_nodes_source_memory");
      console.log(
        "[Graph] Migration: dropped idx_graph_nodes_source_memory index",
      );
    } catch {
      // Index may not exist
    }

    // Soft-delete memory_ref nodes
    db.exec(
      "UPDATE graph_nodes SET deleted = 1, updated_at = ? WHERE type = 'memory_ref' AND deleted = 0",
      [now],
    );

    // Soft-delete "mentions" edges (they connected memory_ref nodes to entities)
    db.exec(
      "UPDATE graph_edges SET deleted = 1, updated_at = ? WHERE type = 'mentions' AND deleted = 0",
      [now],
    );

    // Remove memory_ref embeddings from vector table
    try {
      db.exec(
        `DELETE FROM vec_graph_nodes WHERE rowid IN (
          SELECT rowid FROM graph_nodes WHERE type = 'memory_ref'
        )`,
      );
    } catch {
      // Vector table may not exist or may not have these entries
    }

    console.log(
      `[Graph] Migration: soft-deleted ${memoryRefCount} memory_ref nodes and their mentions edges`,
    );
  }
}

/**
 * Initialize sqlite-vec virtual tables for node embeddings.
 *
 * @param db - The SQLite database instance
 * @returns true if vector tables were created successfully
 */
function initializeVectorTables(db: Database): boolean {
  try {
    // Check if vec_version function exists (extension loaded)
    const stmt = db.prepare("SELECT vec_version() as version");
    const result = stmt.get<{ version: string }>();
    stmt.finalize();

    if (result?.version) {
      // Extension is loaded, create virtual table
      const hasVecTable = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec_graph_nodes'",
        )
        .get();

      if (!hasVecTable) {
        db.exec(VECTOR_TABLE_SQL);
      }
      return true;
    }
    return false;
  } catch {
    // sqlite-vec not available
    return false;
  }
}

/**
 * Check if vector search is available.
 *
 * @param db - The SQLite database instance
 * @returns true if vector search is available
 */
export function isVectorSearchAvailable(db: Database): boolean {
  try {
    const stmt = db.prepare("SELECT vec_version() as version");
    const result = stmt.get<{ version: string }>();
    stmt.finalize();
    return !!result?.version;
  } catch {
    return false;
  }
}

/**
 * Get the sqlite-vec version string.
 *
 * @param db - The SQLite database instance
 * @returns The version string or null if not available
 */
export function getVecVersion(db: Database): string | null {
  try {
    const stmt = db.prepare("SELECT vec_version() as version");
    const result = stmt.get<{ version: string }>();
    stmt.finalize();
    return result?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Verify that the vector table is in sync with the nodes table.
 * If out of sync, clear the vector table to force re-indexing.
 *
 * @param db - The SQLite database instance
 */
export function verifyVectorTableSync(db: Database): void {
  try {
    const nodesWithVec = db
      .prepare(
        "SELECT COUNT(*) as count FROM graph_nodes n WHERE n.deleted = 0 AND EXISTS (SELECT 1 FROM vec_graph_nodes v WHERE v.rowid = n.rowid)",
      )
      .get<{ count: number }>()?.count ?? 0;

    const vecCount = db
      .prepare("SELECT COUNT(*) as count FROM vec_graph_nodes")
      .get<{ count: number }>()?.count ?? 0;

    if (nodesWithVec !== vecCount) {
      console.warn(
        `[Graph] Vector table mismatch: embedded_nodes=${nodesWithVec}, vec_entries=${vecCount}. Vector search may be incomplete.`,
      );
    }
  } catch {
    // Vector table might not exist yet
  }
}
