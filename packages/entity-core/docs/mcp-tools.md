# MCP Tools Reference

Complete reference for all MCP tools exposed by entity-core. Tools are organized
by domain and use first-person descriptions reflecting the entity's perspective.
Tool names use forward-slash namespacing (e.g., `identity/get_all`).

## Identity Tools

| Tool                       | Description                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity/get_all`         | Get all my identity files (self, user, relationship, custom). Each file includes a `promptLabel` used for context wrapping.                                                                                                                                                                                                                                                                                   |
| `identity/write`           | Replace one of my identity files entirely (creates automatic pre-replace snapshot if file exists)                                                                                                                                                                                                                                                                                                             |
| `identity/append`          | Append content to the end of an identity file                                                                                                                                                                                                                                                                                                                                                                 |
| `identity/prepend`         | Prepend content to the beginning of an identity file                                                                                                                                                                                                                                                                                                                                                          |
| `identity/update_section`  | Append content to a specific markdown section (identified by `## heading`). Preserves existing section content. Auto-creates the section at end of file if the heading doesn't exist. Content must NOT include the `## heading` line — the system adds it automatically.                                                                                                                                      |
| `identity/rewrite_section` | **DESTRUCTIVE** — replace the entire content of a markdown section (heading preserved). Creates automatic pre-rewrite snapshot. Auto-creates the section at end of file if the heading doesn't exist. Content must NOT include the `## heading` line — the system adds it automatically. Prefer `identity/update_section` unless existing content is outdated, redundant, or needs fundamental restructuring. |
| `identity/delete_custom`   | Delete a custom identity file (custom category only)                                                                                                                                                                                                                                                                                                                                                          |
| `identity/get_meta`        | Get prompt labels for identity files. Optionally filter by category. Returns a `category/filename` → `promptLabel` map.                                                                                                                                                                                                                                                                                       |
| `identity/set_meta`        | Set the prompt label (XML tag name) for an identity file. Used to customize context wrapping.                                                                                                                                                                                                                                                                                                                 |

### Section Tool Behavior

`identity/update_section` and `identity/rewrite_section` both operate on `##` or
`###` markdown headings:

- **Heading found**: Content is placed within the existing section (between the
  heading and the next same/higher-level heading)
- **Heading not found**: The section is auto-created at the end of the file as
  `## heading\ncontent`
- **Content format**: The `content` parameter must NOT include the `## heading`
  line. A defensive strip runs server-side to prevent duplication if a heading
  is accidentally included.

`identity/rewrite_section` creates a snapshot before modifying (like
`identity/write`), while `identity/update_section` does not.

### Identity File Categories

- **`self/`** — Who I am (`my_identity`, `my_persona`, `my_personhood`,
  `my_wants`, `my_mechanics`)
- **`user/`** — Who I'm talking to (`user_identity`, `user_life`,
  `user_beliefs`, `user_preferences`, `user_patterns`, `user_notes`)
- **`relationship/`** — Our relationship (`relationship_dynamics`,
  `relationship_history`, `relationship_notes`)
- **`custom/`** — User-defined files (any valid `.md` filename — letters,
  numbers, underscores only)

## Memory Tools

