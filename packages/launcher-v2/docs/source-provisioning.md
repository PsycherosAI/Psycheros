# Source provisioning + bundle composition

The launcher ships a small Rust binary + a bundled Deno sidecar. It does NOT
ship Psycheros source — that gets cloned from the public GitHub repo on first
run, pinned to a tagged release, and updated through a separate channel when
newer tags are published.

This is the architectural pivot from the early scaffold, which embedded a
`release-bundle.tar.gz` of pruned source inside the `.app`. The git-clone model
is what's in production now; the tarball model is historical only.

## What's in the `.app` / `.exe` / `.AppImage`

```
Resources/
├── deno                      Bundled Deno (~100MB, per target triple)
└── icons/                    App icons
Contents/MacOS/Psycheros      The Rust shell binary (~10MB)
```

That's it. No embedded source tarball, no script bundle, no auxiliary runtimes.
Per-platform totals are ~120MB — in line with Slack / Discord / VS Code
installers, well under Docker Desktop.

## First-run source provisioning

On a fresh install, the launcher's first-run wizard runs three steps
([`src-tauri/src/bundle/mod.rs`](../src-tauri/src/bundle/mod.rs)):

1. **`clone_or_fetch_source`** — shallow git clone of the public repo at the
   latest matching tag.
   - URL: `https://github.com/PsycherosAI/Psycheros`
   - Tag pattern: `psycheros-v*` (semver-sorted client-side; highest wins)
   - Target: `<data>/source/`
   - Depth: 1 (no history; just the snapshot at the resolved tag)
2. **`stage_bundled_deno`** — copies the Tauri sidecar Deno from
   `<.app>/Contents/Resources/deno-<triple>` to a stable path at
   `<data>/bin/deno`. The OS service definition references the stable path so it
   survives shell auto-updates that move the .app's internal layout.
3. **`warm_deno_cache`** — runs `<data>/bin/deno cache src/main.ts` inside the
   cloned source. Slow (~30-60s on a cold machine pulling all jsr/npm deps to
   `~/.cache/deno`); progress is streamed to the first-run UI via the bootstrap
   ticker so the wait is visible.

After the three steps complete, `config.json` is stamped with the cloned tag
name (e.g. `psycheros-v0.3.3`) in `bundled_source_version`. That stamp is the
canonical "what's installed" signal for the update detector — see below.

## Two update channels

The launcher and the cloned source update through separate mechanisms, on
separate cadences.

| What updates                                 | Trigger                                | Mechanism                                                                                                                                                          | Cadence                                                 |
| -------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| **Tauri shell** (Rust binary + bundled Deno) | `tauri-plugin-updater` poll            | Replaces the `.app`. Standard Tauri auto-update.                                                                                                                   | Rare — only when launcher code or Deno version changes. |
| **Cloned source** (Psycheros code)           | Background watcher + user "Update now" | `git fetch origin <tag>` + `git reset --hard FETCH_HEAD` against `<data>/source/`. Daemon restarted via `supervisor.restart()`. State in `<data>/data/` untouched. | Frequent — every tagged psycheros release.              |

The decoupling is the point: psycheros ships often, the launcher rarely ships.
Users shouldn't have to re-download a 120MB `.app` every time a psycheros tag
drops.

### Update detection

A background thread in
[`src-tauri/src/app/update_watcher.rs`](../src-tauri/src/app/update_watcher.rs)
polls `git ls-remote --tags --refs` every 3 hours, semver-sorts the matching
`psycheros-v*` tags, and compares the highest against
`config.bundled_source_version`. On a rising-edge mismatch it emits
`update-available` to the frontend and injects an in-window toast. The frontend
manager card also runs a direct check on every load to cover the "watcher fired
while user was in chat-view, listener missed it" race.

### Update application

When the user clicks **Update now**, `apply_source_update`
([`commands.rs`](../src-tauri/src/commands.rs)):

1. Re-resolves the latest tag (in case it advanced since detection).
2. `git fetch --depth 1 origin <tag>` into the existing clone.
3. `git reset --hard FETCH_HEAD` — handles both branches and tags uniformly.
   Annotated tags get peeled to their commit automatically.
4. `deno cache src/main.ts` to pull any new deps (incremental, near- instant
   when `deno.lock` is unchanged).
