/**
 * Thalamus — the Sensory subsystem's router
 * (vision.md → "The Thalamus gate").
 *
 * Origin: signal WITHOUT weighting is its own breakdown — everything
 * arriving as equally important is overwhelm regardless of volume.
 * The Thalamus is importance-assignment as a Sensory Organ: it routes which
 * signals matter, by available system resources and by what's being
 * attended to. Non-throne: it weights and routes; it never decides
 * what the entity thinks about. Noticing (Subconscious) stays
 * sovereign over what its batch means.
 *
 * Four responsibilities:
 * 1. ORGAN REGISTRY — the sensorium's map (ids, types, capabilities).
 * 2. GATE — per-envelope verdict: PASS (weighted), HOLD (counted —
 *    repetition becomes weight, not noise), REFLEX-BYPASS (amplitude
 *    ≥ 0.7; the gate cannot block a startle).
 * 3. BATCHER — noticing runs on slots, not per-event. The slot timer
 *    is a MAXIMUM wait (the resource knob); an empty slot makes no
 *    model call; importance mass or a reflex flushes early.
 * 4. MODULATION ROUTER — conscious-layer attention (pay_attention,
 *    tune_attention, future tools) lands here and resolves against
 *    the registry: Sensory-Organ directives for capable Sensory Organs (riding into
 *    the Sensory Organ's own perception model), typed controls for Sensory Organs
 *    with knobs, content-directed scoring as the fallback.
 */

import type { OrganEnvelope } from "./types.ts";

// =============================================================================
// Types
// =============================================================================

/** What a Sensory Organ can receive from the modulation router. */
export interface OrganCapabilities {
  /** Accepts semantic directives that alter what it perceives ("watch
   * for the blue Subaru" — rides into the perception model's prompt). */
  takesDirectives: boolean;
  /** Accepts classic typed commands (setVolume(5), thresholds, fps). */
  hasControls: boolean;
}

/** One registry entry — the Thalamus's knowledge of one Sensory Organ. */
export interface OrganRegistration {
  organId: string;
  /** Type label ("vision", "audio", "environment", …). */
  type: string;
  capabilities: OrganCapabilities;
  /**
   * OPTIONAL health-probe endpoint (health monitoring).
   * Supplied by the HOST wiring from settings the host already owns —
   * the Sensory Organ itself contributes nothing. Null (default): the
   * monitor judges by heartbeat alone and never probes.
   */
  healthProbeUrl?: string | null;
}

/** Per-envelope verdict from the gate. */
export type GateVerdict =
  | { kind: "pass"; weight: number; reason: string }
  | { kind: "hold"; reason: string }
  | { kind: "reflex"; weight: number; reason: string };

/** One sense's current testimony, gathered at flush time (the ride-along:
 * presence attends every wake; it never triggers one). */
export interface PresenceLine {
  organId: string;
  line: string;
}

/** The batch Noticing receives — one model call per non-empty batch:
 * the triggering envelopes PLUS every fresh sense's presence, so the
 * narration sees the whole sensory moment, not one feed. */
export interface NoticingBatch {
  envelopes: Array<
    { envelope: OrganEnvelope; weight: number; heldCount: number }
  >;
  flushedAt: string;
  flushReason: "slot" | "importance" | "reflex";
  /** Presence snapshots from the other senses at flush time (may be
   * empty). Structure in the input; the narration weaves it. */
  presence?: PresenceLine[];
}

/** Attention state the gate reads — the same signals everything reads. */
export interface ThalamusAttention {
  /** The standing-attention directive (tune_attention's note-to-self). */
  directive: string | null;
  /** The TTL-bounded focus override text (pay_attention's target). */
  focusOverride: string | null;
}

// =============================================================================
// Sensory Organ health (check-engine monitoring)
// =============================================================================

/** One Sensory Organ's health verdict. The USB-flavored contract: the
 * monitor reads only what already flows (envelopes) plus an optional
 * host-supplied probe URL — the Sensory Organ reports nothing itself. */
export type SensoryOrganHealth =
  | { state: "green"; detail: string }
  | { state: "yellow"; detail: string }
  | { state: "red"; detail: string };

/**
 * The health rules (check-engine semantics — green = known good,
 * red = known dead, yellow = evidence something's off, verdict unknown):
 *
 * - RED — probe endpoint unreachable (connection refused/failed) — the
 *   dead-server signature.
 * - YELLOW — contradictions: probe reachable but no envelopes for a
 *   long window (server up, stream dead), or probe succeeded but
 *   errored/timed out (degraded).
 * - GREEN — probe reachable (or none configured) and envelopes flowing,
 *   or silence alone with no probe configured (silence never lies; a
 *   still room is legitimate quiet for a streaming Sensory Organ).
 */
