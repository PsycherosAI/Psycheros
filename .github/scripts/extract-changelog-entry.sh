#!/usr/bin/env bash
#
# Extract a single version's CHANGELOG entry to stdout.
#
# Usage:   extract-changelog-entry.sh <pkg> <version>
# Example: extract-changelog-entry.sh psycheros 0.1.2
#
# Reads packages/<pkg>/CHANGELOG.md (Keep-a-Changelog format), finds the
# entry whose header starts with "## [<version>]", and prints its body
# (everything until the next "## [..." header or EOF), filtering out
# trailing link-reference lines of the form "[<x>]: <url>".
#
# Exits 0 if a non-empty entry was found and printed.
# Exits 1 if the CHANGELOG is missing, the entry is missing, or the
# extracted body is whitespace-only — callers should fall back to
# `gh release create --generate-notes` in that case.

set -euo pipefail

PKG="${1:?usage: extract-changelog-entry.sh <pkg> <version>}"
VERSION="${2:?usage: extract-changelog-entry.sh <pkg> <version>}"
CHANGELOG="packages/${PKG}/CHANGELOG.md"

if [ ! -f "$CHANGELOG" ]; then
  echo "::warning::CHANGELOG not found at $CHANGELOG" >&2
  exit 1
fi

# Find the section between "## [<VERSION>]" (start, exclusive of the header
# line itself) and the next "## [..." header (exclusive of that line too).
# Also filter out trailing Keep-a-Changelog link-reference definitions of
# the form "[<x>]: <url>" — they belong to the file as a whole, not any
# one entry, and would leak into the last entry if not filtered.
ENTRY=$(awk -v v="$VERSION" '
  /^## \[/ {
    if (found) exit
    if (index($0, "## ["v"]") == 1) { found = 1; next }
  }
  found && !/^\[.*\]:/ { print }
' "$CHANGELOG")

# Trim leading + trailing blank lines.
ENTRY=$(printf "%s" "$ENTRY" \
  | sed -e ':a' -e '/^$/{$d;N;ba' -e '}' \
        -e '/./,$!d')

# Refuse on whitespace-only.
if [ -z "$(printf "%s" "$ENTRY" | tr -d '[:space:]')" ]; then
  echo "::warning::No CHANGELOG entry found for $PKG version $VERSION" >&2
  exit 1
fi

printf "%s\n" "$ENTRY"
