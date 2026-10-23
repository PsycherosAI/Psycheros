/**
 * system-state Sensory Organ — Response layer.
 *
 * Turns transitions into envelopes (amplitude by significance) and keeps
 * the presence file current on EVERY probe — presence never speaks, it
 * is read. Descriptions state facts plainly; the register is quiet
 * because the events are rare and mean something.
 */

import { join } from "@std/path";
import { psycherosDir } from "../../../../psycheros/src/utils/paths.ts";
import type { OrganEnvelope, Perception } from "../../types.ts";
import type {
  SystemStateGateState,
  SystemStateOrganConfig,
  SystemStateSample,
  SystemStateTransition,
} from "./types.ts";

/** Amplitude per event kind — arrivals and returns matter most. */
export function amplitudeFor(kind: string): number {
  switch (kind) {
    case "unlocked":
      return 0.55;
    case "user_active":
      return 0.5;
    case "locked":
      return 0.4;
    case "user_idle":
      return 0.35;
    case "session_opened":
      return 0.3;
    case "session_closed":
      return 0.25;
    default:
      return 0.2;
  }
}

export function describeEvent(
  t: SystemStateTransition,
  config: SystemStateOrganConfig,
): string {
  const minutes = t.sinceProbes !== undefined
    ? Math.round((t.sinceProbes * config.probeIntervalMs) / 60_000)
    : null;
  switch (t.kind) {
    case "user_active":
      return "Keyboard and mouse activity resumed.";
    case "user_idle":
      return minutes !== null && minutes > 0
        ? `No keyboard or mouse input for about ${minutes} minute${
          minutes === 1 ? "" : "s"
        }.`
        : "Keyboard and mouse input has stopped.";
    case "locked":
      return "The screen locked.";
    case "unlocked":
      return "The screen unlocked.";
    case "session_opened":
      return `A login session opened (${t.session}).`;
    case "session_closed":
      return `A login session closed (${t.session}).`;
  }
}

/** Build the envelope for a transition (the only speaking path). */
export function transitionEnvelope(
  t: SystemStateTransition,
  config: SystemStateOrganConfig,
): OrganEnvelope {
  const perception: Perception = {
    type: "system_state",
    description: describeEvent(t, config),
    confidence: 0.95,
    data: { kind: t.kind, ...(t.session ? { session: t.session } : {}) },
  };
  return {
    id: crypto.randomUUID(),
    organId: config.id,
    timestamp: new Date(t.at).toISOString(),
    specialistModel: "procfs", // deterministic probes, no model in the loop
    amplitude: amplitudeFor(t.kind),
    perception,
  };
}

/** The always-current presence snapshot, written every probe. */
export function presenceSnapshot(
  sample: SystemStateSample,
  gate: SystemStateGateState,
  config: SystemStateOrganConfig,
): Record<string, unknown> {
  const idleMinutes = gate.inputlessProbes > 0
    ? Math.round((gate.inputlessProbes * config.probeIntervalMs) / 60_000)
    : 0;
  return {
    caption: gate.active === null
      ? "machine state not yet established"
      : gate.locked
      ? "screen locked"
      : gate.active
      ? "user active at the machine"
      : idleMinutes > 0
      ? `no input for ~${idleMinutes} min`
      : "user idle",
    timestamp: new Date(sample.at).toISOString(),
    active: gate.active,
    locked: gate.locked,
    sessions: gate.sessions,
    load1: sample.load1,
    observedVia: config.sshTarget ? `ssh:${config.sshTarget}` : "local",
  };
}

/** Write the presence file (cheap, every probe). */
export async function writePresence(
  dataRoot: string,
  snapshot: Record<string, unknown>,
): Promise<void> {
  const dir = join(psycherosDir(dataRoot), "organ-state");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "system-state.json"),
    JSON.stringify(snapshot, null, 2),
  );
}
