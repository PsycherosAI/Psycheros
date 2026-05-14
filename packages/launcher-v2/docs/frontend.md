# Frontend

Plain HTML/CSS/JS — no bundler, no framework. The frontend's job is small:
render the manager card and react to daemon-state events. All heavy lifting is
on the Rust side.

## Why no framework

The whole frontend surface is one HTML page with a status pill, a title/detail
block, two-or-three buttons, and a meta footer. Adding Vite + a framework would
inflate build complexity by an order of magnitude for a UI that doesn't need it.
If the manager surface grows beyond what plain JS can express clearly
(multi-page settings, log-tail viewer with virtualization, etc.), revisit then.

Tauri's `withGlobalTauri: true` setting exposes the IPC API on
`window.__TAURI__` so `invoke()` and `listen()` work without any import
infrastructure. The whole bridge is
[`js/tauri-bridge.js`](../frontend/js/tauri-bridge.js) — one file, under 40
lines.

## Brand alignment

Design tokens in [`styles/tokens.css`](../frontend/styles/tokens.css) mirror
`packages/psycheros/web/css/tokens.css` exactly. The launcher and the chat
client share one visual identity — same dark OLED background (`#000000`), same
violet accent (`#a855f7`), same IBM Plex type stack. The seam between manager
and chat shouldn't feel like a seam.

Keep `tokens.css` in sync when the canonical psycheros tokens change. Both files
have the same `:root` variables; copy-paste is fine.

## State-conditional rendering

The DOM has a single `data-state` attribute on `<body>`. CSS styles the
status-pill dot per state via attribute selectors:

```css
body[data-state="running"] .dot {
  background: var(--c-state-running);
}
body[data-state="installed"] .dot {
  background: var(--c-state-installed);
}
body[data-state="not-installed"] .dot {
  background: var(--c-state-not-installed);
}
```

JS in [`manager.js`](../frontend/js/manager.js) sets the attribute plus
title/detail/actions on every state transition. Three branches in a switch —
that's the entire rendering layer.

## View-mode state machine

The launcher distinguishes **why** the splash is visible:

- **Auto-fallback:** daemon isn't running, splash shown out of necessity. When
  daemon recovers, auto-navigate to chat.
- **Explicit summon:** user pressed `Cmd+,` or clicked "Manager" while daemon
  was up. Stay on splash until they click "Back to chat" or press the
  accelerator again.

The Rust side tracks this in `AppState.user_summoned` (an `AtomicBool`). The
frontend never touches it directly — it calls `set_view_mode` with `"chat"` or
`"manager"` and Rust handles the nav + state update atomically.

The "Back to chat" button (visible only when daemon is Running and user is on
the manager) calls `set_view_mode("chat")`. The `Cmd+,` accelerator is handled
by Rust's `on_menu_event` which toggles `user_summoned` and re-drives
navigation.

## Why Rust drives navigation, not JS

Two reasons:

1. **Cross-origin restrictions.** Once the webview is on
   `http://localhost:3000`, JS in that context can't easily navigate back to
   `tauri://localhost/` because of browser security policies. `webview.eval()`
   from Rust has no such restrictions — it just executes JS in whatever context
   is loaded, including against the `localhost:3000` origin.
2. **Single source of truth.** State (`user_summoned`, current view, daemon
   state) lives in Rust. If JS also tried to navigate based on its own local
   copy, the two views could drift. Keeping navigation in Rust means transitions
   are atomic with state updates.

## IPC contract

The frontend has access to these commands (all in
[`commands.rs`](../src-tauri/src/commands.rs)):

| Command               | Returns                  | When to call                            |
| --------------------- | ------------------------ | --------------------------------------- |
| `daemon_status`       | `DaemonStatus`           | On page load (initial render)           |
| `install_autostart`   | `Result<DaemonStatus,_>` | User clicks "Install autostart"         |
| `uninstall_autostart` | `Result<DaemonStatus,_>` | User clicks "Uninstall autostart"       |
| `set_view_mode`       | `Result<(),_>`           | User clicks "Back to chat" or "Manager" |

Events the frontend listens for:

| Event                   | Payload        | When emitted                                   |
| ----------------------- | -------------- | ---------------------------------------------- |
| `daemon-status-changed` | `DaemonStatus` | Watcher detects state transition (~2s polling) |

## Accessibility notes

- All interactive elements are real `<button>` tags (not divs with onClick
  handlers).
- Focus states use the violet accent.
- Color contrast: foreground `#e8e8e8` on `#000000` background is WCAG AAA for
  normal text.
- The `<kbd>` element for keyboard hints is styled but semantically correct.

## Future shape (if/when the manager surface grows)

Likely additions, in order of priority:

1. **Log viewer** — tail of `daemon.stdout.log` / `daemon.stderr.log` (or
   `journalctl --user` output on Linux). Probably needs virtualized scrolling
   once logs grow.
2. **Settings editor** — install path, port, autostart toggle, entity-core path
   override. Form with save → invoke set commands.
3. **Update controls** — "check for source update," "update Psycheros now,"
   "revert to previous source."
4. **Diagnostics export** — bundle config + recent logs into a shareable archive
   for support.

At point #1, a framework (probably Svelte for its size) becomes worth the build
complexity. Until then, vanilla is the right call.
