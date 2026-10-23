/**
 * system-state Sensory Organ — the Organ impl.
 *
 * Self-drives via the sink on its own probe cadence (the template's
 * contract: FluxManager calls start/stop, never polls tick()). One poll
 * → one gate step → transitions speak through the sink, presence writes
 * to the state file. Blindness holds everything.
 */

import type { Organ, OrganEnvelope } from "../../types.ts";
import {
  defaultSystemStateConfig,
  freshSystemStateGate,
  type SystemStateGateState,
  type SystemStateOrganConfig,
  type SystemStateSample,
} from "./types.ts";
import { type CommandRunner, makeRunner, pollSystemState } from "./capture.ts";
import { pickPrimary, stepSystemGate } from "./system-gate.ts";
import {
  presenceSnapshot,
  transitionEnvelope,
  writePresence,
} from "./response.ts";

export class SystemStateOrgan implements Organ {
  readonly config: SystemStateOrganConfig;
  private runner: CommandRunner;
  private gate: SystemStateGateState = freshSystemStateGate();
  private timer: ReturnType<typeof setInterval> | null = null;
  private blind = false;
  private running = false;

  constructor(
    config: Partial<SystemStateOrganConfig>,
    private sink: (envelope: OrganEnvelope) => void | Promise<void>,
    private context: { dataRoot: string },
  ) {
    this.config = { ...defaultSystemStateConfig(), ...config };
    this.runner = makeRunner(this.config);
  }

  async tick(): Promise<null> {
    await this.probe();
    return null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.probe();
    }, this.config.probeIntervalMs);
    void this.probe();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async probe(): Promise<void> {
    if (!this.running) return;
    const sample: SystemStateSample = await pollSystemState(
      this.runner,
      this.config,
    );
    // One availability line per transition, never per poll.
    const wasBlind = this.blind;
    this.blind = !sample.up;
    if (wasBlind !== this.blind) {
      console.log(
        this.blind
          ? `[system-state] probes failing (${
            this.config.sshTarget || "local"
          }) — holding state`
          : `[system-state] probes recovered (${
            this.config.sshTarget || "local"
          })`,
      );
    }
    if (!sample.up) return; // blindness holds everything

    const step = stepSystemGate(this.gate, sample, this.config);
    this.gate = step.state;

    await writePresence(
      this.context.dataRoot,
      presenceSnapshot(sample, this.gate, this.config),
    );

    for (const t of step.transitions) {
      // Locked and idle often coincide; the primary speaks for the moment.
      this.sink(transitionEnvelope(t, this.config));
    }
    void pickPrimary(step.transitions); // priority documented in the gate
  }
}

export function createSystemStateOrgan(
  config: Partial<SystemStateOrganConfig>,
  sink: (envelope: OrganEnvelope) => void | Promise<void>,
  context: { dataRoot: string },
): SystemStateOrgan {
  return new SystemStateOrgan(config, sink, context);
}
