#!/usr/bin/env bash
# Dev bootstrap: stage local Deno into the Tauri sidecar slot + generate
# placeholder RGBA icons. Run this once before `cargo tauri dev` on a fresh
# checkout. The CI release pipeline does the equivalent (see
# scripts/bundle-source.sh + .github/workflows/) at build time.
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
# Placeholder icons
# ----------------------------------------------------------------------------
# Tauri's `generate_context!` macro validates icons at compile time and
# rejects anything that isn't RGBA. We generate solid-color RGBA PNGs as
# placeholders; replace with a real brand asset before any public release.
# See docs/release.md.
ICON_DIR="src-tauri/icons"
mkdir -p "$ICON_DIR"

SOURCE_PNG="$ICON_DIR/source.png"
if [[ ! -f "$SOURCE_PNG" ]]; then
  python3 - "$SOURCE_PNG" <<'PY'
import struct, sys, zlib
path = sys.argv[1]
W = H = 512
rgba = (30, 18, 48, 255)  # deep violet, matches brand
def chunk(t, d):
    crc = zlib.crc32(t + d) & 0xffffffff
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", crc)
sig = b"\x89PNG\r\n\x1a\n"
ihdr = struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0)  # color type 6 = RGBA
row = b"\x00" + bytes(rgba) * W
raw = row * H
idat = zlib.compress(raw, 9)
with open(path, "wb") as f:
    f.write(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))
PY
fi

if [[ "$(uname -s)" == "Darwin" ]] && command -v sips >/dev/null 2>&1; then
  sips -z 32  32  "$SOURCE_PNG" --out "$ICON_DIR/32x32.png"      >/dev/null
  sips -z 128 128 "$SOURCE_PNG" --out "$ICON_DIR/128x128.png"    >/dev/null
  sips -z 256 256 "$SOURCE_PNG" --out "$ICON_DIR/128x128@2x.png" >/dev/null
else
  # No sips — just copy the source. Cosmetically wrong but Tauri will accept.
  cp "$SOURCE_PNG" "$ICON_DIR/32x32.png"
  cp "$SOURCE_PNG" "$ICON_DIR/128x128.png"
  cp "$SOURCE_PNG" "$ICON_DIR/128x128@2x.png"
fi
# .icns / .ico needed for `cargo tauri build` bundling; not for `tauri dev`.
# Generate via `cargo tauri icon path/to/real.png` when a real asset exists.

echo "icons: placeholders generated in $ICON_DIR"

# ----------------------------------------------------------------------------
# Placeholder release-bundle.tar.gz
# ----------------------------------------------------------------------------
# Tauri resolves bundle.resources at compile time, so the file must exist
# even for `cargo check`. CI runs `bundle-source.sh` to produce the real
# bundle; dev cycle just needs a non-empty tarball. Preserves any existing
# real bundle the dev has already staged.
RESOURCE_DIR="src-tauri/resources"
mkdir -p "$RESOURCE_DIR"
if [[ ! -f "$RESOURCE_DIR/release-bundle.tar.gz" ]]; then
  STUB_TMP=$(mktemp -d -t psy-bundle-stub-XXXXX)
  echo "scaffold-only placeholder — run scripts/bundle-source.sh for the real bundle" \
    > "$STUB_TMP/README.md"
  tar -czf "$RESOURCE_DIR/release-bundle.tar.gz" -C "$STUB_TMP" .
  rm -rf "$STUB_TMP"
  echo "bundle: stub release-bundle.tar.gz staged"
else
  echo "bundle: existing release-bundle.tar.gz preserved"
fi

echo ""
echo "Setup complete. Next:"
echo "  npx --yes @tauri-apps/cli@^2.0 dev   # or: cargo install tauri-cli && cargo tauri dev"
