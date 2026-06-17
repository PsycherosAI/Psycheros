# Changelog

All notable changes to the Psycheros harness daemon are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/), and this package
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.8.0] - 2026-06-17

### Added

- **Voice chat subsystem.** Real-time voice conversations with the entity via a
  Deno-native walkie-talkie pipeline supporting custom TTS/STT providers,
  push-to-talk (configurable keybinds, hold-to-talk, global hotkey), screen wake
  lock during calls, voice effects, and a "Yin Yang" mode that lets you type
  instead of speaking mid-call. Includes a voice FAB in the chat panel, audio
  cues, interruption guard, and Pulses routed through the voice pipeline when a
  call is active.
- Venice AI and NanoGPT image generation providers. Both surface in Settings >
  Vision > Generators alongside the existing OpenRouter and Google AI Studio
  options. Venice uses the native `/v1/image/generate` endpoint and is
  text-to-image only (its inpaint parameter was deprecated May 2025); when the
  entity passes `anchor_ids`/`user_image_path`/`input_image_path` to a Venice
  generator, the request proceeds as text-to-image and the tool result includes
  a note explaining the references were ignored. NanoGPT uses the
  OpenAI-compatible `/v1/images/generations` endpoint and supports image input
  via `imageDataUrl` (single) or `imageDataUrls` (plural, model-dependent).
- Each image generator's entry in the entity's image-gen context block now
  includes an anchor-capability tag (`accepts anchor images` or
  `text-to-image only (no anchor support)` for Venice) so the entity can pick
  the right generator when it needs image references.
- `is_voice` column on messages for authoritative voice attribution — messages
  spoken via voice chat are tagged at write time.

### Fixed

- Browser STT rapid-cycling on Chrome Android (cumulative-result snowballing);
  utterances now batch into full phrases with configurable debounce.
- Silent-audio CPU spin on desktop that caused browser-wide freezes.
- Post-TTS cooldown prevents echo transcription triggers.
- Voice display state now waits for audio playback to drain before advancing.
- Timezone handling and parroted `[Voice Chat]` prefix stripping in voice
  transcripts.
- Profanity restorations expanded for intimate use cases.

## [0.7.2] - 2026-06-10

### Fixed

- Pulse-spawned conversations now appear in the sidebar immediately. Previously
  the sidebar only updated if a tool run during the pulse happened to return
  `affectedRegions: ["conv-list"]`, making it hit-or-miss.
- The "Once at a specific time" datetime picker in the Pulse editor is now
  seeded with a default value when first shown. Desktop browsers (Chrome,
  Firefox) often fail to open the `datetime-local` picker when the field is
  empty, making the field appear unresponsive.

## [0.7.1] - 2026-06-10

### Fixed

- Custom tools are now stored under `.psycheros/custom-tools/` instead of a
  top-level `custom-tools/` directory. The old location was not covered by
  Docker volume mounts, so custom tools were lost on container rebuilds. On
  startup, any files in the legacy `custom-tools/` directory are automatically
  migrated to the new location.
- Tool registry is now reloaded after uploading or deleting a custom tool, so
  new tools appear immediately without a server restart.

## [0.7.0] - 2026-06-09

### Added

- `memory_recall` tool with two-phase design: search mode runs semantic and grep
  matching in parallel to return a compact hit list with titles and previews;
  read mode fetches specific memories in full. The entity only pulls full
  content for memories it actually needs.

## [0.6.2] - 2026-06-09

### Fixed

- Reverted persist-before-yield tool result ordering. Tool results are now
  yielded to the SSE client before DB persistence, restoring the original
  stream-first behavior.

## [0.6.1] - 2026-06-09

### Changed

- Code formatting normalized across wearable modules and documentation.

## [0.6.0] - 2026-06-09

### Added

- Wearable data pipeline for entity-plexus sensor ingestion with live connection
  management and data caching.
- BLE device management UI with live status polling, XML validation, and device
  command interface.
- Event rules engine with webhook UI — define event-triggered actions in SA
  settings.
- `/api/ingest` routes for Authelia-gated wearable data access.
- Configurable wearable stream injection into SA context.
- Restore Conversations feature in Entity Data tab for browsing and recovering
  archived conversations.

### Fixed

- Tool results now persist to the database before SSE yield, preventing orphaned
  tool calls when the connection drops mid-stream.
- GPT-5.x models (including 5.5) now correctly strip all sampling parameters
  (temperature, top_p, frequency/presence penalty) before sending requests.
