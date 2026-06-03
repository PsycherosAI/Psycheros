# UI Features

Detailed documentation for Psycheros web UI features.

## Lazy Message Loading

Long conversations are paginated client-side to prevent typing lag on desktop.
When loading a conversation, only the most recent 50 messages are rendered. If
older messages exist, a sentinel element at the top of the messages container
triggers an `IntersectionObserver` (with 200px margin) to fetch the next batch
via `GET /api/conversations/:id/messages/paginated`.

**How it works:**

- Cursor-based pagination using `created_at` with message `id` as a tiebreaker
  for messages sharing the same timestamp — stable even when new messages arrive
  during scrolling
- Older messages are inserted after the sentinel element so the sentinel stays
  pinned at the top of the scroll container, with `scrollTop` adjusted to
  preserve the user's scroll position
- Loading is suppressed during active SSE streaming to avoid race conditions
- In-flight fetches are aborted via `AbortController` on conversation switch

**What's unaffected:**

- Entity loop (`src/entity/loop.ts`) still calls `db.getMessages()` for full LLM
  context
- Streaming and AutoScroll work as before — new messages append at the bottom
- Message editing works across lazily-loaded messages via `data-message-id`
  attributes

## Context Inspector

Built-in debugging tool for inspecting the full context sent to the LLM. Toggle
via the code icon (`</>`) in the header. The drawer panel uses
`env(safe-area-inset-top)` padding on its header to keep the close button
accessible below the iOS status bar on PWA installs.

## UI Component Patterns

Reference for correct usage of shared UI components. Follow these patterns when
building new settings pages or UI elements to avoid rendering bugs.

### Toggle Switch

The toggle switch uses CSS sibling selectors (`input:checked + .toggle-slider`)
which require a **flat structure** — the `<input>` and
`<span class="toggle-slider">` must be direct siblings inside
`<label class="toggle-label">`.

**Correct pattern (flat structure):**

```html
<label class="toggle-label">
  <input
    type="checkbox"
    id="my-toggle"
    role="switch"
    aria-label="Label Text"
    checked
  >
  <span class="toggle-slider"></span>
  <span class="toggle-text">Label Text</span>
</label>
```

**Incorrect pattern (nested label — breaks CSS selectors):**

```html
<label class="toggle-label" for="my-toggle">
  <span>Label Text</span>
  <label class="toggle">
    <input type="checkbox" id="my-toggle" checked>
    <span class="toggle-slider"></span>
  </label>
</label>
```

The nested `<label class="toggle">` wrapper breaks
`input:checked + .toggle-slider` because there's an extra element between the
input and the slider. This causes the accent color to not apply and the toggle
to visually disappear when checked. **Do not use this pattern.**

**CSS:** `web/css/settings.css` (`.toggle-label`, `.toggle-slider`,
`.toggle-text`). Used in: General Settings (Theme tab), LLM Settings, Tools
Settings, Vision Settings, Situational Awareness Settings.

## Context Inspector (continued)

**Architecture:** Context snapshots are persisted to the `context_snapshots`
database table on each turn. The inspector fetches data via
`GET /api/conversations/:id/context` — data survives page refresh and
conversation switching. Capped at 50 snapshots per conversation (auto-pruned on
insert).

**Turn Navigation:** Use the prev/next arrows to inspect any turn in the
conversation, not just the latest.

**Search:** Full-text search across all snapshot content with match
highlighting.

**Tabs:**

- **System**: Identity sections (self, user, relationship), situational
  awareness, and the full assembled system message as collapsible sections with
  size badges
- **RAG**: All five retrieval sources — memories, chat history, context book
  entries, data vault, knowledge graph
- **Messages**: Conversation history sent to the LLM with role badges and
  collapsible content
- **Tools**: Available tool definitions with parameters
- **Metrics**: Per-section size breakdown, token counts, context window
  utilization bar (reads `contextLength` from the active LLM profile — shows
  e.g. "128k", "200k" — and reports how many oldest messages were trimmed)

**Key types:** `LLMContextSnapshot` (in-memory, `src/types.ts`) and
`ContextSnapshotRecord` (persisted, `src/types.ts`). Snapshot built in
`EntityTurn.process()` (`src/entity/loop.ts`), persisted via
`DBClient.addContextSnapshot()`.

## Temporal Awareness

Every message includes an XML-tagged timestamp in the LLM context, enabling the
entity to understand when events occurred and time gaps between messages.

**Format**: `<t>YYYY-MM-DD HH:MM</t>`

XML tags are used so the LLM treats timestamps as structural metadata. These
tags are **stripped from rendered output** — the user never sees them. Instead,
timestamps are displayed as proper UI elements in message headers (drawn from
database `createdAt` metadata).

**LLM context example:**

```
[user]: <t>2026-03-03 14:22</t> Hey, what did you think about our conversation yesterday?
[assistant]: <t>2026-03-03 14:23</t> I enjoyed our discussion about...
[user]: <t>2026-03-05 15:17</t> Can you summarize what we talked about?
```

