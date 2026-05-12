---
title: "API Reference"
---

## Dual SSE Architecture

Two SSE channels serve different purposes:

### Per-Request Stream (`POST /api/chat`)

Opened per chat request, closes when the response is complete. If the user
switches conversations mid-stream, the client stops rendering but continues
draining the stream so the server finishes processing and persists the full
response. The explicit Stop button (double-tap) still aborts and prevents
persistence.

Event flow:
`message_id (user) → context → thinking → content → tool_call → tool_result → image_generated → metrics → done → message_id (assistant)`

Also emits `dom_update` events for UI changes triggered by tool execution, and
`status` events for retry notifications and errors. The `message_id` event
assigns database IDs to streaming-created DOM elements, enabling edit buttons
without a page refresh.

### Retry Stream (`POST /api/chat/retry`)

Same SSE format as `POST /api/chat`, but re-attempts the last user message
without re-persisting it. Used by the Retry button shown when a turn fails with
no assistant content. The server retrieves the last user message from the
database and passes `{ retry: true }` to the entity loop, which skips user
message insertion and avoids double-appending the message to the LLM context.

### Persistent Channel (`GET /api/events`)

Opened on page load, stays open indefinitely. Server can push events at any
time.

Used for: auto-title updates, background operations, and any UI changes that
happen outside of a chat request.

Managed by `EventBroadcaster` singleton in `src/server/broadcaster.ts`.

## API Endpoints

### App

| Method | Path           | Description             |
| ------ | -------------- | ----------------------- |
| `GET`  | `/`            | App shell HTML          |
| `GET`  | `/c/:id`       | Conversation page       |
| `GET`  | `/health`      | Health check endpoint   |
| `GET`  | `/api/events`  | Persistent SSE channel  |
| `GET`  | `/fragments/*` | HTML fragments for HTMX |

### Chat

| Method | Path              | Description                                                |
| ------ | ----------------- | ---------------------------------------------------------- |
| `POST` | `/api/chat`       | Send message, stream response (SSE)                        |
| `POST` | `/api/chat/retry` | Retry failed turn without re-persisting user message (SSE) |

Chat request body:
`{ "conversationId": string, "message": string, "attachmentId"?: string, "deviceType"?: "desktop"|"mobile" }`.
The `deviceType` field is used by the Situational Awareness system.

### Conversations

| Method   | Path                                        | Description                                          |
| -------- | ------------------------------------------- | ---------------------------------------------------- |
| `GET`    | `/api/conversations`                        | List conversations                                   |
| `POST`   | `/api/conversations`                        | Create conversation                                  |
| `GET`    | `/api/conversations/:id/messages`           | Get messages                                         |
| `GET`    | `/api/conversations/:id/messages/paginated` | Get paginated messages (query: `before`, `limit`)    |
| `GET`    | `/api/conversations/:id/context`            | Get all context snapshots                            |
| `GET`    | `/api/conversations/:id/context/latest`     | Get latest context snapshot                          |
| `PATCH`  | `/api/conversations/:id/title`              | Update title (auto-deduplicates with numeric suffix) |
| `DELETE` | `/api/conversations/:id`                    | Delete conversation                                  |
| `DELETE` | `/api/conversations`                        | Batch delete conversations                           |

### Messages

| Method | Path                | Description            |
| ------ | ------------------- | ---------------------- |
| `PUT`  | `/api/messages/:id` | Update message content |

### Memory

| Method   | Path                                   | Description                                                              |
| -------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `POST`   | `/api/memory/consolidate/:granularity` | Trigger memory consolidation                                             |
| `POST`   | `/api/memories/consolidation/run`      | Run catch-up consolidation for all missed periods                        |
| `POST`   | `/api/memories/:granularity/:date`     | Save edited memory (writes local file, pushes MCP update, reindexes RAG) |
| `POST`   | `/api/memories/significant/create`     | Create new significant memory                                            |
| `DELETE` | `/api/memories/significant/:filename`  | Delete a significant memory (removes file, clears RAG index)             |