- Custom tool import/delete UI now correctly persists state across page loads.
- Inline wearable scripts moved to `psycheros.js` for proper caching and
  maintainability.

## [0.5.4] - 2026-06-04

### Added

- `POST /api/device/command` endpoint for sending commands to connected BLE
  devices through the Device Bridge. Generic endpoint for external callers
  (Android apps, scripts, custom tools) to route commands by device ID. Returns
  `{ success, data?, error? }` with appropriate HTTP status codes (503 if device
  disconnected, 400 for invalid input, 502 for bridge errors).

## [0.5.3] - 2026-06-03

### Fixed

- Sampling-parameter filter now silently skips zero-value defaults (`topK=0`,
  `frequencyPenalty=0`, `presencePenalty=0`) instead of logging spurious
  "stripped" warnings. Non-zero unsupported values still warn as before.

## [0.5.2] - 2026-06-03

### Added

- BLE Device Bridge: bidirectional WebSocket endpoint and built-in `ble_device`
  tool for communicating with BLE peripherals (smartwatches, sensors, etc.)
  through a browser or future Android app gateway. Supports multi-device
  routing, command/response correlation, and an inbound data buffer. Configured
  via External Connections > BLE Devices.

### Fixed

- Reverted Deno 2.8.0→2.7.14 to fix sqlite-vec breakage on Windows.

## [0.5.1] - 2026-06-02

### Fixed

- sqlite-vec extension now tracked per-connection instead of globally,
  preventing crashes when the extension loads late or fails.
- vec0 virtual table creation guarded on extension availability — graceful
  fallback instead of fatal error.
- Conversation import tagging no longer fails on a SQL quoting bug.
- Knowledge graph RAG context capped to 50 nodes to prevent token overflow.

### Changed

- Upgraded Deno runtime to 2.7.14 (stable).

## [0.5.0] - 2026-06-01

### Added

- Model-family detection and parameter filtering: unsupported sampling
  parameters (e.g. `temperature` on o-series models) are automatically stripped
  per-provider, with OpenRouter-specific headers injected.
- Export zip filename now includes the entity name for easier identification.

### Fixed

- Provider-aware reasoning parameters: reasoning effort and response parsing now
  adapt per-model-family instead of assuming OpenAI-shaped responses.
- MCP transport connects before embedding rebuild, preventing 60-second
  handshake timeouts on startup.
- Replaced jsdom with sanitize-html for markdown rendering, fixing V8 CodeRange
  OOM crashes on macOS Tahoe.

## [0.4.12] - 2026-05-29

### Changed

- Identity templates now auto-substitute `{{userName}}` from general settings at
  init time, alongside the existing `{{entityName}}`. User-facing template prose
  references the configured user name instead of generic "the user".
- Self-identity templates restructured with section headings for better
  organization (Identity, Appearance, Tone, Mannerisms, Humor, Wants, Goals,
  Personhood).
- `my_mechanics.md` streamlined — removes redundant technical detail, reframes
  the entity's stateless-LLM explanation as one organ in a distributed system.
- `base_instructions.md` simplified by removing `{{timestamp}}` and `{{chatId}}`
  (these are provided elsewhere in the system prompt).

## [0.4.11] - 2026-05-28

### Fixed

- **Inbound Discord DMs are now processed correctly.** The router's
  `flushBuffer` had a safety gate that skipped channels not found in the server
  config (to avoid processing channels removed between timer ticks). DM channels
  are never in the server config, so every inbound DM was silently dropped.
  Fixed by tracking DM channels in a dedicated set and exempting them from the
  config-removal check in `flushBuffer`, `onPeriodicFlush`, and `updateConfig`.
- **Adding a second LLM profile no longer replaces the first.** The profile ID
  was stored in a global variable (`window.__profileId`) set by a `<script>` tag
  in HTMX-swapped content. When HTMX didn't re-execute the script, the stale ID
  from a previous edit caused the server to update the existing profile instead
  of creating a new one. The ID is now stored in a hidden `<input>` field, which
  is always set correctly by the server-rendered HTML.
- **Discord gateway reconnect cascade on auth failure.** The gateway client
  retried on every close code including fatal ones (4004 auth failed, 4013/4014
  invalid intents). Each reconnect immediately failed and triggered another,
  creating a rapid reconnect loop. Non-retryable close codes are now tracked
  explicitly; `onerror` no longer schedules reconnects (the subsequent `onclose`
  handles the decision with the proper close code).
