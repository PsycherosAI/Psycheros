#!/bin/sh
set -e

# Seed entity-core identity dirs from Psycheros templates if empty.
# On first run with a fresh volume mount, entity-core's data dirs are empty.
# Without seeding, MCP pull returns empty arrays and the entity has no identity.

TEMPLATES="/app/packages/psycheros/templates/identity"
DATA="/app/packages/entity-core/data"

for subdir in self user relationship custom; do
  target="$DATA/$subdir"
  mkdir -p "$target"

  # Check if target has any .md files
  if ! ls "$target"/*.md >/dev/null 2>&1; then
    # Only copy if template dir exists and has .md files
    if ls "$TEMPLATES/$subdir"/*.md >/dev/null 2>&1; then
      cp "$TEMPLATES/$subdir"/*.md "$target/"
      count=$(ls "$target"/*.md 2>/dev/null | wc -l | tr -d ' ')
      echo "[Entrypoint] Seeded $subdir/ with $count template file(s)"
    fi
  else
    echo "[Entrypoint] $subdir/ already has identity files, skipping"
  fi
done

# Ensure memory subdirs exist in entity-core (canonical location)
for memdir in daily weekly monthly yearly significant archive/daily archive/weekly archive/monthly; do
  mkdir -p "$DATA/memories/$memdir"
done

# Symlink Psycheros memories → entity-core memories (single source of truth).
# Psycheros cron writes here; entity-core MCP also writes here.
# Both systems share one physical copy, persisted by the entity-core-data volume.
if [ -d "/app/packages/psycheros/memories" ] && [ ! -L "/app/packages/psycheros/memories" ]; then
  # Remove the directory if it exists (from Docker build) so we can symlink
  rm -rf "/app/packages/psycheros/memories"
fi
if [ ! -L "/app/packages/psycheros/memories" ]; then
  ln -s "$DATA/memories" "/app/packages/psycheros/memories"
  echo "[Entrypoint] Linked psycheros/memories → entity-core/data/memories"
fi

# ---------------------------------------------------------------------------
# Optional: debug SSH server.
#
# Gated by PSYCHEROS_SSH_ENABLED. When off (the default), the sshd binary is
# present in the image but never started. When on, the entrypoint:
#   1. Requires authorized keys (env var or pre-mounted file). Refuses to
#      start otherwise — we don't want a publicly-listening sshd with no auth.
#   2. Generates persistent host keys under .psycheros/ssh/ on first run so
#      fingerprints stay stable across container restarts.
#   3. Launches sshd in the background on PSYCHEROS_SSH_PORT (default 47291).
# ---------------------------------------------------------------------------
SSH_ENABLED=$(printf '%s' "${PSYCHEROS_SSH_ENABLED:-false}" | tr '[:upper:]' '[:lower:]')
if [ "$SSH_ENABLED" = "true" ] || [ "$SSH_ENABLED" = "1" ] || [ "$SSH_ENABLED" = "yes" ]; then
  SSH_PORT="${PSYCHEROS_SSH_PORT:-47291}"
  SSH_KEY_DIR="/app/packages/psycheros/.psycheros/ssh"
  AUTH_KEYS_FILE="/root/.ssh/authorized_keys"

  mkdir -p "$SSH_KEY_DIR" /root/.ssh /var/run/sshd
  chmod 700 /root/.ssh "$SSH_KEY_DIR"

  # Materialize authorized_keys from env var if provided. A pre-mounted
  # /root/.ssh/authorized_keys is also accepted (env var wins).
  #
  # The env var accepts multiple keys separated by commas — required because
  # UnRAID's variable input is single-line and strips literal newlines. We
  # translate "," → newline before writing, then strip leading/trailing
  # whitespace per line. Single-key (no comma) usage is unaffected.
  if [ -n "${PSYCHEROS_SSH_AUTHORIZED_KEYS:-}" ]; then
    printf '%s\n' "$PSYCHEROS_SSH_AUTHORIZED_KEYS" \
      | tr ',' '\n' \
      | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
      | grep -v '^$' \
      > "$AUTH_KEYS_FILE"
    chmod 600 "$AUTH_KEYS_FILE"
    key_count=$(wc -l < "$AUTH_KEYS_FILE" | tr -d ' ')
    echo "[Entrypoint] SSH: wrote $key_count key(s) to authorized_keys from PSYCHEROS_SSH_AUTHORIZED_KEYS"
  fi

  if [ ! -s "$AUTH_KEYS_FILE" ]; then
    echo "[Entrypoint] SSH: PSYCHEROS_SSH_ENABLED=true but no authorized keys found." >&2
    echo "[Entrypoint] SSH: set PSYCHEROS_SSH_AUTHORIZED_KEYS or mount $AUTH_KEYS_FILE. Skipping sshd." >&2
  else
    # Generate persistent host keys on first run.
    if [ ! -f "$SSH_KEY_DIR/ssh_host_ed25519_key" ]; then
      ssh-keygen -q -t ed25519 -N '' -f "$SSH_KEY_DIR/ssh_host_ed25519_key"
      echo "[Entrypoint] SSH: generated ed25519 host key"
    fi
    if [ ! -f "$SSH_KEY_DIR/ssh_host_rsa_key" ]; then
      ssh-keygen -q -t rsa -b 4096 -N '' -f "$SSH_KEY_DIR/ssh_host_rsa_key"
      echo "[Entrypoint] SSH: generated rsa host key"
    fi
    chmod 600 "$SSH_KEY_DIR"/ssh_host_*_key
    chmod 644 "$SSH_KEY_DIR"/ssh_host_*_key.pub

    # sshd runs detached (-D would foreground it; we want the deno process to
    # remain PID-1's child). Port comes from env so operators can override.
    # Non-fatal on failure: this is a debug aid, the main service still runs.
    if /usr/sbin/sshd -p "$SSH_PORT" -e; then
      echo "[Entrypoint] SSH: sshd listening on port $SSH_PORT"
    else
      echo "[Entrypoint] SSH: sshd failed to start on port $SSH_PORT — continuing without it." >&2
    fi
  fi
fi

exec /usr/bin/dumb-init -- "$@"