| Tool                 | Description                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory/create`      | Create a new memory entry with instance tagging. For daily memories, merges with existing content if the file already exists — bullets are deduplicated by `[chat:id]` tag so importing from multiple sources (e.g., entity-loom runs at different times) appends new bullets instead of overwriting. Automatically extracts entities and relationships into the knowledge graph in the background (requires `ENTITY_CORE_LLM_API_KEY`). |
| `memory/search`      | Search my memories using multi-signal ranking (vector similarity, recency, graph context, instance affinity). Falls back to text matching if embeddings are unavailable.                                                                                                                                                                                                                                                                 |
| `memory/list`        | List my memories by granularity, with optional pagination and date range filtering                                                                                                                                                                                                                                                                                                                                                       |
| `memory/read`        | Read a single memory entry by granularity and date. Returns full content and metadata (source instance, version, timestamps).                                                                                                                                                                                                                                                                                                            |
| `memory/update`      | Overwrite a memory entry (no append merge). Use to correct inaccuracies in recorded memories. Preserves existing metadata (source instance, chat IDs), increments version, sets `updatedAt`. Re-extracts entities to the knowledge graph in the background. Tracks who made the edit via `editedBy`.                                                                                                                                     |
| `memory_consolidate` | Consolidate memories across time periods (daily→weekly, weekly→monthly, monthly→yearly). Use `all=true` for catch-up consolidation of all unconsolidated periods. Use `granularity` for a specific level. Requires `ENTITY_CORE_LLM_API_KEY`.                                                                                                                                                                                            |

### memory/create Inputs

| Field                    | Type     | Required | Description                                                                                                                                                                     |
| ------------------------ | -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `granularity`            | enum     | Yes      | One of: `daily`, `weekly`, `monthly`, `yearly`, `significant`                                                                                                                   |
| `date`                   | string   | Yes      | Date string matching `^\d{4}(-W\d{2}                                                                                                                                            |
| `content`                | string   | Yes      | Memory content (first-person perspective). Each bullet point should include `[chat:id]` and `[via:instanceId]` tags.                                                            |
| `chatIds`                | string[] | No       | Related conversation IDs                                                                                                                                                        |
| `instanceId`             | string   | Yes      | Current embodiment ID                                                                                                                                                           |
| `participatingInstances` | string[] | No       | Other embodiments involved                                                                                                                                                      |
| `slug`                   | string   | No       | Slug for significant memory filename (e.g., `first-conversation`). When provided, entity-core stores the file as `YYYY-MM-DD_slug.md` to match the embodiment's local filename. |

### memory/read Inputs

| Field         | Type   | Required | Description                                                   |
| ------------- | ------ | -------- | ------------------------------------------------------------- |
| `granularity` | enum   | Yes      | One of: `daily`, `weekly`, `monthly`, `yearly`, `significant` |
| `date`        | string | Yes      | Date string matching `^\d{4}(-W\d{2}                          |

### memory/read Output

Returns the full `MemoryEntry` object on success:

- `id`, `granularity`, `date`, `content`, `chatIds`, `sourceInstance`,
  `participatingInstances`, `version`, `createdAt`, `updatedAt`

### memory/update Inputs

| Field         | Type   | Required | Description                                                       |
| ------------- | ------ | -------- | ----------------------------------------------------------------- |
| `granularity` | enum   | Yes      | One of: `daily`, `weekly`, `monthly`, `yearly`, `significant`     |
| `date`        | string | Yes      | Date string matching `^\d{4}(-W\d{2}                              |
| `content`     | string | Yes      | New memory content (replaces existing entirely)                   |
| `editedBy`    | string | No       | Identifier for who made the edit (e.g., embodiment ID or "human") |

### memory/update vs memory/create

- `memory/create` is for the entity recording new memories from conversations
- `memory/create` merges daily memories when a file already exists for the same
  date and instance — bullets are deduplicated by `[chat:id]` tag, so importing
  from multiple sources appends new bullets without losing existing ones. The
  embedding cache is updated with the merged content.
- `memory/update` is for correcting existing memories (user-initiated edits from
  the Memories UI)
- `memory/update` preserves existing metadata (source instance, chat IDs,
  participating instances) but overwrites content entirely (no merge)
- `memory/update` increments version and sets `updatedAt` to now
- Both tools re-extract entities to the knowledge graph in the background

### memory/list Inputs

| Field         | Type   | Required | Description                                                                                     |
| ------------- | ------ | -------- | ----------------------------------------------------------------------------------------------- |
| `granularity` | enum   | No       | Filter to one granularity: `daily`, `weekly`, `monthly`, `yearly`, `significant`. Omit for all. |
| `limit`       | number | No       | Maximum results to return (1-100), default 20                                                   |
| `offset`      | number | No       | Skip first N results (for pagination), default 0                                                |
| `beforeDate`  | string | No       | Only include memories with date ≤ this value (YYYY-MM-DD)                                       |
| `afterDate`   | string | No       | Only include memories with date ≥ this value (YYYY-MM-DD)                                       |

### memory/list Output

| Field                       | Description                                                        |
| --------------------------- | ------------------------------------------------------------------ |
| `memories[].granularity`    | Granularity level                                                  |
| `memories[].date`           | Memory date string                                                 |
| `memories[].preview`        | First 100 characters of memory content                             |
| `memories[].sourceInstance` | Instance that created the memory (if available)                    |
| `total`                     | Total matching memories (before offset/limit), used for pagination |

Results are sorted by date, newest first. The `total` field enables clients to
implement pagination by comparing `offset + limit` against `total`.

### memory/search Inputs

| Field            | Type     | Required | Description                                                                                  |
| ---------------- | -------- | -------- | -------------------------------------------------------------------------------------------- |
| `query`          | string   | Yes      | Search query text                                                                            |
| `instanceId`     | string   | Yes      | Current embodiment ID (for instance affinity boosting)                                       |
| `queryEmbedding` | number[] | No       | Pre-computed query embedding (384 dims). If not provided, entity-core generates one locally. |
| `minScore`       | number   | No       | Minimum relevance score (0-1), default 0.3                                                   |
| `maxResults`     | number   | No       | Maximum results (1-50), default 10                                                           |

### memory/search Output

| Field                                                           | Description                                                 |
| --------------------------------------------------------------- | ----------------------------------------------------------- |
| `results[].score`                                               | Final multi-signal relevance score                          |
| `results[].tier`                                                | Granularity level (daily/weekly/monthly/yearly/significant) |
| `results[].ageDays`                                             | Memory age in days                                          |
| `results[].vectorScore`                                         | Raw semantic similarity score (0-1)                         |
| `results[].method`                                              | Search method used: `"vector"` or `"text"`                  |
| `results[].granularity`, `.date`, `.excerpt`, `.sourceInstance` | Original fields (backward compatible)                       |
| `searchMethod`                                                  | Overall method: `"vector"` or `"text"`                      |
| `vectorAvailable`                                               | Whether vector search was available                         |

See [sync-and-memory.md](sync-and-memory.md) for the memory hierarchy and
retrieval ranking details.

## Sync Tools

| Tool          | Description                                                              |
| ------------- | ------------------------------------------------------------------------ |
| `sync/pull`   | Pull all identity and memories from my core                              |
| `sync/push`   | Push changes from an embodiment to my core                               |
| `sync/status` | Check sync status, connected embodiments, and extraction pipeline health |

See [sync-and-memory.md](sync-and-memory.md) for the sync protocol and conflict
resolution details.

### sync/status Output

| Field                | Type   | Description                                        |
| -------------------- | ------ | -------------------------------------------------- |
| `serverVersion`      | number | Monotonically increasing server version            |
| `connectedInstances` | array  | `{id, lastSync}` for each connected embodiment     |
| `extraction`         | object | Extraction pipeline health diagnostics (see below) |

### sync/status extraction Field

| Field               | Type           | Description                                                                  |
| ------------------- | -------------- | ---------------------------------------------------------------------------- |
| `llmAvailable`      | boolean        | Whether an LLM client can be created (API key + model + base URL configured) |
| `lastAttempt`       | string \| null | ISO timestamp of last extraction attempt                                     |
| `lastSuccess`       | string \| null | ISO timestamp of last successful extraction (>=1 node/edge created)          |
| `lastError`         | string \| null | Error message from most recent failure                                       |
| `attemptsTotal`     | number         | Total extraction attempts since server start                                 |
| `successesTotal`    | number         | Successful extractions since server start                                    |
| `nodesCreatedTotal` | number         | Cumulative nodes created                                                     |
| `edgesCreatedTotal` | number         | Cumulative edges created                                                     |

## Snapshot Tools

| Tool               | Description                                |
| ------------------ | ------------------------------------------ |
| `snapshot/create`  | Create a snapshot of all my identity files |
| `snapshot/list`    | List available snapshots with metadata     |
| `snapshot/get`     | Get the content of a specific snapshot     |
| `snapshot/restore` | Restore identity files from a snapshot     |

See [snapshots.md](snapshots.md) for retention policies and restore procedures.

## Knowledge Graph Tools

The knowledge graph tracks durable state — relationships between concepts,
people, preferences, and beliefs. It complements hierarchical memory by
providing structured relationship data.

### Node Operations

| Tool                | Description                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `graph/node_create` | Create a node (self, person, emotion, topic, preference, etc.). Returns existing node if one with same label+type exists (duplicate prevention) |
| `graph/node_get`    | Get a node by ID                                                                                                                                |
| `graph/node_update` | Update node properties                                                                                                                          |
| `graph/node_delete` | Soft-delete a node                                                                                                                              |
| `graph/node_search` | Semantic search over nodes (uses sqlite-vec)                                                                                                    |
| `graph/node_list`   | List nodes by type                                                                                                                              |

### Edge Operations

| Tool                | Description                         |
| ------------------- | ----------------------------------- |
| `graph/edge_create` | Create a relationship between nodes |
| `graph/edge_get`    | Get edges by filters                |
| `graph/edge_update` | Update relationship properties      |
| `graph/edge_delete` | Delete a relationship               |

**Edge Types**: `feels_about`, `close_to`, `mentions`, `helps_with`, `worsens`,
`loves`, `dislikes`, `avoids`, `seeks`, `family_of`, `friend_of`, `reminds_of`,
and more. Arbitrary types are allowed.

### Graph Operations

| Tool             | Description                                              |
| ---------------- | -------------------------------------------------------- |
| `graph/traverse` | Traverse from a node (BFS, configurable depth/direction) |
| `graph/subgraph` | Extract related nodes as a subgraph                      |
| `graph/insights` | Discover patterns (bridges, clusters)                    |
| `graph/stats`    | Get graph statistics                                     |

### Batch Operations

| Tool                      | Description                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graph/write_transaction` | Create multiple nodes and edges atomically (supports optional `embedding` per node). Duplicate nodes are resolved by label+type. Reports skipped edges. |

See [knowledge-graph.md](knowledge-graph.md) for node types, edge types,
confidence scoring, and temporal tracking.

## Instance Types

When an embodiment connects, it identifies itself with an instance type:

```typescript
type InstanceType =
  | "psycheros"
  | "sby"
  | "sillytavern"
  | "openwebui"
  | "claude-code"
  | "other";
```

Adding a new embodiment type:

1. Add the type to `InstanceInfo.type` union in `src/types.ts`
2. Update any embodiment-specific logic (e.g., instance relevance boosting)
