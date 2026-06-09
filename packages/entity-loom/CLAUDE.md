# entity-loom — agent card

Migration wizard. Web UI on port 3210. Imports chat histories from external
platforms (ChatGPT, Claude, SillyTavern, Letta, Kindroid) into a self-contained
import package that Psycheros / entity-core can ingest. Built on Deno 2.x.

First-person convention applies — see [root CLAUDE.md](../../CLAUDE.md). LLM
prompts, memory content, and tool descriptions are written from the entity's
perspective: the entity remembers _their_ conversations, refers to the human by
name, and writes memories as their own experience.

## Commands

```bash
deno task start    # start the wizard server on port 3210
deno task test     # run tests
deno check src/main.ts
deno lint
```

User guide: [`docs/user-guide.md`](docs/user-guide.md).

## The five-stage pipeline

Only one stage runs at a time. Enforcement is in `src/server/stage-lock.ts`.

| Stage          | Code                              | Input                          | Output                      |
| -------------- | --------------------------------- | ------------------------------ | --------------------------- |
| 1. Setup       | `src/stages/setup-stage.ts`       | user form                      | `config.json`               |
| 2. Convert     | `src/stages/convert-stage.ts`     | export files                   | `chats.db` + `raw/`         |
| 3. Significant | `src/stages/significant-stage.ts` | `raw/_loom_conversations.json` | `memories/significant/*.md` |
| 4. Daily       | `src/stages/daily-stage.ts`       | `chats.db`                     | `memories/daily/*.md`       |
| 5. Graph       | `src/stages/graph-stage.ts`       | `memories/*`                   | `graph.db`                  |

Stages 3–5 run as background async tasks with SSE progress (`/api/events`),
abort support, and per-item checkpointing. Stage 5 is skippable — the checkpoint
marks it complete and finalize / download proceed without it.

## SSE and progress

The wizard uses Server-Sent Events (`src/server/sse.ts`) for real-time updates.
A 200-event ring buffer lets late-joining or reconnecting clients replay recent
state. **The client must close the old EventSource before creating a new one** —
EventSource auto-reconnects by default, so failing to close creates duplicate
connections and double-processed events.

`stage-lock.ts` holds a progress snapshot (`setProgressSnapshot` /
`getProgressSnapshot`) alongside the running-stage lock. Each background stage
updates it on every progress broadcast. `/api/status` includes this snapshot as
`runningStage` + `progress`, so a page reload can restore the progress bar
without relying on SSE buffer replay alone.

Client-side DOM performance matters for long runs (hundreds of conversations):
`addLogEntry` uses `insertAdjacentHTML` with a 500-entry cap, and memory list
refreshes are debounced — never call `loadMemories` on every `item_completed`
event directly.

## Module structure

Each `src/*/` has a `mod.ts` barrel.

- `src/llm/` — OpenAI-compatible client. `buildCachingHeaders()` adds
  provider-specific headers (Anthropic prompt-caching beta, OpenRouter
  `HTTP-Referer`/`X-Title`). `modelSupportsTemperature()` guards temperature for
  models that reject it (OpenAI o-series, GPT-5.x, DeepSeek reasoner).
- `src/server/` — HTTP, SSE, router, logger, cost estimator, stage-lock
- `src/stages/` — one file per wizard stage
- `src/parsers/` — one file per platform; ChatGPT is split into a dispatcher
  (`chatgpt.ts`), an official export parser (`chatgpt-official.ts`), a plugin
  export parser (`chatgpt-plugin.ts`), and shared types/utilities
  (`chatgpt-shared.ts`)
- `src/writers/` — DB and memory file writers
- `src/pipeline/` — chunker, signaled LLM wrapper
- `src/dedup/` — checkpoint / resume state
- `src/llm/` — OpenAI-compatible client

## Adding a platform parser

1. Create `src/parsers/<platform>.ts` implementing `PlatformParser`.
2. Register it in `src/parsers/mod.ts`.
3. Add the platform key to `PlatformType` in `src/types.ts`.

All parsers use `buildTitle()` from `src/parsers/title-utils.ts` for consistent
`[platform] Title` formatting with date-range fallback.

## Checkpoint / resume

`CheckpointStateV2` is canonical. v1 packages migrate automatically — old pass
fields map to new stage fields. Packages can be resumed or purged from the Setup
panel (purge deletes the entire package directory).

## The chats.db platform-column trap

`chats.db` carries a `conversations.platform` column **during processing** so
memory writers can emit `[via:platform]` tags. **Finalize strips this column**
to match the Psycheros schema exactly. If you query `chats.db` from elsewhere,
branch on whether the column is present — pre-finalize it exists, post-finalize
it doesn't.

Memory `[via:platform]` tags come from the per-conversation source platform
stored in this column, not the tool's instance ID. Daily memory filenames stay
`<date>_entity-loom.md` (tool identity, not platform).

## Staging re-population

`staging.db` persists across wizard sessions. When staging is re-populated
(e.g., re-running with the same package), conversations that already exist are
**not skipped** — their content is updated if changed, and `included` is always
reset to `1`. This prevents stale exclusion state from a prior session from
hiding conversations.

## Staging vs. chats DB

`staging.db` is a separate database (browse / search / tag palette / Psycheros
comparison). It's excluded from the export ZIP. Don't conflate it with
`chats.db` — they have different schemas and lifecycles.

The "Export Only" fast-track path commits selected conversations to `chats.db`,
finalizes immediately, skips stages 3–5, and goes straight to the download
screen. If tagged conversations are included, the `chats.db` inside the ZIP is
renamed with the tag names (e.g. `entityA-entityB-chats.db`).

## Graph stage shape

Graph extraction is batched. Daily memory files run in batches of ~14 (roughly
two-week increments) in a single LLM call — this reduces API calls and improves
entity consistency across memories. Significant memories are still extracted one
at a time. No content is truncated at any stage; chunking is at message
boundaries when needed.

Entity types are restricted to `self`, `person`, `place`, `health`, `tradition`.
Abstract types (`topic`, `insight`, `preference`, `boundary`, `goal`) are
deliberately excluded to keep extraction high-signal.

## Package output

```
.loom-exports/{entityName}-{platform}/
├── manifest.json
├── config.json
├── checkpoint.json
├── chats.db          # platform column stripped after finalize
├── staging.db        # excluded from ZIP
├── memories/
│   ├── daily/
│   └── significant/
├── graph.db
└── raw/
    ├── _loom_conversations.json
    └── uploads.json
```

`/api/download` streams the package as a ZIP after finalization. An optional
`?tags=` query parameter renames `chats.db` inside the ZIP.

## REST API

All operations are `/api/*`. Staging endpoints under `/api/staging/*` (populate,
conversations CRUD, bulk tags, search, palette CRUD, commit, export-only,
Psycheros compare / autodetect). SSE at `/api/events` for real-time progress.

## Companion packages

This package lives in the [Psycheros monorepo](../../README.md). Sibling
packages: [`psycheros`](../psycheros/) (the primary harness — imports
entity-loom packages) and [`entity-core`](../entity-core/) (the MCP server for
identity and memory).
