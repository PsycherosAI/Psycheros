/**
 * system-state Sensory Organ — type definitions.
 *
 * The entity's awareness of the machine its user sits at: keyboard and
 * mouse activity, screen lock, logins. Every probe is a plain POSIX
 * command that runs identically locally or over SSH (the Perception seam
 * hides the transport), so the production companion on another machine
 * observes the user's computer by SSHing into it with the same organ.
 *
 * Signal honesty (the radar-sense lesson): nothing here crosses a noise
 * floor — input counts are integers, lock states are booleans, sessions
 * are lists. Duration facts ("no input for ten minutes") are stated as
 * PROBE COUNTS against the Sensory Organ's own poll cadence, never wall clocks.
 */

import type { OrganConfig } from "../../types.ts";

/** Configuration. */
export interface SystemStateOrganConfig extends OrganConfig {
  /**
   * SSH target ("user@host") for remote observation. Empty/absent =
   * observe the local machine. The companion's production instance
   * points this at the user's computer; testing observes locally.
   */
  sshTarget: string;
  /** Poll cadence in ms — the Sensory Organ's capture rate (default 5000). */
  probeIntervalMs: number;
  /**
   * Which /proc/interrupts handler names count as input devices
   * (default "i8042|keyboard|mouse|xhci_hcd" — USB-only boxes ride xhci).
   */
  inputPattern: string;
  /**
   * Consecutive input-free probes before "user went idle" (default 120
   * ≈ 10 minutes at the default cadence). Idle/active is the one
   * durational judgment this Sensory Organ makes — and it reports the duration
   * as the fact, not as a gate behind it.
   */
  idleAfterProbes: number;
  /** Ignore login sessions younger than this many ms (default 0 — off). */
  sessionGraceMs: number;
}

export function defaultSystemStateConfig(): SystemStateOrganConfig {
  return {
    id: "system-state",
    tickIntervalMs: 5_000,
    enabled: true,
    sshTarget: "",
    probeIntervalMs: 5_000,
    inputPattern: "i8042|keyboard|mouse|xhci_hcd",
    idleAfterProbes: 120,
    sessionGraceMs: 0,
  };
}

/** One poll's raw findings. `up: false` = probe failure = BLINDNESS. */
export interface SystemStateSample {
  at: number;
  up: boolean;
  /** Sum of input-device interrupt counts (null if unreadable). */
  inputCount: number | null;
  /** Screen-locked verdict (null = no session / unknown). */
  locked: boolean | null;
  /** Active login sessions as "user(tty)" keys. */
  sessions: string[];
  /** 1-minute load average (texture for the presence file). */
  load1: number | null;
}

/** The Sensory Organ's transitions — the whole speaking vocabulary. */
export type SystemStateEventKind =
  | "user_active" // input resumed after idle
  | "user_idle" // input absent for idleAfterProbes
  | "locked" // screen locked
  | "unlocked" // screen unlocked
  | "session_opened" // a login appeared
  | "session_closed"; // a login vanished

export interface SystemStateTransition {
  kind: SystemStateEventKind;
  at: number;
  /** For session events: which session. */
  session?: string;
  /** Context carried for descriptions. */
  sinceProbes?: number;
}

/** In-memory gate bookkeeping. */
export interface SystemStateGateState {
  /** null = unknown (first observation adopts silently). */
  active: boolean | null;
  locked: boolean | null;
  sessions: string[];
  /** False until the first session list is adopted (pre-existing
   * sessions are not "arrivals"). */
  sessionsSeen: boolean;
  inputlessProbes: number;
  lastInputCount: number | null;
}

export function freshSystemStateGate(): SystemStateGateState {
  return {
    active: null,
    locked: null,
    sessions: [],
    sessionsSeen: false,
    inputlessProbes: 0,
    lastInputCount: null,
  };
}
