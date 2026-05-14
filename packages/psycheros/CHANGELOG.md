# Changelog

All notable changes to the Psycheros harness daemon are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/), and this package
follows [Semantic Versioning](https://semver.org/).

## [0.3.1] - 2026-05-14

### Fixed

- **Inactivity-pulse cooldown deadlock.** The inactivity cooldown used
  `getPulseStats().lastRunAt`, which returned the last completed run of any
  status (including `skipped`) — so the cooldown always saw a run from ~1 minute
  ago and blocked every real fire. The cooldown check now calls a dedicated
  `getLastSuccessfulPulseRunAt()` method that filters to successful runs only,
  while `getPulseStats()` continues to surface the most recent run regardless of
  status so the user-facing pulse UI shows real failures.

- **Entity import upload blocked by body-size cap.** The entity-data import
  endpoint wasn't whitelisted as an upload route, so it hit the 1 MB
  `MAX_REQUEST_BODY_SIZE` instead of the larger upload limit. Export zips for
  real companion entities (months/years of data) easily exceed that. The upload
  body-size limit is now `Infinity` — Psycheros is self-hosted software, so an
  artificial cap on user uploads doesn't protect against anything meaningful and
  just breaks large imports.

- **Entity import wrote all files to every identity/memory category.** JSZip's
  `folder().files` returns ALL entries in the zip, not just the subfolder's
  entries. The entity-core import handler relied on `folder.files` to scope
  identity files and memories to their correct category/granularity, so every
  file ended up in every directory. Fixed by iterating `zip.files` directly with
  a prefix check. Also fixed `syncIdentityToLocal` to clear stale files before
  writing so leftovers from a broken import don't persist.

- **Entity import crashed entity-core (stale DB handle).** The import handler
  replaced `graph.db` on disk with `Deno.writeFile`, which truncates the file
  in-place — any SQLite connection with the file open (entity-core's scheduler)
  saw a corrupted/empty DB. Now uses an atomic temp-file + rename. Also fixed
  `GraphStore.close()` to reset the `initialized` flag so `initialize()`
  actually re-runs, added `Scheduler.replaceDatabase()` for updating the handle,
  and made `Scheduler.tick()` catch synchronous errors instead of crashing the
  process. Post-import, Psycheros restarts the MCP subprocess so entity-core
  gets a fully clean state.

- **Vault export → import round-trip silently destroyed every vault document.**
  Three layered bugs: (1) the export query filtered to `scope = 'global'`,
  missing per-conversation docs; (2) the export reader built file paths from
  `projectRoot` instead of `dataRoot`, and `join(projectRoot, absolutePath)`
  concatenates rather than resolves — so the actual `.md` files were dropped
  from every export, with a silent `catch` hiding the `ENOENT`s; (3) the
  importer wrote restored files under `projectRoot/.psycheros/vault/` instead of
  `dataRoot/.psycheros/vault/`, putting them in the wrong location whenever
  `PSYCHEROS_DATA_DIR` differed from the source root. Because the importer wipes
  the destination vault before restoring, a round-trip on a populated vault
  produced an empty vault. All three are fixed: the exporter now iterates every
  scope and bundles file content via `dataRoot`, with a tolerant `isAbsolute()`
  branch that handles both legacy absolute paths (stored by the seeder and
  upload code) and the relative paths the importer writes. Full DB metadata is
  preserved in `vault-metadata.json` so scope and conversation association
  round-trip too. The importer now writes to `dataRoot`.
  `VaultManager.rowToDocument` resolves `file_path` to absolute on read so every
  consumer of `VaultDocument.filePath` sees a path it can pass straight to
  `Deno.readFile`. Generated-image export/import paths had the same
  `projectRoot` mistake and are corrected in the same pass.

## [0.3.0] - 2026-05-14

### Added

- **`PSYCHEROS_DATA_DIR` env var.** Lets a launcher or container point runtime
  state at a stable location independent of where the source bundle lives. When
  set, `.psycheros/`, `identity/`, `.snapshots/`, `memories/`, `custom-tools/`,
  and `backgrounds/` all resolve relative to this path instead of `Deno.cwd()`.
  Non-breaking: when unset, paths resolve exactly as before. Templates and other
  source-relative reads still resolve against the source root. The companion
  `PSYCHEROS_ENTITY_CORE_DATA_DIR` is unchanged. See
  [`docs/configuration.md`](docs/configuration.md) for details. This unblocks
  the desktop launcher v2 work (Tauri app + persistent daemon) — see
  `packages/launcher-v2/`.

### Changed

- **Internal: `projectRoot` split into `projectRoot` + `dataRoot`** in
  `ServerConfig`, `EntityConfig`, `PulseEngineConfig`, and `RouteContext`.
  Source-relative reads (templates, `web/` static, `lib/` extensions) stay on
  `projectRoot`; user-mutable state reads/writes go through `dataRoot`. No
  public surface area changed — env var defaults preserve byte-identical
  behaviour when `PSYCHEROS_DATA_DIR` is unset.

- **Durable scheduler replaces `Deno.cron` everywhere.** Every scheduled or
  event-triggered task — daily memory summarization, identity snapshots, MCP
  identity-change pushes, every flavour of Pulse trigger — now routes through a
  shared `@psycheros/scheduler` workspace package backed by two SQLite tables
  (`schedules` + `job_runs`). Cron fires missed while the daemon was down are
  caught up on next boot per each schedule's catch-up policy; in-flight runs at
  crash are reclaimed instead of orphaned; identity-write pushes survive process
  death via a durable queue; long-running handlers (LLM streams, multi-step
  summarization) keep their leases auto-renewed.
- **Pulse run statistics are derived from `job_runs`, not stored on `pulses`.**
  The `pulses` table no longer carries `success_count`, `error_count`,
  `last_run_at`, or `last_status` — these are computed on demand via
  `DBClient.getPulseStats()`. Existing data is preserved through a one-time
  migration on first boot.
- **`Deno.cron` flag retired.** The `--unstable-cron` flag is no longer required
  in `deno.json` tasks, the Dockerfile, the `.env.example`, or the
  `PSYCHEROS_MCP_ARGS` default. Existing overrides that still pass it are
  harmless but unused.

### Removed

- `src/server/cron-tracker.ts` and the legacy `cron_job_runs` / `pulse_runs`
  tables. The first-boot schema migration folds every legacy row into `job_runs`
  and drops both tables.

### Migration

This release performs a one-shot SQLite migration on first boot:

- `cron_job_runs` rows fold into `job_runs` as their respective handlers
  (`memory.summarize-daily`, `identity.snapshot`), then the table is dropped.
- `pulse_runs` rows fold into `job_runs` as `pulse.execute`, with pulse context
  preserved in `payload`. Any row left in `running` state from a previous
  process is marked `dead` with a reclaim explanation. The legacy table is
  dropped.
- The `pulses` table is rebuilt in place to remove the four denormalized
  run-stat columns; every other column and every row is preserved.

Migration is idempotent — safe to run on a DB that's already been migrated.

## [0.2.0] - 2026-05-13

### Added

- Version chip in the chat header (lower-right). Clicks through to the GitHub
  release page for the running version; staging builds render the chip
  non-interactive with a `· staging` flavor and the full sha in the tooltip.
- `/health` now returns identity + version JSON (`name`, `version`,
  `version_base`, `version_suffix`, `is_staging`, `entity_core_version`,
  `started_at`). Container `HEALTHCHECK` still only reads `r.ok`.
- Admin "Versions" section in the diagnostics dashboard, showing psycheros,
  entity-core, and sqlite-vec versions side by side. Copy-as-markdown export
  includes the same block.
- Service worker cache key now stamps the running version
  (`psycheros-offline-<safe-version>`), evicting stale offline assets on every
  upgrade instead of forever pinning the v2 cache.
- Container image carries `org.opencontainers.image.version` LABEL matching the
  running version (visible in `docker inspect` and the GHCR sidebar).

### Fixed

- Startup banner version no longer shows hardcoded `0.1.0` regardless of the
  actual release. `src/version.ts` is now the source of truth for the running
  version, sourced from `deno.json` via a JSON import.

## [0.1.2] - 2026-05-13

### Fixed

- `getMessagesPaginated`: scroll-back no longer jumps to the oldest message when
  loading earlier history.

## [0.1.1] - 2026-05-13

### Fixed

- First-run setup for `ZAI_API_KEY`-only deployments. The seeded default LLM
  profile previously pointed at OpenRouter under a "Custom Endpoint" label, so
  the Z.ai key failed auth on first message. The seeded profile now resolves
  correctly to Z.ai (provider `zai`, base URL
  `https://api.z.ai/api/coding/paas/v4/chat/completions`, model `glm-4.7`). No
  data migration; existing volumes (`psycheros-data`, `entity-core-data`) and
  saved LLM profiles carry over unchanged.

### Changed

- `README.md` Essential environment table: `PSYCHEROS_MCP_ENABLED` documented
  default corrected to `true` (matches `.env.example` and runtime).

## [0.1.0] - 2026-05-13

### Added

- Initial public release.
- Persistent AI entity served through a web chat UI on port 3000.
- Streaming LLM, tool execution, RAG.
- Hierarchical memory (daily → weekly → monthly → yearly summaries).
- Knowledge graph (people, places, relationships) backed by SQLite + sqlite-vec.
- Lorebook, data vault, autonomous Pulse triggers.
- Discord gateway, image generation, image captioning.
- Entity identity and memory served by the sibling `entity-core` MCP server,
  spawned as a subprocess when `PSYCHEROS_MCP_ENABLED=true`.

[0.1.2]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.1.2
[0.1.1]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.1.1
[0.1.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.1.0