**Display timestamps**: Shown in `.msg-header` as `msg-timestamp` elements.
Time-only for today ("3:42 PM"), date + time for older messages ("Mar 14, 3:42
PM"). Server-side via `formatMessageTime()` in `templates.ts`, client-side via
`formatChatTimestamp()` in `psycheros.js`.

**Timezone**: Configurable via General Settings UI. The selected timezone
propagates to all server-side date/time formatting — message headers, snapshot
dates, memory metadata, vault document dates, knowledge graph sync times, and
daily memory summarization. Client-side streaming timestamps and the entity's
temporal XML are also included. Empty selection falls back to the `TZ`
environment variable, then the browser's local timezone for display.

Implemented in `src/entity/loop.ts` via `formatMessageTimestamp()`. XML
stripping in `src/server/markdown.ts` and `web/js/psycheros.js`.

## Stop Generation

During streaming, the Send button transforms into a Stop button (square icon)
with two-tap confirmation to prevent accidental cancellation.

**States:**

1. **Stop** (red square icon) — initial state during streaming
2. **Stop again** (pulsing amber square icon) — confirmation required, resets
   after 3 seconds
3. **[Stopped]** — shown in the message when generation is halted

**Behavior:**

- Partial assistant response is **not persisted** when stopped
- User message **is persisted** (saved before streaming begins)
- Switching conversations mid-stream no longer aborts generation — the response
  continues in the background and is fully persisted to the database. When you
  switch back, the completed message is visible.
- The explicit Stop button (double-tap) still aborts generation and prevents
  persistence as before.

Implemented in `web/js/psycheros.js`: `requestStopGeneration()`,
`stopGeneration()`. CSS in `web/css/components.css`.

## Retry Failed Turn

When a chat turn fails (rate limit, network error, upstream outage) and no
assistant content was produced, a "Retry" button appears in the assistant bubble
below the error message.

**Behavior:**

- Clicking Retry re-attempts the LLM call using the already-persisted user
  message — no duplicate is created in conversation history
- The error content is cleared and replaced with the new streaming response in
  the same bubble
- Stop button is available during retry, with the same double-tap confirmation
- If the retry also fails with no content, a new Retry button appears again
- Retry is not offered if the turn produced any assistant content, thinking, or
  tool calls (partial results are preserved)

**API:** `POST /api/chat/retry` with body `{ "conversationId": "..." }`

Implemented in `web/js/psycheros.js`: `retryFailedTurn()`. Server handler in
`src/server/routes.ts`: `handleChatRetry()`. CSS in `web/css/components.css`:
`.retry-btn`.

## Auto-Scroll

Smart proximity-based scroll latching replaces the naive "always scroll to
bottom" approach. Matches standard chat app conventions.

**Behavior:**

- **Latched by default** — when the user is within 80px of the bottom, new
  content automatically scrolls into view
- **Scroll up to disengage** — scrolling away from the bottom unlatches
  auto-scroll immediately; the user can read history undisturbed during
  streaming
- **Scroll-to-bottom pill** — a circular button appears whenever the user is
  scrolled away from the bottom, not just during streaming
- **New-content badge** — a pulsing green dot on the pill indicates content has
  arrived while the user was scrolled up
- **Click pill to re-latch** — instant scroll during streaming (avoids race with
  growing content), smooth scroll when idle
- **Scroll back to bottom naturally** — also re-latches and dismisses the pill
- **Sending a message always latches** — user intent is unambiguous, view jumps
  to the new message

**Applies to all conversation views:** Both regular chat and Discord channel
conversations share the same `AutoScroll` module via a common `id="messages"`
element.

**Self-healing DOM:** The `AutoScroll` module detects stale DOM references (from
HTMX swaps and `innerHTML` replacements) via `element.isConnected` checks and
automatically reinitializes.

Implemented in `web/js/psycheros.js`: `AutoScroll` IIFE module (exposed on
`Psycheros.autoScrollReinit` / `Psycheros.autoScrollJump` for inline fragment
scripts). CSS in `web/css/components.css`: `.scroll-to-bottom-pill`,
`.scroll-pill-badge`.

## Message Editing

Both user and assistant messages can be edited after they're sent.

**Features:**

- Edit button (pencil icon) appears on hover
- Inline editing with textarea replacing message content
- Save/Cancel buttons for confirming or discarding changes
- Edited messages shown with (edited) indicator in the UI
- `edited_at` timestamp stored in database (not passed to entity)
- ChatRAG re-indexing: edited messages are automatically re-indexed for semantic
  search

**API:** `PUT /api/messages/:id` with body
`{ "content": "...", "conversationId": "..." }`

Implemented in `web/js/psycheros.js` and `src/server/state-changes.ts`.

## Markdown Rendering

Both user and assistant messages render markdown formatting with progressive
streaming.

- **Server-side**: `renderMarkdown()` in `src/server/markdown.ts` uses `marked`
  (`breaks: true`, `gfm: true`) + `DOMPurify`. Strips LLM XML artifacts (`<t>`
  timestamp tags, non-HTML XML wrappers) before rendering.
- **Client-side streaming**: Progressive markdown rendering — content is parsed
  and rendered live during streaming via debounced `marked.parse()` (40ms, same
  `breaks: true` + `gfm: true` config as server). A blinking block cursor (▌)
  appears inline during generation. Each content segment between tool calls is
  independently rendered.
- **Client-side completion**: On `done` event, final render applied, cursor
  removed, thinking/tool sections collapsed.
- **XML stripping**: `stripEntityXml()` removes `<t>timestamp</t>` tags
  (including content), partial tags at chunk boundaries, and non-HTML XML
  wrappers while preserving standard HTML tags.
- **Supported**: Headers, lists, code blocks, blockquotes, tables, links,
  emphasis
- **Dependencies**: `jsdom` provides DOM environment for DOMPurify sanitization

## General Settings

Customizable display names, timezone, and appearance. Access via Settings →
General Settings (first card in the settings hub). Two tabs: **General** and
**Theme**.

### General Tab

#### Display Names

- **Entity Name** — replaces "Assistant" in message headers across the chat UI
- **Your Name** — replaces "You" in message headers across the chat UI

#### Timezone

- **Display Timezone** — dropdown of ~40 common IANA timezones grouped by
  region, with "(System Default)" option
- Affects all server-rendered date/time display: message timestamps, snapshot
  dates (Today/Yesterday labels), memory metadata, vault document dates,
  knowledge graph sync times, and daily memory summarization schedule
- Also affects client-streamed timestamps and entity temporal XML
- Empty selection uses the system/browser default

Settings are loaded on page init from the server and cached in
`globalThis.PsycherosSettings` for instant access during streaming. Saving
updates the in-memory cache immediately so new messages reflect the change
without a page reload.

**Persistence:** Settings stored in `.psycheros/general-settings.json` on the
server. Defaults:
`{ "entityName": "Assistant", "userName": "You", "timezone": "" }`.

**API Endpoints:**

- `GET /api/general-settings` — get current settings
- `POST /api/general-settings` — save settings
  (`{ "entityName": "...", "userName": "...", "timezone": "..." }`)
- `GET /fragments/settings/general` — render settings form fragment

### Theme Tab

Customizable UI theming. Access via Settings → General Settings → Theme tab.

### Color Themes

8 preset themes — Violet Dream, Phosphor Green, Ocean Blue, Sunset Orange, Rose,
Amber, Mint, Slate — plus a free-form color picker. The custom color picker is
initialized to Violet Dream (`#a855f7`), which also matches the
`PSYCHEROS_ACCENT_COLOR` env-var default. Selecting any preset takes precedence;
the env var only applies when no preset is chosen.

### Background Images

- Upload custom backgrounds (JPEG, PNG, GIF, WebP up to 5MB)
- Apply backgrounds from URL
- Gallery with thumbnails, delete support
- Blur slider (0-20px) and overlay opacity slider (0-100%)

### Glass Effect

Frosted glass (glassmorphism) effect on UI panels when background is active.
Uses `backdrop-filter: blur()` with semi-transparent backgrounds. Automatically
hides dark overlay when enabled. The header is excluded from the glass effect to
remain fully opaque, preventing background content from bleeding through the
logo and header controls.

### Persistence

Theme preferences persist server-side in `.psycheros/appearance-settings.json`.
On page load, the server is queried first and its values take precedence;
localStorage acts as a synchronous cache for instant rendering and an offline
fallback. On theme changes, settings are saved to both localStorage (immediate)
and the server (async fire-and-forget). CSS variables in `web/css/tokens.css`.

**API Endpoints:**

- `GET /api/appearance-settings` — get current appearance settings
- `POST /api/appearance-settings` — save appearance settings
- `GET /api/backgrounds` — list uploaded backgrounds
- `POST /api/backgrounds` — upload new background
- `DELETE /api/backgrounds/:filename` — delete background
- `GET /backgrounds/:filename` — serve background image file

## Tools Settings

Manage which tools are available to the entity. Access via Settings > Tools in
the sidebar.

**Features:**

- Two tabs: **Built-in** and **Custom** — visually separates shipped tools from
  user-written ones
- Built-in tools grouped by category (System, Identity, Knowledge Graph, Data
  Vault, Web Search, Pulse, Memory, Image Generation)
- Toggle switches for each individual tool — changes take effect immediately
  (hot-reload)
- Per-category "Enable All" / "Disable All" buttons
- Global "Enable All" / "Disable All" buttons
- Expandable detail panel on each tool showing full description and JSON Schema
  parameters
- Custom tab includes an **Import Tool** button to upload `.js` files directly
  from the UI

**Settings Priority:**

1. User overrides (saved toggles) take precedence
2. Auto-enabled tools (e.g., `web_search` when a web search provider is
   configured) are always on
3. `PSYCHEROS_TOOLS` environment variable as fallback

**Persistence:** Settings stored in `.psycheros/tools-settings.json`. Only tools
the user has explicitly toggled are stored (as `toolOverrides`). Defaults to
empty (no overrides), meaning the env var controls initial behavior until the
user makes changes via the UI.

**Custom Tools:**

- Place `.js` files in the `custom-tools/` directory at the project root, or use
  the **Import Tool** button on the Custom tab to upload from the UI
- Each file exports a default `Tool` object with `definition` and `execute`
  properties
- Imported files are saved to `custom-tools/` and the registry hot-reloads — no
  server restart needed
- Toggle them on to enable — no core code changes needed

**API Endpoints:**

- `GET /api/tools-settings` — get all tools, categories, and current overrides
- `POST /api/tools-settings` — save overrides and hot-reload
  (`{ "toolOverrides": { "shell": true } }`)
- `POST /api/custom-tools/upload` — upload a `.js` custom tool file
  (multipart/form-data, field `tool`, max 100KB)
- `GET /fragments/settings/tools` — render Tools settings page fragment

**Source files:** `src/tools/tools-settings.ts`, `src/tools/custom-loader.ts`,
`src/server/templates.ts`, `src/server/routes.ts`, `web/css/settings.css`

## Inline Image Display

Generated images render inline in chat messages. The entity uses the
`generate_image` tool and images appear directly in the conversation as the tool
result is processed.

**Features:**

- Images display inline with a subtle container and generator name metadata
- Auto-generated image descriptions displayed below the image (via the
  configured captioning provider)
- Images persist across conversation switches via `[IMAGE:...]` markers stored
  in the assistant message content
- Descriptions are included in the marker JSON and rendered from persisted
  messages
- Lazy loading (`loading="lazy"`) for performance
- Server-side rendered in `renderAssistantMessage()` for persisted messages,
  client-side rendered during SSE streaming

**SSE event:** `image_generated` with JSON payload
`{ imagePath, prompt, generatorName, description }`.

Implemented in `web/js/psycheros.js` (SSE handler), `src/server/templates.ts`
(server-side rendering), `web/css/components.css` (`.generated-image-container`,
`.generated-image`, `.generated-image-meta`, `.generated-image-desc`).

## Chat Image Attachments

Users can attach images to chat messages for the entity to reference in
generation or conversation.

**Features:**

- Clip icon button to the left of the chat input
- File picker accepts images (JPEG, PNG, GIF, WebP)
- Thumbnail preview shown below the input after selecting a file
- Remove button to cancel the attachment before sending
- On send, the attachment is uploaded and its ID is included in the chat request
- The attachment is automatically captioned via the configured vision model
  before being passed to the entity
- The user message is prefixed with
  `[USER_IMAGE: /chat-attachments/filename | Caption: description]` so the
  entity understands the image content
- If captioning fails or is not configured, falls back to path-only:
  `[USER_IMAGE: /chat-attachments/filename]`
- The entity can use `user_image_path` in `generate_image` to incorporate the
  attached image
- The entity can use `describe_image` with the path to get a more detailed
  description

**API:** `POST /api/chat-attachments` (multipart upload, max 10MB), returns
`{ id, filename, url }`. Files stored in `.psycheros/chat-attachments/`.
Captioning is handled server-side in `handleChat` before creating the entity
turn.

Implemented in `web/js/psycheros.js` (`handleAttachment()`,
`removeAttachment()`), `src/server/routes.ts` (`handleUploadChatAttachment`,
auto-caption flow), `web/css/components.css` (`.attach-btn`,
`.attachment-preview`, `.attachment-thumb`, `.attachment-remove`).

## Vision Settings

Settings > Vision provides three tabs:

**Generators** — Card grid for managing image generation provider slots
(OpenRouter, Gemini). Each card links to a config form for provider, model, API
key, default params, and NSFW toggle. Includes captioning config section
(provider, API key, model). Uses HTMX-driven tabs with OOB swaps for active
state.

**Anchors** — List of labeled reference images used as style/character guides by
the `generate_image` tool. Each anchor shows a thumbnail, editable label and
description fields, file size, and save/delete buttons. Upload form at bottom
with file picker, label, and description inputs (max 10MB). Anchor images are
stored in `.psycheros/anchors/` with metadata in the `anchor_images` SQLite
table.

**Gallery** — Browse all generated and user-uploaded images. Rendered
server-side on tab load. Features:

- Stats bar showing total count, disk usage, generated count, and uploaded count
- CSS grid of thumbnail cards (150px min column width) with lazy loading
- Each card shows: square thumbnail with category badge (generated/uploaded),
  truncated UUID filename (full on hover), copy-to-clipboard button, file size,
  and creation date
- Generated image cards include prompt as hover tooltip
- Full-screen lightbox overlay on thumbnail click (close via click-outside,
  Escape key, or swipe-down on mobile)
- Pagination: 24 images per page with "Load more" button (fetches additional
  pages via `GET /api/gallery/images`)
- View-only — no delete capability

Implemented in `src/server/templates.ts` (`renderVisionSettings`,
`renderVisionGeneratorsTab`, `renderVisionAnchorsTab`, `renderVisionGalleryTab`,
`renderVisionTabActiveState`), `src/server/routes.ts` (`scanGalleryImages`,
`handleGalleryImages`, `handleVisionGalleryFragment`), `web/js/psycheros.js`
(load-more, lightbox, copy-clipboard).

## LLM Connections

Multi-provider connection profile system. Access via Settings → LLM Settings
(second card in the settings hub). Uses the same hub-and-card pattern as Image
Gen and other settings.

**Hub View:**

- Card grid showing all saved profiles with provider icon, name, model, and
  active badge
- "Add Profile" card opens a new profile form
- Clicking a profile card opens its edit form

**Profile Edit Form:**

- Provider dropdown (OpenRouter, OpenAI, Alibaba/Qwen, NanoGPT, Custom Endpoint)
  with auto-fill for base URL, model, and worker model
- Connection fields: name, base URL, API key (masked display with show/hide
  toggle)
- Sampling parameters: temperature, top-p, top-k, frequency penalty, presence
  penalty
- Token limits: max tokens, context length
- Thinking toggle for chain-of-thought reasoning (sent as
  `thinking: { type: "enabled" }` to the API)
- Actions: Save Profile, Test Connection, Set as Active, Delete Profile (with
  confirmation)

**Behavior:**

- Active profile is used for all chat requests; switching reloads the LLM client
  immediately
- Entity-core (MCP) is dynamically restarted with the new profile's credentials
  when the active profile changes
- First-time users get a default profile from `ZAI_*` environment variables
- Legacy single-profile settings are automatically migrated to the multi-profile
  format
- Worker model (auto-titling, summarization) always has thinking disabled
  regardless of profile setting
- The max-tokens parameter is sent as `max_completion_tokens` for models that
  require it (OpenAI o-series, gpt-5.x) and `max_tokens` for all others — no
  manual configuration needed

**API Endpoints:**

- `POST /api/llm-settings/profile` — add/update a single profile (server-side
  merge)
- `POST /api/llm-settings/set-active` — set active profile by ID
- `POST /api/llm-settings/test` — test connection for a profile
- `POST /api/llm-settings` — bulk save (delete operations)
- `POST /api/llm-settings/reset` — reset to defaults

**Persistence:** Settings stored in `.psycheros/llm-settings.json` as
`{ profiles: LLMConnectionProfile[], activeProfileId: string }`.

## System Admin Panel

Built-in diagnostics and log viewer for inspecting system health without shell
access. Access via Settings → System Admin.

### Diagnostics Dashboard

Aggregates health data from 7 subsystems into a single view:

- **Overview**: Uptime, active SSE clients, database file size
- **Database**: Row counts for conversations, messages, lorebooks,
  lorebook_entries, memory_summaries
- **Vector System**: sqlite-vec availability/version, sync status between main
  tables and vec0 virtual tables
- **RAG**: Enabled status, indexed file count, chunk count
- **Memory Consolidation**: Enabled status, summary counts by granularity
  (daily/weekly/monthly/yearly), summarized chat count
- **MCP (entity-core)**: Transport connection status, ping-based liveness (30s
  interval, 5s timeout per ping, detects hung or crashed subprocesses),
  automatic reconnection with exponential backoff (5 attempts, 5s–80s delay),
  reconnect status and attempt counter, last sync timestamp, pending
  identity/memory count, last ping success/attempt timestamps. When entity-core
  disconnects, a toast notification appears in the UI showing reconnection
  progress.
- **Knowledge Graph**: Node and edge counts

Data cached for 5 seconds to avoid hammering SQLite on rapid refreshes. Manual
refresh via button.

### Log Viewer

Ring buffer capturing the last 1,000 log entries from all `console.*` calls.
Component tags are parsed from `[Bracket]` prefixes in log messages.

**Filtering:**

- By level (Error, Warning, Info)
- By component tag (DB, RAG, MCP, Server, etc.)
- By entry count limit (50, 100, 250, 500)

**Copy to clipboard** formats logs as markdown with a fenced code block —
designed for pasting into an LLM for analysis. Diagnostics copy produces
structured markdown with sections matching the dashboard.

Timestamps render in the browser's local timezone (not the server's).

