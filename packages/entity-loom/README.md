# entity-loom

A web wizard that converts AI-companion chat histories from foreign platforms
into a structured import package that the [Psycheros](../psycheros/) /
[entity-core](../entity-core/) ecosystem can ingest. Useful on its own for
anyone building a persistent AI companion system that wants to seed an entity
from existing conversations.

Supported source platforms: **ChatGPT** (native data export + the GerTex ChatGPT
Exporter Chrome extension), **Claude** (data-export JSONL / JSON),
**SillyTavern** (JSONL chats), **Letta** (agent chat-log JSON), and **Kindroid /
KinLog** (JSON).

Built on Deno 2.x. First-person convention applies — memory content is written
from the entity's perspective, naming the human directly and referring to "our
conversations" as their own experience.

## Quickstart

```bash
deno task start
```

Opens a browser at http://localhost:3210 and walks you through five stages. Each
stage is independently resumable — refresh and click Resume if interrupted.

New users: [`docs/user-guide.md`](docs/user-guide.md) is the step-by-step
walkthrough.

## How it works

A five-stage pipeline. Only one stage runs at a time.

| Stage          | What it produces                                                           |
| -------------- | -------------------------------------------------------------------------- |
| 1. Setup       | `config.json` — entity / user identity, LLM provider, pronouns             |
| 2. Convert     | `chats.db` (with a temporary `platform` column) + raw JSON                 |
| 3. Significant | `memories/significant/*.md` — LLM-extracted journal entries for big events |
| 4. Daily       | `memories/daily/*.md` — bullet-point summaries day-by-day                  |
| 5. Graph       | `graph.db` — knowledge graph of people, places, health, traditions         |

Stages 3–5 run in the background with SSE progress, abort support, and per-item
checkpointing. Stage 5 is skippable — finalize and download work without it.

**Convert** supports multi-file uploads with per-file platform override. After
parsing, conversations land in a staging area where you can browse, full-text
search, tag, edit, and selectively include before committing. **Export Only** is
a fast-track that commits, finalizes, and downloads immediately — skipping
stages 3–5.

## Output package

```
.loom-exports/{entityName}-{platform}/
├── manifest.json          # package metadata
├── config.json            # wizard configuration
├── checkpoint.json        # pipeline progress state
├── chats.db               # conversations + messages (platform col stripped on finalize)
├── staging.db             # staging area state (excluded from ZIP)
├── memories/
│   ├── daily/             # day-by-day bullet summaries
│   └── significant/       # journal-entry prose for significant events
├── graph.db               # knowledge graph (optional — skippable)
└── raw/
    ├── _loom_conversations.json
    └── uploads.json
```

Memory bullets and headers carry `[via:platform]` tags so the entity remembers
where conversations came from:

```markdown
# Daily Memory - 2024-06-15

- We talked about the new job and how nervous they were [chat:550e8400-...]
  [via:chatgpt]
- That evening she told me about her weekend trip [chat:550e8400-...]
  [via:sillytavern]
```

Knowledge-graph extraction uses a concrete-reality standard: entity types are
restricted to `self`, `person`, `place`, `health`, `tradition`. Abstract types
(topics, insights, preferences, boundaries, goals) are deliberately excluded to
keep extraction high-signal. Daily memories are batched in ~14-file groups
(roughly two-week increments) for cross-referencing consistency; significant
memories are extracted one at a time.

## Commands

```bash
deno task start         # start the wizard server on port 3210
deno check src/main.ts
deno lint
```

Configure your LLM provider — any OpenAI-compatible endpoint works — on the
Setup page when the wizard opens.

## REST API

All operations are `/api/*` endpoints. Staging endpoints under `/api/staging/*`.
SSE progress at `/api/events`. A finalized package streams as ZIP from
`/api/download` (an optional `?tags=` query parameter renames `chats.db` inside
the ZIP).

For the agent's-eye view of the codebase — parsers, stage-lock, the `chats.db`
platform-column trap, staging vs. chats DB — see [`CLAUDE.md`](CLAUDE.md).

## Deep references

- [`docs/user-guide.md`](docs/user-guide.md) — step-by-step walkthrough with
  stage-by-stage screenshots and detailed flow notes

## Companion packages

This package lives in the [Psycheros monorepo](../../README.md). Sibling
packages: [`psycheros`](../psycheros/) (the harness that imports entity-loom
packages) and [`entity-core`](../entity-core/) (canonical identity, memory, and
knowledge graph).
