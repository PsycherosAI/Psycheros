# Changelog

All notable changes to entity-loom are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/),
and this package follows [Semantic Versioning](https://semver.org/).

## [0.2.1] - 2026-05-13

### Changed

- Package documentation refreshed for consumer-facing source releases
  (rolled in from the broader docs sweep ahead of the first GitHub Pages
  deploy).

## [0.2.0] - 2026-05-13

### Added

- Initial public release. Version `0.2.0` (not `0.1.0`) reflects the
  internal lineage prior to first public release.
- Web wizard that converts AI-companion chat histories from foreign
  platforms into a structured import package ingestible by Psycheros /
  entity-core. Useful on its own for any persistent-AI-companion
  ecosystem that wants to seed an entity from existing conversations.
- Supported source platforms:
  - **ChatGPT** — native data export + the GerTex ChatGPT Exporter
    Chrome extension
  - **Claude** — data-export JSONL / JSON
  - **SillyTavern** — JSONL chats
  - **Letta** — agent chat-log JSON
  - **Kindroid / KinLog** — JSON
- Five-stage wizard served at `http://localhost:3210`.

[0.2.1]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.2.1
[0.2.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-loom-v0.2.0
