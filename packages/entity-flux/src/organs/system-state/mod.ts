/**
 * system-state — the entity's awareness of the user's machine: input
 * activity, screen lock, logins. SSH-friendly by construction (every
 * probe is a POSIX command; the Perception seam swaps local exec for
 * ssh). Structure follows the Sensory Organ template.
 *
 * @module
 */

export {
  createSystemStateOrgan,
  SystemStateOrgan,
} from "./system-state-organ.ts";
export { defaultSystemStateConfig, freshSystemStateGate } from "./types.ts";
export type {
  SystemStateEventKind,
  SystemStateGateState,
  SystemStateOrganConfig,
  SystemStateSample,
  SystemStateTransition,
} from "./types.ts";
export { localRunner, makeRunner, sshRunner } from "./capture.ts";
export { parseInputCount } from "./capture.ts";
export { pickPrimary, stepSystemGate } from "./system-gate.ts";
export {
  createSensoryOrgan as createSystemStateSensoryOrgan,
  systemStateSettingsFields,
} from "./sensory-organ-surface.ts";
