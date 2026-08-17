/**
 * Workspace Sandbox
 *
 * Per-session sandbox directory at `dataRoot/.psycheros/workspace/<sessionId>/`.
 * Holds the OpenCode agent file, opencode.json config, and any files the
 * workspace produces.
 *
 * The blessed-tool discipline in coordination-layer.ts enforces Tier 5
 * protected paths; the OS sandbox wrap (bwrap/sandbox-exec) is applied by
 * the supervisor at spawn time.
 */

import { dirname, join } from "@std/path";
import { ensureDir } from "@std/fs";
import type { SkillFile } from "./skills.ts";
import { resolveOpencodeRuntimeDir } from "./opencode-runtime.ts";

/**
 * Layout inside a sandbox dir:
 *   <sandbox>/
 *     .opencode/
 *       agents/
 *         psycheros-workspace.md   — the agent file (first-person self-understanding)
 *     opencode.json                — MCP server config (points at our daemon)
 *     AGENTS.md                    — per-project notes (entity or user may write)
 *     (any files the workspace produces)
 */
export interface SandboxPaths {
  root: string;
  opencodeDir: string;
  agentsDir: string;
  agentFile: string;
  opencodeConfig: string;
  agentsMd: string;
}

/**
 * Resolve the paths for a session's sandbox. Doesn't create anything —
 * call `ensureSandbox` to materialize.
 */
export function resolveSandboxPaths(
  sandboxRoot: string,
  sessionId: string,
): SandboxPaths {
  const root = join(sandboxRoot, sessionId);
  const opencodeDir = join(root, ".opencode");
  const agentsDir = join(opencodeDir, "agents");
  return {
    root,
    opencodeDir,
    agentsDir,
    agentFile: join(agentsDir, "psycheros-workspace.md"),
    opencodeConfig: join(root, "opencode.json"),
    agentsMd: join(root, "AGENTS.md"),
  };
}

/**
 * Create the sandbox dir tree and return resolved paths.
 */
export async function ensureSandbox(
  sandboxRoot: string,
  sessionId: string,
  extraSkills?: SkillFile[],
): Promise<SandboxPaths> {
  const paths = resolveSandboxPaths(sandboxRoot, sessionId);
  await ensureDir(paths.agentsDir);

  // Share one OpenCode node_modules across all sandboxes (see
  // opencode-runtime.ts). No-op until the shared runtime exists.
  const { ensureSandboxRuntimeLink } = await import("./opencode-runtime.ts");
  await ensureSandboxRuntimeLink(sandboxRoot, paths.opencodeDir);

  // Bundle Psycheros workspace skills so OpenCode discovers them via its
  // native skill system. Skills guide procedures like modify-entity-data
  // (use write_entity_data, never direct DB) and author-plugin (scaffold +
  // propose_install). Entity skills requested on open ride along.
  const { bundleSkills } = await import("./skills.ts");
  const skillsDir = join(paths.opencodeDir, "skills");
  await Deno.mkdir(skillsDir, { recursive: true }).catch(() => {});
  await bundleSkills(skillsDir, extraSkills);

  return paths;
}

/**
 * Write the per-session OpenCode config file. Configures:
 * - Default agent: psycheros-workspace
 * - MCP server: remote HTTP endpoint on psycheros daemon (per-session URL)
 * - Provider: forwarded from the user's selected Psycheros LLM profile
 * - Permission: edit/bash/read allowed within sandbox (Tier 5 enforced
 *   via permissions.ts + agent-file discipline)
 *
 * The MCP URL routes per-session via path: /mcp/workspace/<sessionId>.
 *
 * The provider config injects the user's chosen LLM profile (baseUrl, model)
 * so OpenCode doesn't need separate `opencode auth` setup. The API key is
 * NOT written to disk — it's passed via the `PSYCHEROS_OPENCODE_KEY` env
 * var to the OpenCode subprocess at spawn time.
 */
