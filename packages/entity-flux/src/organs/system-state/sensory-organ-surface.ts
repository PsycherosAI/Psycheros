/**
 * System-state's plugin-surface adapter: same contract as
 * out-of-tree plugins — one factory, settings from the
 * `sensoryOrganSettings["system-state"]` bag, a declared descriptor for
 * the Settings card. Keys match the legacy root FluxSettings names so
 * the migration is a straight move.
 */

import type {
  EnvelopeSink,
  SensoryOrganFactoryContext,
  SensoryOrganSettingField,
} from "../../types.ts";
import { createSystemStateOrgan } from "./system-state-organ.ts";
import { defaultSystemStateConfig } from "./types.ts";

export const systemStateSettingsFields: SensoryOrganSettingField[] = [
  {
    key: "systemStateSshTarget",
    label: "SSH target",
    type: "text",
    default: "",
    help:
      '"user@host" to observe a remote machine over SSH. Empty = observe the local machine.',
  },
  {
    key: "systemStateProbeMs",
    label: "Probe cadence (ms)",
    type: "number",
    default: 5000,
  },
  {
    key: "systemStateInputPattern",
    label: "Input-device pattern",
    type: "text",
    default: "i8042|keyboard|mouse|xhci_hcd",
    help: "Which /proc/interrupts handler names count as input devices.",
  },
  {
    key: "systemStateIdleAfterProbes",
    label: "Idle after (probes)",
    type: "number",
    default: 120,
    help:
      'Consecutive input-free probes before "user went idle" (120 ≈ 10 min at the default cadence).',
  },
];

const DESCRIPTOR_DEFAULTS: Record<string, unknown> = Object.fromEntries(
  systemStateSettingsFields.map((f) => [f.key, f.default]),
);

export function createSensoryOrgan(
  sink: EnvelopeSink,
  context: SensoryOrganFactoryContext,
) {
  const values = { ...DESCRIPTOR_DEFAULTS, ...context.settings };
  const str = (k: string, d: string) =>
    typeof values[k] === "string" ? values[k] as string : d;
  const num = (k: string, d: number) =>
    typeof values[k] === "number" ? values[k] as number : d;
  const base = defaultSystemStateConfig();
  return createSystemStateOrgan(
    {
      id: "system-state",
      tickIntervalMs: num("systemStateProbeMs", base.probeIntervalMs),
      enabled: true,
      sshTarget: str("systemStateSshTarget", base.sshTarget),
      probeIntervalMs: num("systemStateProbeMs", base.probeIntervalMs),
      inputPattern: str("systemStateInputPattern", base.inputPattern),
      idleAfterProbes: num("systemStateIdleAfterProbes", base.idleAfterProbes),
    },
    sink,
    { dataRoot: context.dataRoot },
  );
}