### Actions

Manual operations panel for running one-off maintenance tasks. Currently hosts
batch knowledge graph population and embedding operations. (Memory consolidation
was previously available here but now runs automatically on startup.)

- **Batch Populate Knowledge Graph**: Runs
  `entity-core/scripts/batch-populate-graph.ts` to backfill the knowledge graph
  from existing memory files. Extracts entities and relationships via LLM,
  creates `memory_ref` nodes with mentions edges, and generates embeddings.
  Idempotent — already-processed memories are skipped.

**Parameters:**

- **Days** (default 30) — how far back to look for memories
- **Granularity** — `daily`, `weekly`, `monthly`, `yearly`, `significant`, or
  `all`
- **Dry run** — extract entities without writing to the graph
- **Verbose** — show per-entity detail in output

Output includes exit code and full script stdout/stderr. The script runs as a
subprocess against entity-core, so it uses entity-core's data directory and LLM
settings (passed through from the Psycheros environment).

**Source files:** `src/server/logger.ts`, `src/server/diagnostics.ts`,
`src/server/admin-routes.ts`, `src/server/admin-templates.ts`,
`web/js/admin.js`, `web/css/admin.css`

### Entity Data Export & Import

Settings → System Admin → Entity Data tab. Full backup and restore of all entity
data across both entity-core and Psycheros.