export async function writeOpenCodeConfig(
  paths: SandboxPaths,
  input: {
    mcpHttpOrigin: string;
    sessionId: string;
    partyhard: boolean;
    llmProfile?: {
      baseUrl: string;
      model: string;
    };
  },
): Promise<void> {
  const mcpUrl = `${input.mcpHttpOrigin}/api/workspace/mcp/${input.sessionId}`;

  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    default_agent: "psycheros-workspace",
    mcp: {
      "psycheros-workspace": {
        type: "remote" as const,
        url: mcpUrl,
        enabled: true,
      },
    },
    // Action-type permission matrix:
    // - Reads/list/grep: allowed everywhere (silent) — low-risk.
    // - Edits/writes/bash outside sandbox: "ask" — in headless mode this
    //   auto-denies, which is the safety we want; the user can grant access
    //   via Feral mode if needed.
    // - Within sandbox (cwd): everything allowed — sandbox IS the work area.
    // - Tier 5 protected paths additionally enforced via classifyPath()
    //   gating on MCP tools + agent file prose discipline.
    //
    // Partyhard mode adds `--auto` to the opencode run argv, which overrides
    // "ask" → "allow" — the user explicit opting out of prompts.
    permission: {
      // Within working directory (sandbox): everything allowed.
      "edit": "allow",
      "write": "allow",
      "bash": "allow",
      "read": "allow",
      // Outside working directory: reads allowed (low-risk), writes/bash ask
      // (auto-denies in headless mode = safety).
      "external_directory": {
        "read": "allow",
        "edit": "ask",
        "write": "ask",
        "bash": "ask",
      },
    },
  };

  // Forward the user's LLM profile as a custom provider. OpenCode picks it
  // up via `--model psycheros-forwarded/<model>` at spawn time. API key is
  // referenced via env var so it never lands in the config file on disk.
  if (input.llmProfile) {
    config.provider = {
      "psycheros-forwarded": {
        options: {
          baseURL: input.llmProfile.baseUrl,
          apiKey: "{env:PSYCHEROS_OPENCODE_KEY}",
        },
        models: {
          [input.llmProfile.model]: { name: input.llmProfile.model },
        },
      },
    };
  }

  await Deno.writeTextFile(
    paths.opencodeConfig,
    JSON.stringify(config, null, 2),
  );
}

/**
 * Write a minimal AGENTS.md. Per-project context that the entity or user may
 * extend later. Intentionally generic — the briefing goal is already passed
 * as the first user message, so duplicating it here as the H1 just pollutes
 * the workspace's persistent context with per-task text.
 */
export async function writeAgentsMd(
  paths: SandboxPaths,
): Promise<void> {
  const content = `# Workspace Session

This workspace was spawned for a specific task. Notes about the project can go here.
`;
  await Deno.writeTextFile(paths.agentsMd, content);
}

/**
 * Build a bubblewrap (bwrap) argv that sandboxes the OpenCode process on Linux.
 *
 * Layout:
 *   --unshare-all (isolate everything by default)
 *   --share-net (re-enable network for LLM provider + MCP HTTP)
 *   --bind <sandbox> <sandbox> (workspace dir, read-write)
 *   --ro-bind <projectRoot> <projectRoot> (codebase, read-only)
 *   --dev /dev, --proc /proc (system devices/processes)
 *   --tmpfs /tmp (ephemeral tmp)
 *   -- die (rest of args are the actual command)
 *
 * NOT included: dataRoot (which contains .psycheros/db.sqlite — Tier 5).
 * The workspace reaches entity data via the MCP HTTP endpoint instead.
 *
 * Returns the binary to invoke (bwrap) and the full argv (bwrap flags + the
 * original OpenCode command). Callers pass these directly to Deno.Command.
 */
