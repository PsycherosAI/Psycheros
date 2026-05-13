# Changelog

All notable changes to the Psycheros harness daemon are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/),
and this package follows [Semantic Versioning](https://semver.org/).

## [0.1.2] - 2026-05-13

### Fixed

- `getMessagesPaginated`: scroll-back no longer jumps to the oldest
  message when loading earlier history.

## [0.1.1] - 2026-05-13

### Fixed

- First-run setup for `ZAI_API_KEY`-only deployments. The seeded default
  LLM profile previously pointed at OpenRouter under a "Custom Endpoint"
  label, so the Z.ai key failed auth on first message. The seeded profile
  now resolves correctly to Z.ai (provider `zai`, base URL
  `https://api.z.ai/api/coding/paas/v4/chat/completions`, model `glm-4.7`).
  No data migration; existing volumes (`psycheros-data`,
  `entity-core-data`) and saved LLM profiles carry over unchanged.

### Changed

- `README.md` Essential environment table: `PSYCHEROS_MCP_ENABLED`
  documented default corrected to `true` (matches `.env.example` and
  runtime).

## [0.1.0] - 2026-05-13

### Added

- Initial public release.
- Persistent AI entity served through a web chat UI on port 3000.
- Streaming LLM, tool execution, RAG.
- Hierarchical memory (daily → weekly → monthly → yearly summaries).
- Knowledge graph (people, places, relationships) backed by SQLite +
  sqlite-vec.
- Lorebook, data vault, autonomous Pulse triggers.
- Discord gateway, image generation, image captioning.
- Entity identity and memory served by the sibling `entity-core` MCP
  server, spawned as a subprocess when `PSYCHEROS_MCP_ENABLED=true`.

[0.1.2]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.1.2
[0.1.1]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.1.1
[0.1.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/psycheros-v0.1.0