export interface SensoryOrganHealthReport {
  organId: string;
  health: SensoryOrganHealth;
  /** ms epoch of the last envelope received from this Sensory Organ (null never). */
  lastEnvelopeAt: number | null;
  /** ms epoch of the last probe result, when a probe is configured. */
  lastProbeAt: number | null;
}

// =============================================================================
// Thalamus
// =============================================================================

export class Thalamus {
  private registry = new Map<string, OrganRegistration>();

  /** Per-organ hold state: the last PASSED envelope's description +
   * embedding, and the count of similar envelopes held since. */
  private holdState = new Map<
    string,
    { description: string; heldCount: number; lastPassAt: number }
  >();

  /** The accumulating batch between slots. */
  private pending: Array<
    { envelope: OrganEnvelope; weight: number; heldCount: number }
  > = [];

  /** Importance mass accumulated in the pending batch (sum of weights). */
  private pendingMass = 0;

  private slotTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = true;

  // -- Sensory Organ health (check-engine monitor) -----------------------
  /** Last envelope seen per Sensory Organ (ms epoch). The heartbeat. */
  private lastEnvelopeAt = new Map<string, number>();
  /** Last probe outcome per Sensory Organ: reachable / failed / never. */
  private probeState = new Map<
    string,
    { reachable: boolean; at: number; detail: string }
  >();
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  /** How often the monitor evaluates + broadcasts (ms). */
  private static readonly HEALTH_TICK_MS = 30_000;
  /** A streaming Sensory Organ this quiet, with a live probe, is
   * check-engine: not dead, but contradictory. */
  private static readonly SILENCE_SUSPECT_MS = 10 * 60_000;

  constructor(
    private opts: {
      /** Slot interval — the MAXIMUM wait (ms). The resource knob. */
      slotMs: number;
      /** Early-flush when pending importance mass crosses this. */
      flushMass: number;
      /** Reflex amplitude threshold (unconditional pass + flush). */
      reflexThreshold: number;
      /** Hold cooldown: similar envelopes from a Sensory Organ held this long
       * after its last PASS, unless different enough. */
      holdCooldownMs: number;
      /** Read the attention state (directive + focus override). */
      getAttention: () => ThalamusAttention;
      /** Cosine similarity between two texts' embeddings. */
      similarity: (a: string, b: string) => Promise<number>;
      /** Deliver a non-empty batch to Noticing (crosses the boundary). */
      onBatch: (batch: NoticingBatch) => void | Promise<void>;
      /** Gather the other senses' current presence at flush time (the
       * ride-along). Injected by the manager: reads state files,
       * freshness-filters, excludes red organs. The Thalamus stays pure. */
      getPresence?: () => PresenceLine[];
      /** Called when hold-state mutates (volatile snapshot flush). */
      onHoldStateChange?: () => void;
      /** Called each health tick with the full report (broadcast hook). */
      onHealthUpdate?: (report: SensoryOrganHealthReport[]) => void;
    },
  ) {}

  // ---------------------------------------------------------------------------
  // Registry
  // ---------------------------------------------------------------------------

  register(reg: OrganRegistration): void {
    this.registry.set(reg.organId, reg);
  }

  unregister(organId: string): void {
    this.registry.delete(organId);
    this.holdState.delete(organId);
  }

  /** The sensorium's map (registry introspection / future UI). */
  listOrgans(): OrganRegistration[] {
    return [...this.registry.values()];
  }

  /** Export hold-states for the volatile snapshot. */
  exportHoldStates(): Record<
    string,
    { description: string; heldCount: number; lastPassAt: number }
  > {
    return Object.fromEntries(this.holdState.entries());
  }

  /** Restore hold-states from a snapshot. */
  restoreHoldStates(
    snap: Record<
      string,
      { description: string; heldCount: number; lastPassAt: number }
    >,
  ): void {
    for (const [organ, state] of Object.entries(snap)) {
      this.holdState.set(organ, { ...state });
    }
  }

  /** Resolve a modulation instruction against the registry. */
  resolveModulation(
    organId: string,
  ): { organId: string; capabilities: OrganCapabilities } | null {
    return this.registry.get(organId) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleSlot();
    this.startHealthMonitor();
  }

