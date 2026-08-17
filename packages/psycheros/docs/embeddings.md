# Embedding Model Configuration

Deep reference for the user-selectable embedding model: configuration surface,
rebuild orchestration, and the re-index flow. The load-bearing traps (the Xenova
cache override, the MCP ping-pause invariant) live in "Embedding model
configuration" in [`../CLAUDE.md`](../CLAUDE.md).

## Configuration surface

`src/embeddings/` is the configuration surface. Settings persist to
`.psycheros/embedding-settings.json` and propagate to entity-core via
`ENTITY_CORE_EMBEDDING_*` env vars at MCP spawn (same pattern as LLM settings).

Key files:

- `presets.ts` — curated model catalog (MiniLM, BGE-small/base, jina, nomic,
  mpnet) with metadata for the UI picker.
- `settings.ts` / `entity-core-embedding-settings.ts` — load/save.
- `entity-core-env.ts` — builds the env-var map pushed to entity-core.
- `download-manager.ts` — pre-fetches models with progress events. Tracks
  completed downloads in `.psycheros/downloaded-models.json`.
- `re-embed.ts` — orchestrator that drops/recreates psycheros vec tables,
  reindexes messages/memories/vault, and calls entity-core's
  `embedding_rebuild_all` MCP tool.

## Dynamic vec0 dimension

The vec0 dimension is dynamic: `src/db/schema.ts:getActiveEmbeddingDimension()`
reads from `app_metadata.active_embedding_dimension`, and all vec0 DDL sites
read via this getter at call time. The re-embed orchestrator calls
`setActiveEmbeddingDimension()` after a successful rebuild.

## Rebuild notification flow

entity-core sends `notifications/embedding-rebuild` notifications while
re-embedding (`started` / `progress` every 25 items / `done` / `failed` /
`model_change_detected`). `MCPClient` sets a `fallbackNotificationHandler`
**before** `client.connect()` and auto-pauses pings on `started`/`progress`,
resuming on `done`/`failed`.

Notifications are re-broadcast as `embedding_reindex` SSE events (suppressed
while the re-embed orchestrator runs — it emits its own from `onProgress`) and
drive the re-index banner (`#reindex-banner` in the app shell above `#chat`,
`web/js/reindex-banner.js`), which offers "Re-index now" →
`POST /api/embedding-settings/confirm-reembed` on `model_change_detected`.

Two watchdog safety nets in `src/mcp-client/mod.ts` back the ping pause: a
**spawn grace** (failed pings within 3 min of connect log "still starting"
instead of killing) and a **pause cap** (pings resume if no progress
notification for 60 min — the window refreshes on every progress event, so a
healthy multi-hour rebuild on a big companion DB is never cut down).

## Settings/index drift detection

The save endpoint persists the new model to the settings file **before** the
re-embed runs (the user confirms separately via `confirm-reembed`). If the
re-embed is never confirmed or fails mid-run, the settings file and the vec
tables end up at different dimensions — every retrieval path then fails with
dimension mismatches while chat keeps working. entity-core's
`model_change_detected` notification covers this, but it fires once at
entity-core boot and is dropped if no browser is connected, so two durable
checks back it up:

- `Server.init()` (`src/server/server.ts`) compares `resolveDimension(settings)`
  against `app_metadata.active_embedding_dimension` and logs a loud error at
  boot on mismatch.
- `checkEmbeddingSync()` in `web/js/psycheros.js` fetches
  `GET /api/embedding-settings` on every page load (the response carries both
  `resolvedDimension` and `actualDimension`) and renders the re-index banner
  when they differ.

## Settings UI

The UI lives in Settings > Model Settings > Embeddings. Tabs are `LLM Profiles`
and `Embeddings`; the shell is `renderModelSettingsShell()` in
`src/server/templates.ts`. HTMX swaps the whole tab content, so the fragment
ends with an inline `<script>` that calls `globalThis.initEmbeddingsTab()` to
seed the recommended-chunk-size hint — `DOMContentLoaded` fires too early
(before the swap).
