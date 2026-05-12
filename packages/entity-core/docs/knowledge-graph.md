# Knowledge Graph

The knowledge graph is a relational index of concrete, durable facts about
people and their relationships. It tracks who exists in someone's world, what
they're like, and how they relate to each other. It supplements the hierarchical
memory system, which handles narrative substance; the graph provides structured
relationship lookups.

The graph tracks things that exist in the world — people, places, health
conditions, behavioral patterns. It does NOT track ideas, themes, language, or
abstractions. Episodic content (events, stories, one-off experiences) belongs in
the memory system, not the graph.

## Storage

The graph is stored in `data/graph.db` using SQLite with the sqlite-vec
extension for vector similarity search on entity nodes. Schema is defined in
`src/graph/schema.ts`.

If the sqlite-vec extension is not found in `lib/` at startup, entity-core
automatically downloads the correct prebuilt binary from the
[sqlite-vec GitHub releases](https://github.com/asg017/sqlite-vec/releases/tag/v0.1.9)
(v0.1.9) and caches it. This covers Linux, macOS, and Windows on both x86-64 and
aarch64. The download requires internet access on first run; subsequent runs use
the cached file.

## Node Types

Predefined node types provide semantic structure, but arbitrary custom types are
also allowed:

| Type         | Description                                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `self`       | The entity itself — use label "me" for self-references                                                                                                                       |
| `person`     | A real person who exists in the entity's world. Full name or consistent nickname                                                                                             |
| `place`      | A specific location that matters in someone's life. Not "home" (too vague) — a specific dwelling, city, or venue                                                             |
| `health`     | A specific condition, diagnosis, or physical reality that affects daily life                                                                                                 |
| `preference` | A concrete behavioral preference with specific detail. NOT a universal value like "devotion" or a theme like "authentic intimacy"                                            |
| `boundary`   | A specific rule or limit that shapes behavior in the relationship                                                                                                            |
| `goal`       | A concrete goal someone is actively pursuing                                                                                                                                 |
| `tradition`  | A specific, repeatedly-practiced ritual or routine. NOT a one-time event or a playful label                                                                                  |
| `topic`      | A concrete, enduring subject of sustained interest (hobby, community, project, field of study). Extremely narrow — "Vtubing" qualifies, "digital intimacy" does not          |
| `insight`    | A specific, concrete revelation about someone's character or history that was directly revealed. "Used to work as an exotic dancer" qualifies, "joy as nourishment" does not |

**Do not use** `event`, `memory_ref`, `concept`, `dynamic`, `value`, or
`situation` — these are not entity types.

## Edge Types

Edges represent relationships between nodes. Edge types are **freeform natural
language strings** — any type is valid. The following vocabulary is organized by
category as guidance for common relationship patterns:

| Category           | Examples                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Attitudes          | `loves`, `dislikes`, `respects`, `proud_of`, `worried_about`, `nostalgic_for`, `intrigued_by`, `frustrated_with` |
| Social             | `family_of`, `friend_of`, `works_with`, `met_through`, `close_to`, `estranged_from`                              |
| Life/Factual       | `works_at`, `lives_in`, `studies`, `grew_up_in`, `attends`                                                       |
| Beliefs/Values     | `values`, `believes_in`, `committed_to`, `opposes`                                                               |
| Knowledge/Interest | `skilled_at`, `learning`, `interested_in`, `knows_about`                                                         |
| Association        | `reminds_of`, `similar_to`, `contrasts_with`, `associated_with`                                                  |

These are suggestions, not constraints — use whatever type best describes the
relationship.

## Key Concepts

### Confidence

Nodes carry a confidence score (0–1) indicating how certain the knowledge is.
This allows the entity to distinguish between facts, beliefs, and speculations.

### Temporal Fields

Nodes track when knowledge was:

- **Learned** — when the entity first encountered this knowledge
- **Confirmed** — when it was last validated
- **Ended** — when the knowledge became no longer true (if applicable)

This temporal tracking lets the graph represent knowledge that evolves or
expires.

### Dynamic Types

Both node and edge types are freeform strings. Suggested types are provided for
guidance (see `SUGGESTED_EDGE_VOCABULARY` in `src/graph/types.ts`), but any
string is accepted. This means the graph can grow to represent domains not
anticipated at design time.

### Description Discipline

Node descriptions should be concise — one clause, max two. Capture the essential
fact, not the narrative around it.

- Good: `red 2010 WRX`
- Good: `had a bad argument Aug 2020, reconciled since`
- Bad:
  `User mentioned they have a red 2010 Subaru WRX that they bought in 2019 and they really love it...`

## Hybrid Retrieval (RAG Integration)

The graph supports hybrid retrieval that combines:

1. **Vector search** — semantic similarity via sqlite-vec embeddings
2. **Graph traversal** — structural relationships via BFS

This is implemented in `src/graph/rag-integration.ts` and enables queries like
"find everything related to [concept]" that consider both semantic similarity
and structural connections.

### Output Format

Graph RAG context uses a compact one-line-per-relationship format:

```
---
Relevant Knowledge from Graph:
user friends_with Sarah (had a bad argument Aug 2020, reconciled since)
user drives_a Subaru (red 2010 WRX)
Sarah dating Mike (met through user)
```

Standalone entity nodes without relationships are formatted as:

```
Austin (type: place)
```

## Memory Search

The `memory_search` MCP tool searches memory files directly from the FileStore
(not via the graph). It embeds each memory's content on-the-fly using the local
embedder and scores using cosine similarity combined with recency, graph entity
boost, and instance affinity signals.

The graph boost signal checks whether memory content mentions any entity labels
that scored highly in a graph entity search for the same query. This provides
cross-referencing between the memory system and graph without requiring
memory_ref nodes.

## Automatic Extraction

When a memory is created via `memory_create`, entity-core automatically extracts
entities and relationships from the memory content and populates the knowledge
graph. This runs in the background (fire-and-forget) so it doesn't delay the
memory creation response.

The extraction uses the LLM configured via `ENTITY_CORE_LLM_API_KEY` (or
`ZAI_API_KEY`), with the endpoint from `ENTITY_CORE_LLM_BASE_URL` (or
`ZAI_BASE_URL`). If no API key is set, extraction is silently skipped — the
memory is still saved normally.

**Note**: When entity-core is spawned as a subprocess by Psycheros, Psycheros
automatically forwards its `ZAI_*` LLM environment variables. If running
entity-core standalone, you must set `ENTITY_CORE_LLM_API_KEY` or `ZAI_API_KEY`
yourself for extraction to work.

### Significance Framework

Not everything in a memory becomes a graph node. The extraction prompt applies a
concrete reality test and a four-test significance framework:

1. **Concrete reality test** — Could I point to this thing in reality? Abstract
   themes, coined terms, metaphors, and universal human experiences are
   excluded.
2. **Identity test** — Does this reveal something concrete about who someone is?
3. **Relational test** — Does this directly affect how people relate in
   observable ways?
4. **Durability test** — Will this still matter weeks or months from now?
5. **Connectivity test** — Does this connect to other known things?

Entities must pass at least two tests; relationships must pass at least one.

### Confidence Floor

Entities and relationships below a confidence of 0.7 are silently dropped. This
is a hard backstop in addition to the prompt-based significance reasoning.

### Labeling Conventions

- The entity always uses label **"me"** (type `self`) for self-references
- The user is always referred to by their **actual name**, never "user". If the
  name isn't in the memory content, the fallback label is "my person"

### Deduplication

Entities are deduplicated using a two-stage process:

1. **Exact label match** — case-insensitive label+type lookup (fast path, no
   embedding needed)
2. **Semantic similarity** — vector search against existing node embeddings with
   a 0.8 cosine similarity threshold. Matches type (a person "Jordan" won't
   dedup against a place "Jordan").

When a semantic duplicate is found, the existing node is confirmed (its
`lastConfirmedAt` is updated) and optionally boosted (confidence upgraded if the
new extraction is more confident). No new node is created.

### Extraction Pipeline

Extraction behavior:

- Memories with content under 100 characters are skipped
- Entities below 0.7 confidence are dropped (confidence floor)
- Semantic dedup runs async before the database transaction
- All node/edge creation for a single memory happens in one SQLite transaction
- Errors are logged but never fail the memory write

The extraction logic lives in `src/graph/memory-integration.ts`
(`extractMemoryToGraph()`). The prompt, types, and dedup logic are defined in
`src/graph/extraction-prompt.ts` and shared with the batch scripts.

### Graph Consolidation

After extraction runs (at startup and after consolidation passes), a rule-based
consolidation pass cleans up the graph without any LLM calls:

- **Isolated node pruning**: Soft-deletes non-person/self nodes with 0
  connections
- **Generic topic detection**: Soft-deletes low-connectivity topic/preference
  nodes matching vague patterns (single common words, `sacred \w+`,
  `\w+ connection`, `\w+ dynamic`, `\w+ intimacy`)
- **Duplicate merging**: Case-insensitive and containment-based label dedup with
  edge re-parenting
- **Edge cleanup**: Soft-deletes edges connected to pruned nodes

This runs automatically as part of entity-core's startup catch-up — it's a
subconscious maintenance process, not something the entity consciously manages.

## Batch Backfill

If the knowledge graph was not active when memories were written, or extraction
was temporarily unavailable, `scripts/batch-populate-graph.ts` retroactively
processes memory files and populates the graph with entity nodes and
relationship edges.

```bash
# Dry run first to inspect extractions
deno run -A scripts/batch-populate-graph.ts --days 7 --dry-run --verbose

# Process the last 7 days of daily memories
deno run -A scripts/batch-populate-graph.ts --days 7
```

The script uses semantic dedup to prevent duplicate entities, so it's safe to
re-run after interruption.

| Flag              | Description                                                     | Default                 |
| ----------------- | --------------------------------------------------------------- | ----------------------- |
| `--days N`        | Process memories from the last N days                           | `7`                     |
| `--granularity G` | `daily`, `weekly`, `monthly`, `yearly`, `significant`, or `all` | `daily`                 |
| `--file PATH`     | Process a single file (e.g. `daily/2026-03-17.md`)              | —                       |
| `--instance ID`   | `sourceInstance` label on created nodes/edges                   | `batch-populate-script` |
| `--dry-run`       | Extract without writing to graph                                | off                     |
| `--verbose`       | Show per-entity detail                                          | off                     |

The script uses the same LLM client, embedder, and extraction prompt as the
real-time path. On instances where entity-core has already been running, the
embedding model is loaded from the local cache (no re-download).

## Schema Migrations

The graph uses automatic migrations in `src/graph/schema.ts` that run on
initialization. Tables are created first, then migrations are applied —
migrations are conditional and only perform work when affected data exists
(e.g., `memory_ref` nodes must be present for the cleanup migration to run).

The migration for removing `memory_ref` support:

- Drops the `memory_node_links` table
- Drops the `idx_graph_nodes_source_memory` index
- Soft-deletes all existing `memory_ref` nodes and their `mentions` edges
- Removes memory_ref entries from the vector table

## Related Source Files

| File                              | Purpose                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `src/tools/graph.ts`              | Knowledge graph MCP tools (15 tools)                                              |
| `src/graph/mod.ts`                | Barrel export                                                                     |
| `src/graph/store.ts`              | GraphStore class (SQLite + sqlite-vec)                                            |
| `src/graph/types.ts`              | GraphNode, GraphEdge, search/traverse option types, SUGGESTED_EDGE_VOCABULARY     |
| `src/graph/schema.ts`             | SQLite schema for graph tables, migrations                                        |
| `src/graph/extraction-prompt.ts`  | Shared extraction prompt, concrete reality test, confidence floor, semantic dedup |
| `src/graph/consolidator.ts`       | Rule-based graph consolidation (prune isolated/generic nodes, merge duplicates)   |
| `src/graph/memory-integration.ts` | Auto-extraction of entities from memories                                         |
| `src/graph/rag-integration.ts`    | Hybrid vector search + graph traversal, compact context format                    |
| `src/tools/memory.ts`             | Memory tools including file-based vector search                                   |
| `scripts/batch-populate-graph.ts` | Batch backfill: retroactively populate graph from existing memory files           |
