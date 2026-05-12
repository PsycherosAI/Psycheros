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
- **Background** (Pulse, gateway, cron): call
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

- `identity/` and `.snapshots/` are **runtime-only** — gitignored, never
  committed. They contain user-specific entity data. Never `git add` files from
  them.
- Vault documents live in `.psycheros/vault/documents/` (persisted via the
  `.psycheros/` volume mount in Docker).
- To change identity _defaults_, edit `templates/identity/` (committed).
  `src/init/mod.ts` seeds `identity/` from templates on first run when empty.
  `templates/vault/` is seeded into the global Data Vault on first startup.
- **Memories are stored exclusively in `entity-core` via MCP.** There is no
  Psycheros-local memory store. Daily summarization in `src/memory/mod.ts`
  writes through the MCP client.

## Token budget

`contextLength` from the active LLM profile controls FIFO truncation of oldest
conversation history. The system message (identity, RAG, lorebook, vault, graph,
situational awareness, image-gen anchors) is **never** truncated. The current
user message is always preserved. Budget =
`contextLength - maxTokens - 5% safety margin`. Trimming and sanitization in
`src/entity/token-budget.ts`, applied in `EntityTurn.buildMessages()`.

## Deep references

| Topic                             | Doc                                                          |
| --------------------------------- | ------------------------------------------------------------ |
| First-person philosophy           | [docs/entity-philosophy.md](docs/entity-philosophy.md)       |
| Env vars, config, migrations      | [docs/configuration.md](docs/configuration.md)               |
| Tool system, identity tiers       | [docs/tools-reference.md](docs/tools-reference.md)           |
| Memory + RAG (chat, vault, graph) | [docs/memory-and-rag.md](docs/memory-and-rag.md)             |
| UI features                       | [docs/ui-features.md](docs/ui-features.md)                   |
| API endpoints, SSE architecture   | [docs/api-reference.md](docs/api-reference.md)               |
| Code review findings              | [docs/code-review-findings.md](docs/code-review-findings.md) |
| Security audit                    | [docs/security-audit.md](docs/security-audit.md)             |

External Connections (Discord, web search, home, intimacy), Vision (image gen,
captioning, gallery), Situational Awareness, and Pulse all have their feature
surfaces documented in the relevant `docs/` files. Don't reproduce them here.

## Companion packages

This package lives in the [Psycheros monorepo](../../README.md). The canonical
identity and memory store is the sibling [`entity-core`](../entity-core/); the
chat-history importer is the sibling [`entity-loom`](../entity-loom/).