export function buildBwrapArgv(input: {
  sandboxPath: string;
  projectRoot: string;
  /** Existing host folder to work on in place — bound rw at its real path. */
  workdir?: string;
  binary: string;
  args: string[];
}): { binary: string; args: string[] } {
  // OpenCode install paths under $HOME need to be visible inside the sandbox.
  // Without these, bwrap can't find the opencode binary, much less let it
  // read its config or write to its sessions DB.
  const home = Deno.env.get("HOME") ?? "/root";
  const opencodeInstall = `${home}/.opencode`;
  const opencodeConfig = `${home}/.config/opencode`;
  const opencodeData = `${home}/.local/share/opencode`;

  // Shared OpenCode runtime (node_modules symlink target). Bound rw so
  // OpenCode can install plugin updates into the one shared copy. Only
  // bound when it actually exists — bwrap fails on missing bind sources.
  const runtimeDir = resolveOpencodeRuntimeDir(dirname(input.sandboxPath));
  const runtimeArgs = dirExistsSync(join(runtimeDir, "node_modules"))
    ? ["--bind", runtimeDir, runtimeDir]
    : [];

  return {
    binary: "bwrap",
    args: [
      "--unshare-all",
      "--share-net",
      // Die with parent — if the supervisor kills bwrap (e.g. on timeout),
      // propagate the signal to opencode inside. Without this, SIGTERM to
      // bwrap left opencode running as an orphan.
      "--die-with-parent",
      // Codebase + sandbox bindings. Order matters! bwrap layers later binds
      // over earlier ones for overlapping paths. The sandbox typically lives
      // under projectRoot (e.g. <projectRoot>/.psycheros/workspace/<id>/), so
      // we must bind projectRoot FIRST (ro) and the sandbox AFTER (rw) —
      // otherwise the ro bind shadows the sandbox subdir and writes fail.
      "--ro-bind",
      input.projectRoot,
      input.projectRoot,
      "--bind",
      input.sandboxPath,
      input.sandboxPath,
      ...runtimeArgs,
      // Workdir bind — an existing host folder the session works on in
      // place. Bound rw at its real path, AFTER the projectRoot ro-bind so
      // rw wins for that subtree. Everything else on the host stays
      // invisible; this is the kernel-scoped alternative to Feral for
      // "work on my real files" tasks.
      // EDGE: a workdir under /tmp is shadowed by the --tmpfs /tmp below —
      // the bind silently vanishes (found by live test). The supervisor
      // refuses /tmp workdirs rather than binding into oblivion.
      ...(input.workdir ? ["--bind", input.workdir, input.workdir] : []),
      // System paths needed for OpenCode to actually run — without these,
      // the sandbox is so minimal that even spawning bash/node fails.
      // Read-only: the workspace can read system binaries but can't modify them.
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind",
      "/lib64",
      "/lib64",
      "--ro-bind",
      "/bin",
      "/bin",
      "--ro-bind",
      "/sbin",
      "/sbin",
      "--ro-bind",
      "/etc",
      "/etc",
      // /var and /run — needed for TLS certs, system sockets, runtime state.
      // Without these, opencode hangs at startup (no error, just stuck).
      "--ro-bind",
      "/var",
      "/var",
      "--ro-bind",
      "/run",
      "/run",
      // OpenCode install paths under $HOME. Without these, bwrap can't find
      // the opencode binary, much less let it read config or write sessions.
      //
      // - ~/.opencode/ — binary install + bundled node_modules (read-only)
      // - ~/.config/opencode/ — user config (opencode.jsonc) (read-only)
      // - ~/.local/share/opencode/ — sessions DB + logs (read-write; this is
      //   OpenCode's own bookkeeping, NOT user data — safe to write here)
      "--ro-bind",
      opencodeInstall,
      opencodeInstall,
      "--ro-bind",
      opencodeConfig,
      opencodeConfig,
      "--bind",
      opencodeData,
      opencodeData,
      // Devices + proc + tmp.
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      "--tmpfs",
      "/tmp",
      "--",
      input.binary,
      ...input.args,
    ],
  };
}