### Identity / Core Prompts

| Method   | Path                                | Description                 |
| -------- | ----------------------------------- | --------------------------- |
| `POST`   | `/api/settings/file/:dir/:filename` | Save core prompt file       |
| `POST`   | `/api/settings/custom`              | Create custom identity file |
| `DELETE` | `/api/settings/custom/:filename`    | Delete custom identity file |

### Entity Core

| Method | Path                                      | Description                                                  |
| ------ | ----------------------------------------- | ------------------------------------------------------------ |
| `POST` | `/api/entity-core/consolidation/run`      | Run catch-up memory consolidation (delegates to entity-core) |
| `POST` | `/api/entity-core/sync`                   | Manually trigger identity pull then push sync                |
| `POST` | `/api/entity-core/actions/embed-memories` | Run embed-existing-memories script in entity-core            |

### Snapshots

| Method | Path                         | Description                   |
| ------ | ---------------------------- | ----------------------------- |
| `GET`  | `/api/snapshots`             | List snapshots (requires MCP) |
| `POST` | `/api/snapshots/create`      | Create manual snapshot        |
| `POST` | `/api/snapshots/:id/restore` | Restore from snapshot         |

### Lorebooks

| Method   | Path                                   | Description                                       |
| -------- | -------------------------------------- | ------------------------------------------------- |
| `GET`    | `/api/lorebooks`                       | List all lorebooks                                |
| `POST`   | `/api/lorebooks`                       | Create new lorebook                               |
| `GET`    | `/api/lorebooks/:id`                   | Get specific lorebook                             |
| `PUT`    | `/api/lorebooks/:id`                   | Update lorebook                                   |
| `DELETE` | `/api/lorebooks/:id`                   | Delete lorebook                                   |
| `GET`    | `/api/lorebooks/:id/entries`           | List lorebook entries                             |
| `POST`   | `/api/lorebooks/:id/entries`           | Create lorebook entry                             |
| `PUT`    | `/api/lorebooks/:id/entries/:entryId`  | Update lorebook entry                             |
| `DELETE` | `/api/lorebooks/:id/entries/:entryId`  | Delete lorebook entry                             |
| `DELETE` | `/api/lorebooks/state/:conversationId` | Reset lorebook state                              |
| `POST`   | `/api/lorebooks/import-sillytavern`    | Import SillyTavern lorebook (multipart JSON file) |

### Knowledge Graph

| Method   | Path                   | Description                                    |
| -------- | ---------------------- | ---------------------------------------------- |
| `GET`    | `/api/graph`           | Get full knowledge graph (nodes, edges, stats) |
| `POST`   | `/api/graph/nodes`     | Create graph node (auto-generates embedding)   |
| `POST`   | `/api/graph/edges`     | Create graph edge                              |
| `PUT`    | `/api/graph/nodes/:id` | Update graph node (re-generates embedding)     |
| `PUT`    | `/api/graph/edges/:id` | Update graph edge                              |
| `DELETE` | `/api/graph/nodes/:id` | Delete graph node (cascades to edges)          |
| `DELETE` | `/api/graph/edges/:id` | Delete graph edge                              |

### Backgrounds

| Method   | Path                         | Description                 |
| -------- | ---------------------------- | --------------------------- |
| `GET`    | `/api/backgrounds`           | List uploaded backgrounds   |
| `POST`   | `/api/backgrounds`           | Upload background image     |
| `DELETE` | `/api/backgrounds/:filename` | Delete background image     |
| `GET`    | `/backgrounds/:filename`     | Serve background image file |

### Appearance Settings

| Method | Path                       | Description                     |
| ------ | -------------------------- | ------------------------------- |
| `GET`  | `/api/appearance-settings` | Get current appearance settings |
| `POST` | `/api/appearance-settings` | Save appearance settings        |

Settings stored in `.psycheros/appearance-settings.json`. Shape:
`{ "preset": string|null, "customAccent": string|null, "bgImage": string|null, "bgBlur": number, "bgOverlayOpacity": number, "glassEnabled": boolean }`.
Defaults to violet preset with no background.

