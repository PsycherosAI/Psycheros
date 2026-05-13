#!/usr/bin/env bash
set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo ""
echo -e "${CYAN}  Psycheros Launcher${NC}"
echo ""

# Check for Deno
if ! command -v deno &> /dev/null; then
  echo -e "${YELLOW}  Deno not found. Installing...${NC}"
  curl -fsSL https://deno.land/install.sh | sh
  export DENO_DIR="${DENO_DIR:-$HOME/.deno}"
  export PATH="$DENO_DIR/bin:$PATH"

  if ! command -v deno &> /dev/null; then
    echo -e "${RED}  Deno installation failed.${NC}"
    echo "  Please install manually: https://deno.land"
    echo "  Then run this script again."
    exit 1
  fi
  echo -e "${GREEN}  Deno installed!${NC}"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Check for Git (optional — dashboard can download repos without it)
if command -v git &> /dev/null; then
  echo -e "  Git:  $(git --version | head -1)"
else
  echo -e "  Git:  ${YELLOW}not found (updates will be slower without it)${NC}"
fi

# Launcher version (read from the sibling deno.json — same source as the
# dashboard's in-UI chip).
LAUNCHER_VERSION="$(awk -F'"' '/"version"/ {print $4; exit}' "$SCRIPT_DIR/deno.json" 2>/dev/null)"
if [[ -n "$LAUNCHER_VERSION" ]]; then
  echo -e "  Launcher: v${LAUNCHER_VERSION}"
fi
echo ""
echo -e "${CYAN}  Opening dashboard in your browser...${NC}"
echo ""

# Find dashboard.ts
DASHBOARD="$SCRIPT_DIR/dashboard.ts"

if [ ! -f "$DASHBOARD" ]; then
  echo -e "${RED}  dashboard.ts not found in $SCRIPT_DIR${NC}"
  echo "  Make sure run.sh and dashboard.ts are in the same folder."
  exit 1
fi

deno run --allow-net --allow-read --allow-write --allow-run --allow-env "$DASHBOARD"
