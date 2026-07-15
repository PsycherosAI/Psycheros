# Changelog

All notable changes to entity-loom are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this package follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.9] - 2026-07-15

### Fixed

- Updated same-thread reimports are no longer treated as duplicates. The convert
  stage skipped any conversation whose ID was in `processedItems` before
  checking content hash, and the DB writer used `INSERT OR IGNORE` on both the
  conversation row and messages — so a ChatGPT thread imported at 5 messages
  stayed frozen at 5 messages forever, even if the user re-imported the same
  thread after it grew. Parse now computes the hash first; a same-ID +
  different-hash conversation is treated as an updated reimport, included in the
  preview, and committed via `ON CONFLICT DO
  UPDATE`. The DB writer clears
  prior messages for the conversation before re-inserting, so the new message
  list fully replaces the stale snapshot. Message timestamps round-trip exactly
  as the import supplied them (`msg.createdAt.toISOString()`) — daily-memory
  grouping depends on them. For updated conversations, the significant stage's
  `processedItems` entry is cleared so a future Significant run picks up the new
  content. Entries in `raw/_loom_conversations.json` are also replaced (not just
  appended), so subsequent runs hash against the most recent committed version.
- Post-finalize commits no longer crash on the missing `platform` column.
  `DBWriter.writeConversation()` unconditionally wrote to
  `conversations.platform`; after finalize the column is dropped to match the
  Psycheros schema, so any post-finalize commit failed with
  `table conversations has no column named platform`. `DBWriter` now detects
  column presence via `pragma_table_info` and branches the upsert
  (with-or-without platform). `stripPlatformColumn()` is also idempotent now,
  and `getConversationPlatform()` returns `null` instead of throwing when the
  column is gone. Without this, #14's updated-reimport path couldn't write to a
  finalized package.
- Upload dedup now keys on content hash, not filename alone. Re-uploading a file
  with the same name and same bytes still replaces the manifest entry in place
  (no inflation of the upload count). But two genuinely different files that
  happen to share a name — for example, two ChatGPT accounts both exporting
  `conversations.json` — now coexist on disk under disambiguated names
  (`conversations.json`, `conversations.1.json`, ...) instead of the second
  upload silently clobbering the first. Manifest entries record the SHA-256 of
  the bytes so the true-reupload check is exact.
- Staged message IDs are now scoped as `${conversationId}:${rawId}`. ChatGPT
  exports can reuse the same `message_id` across different conversations in the
  same export; using the raw ID directly as `staged_messages.id` (the global
  primary key) crashed the second insert with
  `UNIQUE constraint failed: staged_messages.id` and silently stalled the
  import. The scoped form preserves the source ID inside the key while
  guaranteeing global uniqueness across staged conversations. Re-populating the
  same conversation produces the same scoped IDs (idempotent).

## [0.3.8] - 2026-06-22

### Fixed

- Memory review UI: the Save button now persists the edited content of a daily
  or significant memory. Previously the textarea was looked up with
  `querySelector('#mem-edit-${type}-${filename}')` against an ID that was never
  set and would have been parsed as a class selector anyway (filenames contain
  `.md`). Save silently fell through to the load-from-disk branch and discarded
  the user's edits. Save and Cancel are now separate functions; successful Save
  re-renders read mode with the just-saved content; Cancel reloads read mode
  from disk.
- `PUT /api/memories/daily/:filename` and
  `PUT /api/memories/significant/:filename` now accept empty-string content.
  Clearing the textarea to start a memory over no longer returns 400.
