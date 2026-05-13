# psycheros

The harness daemon. A persistent AI entity served through a web chat UI on port
3000 — streaming LLM, tool execution, RAG, hierarchical memory, knowledge graph,
lorebook, data vault, autonomous Pulse triggers, Discord gateway, image
generation and captioning.

Psycheros is an **embodiment** — an interface through which the entity exists
and interacts. The entity's canonical identity and memory live in the sibling
[`entity-core`](../entity-core/) MCP server. With `PSYCHEROS_MCP_ENABLED=true`,
Psycheros spawns entity-core as a subprocess and routes identity + memory
through it. With MCP disabled, Psycheros falls back to a local identity cache
and writes no memories.

All prompts and tool descriptions use the entity's first-person voice; see
[`PHILOSOPHY.md`](../../PHILOSOPHY.md) for the rationale.

## Quickstart

```bash
cp .env.example .env    # set ZAI_API_KEY (or any OpenAI-compatible key)
deno task dev           # development, hot reload
open http://localhost:3000
```

LLM provider, model, sampling parameters, and the active profile are managed
from **Settings > LLM Connections** in the web UI. The `ZAI_*` env vars only
seed a first-run default if no profile exists yet.

## Essential environment

| Variable                | Default | Description                                                  |
| ----------------------- | ------- | ------------------------------------------------------------ |
| `ZAI_API_KEY`           | —       | First-run default LLM key. Optional once a profile is saved. |
| `PSYCHEROS_MCP_ENABLED` | `true`  | Spawn `entity-core` and route identity / memory through it.  |
| `TZ`                    | host    | Timezone for message timestamps and Pulse scheduling.        |

Full reference: [`docs/configuration.md`](docs/configuration.md).

## Docker

The published image is `ghcr.io/psycherosai/psycheros:latest`; build and publish
run from the monorepo root. See the [monorepo README](../../README.md#docker)
for the full `docker run` example. Two volumes matter for this package:

| Path inside container                | What persists there                         |
| ------------------------------------ | ------------------------------------------- |
| `/app/packages/psycheros/.psycheros` | Conversations DB, vault, runtime config     |
| `/app/packages/entity-core/data`     | Canonical identity, memory, knowledge graph |

## How it works

Browser (HTMX) hits `POST /api/chat`. `EntityTurn` orchestrates the agentic
loop: load identity (local cache or MCP), gather RAG (chat history, vault,
lorebook, graph), call the LLM, execute tools, stream SSE back. A second
persistent SSE channel (`GET /api/events`) carries background updates from
Pulse, the Discord gateway, and cron tasks.

`identity/`, `memories/` (cache), `.snapshots/`, and `.psycheros/` are all
**runtime-only** — gitignored, never committed. To change defaults, edit
`templates/identity/` and `templates/vault/`, which seed the runtime directories
on first start.

For the agent's-eye view of the codebase — load-bearing wirings, the two-lock
concurrency model, the state-changes pattern — see [`CLAUDE.md`](CLAUDE.md).

## Deep references

- [`PHILOSOPHY.md`](../../PHILOSOPHY.md) (repo root) — first-person convention,
  ownership, the multi-embodiment model
- [`docs/configuration.md`](docs/configuration.md) — full env-var reference,
  tools list, MCP / RAG settings
- [`docs/tools-reference.md`](docs/tools-reference.md) — tool system, identity
  tiers, MCP fallback, core prompt structure
- [`docs/memory-and-rag.md`](docs/memory-and-rag.md) — memory hierarchy, the
  four RAG systems (chat, vault, lorebook, graph), vector search
- [`docs/ui-features.md`](docs/ui-features.md) — context viewer, message
  editing, situational awareness, graph viz
- [`docs/api-reference.md`](docs/api-reference.md) — full API endpoints, dual
  SSE architecture, retry stream
- [`docs/security-audit.md`](docs/security-audit.md) — security audit with
  threat model + accepted-risk rationale

## Companion packages

This package lives in the [Psycheros monorepo](../../README.md). The canonical
identity and memory store is the sibling [`entity-core`](../entity-core/); the
chat-history importer is the sibling [`entity-loom`](../entity-loom/).
