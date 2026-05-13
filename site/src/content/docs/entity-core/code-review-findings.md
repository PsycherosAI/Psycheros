---
title: "Code Review Findings"
---

Status: **Complete** — all critical and high-severity issues fixed.

## Scope

Full code review covering MCP tool input validation, file storage safety (path
traversal), SQLite + sqlite-vec correctness, sync protocol / conflict
resolution, vector clock implementation, memory consolidation, LLM extraction
reliability, and snapshot integrity.

## Initial Observations

- ~20 TypeScript source files, compact codebase
- `server.ts` is ~810 lines registering 34 MCP tools — large surface area
- No automated tests
- File operations in `file-store.ts` — path sanitization critical
- Graph store uses sqlite-vec for vector search
- Sync protocol uses vector clocks — complex distributed systems logic

## Bugs Found and Fixed

### `data/` directory not auto-created (High — crash on first run)

- **Location**: `src/mod.ts:34`, `src/graph/store.ts:59`
- **Problem**: Code reads `ENTITY_CORE_DATA_DIR` (default `./data`) but never
  ensured it existed. SQLite throws
  `SqliteError: 14: unable to open database file` when the directory is missing.
- **Fix**: Added `await Deno.mkdir(dataDir, { recursive: true })` before
  `startServer()`

### No `.env` file loading (Medium — confusing DX)

- **Location**: `src/mod.ts` (missing import), `src/llm/client.ts:221-242`
- **Problem**: Unlike Psycheros (which imports `@std/dotenv/load`), entity-core
  never loaded `.env`. The `.env.example` file told users to "copy to .env" but
  the app wouldn't read it. Extraction features silently disabled without env
  vars.
- **Fix**: Added `import "@std/dotenv/load"` to `src/mod.ts` and `"@std/dotenv"`
  to `deno.json` imports

## Security Fix

### Path traversal in identity tool Zod schemas (Critical)

- **Location**: `src/tools/identity.ts:25-71`
- **Problem**: The `filename` field in 5 identity tool schemas
  (`IdentityWriteSchema`, `IdentityAppendSchema`, `IdentityPrependSchema`,
  `IdentityUpdateSectionSchema`, `IdentityDeleteCustomSchema`) accepted any
  string. An LLM prompt injection attack could pass `../../.env.md` to escape
  the data directory via MCP tool calls. The delete handler had inline path
  checks but write/append/prepend/update_section only checked for `.md`
  extension.
- **Fix**: Created shared `SafeFilenameSchema` with regex
  `/^[a-zA-Z0-9_-]+\.md$/` — enforces alphanumeric filenames at the Zod schema
  level. Applied to all 5 identity tool schemas. Inline handler checks remain as
  defense-in-depth.
- **Why this matters**: This is the most important security pattern in the
  codebase. Any new identity tools that accept filenames MUST use
  `SafeFilenameSchema`.

## Data Integrity Fixes (Session 27)

### Graph write transaction not atomic — partial writes on failure (High)

- **Location**: `src/tools/graph.ts` handler, `src/graph/store.ts`
- **Problem**: `graph_write_transaction` created nodes and edges in separate
  loops with no DB transaction. If edge creation failed mid-loop, nodes were
  already committed. Skipped edges (missing node refs) were silently dropped.
- **Fix**: Added `transaction()` method to GraphStore (BEGIN/COMMIT/ROLLBACK).
  Handler now wraps all operations in `store.transaction()`. Skipped edges are
  collected and reported in the response message.

### Batch graph write missing embedding support (Critical — broken pathway)

- **Location**: `src/tools/graph.ts:131-153`
- **Problem**: `GraphWriteTransactionSchema` nodes had no `embedding` field, but
  Psycheros sends pre-computed embeddings in batch writes. Zod stripped the
  field silently — nodes created without vector embeddings, invisible to
  semantic search.
- **Fix**: Added `embedding: z.array(z.number()).optional()` to schema. Handler
  now calls `store.updateNodeEmbedding()` after creating each node (matching the
  single-node `graph_node_create` pattern).

### Soft-deleted nodes still in vector table (High — corrupted search)

- **Location**: `src/graph/store.ts` — `deleteNode()`
- **Problem**: Soft-deleting a node marked it `deleted = 1` and soft-deleted
  edges, but the embedding row in `vec_graph_nodes` was not removed. Vector
  search returned deleted nodes.
- **Fix**: `deleteNode()` now removes from `vec_graph_nodes` when
  `vectorAvailable && changes > 0`.

### Permanent node deletion leaves orphaned edges (High)

- **Location**: `src/graph/store.ts` — `permanentlyDeleteNode()`
- **Problem**: Hard-deleted the node row but relied on FK CASCADE for edges.
  SQLite FK enforcement was never enabled (`PRAGMA foreign_keys` defaults to OFF
  in Deno's sqlite library), so edges with dangling `from_id`/`to_id` references
  remained.
- **Fix**: Added `PRAGMA foreign_keys = ON` in GraphStore constructor. Also
  added explicit edge deletion before node deletion as defense-in-depth.

### Memory sync overwrites original timestamps (Medium)

- **Location**: `src/tools/sync.ts:191-192`
- **Problem**: `sync_push` always set `createdAt`/`updatedAt` to
  `new Date().toISOString()`, ignoring timestamps from the source embodiment.
  All synced memories lost their original temporal ordering.
- **Fix**: Added `createdAt`/`updatedAt` as optional fields in `SyncPushSchema`.
  Handler now uses incoming timestamps when present, falls back to current time.

## Confirmed Safe Patterns

- **SQL injection**: All queries in `src/graph/store.ts` use `?` placeholders —
  no string concatenation
- **LIKE clauses**: User input wrapped as parameters, not string interpolation
- **Memory tool inputs**: `granularity` is Zod enum-validated (only
  daily/weekly/monthly/yearly/significant); `date` uses regex
  `/^\d{4}(-\d{2})?(-\d{2})?$/` — no path traversal possible
- **Transaction safety**: Graph write operations use `store.transaction()` for
  atomicity. Foreign keys enabled at SQLite level.

See also: [security-audit.md](./security-audit/) for the full security
assessment.
