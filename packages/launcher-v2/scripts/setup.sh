#!/usr/bin/env bash
# Dev bootstrap: stage local Deno into the Tauri sidecar slot + generate
# placeholder RGBA icons. Run this once before `cargo tauri dev` on a fresh
# checkout.
#
# Deno version note: whatever `deno` is on PATH at the time this script runs
# gets copied verbatim into `src-tauri/binaries/deno-<triple>` and — once a
# release pipeline exists for launcher-v2 — ships to end users inside the
# Tauri app bundle. There is no second pinning layer downstream. Confirm
# `deno --version` matches /.deno-version (currently 2.7.14) before running
# this for a build that will be distributed. Dev builds tolerate drift; user
# builds should not.
set -euo pipefail

cd "$(dirname "$0")/.."

# ----------------------------------------------------------------------------
# Stage local Deno as the sidecar binary
# ----------------------------------------------------------------------------
if ! command -v deno >/dev/null 2>&1; then
  echo "deno not found on PATH. Install from https://deno.land first." >&2
  exit 1
fi
DENO_BIN="$(command -v deno)"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)    TRIPLE="aarch64-apple-darwin" ;;
  Darwin-x86_64)   TRIPLE="x86_64-apple-darwin" ;;
  Linux-x86_64)    TRIPLE="x86_64-unknown-linux-gnu" ;;
  Linux-aarch64)   TRIPLE="aarch64-unknown-linux-gnu" ;;
  MINGW64_NT*|MSYS_NT*) TRIPLE="x86_64-pc-windows-msvc" ;;
  *)
    echo "Unsupported platform: $(uname -s)-$(uname -m)" >&2
    echo "Set TRIPLE manually and re-run." >&2
    exit 1
    ;;
esac

mkdir -p src-tauri/binaries
DEST="src-tauri/binaries/deno-${TRIPLE}"
# rm first — macOS won't overwrite a recently-executed binary cleanly
rm -f "$DEST"
cp "$DENO_BIN" "$DEST"
chmod +x "$DEST"
echo "sidecar: $DENO_BIN -> $DEST"

# ----------------------------------------------------------------------------
# Icons
# ----------------------------------------------------------------------------
# Real brand-asset icons (heart-chip with the cyan→purple gradient) are
# committed under src-tauri/icons/. If they're missing — typically because
# someone wiped the dir — regenerate them from the canonical SVG. See
# src-tauri/icons/README.md for the full regeneration recipe; this block
# just runs the same recipe automatically as a setup-time safety net.
ICON_DIR="src-tauri/icons"
CANONICAL_SVG="../../site/src/assets/psycheros-logo.svg"

mkdir -p "$ICON_DIR"

if [[ ! -f "$ICON_DIR/icon.icns" || ! -f "$ICON_DIR/icon.ico" || \
      ! -f "$ICON_DIR/32x32.png" || ! -f "$ICON_DIR/128x128.png" || \
      ! -f "$ICON_DIR/128x128@2x.png" ]]; then
  echo "icons: missing — regenerating from $CANONICAL_SVG"
  if [[ "$(uname -s)" != "Darwin" ]] || ! command -v sips >/dev/null 2>&1; then
    echo "  cannot regenerate without sips (macOS-only); commit a real" >&2
    echo "  src-tauri/icons/icon.png and re-run on macOS." >&2
    exit 1
  fi
  if [[ ! -f "$CANONICAL_SVG" ]]; then
    echo "  canonical SVG not found at $CANONICAL_SVG" >&2
    exit 1
  fi
  sips -s format png --resampleHeightWidth 1024 1024 "$CANONICAL_SVG" \
    --out "$ICON_DIR/icon.png" >/dev/null
  npx --yes @tauri-apps/cli@^2.0 icon "$ICON_DIR/icon.png" \
    --output "$ICON_DIR/" >/dev/null
  echo "icons: regenerated in $ICON_DIR"
else
  echo "icons: present in $ICON_DIR"
fi

# Note: no release-bundle.tar.gz staging anymore. Source is fetched at
# first-run via `git clone` from the public Psycheros repo (see
# src-tauri/src/bundle/mod.rs::clone_or_fetch_source). The launcher
# itself ships with no embedded source, only the bundled Deno sidecar.

echo ""
echo "Setup complete. Next:"
echo "  npx --yes @tauri-apps/cli@^2.0 dev   # or: cargo install tauri-cli && cargo tauri dev"
