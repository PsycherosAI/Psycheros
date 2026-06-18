# Changelog

All notable changes to entity-core are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this package follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.3] - 2026-06-18

### Fixed

- `ConsolidationRunner.tickTimer` now uses
  `ReturnType<typeof setInterval> | null` instead of `number | null` so the type
  resolves correctly under Node ambient types (`NodeJS.Timeout`) as well as Deno
  (`number`). Windows contributors whose editor pulled in `@types/node` hit
  `TS2322` on the field assignment. Part of the same workspace-wide fix — see
  [#18](https://github.com/PsycherosAI/Psycheros/issues/18).

## [0.4.2] - 2026-06-18

### Fixed

- `LLMClient.complete()` throws `NO_COMPLETION` on null or empty content instead
  of returning null and crashing callers downstream (notably graph extraction
  with "Cannot read properties of null (reading 'trim')").

- `LLMClient.completeJSON()` strips a bare `"json\n"` prefix when no surrounding
  backticks survive — happens when an upstream stream drop loses the opening
  fence bytes mid-flight.

- Entity import no longer fails on wrapped export zips. When a Windows "Send to
  → Compressed folder" workflow or cloud-sync tool nests the export one level
  deep, the importer detects and flattens the wrapper before processing.

## [0.4.1] - 2026-06-17

### Fixed

- `extraction.llmAvailable` in sync_status now reflects the current environment
  on every read instead of a cached snapshot from the last extraction attempt. A
  fresh boot with credentials correctly passed reports `true` immediately,
  without waiting for the first extraction to run.

## [0.4.0] - 2026-06-09

### Added

- `memory_grep` MCP tool: plain-text keyword search across all memories, scored
  by query term overlap (no embeddings, no recency bias).
- `memory_read` now accepts an optional `slug` parameter to disambiguate
  significant memories that share the same date.

## [0.3.6] - 2026-06-09

### Fixed

- GPT-5.x models now correctly strip all sampling parameters (temperature,
  top_p, frequency/presence penalty) before sending requests.

## [0.3.5] - 2026-06-03

### Fixed

- Deno version reference reverted to 2.7.14 to match runtime.

## [0.3.4] - 2026-06-02

### Fixed

- Long prose memories no longer silently lose their body text during
  consolidation excerpting.
- Significant memories now return full content in RAG retrieval instead of
  truncated excerpts (capped at 10k chars as a safety net).

## [0.3.3] - 2026-06-01

### Fixed

- Memory RAG retrieval improved with keyword-based boosting alongside vector
  search, reducing missed relevant memories on short queries.
- Embedding cache database operations now run inside transactions with busy
  timeout, preventing partial writes under concurrent access.
- MCP transport now connects before embedding rebuild on startup.

## [0.3.2] - 2026-05-28

### Fixed

- **Weekly memory date enrichment now produces human-readable dates.** ISO week
  dates (e.g. `2026-W09`) were not parseable by the JavaScript `Date`
  constructor, causing the weekly branch to return the raw date string instead
  of "Week of February 23, 2026". The weekly parsing now runs before the general
  `Date` constructor check.

## [0.3.1] - 2026-05-28

### Fixed

- **`memory_list` MCP tool now passes `offset`, `beforeDate`, and `afterDate`
  parameters through to the handler.** These fields were defined in the input
  schema but dropped on the floor at the server dispatch layer, making date-
  filtered and paginated memory queries silently ignore all filtering.

### Changed

- **Memory embeddings now include a human-readable date prefix** (e.g. "Daily
  memory from February 14, 2026. [content]") so that temporal queries like "what
  happened last week" can match memories by date semantics. The enrichment
  algorithm is versioned — schema bumped to v2, and entity-core auto-rebuilds
  the embedding cache on startup when a version change is detected.
- **Memory search `minScore` lowered from 0.3 to 0.25** to improve recall for
  date-sensitive and indirect queries that previously fell just below the
  threshold.

## [0.3.0] - 2026-05-27

### Added

- **memory_embedding_purge:** MCP tool that removes orphaned embedding entries
  for deleted memory files from graph.db. Use after manual file deletion to
  prevent ghost search results.
- **memory_embedding_rebuild:** MCP tool that clears the entire memory embedding
  cache and re-embeds every memory file from scratch. Knowledge graph embeddings
  (`vec_graph_nodes`) are unaffected.

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

[0.4.3]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.4.3
[0.4.2]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.4.2
[0.4.1]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.4.1
[0.4.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.4.0
[0.3.6]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.3.6
[0.3.5]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.3.5
[0.3.3]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.3.3
[0.3.2]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.3.2
[0.3.1]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.3.1
[0.3.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.3.0
[0.2.6]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.6
[0.2.5]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.5
[0.2.4]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.4
[0.2.3]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.3
[0.2.2]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.2.2
[0.1.1]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.1.1
[0.1.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.1.0
