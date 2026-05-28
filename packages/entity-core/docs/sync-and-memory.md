# Sync Protocol & Memory System

The sync protocol and memory system are tightly coupled — embodiments sync
memories with instance tagging, and the memory hierarchy consolidates them over
time. This document covers both systems.

## Sync Protocol

Embodiments sync with entity-core using a batch sync model:

1. **Startup**: Embodiment pulls all identity files and memories via `sync_pull`
2. **Operation**: Works with local cache, queues changes
3. **Periodic**: Pushes queued changes via `sync_push` (default: every 5
   minutes)
4. **Shutdown**: Final sync before disconnecting

### Conflict Resolution

- **Identity files**: Last-write-wins with instance priority tiebreaker
- **Memories**: Last-write-wins (incoming version overwrites). Daily memories
  use instance-scoped filenames (`YYYY-MM-DD_instance.md`), so each instance
  owns its file exclusively. For daily memories, `memory/create` merges with
  existing content when the file already exists — bullets are deduplicated by
  `[chat:id]` tag, allowing multiple imports for the same date (e.g.,
  entity-loom runs for different platforms at different times) to coexist. The
  embedding cache is updated with the merged content. For other granularities
  (weekly/monthly/yearly/significant), the incoming push is authoritative.
- **Memory edits**: The `memory/update` tool intentionally overwrites content
  (no merge). This is for user-initiated corrections from the Memories UI. The
  `editedBy` field and version bump distinguish edits from sync-generated
  content.

### Instance Tagging

Memory entries are tagged with:

- `sourceInstance` — which embodiment created the memory (in entry metadata)
- `participatingInstances` — other embodiments involved in the conversation
- Inline `[via:instanceId]` tag on each bullet point in memory content,
  alongside `[chat:id]`

This metadata enables instance-aware retrieval during memory search and lets the
entity identify the source of individual memories when multiple embodiments
contribute to the same file.

### Vector Clocks

Distributed versioning uses vector clocks (`src/sync/versioning.ts`) to track
causality across embodiments. Each embodiment maintains its own clock, and
conflicts are detected when clocks are concurrent (neither dominates the other).

## Memory Hierarchy

Memories are organized hierarchically. All memories are **permanently retained**
— consolidation tiers produce supplementary summaries, not replacements.

```
daily → weekly → monthly → yearly
```

| Granularity     | Description                           | Status                                                                           |
| --------------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| **Daily**       | Auto-generated conversation summaries | Created during conversations (by embodiments)                                    |
| **Weekly**      | Consolidated from daily               | Startup catch-up + scheduler (Sun 5 AM UTC) + `memory_consolidate` tool          |
| **Monthly**     | Consolidated from weekly              | Startup catch-up + scheduler (1st of month 5 AM UTC) + `memory_consolidate` tool |
| **Yearly**      | Consolidated from monthly             | Startup catch-up + scheduler (Jan 1 5 AM UTC) + `memory_consolidate` tool        |
| **Significant** | Permanently remembered events         | Created manually                                                                 |

### Retention Model

All memories are kept permanently across all granularities. Daily memories are
never archived or deleted. The consolidation tiers (weekly/monthly/yearly) exist
to provide higher-quality distilled summaries for broad queries, while the
original daily memories preserve full detail.

SQLite + sqlite-vec scales well for this use case — even a lifetime of daily
memories (50 years × 365 days = ~18,000 entries, perhaps ~30,000 chunks with
longer consolidation tiers) is trivially small for vector search.

### Storage Layout

```
data/memories/
├── daily/          # YYYY-MM-DD_instance.md (per-instance)
├── weekly/         # YYYY-WNN.md
├── monthly/        # YYYY-MM.md
├── yearly/         # YYYY.md
└── significant/    # YYYY-MM-DD_slug.md
```

## Memory Search & Retrieval

`memory_search` uses per-sentence embedding and multi-signal ranking:

```
finalScore = (vectorScore × 0.8) + (recencyScore × 0.05) + (graphBoost × 0.05) + (instanceScore × 0.1)
```

### Per-Sentence Embedding

The user's message is split into sentences, and each sentence is embedded and
searched independently. KNN results are merged (deduplicated, keeping best score
per memory). This handles natural conversation where the actual topic is
embedded in a longer message alongside pleasantries and context. Capped at 5
sentences.

