# entity-core — agent card

Deno 2.x MCP server that holds the canonical identity, hierarchical memory, and
knowledge graph for a persistent AI entity. Communicates over **stdio** using
the MCP protocol — no HTTP. Embodiments (Psycheros, SillyTavern, Claude Code,
etc.) spawn this as a subprocess and sync via pull/push.

First-person convention applies — see [root CLAUDE.md](../../CLAUDE.md).

## Commands

```bash
deno task dev          # development with hot reload
deno task start        # production
deno task stop         # graceful shutdown
deno check src/mod.ts
deno lint
```

```bash
ENTITY_CORE_DATA_DIR=./data deno task dev    # custom data dir (default ./data)
```

## Module structure

Each `src/*/` has a `mod.ts` barrel. Import from `mod.ts`, not from internal
files. Tool descriptions are written first-person: "I use this to…".

The seven tool domains live under `src/tools/` — identity, identity-meta,
memory, consolidation, sync, snapshot, graph, plus export / import. Counts and
full schemas are in [`docs/mcp-tools.md`](docs/mcp-tools.md).

## Adding an MCP tool

1. Create the handler in `src/tools/<name>.ts`.
2. Register it in `src/tools/mod.ts`.
3. Write the description in first person ("I use this to…").

## Storage layout

All persistent state lives in `data/`:

```
data/
├── self/              # identity files (Markdown)
├── user/
├── relationship/
├── custom/
├── identity-meta.json # prompt-label mappings for identity files
├── memories/
│   ├── daily/
│   ├── weekly/
│   ├── monthly/
│   ├── yearly/
│   └── significant/   # preserved permanently
├── graph.db           # SQLite — knowledge graph + memory embedding cache
└── .snapshots/        # auto-snapshots of identity dirs before destructive ops
```

`graph.db` doubles as the embedding cache (content-hash invalidated), so the
graph extension and the embedding cache share the same db file. The `sqlite-vec`
extension auto-downloads from GitHub releases on first use — implemented in
`src/graph/store.ts`.

## Snapshots are load-bearing

Any tool that overwrites or deletes identity content auto-snapshots the affected
directories under `data/.snapshots/` before the change. The `entity_import` tool
also creates a pre-import snapshot so a bad import is reversible. **Don't add a
destructive identity operation without going through the snapshot path** — the
restore tool depends on it.

## Memory consolidation

Daily → weekly → monthly → yearly consolidation runs as cron jobs from
`src/mod.ts`. The consolidator module is `src/consolidation/`:

- `consolidator.ts` — core logic, LLM calls
- `prompts.ts` — LLM prompt templates
- `periods.ts` — ISO week helpers, date filtering

If you change consolidation cadence or grouping, **check `periods.ts`** — the
ISO-week boundary math is the most common breakage point.

Significant memories sit alongside the hierarchy and are never folded into a
higher tier. They're surfaced separately by RAG.

## Knowledge graph

Schema, node and edge types, confidence scoring, hybrid RAG, and the
"significance framework" used by the extractor live in
[`docs/knowledge-graph.md`](docs/knowledge-graph.md). Extraction runs
automatically from new memories via `src/graph/memory-integration.ts`.

Batch backfill from an existing memory tree is
`scripts/batch-populate-graph.ts`.

## Deep references

| Topic                                 | Doc                                                          |
| ------------------------------------- | ------------------------------------------------------------ |
| MCP tool reference, schemas, examples | [docs/mcp-tools.md](docs/mcp-tools.md)                       |
| First-person philosophy               | [docs/entity-philosophy.md](docs/entity-philosophy.md)       |
| Sync protocol, memory retrieval       | [docs/sync-and-memory.md](docs/sync-and-memory.md)           |
| Knowledge graph internals             | [docs/knowledge-graph.md](docs/knowledge-graph.md)           |
| Snapshots: retention, restore         | [docs/snapshots.md](docs/snapshots.md)                       |
| Code review findings                  | [docs/code-review-findings.md](docs/code-review-findings.md) |
| Security audit                        | [docs/security-audit.md](docs/security-audit.md)             |

## Companion packages

This package lives in the [Psycheros monorepo](../../README.md). The primary
embodiment is the sibling [`psycheros`](../psycheros/) harness, which spawns
this server as a subprocess.
