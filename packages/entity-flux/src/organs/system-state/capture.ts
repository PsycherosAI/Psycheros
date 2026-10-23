/**
 * system-state Sensory Organ — Perception layer.
 *
 * One poll = one SystemStateSample assembled from plain POSIX commands.
 * The CommandRunner seam hides the transport: locally it executes
 * directly; with an sshTarget every probe becomes
 * `ssh -o BatchMode=yes user@host "<cmd>"`. The commands are identical
 * in both modes — SSH-friendliness is a property of choosing probes
 * that need no session bus and no desktop environment.
 *
 * Any failure is BLINDNESS (`up: false`): the gate holds its verdicts,
 * never guessing. One availability line per transition, never per poll.
 */

import type { SystemStateOrganConfig, SystemStateSample } from "./types.ts";

/** Executes a command string, returning trimmed stdout or null on any failure. */
export type CommandRunner = (command: string) => Promise<string | null>;

/** Local execution. */
export function localRunner(): CommandRunner {
  return async (command) => {
    try {
      const cmd = new Deno.Command("/bin/sh", {
        args: ["-c", command],
        stdout: "piped",
        stderr: "null",
      });
      const out = await cmd.output();
      if (!out.success) return null;
      return new TextDecoder().decode(out.stdout).trim();
    } catch {
      return null;
    }
  };
}

/** SSH execution — BatchMode so a missing key fails fast, not hangs. */
export function sshRunner(target: string): CommandRunner {
  return async (command) => {
    try {
      const cmd = new Deno.Command("ssh", {
        args: [
          "-o",
          "BatchMode=yes",
          "-o",
          "ConnectTimeout=5",
          target,
          command,
        ],
        stdout: "piped",
        stderr: "null",
      });
      const out = await cmd.output();
      if (!out.success) return null;
      return new TextDecoder().decode(out.stdout).trim();
    } catch {
      return null;
    }
  };
}

export function makeRunner(config: SystemStateOrganConfig): CommandRunner {
  return config.sshTarget ? sshRunner(config.sshTarget) : localRunner();
}

/**
 * Parse /proc/interrupts into a single input-activity integer: the sum
 * of all counts on lines whose handler name matches the input pattern.
 * Deltas between polls = input events (keyboard, mouse — and on USB-only
 * machines, any peripheral traffic, which at desk scale means presence).
 */
export function parseInputCount(
  procInterrupts: string,
  pattern: string,
): number | null {
  let total = 0;
  let matched = false;
  const re = new RegExp(pattern);
  for (const line of procInterrupts.split("\n")) {
    // Shape: "  42:  37055263 0 ... IR-PCI-MSIX-... xhci_hcd"
    const m = line.match(/^\s*(?:IRQ|IO-APIC|[0-9]+):\s+(.*)$/);
    if (!m) continue;
    const rest = m[1];
    const handler = rest.trim().split(/\s+/).pop() ?? "";
    if (!re.test(handler)) continue;
    matched = true;
    // Count only the per-CPU numbers — never digits inside the handler
    // name itself (i8042 would add 8042).
    const countsPart = rest.slice(0, rest.lastIndexOf(handler));
    for (const n of countsPart.match(/\d+/g) ?? []) total += Number(n);
  }
  return matched ? total : null;
}

/** loginctl list-sessions + per-session show → locked verdict + session keys. */
export async function probeSessions(
  run: CommandRunner,
): Promise<{ locked: boolean | null; sessions: string[] }> {
  const list = await run(
    "loginctl list-sessions --no-legend 2>/dev/null",
  );
  if (!list) return { locked: null, sessions: [] };
  const sessions: string[] = [];
  let locked: boolean | null = null;
  let sawActive = false;
  for (const line of list.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    const [id, , user] = cols;
    sessions.push(`${user}`);
    const show = await run(
      `loginctl show-session ${id} -p Active -p LockedHint 2>/dev/null`,
    );
    if (!show) continue;
    const active = show.includes("Active=yes");
    if (!active) continue;
    sawActive = true;
    const isLocked = show.includes("LockedHint=yes");
    // The screen is locked iff the ACTIVE local session says so.
    locked = isLocked;
  }
  if (!sawActive) locked = null;
  return { locked, sessions: [...new Set(sessions)] };
}

/** One full poll. */
export async function pollSystemState(
  run: CommandRunner,
  config: SystemStateOrganConfig,
): Promise<SystemStateSample> {
  const at = Date.now();
  const [interrupts, sessions, loadavg] = await Promise.all([
    run("cat /proc/interrupts"),
    probeSessions(run),
    run("cat /proc/loadavg"),
  ]);
  const inputCount = interrupts !== null
    ? parseInputCount(interrupts, config.inputPattern)
    : null;
  const load1 = loadavg !== null
    ? Number(loadavg.split(/\s+/)[0] ?? Number.NaN)
    : null;
  const up = inputCount !== null;
  return {
    at,
    up,
    inputCount: up ? inputCount : null,
    locked: up ? sessions.locked : null,
    sessions: up ? sessions.sessions : [],
    load1: Number.isFinite(load1 as number) ? load1 : null,
  };
}
