# Memory System & RAG

Psycheros implements a hierarchical memory system where the entity writes their
own memories from conversations. Memory storage and retrieval are delegated
entirely to
[entity-core](https://github.com/PsycherosAI/Psycheros/tree/main/packages/entity-core)
via MCP — Psycheros maintains no local memory files. Three RAG systems provide
contextual recall.

## Memory Architecture

**Entity-core is the sole authority for all memories.** Psycheros reads, writes,
searches, and deletes memories exclusively through MCP tool calls. This
eliminates sync issues, stale local copies, and duplicate indexing.

What Psycheros still manages locally:

- **Chat history** — conversations and messages in SQLite
- **Chat RAG** — vector search over conversation history (Discord conversations
  excluded)
- **Data Vault RAG** — document storage and eager search
- **Memory summary tracking** — `memory_summaries` and `summarized_chats` DB
  tables record which days have been summarized (prevents re-processing)
- **Discord pre-summarization** — condenses Discord activity into a digest
  before injecting into daily memory writer

What entity-core manages:

- **Memory storage** — all memory files (daily, weekly, monthly, yearly,
  significant)
- **Memory RAG** — vector indexing and semantic search over memories
- **Consolidation** — weekly/monthly/yearly summarization through the durable
  scheduler with catch-up

## Memory Hierarchy

Memories are written in the entity's voice (first-person), referring to the user
by their actual name and preferred pronouns. All summarization LLM calls receive
the entity's full identity context as a system message, so memories reflect the
entity's personality and knowledge of the user. They are organized
hierarchically and consolidated over time.

Daily summarization runs in Psycheros (it has conversation context) but writes
the result to entity-core via MCP. When `PSYCHEROS_DISPLAY_TZ` is configured,
the schedule fires at 5 AM in the user's local timezone and messages are grouped
by logical local date (a 5 AM cutoff means messages from 5 AM today to 4:59 AM
tomorrow are the same "day"). Without a configured timezone, it falls back to
`PSYCHEROS_MEMORY_HOUR` at UTC (default: 4 AM). Weekly, monthly, and yearly
consolidation runs in entity-core through its own scheduler, independently of
whether any Psycheros instance is connected. All schedules have
`fire_once_then_align` catch-up — if a daemon was down at the fire time, it runs
once on next boot and resumes the normal cadence.

```
entity-core/data/memories/        (canonical storage — managed by entity-core)
├── daily/           # Daily summaries (auto-generated, per-instance)
│   └── 2026-02-22_psycheros.md
├── weekly/          # Weekly consolidation (Sundays)
│   └── 2026-W08.md
├── monthly/         # Monthly consolidation (1st of month)
│   └── 2026-02.md
├── yearly/          # Yearly consolidation (Jan 1st)
│   └── 2026.md
└── significant/     # Permanently remembered events (never consolidated)
    └── 2026-04-13_first-conversation.md
```

### Memory Types

| Type            | Description                                          | Created By                                    | Stored In   |
| --------------- | ---------------------------------------------------- | --------------------------------------------- | ----------- |
| **Daily**       | Auto-generated conversation summaries                | Psycheros via MCP                             | entity-core |
| **Weekly**      | Consolidated from daily entries                      | entity-core scheduler (Sunday 5 AM UTC)       | entity-core |
| **Monthly**     | Consolidated from weekly entries                     | entity-core scheduler (1st of month 5 AM UTC) | entity-core |
| **Yearly**      | Consolidated from monthly entries                    | entity-core scheduler (Jan 1st 5 AM UTC)      | entity-core |
| **Significant** | Emotionally important events, permanently remembered | Entity via `create_significant_memory` tool   | entity-core |

### Trigger

On startup and via the daily schedule, Psycheros checks for unsummarized dates —
days where messages exist but no `summarized_chats` row covers them. The
schedule fires at 5 AM in the user's local timezone (when `PSYCHEROS_DISPLAY_TZ`
is set), or at `PSYCHEROS_MEMORY_HOUR` UTC (default: 4 AM) as a fallback. On
startup, `repairOrphanedSummaries()` detects DB records where the corresponding
memory doesn't exist in entity-core (e.g., from a failed MCP write), clears
them, and re-summarizes.

