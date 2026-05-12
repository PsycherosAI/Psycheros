# entity-core

A persistent identity and memory store for an AI entity, exposed as an **MCP
server over stdio**. Holds:

- **Identity files** — markdown describing who I am, who I'm talking to, our
  relationship, and custom user-defined categories
- **Hierarchical memory** — daily summaries that consolidate weekly → monthly →
  yearly; significant events are preserved permanently
- **Knowledge graph** — people, places, and relationships extracted from
  memories, stored in SQLite + sqlite-vec for hybrid vector / graph retrieval
- **Snapshots** — automatic backups of identity directories before any
  destructive operation, retained per `ENTITY_CORE_SNAPSHOT_RETENTION_DAYS`

The server communicates exclusively over stdio with the MCP protocol — no HTTP.
Embodiments (Psycheros, SillyTavern via an MCP shim, Claude Code, OpenWebUI,
anything else MCP-capable) spawn it as a subprocess and sync identity and memory
through pull / push tools.

First-person convention applies — see
[`docs/entity-philosophy.md`](docs/entity-philosophy.md) for the rationale.

## Quickstart (standalone)

```bash
deno task start                                  # spawn the MCP server on stdio
ENTITY_CORE_DATA_DIR=./my-data deno task start   # custom data directory
```

Point any MCP client at it as a stdio server:

```bash
deno run -A --unstable-cron path/to/entity-core/src/mod.ts
```

## MCP tool surface

Tools are organized by domain. Counts shift as the API evolves — see
[`docs/mcp-tools.md`](docs/mcp-tools.md) for current schemas.

| Domain          | What it covers                                                        |
| --------------- | --------------------------------------------------------------------- |
| Identity        | Read, write, append, prepend, update, delete identity files           |
| Identity meta   | Prompt-label mappings for which identity files load in which contexts |
| Memory          | Create, search, list memories with instance tagging                   |
| Consolidation   | Roll daily → weekly → monthly → yearly via LLM summarization          |
| Sync            | Pull, push, status check across embodiments                           |
| Snapshots       | Create, list, inspect, restore identity backups                       |
| Knowledge graph | Nodes, edges, traversal, search, batch ops                            |
| Export / import | Zip the whole entity state for backup or transfer                     |

## Connecting from Psycheros

Psycheros spawns entity-core as a subprocess when MCP is enabled:

```bash
PSYCHEROS_MCP_ENABLED=true deno task dev    # inside packages/psycheros
```

| Variable                 | Default                                                |
| ------------------------ | ------------------------------------------------------ |
| `PSYCHEROS_MCP_ENABLED`  | `false` — enable the MCP connection                    |
| `PSYCHEROS_MCP_COMMAND`  | `deno`                                                 |
| `PSYCHEROS_MCP_ARGS`     | `run -A --unstable-cron <path>/entity-core/src/mod.ts` |
| `PSYCHEROS_MCP_INSTANCE` | `psycheros` — instance ID for memory tagging           |

## Environment

| Variable                              | Default  | Description                                                          |
| ------------------------------------- | -------- | -------------------------------------------------------------------- |
| `ENTITY_CORE_DATA_DIR`                | `./data` | Directory for identity, memory, and graph state                      |
| `ENTITY_CORE_SNAPSHOT_RETENTION_DAYS` | `30`     | Days to retain snapshots before automatic cleanup                    |
| `ENTITY_CORE_LLM_API_KEY`             | —        | LLM key for extraction / consolidation. Falls back to `ZAI_API_KEY`. |
| `ENTITY_CORE_LLM_BASE_URL`            | —        | LLM endpoint. Falls back to `ZAI_BASE_URL`.                          |
| `ENTITY_CORE_LLM_MODEL`               | —        | Model for extraction. Falls back to `ZAI_MODEL`.                     |
| `ENTITY_CORE_LLM_TEMPERATURE`         | `0.3`    | Extraction temperature                                               |
| `ENTITY_CORE_LLM_MAX_TOKENS`          | `8000`   | Extraction max tokens                                                |

## Storage layout

```
data/
├── self/, user/, relationship/, custom/    # identity files (Markdown)
├── identity-meta.json                      # prompt-label mappings
├── memories/{daily,weekly,monthly,yearly,significant}/
├── graph.db                                # knowledge graph + embedding cache
└── .snapshots/                             # identity backups before destructive ops
```

`graph.db` doubles as the embedding cache (content-hash invalidated). The
`sqlite-vec` extension auto-downloads from GitHub releases on first use.

For the agent's-eye view of the codebase — why snapshots are load-bearing, how
consolidation cron is wired, the `periods.ts` ISO-week trap — see
[`CLAUDE.md`](CLAUDE.md).

## Deep references

- [`docs/mcp-tools.md`](docs/mcp-tools.md) — complete tool reference with
  schemas, examples, and current counts
- [`docs/entity-philosophy.md`](docs/entity-philosophy.md) — first-person
  convention, ownership, design philosophy
- [`docs/sync-and-memory.md`](docs/sync-and-memory.md) — sync protocol, conflict
  resolution, memory hierarchy, retrieval ranking
- [`docs/knowledge-graph.md`](docs/knowledge-graph.md) — node and edge types,
  confidence scoring, temporal tracking, hybrid RAG
- [`docs/snapshots.md`](docs/snapshots.md) — backup retention and restore
  procedures
- [`docs/code-review-findings.md`](docs/code-review-findings.md) and
  [`docs/security-audit.md`](docs/security-audit.md) — review history

## Companion packages

This package lives in the [Psycheros monorepo](../../README.md). The primary
embodiment is the sibling [`psycheros`](../psycheros/) harness, which spawns
this server as a subprocess.