**Export** produces a zip containing:

- `entity-core/` — identity files, memories (daily/weekly/monthly/yearly/
  significant), knowledge graph (SQLite + JSON export)
- `psycheros/` — conversations + messages, lorebooks, vault documents, generated
  images, anchor image metadata
- `manifest.json` — schema version, timestamp, per-part status, item counts

If entity-core data is unavailable (MCP disconnected, entity-core crashed, or
MCP disabled), the export will:

1. Attempt an automatic MCP restart and retry
2. If the retry also fails, show a warning with two options:
   - **Export Anyway** — produces a Psycheros-only zip (no identity, memories,
     or knowledge graph)
   - **Cancel** — stops so you can fix the entity-core connection first

The manifest records `parts.entity_core: false` and `entity_core_error` when
entity-core data is missing, so imported archives are always auditable.

**Import** accepts the same zip format. It clears existing Psycheros data
(conversations, lorebooks, vault, images) before restoring, then sends
entity-core data through MCP's `entity_import` tool. After a successful import,
a sync pull runs on the existing MCP connection (the import handler reopens DB
connections internally, so no restart is needed). MCP is restarted only as a
fallback if the pull fails.

**API endpoints:**

- `POST /api/admin/entity-data/export` — full export; zip filename includes the
  entity name (e.g. `my-entity-export-2026-06-01T12-34-56.zip`). Returns zip or
  partial error JSON
