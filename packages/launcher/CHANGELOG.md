# Changelog

All notable changes to Psycheros Launcher are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/), and this package
follows [Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-05-13

### Added

- Version chip in the dashboard header. Clickable link to the launcher release
  page for public builds, non-interactive `· staging` variant for dev /
  non-canonical `PSYCHEROS_REPO`.
- Service version line on the Psycheros and Entity Loom cards, pulled from each
  service's `/health` or `/api/version` while running. Shows the cross-linked
  entity-core version where relevant.
- GitHub Releases update check (daily cache, anonymous HTTPS to
  `api.github.com`). Active only when `PSYCHEROS_REPO` resolves to the canonical
  `PsycherosAI/Psycheros`; suppressed in dev / staging mode so devs aren't
  nagged to "update" their staging container to the public stable. Cache file is
  keyed by repo-slug hash, so switching modes invalidates it without manual
  cleanup.
- First-run modal asking whether to enable update checking on canonical-mode
  launchers. Stored in the launcher state file. Never prompts in dev mode.
- "Update available" banner above the actions card when a newer launcher tag is
  detected, plus a small dot indicator on each service version line for
  psycheros / entity-loom / entity-core.
- `install.sh` and `run.sh` now echo the launcher version in their pre-flight
  summary alongside Git and Deno. POSIX-safe awk read of `deno.json` — no jq
  dependency.

## [0.1.2] - 2026-05-13

### Changed

- Package documentation refreshed: new `docs/user-guide.md` and sidebar slot
  ahead of the first GitHub Pages deploy (launcher is the README-recommended
  entry point and previously lacked docs presence).

## [0.1.1] - 2026-05-13

### Added

- `PSYCHEROS_LAUNCHER_PORT` env var: override the launcher dashboard port
  (default `3001`). Useful when `:3001` is squatted by other homelab tools
  (uptimekuma, Verdaccio, etc.). The psycheros daemon's port is still controlled
  separately via `PSYCHEROS_PORT` in the daemon's `.env`.

  Example:
  ```bash
  PSYCHEROS_LAUNCHER_PORT=3011 bash run.sh
  ```

### Changed

- Release-notes transparency: `run.sh` / `run.ps1` will install Deno if it is
  missing, using Deno's official installer at `https://deno.land/install.sh`
  (Unix) or `https://deno.land/install.ps1` (Windows). Pre-install Deno before
  running the launcher and the script will detect the existing install and skip
  the auto-install step.

## [0.1.0] - 2026-05-13

### Added

- Initial public release.
- Browser-based GUI to install, update, and run Psycheros — no terminal
  required.
- Two files do everything: `run.sh` (macOS / Linux) or `run.ps1` (Windows), plus
  `dashboard.ts`. All three attached directly to the release for direct
  download.
- Bundled archives (`launcher-v<version>.zip` / `.tar.gz`) for users who prefer
  a single archive over individual file downloads.

[0.1.2]: https://github.com/PsycherosAI/Psycheros/releases/tag/launcher-v0.1.2
[0.1.1]: https://github.com/PsycherosAI/Psycheros/releases/tag/launcher-v0.1.1
[0.1.0]: https://github.com/PsycherosAI/Psycheros/releases/tag/launcher-v0.1.0
