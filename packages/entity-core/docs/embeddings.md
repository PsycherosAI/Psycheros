# Embeddings

Deep reference for my embedding pipeline — how memory text becomes vectors, how
the cache stays consistent across model and chunk-size changes, and how rebuilds
run without blocking stdio. The load-bearing traps (the Xenova cache override,
event-loop yielding during rebuilds, the shared cache instance) live in
"Embedding maintenance" in [`../CLAUDE.md`](../CLAUDE.md).

## Date-prefix enrichment

Memory content is enriched with a human-readable date prefix before embedding
(e.g., `"Significant memory from February 14, 2026. [original content]"`), so
temporal queries can match memories by date.

## Dynamic vector dimension

The vec0 dimension is dynamic: `EMBEDDING_DIMENSION` in `graph/types.ts` is
`DEFAULT_EMBEDDING_DIMENSION` plus a `getActiveEmbeddingDimension()` getter that
reads the env var at runtime. Vec0 DDL sites
(`graph/schema.ts:vectorTableSql(dim)` and
`embeddings/cache.ts:vectorTableSql(dim)`) take dim as a parameter, so every DDL
site reads the active dimension at call time.

Long memories (>3000 chars) are split into ~2048-char overlapping chunks, each
embedded independently (`src/embeddings/chunker.ts`); short memories get a
single embedding.

## Schema fingerprint

`EmbeddingCache` stores a composite JSON fingerprint in
`embedding_metadata.schema_version`:

```json
{
  "algorithm": 3,
  "chunkParamsHash": "3000:2048:400:2800:200",
  "modelRepoId": "Cohee/jina-embeddings-v2-base-en"
}
```

When the fingerprint changes, `getRebuildReason()` classifies the change:

| Reason                                                    | Behavior                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`                                                   | **Refused at boot.** Model swaps are migrations my Psycheros parent owns (graph nodes included, via `embedding_rebuild_all`), reported to the parent as a `model_change_detected` notification so it can offer the re-index flow.                                                                               |
| `algorithm` / `chunk_params` / `unparseable` (legacy int) | Runs `autoRebuildEmbeddings()` → `createMemoryEmbeddingRebuildHandler` (memory cache only), in the **background**: the boot path doesn't await it, the handler yields to the event loop between items (stdio requests and pings keep being answered), and the fingerprint is marked up-to-date only on success. |

## Rebuild notifications

While any rebuild runs, I send `notifications/embedding-rebuild` JSON-RPC
notifications (custom method; `src/embeddings/rebuild-notify.ts`):

- `started` (with total)
- `progress` (every 25 items)
- `done`
- `failed`
- `model_change_detected`

My Psycheros parent pauses its health-ping watchdog on `started`/`progress` and
resumes on `done`/`failed`; the same events drive the user's re-index banner. A
rebuild mutex (`tryAcquireRebuild`) prevents boot rebuild, backfill, and
`embedding_rebuild_all` from interleaving.

## Maintenance tools

The three MCP tools that manage the embedding cache in `graph.db`
(`memory_embedding_purge`, `memory_embedding_rebuild`, `embedding_rebuild_all`)
are documented with full schemas in [`mcp-tools.md`](mcp-tools.md).
