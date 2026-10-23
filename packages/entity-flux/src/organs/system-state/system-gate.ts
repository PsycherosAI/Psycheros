/**
 * system-state Sensory Organ — Processing, the state gate.
 *
 * Pure functions, no IO, no clocks — samples arrive with timestamps so
 * tests script every edge. The vocabulary is small on purpose (the
 * radar-sense lesson): speak only when the machine's STORY changes —
 * the user came back, went idle, the screen locked, someone logged in.
 * Everything else is presence (the state file), never an envelope.
 *
 * Hysteresis is counted in PROBES (samples of testimony), not
 * milliseconds — the same shape as the situation detector.
 */

import type {
  SystemStateEventKind,
  SystemStateGateState,
  SystemStateOrganConfig,
  SystemStateSample,
  SystemStateTransition,
} from "./types.ts";
import { freshSystemStateGate } from "./types.ts";

export interface SystemGateStep {
  state: SystemStateGateState;
  transitions: SystemStateTransition[];
}

/** Priority for picking one envelope per pass (highest first). */
const PRIORITY: Record<SystemStateEventKind, number> = {
  unlocked: 0,
  user_active: 1,
  locked: 2,
  user_idle: 3,
  session_opened: 4,
  session_closed: 5,
};

export function pickPrimary(
  transitions: SystemStateTransition[],
): SystemStateTransition | null {
  let best: SystemStateTransition | null = null;
  for (const t of transitions) {
    if (!best || PRIORITY[t.kind] < PRIORITY[best.kind]) best = t;
  }
  return best;
}

/**
 * Step the gate one sample. Blindness (up: false) holds everything —
 * no state change, no transitions. First observations adopt silently.
 */
export function stepSystemGate(
  prev: SystemStateGateState,
  sample: SystemStateSample,
  config: SystemStateOrganConfig,
): SystemGateStep {
  if (!sample.up) return { state: prev, transitions: [] };

  const state: SystemStateGateState = { ...prev, sessions: [...prev.sessions] };
  const transitions: SystemStateTransition[] = [];
  const at = sample.at;

  // -- Input activity. Deltas between polls are events; a delta of zero
  //    accumulates toward idle. First observation adopts silently. -----
  if (sample.inputCount !== null) {
    if (state.lastInputCount !== null) {
      const delta = sample.inputCount - state.lastInputCount;
      if (delta > 0) {
        state.inputlessProbes = 0;
        if (state.active === false) {
          transitions.push({ kind: "user_active", at });
          state.active = true;
        }
      } else {
        state.inputlessProbes++;
        if (
          state.active === true &&
          state.inputlessProbes >= config.idleAfterProbes
        ) {
          transitions.push({
            kind: "user_idle",
            at,
            sinceProbes: state.inputlessProbes,
          });
          state.active = false;
        }
      }
    }
    // Adopt the initial verdict once idle has been established at least
    // once; before that "active" starts null and the first input OR the
    // first full idle run decides it silently.
    if (state.active === null) {
      if (state.lastInputCount === null) {
        // Nothing yet — will resolve on the next sample's delta.
      } else if (
        state.inputlessProbes >= config.idleAfterProbes
      ) {
        state.active = false;
      } else {
        state.active = true;
      }
    }
    state.lastInputCount = sample.inputCount;
  }

  // -- Lock state. Transitions only; holds while null. --------------------
  if (sample.locked !== null && sample.locked !== state.locked) {
    if (state.locked !== null) {
      transitions.push({ kind: sample.locked ? "locked" : "unlocked", at });
    }
    state.locked = sample.locked;
  }

  // -- Login sessions. First observation adopts silently; after that,
  //    diffs are arrivals and departures. ---------------------------------
  if (!state.sessionsSeen) {
    state.sessions = sample.sessions;
    state.sessionsSeen = true;
  } else {
    const opened = sample.sessions.filter((s) => !state.sessions.includes(s));
    const closed = state.sessions.filter((s) => !sample.sessions.includes(s));
    for (const s of opened) {
      transitions.push({ kind: "session_opened", at, session: s });
    }
    for (const s of closed) {
      transitions.push({ kind: "session_closed", at, session: s });
    }
    state.sessions = sample.sessions;
  }

  return { state, transitions };
}

export { freshSystemStateGate };
