# Code Review Findings

Status: **Complete** — all critical and high-severity issues fixed. Post-alpha
fixes below.

## Scope

Full code review covering code quality, error handling, input validation, SQLite
usage, LLM client robustness, frontend security, memory/RAG correctness, and
tool execution safety.

## Initial Observations

- ~69 TypeScript source files, ~320 total files
- No automated tests — validation done via manual browser testing
- No linting/formatting config beyond Deno defaults
- Server-side HTML rendering in `templates.ts` (~1000 LOC)
- Raw HTTP server (no framework) — all routing/parsing is manual
- Custom SSE implementation

## Bugs Found and Fixed

### Tools default behavior (High — security)

- **Problem**: `PSYCHEROS_TOOLS` defaulted to all tools enabled when env var
  unset, contradicting `.env.example` docs that said "no tools enabled by
  default". This meant the shell tool (arbitrary command execution) was active
  by default.
- **Location**: `src/main.ts:22-24`
- **Fix**: Changed default from `return ["all"]` to `return []`

### Service worker cached stale assets (High — UX)

- **Problem**: Old SBy UI persisted in Chrome even after code updates. Cache
  name `sby-v4` and precache list referenced `/js/sby.js` (now `psycheros.js`).
- **Fix**: Renamed cache to `psycheros-v1`, updated asset list, old caches
  auto-purge

### Extra newlines in assistant messages (Medium — UX)

- **Problem**: CSS `white-space: pre-wrap` on `.assistant-text` preserved
  literal whitespace from HTML between `<p>` tags. Compounded by `breaks: true`
  in server-side marked config.
- **Fix**: Changed to `white-space: normal` and `breaks: false`

### `htmx:oobErrorNoTarget` on conversation switch (Low — console noise)

- **Problem**: OOB swap for `#header-title` had no target element in the header
  template.
- **Fix**: Added `<span id="header-title">` to header; conversation title now
  displays in header bar

### Identity files overwritten by entity (Medium — data loss on deploy)

- **Problem**: Entity writes to `identity/user/` files during chat, overwriting
  tracked git files. Solved by gitignoring identity directories and seeding from
  templates on first run.

## Security Fixes

### XSS in hx-confirm attribute (High)

- **Location**: `src/server/templates.ts:1110`
- **Problem**: `categoryLabel` and `displayName` interpolated into `hx-confirm`
  attribute without HTML escaping
- **Fix**: Wrapped with `escapeHtml()`

### XSS in background gallery onclick handlers (High)

- **Location**: `src/server/templates.ts:~2411-2416`
- **Problem**: `bg.url` and `bg.filename` interpolated into inline onclick
  handlers without escaping
- **Fix**: Added client-side `escapeAttr()` helper, applied to all interpolated
  values

### Request body size limits (Low)

- **Problem**: No Content-Length enforcement on most endpoints
- **Fix**: 1MB for JSON/form, 10MB for uploads, returns 413

### Error message sanitization (Low)

- **Problem**: 18 catch blocks leaked internal paths to clients
- **Fix**: Generic messages to clients, real errors logged server-side

## LLM Client Resilience (Session 17)

### No timeout on LLM API fetch (Critical — availability)

- **Problem**: `fetch()` call to Z.ai API had no timeout. If the API hung or was
  unreachable, Psycheros would block indefinitely — silent stall, no error, no
  logging.
- **Location**: `src/llm/client.ts` — `makeRequest()`
- **Fix**: Added `AbortController` with 30s connection timeout (configurable via
  `connectTimeout`). Throws `LLMError` with code `CONNECT_TIMEOUT`.

### No stall detection on streaming response (Critical — availability)

- **Problem**: `reader.read()` on the SSE stream body had no timeout. If the API
  accepted the connection (HTTP 200) then stopped sending data mid-stream, the
  reader blocked indefinitely.
- **Location**: `src/llm/client.ts` — `chatStream()` read loop
- **Fix**: Added `readWithTimeout()` wrapper with 60s stall timeout
  (configurable via `streamStallTimeout`). Cancels the reader on timeout to tear
  down the TCP connection. Throws `LLMError` with code `STREAM_STALL_TIMEOUT`.

### Silent malformed chunk swallowing (Medium — observability)