### Data Vault

| Method   | Path                | Description                                               |
| -------- | ------------------- | --------------------------------------------------------- |
| `GET`    | `/api/vault`        | List vault documents                                      |
| `POST`   | `/api/vault`        | Upload vault document (multipart: document, title, scope) |
| `GET`    | `/api/vault/:id`    | Get vault document metadata                               |
| `PUT`    | `/api/vault/:id`    | Update vault document title/content                       |
| `DELETE` | `/api/vault/:id`    | Delete vault document                                     |
| `POST`   | `/api/vault/search` | Search vault by query                                     |

### General Settings

| Method | Path                    | Description                                   |
| ------ | ----------------------- | --------------------------------------------- |
| `GET`  | `/api/general-settings` | Get general settings (entity name, user name) |
| `POST` | `/api/general-settings` | Save general settings                         |

Settings stored in `.psycheros/general-settings.json`. Defaults:
`{ "entityName": "Assistant", "userName": "You" }`.

### Situational Awareness Settings

| Method | Path               | Description             |
| ------ | ------------------ | ----------------------- |
| `GET`  | `/api/sa-settings` | Get current SA settings |
| `POST` | `/api/sa-settings` | Save SA settings        |

Settings stored in `.psycheros/sa-settings.json`. Shape:
`{ "enabled": boolean }`. Defaults to `{ "enabled": true }`. When enabled, the
entity receives a `<situational_awareness>` XML block in its system message each
turn containing the current conversation, last user message (cross-conversation,
excluding Pulses), user device type, and connected devices (Lovense, Intiface,
home).

### LLM Settings (Multi-Provider Profiles)

| Method | Path                           | Description                                                          |
| ------ | ------------------------------ | -------------------------------------------------------------------- |
| `GET`  | `/api/llm-settings`            | Get all profiles and active ID (API keys masked)                     |
| `POST` | `/api/llm-settings`            | Bulk save (used by delete operations)                                |
| `POST` | `/api/llm-settings/profile`    | Add or update a single profile (server-side merge)                   |
| `POST` | `/api/llm-settings/set-active` | Set active profile by ID (triggers entity-core restart if connected) |
| `POST` | `/api/llm-settings/reset`      | Reset to environment variable defaults                               |
| `POST` | `/api/llm-settings/test`       | Test connection for a profile (accepts partial profile)              |
| `GET`  | `/fragments/settings/llm`      | Hub view (card grid of all profiles)                                 |
| `GET`  | `/fragments/settings/llm/new`  | New profile edit form                                                |
| `GET`  | `/fragments/settings/llm/:id`  | Edit existing profile form                                           |

### Web Search Settings

| Method | Path                             | Description                                       |
| ------ | -------------------------------- | ------------------------------------------------- |
| `GET`  | `/api/web-search-settings`       | Get current web search settings (API keys masked) |
| `POST` | `/api/web-search-settings`       | Save web search settings                          |
| `POST` | `/api/web-search-settings/reset` | Reset to environment variable defaults            |

### Discord Settings

| Method | Path                          | Description                                     |
| ------ | ----------------------------- | ----------------------------------------------- |
| `GET`  | `/api/discord-settings`       | Get current Discord settings (bot token masked) |
| `POST` | `/api/discord-settings`       | Save Discord settings                           |
| `POST` | `/api/discord-settings/reset` | Reset to environment variable defaults          |

Settings stored in `.psycheros/discord-settings.json`. Shape:
`{ "enabled": boolean, "botToken": string, "defaultChannelId": string }`.

### Home Settings

| Method | Path                 | Description                                            |
| ------ | -------------------- | ------------------------------------------------------ |
| `GET`  | `/api/home-settings` | Get current home device settings                       |
| `POST` | `/api/home-settings` | Save home device settings and hot-reload tool registry |

