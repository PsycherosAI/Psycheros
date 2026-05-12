# Releases

How Psycheros releases are versioned, tagged, and published. The four packages
in this workspace have **independent version lineages** — `psycheros` does not
move in lockstep with `entity-core`, `entity-loom`, or `launcher`.

## Tag conventions

Every release tag uses the form `<package>-v<ver>`:

| Package       | Tag prefix      | Example              | Shipped as                                       |
| ------------- | --------------- | -------------------- | ------------------------------------------------ |
| `psycheros`   | `psycheros-v`   | `psycheros-v0.1.0`   | Docker image at `ghcr.io/psycherosai/psycheros`  |
| `entity-core` | `entity-core-v` | `entity-core-v0.1.0` | Tagged source release (tarball + zip)            |
| `entity-loom` | `entity-loom-v` | `entity-loom-v0.2.0` | Tagged source release (tarball + zip)            |
| `launcher`    | `launcher-v`    | `launcher-v0.1.0`    | Bundle (zip + tarball + raw helper-script files) |

Each package follows [Semantic Versioning 2.0](https://semver.org/). MAJOR for
breaking changes, MINOR for backwards-compatible additions, PATCH for fixes. The
`version` field in each package's `deno.json` always tracks the most recently
published release of that package.

Tags are immutable once published. If something is wrong with a release, we
publish a new patch version; we don't move or delete release tags.

## Cutting a release

Every release is operator-initiated. All release/publish workflows are
manual-dispatch by design — there is no auto-release on push, merge, or tag
creation.

The flow:

1. **Land the change on `main`** (via PR or direct push to the curated tree).
2. **Bump the package's `deno.json` version** to match the version you're about
   to tag. Commit and push.
3. **Tag the commit** with the appropriate `<package>-v<ver>` form and push the
   tag to origin.
4. **Create a GitHub Release** at the tag with release notes (the "Generate
   release notes" button gives you a reasonable starting point).
5. **Dispatch the workflows** that correspond to the package.

### `launcher-v*`, `entity-core-v*`, `entity-loom-v*`

```bash
gh workflow run release.yml --ref entity-core-v0.1.0
```

The `release` workflow routes to exactly one job based on the tag prefix and
uploads the package's artifacts to the Release. Non-matching jobs skip.

- **launcher** uploads the bundle (zip + tarball) plus raw `dashboard.ts`,
  `run.sh`, `run.ps1` for direct `curl`/`iwr` consumption.
- **entity-core** and **entity-loom** upload a scoped source tarball + zip
  containing only their `packages/<name>/` subtree, renamed to `<tag>.tar.gz` /
  `<tag>.zip` at the top level.

### `psycheros-v*`

The Psycheros harness release is a **two-step dispatch** because the artifact is
a Docker image (built by `docker.yml`) rather than a file uploaded to a Release:

```bash
# After tag + Release exist:
gh workflow run docker.yml  --ref psycheros-v0.1.0   # builds + pushes the image
gh workflow run release.yml --ref psycheros-v0.1.0   # emits notes-only marker
```

The `release` workflow for `psycheros-v*` does not attach files — the container
image is the artifact. It emits notice annotations reminding the operator to
also dispatch `docker.yml`.

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

## Finding the latest release per package

The GitHub Releases page has a single repo-wide "Latest" badge that GitHub
assigns based on **creation timestamp**, not by tag prefix or package. With four
independent version lineages in this workspace, the "Latest" badge is not a
reliable per-package indicator — it just marks whichever release was created
most recently.

To find the latest of a specific package:

- **Browser**: filter the Releases page by tag prefix in the URL bar — e.g.
  [releases?q=launcher-v](https://github.com/PsycherosAI/Psycheros/releases?q=launcher-v).
- **CLI**: `gh release list --limit 50` and find the highest `<package>-v*` tag.
- **API**:
  `gh api repos/PsycherosAI/Psycheros/releases --jq '.[] | select(.tag_name | startswith("launcher-v")) | .tag_name' | head -1`.

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

The `launcher-v*` bundle layout:

```
launcher-v0.1.0/
  dashboard.ts
  run.sh
  run.ps1
  README.md
```

Plus the raw `dashboard.ts`, `run.sh`, and `run.ps1` files attached at the top
of the Release for direct fetch.

## Workflow files

- [`.github/workflows/docker.yml`](.github/workflows/docker.yml) — builds and
  pushes the Psycheros container image.
- [`.github/workflows/release.yml`](.github/workflows/release.yml) — uploads
  source / launcher artifacts to a GitHub Release; routes by tag prefix.
- [`.github/workflows/check.yml`](.github/workflows/check.yml) — type-check,
  lint, and `deno fmt --check` across the workspace.