/**
 * Build a sandbox-exec argv + Seatbelt profile that sandboxes the OpenCode
 * process on macOS. sandbox-exec is "deprecated" since macOS Sierra (2016)
 * but practically still the standard in 2026 — Apple has not provided a
 * replacement, current AI tools (Goose, etc.) still use it.
 *
 * The profile:
 *   - Denies everything by default (deny default)
 *   - Allows network (LLM provider + MCP HTTP)
 *   - Allows reads from system paths (/usr, /System, /Library, /bin, /opt)
 *   - Allows reads from projectRoot (codebase, read-only)
 *   - Allows writes to sandboxPath + /tmp + /var/tmp
 *   - Allows process execution for shell + node + opencode binary
 *   - Explicitly denies reads/writes under <dataRoot>/.psycheros (Tier 5)
 *
 * Profile is written to a temp file and passed via -f. Returns the binary
 * (sandbox-exec) and argv to invoke.
 */
export async function buildSandboxExecArgv(input: {
  sandboxPath: string;
  projectRoot: string;
  dataRoot: string;
  /** Existing host folder to work on in place — rw-allowed at its real path. */
  workdir?: string;
  /** Shared OpenCode runtime dir (node_modules symlink target), if present. */
  sharedRuntimeDir?: string;
  binary: string;
  args: string[];
}): Promise<{ binary: string; args: string[] }> {
  // Resolve symlinks for clean path matching inside the profile.
  const sandbox = await realpathOrFallback(input.sandboxPath);
  const project = await realpathOrFallback(input.projectRoot);
  const data = await realpathOrFallback(input.dataRoot);
  const opencodeBin = await realpathOrFallback(input.binary);

  // Seatbelt profile — minimal viable sandbox for OpenCode to function
  // while blocking Tier 5 paths. Generated fresh per session.
  const profile = `
(version 1)
(deny default)
(allow network*)

;; System reads — needed for libc, system calls, etc.
(allow file-read* (subpath "/usr"))
(allow file-read* (subpath "/System"))
(allow file-read* (subpath "/Library"))
(allow file-read* (subpath "/bin"))
(allow file-read* (subpath "/sbin"))
(allow file-read* (subpath "/opt/homebrew"))
(allow file-read* (subpath "/tmp"))
(allow file-read* (subpath "/var/tmp"))

;; Codebase (read-only)
(allow file-read* (subpath "${project}"))

;; Sandbox (read-write — entity's work area)
(allow file-write* (subpath "${sandbox}"))
(allow file-read* (subpath "${sandbox}"))
${
    input.workdir
      ? `
;; Workdir — an existing host folder the session works on in place (rw).
(allow file-write* (subpath "${input.workdir}"))
(allow file-read* (subpath "${input.workdir}"))
`
      : ""
  }

;; Temp dirs (read-write)
(allow file-write* (subpath "/tmp"))
(allow file-write* (subpath "/var/tmp"))

;; Process execution — opencode itself + common shells it might spawn.
;; OpenCode may spawn node/python for its own tools; allow the binaries
;; under standard install locations.
(allow process-exec (literal "${opencodeBin}"))
(allow process-exec (subpath "/usr/bin"))
(allow process-exec (subpath "/bin"))
(allow process-exec (subpath "/opt/homebrew/bin"))
(allow process-exec (subpath "/usr/local/bin"))

;; Tier 5 hard block — daemon files, always denied regardless of mode.
;; Belt-and-suspenders with classifyPath() gating in coordination-layer.ts.
(deny file-read* (subpath "${data}/.psycheros"))
(deny file-write* (subpath "${data}/.psycheros"))
${
    input.sharedRuntimeDir
      ? `
;; Shared OpenCode runtime (node_modules symlink target) — rw, so OpenCode
;; can install plugin updates into the one shared copy. More specific than
;; the Tier 5 deny above and later in the profile, so it takes precedence.
(allow file-read* (subpath "${input.sharedRuntimeDir}"))
(allow file-write* (subpath "${input.sharedRuntimeDir}"))
`
      : ""
  }
`;

  // Write profile to a temp file. sandbox-exec reads via -f.
  const profilePath = `${sandbox}/.opencode/sandbox-profile.sb`;
  await Deno.writeTextFile(profilePath, profile);

  return {
    binary: "sandbox-exec",
    args: [
      "-f",
      profilePath,
      input.binary,
      ...input.args,
    ],
  };
}

