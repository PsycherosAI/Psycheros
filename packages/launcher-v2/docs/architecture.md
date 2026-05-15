# Architecture

The v2 launcher is a Tauri 2.x desktop app that **does not own** the Psycheros
daemon process. Instead it installs an OS-native service definition (launchd
plist / systemd user unit / Windows scheduled task) and lets the OS supervise
everything — start at login, restart on crash, log rotation.

This is the architectural pivot from v1: v1 was an HTTP dashboard that spawned
the daemon as a child process, so closing the dashboard killed the persistent
entity. v2 decouples them. The entity outlives the app.

## System shape

```
┌─────────────────────────────────────────────────────────────┐
│  Psycheros.app  (single Tauri binary, one install)          │
│  ┌─────────────────────────┐  ┌───────────────────────────┐ │
│  │ Chat client window      │  │ Manager surface           │ │
│  │ — webview onto :3000    │  │ — same window, Cmd+,       │ │
│  │ — Psycheros UI inline   │  │ — install / status / logs │ │
│  │ — auto-fallback to mgr  │  │ — auto-fallback target    │ │
│  └─────────────────────────┘  └───────────────────────────┘ │
└──────────────┬──────────────────────────┬───────────────────┘
               │ HTTP (chat)              │ launchctl / systemctl /
               ▼                          ▼ Task Scheduler
┌──────────────────────────┐    ┌────────────────────────────┐
│  psycheros daemon        │    │  OS service supervisor     │
│  — runs at login         │◄───┤  — RunAtLoad + KeepAlive   │
│  — restarted on crash    │    │  — supervises lifecycle    │
│  — survives app close    │    │  — independent of app      │
└──────────────────────────┘    └────────────────────────────┘
```

## Three commitments

1. **The launcher does not own the daemon's lifecycle.** Launchd does (or
   systemd, or Task Scheduler). The launcher installs the service definition on
   user opt-in; from that point the OS supervises start, restart, log rotation.
2. **Closing the launcher has no effect on the daemon.** This is the inverse of
   v1 and the entire reason for the v2 architecture.
3. **One window, two surfaces.** The chat client and the manager render in the
   same window. `Cmd+,` toggles. When the daemon goes down mid-session, the
   window auto-falls-back to the manager.

## Filesystem layout

The launcher writes everything under the OS-conventional app-data dir:

```
~/Library/Application Support/Psycheros/   (macOS — equivalent paths on Linux/Windows)
├── config.json          User prefs (port, autostart toggle, names, timezone)
├── source/              Extracted release bundle
│   └── packages/
│       ├── psycheros/   The daemon source — daemon's `projectRoot`
│       └── entity-core/ MCP server source
├── bin/
│   └── deno             Bundled Deno copied to stable path (plist references this)
├── data/                The daemon's `PSYCHEROS_DATA_DIR` target
│   ├── .psycheros/      DB, settings, vault docs, generated images
│   ├── identity/        Entity identity files
│   ├── .snapshots/      Versioned identity snapshots
│   ├── memories/        Daily/weekly memory summaries
│   ├── custom-tools/    User-imported tool JS files
│   ├── backgrounds/     UI background images
│   └── entity-core/
│       └── data/        Entity-core's own data dir
└── logs/                Daemon stdout/stderr (launchd / Task Scheduler)
                         Linux uses journalctl instead of files here.
```

The split between `source/` and `data/` is the whole point of the
`PSYCHEROS_DATA_DIR` refactor in psycheros 0.3 — `source/` gets wiped and
replaced on auto-update; `data/` is durable across updates.

## State flow on first run

```
1. User launches Psycheros.app
2. Launcher detects no config.json — shows first-run welcome
3. Launcher extracts release-bundle.tar.gz → source/
4. Launcher copies bundled Deno → bin/deno
5. Launcher runs `deno cache src/main.ts` to warm dep cache (slow — needs progress UI)
6. Launcher writes config.json with defaults (entity name, timezone, port)
7. Launcher offers "Install autostart" (not done by default — user opts in)
8. On opt-in: write plist + launchctl load -w → daemon starts
9. Watcher detects daemon Running → webview navigates to localhost:3000
10. User sees chat UI
```

