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

## Trusted local plugins

Entity-core loads optional plugin entrypoints from `PSYCHEROS_PLUGIN_DIR` before
MCP connects. The manager in `src/plugins/` registers additional MCP tools and
additive result decorators. Decorators run after core handlers and cannot
overwrite core fields. My plugin-owned credentials live beside the shared plugin
directory under `.psycheros/plugin-secrets/<id>.env`. I apply them before import
and keep them out of portable entity exports.

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
graph extension and the embedding cache share the same db file. Long memories
(>3000 chars) are split into ~2048-char overlapping chunks, each embedded
independently — see `src/embeddings/chunker.ts`. Short memories get a single
embedding. The `sqlite-vec` extension auto-downloads from GitHub releases on
first use — implemented in `src/graph/store.ts`.

## Snapshots are load-bearing

Any tool that overwrites or deletes identity content auto-snapshots the affected
directories under `data/.snapshots/` before the change. The `entity_import` tool
also creates a pre-import snapshot so a bad import is reversible. **Don't add a
destructive identity operation without going through the snapshot path** — the
restore tool depends on it.

## Memory consolidation

Daily → weekly → monthly → yearly consolidation runs through a local
single-purpose runner at `src/consolidation/runner.ts`. The runner owns its own
`consolidation_runs` table in `graph.db`, hardcodes the three cadences (weekly
Sundays / monthly 1st / yearly Jan 1, all at 5 AM UTC) without a general cron
parser, and uses a composite primary key on `(period, scheduled_for)` to
structurally prevent double-fire across ticks. Missed boundaries during downtime
catch up on the first tick after boot (`fire_once_then_align` semantics — one
fire per missed boundary, the catch-up loop inside the handler then drains every
unconsolidated period).

The consolidator module is `src/consolidation/`:

- `runner.ts` — the ticker, schema, fire-time math
- `consolidator.ts` — core consolidation logic, LLM calls
- `prompts.ts` — LLM prompt templates
- `periods.ts` — ISO week helpers, date filtering

If you change consolidation cadence or grouping, **check `periods.ts`** — the
ISO-week boundary math is the most common breakage point.

`reclaimRunningOnBoot` in `runner.ts` is wrapped in try/catch — a
`database is locked` failure (concurrent process holding `graph.db`) must not
crash the daemon uncaught. `GraphStore` sets `PRAGMA busy_timeout = 5000` so
transient contention resolves; only a genuinely wedged lock hits the catch.
Don't strip either as defensive bloat — both are load-bearing on Windows where
orphan entity-core subprocesses can outlive their psycheros parent.

Significant memories sit alongside the hierarchy and are never folded into a
higher tier. They're surfaced separately by RAG.

## Embedding maintenance

Memory content is enriched with a human-readable date prefix before embedding
(e.g., `"Significant memory from February 14, 2026. [original content]"`), so
temporal queries can match memories by date. The enrichment algorithm is
versioned — when the version changes, entity-core auto-rebuilds the entire
embedding cache on startup. The rebuild runs after the MCP transport connects
(so the handshake never times out), but before any tool calls are processed.

Two MCP tools manage the memory embedding cache in `graph.db` (separate from
knowledge graph embeddings in `vec_graph_nodes`):

- `memory_embedding_purge` — scans all cached memory embeddings and removes
  entries whose memory file no longer exists. Use after manual file deletion to
  prevent ghost search results.
- `memory_embedding_rebuild` — clears the entire memory embedding cache and
  re-embeds every memory file from scratch. Use after bulk deletion or
  migration.

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
| First-person philosophy               | [../../PHILOSOPHY.md](../../PHILOSOPHY.md)                   |
| Sync protocol, memory retrieval       | [docs/sync-and-memory.md](docs/sync-and-memory.md)           |
| Knowledge graph internals             | [docs/knowledge-graph.md](docs/knowledge-graph.md)           |
| Snapshots: retention, restore         | [docs/snapshots.md](docs/snapshots.md)                       |
| Code review findings                  | [docs/code-review-findings.md](docs/code-review-findings.md) |
| Security audit                        | [docs/security-audit.md](docs/security-audit.md)             |

## Companion packages

This package lives in the [Psycheros monorepo](../../README.md). The primary
embodiment is the sibling [`psycheros`](../psycheros/) harness, which spawns
this server as a subprocess.