  stop(): void {
    this.stopped = true;
    if (this.slotTimer !== null) {
      clearTimeout(this.slotTimer);
      this.slotTimer = null;
    }
    if (this.healthTimer !== null) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  private scheduleSlot(): void {
    if (this.stopped) return;
    this.slotTimer = setTimeout(() => {
      this.slotTimer = null;
      // EMPTY SLOT = NO CALL. The slot is a maximum wait, not a
      // metronome noticing must answer.
      void this.flush("slot");
      this.scheduleSlot();
    }, this.opts.slotMs);
  }

  // ---------------------------------------------------------------------------
  // Sensory Organ health (check-engine monitor)
  // ---------------------------------------------------------------------------

  /** Start the periodic evaluate-and-broadcast loop. */
  private startHealthMonitor(): void {
    if (this.healthTimer !== null) return;
    // First evaluation soon after start (probes matter most at boot),
    // then steady ticks.
    setTimeout(() => void this.tickHealth(), 3_000);
    this.healthTimer = setInterval(
      () => void this.tickHealth(),
      Thalamus.HEALTH_TICK_MS,
    );
  }

  /** One monitor pass: probe configured endpoints, judge, broadcast. */
  private async tickHealth(): Promise<void> {
    await Promise.all(
      this.listOrgans().map((reg) => this.probeOrgan(reg.organId)),
    );
    this.opts.onHealthUpdate?.(this.healthReport());
  }

  /**
   * Probe one Sensory Organ's configured endpoint (if any). A GET on
   * the /models path of the configured base URL — the cheapest
   * reachability check an OpenAI-compatible server answers. Timeouts
   * and errors both land as unreachable; the DETAIL carries which, so
   * red can say "refused" vs "errored" and yellow can say "timeout".
   */
  private async probeOrgan(organId: string): Promise<void> {
    const reg = this.registry.get(organId);
    const url = reg?.healthProbeUrl;
    if (!reg || !url) return;
    const at = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4_000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      this.probeState.set(organId, {
        reachable: true,
        at,
        detail: `HTTP ${res.status}`,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      this.probeState.set(organId, {
        reachable: false,
        at,
        detail: aborted ? "timeout" : "unreachable",
      });
    }
  }

  /** The full health report — one row per registered Sensory Organ. */
  healthReport(): SensoryOrganHealthReport[] {
    const now = Date.now();
    return this.listOrgans().map((reg) => {
      const lastEnv = this.lastEnvelopeAt.get(reg.organId) ?? null;
      const probe = reg.healthProbeUrl
        ? this.probeState.get(reg.organId) ?? null
        : null;

      let health: SensoryOrganHealth;
      if (probe && !probe.reachable) {
        // Known dead: the endpoint itself refuses. (A timeout reads as
        // unreachable too — a hung server is not "up".)
        health = {
          state: "red",
          detail: `endpoint ${probe.detail}`,
        };
      } else if (
        probe && probe.reachable && lastEnv !== null &&
        now - lastEnv > Thalamus.SILENCE_SUSPECT_MS
      ) {
        // Contradiction: server answers, stream silent for 10+ min.
        health = {
          state: "yellow",
          detail: `endpoint up (${probe.detail}), no envelopes ${
            Math.round((now - lastEnv) / 60_000)
          }m`,
        };
      } else if (
        probe && probe.reachable && lastEnv === null &&
        now - (probe.at) > Thalamus.SILENCE_SUSPECT_MS
      ) {
        // Contradiction shape two: up since boot but never a peep.
        health = {
          state: "yellow",
          detail: `endpoint up, no envelopes since start`,
        };
      } else if (probe && probe.reachable) {
        health = { state: "green", detail: probe.detail };
      } else {
        // No probe configured: silence alone never lies — a still room
        // is legitimate quiet for a streaming Sensory Organ. Green with
        // a note when envelopes flow; unknown-but-quiet reads green to
        // avoid false alarms (the two-signal contract).
        health = {
          state: "green",
          detail: lastEnv !== null
            ? "envelopes flowing"
            : "no probe configured",
        };
      }
      return {
        organId: reg.organId,
        health,
        lastEnvelopeAt: lastEnv,
        lastProbeAt: probe?.at ?? null,
      };
    });
  }

  /** Health heartbeat timestamps for the volatile snapshot (the probe
   * states self-heal on the first tick post-restore — only the
   * envelope history is worth persisting). */
  exportHealthSnapshot(): Record<string, number> {
    return Object.fromEntries(this.lastEnvelopeAt.entries());
  }

  /** Restore heartbeat timestamps (await-ordered at boot). */
  restoreHealthSnapshot(snap: Record<string, number> | undefined): void {
    if (!snap) return;
    for (const [organId, at] of Object.entries(snap)) {
      if (typeof at === "number") this.lastEnvelopeAt.set(organId, at);
    }
  }

  // ---------------------------------------------------------------------------
  // Gate
  // ---------------------------------------------------------------------------

  /**
   * The configured reflex amplitude threshold (read by the noticing
   * path to tag event-class observations — Familiarity's event-exempt
   * rule reads the tag, never the Sensory Organ).
   */
  getReflexThreshold(): number {
    return this.opts.reflexThreshold;
  }

  /**
   * Receive an envelope from a Sensory Organ; gate it. Reflex-bypass envelopes
   * pass unconditionally AND flush the batch immediately (a startle is
   * now, not at the next slot).
   */
  async receive(envelope: OrganEnvelope): Promise<GateVerdict> {
    // The heartbeat the health monitor reads — every envelope landing
    // here is the cheapest possible liveness signal (USB-flavored: the
    // organ doesn't know it's being watched).
    this.lastEnvelopeAt.set(envelope.organId, Date.now());
    if (this.stopped) {
      return { kind: "hold", reason: "thalamus stopped" };
    }

    // Reflex: the gate cannot block a startle.
    if (envelope.amplitude >= this.opts.reflexThreshold) {
      const weight = this.weight(envelope, 1.5);
      this.enqueue(envelope, weight, 0);
      await this.flush("reflex");
      return { kind: "reflex", weight, reason: "amplitude ≥ reflex threshold" };
    }

    // Hold gate: similar to the Sensory Organ's last PASS and inside the
    // cooldown → HOLD (counted; repetition becomes weight later).
    const hold = this.holdState.get(envelope.organId);
    const now = Date.now();
    if (hold && now - hold.lastPassAt < this.opts.holdCooldownMs) {
      const sim = await this.opts.similarity(
        hold.description,
        envelope.perception.description,
      ).catch(() => 0);
      if (sim >= 0.75) {
        hold.heldCount++;
        return {
          kind: "hold",
          reason: `similar to last pass (sim ${sim.toFixed(2)})`,
        };
      }
    }

    // PASS: weighted by amplitude and attention alignment.
    const weight = this.weight(envelope, 1);
    this.holdState.set(envelope.organId, {
      description: envelope.perception.description,
      heldCount: 0,
      lastPassAt: now,
    });
    this.opts.onHoldStateChange?.();
    this.enqueue(envelope, weight, hold?.heldCount ?? 0);

    // Dynamic early-flush: importance mass crossed the bar.
    if (this.pendingMass >= this.opts.flushMass) {
      await this.flush("importance");
    }

    return { kind: "pass", weight, reason: `weight ${weight.toFixed(2)}` };
  }

  /** Importance weight: amplitude × attention alignment (0.5–1.5). */
  private weight(envelope: OrganEnvelope, multiplier: number): number {
    const attention = this.opts.getAttention();
    const desc = envelope.perception.description.toLowerCase();
    let alignment = 0; // -1..1

    if (attention.focusOverride) {
      const words = attention.focusOverride.toLowerCase().split(/\W+/)
        .filter((w) => w.length > 3);
      const hits = words.filter((w) => desc.includes(w)).length;
      if (words.length > 0) {
        alignment = Math.max(alignment, (hits / words.length) * 2 - 0.5);
      }
    }
    if (attention.directive) {
      const words = attention.directive.toLowerCase().split(/\W+/)
        .filter((w) => w.length > 4);
      const hits = words.filter((w) => desc.includes(w)).length;
      if (words.length > 0) {
        alignment = Math.max(alignment, (hits / words.length) * 1.5 - 0.5);
      }
    }

    const alignmentFactor = 1 + Math.max(-0.5, Math.min(0.5, alignment / 2));
    return Math.max(
      0.05,
      Math.min(1.5, envelope.amplitude * alignmentFactor * multiplier),
    );
  }

  private enqueue(
    envelope: OrganEnvelope,
    weight: number,
    heldCount: number,
  ): void {
    this.pending.push({ envelope, weight, heldCount });
    this.pendingMass += weight;
  }

  /** Flush the pending batch to Noticing. Empty → nothing sent. */
  private async flush(reason: NoticingBatch["flushReason"]): Promise<void> {
    if (this.pending.length === 0) return;
    const batch: NoticingBatch = {
      envelopes: this.pending,
      flushedAt: new Date().toISOString(),
      flushReason: reason,
      presence: this.opts.getPresence?.() ?? [],
    };
    this.pending = [];
    this.pendingMass = 0;
    try {
      await this.opts.onBatch(batch);
    } catch (error) {
      console.error(
        "[Thalamus] batch delivery failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
