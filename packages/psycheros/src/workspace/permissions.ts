/**
 * Workspace Permissions — 5-tier classification
 *
 * Maps a requested filesystem path to one of five tiers, each with its own
 * access policy. The OS-level sandbox (bwrap on Linux) is the hard floor
 * that enforces Tier 5; this module is the soft classifier that drives
 * prompts and rejections.
 *
 * Critical invariant: symlinks are resolved (realpath) BEFORE classification.
 * Without this, a symlink inside the sandbox pointing at ~/.psycheros/db.sqlite
 * would silently escape Tier 1 and land in Tier 5 — undoing the protection.
 */

import { isAbsolute, resolve as resolvePath } from "@std/path";

/**
 * The five tiers, in order of restrictiveness.
 */
export type PermissionTier = 1 | 2 | 3 | 4 | 5;

/**
 * Per-session permission state. Carries the path prefixes the entity/user
 * has explicitly approved for this session, plus the partyhard flag.
 */
export interface SessionPermissionState {
  /** Path prefixes (realpath'd) the user has approved for this session. */
  approvedPaths: string[];
  /** Sandbox dir (Tier 1 root). */
  sandboxPath: string;
  /** dataRoot — entity data lives under here. */
  dataRoot: string;
  /** projectRoot — codebase lives under here. */
  projectRoot: string;
  /**
   * Partyhard mode bypasses Tier 2/4 prompts. Does NOT bypass Tier 5
   * protection — protected paths are always blocked regardless. Also
   * does NOT bypass `alwaysAskPaths` — those are user-defined and always
   * prompt.
   */
  partyhard: boolean;
  /**
   * User-defined path prefixes (realpath'd) that ALWAYS prompt before
   * access, even in Feral mode. Different from Tier 5 (hardcoded daemon
   * files).
   */
  alwaysAskPaths: string[];
}

/**
 * Result of classifying a path.
 */
export interface PathClassification {
  tier: PermissionTier;
  /** Why this tier was chosen — for logging/UI. */
  reason: string;
  /** The realpath'd version of the input path. */
  resolvedPath: string;
  /** True if the caller may proceed without any prompt. */
  allowedWithoutPrompt: boolean;
  /** True if the caller may never touch this path. */
  hardBlocked: boolean;
}

/**
 * Paths that are ALWAYS protected (Tier 5), regardless of partyhard or
 * approvals. These cover the daemon's runtime state — touching them
 * directly would brick Psycheros.
 */
const PROTECTED_PATH_PATTERNS = [
  // SQLite database files
  /\.psycheros\/psycheros\.db$/,
  /\.psycheros\/.*\.db$/,
  // Daemon runtime files
  /\.psycheros\/mcp-child\.pid$/,
  // Entity-core graph DB
  /\/graph\.db$/,
];

/**
 * Classify a requested path. Returns the tier and policy hints.
 *
 * `state` carries the per-session context (sandbox, approved paths, partyhard).
 */
export function classifyPath(
  requested: string,
  state: SessionPermissionState,
): PathClassification {
  // Resolve symlinks before classification. If realpath fails (path doesn't
  // exist yet), fall back to absolute resolve without symlink expansion.
  let resolved: string;
  try {
    resolved = Deno.realPathSync(requested);
  } catch {
    resolved = isAbsolute(requested)
      ? resolvePath(requested)
      : resolvePath(resolvePath(state.sandboxPath, requested));
  }

  // Tier 5: always protected. Check FIRST so protected paths can't be
  // reached via approval or partyhard.
  for (const pattern of PROTECTED_PATH_PATTERNS) {
    if (pattern.test(resolved)) {
      return {
        tier: 5,
        reason: "Protected path — daemon/database/runtime file",
        resolvedPath: resolved,
        allowedWithoutPrompt: false,
        hardBlocked: true,
      };
    }
  }

  const sandboxResolved = realpathOrResolve(state.sandboxPath);
  const dataRootResolved = realpathOrResolve(state.dataRoot);
  const projectRootResolved = realpathOrResolve(state.projectRoot);

  // Tier 1: inside the sandbox dir.
  if (pathStartsWith(resolved, sandboxResolved)) {
    return {
      tier: 1,
      reason: "Inside sandbox — full access",
      resolvedPath: resolved,
      allowedWithoutPrompt: true,
      hardBlocked: false,
    };
  }

  // Tier 2: entity data (under dataRoot, but not the sandbox).
  if (pathStartsWith(resolved, dataRootResolved)) {
    // Partyhard bypass disabled (see supervisor.ts). Entity-data writes
    // always require approval.
    return {
      tier: 2,
      reason: "Entity data — write requires approval",
      resolvedPath: resolved,
      allowedWithoutPrompt: false,
      hardBlocked: false,
    };
  }

  // Tier 3: codebase (under projectRoot).
  if (pathStartsWith(resolved, projectRootResolved)) {
    return {
      tier: 3,
      reason: "Codebase — read-only",
      resolvedPath: resolved,
      // Reads are free; writes are always blocked at Tier 3.
      allowedWithoutPrompt: false,
      hardBlocked: true, // writes blocked; reads allowed via read_codebase tool
    };
  }

  // Tier 4: any other path on the computer.
  // Check the user-defined always-ask list FIRST — these override approved
  // paths. They still get a prompt; the user can approve once or for session.
  const isAlwaysAsk = (state.alwaysAskPaths ?? []).some((p) =>
    pathStartsWith(resolved, p)
  );
  if (isAlwaysAsk) {
    return {
      tier: 4,
      reason: "User always-ask path (§13b) — prompts every access",
      resolvedPath: resolved,
      // Even approved-for-session paths bypass; always-ask overrides approval
      // because the user explicitly marked it as "ask every time."
      allowedWithoutPrompt: false,
      hardBlocked: false,
    };
  }

  // Not in always-ask list. Check the per-session approved list.
  const isApproved = state.approvedPaths.some((p) =>
    pathStartsWith(resolved, p)
  );
  if (isApproved) {
    return {
      tier: 4,
      reason: "User-approved path for this session",
      resolvedPath: resolved,
      allowedWithoutPrompt: true,
      hardBlocked: false,
    };
  }

  return {
    tier: 4,
    reason: "Outside sandbox — requires per-session approval",
    resolvedPath: resolved,
    allowedWithoutPrompt: false,
    hardBlocked: false,
  };
}

/**
 * Add a path to the session's approved list. Subsequent classifyPath calls
 * for paths under this prefix will be Tier 4 with allowedWithoutPrompt=true.
 *
 * The approved path is realpath'd to prevent a malicious relative path
 * from being approved that happens to point at a protected location.
 */
export function approvePath(
  state: SessionPermissionState,
  path: string,
): void {
  const resolved = realpathOrResolve(path);
  if (!state.approvedPaths.includes(resolved)) {
    state.approvedPaths.push(resolved);
  }
}

// =============================================================================
// Helpers
// =============================================================================

function pathStartsWith(path: string, prefix: string): boolean {
  // Ensure trailing slash so "/foo/bar" doesn't match prefix "/foo/ba".
  const p = prefix.endsWith("/") ? prefix : prefix + "/";
  return path === prefix || path.startsWith(p);
}

function realpathOrResolve(path: string): string {
  try {
    return Deno.realPathSync(path);
  } catch {
    return resolvePath(path);
  }
}