- `POST /api/admin/entity-data/export?partial=1` — skip entity-core, export
  Psycheros-only data
- `POST /api/admin/entity-data/import` — import from zip
- `GET /fragments/admin/entity-data` — Entity Data tab HTML fragment

## Knowledge Graph Editor

Mobile-first card list editor with an optional network graph toggle for the
knowledge graph stored in entity-core. Requires MCP connection
(`PSYCHEROS_MCP_ENABLED=true`).

Access via Settings → Entity Core → Knowledge Graph tab.

**List View (default):**

- Card list with type badges, labels, and connection counts
- Expand a card to see description, connections list, and Edit/Connect/Delete
  actions
- Virtual scrolling for smooth performance with large graphs
- Search nodes by label/description (instant client-side filtering)
- Filter by node type
- "Add Node" toolbar button opens a create modal

**Network View (optional toggle):**

- vis-network graph visualization, lazy-loaded on first toggle
- Node details slide-in panel with connections and actions
- Zoom/fit controls
- Search and type filter highlight matching nodes

**Editing:**

- Create/edit nodes (label, description, type)
- Connect nodes via modal with searchable node pickers and relationship type
  suggestions
- Edit modal shows existing connections with individual delete buttons
- Delete nodes uses a confirmation modal (no browser `prompt()` or `confirm()`)

**Source files:** `web/js/graph-view.js` (dynamically loaded),
`web/css/graph.css`

**API Endpoints:**

- `GET /api/graph` — full graph data (nodes, edges, stats)
- `POST /api/graph/nodes` — create node
- `PUT /api/graph/nodes/:id` — update node
- `DELETE /api/graph/nodes/:id` — delete node
- `POST /api/graph/edges` — create edge
- `PUT /api/graph/edges/:id` — update edge
- `DELETE /api/graph/edges/:id` — delete edge

## Data Vault

Document storage and search system accessible via Settings → Data Vault in the
sidebar. Documents are chunked, embedded, and proactively searched every turn
for context injection.

**Features:**

- Upload documents (.md, .txt, .pdf, .docx, .xlsx up to 10MB)
- Document cards showing title, file type, chunk count, size, source
  (upload/entity), date
- View/Edit documents with a rendered markdown view mode (default) and textarea
  edit mode
- Cancel button to discard edits and return to the vault list
- Delete documents with confirmation
- Entity can also create/edit vault documents via `vault` tool
- Descriptive file naming: `vault_{date}_{slug}.md` with automatic conflict
  resolution

**API Endpoints:**

- `GET /api/vault` — list documents
- `POST /api/vault` — upload document
- `GET /api/vault/:id` — get document metadata
- `PUT /api/vault/:id` — update document
- `DELETE /api/vault/:id` — delete document
- `POST /api/vault/search` — search vault

**Source files:** `src/vault/manager.ts`, `src/vault/processor.ts`,
`src/tools/vault-tools.ts`, `src/server/routes.ts`

## Core Prompts Editor

Review and edit the entity's identity files accessible via Settings -> Core
Prompts in the sidebar. The foundational settings UI -- Memories Editor and
other tabbed editors follow its pattern.

**Tabs:** Self, User, Relationship, Custom

**Features:**

- View and edit any identity file with a textarea editor
- Create/delete custom files
- **Upload File** -- restore or add identity files in any category. Writes
  through MCP so entity-core stays canonical. Overwrites if the file already
  exists.
