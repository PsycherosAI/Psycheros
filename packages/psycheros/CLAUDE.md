# psycheros — agent card

The harness daemon. Web UI on port 3000, streaming LLM, tool execution, RAG,
lorebook, data vault. Psycheros is an **embodiment** of the entity — the
entity's canonical identity and memory live in the sibling
[`entity-core`](../entity-core/) MCP server, and Psycheros syncs with it when
`PSYCHEROS_MCP_ENABLED=true`.

First-person convention applies — see [root CLAUDE.md](../../CLAUDE.md).

## Commands

```bash
deno task dev          # development with hot reload
deno task start        # production
deno task stop         # graceful shutdown
deno check src/main.ts
deno lint
```

LLM connections are configured through the web UI (Settings > LLM Settings), not
via env vars beyond a first-run default. The `ZAI_*` vars seed a default profile
on first run if present.

## Module structure

Each `src/*/` directory has a `mod.ts` barrel. Import from `mod.ts`, not from
internal files. Add new modules following the same pattern.

The agentic loop is in `src/entity/loop.ts` — LLM call, tool execution, context
capture, image and tool-arg fading. The chat HTTP route in
`src/server/routes.ts` calls into it and streams SSE back to the browser.

## Wearable data pipeline

`src/wearable/` handles sensor data from entity-plexus (Android app connected to
Bangle.js watches via BLE). Separate from the existing DeviceBridge (which
serves web BLE gateway clients with a different protocol). Two singleton
services:

- **WearableConnectionManager** (`connection-manager.ts`) — WebSocket
  connections from entity-plexus, fire-and-forget command push, implicit device
  registration from first inbound message. Discovers data streams from incoming
  readings and an optional capabilities message, persists them to BLE device
  profiles in `.psycheros/ble-settings.json`.
- **WearableDataCache** (`cache.ts`) — latest sensor reading per type per
  device, synchronous `getSnapshot()` for zero-latency SA reads.

The `ble_device` tool and `/api/device/command` endpoint try DeviceBridge first,
then fall back to WearableConnectionManager. The wearable cache is included in
`DeviceCacheSnapshot.wearableDevices` for SA reads.

**Stream discovery and SA injection:** Data streams (sleep, hr, accel, etc.) are
discovered dynamically when readings arrive — either from an explicit
capabilities message or auto-detected from incoming data. Each stream gets a
`BLEStreamConfig` entry (label, xmlTag, enabled) on the device's BLE profile.
The user configures XML tag names and per-stream on/off toggles in two UIs: BLE
settings (per-device stream config) and SA settings (global toggle view). The
entity loop's `formatWearableData()` renders a `<wearable_data>` block in the SA
XML using each stream's configured xmlTag, only including enabled streams with
fresh readings (< 5 min). Known stream types (sleep, hr, accel, battery, gps,
screen) get human-readable renderers; unknown types serialize as JSON.

**Connection status** is tracked by
`WearableConnectionManager.connectedDeviceIds` and surfaced in both BLE and SA
settings UIs with Connected/Disconnected badges.

**Event Rules (Webhooks):** The SA settings page has a Webhooks tab that lets
the user define rules that trigger Pulses when sensor readings match conditions.
Each rule has a single condition (stream ID + operator: `changes_to`,
`goes_above`, `goes_below` + value) and a single action (`Run Pulse`). The
`EventRulesEngine` (`event-rules-engine.ts`) evaluates incoming readings from
`WearableConnectionManager.handleMessage()` (after `cache.ingest()`), calling
`PulseEngine.triggerPulse(rule.action.pulseId, "data_event")` on match.
Sustained tracking (`condition.sustainedMinutes`) requires the condition to hold
continuously before firing; cooldown prevents re-triggering within
`cooldownMinutes`. Types and persistence live in `event-rules.ts`. Config persists across device
disconnects — all registered devices are always visible and editable regardless
of connection state.

**Production vs localhost routes:** The wearable endpoints are registered under
two path sets. `/api/device/stream` and `/api/device/data` are for localhost/dev
(no Authelia). `/api/ingest/stream` and `/api/ingest` are for production behind
Authelia's `client_credentials` bearer auth — the access-control rule only
allows authenticated requests on `/api/ingest`. Both path sets delegate to the
same handlers. Route registration is in `server.ts` `handleAPIRoute()`.

## LLM client and model capabilities

`src/llm/client.ts` is the OpenAI-compatible LLM client. It handles chat
completion (streaming and non-streaming), provider-specific headers, and model
parameter filtering.

