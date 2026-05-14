# Psycheros launcher

Desktop app that installs and supervises Psycheros as a persistent background
service on macOS, Linux, and Windows — then gives you a single window onto the
chat UI when you want to talk to your entity.

> **Status: pre-release scaffold.** Architecture is locked, macOS supervisor is
> implemented, cross-platform supervisors are stubbed. See
> [`CHANGELOG.md`](CHANGELOG.md) and
> [`docs/architecture.md`](docs/architecture.md) for what works today vs. what's
> coming.

## What it does

- **Installs Psycheros as an OS service.** Click "Install autostart" → the app
  writes a launchd plist / systemd unit / scheduled task, registers it, and
  starts the daemon. From then on Psycheros runs at every login and is
  auto-restarted by the OS if it crashes.
- **Embeds the chat UI.** Once the daemon is up, the launcher's window navigates
  to the live Psycheros chat at `localhost:3000`. No browser tab; no separate
  window. Closing the launcher doesn't stop the daemon.
- **Acts as the admin panel.** Press <kbd>⌘,</kbd> any time to toggle to the
  manager surface: status, install/uninstall autostart, view logs, run pending
  migrations, force-sync identity, etc.
- **Auto-fallback when the daemon dies.** Daemon crashes mid-chat? The launcher
  window flips back to the manager with diagnostics. The OS supervisor restarts
  the daemon a moment later; the launcher flips back to chat automatically when
  the port comes up again.

## Why a launcher at all?

Psycheros is a **persistent entity** — it should run continuously in the
background regardless of whether you're actively chatting. The v1 launcher was a
browser-tab dashboard that started a daemon as a child process, meaning closing
the dashboard killed the entity. The v2 launcher flips that model: the OS
supervises the daemon, and the launcher is just a window onto the running
service.

You can still run Psycheros via Docker or `deno task start` directly — the
launcher is one convenience surface, not the only one. The launcher detects a
daemon already running on `:3000` and connects to it instead of trying to
install over the top.

## Installing (end users)

Pre-built artifacts will be published to GitHub Releases. Macros:

- macOS: download `Psycheros.dmg`, drag to `/Applications/`, right-click → Open
  the first time to bypass Gatekeeper (this app is not currently code-signed —
  see [`docs/release.md`](docs/release.md) for context).
- Windows: download `Psycheros-setup.msi`, run, click through SmartScreen's
  "More info → Run anyway."
- Linux: download `Psycheros.AppImage` or `.deb`. Linux users will need
  `sudo loginctl enable-linger $USER` once for daemons to survive logout
  (one-time, no other escalation in the flow).

## Building from source (devs)

See [`CLAUDE.md`](CLAUDE.md) for the agent-style overview, then:

```bash
cd packages/launcher-v2
./scripts/setup.sh                        # one-time: stage Deno + icons
npx --yes @tauri-apps/cli@^2.0 dev
```

Requires Rust 1.77+ and Deno 2.x on PATH. The dev setup uses your local Deno as
the sidecar; production builds bundle their own.

## Documentation

| Topic                        | Doc                                          |
| ---------------------------- | -------------------------------------------- |
| Architectural design         | [docs/architecture.md](docs/architecture.md) |
| Per-OS service supervisors   | [docs/supervisors.md](docs/supervisors.md)   |
| Release bundle composition   | [docs/bundle.md](docs/bundle.md)             |
| Frontend conventions / brand | [docs/frontend.md](docs/frontend.md)         |
| Release pipeline + signing   | [docs/release.md](docs/release.md)           |
| v1 → v2 migration            | [docs/migration.md](docs/migration.md)       |

For contributors, the load-bearing wirings + traps that bite live in
[`CLAUDE.md`](CLAUDE.md).