Settings stored in `.psycheros/home-settings.json`. Shape:
`{ "devices": Array<{ name: string, type: string, address: string, enabled: boolean }> }`.
The `control_device` tool is auto-enabled when any device has `enabled: true`.

### Lovense Settings

| Method | Path                         | Description                                                                        |
| ------ | ---------------------------- | ---------------------------------------------------------------------------------- |
| `GET`  | `/api/lovense-settings`      | Get current Lovense connection settings                                            |
| `POST` | `/api/lovense-settings`      | Save Lovense settings and hot-reload tool registry                                 |
| `POST` | `/api/lovense-settings/test` | Test connection to Lovense Connect bridge, returns connected toys                  |
| `GET`  | `/api/lovense-status`        | Quick connection check for header icon (3s timeout), returns `{ connected, toy? }` |

Settings stored in `.psycheros/lovense-settings.json`. Shape:
`{ "enabled": boolean, "connection": { "domain": string, "port": number, "secure": boolean } }`.
Supports two modes: LAN Mode (port 20010, HTTP) and Game Mode (port 34568 mobile
/ 30010 PC, HTTPS). Domain format: `192-168-X-X.lovense.club` (dashes, not
dots). The `control_lovense` tool is auto-enabled when `enabled: true` and
domain is set. Settings page auto-reloads after save.

### Buttplug (Universal) Settings

| Method | Path                          | Description                                                                                          |
| ------ | ----------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/buttplug-settings`      | Get current Buttplug/WebSocket settings                                                              |
| `POST` | `/api/buttplug-settings`      | Save Buttplug settings and hot-reload tool registry                                                  |
| `POST` | `/api/buttplug-settings/test` | Test connection to Intiface Central, returns discovered devices                                      |
| `GET`  | `/api/buttplug-status`        | Quick connection check for header icon (2s timeout), returns `{ connected, deviceCount?, devices? }` |

Settings stored in `.psycheros/buttplug-settings.json`. Shape:
`{ "enabled": boolean, "websocketUrl": string }`. Connects to Intiface Central
over WebSocket (default `ws://127.0.0.1:12345`). The `control_toy` tool is
auto-enabled when `enabled: true`. Both Lovense and Buttplug status are polled
for the intimacy heart icon in the header.

### Image Gen Settings

| Method | Path                            | Description                                                |
| ------ | ------------------------------- | ---------------------------------------------------------- |
| `GET`  | `/api/image-gen-settings`       | Get current image generator settings (API keys masked)     |
| `POST` | `/api/image-gen-settings`       | Save image generator settings and hot-reload tool registry |
| `POST` | `/api/image-gen-settings/reset` | Reset to defaults (empty generators list)                  |

Settings stored in `.psycheros/image-gen-settings.json`. Shape:
`{ "generators": Array<ImageGenConfig>, "captioning": CaptioningSettings }`
where each generator config has id, name, description, enabled, nsfw, provider
(openrouter/gemini), and provider-specific settings (API keys, model, etc.).
Captioning settings have `enabled`, `provider` (gemini/openrouter), and
provider-specific settings (API key, model). The `generate_image` tool is
auto-enabled when any generator has `enabled: true`. The `describe_image` tool
is auto-enabled when captioning has a provider configured.

The `POST` handler supports partial updates: if the body contains only a
`captioning` field (no `generators`), only the captioning settings are merged
into existing settings. This prevents the common pattern of fetching masked
settings and writing them back from corrupting API keys.

### Anchor Images

| Method   | Path                     | Description                                                               |
| -------- | ------------------------ | ------------------------------------------------------------------------- |
| `GET`    | `/api/anchor-images`     | List all anchor images (metadata from DB)                                 |
| `POST`   | `/api/anchor-images`     | Upload anchor image (multipart: image file, label, description; max 10MB) |
| `PATCH`  | `/api/anchor-images/:id` | Update anchor image label/description                                     |
| `DELETE` | `/api/anchor-images/:id` | Delete anchor image (file + DB row)                                       |

Anchor images are stored in `.psycheros/anchors/` with metadata in the
`anchor_images` SQLite table. Used as style/character references by the
`generate_image` tool.

