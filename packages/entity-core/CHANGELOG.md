# Changelog

All notable changes to entity-core are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this package follows
[Semantic Versioning](https://semver.org/).

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

[0.1.1]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.1.1
[0.1.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.1.0