/**
 * Resolve symlinks for a path, falling back to the input if resolution fails
 * (path doesn't exist yet, permission denied, etc.).
 */
async function realpathOrFallback(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch {
    return path;
  }
}

/**
 * Pick the right OS sandbox for the current platform. Returns null if no
 * sandbox is available on this platform (Windows, or sandbox binary missing).
 *
 * When this returns null, the supervisor falls back to running OpenCode
 * directly — Tier 5 still enforced via classifyPath() + OpenCode permission
 * config (the soft layers).
 *
 * @param sandboxBinary optional explicit path (e.g., from capabilities
 *        detection). If unset, looks up via $PATH.
 */
export async function buildSandboxArgv(input: {
  sandboxPath: string;
  projectRoot: string;
  dataRoot: string;
  workdir?: string;
  binary: string;
  args: string[];
  sandboxBinary?: string;
}): Promise<{ binary: string; args: string[] } | null> {
  const platform = Deno.build.os;
  const sharedRuntimeDir = await resolveSharedRuntimeDir(input.sandboxPath);

  if (platform === "linux") {
    // bwrap required — if not available, no OS sandbox.
    const bwrapPath = input.sandboxBinary ?? await findBinary("bwrap");
    if (!bwrapPath) return null;
    return buildBwrapArgv({
      sandboxPath: input.sandboxPath,
      projectRoot: input.projectRoot,
      ...(input.workdir ? { workdir: input.workdir } : {}),
      binary: input.binary,
      args: input.args,
    });
  }

  if (platform === "darwin") {
    // sandbox-exec required — if not available, no OS sandbox.
    const sandboxExecPath = input.sandboxBinary ??
      await findBinary("sandbox-exec");
    if (!sandboxExecPath) return null;
    return await buildSandboxExecArgv({
      sandboxPath: input.sandboxPath,
      projectRoot: input.projectRoot,
      dataRoot: input.dataRoot,
      ...(input.workdir ? { workdir: input.workdir } : {}),
      ...(sharedRuntimeDir ? { sharedRuntimeDir } : {}),
      binary: input.binary,
      args: input.args,
    });
  }

  // Windows + others: no OS sandbox available. Falls back to soft mode.
  return null;
}

/**
 * The shared OpenCode runtime dir for a sandbox — a sibling of the sandbox
 * dir inside the workspace root, or null when it doesn't exist.
 */
async function resolveSharedRuntimeDir(
  sandboxPath: string,
): Promise<string | null> {
  const runtimeDir = resolveOpencodeRuntimeDir(dirname(sandboxPath));
  try {
    const stat = await Deno.stat(join(runtimeDir, "node_modules"));
    return stat.isDirectory ? runtimeDir : null;
  } catch {
    return null;
  }
}

function dirExistsSync(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

/**
 * Look up a binary on $PATH. Returns undefined if not found.
 */
async function findBinary(name: string): Promise<string | undefined> {
  try {
    const command = new Deno.Command("which", {
      args: [name],
      stdout: "piped",
      stderr: "piped",
    });
    const { stdout, success } = await command.output();
    if (!success) return undefined;
    const path = new TextDecoder().decode(stdout).trim().split("\n")[0];
    return path || undefined;
  } catch {
    return undefined;
  }
}