- **LLM no longer parrots `[IMAGE:]` markers or image metadata.** The entity
  loop now strips `[IMAGE:{...}]` markers and `[short:...]` metadata from
  assistant messages and tool results before persisting to the DB and feeding
  them back to the LLM. Previously these UI-only markers leaked into the
  conversation context, causing the LLM to echo them in its responses.

### Changed

- **Memory Consolidation removed from Entity Core > Maintenance UI.** Memory
  consolidation now runs automatically on startup, so the manual trigger has
  been removed from the maintenance tab. The code is commented out (not deleted)
  in case manual triggering is needed in the future.
- **Default sampling parameters for new profiles:** temperature changed from 0.7
  to 1, top-p changed from 1 to 0.95. These better match typical defaults for
  GLM models via OpenRouter.
- **Default model name for new profiles** changed from `glm-4.7` to
  `z-ai/glm-4.7` to match the OpenRouter model path format.
- **Natural pass guidance for DM conversations.** In direct-message contexts,
  the entity loop now injects guidance that DMs have natural rhythms — if the
  exchange has reached a natural endpoint, the entity can simply not call
  `act_in_discord` rather than forcing a response. Documented in the
  configuration reference.
- **Image description and generation tool results now fade over time.**
  `describe_image` and `generate_image` tool results are faded after the same
  threshold as inline image descriptions, keeping context lean in long
  conversations.

## [0.4.10] - 2026-05-27

### Fixed

- **Corrupted sqlite-vec virtual tables are now repaired automatically on
  startup.** If `vec_memory_chunks`, `vec_messages`, or `vec_vault_chunks` are
  corrupted (e.g. from a crash during write), the vector sync check now catches
  the error, drops and recreates the virtual table, and rebuilds from the
  backing regular tables. Previously the error was logged and vector search fell
  back to in-memory permanently until the user manually deleted the database.

## [0.4.9] - 2026-05-27

### Fixed

- **Health pings no longer kill entity-core during tool calls.** Entity-core is
  single-threaded over stdio JSON-RPC — while processing `sync_pull` (which
  reads hundreds of memory files on slow Windows machines), it can't respond to
  health pings. The ping timeout would fire, Psycheros would kill and restart
  entity-core, and the crash loop repeated before `sync_pull` ever finished. The
  MCP client now tracks active tool calls and suppresses the reconnect trigger
  while any call is pending. The tool call's own timeout still handles genuine
  hangs.

## [0.4.8] - 2026-05-27

### Fixed

- **MCP client timeouts no longer crash-loop entity-core on slow machines.** The
  default `toolCallTimeoutMs` was 30 s, too short for `sync_pull` on Windows
  machines with many memory files. Default raised to 60 s, with `sync_pull`
  using an explicit 300 s timeout.
- **Daily memory catch-up no longer creates duplicates after entity-loom
  imports.** `catchUpSummarization()` now queries entity-core for existing daily
  memories but only skips dates where the memory's `sourceInstance` matches
  Psycheros or `entity-loom` — memories from other embodiments (SillyTavern)
  don't block Psycheros from creating its own summary for the same date. Matched
  dates are recorded locally so re-checks don't repeat on every startup.

## [0.4.7] - 2026-05-27

### Added

- **Embedding maintenance tools.** Two new entity-core MCP tools
  (`memory_embedding_purge` and `memory_embedding_rebuild`) for managing the
  memory embedding cache. Purge removes orphaned entries left behind after
  manually deleting memory files; rebuild clears and re-embeds all memory files
  from scratch. Both are accessible from Settings > Entity Core > Maintenance in
  the web UI.

## [Unreleased]

## [0.4.6] - 2026-05-26

### Fixed

- Oversized single conversations in daily summarization (common in
  companion-style threads) are now recursively split by messages until each
  piece fits within the context budget, instead of being sent as a single
  oversized chunk.
- Entity-loom imported conversations are now excluded from daily summarization
  (entity-loom already handles memory extraction during its pipeline). A
  one-time DB migration retroactively tags existing imports by their
  `[platform]` title prefix, and the chat import endpoint sets the tag for new
  imports.

## [0.4.5] - 2026-05-26

### Fixed

- Daily memory summarizer now splits conversation-heavy days into multiple
  chunks that fit within the worker model's context window, instead of sending
  all content in a single request that exceeds the limit and crash-loops
  entity-core on startup catch-up.

