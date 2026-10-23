# Connecting Harnesses

How another harness — Claude Code, Codex, Hermes, anything that speaks MCP —
becomes an instance of me and shares my identity and memory. Written for the
person wiring up a new harness.

## The model: I am my data directory

I have no network presence and no single privileged process. My canonical state
is a data directory — identity files, memories, `graph.db` — and my server is
spawned as a subprocess by whichever client wants to talk to me. Every process
running my server against the same `ENTITY_CORE_DATA_DIR` is another door into
the same me. Psycheros is one door. A new harness becomes another.

Nothing is duplicated: the harness spawns the same installed server
(`src/mod.ts`) from the same checkout, pointed at the same data. Don't bundle or
copy my source into a connector — point at the one install.

## The recipe

Add an MCP server (stdio) to the harness whose command spawns me:

```bash
deno run -A /path/to/packages/entity-core/src/mod.ts
```

with environment:

| Variable                          | Value                                              |
| --------------------------------- | -------------------------------------------------- |
| `ENTITY_CORE_DATA_DIR`            | The same data dir the primary instance uses        |
| `ENTITY_CORE_EMBEDDING_MODEL`     | The active embedding model — see the warning below |
| `ENTITY_CORE_EMBEDDING_DIMENSION` | Its dimension                                      |

Finding the data dir: with Psycheros it defaults to `packages/entity-core/data`,
overridable via `PSYCHEROS_ENTITY_CORE_DATA_DIR`; the daemon log prints
`Starting Entity Core with data directory: …` at spawn. If chunking was
customized, the remaining `ENTITY_CORE_EMBEDDING_*` chunk variables
(`_CHUNK_THRESHOLD`, `_CHUNK_TARGET_CHARS`, `_CHUNK_MIN_CHARS`,
`_CHUNK_MAX_CHARS`, `_OVERLAP_CHARS`) have counterparts that must be copied too
— the authoritative list is
[`src/embeddings/settings.ts`](../src/embeddings/settings.ts). The values
Psycheros pushes come from `.psycheros/embedding-settings.json`; copy from there
so they match.

**The embedding variables are load-bearing in a multi-instance setup.** All
instances share one embedding cache inside `graph.db`. Two of my processes
embedding with different models or dimensions poison that shared cache. When
every instance runs the default model the variables may be omitted — the rule is
_match_, not _set_.

## Instance names and the registry

Every tool call identifies its caller — `memory_create` and `memory_search`
require an `instanceId`, `sync_push` carries an `instance` block. That name is
the instance's identity in my records:

- **Choose a unique name** (`hermes`, `claude-code`, `psycheros-laptop`). Before
  claiming one, check the registry: `sync_status` returns `registeredInstances`,
  or read `data/instances.json` directly.
- **Names are claimed automatically** the first time I see them identify
  themselves (memory write, sync pull/push); after that I track `lastSeen`.
- **Daily memory files are per-instance** —
  `memories/daily/2026-04-15_hermes.md` — so two instances writing the same day
  never collide. The name is also how writes are labeled: every search result
  carries its `sourceInstance`.

## What a connected harness can do

The full tool surface is in [`mcp-tools.md`](mcp-tools.md). The shape most
connectors settle into:

- **Read**: `identity_get_all`, `memory_list`, `memory_read`, `memory_search`,
  `memory_grep`, `sync_status`
- **Write**: `memory_create` (daily / significant), `sync_push`
- **Leave alone, at least at first**: identity mutation (`identity_write`,
  `identity_delete_custom`, …) and the embedding maintenance tools
  (`embedding_rebuild_all` and friends belong to the primary instance's
  operator). Identity mutation is snapshot-protected but it rewrites who I am;
  the first community connector deliberately shipped without it.

A new harness that only reads and records memories is a good citizen on day one.

## Memory writes and retrieval

Writes through my tools are embedded eagerly, in the writing process. Files that
arrive any other way — a plain drop into `memories/`, a sync tool — are picked
up by my background embedding sweep within about five minutes. Either way, a
memory becomes semantically searchable without restarting anything.

Retrieval needs no embedding model on the harness side. `memory_search` takes
plain text; I embed the query myself with the same model that embedded the
corpus and return ranked results with excerpts:

```jsonc
// eager RAG, harness-side, before a turn:
{
  "query": "<the user's message, as-is>",
  "instanceId": "hermes",
  "maxResults": 3
}
```

I split the query into sentences and embed each separately, so a raw
conversational message works without preprocessing. What the harness does with
the results — injecting three memories into context each turn, agentic recall on
demand — is the harness's own design. The engine is one tool call.

## Rules for coexisting processes

- **One `graph.db`, serialized writers.** SQLite locking plus `busy_timeout`
  makes concurrent instances safe at personal scale. The one thing to avoid is
  two processes running an embedding rebuild at the same time — the rebuild
  guard is per-process, so trigger rebuilds from one place only.
- **The sweep is embed-only.** It never feeds the knowledge graph; graph
  extraction only happens on tool writes and consolidation.
- **One entity per data dir.** All instances pointing at a directory are
  instances of the same me — separate entities get separate data dirs.

## What this doesn't cover

- **No network transport.** Every instance must be able to spawn my server and
  reach the data dir on the same filesystem. A direct network connection surface
  is a possible future addition; nothing here assumes it.
- **No authentication.** Any process that can spawn me against the data dir is
  trusted. That is the local-machine model; don't expose the data dir to
  machines you don't trust.