When a date already has an owned daily memory in entity-core (created by this
Psycheros instance or by entity-loom), catch-up skips re-summarizing it but
still records the skip locally so it doesn't re-query entity-core on every
restart. The skip path writes **both** tables: a row in `memory_summaries` (via
`upsertMemorySummary`) and one `summarized_chats` row per conversation with
messages on that date (via `markConversationsForDateSummarized`). Both writes
are required — `getUnsummarizedDates` LEFT JOINs `summarized_chats`, so writing
only `memory_summaries` leaves the date re-appearing as unsummarized on every
boot.

Imported conversations (from entity-loom) are excluded from summarization since
entity-loom handles memory extraction during its pipeline. These are tagged with
`source_type = 'import'` — a one-time migration retroactively tags existing
imports by their `[platform]` title prefix, and the import endpoint sets the tag
for new imports going forward. Discord conversations are also excluded.

### Context-Aware Chunking

Active chat days can produce more conversation content than the worker model's
context window allows. Rather than failing or truncating (which loses memories),
the summarizer splits conversations into chunks that fit within the token budget
and summarizes each independently, then merges the bullet points into a single
memory file.

The budget is calculated from the active profile's `contextLength`: identity
system message, prompt template, platform activity, custom instructions, output
reserve (500 tokens), and a safety margin are subtracted to determine how many
tokens are available for conversation content. Conversations are grouped into
chunks by accumulating until the budget would be exceeded. A single conversation
that exceeds the budget on its own is recursively split in half by messages
until each piece fits — important for companion-style threads that can span
thousands of messages in a single day. Every message is included in exactly one
chunk; no memories are silently dropped.

If a chunk fails (e.g., the model rejects an oversized single conversation), the
error is logged and remaining chunks continue. A partial result still produces a
memory file with whatever was successfully summarized. When no `contextLength`
is available (no active profile), the summarizer behaves as before with no
chunking.

### Discord Integration

Discord activity is integrated into daily memories via a **pre-summarizer** — a
lightweight worker model call that condenses raw Discord messages into a
first-person summary before the daily memory writer processes them. This
prevents high-volume channels from blowing out the daily memory context window.

**Flow:**

1. Daily memory writer collects web conversations (Discord excluded by
   `sourceType` filter)
2. If `includeInDailyMemories` is enabled in Discord gateway settings, the
   pre-summarizer runs:
   - Collects Discord messages for the date via
     `getMessagesByDate(date, modifier, "discord")`
   - Groups by server/channel, formats with headers
   - Truncates from oldest to newest if total exceeds 100k chars (~25k tokens) —
     FIFO safeguard
   - Calls worker model with entity's full identity context, producing a
     first-person summary
3. The Discord summary is injected into the daily memory prompt as a
   `{{PLATFORM_ACTIVITY}}` section
4. Entity writes memories referencing both web and Discord activity, using
   synthetic chat IDs (e.g. `[chat:Discord-Psycheros-2026-05-08]`)
5. Real Discord conversation IDs are tracked in `summarized_chats` alongside
   synthetic IDs

**Settings** (Discord gateway config, `.psycheros/discord-gateway.json`):

- `includeInDailyMemories` (boolean, default true) — toggle in Settings >
  External Connections > Channels > Discord
- `memoryInstructions` (string) — optional instructions block for handle mapping
  (e.g., "superdog420 is James"), written in first-person from the entity's
  perspective

### Custom Daily Memory Instructions

Users can configure additional instructions that the entity follows when writing
daily memories. These are stored in `.psycheros/memory-settings.json` as
`{ dailyInstructions: string }` and injected into the daily summarization prompt
between the base guidelines and the conversation data.

Instructions are written in first-person from the entity's perspective (e.g., "I
do not include vitamin reminders in my daily memories"). They are
Psycheros-specific — different embodiments can have different memory-writing
directives. The field defaults to empty (no custom instructions).

