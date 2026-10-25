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

/** Wall-clock cap for one exec. ConnectTimeout covers TCP connect only;
 * auth, session setup and the command itself can stall forever without
 * this — a stalled probe must die, not stack. */
const EXEC_TIMEOUT_MS = 10_000;

/** Run argv, resolve trimmed stdout, or null on failure or timeout. The
 * timeout SIGKILLs the child — and resolves the wait at the wall clock
 * even so, because pipe EOF is not the child's death: a grandchild can
 * hold the stdout pipe open past the corpse, and a stalled probe must
 * not wait on it. */
export async function runCommand(
  argv: string[],
  timeoutMs = EXEC_TIMEOUT_MS,
): Promise<string | null> {
  try {
    const child = new Deno.Command(argv[0], {
      args: argv.slice(1),
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).spawn();
    let fire: ReturnType<typeof setTimeout> | undefined;
    const wallClock = new Promise<null>((resolve) => {
      fire = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already exited
        }
        resolve(null);
      }, timeoutMs);
    });
    const waited: Promise<string | null> = child.output().then(
      (out) => out.success ? new TextDecoder().decode(out.stdout).trim() : null,
      () => null,
    );
    try {
      return await Promise.race([waited, wallClock]);
    } finally {
      clearTimeout(fire);
    }
  } catch {
    return null;
  }
}

/** Local execution. */
export function localRunner(): CommandRunner {
  return (command) => runCommand(["/bin/sh", "-c", command]);
}

/** SSH execution — BatchMode so a missing key fails fast, not hangs, and
 * one multiplexed master carries every exec: ControlMaster=auto opens a
 * single authenticated connection and later probes ride it in
 * milliseconds, so a multi-command poll fits inside the poll interval
 * instead of stacking fresh handshakes into the target's sshd (which
 * MaxStartups then drops — the flap loop). ControlPersist retires the
 * master after ten idle minutes and ServerAlive buries a dead peer in
 * ~30s; a per-process socket keeps restarts and sibling processes off
 * each other's masters. */
export function sshRunner(target: string): CommandRunner {
  const controlPath = `/tmp/psycheros-ssh-${crypto.randomUUID()}`;
  const baseArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${controlPath}`,
    "-o",
    "ControlPersist=10m",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
  ];
  return (command) => runCommand(["ssh", ...baseArgs, target, command]);
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