- **Problem**: `parseSSELine()` returned `null` on JSON parse failure, same as
  empty lines. Consumers silently skipped it. If the API sent consistently
  malformed data, the user got an empty response with no error.
- **Location**: `src/llm/client.ts` — `parseSSELine()`
- **Fix**: Returns `"malformed"` sentinel. After 5 consecutive malformed chunks,
  throws `LLMError` with code `MALFORMED_STREAM`.

### Generic error message hid failure category (Medium — observability)

- **Problem**: All LLM errors surfaced as
  `"An error occurred while processing your message"` — no distinction between
  timeout, network failure, rate limit, auth error, or server error. Status
  event sent raw JSON that the client displayed as a string.
- **Location**: `src/server/routes.ts` — chat catch block; `web/js/psycheros.js`
  — status event handler
- **Fix**: Error switch in routes.ts maps error codes to descriptive user-facing
  messages. Client-side parses JSON status events and displays error text with
  toast notification.

### No logging on LLM request lifecycle (Low — observability)

- **Problem**: Zero log output between context-loading and error catch.
  Impossible to tell from logs whether a request was sent, when connection
  established, or how long streaming took.
- **Location**: `src/llm/client.ts`
- **Fix**: Added `[LLM]` tagged logging: request send (model, message count,
  tools), connect timing, stream completion stats, abnormal stream termination
  warnings.

### Tool results invisible after finish_reason=tool_calls (High — UX)

- **Problem**: The entity loop yields a `done` SSE event after every LLM call,
  including when `finish_reason=tool_calls`. The client's `done` handler
  unconditionally tore down the streaming UI — removing the streaming indicator,
  collapsing all thinking/tool sections, and calling `AutoScroll.streamEnd()`.
  Since tools hadn't executed yet, the user saw the interface go quiet with no
  visual feedback. Tool results, when they arrived, were appended to
  now-collapsed tool cards (invisible unless manually expanded). Auto-scroll was
  deactivated (`_streaming = false`), so subsequent content from the next LLM
  iteration never scrolled into view. This was most visible with tools like
  `maintain_identity` and `web_search` where the model reasons then calls a tool
  with no intermediate text content (e.g., "54 thinking chunks, 0 content").
- **Locations**: `web/js/psycheros.js` — `done` event handler (line ~1811),
  `tool_result` event handler (line ~1693)
- **Fix**: The `done` handler now checks `data` (the `finishReason` string).
  When `finishReason === "tool_calls"`, sections are still collapsed but the
  streaming indicator is kept and `AutoScroll.streamEnd()` is not called —
  keeping auto-scroll active for tool results and the next LLM iteration. The
  `tool_result` handler now re-expands the tool card after adding the result, so
  the output is visible to the user. The final `done` event (with
  `finishReason: "stop"`, `"length"`, etc.) still triggers full teardown as
  before.

## Known Issues (deferred)

### Type errors in `src/tools/graph-read.ts`

- 4 type errors at lines 472, 477, 487, 492 — `as` casts from specific arg types
  to `Record<string, unknown>` that TypeScript rejects
