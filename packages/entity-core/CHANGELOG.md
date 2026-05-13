# Changelog

All notable changes to entity-core are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this package follows
[Semantic Versioning](https://semver.org/).

## [0.1.2] - 2026-05-13

### Added

- `ENTITY_CORE_VERSION` exported from `mod.ts` for consumers that want to
  surface the linked entity-core version (e.g., psycheros's admin diagnostics,
  entity-loom's version chip tooltip). Backed by `src/version.ts`, a JSON import
  of `deno.json`.

## [0.1.1] - 2026-05-13

### Fixed

- LLM JSON-response parsing: tolerate unpaired markdown code fences in
  responses. Previously a stray `` ``` `` (without a matching closer) could
  break JSON extraction; the parser now handles partial-fence shapes gracefully.

### Changed

- MCP tool name documentation in `docs/mcp-tools.md`: ~40 tool names switched
  from slash form (e.g. `identity/get_all`) to underscore form
  (`identity_get_all`) to match what `server.tool` actually registers. Adds
  previously-undocumented `memory_delete`.

## [0.1.0] - 2026-05-13

### Added

- Initial public release.
- Persistent identity and memory store exposed as an MCP server over stdio.
  Embodiments (Psycheros, an MCP shim for SillyTavern, Claude Code, OpenWebUI,
  anything else MCP-capable) spawn the server as a subprocess and sync identity
  and memory through pull / push tools.
- Identity files; hierarchical memory (daily → weekly → monthly → yearly
  summaries).
- Knowledge graph (people, places, relationships) backed by SQLite + sqlite-vec.
- Snapshot system: pre-destructive-operation snapshots for recovery.

[0.1.1]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.1.1
[0.1.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/entity-core-v0.1.0