- Resume and Purge buttons on the setup screen no longer corrupt Windows paths.
  The package directory was rendered into an inline
  `onclick="resumePackage('${
  dir }')"` string literal, where `\` in paths
  like `H:\Psycheros\...` was parsed as a JS escape character, corrupting the
  path before the handler ever saw it. Package rows now carry the dir/name in
  `data-*` attributes (which don't parse backslashes) with click handling
  delegated to the list container. The same render helper is now used for both
  initial load and post-purge refresh, eliminating the duplicated row template.
- Stale `running` checkpoint no longer bricks a resumed package. If the process
  died mid-stage (laptop closed, terminal killed, power loss), the persisted
  checkpoint kept `status: "running"` for the background stage even though
  nothing was in memory — on the next resume, the UI trusted the stale value and
  hid the Start button with no way to continue. On resume, if no stage is
  actually running in this process, the significant/daily/graph stages are now
  normalized to `status: "aborted"` (preserving `processedItems` and
  `failedItems`) so the existing resumable UI path offers the Continue button.
  Setup and convert are excluded — setup is synchronous, convert is cheap to
  re-run.
- LLM client now handles providers that hard-require a specific temperature
  (e.g. Moonshot/Kimi on certain models). Previously, providers that rejected
  any `temperature` other than a fixed value (commonly `1`) would fail every
  request with no workaround, because entity-loom uses task-specific values (0.2
  for graph JSON, 0.3 for significant memories, 0.7 for daily prose). The client
  now sends the task-specific temperature first; if the provider rejects with an
  explicit fixed-temperature error, it learns the required value, retries once
  with it, and uses that value for the life of the `LLMClient` instance so later
  calls don't pay the retry cost. Range errors ("temperature must be between 0
  and 2") and multi-value errors ("temperature: expected one of [0, 0.7, 1]")
  are not guessed — guessing wrong would just produce another rejection.
  Task-specific temperatures are preserved for every provider that allows them.

## [0.3.7] - 2026-06-17

### Added

- `is_voice` column on the `messages` table. Conversations imported via the
  setup wizard now preserve voice-attribution metadata — messages spoken via
  voice chat are flagged at import time. Always `false` for external platform
  imports (ChatGPT/Claude/etc. don't have voice context).

## [0.3.6] - 2026-06-10

### Security

- The `POST /api/setup/resume` and `GET /api/status` endpoints no longer include
  `llmApiKey` in their JSON responses. The key is replaced with a boolean
  `hasApiKey` field. The frontend shows a masked placeholder on resume instead
  of the actual key value.

## [0.3.5] - 2026-06-09

### Fixed

- GPT-5.x models now correctly strip all sampling parameters (temperature,
  top_p, frequency/presence penalty) before sending requests.

## [0.3.4] - 2026-06-01

### Fixed

- Temperature parameter now stripped for OpenAI o-series and DeepSeek reasoner
  models to prevent API rejections.

## [0.3.3] - 2026-05-22

### Fixed

- OpenAI o-series and gpt-5.x models now use `max_completion_tokens` instead of
  the rejected `max_tokens` parameter, fixing connection tests and all LLM
  requests on newer models.

## [0.3.2] - 2026-05-15

### Fixed

- **Progress UI restored on page reload**: The wizard's progress bar now
  repopulates from the server-side stage-lock snapshot on reconnect, instead of
  showing a blank screen until the next SSE event.
- **Browser freeze on large import runs prevented**: DOM updates for long runs
  (hundreds of conversations) no longer block the main thread.

### Changed

- **ChatGPT parser split**: The monolithic `ChatGPTParser` is now a thin
  dispatcher that delegates to `ChatGPTOfficialParser` (native OpenAI exports)
  and `ChatGPTPluginParser` (3rd-party browser plugin exports like GerTex).
  Shared types and utilities live in `chatgpt-shared.ts`. Fixes to one
  sub-parser cannot break the other.
- **Improved ChatGPT detection**: GerTex exports with large metadata blocks that
  push `"mapping"` past the 2KB head window are now detected correctly. The
  detection logic checks the file tail for `"current_node"` and accepts
  `"conversation_id"` or `"create_time"` as head markers.
- **Staging re-population resets inclusion**: When staging is re-populated
  (e.g., re-running the wizard with the same package), conversations that
  already exist in `staging.db` have their `included` state reset to `1`.
  Previously, conversations excluded in a prior session would stay excluded even
  after re-import, making them invisible to the commit step.

## [0.3.1] - 2026-05-14

### Changed

- Code formatting refreshed (deno fmt).

## [0.3.0] - 2026-05-13

### Added

- Version chip in the wizard and graph viewer (lower-right corner). Clicks
  through to the GitHub release page for the running version; staging builds
  render the chip non-interactive with `· staging` flavor. Tooltip surfaces both
  entity-loom and entity-core versions since the graph engine version is often
  the operationally important one.
- `/api/version` endpoint on the main wizard server returns the version payload
  as JSON so the launcher dashboard can render an entity-loom service card the
  same way it consumes psycheros's `/health`.

## [0.2.1] - 2026-05-13

### Changed

- Package documentation refreshed for consumer-facing source releases (rolled in
  from the broader docs sweep ahead of the first GitHub Pages deploy).

## [0.2.0] - 2026-05-13

### Added

- Initial public release. Version `0.2.0` (not `0.1.0`) reflects the internal
  lineage prior to first public release.
- Web wizard that converts AI-companion chat histories from foreign platforms
  into a structured import package ingestible by Psycheros / entity-core. Useful
  on its own for any persistent-AI-companion ecosystem that wants to seed an
  entity from existing conversations.
- Supported source platforms:
  - **ChatGPT** — native data export + the GerTex ChatGPT Exporter Chrome
    extension
  - **Claude** — data-export JSONL / JSON
  - **SillyTavern** — JSONL chats
  - **Letta** — agent chat-log JSON
  - **Kindroid / KinLog** — JSON
- Five-stage wizard served at `http://localhost:3210`.

[0.3.9]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.3.9
[0.3.8]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.3.8
[0.3.7]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.3.7
[0.3.6]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.3.6
[0.3.5]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.3.5
[0.3.4]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.3.4
[0.3.3]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.3.3
[0.3.2]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.3.2
[0.3.1]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.3.1
[0.3.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.3.0
[0.2.1]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.2.1
[0.2.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.2.0
