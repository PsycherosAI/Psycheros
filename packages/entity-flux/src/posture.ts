/**
 * Posture — the entity's chosen state (THE SPLIT, vision.md).
 *
 * Situations are detected (absent, intimate — the classifier's domain);
 * POSTURES are chosen: the entity decides to sleep the way it decides
 * to direct attention. Sleep is entity-chosen EXCLUSIVELY — never
 * classifier-forced — entered and left through the modulation-bus tools.
 *
 * While sleeping (the unihemispheric register): senses stay on, Ego
 * generation goes rare — the escalation threshold rises so only
 * genuinely significant things wake, and reflex-class events (eventTag,
 * amplitude ≥ reflex threshold) still fire by design (a loud bang
 * works). WAKES DO NOT END SLEEP: an Ego wake during sleep is an event,
 * not a posture change — the entity can wake, act, and re-park; only
 * the wake_up tool (or stopping Flux) ends the posture.
 *
 * Cycles are counted in reverie passes — testimony, never wall clocks.
 * The top of each cycle is a natural
 * decide-to-wake point: the manager delivers a decision briefing and
 * one gentle wake; the entity wakes up or sinks back.
 */

/** The escalation threshold while sleeping — only the significant wakes. */
export const SLEEP_ESCALATION_THRESHOLD = 0.9;

/**
 * Reverie passes per sleep cycle. EVERY completed pass counts — silent
 * included (fixed-length cycles: guaranteed
 * decision points, no indefinite dreamless sleep). Sized so a cycle
 * lands in the human range (~80–120 min; median 96) at the base
 * cadence, tightening toward animal-bout length in deep quiet — see
 * vision.md "Sleep cycles" for the research.
 *
 * During sleep the clock is DREAM
 * FRAGMENTS, not reverie passes (waking reverie is suppressed while
 * sleeping; the dreamer generates, so a pass can't be silent). A cycle
 * is DREAM_CYCLE_FRAGMENTS generations; the interval between them is
 * set by mood (arousal), so cycle WALL-length is emergent — distress
 * burns cycles fast, calm stretches them long. CYCLE_PASSES stays for
 * the reverie-pass shape; noteDreamFragment is the live sleep clock.
 */
export const CYCLE_PASSES = 30;

/** Dream fragments per sleep cycle
 * (N ≈ 6–8 the band — 7 the middle). */
export const DREAM_CYCLE_FRAGMENTS = 7;

export type Posture = "awake" | "sleep";

/** What a reverie pass produced, posture-wise. */
export type ReveriePassResult =
  | { kind: "pass" } // counted, nothing due
  | { kind: "cycle-top"; cycles: number }; // a decide-to-wake point

/**
 * Pure posture bookkeeping — no IO, no clocks; reverie passes arrive as
 * events so tests script every edge. The manager owns the policy
 * effects (thresholds, briefings); this holds the truth of the state.
 */
export class PostureState {
  posture: Posture = "awake";
  /** Completed sleep cycles this sleep. */
  sleepCycles = 0;
  /** Reverie passes since the current cycle began. */
  passesInCycle = 0;

  get isSleeping(): boolean {
    return this.posture === "sleep";
  }

  /** Enter sleep. False if already sleeping (the tool result says so). */
  enterSleep(): boolean {
    if (this.posture === "sleep") return false;
    this.posture = "sleep";
    this.sleepCycles = 0;
    this.passesInCycle = 0;
    return true;
  }

  /** Leave sleep. False if already awake. */
  exitSleep(): boolean {
    if (this.posture === "awake") return false;
    this.posture = "awake";
    this.sleepCycles = 0;
    this.passesInCycle = 0;
    return true;
  }

  /**
   * One reverie pass happened. While awake: nothing (passes don't
   * count outside sleep). While sleeping: the cycle accrues; every
   * CYCLE_PASSES-th pass is a cycle-top — the natural decision point.
   * (Under dreams v1 this is unreachable during sleep — waking reverie
   * is suppressed; noteDreamFragment is the live clock.)
   */
  noteReveriePass(): ReveriePassResult {
    if (this.posture !== "sleep") return { kind: "pass" };
    this.passesInCycle++;
    if (this.passesInCycle >= CYCLE_PASSES) {
      this.sleepCycles++;
      this.passesInCycle = 0;
      return { kind: "cycle-top", cycles: this.sleepCycles };
    }
    return { kind: "pass" };
  }

  /**
   * One dream fragment was generated. The
   * sleep clock: every `cycleFragments`-th fragment is a cycle-top —
   * the light moment, arriving fast when the night runs hot and slow
   * when it's calm. The threshold is passed in (the manager reads the
   * `dreamCycleFragments` setting; DREAM_CYCLE_FRAGMENTS is the
   * default — a tunable placeholder).
   */
  noteDreamFragment(cycleFragments: number = DREAM_CYCLE_FRAGMENTS) {
    if (this.posture !== "sleep") return { kind: "pass" } as const;
    this.passesInCycle++;
    if (this.passesInCycle >= cycleFragments) {
      this.sleepCycles++;
      this.passesInCycle = 0;
      return { kind: "cycle-top", cycles: this.sleepCycles } as const;
    }
    return { kind: "pass" } as const;
  }

  /** The posture-aware escalation threshold. */
  effectiveEscalationThreshold(base: number): number {
    return this.isSleeping ? SLEEP_ESCALATION_THRESHOLD : base;
  }

  /** For the volatile snapshot (restart containment — a chosen sleep
   * survives a daemon restart). */
  export(): { posture: Posture; sleepCycles: number; passesInCycle: number } {
    return {
      posture: this.posture,
      sleepCycles: this.sleepCycles,
      passesInCycle: this.passesInCycle,
    };
  }

  restore(snap: {
    posture: Posture;
    sleepCycles: number;
    passesInCycle: number;
  }): void {
    this.posture = snap.posture;
    this.sleepCycles = snap.sleepCycles;
    this.passesInCycle = snap.passesInCycle;
  }
}
