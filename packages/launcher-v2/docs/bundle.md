# Release bundle

The launcher embeds a tarball containing a pruned snapshot of the Psycheros
source tree, plus a per-platform Deno binary as a Tauri sidecar. On first run
(or after a shell auto-update), it extracts the tarball, copies Deno to a stable
path, and primes Deno's dependency cache against the extracted source.

This is **Approach C** from the earlier research: shell binary, bundled Deno,
and source-prune tarball — together in one .app. Approaches A (source only, no
Deno bundled) and B (`deno compile` everything to one binary) were considered
and rejected. See
[`architecture.md`](architecture.md#why-tauri--deno-sidecar-not-electron-not-native)
for the rationale.

## Bundle composition

### Inside the `.app` / `.exe` / `.AppImage`

```
Resources/
├── deno                      Bundled Deno (~100MB, per target triple)
├── release-bundle.tar.gz     Pruned source (~5-10MB compressed)
└── icons/                    App icons
```

### Inside `release-bundle.tar.gz`

```
deno.json                 Workspace root with hoisted deps
deno.lock                 Frozen for reproducible cache
packages/
├── psycheros/            Main daemon
├── entity-core/          Canonical identity / memory MCP server
└── scheduler/            Shared scheduler dep
```

### Explicitly **not** in the bundle

- `packages/launcher/` (v1 — being replaced)
- `packages/launcher-v2/` (this package — circular)
- `packages/entity-loom/` (separate utility, separate distribution)
- `.github/`, `docs/`, `tests/` (not needed at runtime)
- `Dockerfile`, `entrypoint.sh` (Docker-only)
- `.psycheros/`, `identity/`, `.snapshots/`, etc. (user state, not source —
  these belong in the user's `<data_dir>/data/` post-install)

`scripts/bundle-source.sh` does the pruning. CI invokes it before the Tauri
build step; see [`release.md`](release.md).

## Estimated bundle size per platform

| Component               | Size        |
| ----------------------- | ----------- |
| Tauri shell binary      | ~10 MB      |
| Bundled Deno (1 triple) | ~100 MB     |
| release-bundle.tar.gz   | ~5-10 MB    |
| Icons + metadata        | ~1 MB       |
| **Total per platform**  | **~120 MB** |

In line with Slack (~200 MB), Discord (~200 MB), VS Code (~200-300 MB). Smaller
than Docker Desktop (~1 GB+). Acceptable.

## First-run extraction flow

```
1. Launcher boots, reads config.json
2. config.json missing OR bundled_source_version != bundle's version:
   a. Show "Setting up Psycheros…" progress UI
   b. Extract Resources/release-bundle.tar.gz → <data>/source/
   c. Copy Tauri sidecar Deno → <data>/bin/deno
   d. Run `<data>/bin/deno cache <data>/source/packages/psycheros/src/main.ts`
      (~30-60s on first run; pulls all npm/jsr deps to ~/.cache/deno)
   e. Write config.json with bundled_source_version
3. Continue to normal daemon-detection flow
```

The cache warm in step 2d is the slow part. Without it, the daemon's first start
would block for the same time, looking like a hang. By doing it explicitly in
the launcher's first-run UI with a progress bar, we make the wait visible and
expected.

## Shell-update vs source-update

Two separate update channels:

| What updates                    | Trigger                        | Mechanism                                                                                                     |
| ------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Tauri shell (Rust code)         | `tauri-plugin-updater` poll    | Standard Tauri auto-update flow. Replaces the `.app` binary.                                                  |
| Bundled source (Psycheros code) | Shell update OR user-initiated | Re-extract `release-bundle.tar.gz` from updated shell, OR clone fresh from GitHub. Replaces `<data>/source/`. |

Most updates will be **source-only** — the launcher itself rarely changes, but
psycheros ships frequently. Shell updates are reserved for when the launcher's
Rust code or bundle structure changes.

When a shell update lands and contains a newer `release-bundle.tar.gz`, the
first launcher boot after the update detects the version mismatch and
re-extracts. The daemon is stopped, source replaced, daemon restarted — all
visible in the UI with progress.

## Why not just clone the repo on first run?

Considered. Rejected for two reasons:

1. **Offline install impossible.** Cloning requires internet access at exactly
   the wrong moment (user just downloaded the app). Bundling means the user can
   run immediately, populate the Deno cache later when they have connectivity.
2. **Version pinning.** A clone of `main` would give the user whatever's latest,
   which may not match the launcher's expectations (the launcher's Rust code
   expects specific HTTP routes from psycheros). The bundled tarball is pinned
   to a specific psycheros version that the launcher was tested against.

The clone path is still available as a "use my own clone" advanced setting in
the manager UI for power users who want to develop psycheros locally. See
[`migration.md`](migration.md) for the existing-clone adoption flow.

## What about the bundled vec0 extension?

Currently, psycheros's `prepareVectorExtension(projectRoot)` downloads
`vec0.{so,dylib,dll}` to `<source>/packages/psycheros/lib/` on first daemon
start. After every shell update (which replaces `<source>/`), vec0 gets wiped
and redownloads — ~5MB, slow on slow connections.

A future psycheros change would move vec0 to a separate cache dir
(`<launcher_data>/cache/`) so it survives source-bundle updates. That's a polish
task; the current shape works, it's just wasteful.

## Bundle pinning + reproducibility

The bundle is reproducible:

- `deno.lock` is committed and copied into the tarball — Deno's dep resolution
  is fully pinned.
- The CI build pins Deno to a specific version (see release.md).
- `bundle-source.sh` is deterministic given a clean monorepo checkout.

Two clean builds of the same commit should produce byte-identical tarballs.