- **Prompt Label** input field on each file editor -- customize the XML tag name
  used in the LLM context (e.g., rename `<user_identity>` to something more
  personal like `<human_identity>`, or a preferred name). Default is the
  filename without `.md`. Persisted via
  `POST /api/settings/prompt-label/:directory/:filename`.
- Tabbed navigation with file lists per category

**Source files:** `src/server/templates.ts` (render functions),
`src/server/routes.ts` (`handleSavePromptLabel`), `web/css/settings.css`

## Memories Editor

Review and edit the entity's recorded memories accessible via Settings →
Memories in the sidebar. Modeled after the Core Prompts UI with the same tabbed
navigation pattern.

**Features:**

- Six tabs: Daily, Weekly, Monthly, Yearly, Significant, Instructions
- File lists sorted newest-first, each linking to a full editor
- **Pagination**: Shows "X of N" count with "Load more" button when more than 50
  memories exist for a granularity
- **Search**: Filter bar with a search input that queries memories across all
  granularities using entity-core's `memory_search` tool (multi-signal ranking).
  Results show color-coded granularity badges and relevance scores.
- **Date range filtering**: "From" and "To" date pickers that filter memories by
  date range. Filters persist when switching between tabs.
- Editor displays read-only metadata (source instance, created/updated
  timestamps, version) when available from entity-core
- Save writes the local file, pushes an overwrite update to entity-core via MCP
  (if connected), and reindexes the file in RAG
- Significant tab includes a Create form for manually adding new significant
  memories; the Delete button is in the editor view (not the list), with
  confirmation
- Catch-up tab shows consolidation status (weekly/monthly/yearly) with a Run
  Catch-up button that backfills all missed periods in the background, with
  results displayed via SSE
- Instructions tab provides a textarea for custom daily memory-writing
  instructions (stored in `.psycheros/memory-settings.json`). Written in
  first-person from the entity's perspective — these shape what the entity
  remembers and how it expresses it. Defaults to empty.
- Works in offline mode (no MCP) — edits are saved locally only

**Flow:**

1. Settings hub → Memories card → tabbed view
2. Click tab → file list for that granularity
3. Click file → editor with textarea
4. Edit and Save → writes local file + MCP update + RAG reindex
5. Or (Significant tab): fill date + content → Create → new memory file
6. Search: type query in search box → submit → cross-granularity results with
   excerpts
7. Filter: set From/To dates → tab list updates → persists across tab switches

**MCP Integration:**

- **Read**: If MCP is connected, `memory_read` fetches richer metadata from
  entity-core (source instance, timestamps, version). Falls back to local file.
- **Save**: Calls `memory_update` on entity-core (explicit overwrite, no append
  merge). Falls back to local-only if MCP is disconnected.
- **Create**: Calls `memory_create` on entity-core for new significant memories.
- **RAG**: `MemoryIndexer.reindexFile()` processes only the changed file —
  removes old chunks, re-reads, re-chunks, re-embeds, re-stores.

**Security:**

- Granularity validated against allowed values
- Date validated against entity-core's regex
  (`^\d{4}(-W\d{2}|(-\d{2})?(-\d{2})?)$`)
- Path traversal prevented by sanitizing date/granularity before file path
  construction
- Only significant memories can be created new; other granularities are
  edit-only

**API Endpoints:**

- `GET /fragments/settings/memories` — tabbed view
- `GET /fragments/settings/memories/search?q=` — search memories
  (cross-granularity)
- `GET /fragments/settings/memories/consolidation` — catch-up status tab
- `GET /fragments/settings/memories/instructions` — custom daily memory
  instructions tab
- `GET /fragments/settings/memories/:granularity?offset=&before=&after=` — file
  list (with optional pagination and date range)
- `GET /fragments/settings/memories/:granularity/:date` — editor
- `POST /api/memories/:granularity/:date` — save edited memory
- `POST /api/memories/significant/create` — create new significant memory
- `DELETE /api/memories/significant/:filename` — delete a significant memory
- `POST /api/memories/consolidation/run` — run catch-up consolidation
- `POST /api/memories/instructions` — save custom daily memory instructions

**Source files:** `src/server/templates.ts` (render functions),
`src/server/routes.ts` (handlers), `src/mcp-client/mod.ts` (MCP methods),
`src/rag/indexer.ts` (reindexFile)

## Pulse System

Autonomous prompt scheduling system accessible via Settings → Pulse in the
sidebar. The entity can act on its own initiative by processing user-defined
prompts on schedules, timers, or external triggers.

**Features:**

- Tabbed view: Prompts list and Execution Log
- Create, edit, enable/disable, and delete Pulses
- Manual "Run Now" trigger for any Pulse
- Conversations with active Pulses show a heartbeat indicator in the sidebar

**Timezone-Aware Scheduling:** When `PSYCHEROS_DISPLAY_TZ` (or `TZ`) is set,
daily/weekly/monthly and one-shot schedules are automatically converted from the
user's local timezone to UTC before being stored as cron expressions. The editor
pre-fills and list view display times in local time. Advanced cron expressions
are not converted and are always interpreted in UTC. If no timezone is
configured, behavior is unchanged (times treated as UTC).

**Trigger Types:**

- **Scheduled** — Friendly presets (every N minutes/hours, daily at time, weekly
  on day, monthly on date) plus advanced cron expression
- **One-shot** — Fire once at a specific datetime, then auto-disable
- **Inactivity** — Fire after no user messages across all chats for a set
  duration, with optional ±35% random jitter for organic feel
- **Webhook** — External trigger via `POST /api/webhook/pulse/:id` with Bearer
  token authentication (rate-limited to 1 per 10s)
- **Filesystem** — Watch a directory for file creation/modification events
  (debounced at 1s)

**Chat Modes:**

- **Visible** — Entity response streams in real-time to the assigned
  conversation. The Pulse prompt appears as a visually distinct system message
  (centered, accent-colored border, EKG Pulse icon header with timestamp). The
  entity's response streams live with full markdown rendering, thinking display,
  and tool call cards — identical to regular chat streaming.
