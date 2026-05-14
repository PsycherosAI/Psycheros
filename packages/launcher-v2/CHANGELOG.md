# Changelog

All notable changes to the Psycheros desktop launcher are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/), and this package
follows [Semantic Versioning](https://semver.org/). It is pre-1.0 until
cross-platform supervisors and the first-run flow ship.

## [Unreleased] — scaffold

### Added

- Initial package scaffold. Tauri 2.x desktop app shape:
  - One-window, two-surface architecture (chat + manager) with `Cmd+,` toggle
    and webview-eval-driven navigation from Rust.
  - `ServiceSupervisor` trait with full macOS launchd implementation and stub
    Linux (systemd-user) + Windows (Task Scheduler) impls behind
    `#[cfg(target_os = ...)]` gates.
  - Daemon detection via TCP probe + supervisor `is_loaded` check; state machine
    distinguishes `NotInstalled` / `Installed` / `Running`.
  - Splash + state-conditional buttons in vanilla HTML/CSS/JS.
  - Cross-platform path resolution via `dirs` crate
    (`~/Library/Application
    Support/Psycheros/` on macOS, equivalent on
    Linux/Windows).
  - Tauri commands: `daemon_status`, `install_autostart`, `uninstall_autostart`,
    `set_view_mode`.
- `scripts/setup.sh` — dev bootstrap (stage Deno sidecar + RGBA icons).
- `scripts/bundle-source.sh` — produces `release-bundle.tar.gz` for embedding in
  the Tauri bundle.
- Documentation: README, CLAUDE.md, six deep-reference docs covering
  architecture, supervisors, bundle, frontend, release, migration.

### Carried over from earlier research spike

(The spike directory was kept locally during development and removed once this
scaffold was complete — its findings live on in this CHANGELOG and the docs/
tree.)

All architectural decisions and non-obvious findings from the spike's empirical
research:

- `withGlobalTauri: true` is mandatory for plain HTML/JS frontends.
- Capture splash URL dynamically (`window.url()`) — dev and prod use different
  schemes.
- Drive cross-origin navigation from Rust (`webview.eval`), not JS.
- Skip no-op navigations (`location.replace(sameURL)` reloads).
- Tauri icon validator requires RGBA (color type 6).
- `launchctl list <label>` exit codes (0 / 113), not stdout.
- `KeepAlive=true` makes "stop temporarily" semantically impossible.
- View-mode state via a single `user_summoned: AtomicBool`.

### Prerequisite landed in psycheros

- `PSYCHEROS_DATA_DIR` env in psycheros 0.3+ (separate `projectRoot` from
  `dataRoot`) — the launcher sets this in every OS service definition so the
  daemon writes runtime state to `<launcher_data_dir>/data/` regardless of where
  the source bundle lives.

### Known gaps (not yet implemented)

- Linux + Windows supervisors return `NotImplemented`. Trait, plist rendering
  pattern, and integration tests are ready for them; see per-module doc comments
  for implementation notes.
- First-run install flow (clone-monorepo equivalent for a `.app` / `.exe` /
  `.AppImage`): `bundle::extract_release_bundle`, `bundle::stage_bundled_deno`,
  `bundle::warm_deno_cache` are implemented as stubs. Phase 2 work.
- Auto-update via `tauri-plugin-updater`: dep present, no signing key
  configured. Phase 5 work.
- Manager surface beyond install/uninstall: logs viewer, settings editor,
  migration runner, "force resync identity" — phase 3-4 work.
- Code signing / notarization: none (Gatekeeper / SmartScreen workaround
  documented in `docs/release.md`).