**Model capabilities** (`src/llm/model-capabilities.ts`) — an ordered array of
model-family rules that detects which sampling parameters a model supports from
its name string. First match wins. `filterSamplingParams()` strips unsupported
parameters before the API call and logs what was removed. Zero-value no-op
params (`topK=0`, `frequencyPenalty=0`, `presencePenalty=0`) are silently
skipped rather than stripped — they're defaults, not intentional user choices.
Non-zero values on unsupported models still warn. Unknown models get a
permissive default (send everything). The rules cover OpenAI o-series, GPT-5.x
(including 5.5), GPT-4.x/3.5, Claude, DeepSeek, Gemini, Qwen, GLM, Llama,
Mistral, Kimi, and Gemma — including OpenRouter-prefixed names like
`anthropic/claude-sonnet-4-20250514`. GPT-5.x only supports `maxTokens`
(sampling params rejected like o-series).

**Reasoning parameters** are gated on provider in `buildRequest()`:

- **Z.ai / NanoGPT**: sends `thinking: { type: "enabled" }` — enables Z.ai's
  chain-of-thought return.
- **OpenRouter**: sends `reasoning: {}` — tells OpenRouter to return reasoning
  tokens (ignored without it).
- **Other providers**: no parameter sent; reasoning tokens returned
  automatically if the model supports them.

**Reasoning response parsing** in `processChunk()` checks four SSE delta fields
in priority order: `reasoning_content` (Z.ai), `reasoning`
(OpenRouter/DeepSeek), `thinking` (Claude via OpenRouter), `reasoning_details`
(OpenRouter structured array — extracts `text` from entries with
`type: "reasoning.text"`). Adding a new provider that returns reasoning in a
different field means extending this chain.

`buildProviderHeaders()` adds provider-specific HTTP headers:

- **OpenRouter**: `HTTP-Referer` + `X-Title` (required, or requests fail with
  "Missing Authentication header")
- **Anthropic**: `anthropic-beta: prompt-caching-2024-07-31`

## HTMX inline scripts

HTMX 2.x does not reliably re-execute `<script>` tags inside swapped fragments.
Functions called from `onclick` handlers in HTMX-swapped fragments must live in
`web/js/psycheros.js` (loaded once, persists across swaps). That file is loaded
as `type="module"`, so top-level function declarations are module-scoped — any
function referenced from inline `onclick` must be explicitly exported via
`globalThis.functionName = functionName`.

Server data that fragment JS needs (e.g., provider presets) should be embedded
using `<script type="application/json" id="...">` tags or
`<input type="hidden">` fields in the HTML fragment, not inline `<script>`
assignments.

## Adding a built-in tool

A tool isn't fully wired until **all seven** of these are in place. The Pulse
path is the silent failure — a tool that works in chat but errors when an
autonomous Pulse calls it almost always means step 7 is missing.

1. Create `src/tools/my-tool.ts` implementing the `Tool` interface.
2. Register it in `AVAILABLE_TOOLS` in `src/tools/registry.ts`.
3. Add the tool name to the appropriate category in `TOOL_CATEGORIES` in
   `src/tools/tools-settings.ts`.
4. For off-by-default tools: add to `DEFAULT_DISABLED_TOOLS` in the same file.
5. For auto-enablement when its settings are configured: add to the
   `autoEnabled` array in `src/server/server.ts`.
6. If the tool changes UI state: use a state-change function and return
   `affectedRegions` (see below).
7. **If the tool needs persistent settings** (API keys, config): add a settings
   type in `src/llm/`, a getter on `PsycherosServer`, and wire it into **both**
   `EntityConfig` (`src/entity/loop.ts`) and `PulseEngineConfig`
   (`src/pulse/engine.ts`). The Pulse engine must pass the settings through or
   the tool will fail when called autonomously.

## Adding a custom tool (no core changes)

Custom tools don't need any of the registry wiring above.

1. Create `custom-tools/my-tool.js` exporting a default `Tool` object.
2. Or use the **Import Tool** button on Settings > Tools > Custom.
3. Toggle it on.

The custom-tool loader is in `src/tools/custom-loader.ts`.

## Reactive UI: state-changes

UI updates flow through state-change functions in `src/server/state-changes.ts`.
A state-change function returns `{ success, data, affectedRegions }`, and
`affectedRegions` tells the frontend which DOM regions to re-render.

- **Synchronous** (during a chat turn): return the state-change result from the
  tool — it flows through the chat stream.
- **Background** (Pulse, gateway, scheduler handler): call
  `getBroadcaster().broadcastUpdates()` on the persistent SSE channel
  (`GET /api/events`).

Two SSE channels exist. `POST /api/chat` is the per-request stream (message_id,
context, thinking, content, tool_call, metrics, done) and its retry sibling
`POST /api/chat/retry`. `GET /api/events` is the persistent channel for
background updates and Pulse streaming.