- **Silent** — Entity processes the prompt in the background; output stored in
  execution log only

**Visible Mode Behavior:**

- The Pulse prompt message appears in real-time with the entity's accent color
  border and Pulse icon
- The entity perceives Pulse messages as system-initiated via a
  `[System — Pulse "name"]` prefix, not as user messages
- Responses stream via the persistent SSE channel (content, thinking, tool_call,
  tool_result, done, message_id events)
- Input is disabled during Pulse streaming; the stop button appears (double-tap
  to confirm)
- Chat auto-scrolls as Pulse content arrives
- Pulse message metadata (pulse_id, pulse_name) is stored on messages for
  traceability
- **Streaming fallback**: If the persistent SSE connection drops during pulse
  execution (common during idle periods), a `pulse_complete` event triggers a
  conversation reload so the response is always visible even when real-time
  streaming was missed. Recovery is suppressed while viewing settings to avoid
  interrupting in-progress work — the Pulse response is visible once the user
  returns to the chat
- **SSE resilience**: The persistent SSE connection reconnects on every
  `visibilitychange → visible` event (unless a Pulse is actively streaming),
  preventing dead or stuck connections from silently dropping events. The
  `onerror` handler also explicitly closes and reconnects after 1 second rather
  than relying on the browser's built-in auto-reconnect, which can get stuck in
  `CONNECTING` state indefinitely. If a reconnect does occur mid-stream, the
  `done` event handler detects the orphaned `pulseStreamingPulseId` and properly
  exits streaming mode to prevent the UI from getting stuck

**Pulse Chaining:**

- Pulses can chain into other Pulses for complex workflows
- Cycle detection via ancestry walking and max chain depth (default 3)
- Errors in chained Pulses don't prevent sibling chains

**Entity-Created Pulses:**

- Entity can create, trigger, and delete Pulses via the `pulse` tool
- Entity-created Pulses default to silent mode and auto-delete after successful
  execution

**Execution Log:**

- Paginated table showing time, pulse name, trigger source, status, duration,
  tool call count, and result preview
- Filterable by pulse ID and status

**Inactivity Trigger Details:**

- The inactivity timer starts from when the Pulse is saved/enabled, not
  retroactively from the last user message
- User activity (sending a message) resets the inactivity clock
- A cooldown equal to the threshold (measured from the last successful run)
  prevents rapid-fire re-execution when the user stays inactive
- With random jitter enabled, the fire window uses absolute elapsed times (e.g.,
  a 10-min threshold with jitter fires between 6.5–13.5 min), not threshold +
  offset
- If the probability-based jitter window is missed, the Pulse falls through and
  fires once the threshold is exceeded (rather than being permanently
  suppressed)

**Source files:** `src/pulse/engine.ts`, `src/pulse/routes.ts`,
`src/pulse/templates.ts`, `src/pulse/timezone.ts`, `src/tools/pulse-tools.ts`,
`src/db/client.ts` (pulse run persistence), `web/js/psycheros.js` (switchTab,
savePulse, updatePulseTriggerFields, pulse_complete handler),
`web/css/settings.css` (pulse-specific styles), `web/css/components.css`
(.msg--pulse styles)

## Situational Awareness

Real-time signal feeds injected into the entity's context every turn, giving it
awareness of the user's presence and environment. Access via Settings →
Situational Awareness in the sidebar.

**Settings UI:**

- Enable/disable toggle to control whether the SA block is included in context
- Active Signals section listing built-in feeds with descriptions
- Future Feeds placeholder for upcoming signal types

**Built-in Signals:**

- **Current Time** — The current date and time (with short weekday name) in the
  user's display timezone, injected as `<current_time>` at the top of the SA
  block on every turn. Gives the entity an unambiguous "right now" reference,
  independent of the last interaction's timestamp.

- **Current Conversation** — The conversation ID and title the entity is
  currently processing. Always present when a conversation exists.