- App runs fine (Deno doesn't type-check at runtime) but `deno check` fails on
  these
- Fix: Cast through `unknown` first, or make the tool registry generic over arg
  types

### sqlite-vec on macOS

- The native extension is **not** committed to the repo. On first run, the
  correct binary for the current platform is fetched from sqlite-vec's GitHub
  releases (v0.1.9) and cached at `lib/vec0.{so,dylib,dll}`.
- Subsequent startups are a fast no-op once the file exists.
- sqlite-vec loads natively on Linux (x86-64), macOS (aarch64), and Windows; no
  functional fallback is required for those platforms.

### graph_create_edge rejects labels with cryptic JSON error (Medium — UX)

- `graph_create_edge` only accepted `fromId`/`toId` but entity naturally used
  `fromLabel`/`toLabel` (consistent with `graph_write_batch`)
- Undefined IDs passed to entity-core → Zod validation failure → MCP error
  returned as plain text → Psycheros `JSON.parse()` threw `SyntaxError`
- Fix: Added `fromLabel`/`toLabel` support with label-to-ID resolution via
  `getGraphNodes()` (exact case-insensitive match). Clear error messages for
  missing nodes.
- Initial fix used `searchGraphNodes()` (semantic search) which failed for short
  proper nouns — switched to direct node list lookup

### Phase 4: Resource Finalization & Startup Safety (Session 27)

#### FIXED: MCP connect race condition — fire-and-forget startup

- **Severity**: High — `mcpClient.connect()` was not awaited; server init ran in
  parallel. First request after startup could fail if MCP handshake hadn't
  completed.
- **Location**: `src/main.ts:108`
- **Fix**: `await mcpClient.connect()` with try/catch. Offline fallback behavior
  preserved.

#### FIXED: Prepared statements not finalized on error paths

- **Severity**: Medium (resource leak) — `stmt.get()`/`stmt.run()` could throw
  before `stmt.finalize()`, leaking statement handles
- **Locations**: `src/entity/loop.ts:339`, `src/lorebook/state-manager.ts:92`
- **Fix**: Wrapped in try/finally blocks for guaranteed finalization

#### FIXED: Shell tool abort listener leak

- **Severity**: Medium (memory leak) — abort event listener registered without
  `{ once: true }`, never removed on normal completion
- **Location**: `src/tools/shell.ts:98`
- **Fix**: Added `{ once: true }` option to `addEventListener`

#### FIXED: MCP transport not cleaned up on connect failure

- **Severity**: Medium (resource leak) — if `client.connect()` threw, transport
  and client objects were left dangling
- **Location**: `src/mcp-client/mod.ts:164`
- **Fix**: Cleanup in catch block: `client.close()`, then null both references

## Confirmed Safe Patterns

- All SQLite queries are parameterized
- User/assistant messages rendered through `marked` + `DOMPurify`
- `isValidFilename()` properly checks for path traversal
- Background upload generates safe filenames server-side
- Background delete handler regex blocks traversal after URL decoding
- Prepared statements wrapped in try/finally for guaranteed finalization

## Post-Alpha Fixes

### OpenRouter image generation payload incorrect (High — functionality)

- **Problem**: Sent `size` (DALL-E parameter) which OpenRouter doesn't support
  on `/chat/completions`. Used wrong `modalities` ordering. Base URL trailing
  slash produced double-slash 404s.
- **Locations**: `src/tools/generate-image.ts:192-199`
- **Fix**: Replaced `size` with `image_config` (`aspect_ratio`, `image_size`);
  changed `modalities` to `["image", "text"]`; strip trailing slash from base
  URL.

### `[IMAGE:...]` marker regex fragile (Medium — rendering)

- **Problem**: Four locations used `[^}]+` which fails when prompt/description
  contains `}` characters. Also, server-side template regex required `<p>`
  wrapper that markdown render doesn't always produce.
- **Locations**: `src/entity/loop.ts:788`, `src/server/templates.ts:1455,1673`,
  `src/server/routes.ts:6672`
- **Fix**: Changed to `.*` (lazy) pattern, consistent with existing
  `fadeImageMarker` regex. Removed `<p>` wrapper requirement from template
  regex.

- Tool execution serialized across concurrent turns via promise mutex in
  `ToolRegistry.executeAll()`, preventing race conditions on shared resources
  (identity files, knowledge graph, memories) when multiple turns run
  simultaneously (e.g., background stream + new conversation, Pulse + user chat)

See also: [security-audit.md](security-audit.md) for the full security
assessment.

## Pulse System Bug Fixes

### Inactivity trigger rapid-fire (High — UX/exhaustion)

- **Problem**: `handleInactivityTick()` had no cooldown mechanism. Once the
  inactivity threshold was exceeded, the Pulse fired every minute (the cron tick
  interval). The `lastRunAt` guard present in `handleCronTick()` was missing
  from the inactivity handler.
- **Location**: `src/pulse/engine.ts` — `handleInactivityTick()`
- **Fix**: Added `lastRunAt` check — after firing, the Pulse won't fire again
  until the full threshold period has elapsed since the last run.

### Inactivity jitter window never fires for short thresholds (High — functionality)

- **Problem**: The jitter window was calculated as
  `threshold + [randomIntervalMin, randomIntervalMax]`. For a 4-min threshold,
  the window was 16.5–23.5 min instead of the intended 6.5–13.5 min. Combined
  with a max probability of 40% and only 1-2 tick chances, the Pulse frequently
  missed its window entirely. Additionally, once past the window, the Pulse was
  permanently suppressed (`elapsedMs > windowEndMs → return`).
- **Location**: `src/pulse/engine.ts` — `handleInactivityTick()` jitter logic
- **Fix**: Window now uses `randomIntervalMin/Max` as absolute elapsed times
  from the effective start. Upper window bound changed from hard return to
  fall-through, so the Pulse fires if the jitter window is missed.

### Inactivity trigger fires retroactively on enable (Medium — UX)

- **Problem**: The inactivity timer was based solely on `lastGlobalUserMessage`.
  Enabling a Pulse after the threshold had already elapsed caused it to fire
  immediately on the next tick.
- **Location**: `src/pulse/engine.ts` — `handleInactivityTick()` and
  `registerTriggers()`
- **Fix**: Track `inactivityEnabledAt` per Pulse (set to `Date.now()` on
  registration). Effective start time is `max(enabledAt, lastUserMessage)`. User
  activity still resets the clock as expected.

### Pulse run duration stored as literal SQL string (Medium — data integrity)

- **Problem**: `completePulseRun()` passed a CAST expression as a string
  parameter value instead of inlining it in the SQL. This stored `"CAST(...)"`
  as the duration_ms value and caused "column index out of range" errors (9
  values for 8 placeholders).
- **Location**: `src/db/client.ts` — `completePulseRun()`
- **Fix**: Inlined the CAST expression in the SQL statement and adjusted
  parameter order to match the 8 placeholders.

### Pulse errors not reported to client (Medium — UX)

- **Problem**: When a visible Pulse failed (LLM error, etc.), the catch block
  only logged to console and updated the DB. No notification was sent to the
  client — the chat bar stayed active and no error toast appeared.
- **Location**: `src/pulse/engine.ts` — `executePulse()` catch block
- **Fix**: On error, broadcast `status` event with error details and `done`
  event with `"error"` to trigger the client's error UI (red toast + inline
  error message).