| Signal                | Weight | Description                                                       |
| --------------------- | ------ | ----------------------------------------------------------------- |
| **Vector similarity** | 0.8    | Semantic match via embeddings (all-MiniLM-L6-v2, 384 dims)        |
| **Recency**           | 0.05   | Inverse decay: `1 / (1 + age_days × 0.007)` — half-life ~100 days |
| **Graph boost**       | 0.05   | Boosts memories linked to entity nodes matching the query         |
| **Instance affinity** | 0.1    | +0.1 for memories from the same embodiment                        |

Default `minScore` is 0.25 — results below this are excluded.

### Date-Enriched Embeddings

Memory content is enriched with a human-readable date prefix before embedding
(e.g., `"Significant memory from February 14, 2026. [original content]"`). This
allows the embedding model to capture temporal semantics, so queries about dates
and events ("Valentine's Day", "our anniversary") can match memories even when
the event name isn't explicitly mentioned in the prose.

The enrichment is part of the embedding cache's content hash, so changing the
enrichment logic invalidates all cached embeddings. A schema version in
`graph.db` tracks the enrichment algorithm — when the version changes,
entity-core automatically rebuilds all embeddings on startup.

### How It Works

1. The query is embedded locally using the same model as Psycheros
   (`all-MiniLM-L6-v2`)
2. Entity nodes in the knowledge graph matching the query are found (for graph
   boosting)
3. **Cached embeddings** (preferred): KNN search against pre-computed embeddings
   stored in `graph.db` via sqlite-vec. Long memories (>3000 chars) are split
   into overlapping ~2048-char chunks, each embedded independently — results are
   deduplicated by parent memory, keeping the best chunk score. Returns top
   candidates in sub-second time. Embeddings are computed eagerly when memories
   are created/updated via MCP, and lazily on first search for any uncached
   memories.
4. **Full scan fallback**: If the embedding cache is empty (e.g., fresh
   install), all memory files are loaded, embedded, and cached as they go. Each
   file only needs to be embedded once — subsequent searches use the cached
   vector. Long memories are chunked during this process.
5. Each candidate memory is scored using the multi-signal formula above
6. Results are sorted by final score and filtered by `minScore`
7. Excerpts are returned: short memories (<2000 chars) in full; longer memories
   use the matched chunk's content directly, or fall back to keyword-matching on
   bullet sections

### Fallback

If vector search is unavailable (sqlite-vec not loaded, embedding model fails),
the system falls back to text-based substring matching with instance boosting.
The `method` field in results indicates which search method was used. On first
run, the sqlite-vec extension is automatically downloaded from GitHub releases
if not found in `lib/`.

### Instance Relevance

Results from the same embodiment are boosted, making memories contextually
relevant to the current interface — a memory created in Psycheros is slightly
more relevant when searching from Psycheros than from SillyTavern.

## Related Source Files

| File                                | Purpose                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/tools/memory.ts`               | Memory MCP tools (create, read, update, delete, search, list)                              |
| `src/consolidation/consolidator.ts` | Consolidation logic (daily→weekly→monthly→yearly), catch-up                                |
| `src/consolidation/periods.ts`      | ISO week helpers, period calculation, date filtering                                       |
| `src/consolidation/prompts.ts`      | LLM prompt templates for consolidation                                                     |
| `src/embeddings/mod.ts`             | Local embedding model (all-MiniLM-L6-v2)                                                   |
| `src/embeddings/cache.ts`           | Embedding cache — chunk-aware storage in `graph.db` with content-hash invalidation         |
| `src/embeddings/chunker.ts`         | Splits long memories into overlapping ~2048-char chunks for independent embedding          |
| `src/graph/memory-integration.ts`   | Auto-extract entities from memories into graph                                             |
| `src/tools/sync.ts`                 | Sync MCP tools (pull, push, status)                                                        |
| `src/sync/versioning.ts`            | Vector clock implementation                                                                |
| `src/sync/conflict.ts`              | Conflict resolution strategies                                                             |
| `src/storage/file-store.ts`         | File-based storage for identity and memory files                                           |
| `src/mod.ts`                        | Entry point, scheduler instantiation, consolidation schedule definitions, startup catch-up |
