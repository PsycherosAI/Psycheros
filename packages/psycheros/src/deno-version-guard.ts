/**
 * Boot-time Deno runtime version guard.
 *
 * The repo root carries a `.deno-version` file — the single source of truth
 * for the Deno pin. CI reads it (`check.yml`, `release.yml`), the published
 * container's base image matches it, and the launcher-v2 sidecar is built
 * from it. This guard compares the running interpreter against that pin at
 * daemon startup and prints a loud banner on mismatch, so version drift
 * announces itself instead of surfacing later as confusing runtime breakage.
 *
 * Warn-only by design: a mismatch is often harmless (patch-level formatter
 * differences), and refusing to boot would brick working installs whenever
 * the pin moves before every install path has caught up. Desktop launcher
 * users get the matching runtime through app updates; source installs get
 * the exact fix command printed here.
 */

import { dirname, join } from "@std/path";

export interface DenoVersionCheckResult {
  /** "ok" — running version matches the pin. "no-pin" — no pin file found. */
  status: "ok" | "mismatch" | "no-pin" | "unreadable";
  expected?: string;
  actual?: string;
  pinPath?: string;
}

/**
 * Locate `.deno-version` by walking up from this module's directory
 * (packages/psycheros/src → repo root), falling back to the cwd.
 * Returns null when no pin file is present — container images that don't
 * ship the repo root, for instance — which the caller treats as "skip".
 */
export function findDenoVersionPin(): string | null {
  const candidates: string[] = [];
  try {
    let dir: string | undefined = import.meta.dirname;
    for (let i = 0; i < 5 && dir; i++) {
      candidates.push(join(dir, ".deno-version"));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // import.meta.dirname unavailable — the cwd fallback below still runs.
  }
  candidates.push(join(Deno.cwd(), ".deno-version"));
  for (const path of candidates) {
    try {
      if (Deno.statSync(path).isFile) return path;
    } catch {
      // keep walking
    }
  }
  return null;
}

/**
 * Compare the running Deno against the pin. Overridable inputs keep this
 * unit-testable without needing multiple installed interpreters.
 */
export function checkDenoVersion(
  opts: { pinPath?: string; actualVersion?: string } = {},
): DenoVersionCheckResult {
  const actual = opts.actualVersion ?? Deno.version.deno;
  const pinPath = opts.pinPath ?? findDenoVersionPin();
  if (!pinPath) return { status: "no-pin", actual };
  try {
    Deno.statSync(pinPath);
  } catch {
    // An explicitly-passed pin path that isn't there counts as no pin —
    // same contract as never finding one.
    return { status: "no-pin", actual };
  }
  let expected: string;
  try {
    expected = Deno.readTextFileSync(pinPath).trim();
  } catch {
    return { status: "unreadable", actual, pinPath };
  }
  if (expected === "") return { status: "unreadable", actual, pinPath };
  return {
    status: expected === actual ? "ok" : "mismatch",
    expected,
    actual,
    pinPath,
  };
}

/**
 * Print a prominent banner when the running Deno does not match the pin.
 * Never throws, never exits — a mismatch is a loud warning, not a gate.
 */
export function warnOnDenoVersionMismatch(
  log: (msg: string) => void = console.warn,
): DenoVersionCheckResult {
  const result = checkDenoVersion();
  if (result.status !== "mismatch") return result;
  const lines = [
    "",
    "============================================================",
    "⚠️  Deno version mismatch",
    "",
    `    Psycheros is pinned to Deno ${result.expected} (.deno-version),`,
    `    but this process is running Deno ${result.actual}.`,
    "    Most things will work, but subtle breakage is possible.",
    "",
    `    Source install fix:   deno upgrade ${result.expected}`,
    "    Desktop launcher:     update the Psycheros app — the bundled",
    "                          runtime rides along with shell updates.",
    "============================================================",
    "",
  ];
  log(lines.join("\n"));
  return result;
}