### Pulse streaming lost on SSE reconnection (Medium — UX)

- **Problem**: Pulse responses stream via the persistent SSE channel. If the
  EventSource connection drops during the inactivity wait (common on WSL2), all
  streaming events are lost. The user sees no response until manually
  refreshing.
- **Location**: `src/pulse/engine.ts` — `executePulse()`; `web/js/psycheros.js`
  — persistent SSE handlers
- **Fix**: Added `pulse_complete` event broadcast after Pulse execution (success
  or error). Client-side handler detects if streaming was missed
  (`pulseAssistantEl === null`) and reloads the conversation from the server.

### File inputs broken on cross-platform (High — functionality)

- **Problem**: All file inputs used
  `<button onclick="document.getElementById('input').click()">` to trigger a
  hidden file input, or `<label for>` with a separate hidden input. Both
  patterns fail on iOS Safari PWA, Android Chrome, Windows desktop browsers, and
  macOS Safari — the file picker never opens. Programmatic `.click()` and
  `<label for>` with `display:none`/`hidden` inputs don't reliably trigger
  native file pickers across browsers.
- **Locations**: `src/server/routes.ts` (vault), `src/server/templates.ts`
  (anchor, chat attachment, custom tool import, background upload)
- **Fix**: Placed `<input type="file">` inside a `<label>` wrapper with
  `position:relative;overflow:hidden` on the label and
  `position:absolute;inset:0;opacity:0` on the input. Clicking anywhere on the
  label directly clicks the file input element — no JavaScript, no `for`
  attribute. This is the only pattern that reliably works across all platforms
  including iOS PWA standalone mode. Applied to all five file inputs in the app.

### Settings link closes sidebar without navigating on Safari (High — functionality)

- **Problem**: Sidebar settings link was `<a>` without `href` with
  `onclick="Psycheros.closeSidebarAfterNav()"`. In Safari, `<a>` without `href`
  is not an interactive element — the inline `onclick` fires (closing the
  sidebar) but HTMX's `addEventListener`-based handler never fires, so no
  navigation occurs.
- **Location**: `src/server/templates.ts:1200`
- **Fix**: Changed `<a>` to `<button>` (always interactive in all browsers) with
  `onclick="Psycheros.closeSidebarAfterNav()"`. The `<button>` element ensures
  HTMX's addEventListener handler fires on Safari, so the `hx-get` request
  navigates to settings and the sidebar closes.

