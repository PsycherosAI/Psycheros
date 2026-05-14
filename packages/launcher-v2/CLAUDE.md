# launcher-v2 — agent card

Tauri 2.x desktop app that installs Psycheros as an **OS-supervised service**
(launchd / systemd-user / Task Scheduler), renders the chat UI inline by
navigating the webview to the daemon's `localhost:3000`, and provides an in-app
manager surface for install/uninstall, status, logs, and updates. Replaces the
v1 `packages/launcher` HTTP-server-in-a-browser-tab shape.

First-person convention applies — see [root CLAUDE.md](../../CLAUDE.md). The
launcher itself is utility surface, not entity surface, so this convention
mainly affects user-facing copy in `frontend/` (titles, error messages), not
Rust internals.

## Commands

```bash
# Dev (from inside packages/launcher-v2/):
./scripts/setup.sh                        # one-time: stage Deno + icons
npx --yes @tauri-apps/cli@^2.0 dev        # or cargo install tauri-cli && cargo tauri dev

# Build a distributable (.app / .msi / .deb / .AppImage):
./scripts/bundle-source.sh                # produce release-bundle.tar.gz
npx --yes @tauri-apps/cli@^2.0 build

# Rust gates:
cd src-tauri && cargo check
cd src-tauri && cargo fmt --check
cd src-tauri && cargo clippy -- -D warnings
```

This package is **not in the Deno workspace** — it's Rust + plain HTML/JS/CSS.
The root `deno.json` workspace list intentionally omits it.

## Architectural pillars (do not violate)

1. **The launcher does not own the daemon process.** It installs an OS service
   definition; the OS supervises. Closing/crashing the launcher never touches
   the daemon. See [`docs/architecture.md`](docs/architecture.md).
2. **Cross-platform via trait, not `#[cfg]` everywhere.** All daemon lifecycle
   goes through [`supervisor::ServiceSupervisor`]. The macOS impl is full;
   Linux + Windows are stubs with explicit `NotImplemented`. See
   [`docs/supervisors.md`](docs/supervisors.md).
3. **One window, two surfaces.** Chat and manager render in the same `main`
   window. `Cmd+,` toggles. The webview navigates between `tauri://localhost/`
   (manager) and `http://localhost:3000/` (chat).
4. **Navigation is driven from Rust, not JS.** Cross-origin restrictions prevent
   JS in either context from reliably navigating to the other. `webview.eval()`
   from Rust sidesteps this. See
   [`daemon::navigation`](src-tauri/src/daemon/navigation.rs).
5. **Frontend never directly polls the daemon HTTP.** It calls Rust commands;
   Rust does the TCP probe + supervisor query. This avoids webview CORS issues
   entirely.

## Module structure (`src-tauri/src/`)

```
lib.rs                    Tauri builder; entry from main.rs
main.rs                   Thin binary wrapper around lib::run()

paths.rs                  Per-OS path resolution (app data, source, deno, logs)

supervisor/
  mod.rs                  ServiceSupervisor trait + DaemonConfig + DefaultSupervisor alias
  launchd.rs              macOS: ~/Library/LaunchAgents/<label>.plist (full impl)
  systemd.rs              Linux: ~/.config/systemd/user/*.service (stub)
  task_scheduler.rs       Windows: schtasks (stub)

daemon/
  mod.rs                  Public surface — DAEMON_PORT const, re-exports
  status.rs               DaemonState enum + probe() — TCP + supervisor check
  navigation.rs           webview.eval-based navigation driven by Rust

app/
  mod.rs                  Watcher thread + menu event handler
  state.rs                AppState (user_summoned, splash_url, last_navigated)
  menu.rs                 Native menu (Preferences = Cmd+,)

bundle/                   Release-bundle extraction + Deno staging (phase 2 stubs)
config/                   config.json read/write (phase 2 stubs)

commands.rs               #[tauri::command] surface — JS RPC entry points
```

The frontend (`frontend/`) is plain HTML/CSS/JS — no bundler. Tauri's
`withGlobalTauri: true` exposes the IPC API on `window.__TAURI__` so JS can
`invoke()` Rust commands and `listen()` for events without a build step. The
split is intentional: keep the build surface small until product needs demand
otherwise.

