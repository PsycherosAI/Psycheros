# Changelog

All notable changes to the Psycheros harness daemon are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/), and this package
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Trusted plugin surface** (`packages/plugin-api/` + `src/plugins/`): a
  multi-capability extension system for code that's more than a single tool.
  Plugins declare a manifest and entrypoints; the manager loads them at daemon
  startup. Capabilities include tools, prompt hooks, HTTP routes, browser
  assets, and entity-core MCP result decorators.
- **Aggregate prompt-hook budget accounting**: bounded total plugin context per
  turn to `(contextLength - maxTokens) * 0.15` clamped to `[4_000, 60_000]`
  chars. Per-hook truncation and skip both set `degraded` and surface in
  `PluginStatus.warnings`. Without this cap, N plugins × per-hook max could
  destabilize the entity loop.
- **Env-var denylist** (`isDeniedPluginEnvVar` in `packages/plugin-api`):
  refuses ~26 process-global names (proxy redirection, TLS trust, native
  injection, process identity, runtime behavior) plus `PSYCHEROS_*` and
  `ENTITY_CORE_*` prefix blocks. Soft enforcement — refused vars mark the plugin
  degraded, don't brick it.
- **Plugin event log** (`src/plugins/event-log.ts`): per-plugin in-memory ring
  buffer (200 events) plus plain-text file at `.psycheros/plugin-logs/<id>.log`
  with 5 MB rotation. Greppable one-line-per-event format designed for
  support-chat paste.
- **Inter-plugin dependency resolution** (`src/plugins/dependency-resolver.ts`):
  topological sort with `@std/semver` range checks and cycle detection. Failed
  resolution marks plugins degraded with the reason in `lastError` and the event
  log.
- **Auto-updater** (`src/plugins/updater.ts`): per-plugin check against GitHub's
  tag API filtered by `tagPrefix`, apply chains the existing installer's
  `inspectGit` → `installDraft` so backup/atomic-replace come for free. UI
  button per plugin; no scheduler integration yet.
- **Plugins Settings card page** at `/fragments/settings/plugins`: safety banner
  linking to the User Guide vetting walkthrough, aggregate health card with
  last-turn budget meter, per-plugin Recent Activity panel with level filter and
  Copy and Download log buttons, per-plugin check-update and apply-update UI.
- **Install-review redesign**: capability-salience layout translating
  capabilities to operational language ("shape what the entity thinks each turn"
  vs "1 prompt hook"), reassuring "will not" lines for absent high-stakes
  capabilities, and a manifest-field diff (version arrow, browser-asset deltas,
  dependency adds/removes) when replacing an existing install.
- **Context Inspector integration**: `LLMContextSnapshot.metrics` gained
  `pluginBudgetUsed` and `pluginBudgetMax`; Metrics tab renders a meter when
  present and Plugin Context is now in the per-section breakdown. Both persist
  per-turn via the snapshots DB.
- **New API endpoints** under `/api/plugin-manager/*`: `GET /health`,
  `GET /plugins/<id>/events`, `GET /plugins/<id>/log`,
  `POST /plugins/<id>/check-update`, `POST /plugins/<id>/update`.
- **Plugins section in User Guide** at
  `site/src/content/docs/psycheros/user-guide.md` covering the trust model, the
  five vetting checks, red flags, and post-install recovery.
- **Plugin authoring reference** at `docs/plugins.md` covering manifest fields,
  entrypoint shapes, env conventions, dependency syntax, and update metadata.

### Changed

- **PluginManager.load()** refactored into discover → resolve → load phases so
  dependency resolution can topologically sort before any `start()` runs.
  Plugins that fail resolution never import.

### Fixed

- Pronoun consistency: the entity is never referred to as "it" in user-facing UI
  copy. They/them or rephrasing throughout.

### Security

- Plugins are trusted local code with full access to the entity's identity,
  memories, vault, and network. There is no sandbox between a loaded plugin and
  the entity. The trust model is documented in the User Guide; vetting is the
  operator's responsibility.

## [0.8.25] - 2026-07-16

### Fixed

- Lovense toy status coercion now handles numeric API responses (was treating
  all responses as strings)

### Added

- Audio/Voice Chat section in user guide

## [0.8.24] - 2026-07-15

### Fixed

- WebSocket idleTimeout raised to 3600s for long-lived streams
- Pulse engine now passes bleSettings to EntityConfig
- Skipped Pulse ticks no longer log by default