## Multi-Provider LLM Profiles

### Profile save race condition (High — data loss)

- **Problem**: Adding a new LLM profile used a client-side read-modify-write
  flow (GET all settings, push new profile, POST back). If the GET returned
  stale data (e.g., from cache, race condition, or HTMX page swap), existing
  profiles would be silently overwritten.
- **Location**: `src/server/templates.ts` — `saveProfile()` JS;
  `src/server/routes.ts` — `handleSaveLLMSettings()`
- **Fix**: Added `POST /api/llm-settings/profile` endpoint that handles
  add/update atomically on the server. The client now sends just the profile
  object; the server reads current settings, merges the profile in, and saves.
  The bulk `POST /api/llm-settings` is kept only for delete operations.

### Test connection credential mixing (Medium — security)

- **Problem**: `handleTestLLMConnection` fell back to the active profile's API
  key when the test profile's key was empty — even if the test profile had a
  different base URL. This could send requests to one provider with another
  provider's credentials.
- **Location**: `src/server/routes.ts` — `handleTestLLMConnection()`
- **Fix**: Credential fallback only triggers when ALL three values (baseUrl,
  apiKey, model) are empty on the test profile.

### Worker model thinking not disabled (Medium — unnecessary tokens)

- **Problem**: `createClientFromProfile()` with `useWorker: true` still had
  `thinkingEnabled` from the profile, causing lightweight tasks (auto-titling)
  to request chain-of-thought reasoning unnecessarily.
- **Location**: `src/llm/client.ts` — `createClientFromProfile()`
- **Fix**: `thinkingEnabled` defaults to `false` when `useWorker: true`, unless
  explicitly overridden.

## Memory System Bug Fixes

### Significant memories not indexed into RAG or synced to MCP (High — functionality)

- **Problem**: When the entity created a significant memory via the
  `create_significant_memory` tool, the file was written to disk but never
  indexed into RAG or synced to entity-core. The web UI path correctly called
  `reindexFile()` and `createMemory()` after writing, but the tool path only
  wrote the file. Significant memories were invisible to RAG search until the
  next server restart.
- **Location**: `src/tools/create-significant-memory.ts` — `execute()`;
  `src/entity/loop.ts` — `EntityConfig`
- **Fix**: Added `memoryIndexer` to `EntityConfig` (threaded from server through
  routes and pulse engine). The tool now calls `memoryIndexer.reindexFile()` and
  `mcpClient.createMemory()` after writing, both with non-fatal error handling.
  Existing significant memories on disk are unaffected — `indexAll()` on startup
  already indexes them.

## Chat Image Upload Bug Fixes

### Chat attachment file input had duplicate inputs with same ID (High — functionality)

- **Problem**: The Safari file input fix (`ed9892a`) wrapped the file input
  inside a `<label>` for cross-platform compatibility but left the old
  `display:none` file input with `onchange="Psycheros.handleAttachment(this)"`
  in place. The `<label>`-wrapped input had no `onchange` handler, and the
  orphaned input was never triggered by clicking the attach button. Selecting a
  file did nothing — no preview, no error, no upload.
- **Location**: `src/server/templates.ts` — `renderInputArea()`
- **Fix**: Removed the orphaned second file input and added the `onchange`
  handler to the `<label>`-wrapped input.

### [USER_IMAGE:...] markers not rendered as images in user messages (High — UX)

- **Problem**: When a conversation was loaded from the server, user messages
  containing `[USER_IMAGE: path | Caption: ... | Short: ...]` markers displayed
  the raw marker text instead of an inline image. The `renderUserMessage()`
  function passed content straight through `renderMarkdown()` without parsing
  user image markers (unlike `renderAssistantMessage()` which handled
  `[IMAGE:{...}]` markers). Additionally, the client-side `sendMessage()`
  function didn't render the attachment image in the user message bubble, and
  blocked sending image-only messages (no text).
- **Location**: `src/server/templates.ts` — `renderUserMessage()`;
  `web/js/psycheros.js` — `sendMessage()`
- **Fix**: Added `[USER_IMAGE:...]` marker parsing in `renderUserMessage()` to
  render inline images. Added client-side attachment rendering in
  `sendMessage()`. Changed guard to allow image-only sends with a fallback
  placeholder text.