## State machine: view mode

`AppState.user_summoned` is the only flag distinguishing "splash because daemon
is down" from "splash because user pressed Cmd+,":

| state        | user_summoned | what the user sees           | on daemon → Running  |
| ------------ | ------------- | ---------------------------- | -------------------- |
| Running      | false         | chat UI                      | (already there)      |
| Running      | true          | manager (user wants it)      | **stays on manager** |
| Installed    | false         | manager, "daemon starting…"  | auto-flips to chat   |
| Installed    | true          | same                         | **stays on manager** |
| NotInstalled | false         | manager, "install autostart" | auto-flips to chat   |
| NotInstalled | true          | same                         | **stays on manager** |

When daemon goes Running → not-Running, the launcher always auto-flips to the
manager (regardless of `user_summoned`) so the user has a recovery affordance
instead of a frozen chat window.

## Traps that bite

- **`window.__TAURI__` is undefined unless `withGlobalTauri: true`.** Tauri 2's
  default is `false`. Frontend will silently fail every IPC call if this isn't
  set in `tauri.conf.json`. Already set; don't remove it.
- **`window.url()` returns different URLs in dev vs production.** Dev uses a
  random local port (`http://127.0.0.1:<random>/`); production uses
  `tauri://localhost/`. We capture it once at startup into `AppState.splash_url`
  to navigate back to from any origin.
- **`location.replace(sameURL)` triggers a hard reload.** Wipes splash JS state
  and looks like a glitch. `daemon::navigation::drive` de-dupes via
  `AppState.last_navigated`.
- **Tauri's icon validator requires RGBA, not RGB.** `cargo tauri dev` panics
  with "icon is not RGBA" if you pass color type 2 (RGB). Color type 6 (RGBA)
  only. `scripts/setup.sh` generates the right format.
- **`launchctl list <label>` exits 0 = loaded, 113 = not loaded.** Parse the
  exit code, not the stdout text — the latter varies across macOS versions and
  is meant for humans.
- **`KeepAlive=true` makes "Stop" useless.** `launchctl stop` is a no-op against
  KeepAlive — the daemon comes right back. The only real off switch is
  `launchctl unload -w` (which we wrap as "Uninstall autostart").

## Cross-platform considerations

| Platform | Supervisor           | Sudo needed?              | Logs                                |
| -------- | -------------------- | ------------------------- | ----------------------------------- |
| macOS    | launchd (user agent) | Never                     | Files at `<data>/logs/daemon.*.log` |
| Linux    | systemd user unit    | Once, for `enable-linger` | `journalctl --user -u psycheros`    |
| Windows  | Task Scheduler       | Never (user-level task)   | Redirected stdout files via wrapper |

The launchd impl is the reference. Other OSes follow the same trait contract but
the under-the-hood mechanics differ — see per-OS module doc comments and
[`docs/supervisors.md`](docs/supervisors.md) for the full picture.

## Deep references

| Topic                                         | Doc                                          |
| --------------------------------------------- | -------------------------------------------- |
| Overall architecture, daemon ownership model  | [docs/architecture.md](docs/architecture.md) |
| Per-OS service supervisor design + impl notes | [docs/supervisors.md](docs/supervisors.md)   |
| Release-bundle composition + extraction flow  | [docs/bundle.md](docs/bundle.md)             |
| Frontend conventions, view modes, brand       | [docs/frontend.md](docs/frontend.md)         |
| CI matrix, signing posture, distribution      | [docs/release.md](docs/release.md)           |
| v1 → v2 migration story                       | [docs/migration.md](docs/migration.md)       |

## Companion packages

This package lives in the [Psycheros monorepo](../../README.md). It manages the
lifecycle of the sibling [`psycheros`](../psycheros/) daemon and ships a pruned
bundle of its source plus [`entity-core`](../entity-core/) and
[`scheduler`](../scheduler/). It does not manage
[`entity-loom`](../entity-loom/) — Loom is a separate utility with its own
distribution story.

The v1 [`launcher`](../launcher/) is being replaced by this package. Delete v1
once v2 reaches feature parity per [`docs/migration.md`](docs/migration.md).
