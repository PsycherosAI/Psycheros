# Psycheros + entity-core single-container image.
#
# Bundles the harness (port 3000) and the entity-core MCP server as one
# unit. Psycheros spawns entity-core as a subprocess via stdio MCP, so
# they ship together for the default homelab/single-host deployment.
#
# Target: linux/amd64 (UnRAID homelab) — can be cross-built for other arches.
# Build context: monorepo root.
#
# Usage:
#   docker build -f packages/psycheros/Dockerfile --platform linux/amd64 \
#     -t psycheros .
#   docker run -d --name psycheros -p 3000:3000 \
#     -e ZAI_API_KEY=<key> -e TZ=America/Los_Angeles \
#     -v /path/to/entity-core-data:/app/packages/entity-core/data \
#     -v /path/to/psycheros:/app/packages/psycheros/.psycheros \
#     psycheros

FROM denoland/deno:2.7.5

# Install dumb-init for proper PID 1 signal handling, plus an SSH server and a
# small set of diagnostic tools used when an operator (or an external Claude
# Code agent) connects via SSH for live in-container debugging. SSH is gated
# at runtime by PSYCHEROS_SSH_ENABLED (default off) — the binaries are baked
# in but inert unless explicitly turned on.
RUN apt-get update && apt-get install -y --no-install-recommends \
        dumb-init \
        openssh-server \
        bash \
        ca-certificates \
        git \
        curl \
        wget \
        jq \
        less \
        vim-tiny \
        procps \
        htop \
        sqlite3 \
        ripgrep \
        lsof \
        iproute2 \
        iputils-ping \
        tree \
        file \
    && ln -sf /usr/bin/vim.tiny /usr/local/bin/vim \
    && mkdir -p /var/run/sshd /root/.ssh \
    && chmod 700 /root/.ssh \
    && rm -rf /var/lib/apt/lists/*

# Interactive-shell niceties for human operators (only fires for login shells;
# agent sessions over non-TTY ssh are unaffected because aliases don't apply).
RUN printf '%s\n' \
    '# Psycheros debug shell — interactive niceties' \
    'if command -v dircolors >/dev/null 2>&1; then eval "$(dircolors -b)"; fi' \
    "alias ls='ls --color=auto'" \
    "alias ll='ls --color=auto -lh'" \
    "alias la='ls --color=auto -lhA'" \
    "alias grep='grep --color=auto'" \
    > /etc/profile.d/psycheros-debug.sh

# Hardened sshd drop-in. The entrypoint sets the listen port at runtime and
# generates / loads host keys from the persistent .psycheros volume so the
# host key fingerprint is stable across container restarts.
RUN printf '%s\n' \
    '# Psycheros debug SSH — runtime-gated, key-only, root login restricted to keys.' \
    'PermitRootLogin prohibit-password' \
    'PasswordAuthentication no' \
    'PermitEmptyPasswords no' \
    'ChallengeResponseAuthentication no' \
    'KbdInteractiveAuthentication no' \
    'PubkeyAuthentication yes' \
    'UsePAM no' \
    'X11Forwarding no' \
    'PrintMotd no' \
    'AuthorizedKeysFile /root/.ssh/authorized_keys' \
    'HostKey /app/packages/psycheros/.psycheros/ssh/ssh_host_ed25519_key' \
    'HostKey /app/packages/psycheros/.psycheros/ssh/ssh_host_rsa_key' \
    'LogLevel VERBOSE' \
    'Subsystem sftp internal-sftp' \
    '# Force agent-friendly env into every child session. Required because' \
    "# Dockerfile ENV doesn't propagate through sshd, and AcceptEnv from the" \
    '# client (e.g. macOS sending LANG=en_US.UTF-8) would otherwise win.' \
    '# NOTE: OpenSSH only honors the FIRST SetEnv line at a given scope —' \
    '# all variables must be on one line.' \
    'SetEnv LANG=C.UTF-8 LC_ALL=C.UTF-8 EDITOR=vi PAGER=cat GIT_PAGER=cat MANPAGER=cat' \
    > /etc/ssh/sshd_config.d/psycheros.conf

WORKDIR /app

# Workspace config + all package configs for workspace resolution
COPY deno.json deno.lock* /app/
COPY packages/psycheros/deno.json /app/packages/psycheros/deno.json
COPY packages/entity-core/deno.json /app/packages/entity-core/deno.json
COPY packages/entity-loom/deno.json /app/packages/entity-loom/deno.json
COPY packages/launcher/deno.json /app/packages/launcher/deno.json

# Source for the two packages that run in this image
COPY packages/psycheros /app/packages/psycheros/
COPY packages/entity-core /app/packages/entity-core/

# Entrypoint script — co-located with the psycheros package
RUN chmod +x /app/packages/psycheros/entrypoint.sh

# Drop the agent orientation brief into root's home so an AI agent that
# connects via SSH can `cat ~/AGENT_BRIEF.md` for layout, process model,
# and rules of engagement before doing anything.
RUN cp /app/packages/psycheros/scripts/AGENT_BRIEF.md /root/AGENT_BRIEF.md

# Enable nodeModulesDir + vendor on the workspace root deno.json (workspace
# members can't set these). Forces deps into /app/node_modules and
# /app/vendor instead of the unreliable global /deno-dir cache.
RUN deno eval "\
    const j = JSON.parse(Deno.readTextFileSync('/app/deno.json')); \
    j.nodeModulesDir = 'auto'; j.vendor = true; \
    Deno.writeTextFileSync('/app/deno.json', JSON.stringify(j, null, 2) + '\n');"

# Install all dependencies into local node_modules/ directories
RUN cd /app/packages/psycheros && deno install --entrypoint src/main.ts \
    && cd /app/packages/entity-core && deno install --entrypoint src/mod.ts

# Cache dynamic imports that `deno install` can't statically analyze
RUN cd /app/packages/psycheros && deno cache npm:@huggingface/transformers@3.3.1

# Warm-start both apps to cache any remaining transitive JSR deps
# (e.g. @denosaurs/plug → @std/path@0.217.0 pulled by @db/sqlite)
RUN cd /app/packages/entity-core && timeout 5s deno run -A --unstable-cron src/mod.ts || true
RUN cd /app/packages/psycheros && timeout 10s deno run -A --unstable-cron src/main.ts || true

# Create volume-mounted directories (will be overlaid by volume mounts)
# Note: /app/packages/psycheros/memories is NOT listed — entrypoint symlinks
# it to entity-core/data/memories so both systems share one physical copy.
RUN mkdir -p \
    /app/packages/psycheros/.snapshots \
    /app/packages/psycheros/.psycheros/backgrounds \
    /app/packages/psycheros/.psycheros/vault \
    /app/packages/entity-core/data

EXPOSE 3000

# Debug SSH (only reachable when PSYCHEROS_SSH_ENABLED=true and the host maps
# the port). Default is an obscure high port to avoid collision with anything
# operators may already run; can be overridden with PSYCHEROS_SSH_PORT.
EXPOSE 47291

# Default environment — MCP wired up for single-container layout.
# Force UTC to prevent local-time Date methods from drifting.
ENV TZ=UTC

# Shell environment defaults. Tuned for AI-agent debug sessions: predictable
# UTF-8, no pagers (which would hang a non-TTY ssh session), sensible editor.
ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    EDITOR=vi \
    PAGER=cat \
    GIT_PAGER=cat \
    MANPAGER=cat

ENV PSYCHEROS_HOST=0.0.0.0
ENV PSYCHEROS_PORT=3000
ENV PSYCHEROS_MCP_ENABLED=true
ENV PSYCHEROS_MCP_COMMAND=deno
ENV PSYCHEROS_MCP_ARGS="run -A --cached-only --unstable-cron /app/packages/entity-core/src/mod.ts"
ENV PSYCHEROS_ENTITY_CORE_DATA_DIR=/app/packages/entity-core/data

# Debug SSH defaults — disabled unless explicitly enabled at runtime.
ENV PSYCHEROS_SSH_ENABLED=false
ENV PSYCHEROS_SSH_PORT=47291

# Health check (start-period accounts for embedding model load time)
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD deno eval "const r = await fetch('http://localhost:3000/health'); if (!r.ok) Deno.exit(1);"

# Set working directory to psycheros so Deno.cwd() resolves static files correctly
WORKDIR /app/packages/psycheros

# Entrypoint seeds identity templates, then execs into dumb-init → deno
ENTRYPOINT ["/app/packages/psycheros/entrypoint.sh"]
CMD ["deno", "run", "-A", "--cached-only", "--unstable-cron", "/app/packages/psycheros/src/main.ts"]
