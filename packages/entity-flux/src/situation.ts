/**
 * Situation detection — the Thalamus's mode layer (vision.md
 * "Sensory modes").
 *
 * Holds the entity's current SITUATION (normal / absent / intimate —
 * absent — or whatever the configuration declares; modes are
 * configuration, not a hardcoded taxonomy) and moves between modes only
 * on sustained evidence: enter hysteresis and exit hysteresis, so a mode
 * never flickers. Re-evaluation is DELTA-DRIVEN:
 * no wall clocks — the classifier is asked only when
 * enough new Noticing material has accrued since the last ask.
 *
 * The classifier is an injected seam: the shipped engine is a frozen
 * encoder + trained linear head (ONNX, CPU); tests use deterministic fakes. Without a
 * classifier, situation detection is inert — it never runs and costs
 * nothing.
 *
 * Input register: PROSE — Noticing's first-person observations, not raw
 * sensor snapshots (clinical
 * sensor-report text does not classify; narration does).
 */

/** One configured sensory mode. Modes are data, never code. */
export interface SensoryMode {
  name: string;
  /** Prose description used by classifiers that score against text. */
  description: string;
}

/** The default mode set — overridable via FluxSettings.sensoryModes. */
export const DEFAULT_SENSORY_MODES: SensoryMode[] = [
  {
    name: "normal",
    description:
      "normal waking activity: a person present and awake — working, cooking, chores, resting quietly",
  },
  {
    name: "absent",
    description:
      "absent: nobody home, empty rooms, no presence for a long time",
  },
  {
    name: "intimate",
    description:
      "intimacy: two people in close private physical contact, physical affection",
  },
];

/**
 * The classifier seam: prose digest in, scores over mode names out.
 * Higher is better; absent names score 0.
 */
export type SituationClassifier = (
  digest: string,
) => Promise<Record<string, number>>;

/** How many fresh observations must accrue before asking the classifier. */
const NEW_MATERIAL_FOR_EVAL = 3;
/** Consecutive agreeing evaluations required to ENTER a mode. */
const ENTER_EVALS = 2;
/** Consecutive disagreeing evaluations required to LEAVE a mode. */
const EXIT_EVALS = 3;
/** How much recent narration rides in each digest. */
const DIGEST_OBSERVATIONS = 6;

/** A completed mode transition, for announcements. */
export interface ModeChange {
  from: string | null;
  to: string;
}

export class SituationDetector {
  private current: string | null = null;
  private pendingEnter: { mode: string; count: number } | null = null;
  private exitCount = 0;
  private newSinceEval = 0;
  private readonly recent: string[] = [];

  constructor(
    /** The configured modes — scores outside this set are ignored. */
    private readonly modes: SensoryMode[] = DEFAULT_SENSORY_MODES,
  ) {}

  /** The current mode, or null before the first established mode. */
  get mode(): string | null {
    return this.current;
  }

  /** Noticing produced an observation; its prose feeds the detector. */
  note(observation: string): void {
    this.recent.push(observation);
    if (this.recent.length > DIGEST_OBSERVATIONS) this.recent.shift();
    this.newSinceEval++;
  }

  /**
   * Evaluate if enough new material has accrued. Returns the completed
   * transition when one happens (enter or switch), else null. Inert —
   * no classifier call at all — without a classifier or fresh material.
   */
  async maybeEvaluate(
    classifier: SituationClassifier | undefined,
  ): Promise<ModeChange | null> {
    if (!classifier || this.newSinceEval < NEW_MATERIAL_FOR_EVAL) return null;
    this.newSinceEval = 0;
    const digest = this.recent.join(" ");
    const scores = await classifier(digest);
    let top: string | null = null;
    let topScore = -Infinity;
    for (const mode of this.modes) {
      const s = scores[mode.name] ?? 0;
      if (s > topScore) {
        topScore = s;
        top = mode.name;
      }
    }
    // No configured mode scored above zero (e.g., a classifier that
    // only says "sleep" while postures own sleep): no verdict, hold.
    if (top === null || topScore <= 0 || top === this.current) {
      if (top === this.current) this.exitCount = 0;
      this.pendingEnter = null;
      return null;
    }

    // Leaving logic: sustained disagreement accumulates exit credit even
    // while a different mode's enter-count builds.
    this.exitCount++;

    this.pendingEnter = this.pendingEnter?.mode === top
      ? { mode: top, count: this.pendingEnter.count + 1 }
      : { mode: top, count: 1 };

    if (this.current === null || this.exitCount >= EXIT_EVALS) {
      if (this.pendingEnter.count < ENTER_EVALS) return null;
      const change: ModeChange = { from: this.current, to: top };
      this.current = top;
      this.exitCount = 0;
      this.pendingEnter = null;
      return change;
    }
    return null;
  }
}