- **Last User Message** — Tracks the most recent user message across all
  conversations (excluding automated Pulse messages). The entity sees the
  timestamp (formatted in the user's display timezone) and which conversation
  the message was sent in (ID + title).

- **Device Detection** — Frontend detects whether the user is on desktop or
  mobile using the existing `isMobileDevice()` heuristic
  (Android/iPhone/iPad/iPod UA or touch points + viewport width). The device
  type is sent with each `/api/chat` request and included in the SA block as a
  simple `desktop` or `mobile` indicator.

- **Connected Devices** — Shows which Lovense toys, Intiface devices, home smart
  devices, and BLE devices are currently connected. A server-side
  `DeviceStatusCache` probes Lovense Connect and Intiface Central every 30
  seconds in the background; home devices are read from settings (static
  config); BLE devices are read from the DeviceBridge singleton (live WebSocket
  connections). The entity sees connected devices without needing to call a
  discover tool. The section is omitted from the SA block entirely when no
  devices are connected or configured.

- **Device Preferences** — Custom instructions configured per integration
  (Lovense or Intiface) in External Connections → Intimacy. Each section has a
  "Custom Instructions" textarea where the user writes preferences for how the
  entity should use connected devices. These are injected as
  `<lovense_preferences>` or `<toy_preferences>` XML blocks inside situational
  awareness, but **only** when a matching device is actually connected. No
  device connected means no preferences in context — keeping the system message
  lean when the entity doesn't need them.

**Context Format:**

The SA block is injected into the system message as structured XML, placed after
custom identity files and before lorebook/RAG content:

```xml
<situational_awareness>
  <current_time><t>Fri 2026-04-10 14:32</t></current_time>
  <current_conversation id="abc-123" title="Thread Title" />
  <last_user_message>
    <timestamp><t>Thu 2026-04-09 23:15</t></timestamp>
    <conversation id="def-456" title="Another Thread Title" />
  </last_user_message>
  <user_device>desktop</user_device>
  <connected_devices>
    <intimacy>
      <lovense count="1">
        <device name="Lush" battery="85" />
      </lovense>
      <intiface count="1">
        <device name="Nora" />
      </intiface>
    </intimacy>
    <home>
      <device name="Coffee Maker" type="shelly-plug" />
    </home>
  </connected_devices>
  <lovense_preferences>Start slow, ramp up gradually, prefer pattern mode</lovense_preferences>
  <toy_preferences>Use gentle vibration, check in before escalating</toy_preferences>
</situational_awareness>
```

The `<lovense_preferences>` and `<toy_preferences>` blocks only appear when the
corresponding device type is connected and the user has written custom
instructions in External Connections → Intimacy. They are omitted from the SA
block when no matching device is connected or the instructions field is empty.

Both `current_conversation` and the nested `conversation` use the same attribute
structure (`id` + `title`) to make it clear they're the same type of entity —
just different instances. "Conversation" is used consistently throughout; no
"thread" alias.

**Pulse Exclusion:** Pulse-triggered messages are excluded from the last user
message query (`WHERE pulse_id IS NULL`), so the entity only sees the timestamp
of genuine user messages.

**Persistence:** Settings stored in `.psycheros/sa-settings.json`. Defaults to
`{ "enabled": true }`.

**API Endpoints:**

- `GET /api/sa-settings` — get current SA settings
- `POST /api/sa-settings` — save SA settings
- `GET /fragments/settings/sa` — render SA settings page fragment

**Source files:** `src/entity/loop.ts` (SA block builder, `escapeXml`,
`formatConnectedDevices`, `ProcessOptions.deviceType`), `src/entity/context.ts`
(injection into `buildSystemMessage`), `src/server/device-cache.ts`
(`DeviceStatusCache` — periodic Lovense/Intiface probing, home device config,
BLE device status), `src/db/client.ts` (`getLatestUserInteraction`),
`src/server/routes.ts` (handlers), `src/server/templates.ts`
(`renderSASettings`), `web/js/psycheros.js` (`deviceType` in request body,
Context Inspector rendering)

## Discord Channel View

The Discord channel chat view (`renderDiscordChannelView`) provides feature
parity with regular conversations for Discord-sourced messages.

**Header:** Shows server name (title), channel name (`#name`), channel ID (meta,
separated with a middot), and a colored mode badge (Active/Lurk/Strict) resolved
from the gateway config at render time. Channel name is resolved from the
gateway's channel cache rather than relying on the stored DB value (which may
contain the channel ID for older conversations). Includes context inspector
button and clear context button.

**Message display:** User messages labeled "Discord", entity messages labeled
with the entity's configured name (from General Settings). Messages show
`<@userId>` mentions with a Discord-blurple highlight (`.discord-mention`
class). Entity messages render thinking sections, tool call cards, and text
content — each in its own collapsible section within the message. Context
divider messages render with a scissors icon, accent-colored "Context cleared"
label with timestamp, and gradient horizontal line separator.

**Message editing:** Both user and entity messages are editable (hover reveals
edit button). Edits affect the local DB copy only, not the original Discord
message. For entity messages, only the text content is editable — thinking and
tool call sections are preserved. Uses the same
`startMessageEdit`/`saveMessageEdit` JS functions as regular conversations.
Conversation ID is resolved from the message element's `data-conversation-id`
attribute (Discord views are loaded via HTMX fragment swap, so the URL path is
unreliable). On save, Discord messages are updated in-place rather than
replacing the DOM element (preserving the Discord-specific layout).

**Context inspector:** Available via header button. Always reads the
conversation ID from the `.discord-channel-view` element's
`data-conversation-id` attribute (since `currentConversationId` tracks
sidebar-selected conversations and is not updated for Discord channel
navigation).

**Clear context:** Inserts a system divider message ("Context cleared at
{timestamp}") without deleting message history. Messages above the divider
remain visible in the UI but are not in the entity's context window. System-role
messages are filtered from the LLM message history to avoid API errors (most
LLMs only allow system role at position 0). The channel ID for the reload is
read from the `data-channel-id` attribute on `.discord-channel-view`. API:
`POST /api/conversations/:id/clear-context`.

**Sidebar filtering:** Discord conversations (`source_type = 'discord'`) are
excluded from the main conversation sidebar. They appear only in the Discord
Hub.

**Source files:** `src/server/templates.ts` (`renderDiscordChannelView`,
`formatDiscordMessageContent`, `renderThinkingSection`, `renderToolCard`),
`src/server/routes.ts` (`handleClearConversationContext`), `src/db/client.ts`
(`insertSystemMessage`, `listWebConversations`), `web/js/psycheros.js`
(Discord-aware `startMessageEdit`/`saveMessageEdit`, `loadContextSnapshots`),
`web/css/discord.css` (`.discord-channel-header`, `.discord-msg-text`,
`.discord-msg-edit-btn`, `.discord-context-divider`, `.discord-mention`)

## Discord Hub

The Discord Hub (`renderDiscordHub`) shows connection status, configured servers
with expandable channel lists, and recent Discord conversations.

**Server cards:** Column flex layout with a header row (server name, member
count, chevron) and an expandable channels section below. Channels are clickable
links that load the channel chat view via HTMX.

**Conversation titles:** Resolved at render time from the gateway's channel
cache. Existing DB titles that contain channel IDs instead of names are
rewritten before display.

**Channel picker loading:** Uses `AbortController` to cancel in-flight requests
when navigating away or reloading, preventing stale responses from overwriting
fresh content (e.g. when navigating from Hub to Settings).

**Settings page styling:** The `.discord-settings-page` class scopes label/hint
overrides so input labels are prominent and field hints are small and muted. The
`.field-hint` class provides consistent muted styling across all settings pages.

**Source files:** `src/server/templates.ts` (`renderDiscordHub`,
`renderConnectionsDiscordSettings`), `src/server/server.ts` (Hub route handler,
channel name resolution), `src/discord/router.ts` (`getChannelNameForChannel`),
`web/css/discord.css` (`.discord-server-card`, `.discord-server-card-row`,
`.field-hint`, `.discord-settings-page`)