5. `supervisor.restart()` cycles the daemon so it picks up new code.
6. Stamps the new tag name in `bundled_source_version`.

Progress streams to the frontend as `source-update-progress` events, reusing the
bootstrap card's ticker component.

### Runtime sync on shell updates

The staged Deno at `<data>/bin/deno` is a copy, so a shell update that ships a
newer bundled sidecar does nothing to it on its own — and first-run never
re-runs for an existing install (the intact source clone and staged binary make
`needs_first_run` false). Until 2026-10-25 that was a real gap: a Deno pin bump
reached new installs but never installs that had already booted once, while the
daemon-side version-guard banner told users to update an app they had already
updated.

`stage_deno_if_needed` ([`commands.rs`](../src-tauri/src/commands.rs)) closes
it: probe the versions of the bundled sidecar and the staged binary
(`bundle::deno_version_of` — a `--version` exec with a first-line parse) and
re-stage the sidecar over `<data>/bin/deno` when they differ. Wired into four
points — app startup, both install buttons, and Start (before the macOS re-sign
pass). Details that matter:

- **Version-keyed, not byte-keyed** — a same-version rebuild is a no-op, so
  normal starts don't re-copy a ~100MB binary. An unprobeable sidecar (dev
  builds without one) is left alone rather than blind-copied every start.
- **No cache re-warm** — DENO_DIR's remote/npm caches are not
  version-partitioned and the supervisor starts the daemon with plain `deno run`
  (not `--cached-only`), so the swap rides the existing warm cache.
- **A running daemon keeps its old image** — Unix swaps the inode safely and the
  process exits on the binary it started with; Windows cannot replace an in-use
  exe at all, so the failure surfaces on Start/Install and the next
  Start-after-Stop lands it. The app-startup hook covers the autostart case
  where the OS boots the daemon before the launcher ever opens.

## Why git clone and not the tarball model

The tarball model embedded `release-bundle.tar.gz` inside the `.app` and
re-extracted on every shell update. Considered but discarded:

1. **Couples source updates to shell updates.** Every psycheros change required
   publishing a new `.app` + every user re-downloading 120MB. Hostile to the
   user, especially over weak connections, and forced the shell-update cadence
   to track the source-update cadence (which is high).
2. **Two ways to fail.** The build-time tarball baking AND the runtime
   extraction were both stateful operations that could silently produce wrong
   content (pruning misses, path-shattering from spaces in user dirs, etc.).
   Git's `clone` + `reset --hard` has well-defined semantics across every
   commit + extensive prior art for failure recovery.
3. **No room for the tag-based release model.** With a tarball, "which psycheros
   version am I running?" is implicit in the launcher's build. With git clone +
   tag tracking, the user's installed version is a tag name they can read,
   compare, and (if needed) roll forward or back by reinstalling.

Trade-offs accepted:

- **Requires `git` on the user's machine.** macOS ships it via Xcode Command
  Line Tools; first run may trigger a one-time CLT install prompt. The launcher
  surfaces a clear "install Xcode CLT" message if git is absent.
- **Requires network at first run and every update.** The launcher is a
  network-attached product anyway (talks to LLM APIs); this isn't a meaningful
  restriction.

## The bundled vec0 extension caveat

Psycheros's `prepareVectorExtension(projectRoot)` currently downloads
`vec0.{so,dylib,dll}` to `<source>/packages/psycheros/lib/` on first daemon
start. Every source update wipes `<source>/`, so vec0 is re-downloaded after
every update — ~5MB, slow on slow connections.

This is wasteful but not broken. A future psycheros change should move vec0 to a
launcher-managed cache dir (`<data>/cache/`) so it survives source updates.
That's a separate piece of work; the current flow functions, it just costs a few
extra MB per update.

## Reproducibility

Two installs at the same psycheros tag produce identical content inside
`<data>/source/`:

- `deno.lock` is committed in the public repo and frozen at clone time.
- Tag refs are immutable (annotated tags include the commit SHA; the launcher
  uses `git reset --hard FETCH_HEAD` which checks out the exact peeled commit).
- The shallow clone's lack of history is deterministic — same content every
  time.

The Tauri shell side is reproducible separately via Cargo.lock + the Tauri build
pipeline; see [`release.md`](release.md).
