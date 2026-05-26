# Changelog

All notable changes to entity-core are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this package follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.6] - 2026-05-26

### Fixed

- **EmbeddingCache v1→v2 migration failed on startup.** `CACHE_SCHEMA` combined
  `CREATE TABLE` and `CREATE INDEX` into one `db.exec()` call. On a database
  where `memory_embeddings` existed without the `parent_key` column (v1 schema),
  the `CREATE TABLE IF NOT EXISTS` was a no-op but the
  `CREATE INDEX ... ON memory_embeddings(parent_key)` failed immediately —
  before `migrateSchema()` ever got a chance to add the column. The schema DDL
  is now split into table creation and index creation, with the migration
  running between them.

## [0.2.5] - 2026-05-26

### Fixed

- **Significant memory update preserves slug.** `memory_update` now accepts an
  optional `slug` argument and falls back to the existing entry's slug when not
  provided. Previously the slug was lost during update, causing writes to a bare
  `{date}.md` file that shadowed the real `{date}_{slug}.md`.
- **Significant memory list returns unique keys.** The `memory_list` tool now
  returns `date_slug` (instead of bare `date`) for significant memories, so
  consumers can uniquely identify each memory file.
- **Orphan bare-date files auto-removed on list.** `listMemories` now
  automatically removes bare-date files (`YYYY-MM-DD.md`) found in the
  significant directory, instead of just logging a warning. These orphans from
  the slug propagation bug would show up in the UI as ghost entries that
  couldn't be deleted.
- **Significant memory delete cleans up orphan files.** `deleteMemory` now
  removes any bare-date orphan (`{date}.md`) alongside the target
  `{date}_{slug}.md` for significant memories. Previously the orphan would
  persist after deleting the real file, keeping the memory visible in the list
  even after a page refresh.

## [0.2.4] - 2026-05-24

### Fixed

- **Entity import failed to replace `graph.db` on Windows.** The import handler
  called `Deno.rename()` while GraphStore and EmbeddingCache still had the file
  open — Windows blocks rename when any file handle is active, causing
  `PermissionDenied (os error 5)`. The handler now closes both connections
  before the rename and reopens them after. `GraphStore` and `EmbeddingCache`
  both gained a `reopen()` method for this purpose. The startup embedding-cache
  backfill IIFE in `mod.ts` now also closes its connection when finished so it
  doesn't hold a stale handle.

## [0.2.3] - 2026-05-23

### Added

- Embedding chunking: long memories (>3000 chars) are now split into overlapping
  ~2048-char chunks, each embedded independently, improving recall on detailed
  memories.
- `scripts/rebuild-embedding-cache.ts` for backfilling chunked embeddings from
  an existing memory store.
- LLM client retry with exponential backoff (configurable via `maxRetries`).
- Automatic `max_completion_tokens` selection for OpenAI o-series and gpt-5.x
  models.

### Changed

- EmbeddingCache schema migrated to v2 with `parent_key`, `chunk_index`, and
  `total_chunks` columns. Existing v1 caches are auto-migrated on first boot.

## [0.2.2] - 2026-05-14

### Changed

- **Weekly / monthly / yearly consolidation no longer routes through
  `@psycheros/scheduler`.** I now run a local single-purpose
  `ConsolidationRunner` (`src/consolidation/runner.ts`) that owns one
  `consolidation_runs` table on `graph.db` and ticks every five minutes. The
  three cadences (Sundays / 1st of month / Jan 1, all at 5 AM UTC) are hardcoded
  — no general cron parser. A composite primary key on `(period, scheduled_for)`
  structurally prevents double-fire. Missed boundaries during downtime catch up
  on the first tick after boot via the existing `findUnconsolidatedPeriods`
  loop. The legacy `schedules` and `job_runs` tables are dropped on first boot
  (idempotent); run history is not preserved, but it was never user-facing in
  entity-core anyway.

  Motivation: I was using ~15% of the scheduler's surface (three
  `fire_once_then_align` recurring fires, no retries, no checkpoints, no ad-hoc
  enqueue). The full scheduler's machinery — leases, retry expedition, pruning —
  was overkill for what amounts to "fire at most one row per period per
  granularity." The narrower runner is ~250 LOC and ships standalone with
  entity-core, removing a workspace-level coupling that complicated standalone
  installation.

## [0.2.1] - 2026-05-14

### Fixed

- **Entity import wrote all files to every identity/memory category.** JSZip's
  `folder().files` returns ALL entries in the zip, not just the subfolder's
  entries. The import handler iterated `folder.files` to scope identity files
  and memories to their correct category/granularity, so every file ended up in
  every directory. Fixed by iterating `zip.files` directly with a prefix check.

- **Entity import crashed on stale DB handle.** The import handler replaced
  `graph.db` on disk with `Deno.writeFile`, which truncates the file in-place —
  any SQLite connection with the file open saw a corrupted/empty DB. Now uses an
  atomic temp-file + rename. Also fixed `GraphStore.close()` to reset the
  `initialized` flag so `initialize()` actually re-runs, added
  `Scheduler.replaceDatabase()` for updating the handle, and made
  `Scheduler.tick()` catch synchronous errors instead of crashing the process.

## [0.2.0] - 2026-05-14

### Changed

- **Weekly / monthly / yearly consolidation routes through the durable
  `@psycheros/scheduler`.** Schedules live in two new tables (`schedules` +
  `job_runs`) co-located in `graph.db`. Fires missed while the MCP server was
  down catch up on next boot with `fire_once_then_align` policy. The
  `Deno.cron`-based wiring (and the `--unstable-cron` runtime flag) are gone.

## [0.1.2] - 2026-05-13

### Added

- `ENTITY_CORE_VERSION` exported from `mod.ts` for consumers that want to
  surface the linked entity-core version (e.g., psycheros's admin diagnostics,
  entity-loom's version chip tooltip). Backed by `src/version.ts`, a JSON import
  of `deno.json`.

## [0.1.1] - 2026-05-13

### Fixed

- LLM JSON-response parsing: tolerate unpaired markdown code fences in
  responses. Previously a stray `` ``` `` (without a matching closer) could
  break JSON extraction; the parser now handles partial-fence shapes gracefully.

### Changed

- MCP tool name documentation in `docs/mcp-tools.md`: ~40 tool names switched
  from slash form (e.g. `identity/get_all`) to underscore form
  (`identity_get_all`) to match what `server.tool` actually registers. Adds
  previously-undocumented `memory_delete`.

## [0.1.0] - 2026-05-13

### Added

- Initial public release.
- Persistent identity and memory store exposed as an MCP server over stdio.
  Embodiments (Psycheros, an MCP shim for SillyTavern, Claude Code, OpenWebUI,
  anything else MCP-capable) spawn the server as a subprocess and sync identity
  and memory through pull / push tools.
- Identity files; hierarchical memory (daily → weekly → monthly → yearly
  summaries).
- Knowledge graph (people, places, relationships) backed by SQLite + sqlite-vec.
- Snapshot system: pre-destructive-operation snapshots for recovery.

[0.2.6]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.6
[0.2.5]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.5
[0.2.4]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.4
[0.2.3]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.3
[0.2.2]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.2
[0.1.1]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.1.1
[0.1.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.1.0
