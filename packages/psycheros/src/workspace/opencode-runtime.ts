/**
 * Shared OpenCode runtime
 *
 * OpenCode bootstraps its own `.opencode/node_modules` (~63MB) inside every
 * sandbox it runs in. With retained sessions that multiplies into gigabytes
 * of identical copies. This module keeps ONE runtime copy at
 * `<workspaceRoot>/.opencode-runtime/node_modules` and symlinks it into
 * sandboxes — outside any session dir, so retention never follows it.
 *
 * The runtime dir is bound rw into the OS sandbox alongside the session dir,
 * so OpenCode can still npm-install plugin updates into the shared copy.
 */

import { join } from "@std/path";
import { copy, ensureDir } from "@std/fs";
import type { DBClient } from "../db/client.ts";

export const OPENCODE_RUNTIME_DIRNAME = ".opencode-runtime";

export function resolveOpencodeRuntimeDir(workspaceRoot: string): string {
  return join(workspaceRoot, OPENCODE_RUNTIME_DIRNAME);
}

async function isRealDir(path: string): Promise<boolean> {
  try {
    const stat = await Deno.lstat(path);
    return stat.isDirectory && !stat.isSymlink;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path); // follows symlinks — a valid symlink counts
    return true;
  } catch {
    return false;
  }
}

/**
 * Sessions whose sandbox node_modules may be reclaimed: terminal + unpinned,
 * or sandboxes with no session row at all (DB wiped / legacy). Running,
 * suspended, and pinned sessions keep their real copies — stealing from a
 * live session would break a possibly in-flight OpenCode process, and pinned
 * sessions must stay resumable as-is.
 */
async function loadStealableSandboxPaths(db: DBClient): Promise<Set<string>> {
  const stmt = db.getRawDb().prepare(
    `SELECT sandbox_path FROM workspace_sessions
     WHERE status NOT IN ('complete', 'failed', 'cancelled')
        OR COALESCE(pinned, 0) = 1`,
  );
  const rows = stmt.all<{ sandbox_path: string }>();
  stmt.finalize();
  return new Set(rows.map((r) => r.sandbox_path));
}

interface SandboxCandidate {
  sandboxDir: string;
  nodeModules: string;
  mtime: number;
}

async function findRuntimeCandidates(
  workspaceRoot: string,
  protectedPaths: Set<string>,
): Promise<SandboxCandidate[]> {
  const candidates: SandboxCandidate[] = [];
  try {
    for await (const entry of Deno.readDir(workspaceRoot)) {
      if (!entry.isDirectory || entry.name === OPENCODE_RUNTIME_DIRNAME) {
        continue;
      }
      const sandboxDir = join(workspaceRoot, entry.name);
      if (protectedPaths.has(sandboxDir)) continue;
      const nodeModules = join(sandboxDir, ".opencode", "node_modules");
      if (!await isRealDir(nodeModules)) continue;
      const stat = await Deno.stat(nodeModules).catch(() => null);
      candidates.push({
        sandboxDir,
        nodeModules,
        mtime: stat?.mtime?.getTime() ?? 0,
      });
    }
  } catch {
    // workspace root unreadable — nothing to do
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates;
}

/**
 * Symlink a sandbox's `.opencode/node_modules` at the shared runtime. Best
 * effort — on failure (e.g. Windows without dev mode) OpenCode just
 * bootstraps a real copy as before.
 */
async function linkSandboxToRuntime(
  nodeModules: string,
  runtimeNodeModules: string,
): Promise<boolean> {
  if (await pathExists(nodeModules)) return false;
  try {
    await Deno.symlink(runtimeNodeModules, nodeModules, { type: "dir" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Link a freshly created sandbox's `.opencode/node_modules` at the shared
 * runtime, when one exists. Called from ensureSandbox — a no-op until the
 * runtime has been established (fresh installs bootstrap normally).
 */
export async function ensureSandboxRuntimeLink(
  workspaceRoot: string,
  opencodeDir: string,
): Promise<void> {
  const runtimeNodeModules = join(
    resolveOpencodeRuntimeDir(workspaceRoot),
    "node_modules",
  );
  if (!await pathExists(runtimeNodeModules)) return;
  await linkSandboxToRuntime(
    join(opencodeDir, "node_modules"),
    runtimeNodeModules,
  );
}

/**
 * Ensure the shared runtime exists and sandboxes reference it.
 *
 * - If the runtime is missing, promotes it from the newest reclaimable
 *   sandbox (rename — instant on the same filesystem; copy as fallback).
 * - Then replaces every other reclaimable sandbox's real node_modules with a
 *   symlink to the runtime.
 *
 * Fresh installs (no sandbox has bootstrapped yet) are a no-op — the first
 * OpenCode session bootstraps its own copy and the next daemon start
 * promotes it.
 *
 * @returns the runtime dir path, or null if no runtime could be established.
 */
export async function ensureOpencodeRuntime(
  workspaceRoot: string,
  db: DBClient,
): Promise<string | null> {
  const runtimeDir = resolveOpencodeRuntimeDir(workspaceRoot);
  const runtimeNodeModules = join(runtimeDir, "node_modules");
  const protectedPaths = await loadStealableSandboxPaths(db).catch(() =>
    new Set<string>()
  );
  const candidates = await findRuntimeCandidates(
    workspaceRoot,
    protectedPaths,
  );

  if (!await pathExists(runtimeNodeModules)) {
    const donor = candidates.shift();
    if (!donor) return null;

    await ensureDir(runtimeDir);
    try {
      await Deno.rename(donor.nodeModules, runtimeNodeModules);
    } catch {
      // Cross-device or locked — fall back to copy + delete.
      try {
        await copy(donor.nodeModules, runtimeNodeModules);
        await Deno.remove(donor.nodeModules, { recursive: true });
      } catch (err) {
        console.error(
          "[workspace] failed to promote OpenCode runtime:",
          err instanceof Error ? err.message : String(err),
        );
        return null;
      }
    }
    console.log(
      `[workspace] promoted shared OpenCode runtime from ${donor.sandboxDir}`,
    );
    await linkSandboxToRuntime(donor.nodeModules, runtimeNodeModules);
  }

  let swept = 0;
  for (const candidate of candidates) {
    try {
      await Deno.remove(candidate.nodeModules, { recursive: true });
    } catch (err) {
      console.error(
        `[workspace] failed to sweep ${candidate.nodeModules}:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    if (await linkSandboxToRuntime(candidate.nodeModules, runtimeNodeModules)) {
      swept++;
    }
  }
  if (swept > 0) {
    console.log(
      `[workspace] swept ${swept} sandbox node_modules copy/copies to the shared runtime`,
    );
  }

  return runtimeDir;
}