### Gallery Images

| Method | Path                  | Description                                                               |
| ------ | --------------------- | ------------------------------------------------------------------------- |
| `GET`  | `/api/gallery/images` | List all gallery images with pagination (`?offset=N&limit=N`, default 24) |

Scans `.psycheros/generated-images/` and `.psycheros/chat-attachments/`
directories, cross-references with the `messages` table for metadata (prompt,
generator, description for generated images; upload date for all). Returns JSON
with `{ totalSize, generatedCount, userCount, total, hasMore, images[] }`.
Anchor images are excluded (managed in their own tab). View-only — no delete
endpoint.

### Chat Attachments

| Method | Path                          | Description                                                             |
| ------ | ----------------------------- | ----------------------------------------------------------------------- |
| `POST` | `/api/chat-attachments`       | Upload image attachment for chat (multipart: attachment file; max 10MB) |
| `GET`  | `/chat-attachments/:filename` | Serve chat attachment image file                                        |

Attachments are stored in `.psycheros/chat-attachments/`. The chat request body
includes an optional `attachmentId` field; if provided and captioning is
configured, the attachment is auto-captioned via the configured vision model and
prefixed to the user message as
`[USER_IMAGE: /chat-attachments/filename | Caption: description]`. If captioning
fails or is not configured, falls back to
`[USER_IMAGE: /chat-attachments/filename]`.

### Generated Images

| Method | Path                          | Description                  |
| ------ | ----------------------------- | ---------------------------- |
| `GET`  | `/generated-images/:filename` | Serve a generated image file |
| `GET`  | `/anchors/:filename`          | Serve an anchor image file   |

### Tools Settings