## Concurrency: two locks to know about

- **Tool execution mutex** — `ToolRegistry.executeAll()` serializes tool
  execution across concurrent turns. Without this, two turns racing on the
  knowledge graph or identity files would corrupt state.
- **Per-conversation write lock** — `src/utils/conversation-lock.ts` is a
  promise-chain mutex keyed by conversation ID. Entity turns hold it from
  user-message persist through final response. **`send_discord_dm` also acquires
  it** before writing synthetic role-alternation messages to the DM
  conversation. Any new code that writes to chat persistence for a specific
  conversation must take this lock — otherwise role alternation corrupts when a
  Pulse and a chat turn touch the same DM thread.

## User data and runtime state

All user-mutable state resolves under **`dataRoot`** — defaulting to
`Deno.cwd()` so today's `deno task start` behaviour is unchanged, overridable
via `PSYCHEROS_DATA_DIR` for launcher-managed deployments that put source and
data in separate directories. Source-relative reads (templates, web assets, vec0
extension) still resolve under **`projectRoot`**. Configs that need both fields
are `ServerConfig`, `EntityConfig`, `PulseEngineConfig`, and `RouteContext`.

The data tree (rooted at `dataRoot`):

- `identity/` and `.snapshots/` — **runtime-only**, gitignored, never committed.
  User-specific entity data. Never `git add` files from them.
- `.psycheros/` — DB (`psycheros.db`), settings JSON files, vault documents
  (`.psycheros/vault/documents/`), generated images, chat attachments,
  background images, anchor images.
- `memories/` — daily/weekly/monthly/yearly memory summaries.
- `custom-tools/` — user-imported tool JS files.
- `backgrounds/` — UI background images.

Docker users currently bind-mount `.psycheros/` only; setting
`PSYCHEROS_DATA_DIR=/data` and bind-mounting `/data` is the cleaner way to
persist the entire data tree uniformly.

To change identity _defaults_, edit `templates/identity/` (committed,
source-root). `src/init/mod.ts` seeds `dataRoot/identity/` from
`projectRoot/templates/identity/` on first run when empty. `templates/vault/` is
seeded into the global Data Vault on first startup.

**Memories are stored exclusively in `entity-core` via MCP.** There is no
Psycheros-local memory store. Daily summarization in `src/memory/mod.ts` writes
through the MCP client.

## Token budget

`contextLength` from the active LLM profile controls FIFO truncation of oldest
conversation history. The system message (identity, RAG, lorebook, vault, graph,
situational awareness, image-gen anchors) is **never** truncated. The current
user message is always preserved. Budget =
`contextLength - maxTokens - 5% safety margin`. Trimming and sanitization in
`src/entity/token-budget.ts`, applied in `EntityTurn.buildMessages()`.

## Scheduled work

Every scheduled or event-triggered task — daily memory summarization, identity
snapshots, MCP identity-change pushes, every flavour of Pulse trigger — routes
through the durable scheduler at [`src/scheduler/`](src/scheduler/). One
process-local instance lives on `PsycherosServer.scheduler`. Schedules and run
history live in `schedules` and `job_runs` in the main SQLite database. See
[`docs/scheduler.md`](docs/scheduler.md) for catch-up policies, registered
handlers, and operational details.

## Deep references

| Topic                             | Doc                                                |
| --------------------------------- | -------------------------------------------------- |
| First-person philosophy           | [../../PHILOSOPHY.md](../../PHILOSOPHY.md)         |
| Env vars, config, migrations      | [docs/configuration.md](docs/configuration.md)     |
| Tool system, identity tiers       | [docs/tools-reference.md](docs/tools-reference.md) |
| Memory + RAG (chat, vault, graph) | [docs/memory-and-rag.md](docs/memory-and-rag.md)   |
| UI features                       | [docs/ui-features.md](docs/ui-features.md)         |
| API endpoints, SSE architecture   | [docs/api-reference.md](docs/api-reference.md)     |
| Durable scheduler                 | [docs/scheduler.md](docs/scheduler.md)             |
| Security audit                    | [docs/security-audit.md](docs/security-audit.md)   |

External Connections (Discord, web search, home, intimacy), Vision (image gen,
captioning, gallery), Situational Awareness, and Pulse all have their feature
surfaces documented in the relevant `docs/` files. Don't reproduce them here.

## Companion packages

This package lives in the [Psycheros monorepo](../../README.md). The canonical
identity and memory store is the sibling [`entity-core`](../entity-core/); the
chat-history importer is the sibling [`entity-loom`](../entity-loom/).