Configured via the **Instructions** tab in Settings → Memories.

**Exclusions:**

- Discord messages are excluded from Chat RAG embedding (they get their own
  summary path through daily memories)
- Discord conversations are excluded from the main daily summarization pipeline
  (handled separately via pre-summarizer)

### Consolidation Schedule

- **Daily summarization**: Psycheros scheduler at 5 AM local time (or
  `PSYCHEROS_MEMORY_HOUR` UTC fallback) — uses the active profile's worker
  model, stored in entity-core
- **Weekly**: entity-core scheduler (Sunday 5 AM UTC) — `fire_once_then_align`
  catch-up policy
- **Monthly**: entity-core scheduler (1st of month 5 AM UTC) —
  `fire_once_then_align` catch-up policy
- **Yearly**: entity-core scheduler (January 1st 5 AM UTC) —
  `fire_once_then_align` catch-up policy

Weekly, monthly, and yearly consolidation run independently in entity-core
regardless of whether Psycheros is connected. Each handler internally finds and
processes any missed periods, so a single catch-up fire after extended downtime
is enough to bring the hierarchy current.

### Instance Tagging

Memories are tagged with `sourceInstance` to track which embodiment created
them. Daily memory bullet points include inline `[chat:id]` and
`[via:instanceId]` tags so the entity can identify the source of individual
memories when multiple embodiments contribute to the same file. Consolidated
memories (weekly, monthly, yearly) preserve `[via:instanceId]` tags but omit
`[chat:id]` tags — these are thematic summaries, not conversation logs.

### MCP Requirements

Memory operations require entity-core to be connected
(`PSYCHEROS_MCP_ENABLED=true`). If MCP is unavailable:

