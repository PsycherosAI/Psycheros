# Releases

How Psycheros releases are versioned, tagged, and published. The five packages
in this workspace have **independent version lineages** — `psycheros` does not
move in lockstep with `entity-core`, `entity-loom`, `launcher-v2`, or
`launcher`.

## Tag conventions

Every release tag uses the form `<package>-v<ver>`:

| Package       | Tag prefix      | Example              | Shipped as                                      |
| ------------- | --------------- | -------------------- | ----------------------------------------------- |
| `psycheros`   | `psycheros-v`   | `psycheros-v0.1.0`   | Docker image at `ghcr.io/psycherosai/psycheros` |
| `entity-core` | `entity-core-v` | `entity-core-v0.1.0` | Tagged source release (tarball + zip)           |
| `entity-loom` | `entity-loom-v` | `entity-loom-v0.2.0` | Tagged source release (tarball + zip)           |
| `launcher-v2` | `launcher-v2-v` | `launcher-v2-v0.2.0` | Desktop app (.dmg + .msi)                       |
| `launcher`    | `launcher-v`    | `launcher-v0.1.0`    | Bundle (zip + tarball) + raw install scripts    |

Each package follows [Semantic Versioning 2.0](https://semver.org/). MAJOR for
breaking changes, MINOR for backwards-compatible additions, PATCH for fixes. The
`version` field in each package's `deno.json` always tracks the most recently
published release of that package.

Tags are immutable once published. If something is wrong with a release, we
publish a new patch version; we don't move or delete release tags.

## Cutting a release

Releases are **maintainer-initiated and operator-curated**. There is no
auto-release on push, merge, or branch activity — but signed annotated tag
pushes **do auto-fire the corresponding artifact workflows** (see "What
auto-fires on tag push" below). The maintainer's act is pushing the tag;
everything downstream of that is mechanical.

### A release event is a sweep across all five packages

Each of the five packages has an **independent semver lineage**. A release event
is not a single-package decision — it's a survey across all five, producing 0–N
tag-cuts depending on which packages are ready to ship.

Per release event, each package is in one of three states:

| State           | Condition                                                                                                                                                                | Action                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **CLEAN**       | `packages/<pkg>/deno.json:version` on `main` equals the version in the most recent `<pkg>-v*` tag, and the `packages/<pkg>/` source tree matches what that tag points at | Skip this package this cycle                                                  |
| **PENDING_TAG** | `deno.json:version` on `main` is greater than the latest tag                                                                                                             | Cut `<pkg>-v<version>`                                                        |
| **DRIFT**       | versions equal, source tree differs                                                                                                                                      | Bump `packages/<pkg>/deno.json`'s `version` field on `main`, then cut the tag |

**Drift policy is a soft warning.** A drifted package does not block other
packages from being released. Maintainers may have valid reasons to keep a
package drifted across multiple release cycles (in-progress work not yet ready
for consumption). Surface drift; don't force resolution.

**Version bumps are part of the release decision, not a precondition for work.**
Source changes accumulate on `main` between releases; the version bump happens
at release time, when the maintainer decides how the change maps to semver
weight (PATCH for fixes, MINOR for backwards-compatible additions, MAJOR for
breaking changes).

### Release notes — `CHANGELOG.md` as source of truth

Each package keeps a [Keep a Changelog](https://keepachangelog.com/)-format file
at `packages/<pkg>/CHANGELOG.md`. This is the canonical source for "what changed
in this release" — it ships with the source tarball / launcher bundle /
container image, and the GitHub Release page for each tag is auto-generated from
the matching entry.

When a new release version ships, the maintainer:

1. Bumps `packages/<pkg>/deno.json:version`.
2. Prepends a new entry to `packages/<pkg>/CHANGELOG.md` of the form:
   ```markdown
   ## [<new-version>] - <YYYY-MM-DD>

   ### Fixed

   - <bullet per fix>

   ### Changed

   - <bullet per behavior change>

   ### Added

   - <bullet per new feature>
   ```
3. Adds the `[<new-version>]: https://...` link reference at the file's bottom
   block (preserve newest-first order).
4. Commits both files together: `git commit -S -m "bump(<pkg>): <old> → <new>"`.
5. Tags + pushes — `release.yml` extracts the new entry and posts it to the GH
   Release page automatically.

### The flow for a single release event

For each package the maintainer decides to ship:

1. **For DRIFT packages**: bump `packages/<pkg>/deno.json:version` AND append
   the new `CHANGELOG.md` entry on `main`, commit (signed), push.
2. **Cut a signed annotated tag** of the form `<package>-v<version>` against the
   current `main` tip:
   ```bash
   git tag -s -a <package>-v<version> -m "<one-line release summary>" <SHA>
   git push origin <package>-v<version>
   ```
3. **Done.** The auto-fire workflow extracts the CHANGELOG entry and creates the
   GH Release page with curated notes. No manual override step is needed in the
   normal flow. (For corrections to an already-published release page,
   `gh release edit <tag> --notes-file
   <(path/to/notes>` is still available
   as a recovery path.)

### What auto-fires on tag push

A `<package>-v*` tag push fires the appropriate workflows immediately:

| Tag prefix       | docker.yml                                                                            | release.yml                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `psycheros-v*`   | Builds + pushes `ghcr.io/psycherosai/psycheros:<semver>` + `:latest` + `:sha-<short>` | Creates GH Release, notes from `packages/psycheros/CHANGELOG.md`                                                                                                                            |
| `launcher-v2-v*` | —                                                                                     | Creates GH Release (**Latest badge**), notes from `packages/launcher-v2/CHANGELOG.md`; uploads `.dmg` + `.msi` + stable-named `Psycheros-macOS-latest.dmg` / `Psycheros-Windows-latest.msi` |
| `launcher-v*`    | —                                                                                     | Creates GH Release, notes from `packages/launcher/CHANGELOG.md`; uploads bundle `.zip` / `.tar.gz` + raw `install.sh` / `install.ps1`. **Deprecated — v1 lineage.**                         |
| `entity-core-v*` | —                                                                                     | Creates GH Release, notes from `packages/entity-core/CHANGELOG.md`; uploads scoped source `.tar.gz` / `.zip`                                                                                |
| `entity-loom-v*` | —                                                                                     | Creates GH Release, notes from `packages/entity-loom/CHANGELOG.md`; uploads scoped source `.tar.gz` / `.zip`                                                                                |

The note-extraction logic lives in `.github/scripts/extract-changelog-entry.sh`
— it reads the latest top-level entry from the package's CHANGELOG.md at the
tagged SHA and writes it to a tempfile passed to
`gh release create --notes-file`. If the entry is missing or empty, the workflow
falls back to `--generate-notes` and emits a `::warning::`.

Both workflows are also preserved as `workflow_dispatch`-capable for manual
retries (e.g. transient network failures or cache misses); the canonical trigger
is the tag push.

## Image tag conventions (psycheros)

`docker.yml` produces multiple tags on the GHCR image per successful build:

| Image tag         | When pushed                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `<semver>`        | When dispatched against a `psycheros-v<semver>` tag (the prefix is stripped — e.g. tag `psycheros-v0.1.0` → image `psycheros:0.1.0`) |
| `latest`          | Auto-applied alongside `<semver>` for any `psycheros-v*` tag dispatch (via `flavor.latest=auto`)                                     |
| `<branch-name>`   | When dispatched against a branch ref (used for dev/feature builds — not for canonical releases)                                      |
| `sha-<short-sha>` | Always — every build is reachable by its exact commit                                                                                |

### Pinning in production

`docker pull psycheros:latest` will give consumers the most recently
**dispatched** semver release — but the tag is **not semver-compared**.
Dispatching `docker.yml` against an older tag (say re-running for
`psycheros-v0.0.5` after `0.1.0` already shipped) would move `latest` backward
onto the older image. This is a sharp edge in `flavor.latest=auto`.

For production deployments, **pin to a specific `<semver>` tag** (e.g.
`psycheros:0.1.0`). Those tags are immutable per the no-retag policy above.
Reserve `latest` for casual / try-it-out consumption.

### `main` and other branch tags

A branch dispatch (e.g. against `refs/heads/main`) tags the image with the
branch name (e.g. `psycheros:main`). It does **not** push `latest` (that's
reserved for semver tag dispatches).

If `main` and the most recent release tag point at the same commit (the default
state right after a release), dispatching `docker.yml` against `main` would
conflict with the existing `sha-<short>` tag — the registry would move the sha
pointer from the release version to the new branch build. Avoid dispatching
`docker.yml` against `main` until `main` has advanced past the release.

## Latest badge policy

The repo-wide "Latest" badge is set explicitly via `gh release create --latest`
/ `--latest=false` per release. The **launcher-v2** lineage owns the badge — the
launcher is the user-facing entry point and the recommended Quickstart artifact
for first-time visitors, so strangers landing on `/releases` should be guided
there rather than to the notes-only harness release.

| Tag prefix       | `--latest`       |
| ---------------- | ---------------- |
| `launcher-v2-v*` | `--latest`       |
| `launcher-v*`    | `--latest=false` |
| `psycheros-v*`   | `--latest=false` |
| `entity-core-v*` | `--latest=false` |
| `entity-loom-v*` | `--latest=false` |

This buys stable URLs the docs site (or anyone else) can hardcode without
rebuilding on every launcher-v2 cut:

- `https://github.com/PsycherosAI/Psycheros/releases/latest` redirects to the
  newest launcher-v2 release page.
- `https://github.com/.../releases/latest/download/Psycheros-macOS-latest.dmg`
  and `.../Psycheros-Windows-latest.msi` redirect to the latest desktop
  installers — filenames are version-less by design specifically to make these
  URLs stable.
- `https://github.com/.../releases/latest/download/install.sh` and
  `.../install.ps1` redirect to the latest v1 launcher's install scripts (still
  available for existing users).

The bundle archives (`launcher-v*.tar.gz` / `.zip`) embed the version in the
filename, so a "latest bundle" URL would only work if we also renamed the
uploads to be version-less. We don't, for now — pinned-version filenames are the
right default for asset integrity.

## Finding the latest release per package

To find the latest of a specific package (other than the launcher, which the
Latest badge already points at):

- **Browser**: filter the Releases page by tag prefix in the URL bar — e.g.
  [releases?q=entity-core-v](https://github.com/PsycherosAI/Psycheros/releases?q=entity-core-v).
- **CLI**: `gh release list --limit 50` and find the highest `<package>-v*` tag.
- **API**:
  `gh api repos/PsycherosAI/Psycheros/releases --jq '.[] | select(.tag_name | startswith("entity-core-v")) | .tag_name' | head -1`.

For the Docker image, `docker pull ghcr.io/psycherosai/psycheros:latest` is the
supported "give me the most recent stable release" path (with the caveat
described in **Pinning in production** above).

## What does NOT auto-release

To make the manual-dispatch posture explicit, none of the following trigger a
release:

- Pushing a commit to `main`
- Merging a pull request
- Creating or pushing a tag (tag creation is one step; publishing artifacts is a
  separate explicit dispatch)
- Publishing a GitHub Release without dispatching `release.yml`

The operator is always the one to decide that a release is ready to ship.

## Source release contents

The `entity-core-v*` and `entity-loom-v*` source tarballs contain that package's
source tree only, scoped to `packages/<name>/` and renamed to `<tag>/` at the
top level.

GitHub additionally attaches "Source code (zip)" and "Source code (tar.gz)" of
the **entire monorepo** at the tag — that's a GitHub default we can't disable on
free-tier repos. Our scoped per-package archive is the canonical consumption
path for distribution; the monorepo source is available for users who want the
full workspace.

The `launcher-v*` bundle (`.tar.gz` and `.zip`) contains the full
`packages/launcher/` source tree, renamed to `<tag>/` at the top level:

```
launcher-v0.2.0/
  CHANGELOG.md
  README.md
  dashboard.ts
  deno.json
  docs/
  install.ps1
  install.sh
  run.ps1
  run.sh
  version.ts
```

The runtime entry-point `dashboard.ts` imports `./version.ts`, which imports
`./deno.json` — so a runnable launcher needs the full bundle, not just the boot
script. `release.yml` runs `deno check` against the staged bundle as a smoke
test before upload to catch any future siblings being added without the bundle
step being updated.

Plus the raw `install.sh` and `install.ps1` files attached at the top of the
Release for direct fetch. These clone the Psycheros monorepo themselves and
don't depend on bundle siblings, so they work as standalone downloads for users
who want a one-step bootstrap.

## Workflow files

- [`.github/workflows/docker.yml`](.github/workflows/docker.yml) — builds and
  pushes the Psycheros container image.
- [`.github/workflows/release.yml`](.github/workflows/release.yml) — uploads
  source / launcher artifacts to a GitHub Release; routes by tag prefix.
- [`.github/workflows/check.yml`](.github/workflows/check.yml) — type-check,
  lint, and `deno fmt --check` across the workspace.
