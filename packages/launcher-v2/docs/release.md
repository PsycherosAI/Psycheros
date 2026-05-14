# Release pipeline

How the launcher gets from source to a downloadable `.dmg` / `.msi` /
`.AppImage`, with explicit notes on the signing posture for v1.

## CI matrix

The launcher builds on four targets:

| Target                     | Runner           | Artifacts                     |
| -------------------------- | ---------------- | ----------------------------- |
| `aarch64-apple-darwin`     | `macos-14`       | `Psycheros.dmg` (arm64)       |
| `x86_64-apple-darwin`      | `macos-13`       | `Psycheros.dmg` (Intel)       |
| `x86_64-pc-windows-msvc`   | `windows-latest` | `Psycheros-setup.msi`, `.exe` |
| `x86_64-unknown-linux-gnu` | `ubuntu-22.04`   | `Psycheros.AppImage`, `.deb`  |

Built via `tauri-apps/tauri-action`. Per-job steps:

1. Check out monorepo.
2. Install Rust + Deno + Node (for `@tauri-apps/cli` if used).
3. Run `packages/launcher-v2/scripts/bundle-source.sh` — produces
   `release-bundle.tar.gz` in `src-tauri/resources/`.
4. Download the Deno binary for this triple, place at
   `src-tauri/binaries/deno-<triple>` (Tauri sidecar naming).
5. `cargo tauri build --target <triple>`.
6. Upload the produced installer to the GitHub Release.

## What CI does NOT do

- No code signing (v1 decision — see "Signing posture" below).
- No notarization (macOS).
- No SmartScreen pre-registration (Windows).

These are operational steps that require paid certificates and stable build
identities. They're real Phase 5 work, not Phase 1 scaffold.

## Signing posture

**v1 ships unsigned**, by deliberate decision. The cost-benefit of code signing
for an indie / pre-1.0 launcher is poor:

- macOS Developer ID: $99/year + notarization workflow.
- Windows Authenticode: $200-400/year for a usable cert.
- Linux: typically not signed; package managers verify integrity.

Without signing, users hit OS-level warnings on first run:

| OS      | Warning                                  | Workaround                                                                                   |
| ------- | ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| macOS   | Gatekeeper: "cannot verify developer"    | Right-click → Open → confirm. Or `xattr -d com.apple.quarantine /Applications/Psycheros.app` |
| Windows | SmartScreen: "Windows protected your PC" | Click "More info" → "Run anyway"                                                             |
| Linux   | None (AppImage), none (.deb)             | n/a                                                                                          |

These warnings are scary for non-technical users. The README and first-launch
documentation must call them out clearly. Once revenue or user count justifies
the cert cost, signing is a Phase 5 add-on.

### What we DO sign

`tauri-plugin-updater` uses its own Ed25519 signing for update manifests —
separate from OS-level code signing. This is cheap (free, just a key pair) and
important: it prevents a compromised update server from pushing malicious shell
updates. CI generates the keypair once and stores the private key in GitHub
secrets; the public key is baked into the launcher build.

This means: **even unsigned at the OS level, the launcher only auto-updates to
binaries signed by our private key.** Decent mitigation against the
update-server attack surface.

## Release cadence

Two channels:

| Channel             | Trigger                       | Audience         |
| ------------------- | ----------------------------- | ---------------- |
| Stable (`main`)     | Git tag `launcher-v*`         | Public           |
| Pre-release (`dev`) | Push to `launcher-dev` branch | Internal testing |

The `tauri-plugin-updater` manifest server is configured to deliver the latest
stable to most users and pre-releases to opted-in testers.

## Per-platform packaging

### macOS — `.dmg`

Tauri builds a `.app` and packages it in a `.dmg` for distribution. The `.app`'s
`Contents/MacOS/Psycheros` is the Rust binary; `Contents/Resources/` holds the
bundled Deno sidecar, the release-bundle tarball, and icons.

Min macOS version: 12.0 (set in `tauri.conf.json` →
`bundle.macOS.minimumSystemVersion`).

### Windows — `.msi` + `.exe`

Tauri uses WiX to produce a `.msi` installer plus a standalone `.exe`. The MSI
handles Start Menu shortcut, uninstaller registration. The `.exe` is the same
binary, useful for users who prefer not to install.

WiX language: `en-US` (single-locale for now).

### Linux — `.AppImage` + `.deb`

`.AppImage` is the recommended distribution format — no system dependencies,
runs anywhere. `.deb` is provided for Debian/Ubuntu users who prefer apt-managed
installs.

`.deb` `depends` field: currently empty. Add `libwebkit2gtk-4.1-0` when the
build matures, since Tauri 2 on Linux uses webkit2gtk.

## Per-version bundle artifacts

A single release tag produces these GitHub Release assets:

```
Psycheros-v0.1.0-arm64.dmg            macOS Apple Silicon
Psycheros-v0.1.0-x64.dmg              macOS Intel
Psycheros-v0.1.0-setup.msi            Windows installer
Psycheros-v0.1.0-x64.exe              Windows standalone
Psycheros-v0.1.0-x64.AppImage         Linux universal
Psycheros-v0.1.0-amd64.deb            Debian/Ubuntu
latest.json                           tauri-plugin-updater manifest
```

`latest.json` is the manifest the auto-updater polls. It lists per- platform
URLs and Ed25519 signatures.

## Branding before going public

Before any public release, replace the placeholder violet-square icons. The
launcher's brand should align with whatever overall Psycheros visual identity
exists (see `packages/psycheros/web/`).

To regenerate icons from a 1024x1024 source PNG:

```bash
cd packages/launcher-v2
npx --yes @tauri-apps/cli@^2.0 icon path/to/source.png
```

This emits properly-sized PNGs + `.icns` (macOS) + `.ico` (Windows) into
`src-tauri/icons/`.

## Local testing of a release build

Build a one-platform installer locally:

```bash
cd packages/launcher-v2
./scripts/bundle-source.sh
npx --yes @tauri-apps/cli@^2.0 build
```

Outputs land in `src-tauri/target/release/bundle/`. Open the `.dmg` or `.msi`,
install, run — same user experience as a CI-produced artifact except for the
Gatekeeper/SmartScreen warning (no signed release builds locally).