| Method | Path                       | Description                                                                                                                        |
| ------ | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/api/tools-settings`      | Get all tools metadata, categories, current overrides, and custom tool names                                                       |
| `POST` | `/api/tools-settings`      | Save tool overrides and hot-reload registry (`{ "toolOverrides": { "shell": true, ... } }`)                                        |
| `POST` | `/api/custom-tools/upload` | Upload a custom tool `.js` file (multipart/form-data, field `tool`, max 100KB); writes to `custom-tools/` and hot-reloads registry |

Settings stored in `.psycheros/tools-settings.json`. Shape:
`{ "toolOverrides": Record<string, boolean> }`. When this file exists, overrides
take precedence over `PSYCHEROS_TOOLS` env var.

The custom tools upload endpoint accepts a `multipart/form-data` request with a
`tool` field containing the `.js` file. On success, the file is written to
`custom-tools/<filename>` and the custom tool registry is reloaded. Returns
`{ "success": true, "toolName": "..." }` or
`{ "success": false, "error": "..." }`.

### MCP

| Method | Path            | Description               |
| ------ | --------------- | ------------------------- |
| `POST` | `/api/mcp/sync` | Manually trigger MCP sync |

### System Admin

| Method | Path                                              | Description                                                                                                                                          |
| ------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/fragments/admin`                                | Admin hub with tab navigation                                                                                                                        |
| `GET`  | `/fragments/admin/diagnostics`                    | Diagnostics dashboard HTML fragment                                                                                                                  |
| `GET`  | `/fragments/admin/logs`                           | Log viewer HTML fragment                                                                                                                             |
| `GET`  | `/fragments/admin/jobs`                           | Scheduled jobs dashboard HTML fragment                                                                                                               |
| `GET`  | `/fragments/admin/actions`                        | Actions panel HTML fragment                                                                                                                          |
| `GET`  | `/fragments/settings/connections`                 | External connections hub (Channels, Home, Web Search tabs)                                                                                           |
| `GET`  | `/fragments/settings/connections/discord`         | Discord connection settings fragment                                                                                                                 |
| `GET`  | `/fragments/settings/connections/home`            | Home automation settings fragment                                                                                                                    |
| `GET`  | `/fragments/settings/vision`                      | Vision settings hub (Generators, Anchors, Gallery tabs)                                                                                              |
| `GET`  | `/fragments/settings/vision/generators`           | Generators tab content (HTMX fragment)                                                                                                               |
| `GET`  | `/fragments/settings/vision/anchors`              | Anchors tab content (HTMX fragment)                                                                                                                  |
| `GET`  | `/fragments/settings/vision/gallery`              | Gallery tab content (HTMX fragment, server-rendered)                                                                                                 |
| `GET`  | `/fragments/settings/vision/image-gen/new`        | New image generator config fragment                                                                                                                  |
| `GET`  | `/fragments/settings/vision/image-gen/:id`        | Edit image generator config fragment                                                                                                                 |
| `GET`  | `/fragments/settings/tools`                       | Tools settings UI fragment                                                                                                                           |
| `GET`  | `/fragments/settings/sa`                          | Situational Awareness settings fragment                                                                                                              |
| `GET`  | `/fragments/settings/vault`                       | Data Vault management fragment                                                                                                                       |
| `GET`  | `/fragments/settings/vault/:id`                   | Vault document detail/edit fragment                                                                                                                  |
| `GET`  | `/fragments/settings/entity-core`                 | Entity Core hub with tab navigation                                                                                                                  |
| `GET`  | `/fragments/settings/entity-core/overview`        | Entity Core overview tab (ping-based connection status, graph stats, extraction pipeline health, sync)                                               |
| `GET`  | `/fragments/settings/entity-core/llm`             | Entity Core LLM settings tab                                                                                                                         |
| `GET`  | `/fragments/settings/entity-core/graph`           | Knowledge Graph visualization tab                                                                                                                    |
| `GET`  | `/fragments/settings/entity-core/maintenance`     | Entity Core maintenance tab (consolidation, batch populate, embed)                                                                                   |
| `GET`  | `/fragments/settings/entity-core/snapshots`       | Snapshot browser tab                                                                                                                                 |
| `GET`  | `/fragments/entity-core/snapshots/:id`            | Snapshot preview fragment                                                                                                                            |
| `GET`  | `/fragments/settings/memories`                    | Memories tabbed view fragment                                                                                                                        |
| `GET`  | `/fragments/settings/memories/search?q=`          | Search memories across all granularities (uses entity-core `memory_search`)                                                                          |
| `GET`  | `/fragments/settings/memories/:granularity`       | Memory file list fragment (daily/weekly/monthly/yearly/significant). Query params: `offset` (pagination), `before`, `after` (date range, YYYY-MM-DD) |
| `GET`  | `/fragments/settings/memories/:granularity/:date` | Memory editor fragment                                                                                                                               |
| `GET`  | `/api/admin/diagnostics`                          | JSON diagnostics snapshot (all subsystems)                                                                                                           |
| `GET`  | `/api/admin/logs`                                 | JSON log entries with filtering (`?level=`, `?component=`, `?limit=`, `?since=`)                                                                     |
| `GET`  | `/api/admin/logs/entries`                         | HTML partial of log entries (same query params as above)                                                                                             |
| `GET`  | `/api/admin/jobs`                                 | JSON scheduled jobs status                                                                                                                           |
| `GET`  | `/api/admin/jobs/rows`                            | HTML partial of job table rows                                                                                                                       |
| `POST` | `/api/admin/jobs/:id/trigger`                     | Manually trigger a scheduled job                                                                                                                     |
| `POST` | `/api/admin/actions/batch-populate`               | Run batch-populate-graph script (`{ days, granularity, dryRun, verbose }`)                                                                           |
| `POST` | `/api/admin/actions/add-instance-suffix`          | Add instance suffix to old memory files (`{ instanceId, apply, scopes }`)                                                                            |

### Pulse