### User image description fading never triggered (Medium — token waste)

- **Problem**: `buildFadeMap()` in the agentic loop only tracked `[IMAGE:{...}]`
  markers (generated images) for fading, missing `[USER_IMAGE:...]` markers
  entirely. User-uploaded images kept both longform Caption and shortform Short
  in context indefinitely, wasting tokens on verbose descriptions that the
  entity no longer needs.
- **Location**: `src/entity/loop.ts` — `buildFadeMap()`
- **Fix**: Added `\[USER_IMAGE:` check alongside the existing `\[IMAGE:\{` check
  in the first pass.

### renderUserMessage regex `[^]]` parsed incorrectly by JavaScript (High — rendering)

- **Problem**: The regex to match `[USER_IMAGE:...]` markers used `[^]]*`
  intending "any character except `]`". However, JavaScript parses `[^]]` as
  `[^]` (match any character including newline) followed by a literal `]` — not
  as a negated character class. This caused the regex to never match messages
  with long captions, displaying raw
  `[USER_IMAGE: ... | Caption: long text | Short: short]` instead of the image.
- **Location**: `src/server/templates.ts` — `renderUserMessage()`
- **Fix**: Changed `[^]]*` to `[^\]]*` (properly escaped `]` inside the
  character class).

### Image captioning ByteString error on Windows (High — functionality)

- **Problem**: The `describe_image` tool and auto-captioning path failed with
  `"headers of RequestInit is not valid ByteString"` when using OpenRouter on
  Windows. Main chat worked fine — failure was isolated to the captioning
  request construction. Copying/pasting API keys or base URLs on Windows can
  inject invisible non-ASCII characters (zero-width spaces, BOM, smart quotes).
  `.trim()` alone does not catch these. The Fetch API rejects header values
  containing characters outside the Latin-1 range (code points > 255) as invalid
  ByteString.
- **Location**: `src/tools/describe-image.ts` — `captionViaOpenRouter()`,
  `captionViaOpenRouterDual()`, `captionViaGemini()`, `captionViaGeminiDual()`;
  `src/tools/generate-image.ts` — `generateViaOpenRouter()`,
  `generateViaGemini()`
- **Fix**: Added `sanitizeHeaderValue()` to `src/tools/generate-image.ts`
  (exported, reused by `describe-image.ts`). Strips all characters outside the
  printable ASCII + extended Latin range (`[^\x20-\x7E\x80-\xFF]`) from header
  values before constructing HTTP requests. Applied across all 6 request
  construction sites (4 in describe-image.ts, 2 in generate-image.ts). Also
  fixed inconsistent captioning config access — `generate-image.ts` used
  `ctx.config.captioningSettings` (a separate field) while `describe-image.ts`
  and `look-closer.ts` used `ctx.config.imageGenSettings?.captioning`.
  Standardized to the latter and removed the redundant `captioningSettings`
  field from `EntityConfig`.

### Lorebook sticky entries expired by Pulse turns (High — functionality)