## [0.4.4] - 2026-05-26

### Added

- "Upload File" button in Core Prompts UI for all categories (Self, User,
  Relationship, Custom). Lets users restore missing identity files without
  reinstalling. Writes through MCP so entity-core stays canonical.
  (`POST /api/settings/identity/upload`)

### Fixed

- **Entity Data Import no longer causes launcher port-conflict errors.** The
  import's heavy synchronous SQLite operations blocked the Deno event loop,
  making the `/health` endpoint unresponsive. The launcher detected this as a
  crash, kicked the user out, and showed a "Port 3000 is held" error. The import
  now yields to the event loop between phases so the server stays responsive
  throughout. The import also reports streaming progress via NDJSON so the user
  sees a progress bar with phase labels instead of a frozen "Importing..."
  message.

- **Knowledge Graph Import no longer crashes entity-core on Windows.** The
  import stops entity-core, writes directly to `graph.db`, then restarts it. The
  restart was calling `pull()` immediately, which raced with entity-core startup
  on Windows (slow file-handle cleanup) and caused a "Connection closed" error.
  The restart now skips the unnecessary identity pull and retries up to 3 times
  with backoff. The post-disconnect pause before writing to the database was
  also increased from 500 ms to 1.5 s for more reliable Windows file-handle
  release.

- **Memory "Load More" items now open correctly.** The load-more function used
  `insertAdjacentHTML` without telling HTMX about the new elements, so their
  `hx-get` click handlers were inert. Now calls `htmx.process()` on the appended
  items.
- **Core prompt files no longer disappear after editing one.** The identity sync
  (`syncIdentityToLocal`) previously deleted all local `.md` files before
  writing back what entity-core returned. On non-Docker installs, templates were
  seeded locally but never pushed to entity-core — so the first periodic sync
  after editing even one file would wipe every other prompt. The sync now only
  writes/updates files from the cache, leaving untouched files alone.
- **Significant memory delete now works.** The slug suffix was not being passed
  to entity-core's `memory_delete` tool, so the actual `{date}_{slug}.md` file
  was never found and the delete silently failed. The delete button also used
  HTMX's `hx-delete` with a JSON response that HTMX didn't reliably process; it
  now uses a plain JS `fetch()` call with list refresh, matching the working
  custom-file delete pattern.
- **Significant memory save no longer creates orphan files.** The
  `memory_update` handler now preserves the slug from the existing entry (or
  accepts it as an explicit argument), preventing it from writing to a bare
  `{date}.md` file that shadows the real `{date}_{slug}.md` on subsequent reads.
- **Significant memory list now shows unique entries.** Each significant memory
  uses `date_slug` as its list key, so multiple memories on the same date each
  get their own editor URL instead of all linking to the same one.

## [0.4.3] - 2026-05-24

### Fixed

- Core prompt files now populate correctly in Docker images. The `.dockerignore`
  pattern `**/identity` was too broad — it excluded `templates/identity/` from
  the build context, so neither `src/init/mod.ts` nor `entrypoint.sh` could find
  template files to seed. The same issue affected `templates/custom-tools/`.
  Both directories are now re-included with negation rules.

## [0.4.2] - 2026-05-23

### Fixed

- Chat history and knowledge graph data imports no longer fail on larger files
  due to the 1 MB request-body cap. The chat and graph migration endpoints are
  now whitelisted as upload routes alongside memories and entity data.

## [0.4.1] - 2026-05-23

### Fixed

- Z.ai default base URL updated to the correct public endpoint, fixing
  connection errors for new installs that rely on the seeded default profile.
- Base instructions template simplified to a concise identity + framework
  statement, giving entities a cleaner starting prompt.

## [0.4.0] - 2026-05-22

### Added

- **conversation_peek tool**: entities can now peek at messages in other active
  conversations for cross-conversation awareness, with configurable access
  controls.
- **Custom daily memory instructions**: new memory settings let the entity
  define recurring daily instructions that the memory summarizer incorporates
  during its nightly digest.
- **Custom instructions for intimacy device connections**: per-connection
  instruction templates for intimate hardware integrations, configurable from
  the External Connections settings.
- **Manual safety override for home automation devices**: a confirmation-gated
  override for device commands flagged by the safety filter, giving the entity
  controlled access when the user explicitly authorizes it.

### Fixed

