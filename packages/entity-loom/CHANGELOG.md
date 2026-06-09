# Changelog

All notable changes to entity-loom are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this package follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[0.3.5]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.3.5
[0.3.4]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.3.4
[0.3.3]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.3.3
[0.3.2]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.3.2
[0.3.1]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.3.1
[0.3.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.3.0
[0.2.1]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.2.1
[0.2.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.2.0