- **Problem**: Sticky lorebook entry turn counters were decremented on every
  evaluation, including Pulse/automated turns. When a Pulse fired in the same
  conversation (or in its own conversation assigned to the user's thread), it
  consumed sticky duration that was earned by real user conversation. A Pulse
  firing 4+ times could exhaust a `stickyDuration: 5` entry before the user
  returned to the thread. Additionally, when all sticky entries expired, stale
  `lorebook_state` rows were not cleaned up from the database — they persisted
  until the next evaluate call for that conversation.
- **Location**: `src/lorebook/evaluator.ts` — Step 3 (sticky processing);
  `src/lorebook/manager.ts` — `evaluate()`; `src/pulse/engine.ts` —
  `executePulse()`; `src/entity/loop.ts` — `ProcessOptions`
- **Fix**: Added `skipStickyDecrement` flag to `EvaluationOptions`,
  `LorebookManager.evaluate()`, and `ProcessOptions`. When set (automatically
  for Pulse turns), sticky entries are preserved with their current
  `turnsRemaining` unchanged and still appear in context, but the counter is not
  decremented. Pulse turns can still trigger entries and re-trigger resets the
  timer normally. Also added `clearState()` call in `evaluate()` when all
  entries expire, to clean up stale database rows.

### Entity-created Pulses never fire (Critical — functionality)

- **Problem**: Three interacting bugs prevented entity-created Pulses from
  working at all:
  1. `setPulseEngine()` was exported from `pulse-tools.ts` but never imported or
     called anywhere. The `pulseEngine` variable was always `null`, so
     `registerTriggers()` and `executePulse()` were silently no-ops.
  2. Even if wired up, `executeCreate()` saved the Pulse to the database but
     never called `pulseEngine.registerTriggers()`. The engine only loaded
     Pulses at startup, so Pulses created mid-session were invisible to the
     scheduler.
  3. No `run_at` parameter existed — entities could only use `interval_seconds`
     for "in N minutes" prompts, but the engine interpreted this as a recurring
     schedule (`*/30 * * * *`), producing wrong fire times.
- **Location**: `src/tools/pulse-tools.ts` — `executeCreate()`;
  `src/server/server.ts` — startup
- **Fix**: Added `setPulseEngine(this.pulseEngine)` call in server startup.
  Added `registerTriggers()` call after `createPulse()` in the tool. Added
  `run_at` parameter for one-shot scheduling. Added timezone conversion (display
  TZ → UTC) for `run_at`, `cron_expression` (daily/weekly/monthly patterns).

### One-shot Pulses disable before executing (Critical — functionality)

- **Problem**: `handleCronTick()` called
  `updatePulse({ enabled: false, runAt: null })` before `executePulse()`. Since
  `executePulse()` re-reads the Pulse from the DB and checks `pulse.enabled`, it
  immediately returned without executing. The one-shot Pulse was disabled but
  never ran.
- **Location**: `src/pulse/engine.ts` — `handleCronTick()`
- **Fix**: Only clear `runAt` before execution (to prevent re-fire). Disable the
  Pulse after `executePulse()` completes (unless auto-deleted).

### Pulse sidebar indicator missing on entity tool calls (Medium — UX)

- **Problem**: When an entity created or deleted a Pulse via the tool, the
  sidebar conversation list never refreshed to show/hide the Pulse icon
  indicator. The tool returned a plain string result without specifying
  `affectedRegions`.
- **Location**: `src/tools/pulse-tools.ts` — `executeCreate()`,
  `executeDelete()`
- **Fix**: Added `affectedRegions: ["conv-list"]` to create and delete tool
  results, triggering a sidebar refresh.

### Pulse messages rendered as user messages after reload (Medium — rendering)

- **Problem**: `renderMessage()` checked only `msg.pulseId` to decide whether to
  use Pulse styling. Entity-created Pulse messages had `pulse_name` set but
  `pulse_id` was null (legacy artifact), so they rendered as regular user
  messages after page reload.
- **Location**: `src/server/templates.ts` — `renderMessage()`
- **Fix**: Changed condition to `if (msg.pulseId || msg.pulseName)`.

### Captioning API key overwritten by masked value on save (High — functionality)

- **Problem**: The Vision settings page renders captioning API keys in masked
  form (`sk-••••••••b0a3`) via `maskImageGenSettings()`. When the user saved
  captioning settings, the browser sent the masked value back to the server. The
  `handleSaveImageGenSettings()` captioning-only path
  (`!body.generators && body.captioning`) blindly wrote the masked key back to
  disk, overwriting the real API key. Subsequent captioning requests sent the
  masked key as the `Authorization` header — after `sanitizeHeaderValue()`
  stripped the Unicode `•` characters, the result was a truncated invalid key,
  causing 401 errors. The generator save path (`handleSaveImageGenSlot`) already
  had mask-detection logic, but the captioning path did not.
- **Location**: `src/server/routes.ts` — `handleSaveImageGenSettings()`
- **Fix**: Added masked key detection before writing — if the incoming `apiKey`
  contains `••••`, the existing real key from current settings is preserved
  instead. Matches the pattern already used by the generator save handler.

### SSE truncation produced invalid JSON, silently dropping tool results from UI (Critical — UX)

- **Problem**: `truncateSSEData()` in `convertToSSEEvent()` was called on
  already-serialized JSON (e.g., `JSON.stringify(toolResult)` then truncated the
  string). When a tool result exceeded 100KB (`MAX_SSE_MESSAGE_SIZE`), the
  serialized JSON was cut mid-structure, producing invalid JSON. On the client
  side, `JSON.parse(data)` threw inside a try-catch that only logged to
  `console.error` — so tool results silently vanished from the UI with no
  visible error. The LLM still processed the full result in its agentic loop
  context, so the server-side behavior was correct, but the user saw nothing.
  This was intermittent because it only triggered when tool results were large
  enough (web search results, identity file reads, image descriptions). Identity
  updates were especially vulnerable due to file content sizes.
- **Location**: `src/server/routes.ts` — `truncateSSEData()`,
  `convertToSSEEvent()`; `src/pulse/engine.ts` — Pulse tool_result broadcast
- **Fix**: For `tool_result` events, the `content` field is now truncated
  **before** JSON serialization (capped at 50KB with a
  `[... N characters truncated]` notice). The same pre-serialization truncation
  is applied to `tool_call` arguments. The resulting JSON is always valid and
  parseable by the client. The LLM still receives the full untruncated content
  in its context — truncation only affects what's sent to the browser via SSE.
  The Pulse engine's tool_result broadcast (via `EventBroadcaster`) received the
  same fix. `truncateSSEData()` is retained as a last-resort safety net for
  non-JSON event types.

### Mobile keyboard popup and input text disappearing during typing (High — UX)

- **Problem**: The `visibilitychange` handler (which fires on Android when the
  virtual keyboard opens/closes) called `loadConversationFromUrl()`, replacing
  the entire `#chat` innerHTML and destroying/recreating the textarea. The
  save/restore logic for unsent text caused a visible flash (text briefly
  disappearing then reappearing) and the keyboard would dismiss and sometimes
  re-trigger visibility events. Additionally, `initPersistentSSE()` was called
  unconditionally on every `visible` transition, tearing down healthy
  EventSource connections unnecessarily.
- **Location**: `web/js/psycheros.js` — `visibilitychange` handler,
  `initPersistentSSE()` `done` event handler
- **Fix**: The conversation reload is now skipped entirely when the user is
  actively interacting (input focused, streaming active, virtual keyboard open,
  or unsent text present). The save/restore logic is removed since the reload no
  longer fires in those cases. The debounce was increased from 500ms to 1500ms.
  SSE is only reconnected if the existing connection is unhealthy (`CLOSED` or
  `CONNECTING` readyState).

### Context Inspector button inaccessible behind iOS status bar (Medium — UX)

- **Problem**: The Context Inspector toggle (`</>`) in the header was
  unreachable when the app was installed as an iOS PWA. The safe area inset was
  handled via `padding-top` on the `.app` grid container, which pushed the
  header row below the status bar. However, the header's background didn't
  extend into the safe area, and tap targets in the top-right corner (directly
  under the battery indicator) were unreliable or obscured.
- **Location**: `web/css/layout.css` — `.app` grid; `web/css/components.css` —
  `.header`
- **Fix**: Moved the `env(safe-area-inset-top)` handling from the grid
  container's padding into the header element itself. The header now has
  `padding-top: env(safe-area-inset-top)` and its height expanded to
  `calc(var(--header-height) + env(safe-area-inset-top))`. The grid row height
  matches. The header background now extends behind the status bar, and button
  content sits in the safe `var(--header-height)` zone below it. No change on
  Android (where the safe area inset is 0).

### Pulse UI permanently stuck after SSE reconnect during streaming (High — UX)

- **Problem**: If `initPersistentSSE()` was called while a Pulse was actively
  streaming, the old SSE connection was closed and the new one started with
  fresh closure-scoped state (`pulseAssistantEl = null`). However, the
  module-level `pulseStreamingPulseId` remained set. The new connection's `done`
  handler saw no `pulseAssistantEl` and returned without clearing
  `pulseStreamingPulseId` or calling `exitPulseStreamingMode()`. The UI was
  permanently stuck with a disabled input and stop button.
- **Location**: `web/js/psycheros.js` — `initPersistentSSE()` `done` event
  handler
- **Fix**: When the `done` handler receives an event but `pulseAssistantEl` is
  null, it now checks the module-level `pulseStreamingPulseId`. If set, it
  clears it and calls `exitPulseStreamingMode()` to unstick the UI. Combined
  with the conditional SSE reconnect fix above (which avoids tearing down
  healthy connections), this both prevents the issue and recovers from it if it
  occurs.
