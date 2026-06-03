# Dev bootstrap (Windows): stage the local Deno into the Tauri sidecar slot.
#
# Mirror of scripts/setup.sh for Windows hosts. Run this once before
# `cargo tauri dev` on a fresh checkout.
#
# Deno version note: whatever `deno` is on PATH at the time this script runs
# gets copied verbatim into `src-tauri/binaries/deno-x86_64-pc-windows-msvc.exe`
# and — once a release pipeline exists for launcher-v2 on Windows — ships to
# end users inside the Tauri app bundle. There is no second pinning layer
# downstream. Confirm `deno --version` matches /.deno-version (currently 2.7.14)
# before running this for a build that will be distributed. Dev builds tolerate
# drift; user builds should not.
#
# Icons are committed binaries under src-tauri/icons/ and are not regenerated
# from this script — regeneration requires macOS-only `sips`, see
# src-tauri/icons/README.md for the manual recipe.

$ErrorActionPreference = 'Stop'

Set-Location (Join-Path $PSScriptRoot '..')

# ----------------------------------------------------------------------------
# Stage local Deno as the sidecar binary
# ----------------------------------------------------------------------------
$denoCmd = Get-Command deno -ErrorAction SilentlyContinue
if (-not $denoCmd) {
    Write-Error "deno not found on PATH. Install from https://deno.land first."
}
$denoBin = $denoCmd.Source

# The Tauri sidecar lookup uses the Rust target triple suffix. On 64-bit
# Windows that's always x86_64-pc-windows-msvc; we don't currently ship an
# arm64-windows build (rust-toolchain on the runner doesn't target it).
$triple = 'x86_64-pc-windows-msvc'

$binDir = Join-Path 'src-tauri' 'binaries'
if (-not (Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir | Out-Null
}

$dest = Join-Path $binDir "deno-$triple.exe"

# Remove first — Windows can refuse to overwrite an in-use binary, and a
# previous `cargo tauri dev` run may have left a handle. The Remove-Item
# fails loudly if a process is still holding the file, which is what we
# want — better to surface the conflict than to silently ship a stale copy.
if (Test-Path $dest) {
    Remove-Item -Path $dest -Force
}
Copy-Item -Path $denoBin -Destination $dest
Write-Host "sidecar: $denoBin -> $dest"

# ----------------------------------------------------------------------------
# Daemon-runner sidecar — built by cargo, no extra staging needed
# ----------------------------------------------------------------------------
# `psycheros-daemon-runner` is a `[[bin]]` target in the same Cargo crate
# as the launcher. Both `cargo tauri dev` and `cargo tauri build` run
# `cargo build` as their first step, which compiles every `[[bin]]` in
# the manifest — so the runner ends up at
# `src-tauri/target/<profile>/psycheros-daemon-runner.exe` without any
# explicit step here.
#
# Tauri's bundle phase auto-includes additional `[[bin]]` targets from
# `target/release/` into the MSI, installed alongside the main launcher
# .exe. The Rust supervisor's `resolve_sidecar_runner` falls back to
# `current_exe().parent().join("psycheros-daemon-runner.exe")` to find
# it at runtime — same in dev (`target/debug` siblings) and prod
# (INSTALLDIR siblings).
#
# (An earlier iteration of this script also staged the runner into
# `src-tauri/binaries/psycheros-daemon-runner-<triple>.exe` to satisfy
# tauri-build's externalBin existence check. That externalBin entry was
# removed because it caused a duplicate-component WiX error — the
# externalBin staging + the `[[bin]]` auto-include both landed the same
# file in INSTALLDIR. Removing the externalBin entry also removed the
# need for a placeholder-bootstrap dance here.)
#
# Stale staged copies under src-tauri/binaries/ from earlier checkouts
# are no longer referenced by anything; clean them up so the binaries/
# directory only holds files Tauri actually consumes.
$staleRunner = Join-Path $binDir "psycheros-daemon-runner-$triple.exe"
if (Test-Path $staleRunner) {
    Remove-Item -Path $staleRunner -Force
    Write-Host "removed stale staged runner: $staleRunner"
}

# ----------------------------------------------------------------------------
# Icons
# ----------------------------------------------------------------------------
$iconDir = Join-Path 'src-tauri' 'icons'
$required = @(
    'icon.icns',
    'icon.ico',
    '32x32.png',
    '128x128.png',
    '128x128@2x.png'
)
$missing = $required | Where-Object { -not (Test-Path (Join-Path $iconDir $_)) }
if ($missing.Count -gt 0) {
    Write-Host "icons: missing $($missing -join ', ') in $iconDir"
    Write-Host "  Regenerate from macOS (sips-based recipe in src-tauri/icons/README.md)."
    Write-Error "icons are required by the Tauri build — aborting."
}
Write-Host "icons: present in $iconDir"

Write-Host ''
Write-Host 'Setup complete. Next:'
Write-Host '  npx --yes @tauri-apps/cli@^2.0 dev'
Write-Host '  # or: cargo install tauri-cli && cargo tauri dev'