| Method   | Path                                  | Description                                                        |
| -------- | ------------------------------------- | ------------------------------------------------------------------ |
| `GET`    | `/api/pulses`                         | List all pulses                                                    |
| `POST`   | `/api/pulses`                         | Create a new pulse (JSON body)                                     |
| `GET`    | `/api/pulses/:id`                     | Get single pulse                                                   |
| `PUT`    | `/api/pulses/:id`                     | Update a pulse                                                     |
| `DELETE` | `/api/pulses/:id`                     | Delete a pulse                                                     |
| `POST`   | `/api/pulses/:id/trigger`             | Manual trigger                                                     |
| `POST`   | `/api/pulses/:id/stop`                | Abort a running Pulse                                              |
| `GET`    | `/api/pulses/running/:conversationId` | Get pulse ID running for a conversation                            |
| `POST`   | `/api/webhook/pulse/:id`              | Webhook trigger (Bearer token auth)                                |
| `GET`    | `/api/pulses/runs`                    | List pulse runs (paginated, filterable by `?pulseId=`, `?status=`) |
| `GET`    | `/api/pulses/:id/runs`                | Runs for a specific pulse                                          |
| `GET`    | `/api/pulses/runs/:runId`             | Single run details                                                 |
| `GET`    | `/fragments/settings/pulse`           | Main tabbed Pulse view (Prompts + Execution Log)                   |
| `GET`    | `/fragments/settings/pulse/new`       | New Pulse editor                                                   |
| `GET`    | `/fragments/settings/pulse/:id/edit`  | Edit Pulse editor                                                  |
| `GET`    | `/fragments/settings/pulse/list`      | Prompt list partial (for HTMX reload)                              |
| `GET`    | `/fragments/settings/pulse/log`       | Execution log partial (paginated)                                  |

## Related Source Files

| File                            | Purpose                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/server/routes.ts`          | All API endpoint handlers                                                                                   |
| `src/server/admin-routes.ts`    | Admin panel route handlers                                                                                  |
| `src/server/admin-templates.ts` | Admin panel HTML rendering                                                                                  |
| `src/server/diagnostics.ts`     | Diagnostics snapshot aggregation                                                                            |
| `src/server/logger.ts`          | Log capture ring buffer                                                                                     |
| `src/server/sse.ts`             | SSE encoding utilities                                                                                      |
| `src/server/broadcaster.ts`     | Persistent SSE channel (EventBroadcaster)                                                                   |
| `src/server/state-changes.ts`   | Unified state mutations                                                                                     |
| `src/server/ui-updates.ts`      | Reactive DOM updates                                                                                        |
| `src/server/templates.ts`       | HTML rendering for fragments                                                                                |
| `src/tools/tools-settings.ts`   | Tool settings types, categories, persistence                                                                |
| `src/tools/custom-loader.ts`    | Dynamic custom tool loader                                                                                  |
| `src/pulse/engine.ts`           | Pulse scheduling and execution engine                                                                       |
| `src/pulse/routes.ts`           | Pulse CRUD and trigger API handlers                                                                         |
| `src/pulse/templates.ts`        | Pulse settings UI rendering                                                                                 |
| `src/llm/discord-settings.ts`   | Discord settings type, persistence, token masking                                                           |
| `src/llm/home-settings.ts`      | Home automation settings type, persistence                                                                  |
| `src/tools/control-device.ts`   | Home automation tool (Shelly Plug local HTTP API)                                                           |
| `src/llm/lovense-settings.ts`   | Lovense settings type, persistence, LAN/Game Mode config                                                    |
| `src/llm/buttplug-settings.ts`  | Universal toy control settings type, persistence, WebSocket URL config                                      |
| `src/tools/control-lovense.ts`  | Lovense device control tool (state-based patterns, speed, presets)                                          |
| `src/tools/control-buttplug.ts` | Universal toy control tool (`control_toy`, vibration/rotation/position/oscillate/constrict, pattern engine) |
| `src/llm/image-gen-settings.ts` | Image generator + captioning config type, persistence, API key masking                                      |
| `src/tools/generate-image.ts`   | Image generation tool (OpenRouter, Gemini), auto-captioning                                                 |
| `src/tools/describe-image.ts`   | Image captioning tool (Gemini, OpenRouter), shared caption logic                                            |