- Daily summarization does not run (no point — memories can't be stored)
- Memory browser UI returns 503 errors
- `create_significant_memory` tool fails with an error message

## RAG Systems

Three RAG systems provide contextual information before each LLM call, plus the
Data Vault for user/entity-uploaded documents.

### Memory RAG (via MCP)

Retrieves relevant memories from entity-core's memory store via the
`memory_search` MCP tool.

1. **Query**: Before processing each message, the user's message is sent to
   entity-core's semantic memory search
2. **Results**: Entity-core returns scored excerpts with granularity, date, and
   relevance percentage
3. **Context**: Retrieved memories are injected into the system prompt with
   relevance scores
4. **No local indexing**: All memory embeddings and vector search happen in
   entity-core
5. **Excerpt behavior**: Short memories (<2000 chars) are returned in full;
   longer memories get the most relevant section with context (~512 tokens). No
   truncation markers.

### Memory Recall Tool (`memory_recall`)

A deliberate recall tool for when the automatic eager RAG pass doesn't surface
something the entity should know. The entity uses this when someone explicitly
asks it to try harder to remember, or when it senses a gap in its recall.

**Two-phase operation:**

1. **Search mode** (`query` parameter): Runs semantic search (`memory_search`)
   and keyword search (`memory_grep`) in parallel against entity-core, merges
   and deduplicates the results, and returns a compact hit list. Each result
   shows the memory title, date, source tags (`semantic:X%`, `keyword:Y%`), a
   `memory_id` for the read phase, and a ~300 character preview.
2. **Read mode** (`granularity` + `date`, optionally `slug`): Reads a single
   memory in full by its identifier from the hit list. The entity only reads the
   specific memories it needs, keeping context token usage controlled.

The hybrid approach catches both semantically related content (via embeddings)
and exact keyword matches (via text grep), compensating for limitations in
either method individually.

**Known limitation**: entity-core embeds each memory file as a single blob
truncated to 3000 chars. Daily and weekly memories are typically under 3KB, but
monthly/yearly/significant memories may grow beyond this over time, making
content past the 3000-char mark unsearchable. The old Psycheros chunker split
files into ~512-token pieces and embedded each independently — entity-core does
not currently do this.

**Embedding maintenance:** Two MCP tools manage the memory embedding cache.
`memory_embedding_purge` removes orphaned entries left behind after manual file
deletion (prevents ghost search results). `memory_embedding_rebuild` clears and
re-embeds all memory files from scratch. Both are available from Settings >
Entity Core > Maintenance. Knowledge graph embeddings are separate and
unaffected.

### Chat RAG

Semantic search over conversation history.

1. **Automatic Indexing**: Every message is embedded when saved (non-blocking).
   Discord messages are excluded — they get their own summary path through daily
   memories.
2. **Tiered Search**: First searches current conversation; if no good matches
   (score < 0.5), expands to all conversations
3. **Relevance Filtering**: Only messages above minimum similarity score (0.3)
   are included
4. **Historical Context**: Helps the entity remember what was discussed
   previously
5. **Thread Tagging**: Each retrieved message includes a trailing `[chat:id]`
   tag matching the daily memory convention, so the entity can identify which
   conversation a message originated from

One-time migration for existing messages:

```bash
deno run -A scripts/index-messages.ts
```

### Graph RAG

Knowledge graph context when MCP is enabled. The entity can both read from and
write to its knowledge graph during conversation. The graph is a relational
index of durable state (relationships, preferences, attributes) — not narrative
memory.

**Context injection (automatic):**

1. **Semantic Search**: Queries the knowledge graph for relevant nodes using
   vector similarity (embeddings auto-generated via all-MiniLM-L6-v2)
2. **Graph Traversal**: Follows edges to find connected concepts (depth 1 by
   default)
3. **Anchor Nodes**: Includes "me" and "user" nodes when referenced by edges in
   the result set
4. **Context Injection**: Relevant nodes and relationships are formatted in
   compact one-line-per-relationship format and added to the system prompt

Total graph nodes are capped at 50 — after traversal and dedup, nodes are ranked
by query-relevance score and the top 25 are kept (edges between dropped nodes
are pruned).

**Context format example:**

```
---
Relevant Knowledge from Graph:
user friends_with Sarah (had a bad argument Aug 2020, reconciled since)
user drives_a Subaru (red 2010 WRX)
Sarah dating Mike (met through user)
```

**Graph building (via tools):**

- The entity can create/update nodes and edges during conversation using 7 write
  tools
- All node creation auto-generates vector embeddings for semantic search
- Duplicate prevention: creating a node with an existing label+type returns the
  existing node
- Batch operations support referencing existing nodes by label (e.g., "me",
  "user")
- Only durable state should be stored (people, preferences, places, goals,
  beliefs, health) — events and episodes belong in the memory system

Requires `PSYCHEROS_MCP_ENABLED=true`.

### Vault RAG (Data Vault)

Eager RAG over user-uploaded and entity-created reference documents. Documents
are chunked, embedded, and proactively searched every turn — always available,
no keyword triggers needed.

**Document storage:**

- Users upload via Settings → Data Vault UI or `POST /api/vault` (supports .md,
  .txt, .pdf, .docx, .xlsx)
- Entity creates/updates via `vault` tool (saved as markdown)
- Template seeding: `.md` files in `templates/vault/` are automatically indexed
  into the global vault on first startup (skipped if already present). Used for
  pre-populated documents like welcome messages.
- Files stored at `.psycheros/vault/documents/{global|chat-{convId}}/`
  (persisted across Docker container recreations)
- Content extracted, chunked (512 tokens), embedded (all-MiniLM-L6-v2, 384 dims)

**Scope:**

- **Global** — available in every conversation
- **Per-chat** — only searched in the matching conversation

**Retrieval:**

1. Every turn, the user message is embedded and compared against all vault
   chunks
2. Always includes global documents; per-chat documents only when conversation
   matches
3. Top results (default 5 chunks, 1500 token budget, min 0.3 similarity)
   formatted and injected
4. Falls back to in-memory cosine similarity when sqlite-vec is unavailable

**Context injection order:** base instructions → identity → lorebook → **vault**
→ memories → chat history → graph

### Lorebook RAG (Context Books)

Keyword-triggered content injection from configurable entries organized into
lorebooks. Entries can be sticky (persist across multiple turns) with
configurable duration and re-trigger behavior.

**Evaluation pipeline** (runs every turn):

1. Scan user message for trigger matches
2. Scan recent history respecting each entry's `scanDepth`
3. Process sticky entries — decrement turn counter, check re-triggers
4. Recursion pass — entry content can trigger other entries (unless prevented)
5. Sort by priority and build context string

**Sticky behavior:**

- Sticky entries remain active for `stickyDuration` user turns after triggering
- Turn counters are scoped per conversation — activity in other threads doesn't
  affect sticky state
- Pulse/automated turns do NOT consume sticky duration (counters are preserved)
- Fresh triggers from Pulse messages still work (e.g., trigger word in Pulse
  text re-triggers the entry)
- `reTriggerResetsTimer`: when true (default), re-triggering resets the counter
  to `stickyDuration - 1`
- State persisted in `lorebook_state` table, keyed by
  `(conversation_id, entry_id)`

**Entity tools:**

| Tool    | Description                                                         |
| ------- | ------------------------------------------------------------------- |
| `vault` | Manage vault documents (write, read, append, rewrite, list, search) |

### Vector Search Backend

- **Primary**: sqlite-vec extension for efficient vector similarity search. The
  native binary is downloaded from upstream GitHub releases (v0.1.9) on first
  run into `lib/vec0.{so,dylib,dll}` for the current platform.
- **Fallback**: In-memory cosine similarity calculation when the extension is
  unavailable (e.g., the download failed and there is no cached binary).
- **Embeddings**: HuggingFace `all-MiniLM-L6-v2` model (384 dimensions)
- **Used for**: Chat RAG, Vault RAG, Graph RAG (all local to Psycheros)
- **Memory RAG**: Handled by entity-core via MCP (not local)

## Related Source Files

| File                               | Purpose                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/memory/mod.ts`                | Memory module barrel — daily summarization, trigger, catch-up, orphan repair                               |
| `src/memory/summarizer.ts`         | Daily summarization with identity context, Discord pre-summarizer injection, writes to entity-core via MCP |
| `src/memory/discord-summarizer.ts` | Discord pre-summarizer — first-person condensation of platform activity for daily memory injection         |
| `src/memory/trigger.ts`            | Startup catch-up, orphan repair, cron setup                                                                |
| `src/memory/file-writer.ts`        | Content formatting utilities (extractChatIds, formatMemoryContent)                                         |
| `src/memory/types.ts`              | Memory types, date formatting, instance tagging                                                            |
| `src/memory/memory-settings.ts`    | Load/save custom daily memory instructions (`.psycheros/memory-settings.json`)                             |
| `src/memory/date-utils.ts`         | Timezone-aware logical date helpers for message grouping                                                   |
| `src/mcp-client/mod.ts`            | MCP client — createMemory, readMemory, searchMemories, listMemories, deleteMemory, updateMemory            |
| `src/rag/mod.ts`                   | RAG retrieval system (chat, vault, graph — memory RAG removed)                                             |
| `src/rag/embedder.ts`              | HuggingFace transformer embeddings                                                                         |
| `src/rag/conversation.ts`          | ChatRAG for chat history                                                                                   |
| `src/rag/context-builder.ts`       | Formats retrieved memories for context                                                                     |
| `src/db/vector.ts`                 | sqlite-vec helpers, serialization, search                                                                  |
| `src/vault/mod.ts`                 | Data Vault barrel exports                                                                                  |
| `src/vault/manager.ts`             | VaultManager — CRUD, chunking, embedding, vector search                                                    |
| `src/vault/processor.ts`           | Text extraction from .md/.txt/.pdf/.docx/.xlsx                                                             |
| `src/vault/retriever.ts`           | Vault context formatting for system message                                                                |
| `src/vault/types.ts`               | Vault type definitions                                                                                     |
| `src/tools/vault-tools.ts`         | `vault` — unified vault document management tool                                                           |
