#!/usr/bin/env bash
# Produce src-tauri/resources/release-bundle.tar.gz containing the pruned
# psycheros source bundle that the Tauri app embeds and extracts on first
# run (see src-tauri/src/bundle/mod.rs + docs/bundle.md).
#
# Contents of the bundle:
#   packages/psycheros/      — harness daemon
#   packages/entity-core/    — canonical identity / memory MCP server
#   packages/scheduler/      — shared durable scheduler dep
#   deno.json                — workspace root with hoisted deps
#   deno.lock                — frozen for reproducible cache
#
# Explicitly excluded:
#   packages/launcher/         (v1, being replaced by this very app)
#   packages/launcher-v2/      (this package — would be circular)
#   packages/entity-loom/      (separate standalone utility)
#   .github/, docs/, tests/    (not needed at runtime)
#   Dockerfile, entrypoint.sh  (docker-specific)
#
# This script is run by CI on release. Devs only need it if they want to
# test the extraction path locally.
set -euo pipefail

cd "$(dirname "$0")/.."

# Resolve monorepo root (../../ from this package).
MONOREPO_ROOT="$(cd ../.. && pwd)"
STAGE_DIR=$(mktemp -d -t psy-bundle-XXXXX)
trap 'rm -rf "$STAGE_DIR"' EXIT

echo "Staging bundle in $STAGE_DIR ..."

# Copy workspace root files
cp "$MONOREPO_ROOT/deno.json" "$STAGE_DIR/"
cp "$MONOREPO_ROOT/deno.lock" "$STAGE_DIR/"

# Copy required packages (preserve directory structure)
mkdir -p "$STAGE_DIR/packages"
for pkg in psycheros entity-core scheduler; do
  cp -R "$MONOREPO_ROOT/packages/$pkg" "$STAGE_DIR/packages/$pkg"
  # Strip runtime + dev-only state that may have been generated locally
  rm -rf "$STAGE_DIR/packages/$pkg/.psycheros" \
         "$STAGE_DIR/packages/$pkg/identity" \
         "$STAGE_DIR/packages/$pkg/.snapshots" \
         "$STAGE_DIR/packages/$pkg/memories" \
         "$STAGE_DIR/packages/$pkg/custom-tools" \
         "$STAGE_DIR/packages/$pkg/backgrounds" \
         "$STAGE_DIR/packages/$pkg/data" \
         "$STAGE_DIR/packages/$pkg/lib" \
         "$STAGE_DIR/packages/$pkg/tests" \
         "$STAGE_DIR/packages/$pkg/docs" \
         "$STAGE_DIR/packages/$pkg/scripts" \
         "$STAGE_DIR/packages/$pkg/CLAUDE.md" \
         "$STAGE_DIR/packages/$pkg/CHANGELOG.md" \
         "$STAGE_DIR/packages/$pkg/.env.example" \
         "$STAGE_DIR/packages/$pkg/Dockerfile" \
         "$STAGE_DIR/packages/$pkg/entrypoint.sh"
done

mkdir -p src-tauri/resources
OUT="$(cd src-tauri/resources && pwd)/release-bundle.tar.gz"
tar -czf "$OUT" -C "$STAGE_DIR" .
SIZE=$(du -h "$OUT" | cut -f1)
echo "Bundle written: $OUT ($SIZE)"
