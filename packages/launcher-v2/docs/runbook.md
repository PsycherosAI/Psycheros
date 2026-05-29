# Operations runbook

Common failure modes for end users, with the in-app paths to recovery. Every
action below has a button in the launcher — this document just maps symptoms to
the right surface. Linked from the Diagnostics card.

## Symptom → recovery

### "Atlas keeps crashing" warning appears

The launcher detected ≥3 daemon Running→Installed transitions in a minute (a
"crashloop"). Most common causes, in order of likelihood:

1. **Port 3000 is held by another process.** Click `Diagnostics` to see the
   warning details, which will name the holding process if the launcher could
   resolve it (macOS only, via `lsof`). Quit that process and the daemon will
   bind on its next restart cycle.
2. **Corrupted source clone.** Open `Data` → click `Re-init`, type `REINIT` to
   confirm. The launcher uninstalls the service, deletes the cloned source, and
   walks you back through the first-run wizard. Memories and vault content
   survive — only source + identity reset.
3. **A bug in the daemon itself.** Open `Diagnostics` → scroll to the log panel
   → filter to ERROR. The most recent crash stack trace surfaces there. If it's
   an upstream regression you can roll back to the last known good release: open
   `Diagnostics` → `Update history` → find the entry you were on before the bad
   update → click `Roll back`.

### "Memory sync is offline" warning appears

The daemon's MCP client can't reach `entity-core`. The warning has a
`Restart daemon` button; that's the fix in ~95% of cases.

If restart doesn't clear it, open `Diagnostics` and check the log panel for
`entity-core` errors. The `entity-core` subprocess spawns inside the daemon — if
Deno itself died or got SIGKILLed (memory pressure, etc.), the daemon's MCP
client keeps reporting offline until the daemon restarts.

**Windows:** if the log shows
`'deno' is not recognized as an internal or
external command`, the daemon can't
find Deno to spawn entity-core. This can happen if the launcher didn't pass
`PSYCHEROS_MCP_COMMAND` (fixed in a recent release). Workaround: reinstall via
the launcher's `Uninstall` → `Install` flow, which re-registers the service with
the correct environment variables.

### Daemon won't start at all

Check `Diagnostics` → daemon state.

- **Not installed**: open the manager card and click `Install
  autostart` (or
  `Install for manual start/stop`).
- **Stopped**: click `Start daemon` on the manager card.
- **Installed** (stuck): wait ~20 seconds — the launcher will surface a more
  specific warning if it detects a port conflict. Then refer to the "keeps
  crashing" section above.

### First-run bootstrap fails with "git not found"

A warning card appears with a platform-specific fix button:

- **macOS**: Click `Install Command Line Tools`. macOS opens the Xcode CLT
  installer dialog. Click `Install`, wait ~5 minutes, then come back and click
  `Try again`.
- **Windows**: Click `Download Git for Windows`. The Git for Windows download
  page opens in your browser. Run the installer, then come back and click
  `Try again`.
- **Linux**: Click `Open install instructions`. The Git Linux download page
  opens in your browser. Follow the instructions for your distribution, then
  come back and click `Try again`.

### Update reports "couldn't find any tagged releases"

You're on a channel that has no published tags yet.

- **Stable** (default): one of these is true:
  - The maintainer hasn't tagged a new release since you installed.
  - The launcher is pointed at the wrong source repo (this would be a packaging
    bug — file an issue).
- **Beta**: switch to `Stable` via `Settings` → `Update channel` →
  `Switch to Stable`. Beta tags don't always exist between releases.

### "Disk full" or "Operation not permitted" on backup

The launcher writes to `~/Downloads/`. Check that:

- Your Downloads folder isn't full / read-only.
- macOS hasn't revoked Full Disk Access from the launcher (System Settings →
  Privacy & Security → Full Disk Access).

### Restore reports an error

The most actionable surface is the error string the launcher returns —
psycheros's import endpoint emits specific reasons (invalid manifest, schema
version mismatch, missing zip entries). If the message says
`Unsupported schema version`, the backup was produced by a newer psycheros than
what's currently installed — update to that version (via `Settings` →
`Source version`) and retry.

### Diagnostics card shows "—" for PID / last exit

This is normal when the daemon isn't installed (no service for launchd to report
on) or hasn't been started yet. Once the daemon runs at least once, both fields
populate.

### Settings card's "Edit in Psycheros" button is disabled

The button only works when the daemon is `Running` — the chat view it switches
to is a splash screen otherwise. Start the daemon from the manager card, then
the button activates.

## When in doubt

The `Diagnostics` card is the launcher's complete state snapshot — versions,
paths, daemon state, log tail, update history. Most of the support conversations
the maintainers have start with "open Diagnostics, take a screenshot, send it
over." That's still the fastest support path.

For destructive operations, the launcher always asks twice:

- **Uninstall** + **Restore** ask via a single-confirm modal.
- **Wipe entity data** + **Re-init Psycheros** ask via a typed-confirm modal
  (type `WIPE` or `REINIT`).

These aren't pointless friction — typing the phrase is the only remaining
seatbelt between you and irreversibly clobbering your entity. Both operations
are undoable only if you've previously backed up.