(Steps 3-6 are Phase 2 work; this scaffold has them stubbed.)

## State flow on subsequent launches

```
1. User launches Psycheros.app
2. Launcher reads config.json (skip first-run)
3. Watcher probes daemon — if daemon is already running (launchd kept it
   alive even after app close last time), webview immediately navigates
   to localhost:3000. No spinner, no delay.
4. If daemon isn't running for any reason, launcher shows the manager
   splash. User can manually start it or wait for launchd to start it.
```

## State flow on daemon crash mid-session

```
1. Daemon (DB lock / OOM / whatever) exits
2. Watcher's next 2s probe: port not bound + supervisor loaded → state=Installed
3. Rust drives webview navigation to splash, showing "Daemon is starting…"
4. Launchd auto-restarts daemon within ~2s (KeepAlive=true)
5. Watcher's next probe: port bound → state=Running
6. Rust drives webview back to localhost:3000
7. User's chat session reconnects via SSE; total interruption ~4-6s
```

Empirically validated during the research phase: SIGKILL the daemon, watch
launchd revive it within ~2s, watch the launcher's webview auto-flip back to
chat. Reproducible locally — run `cargo tauri dev`, then in a second terminal
run `pkill -9 -f "deno run -A src/main.ts"`.

## Why Tauri + Deno sidecar (not Electron, not native)

- **Tauri** ships a tiny Rust binary (~10MB shell vs Electron's 150MB+ Chromium)
  and uses the OS-native webview (WKWebView on macOS, WebView2 on Windows,
  webkit2gtk on Linux). The launcher renders the same Psycheros UI a browser
  would, with no Chromium fork.
- **Deno sidecar** because that's how Psycheros is written. We bundle a Deno
  binary per target triple (~100MB each) as a Tauri sidecar; the launcher copies
  it to a stable path on first run so the OS service definition can reference
  it.
- **Not `deno compile`** because Psycheros's native deps (`@db/sqlite` FFI,
  `onnxruntime-node`, `sharp`) don't survive `deno compile` cleanly, AND because
  shipping source preserves the "users can run with Docker or raw
  `deno task start`" promise that's load-bearing for the project's philosophy.

## What lives where (module ↔ responsibility)

| Module                        | Responsibility                                     |
| ----------------------------- | -------------------------------------------------- |
| `src/lib.rs`                  | Tauri Builder wiring                               |
| `src/main.rs`                 | Binary entry                                       |
| `src/paths.rs`                | All filesystem locations the launcher reads/writes |
| `src/supervisor/*`            | OS service installation/uninstallation             |
| `src/daemon/status.rs`        | Detect what state the daemon is in right now       |
| `src/daemon/navigation.rs`    | Drive webview between manager and chat             |
| `src/app/state.rs`            | View-mode flag + splash URL + nav dedupe           |
| `src/app/menu.rs`             | Native menu + accelerators                         |
| `src/app/mod.rs`              | Watcher thread + menu event handler                |
| `src/commands.rs`             | Tauri IPC surface — the API the frontend calls     |
| `src/bundle/*`                | Release-bundle extraction (phase 2)                |
| `src/config/*`                | `config.json` read/write                           |
| `frontend/index.html`         | Splash markup + per-state CSS                      |
| `frontend/js/manager.js`      | State-conditional rendering                        |
| `frontend/js/tauri-bridge.js` | Single-purpose IPC wrapper                         |

## What this is _not_

- **Not a process manager for arbitrary services.** Just psycheros + its MCP
  child (entity-core, spawned by psycheros).
- **Not a container.** No isolation, no cgroups, no chroot. The daemon runs as
  the user, can read the user's files, can talk to the user's network. Same
  trust posture as `deno task start`.
- **Not a settings hub.** Psycheros's own settings UI (in the chat surface) is
  where entity name, API keys, etc. get configured. The launcher's manager
  surface is about the lifecycle, not the content.
- **Not where Entity Loom lives.** Loom is a separate utility with its own
  (eventual) distribution; the launcher does not bundle or manage it.