- Lazy message loading now loads all older messages correctly. The cursor
  previously used only `created_at` with strict `<`, which could skip messages
  sharing the same timestamp. The cursor now also carries the message `id` as a
  tiebreaker (`beforeId` query param).
- Vault delete returns proper HTML for HTMX requests instead of raw JSON.
- Vault write no longer silently overwrites existing documents.
- OpenAI o-series and gpt-5.x models now use `max_completion_tokens` instead of
  the rejected `max_tokens` parameter, fixing connection tests and all LLM
  requests on newer models.
- Vault scope UI removed from settings; context book labels cleaned up.
- Multi-line blockquotes preserve line breaks instead of collapsing into a
  single line. Both server-side and client-side `marked` now use `breaks: true`.

## [0.3.3] - 2026-05-19

### Added

- **`act_in_discord` built-in tool.** Replaces the previous text-directive
  system (`[DISCORD_SEND_MESSAGE]`, `[DISCORD_ADD_REACTION]`, etc.) with a
  dedicated, fully-typed tool. Supports sending messages, adding and removing
  reactions (with Unicode emoji and shortcodes), typing indicators, and channel
  management — all through the standard tool interface instead of string
  parsing.

### Fixed

- Discord channel state now tears down cleanly when a channel toggle is turned
  off, instead of leaving stale listeners.
- Discord reactions accept any Unicode emoji, not just a hardcoded ASCII subset.
- Context inspector works correctly for Discord channel conversations (was
  showing stale or empty context).
- Channel auto-scroll restored after clearing Discord context.
- Entity-core MCP subprocess argv is built as a proper array instead of a
  space-joined string (fixes paths with spaces on Windows).
- Entity now knows its own Discord user ID and mention tag in channel context,
  so it can recognize when it's been pinged.
- Discord Hub channel picker no longer gets stuck on "Loading servers…" after
  navigating back from a channel view.
- Discord Hub channel picker shows a retry link after 10 seconds if servers
  haven't loaded.
- **Discord Hub sidebar toggle.** New "Show Discord Hub in Sidebar" toggle in
  Settings > External Connections > Discord (Connection section). Controls
  whether the Discord Hub entry appears in the Conversations sidebar. Defaults
  to on for existing installs. Changes take effect immediately on save.

### Changed

- Discord debounce default changed from 1s to 5s.
- **Active mode tier overhaul.** Fast tier now uses per-message debounce with a
  buffer-size limit (`fastBufferFlushSize`, default 10) instead of a periodic
  digest timer — the entity participates more naturally in rapid-fire channels.
  Medium tier retains its periodic digest for measured check-ins.
  `fastDigestIntervalMs` removed from tier config.
- Documentation refreshed for the new tool system, Discord features, and
  configuration options.

## [0.3.2] - 2026-05-14

### Changed

- **`@psycheros/scheduler` dissolved into psycheros's source tree.** The shared
  workspace package is gone. The scheduler now lives at `src/scheduler/` as
  internal source — no public API change for psycheros consumers, no schema
  change, no behavior change. The dissolve removes a workspace-level coupling
  that had grown vestigial: entity-core only used ~15% of the scheduler's
  surface (three hardcoded recurring fires) and has been migrated to a local
  `ConsolidationRunner` of its own. See entity-core's `[0.2.2]` entry.

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
  `https://api.z.ai/api/paas/v4/chat/completions`, model `glm-4.7`). No data
  migration; existing volumes (`psycheros-data`, `entity-core-data`) and saved
  LLM profiles carry over unchanged.

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

[0.4.1]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.4.1
[0.4.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.4.0
[0.3.3]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.3.3
[0.3.2]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.3.2
[0.1.2]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.1.2
[0.1.1]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.1.1
[0.1.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.1.0
[0.8.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.8.0
[0.7.2]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.7.2
[0.7.1]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.7.1
[0.7.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.7.0
[0.6.2]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.6.2
[0.6.1]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.6.1
[0.6.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.6.0
[0.5.4]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.5.4
[0.5.3]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.5.3
[0.5.2]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.5.2
[0.5.1]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.5.1
[0.5.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.5.0
[0.4.12]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.4.12
[0.4.11]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.4.11
[0.4.10]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.4.10
[0.4.9]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.4.9
[0.4.8]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.4.8
[0.4.7]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.4.7
[0.4.6]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.4.6
[0.4.5]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.4.5
[0.4.4]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.4.4
[0.4.3]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.4.3
[0.4.2]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.4.2
