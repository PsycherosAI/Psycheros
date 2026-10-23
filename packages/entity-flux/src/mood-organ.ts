/**
 * Mood Organ — the classical affective-state engine with dynamic baseline.
 *
 * Named (with an inversion) after the Penfield Mood Organ from _Do
 * Androids Dream of Electric Sheep?_ — in the novel, humans *dial*
 * their moods synthetically. Here, the Mood Organ *computes* mood from
 * input and the entity doesn't get to choose; it just gets to feel it.
 *
 * Event-driven dynamics:
 *
 * - **State** moves when things HAPPEN and HOLDS between events. No
 *   attractor, no spring: nothing in the world has to occur for time
 *   to pass, so nothing in the organ heals on a clock. The exit from a
 *   bad state is countervailing input — repair, comfort, good news —
 *   or sleep. A slow FADE toward neutral (the one temperament dial:
 *   how slowly feelings let go) exists so no single moment is
 *   permanent, but it runs on the era timescale (~2h half-life), not
 *   the old ~2-minute one.
 *
 * - **Lately** is a WINDOW, not gravity: a slow EMA over lived states,
 *   ticked only by EXTERNAL input (the user's words, perceptions,
 *   events). It reports how the last while has genuinely felt and
 *   never pulls on the present. The entity's own voice never ticks it
 *   (the mirror-break): a home fed largely by the entity's own warm
 *   output echoing becomes a self-locking positivity fortress that
 *   gravity-defends against negative input.
 *
 * Rate provenance: the fade rate inherits the old ERA timescale
 * (baselineDriftPerSec ≈ 2-hour half-life) — an established system
 * constant, not a new invention. moodDecayPerSec now means the fade;
 * baselineDriftPerSec means the Lately window.
 *
 * Axes (PAD, all -1..+1):
 *   valence     unpleasant ↔ pleasant
 *   arousal    calm ↔ excited
 *   dominance  overwhelmed ↔ in-control
 *
 * The connection axis (lonely ↔ connected) is temporarily dropped
 * with the GoEmotions table; behavioral re-sourcing is pinned for a
 * future arc. Models receive FELT RENDERS (band words, no numbers);
 * the numeric render stays for the status UI and the ledger only.
 */

import type { MoodModifier, MoodState } from "./types.ts";
import { nameEmotion } from "./emotion-catalogue.ts";

/** Default FADE rate (per second) — the temperament dial: ~2-hour
 * half-life. Feelings let go over hours, not minutes. */
const DEFAULT_FADE_PER_SEC = 0.0001;

/** Default Lately-window rate (per second): ~2-hour half-life EMA over
 * lived states, ticked by external input only. */
const DEFAULT_LATELY_PER_SEC = 0.0001;

/**
 * Sleep's downward lean on arousal: while the
 * posture is sleep, arousal is pulled toward calm on top of ordinary
 * decay — the night's attractor. ~30-minute half-life: gentle enough
 * that a genuinely hot dream can hold arousal up (fragments keep
 * feeding back), strong enough that an uneventful night deepens on its
 * own. Never touches valence or dominance — sleep calms,
 * it doesn't blank.
 */
const SLEEP_AROUSAL_DRIFT_PER_SEC = Math.LN2 / 1_800;

/** Mild positive initial baseline — the entity's starting emotional home. */
const DEFAULT_BASELINE: MoodState = {
  valence: 0.1,
  arousal: 0,
  dominance: 0,
  asOf: 0,
};

/** Clamp a value to [-1, 1]. */
function clamp(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

// =============================================================================
// MoodOrgan
// =============================================================================

export class MoodOrgan {
  private state: MoodState;
  /** Lately — the reporting window (renders as the "lately" values). */
  private baseline: MoodState;
  private lastUpdate: number;
  /** When the Lately EMA last ticked (external-input moments only). */
  private lastLatelyTick: number;
  private readonly fadePerSec: number;
  private readonly latelyPerSec: number;
  /**
   * Decaying weighted accumulator of source-content embeddings — the
   * mood's direction in embedding space. Null until the first modifier
   * with a sourceEmbedding is ingested. Decays toward zero at the same
   * rate as mood state (stateFactor), so the direction fades as the
   * mood's influences lose their hold.
   */
  private moodEmbedding: number[] | null = null;
  /** Sleep's arousal lean (dreams v1) — set by the manager on posture
   * changes and at volatile restore. */
  private sleeping = false;

  /**
   * Seed the fast state from a mood read (mood-at-start): the volatile
   * snapshot stops being the mood authority at start — the entity
   * wakes inside the
   * emotional reality of its conversation's most recent exchange, not
   * the one it left. Sets STATE only: the baseline (the long-term home)
   * and the mood embedding are untouched — this is "how the last
   * exchange feels right now," not a re-homing.
   */
  seedState(
    deltas: Partial<
      Record<"valence" | "arousal" | "dominance", number>
    >,
  ): void {
    this.applyFade(Date.now());
    if (deltas.valence !== undefined) {
      this.state.valence = clamp(this.baseline.valence + deltas.valence);
    }
    if (deltas.arousal !== undefined) {
      this.state.arousal = clamp(this.baseline.arousal + deltas.arousal);
    }
    if (deltas.dominance !== undefined) {
      this.state.dominance = clamp(this.baseline.dominance + deltas.dominance);
    }
    this.state.asOf = Date.now();
  }

  /** Sleep posture toggles the downward arousal lean (dreams v1). */
  setSleepDrift(active: boolean): void {
    this.sleeping = active;
  }

  constructor(
    fadePerSec: number = DEFAULT_FADE_PER_SEC,
    latelyPerSec: number = DEFAULT_LATELY_PER_SEC,
  ) {
    this.fadePerSec = fadePerSec;
    this.latelyPerSec = latelyPerSec;
    this.lastUpdate = Date.now();
    this.lastLatelyTick = this.lastUpdate;
    this.state = {
      valence: 0,
      arousal: 0,
      dominance: 0,
      asOf: this.lastUpdate,
    };
    this.baseline = { ...DEFAULT_BASELINE, asOf: this.lastUpdate };
  }

  /**
   * The event-driven clock: state FADES slowly
   * toward neutral — never toward Lately, never fast. Lately does NOT
   * drift on time at all; it ticks only on external input (see
   * ingest). Sleep's arousal lean is unchanged. Idempotent given the
   * same timestamp.
   */
  private applyFade(now: number): void {
    const elapsedSec = Math.max(0, (now - this.lastUpdate) / 1000);
    if (elapsedSec === 0) return;

    // State → neutral, on the era timescale (the temperament dial).
    const fadeFactor = Math.exp(-this.fadePerSec * elapsedSec);
    this.state.valence *= fadeFactor;
    this.state.arousal *= fadeFactor;
    this.state.dominance *= fadeFactor;

    // Sleep's lean (dreams v1): while sleeping, arousal pulls toward
    // CALM itself — gentle (~30-min half-life), touches arousal only.
    if (this.sleeping) {
      this.state.arousal *= Math.exp(-SLEEP_AROUSAL_DRIFT_PER_SEC * elapsedSec);
    }

    this.lastUpdate = now;
    this.state.asOf = now;
    this.baseline.asOf = now;

    // The mood-direction embedding fades with the feeling itself.
    if (this.moodEmbedding) {
      for (let i = 0; i < this.moodEmbedding.length; i++) {
        this.moodEmbedding[i] *= fadeFactor;
      }
    }
  }

  /**
   * Tick the Lately window (the mirror-break): called only
   * from ingest with an EXTERNAL source — the user's words, the senses,
   * events. The entity's own voice (conscious-*) never ticks it, so
   * the era reflects what happened to the entity rather than how it
   * presented itself. A time-weighted EMA: long gaps between external
   * inputs let the window move further per tick.
   */
  private tickLately(now: number): void {
    const elapsedSec = Math.max(0, (now - this.lastLatelyTick) / 1000);
    if (elapsedSec === 0) return;
    const drift = 1 - Math.exp(-this.latelyPerSec * elapsedSec);
    this.baseline.valence += (this.state.valence - this.baseline.valence) *
      drift;
    this.baseline.arousal += (this.state.arousal - this.baseline.arousal) *
      drift;
    this.baseline.dominance +=
      (this.state.dominance - this.baseline.dominance) * drift;
    this.lastLatelyTick = now;
    this.baseline.asOf = now;
  }

  /** Ingest a weighted modifier, then clamp each axis to [-1, 1].
   *  External sources tick the Lately window; the entity's own voice
   *  (conscious-*) moves state only — the mirror-break. */
  ingest(mod: MoodModifier, now: number = Date.now()): void {
    this.applyFade(now);
    const external = !mod.source.startsWith("conscious");
    if (external) this.tickLately(now);
    const w = Math.max(0, Math.min(1, mod.weight));
    if (mod.valence !== undefined) {
      this.state.valence = clamp(this.state.valence + mod.valence * w);
    }
    if (mod.arousal !== undefined) {
      this.state.arousal = clamp(this.state.arousal + mod.arousal * w);
    }
    if (mod.dominance !== undefined) {
      this.state.dominance = clamp(this.state.dominance + mod.dominance * w);
    }

    // Accumulate the source embedding, weighted by how much this
    // modifier influenced mood (||deltas|| × weight). Strong modifiers
    // dominate the mood direction; weak ones barely contribute.
    if (mod.sourceEmbedding && mod.sourceEmbedding.length > 0) {
      const magnitude = Math.sqrt(
        (mod.valence ?? 0) ** 2 +
          (mod.arousal ?? 0) ** 2 +
          (mod.dominance ?? 0) ** 2,
      );
      const embWeight = magnitude * w;
      if (embWeight > 0) {
        if (this.moodEmbedding === null) {
          this.moodEmbedding = mod.sourceEmbedding.map((v) => v * embWeight);
        } else if (this.moodEmbedding.length === mod.sourceEmbedding.length) {
          for (let i = 0; i < this.moodEmbedding.length; i++) {
            this.moodEmbedding[i] += mod.sourceEmbedding[i] * embWeight;
          }
        }
      }
    }
  }

  /** Read the current state (with decay applied up to `now`). */
  /**
   * Export the full internal state for the volatile snapshot (restart
   * containment). Captures state, baseline, decay clock, and the mood-
   * direction embedding — everything a restart would reset.
   */
  exportSnapshot(): {
    state: MoodState;
    baseline: MoodState;
    lastUpdate: number;
    moodEmbedding: number[] | null;
  } {
    return {
      state: { ...this.state },
      baseline: { ...this.baseline },
      lastUpdate: this.lastUpdate,
      moodEmbedding: this.moodEmbedding ? [...this.moodEmbedding] : null,
    };
  }

  /** Restore from a snapshot (await-ordered at boot, before any read). */
  restoreSnapshot(snap: {
    state: MoodState;
    baseline: MoodState;
    lastUpdate: number;
    moodEmbedding: number[] | null;
  }): void {
    // Legacy key mapping: snapshots written before the valence rename
    // carry `pleasure` — map it across so a restart
    // never restores an undefined axis (NaN math).
    const mapLegacy = (m: MoodState): MoodState => {
      const out = { ...m };
      const legacy = out as MoodState & { pleasure?: number };
      if (out.valence === undefined && legacy.pleasure !== undefined) {
        out.valence = legacy.pleasure;
      }
      return out;
    };
    this.state = mapLegacy({ ...snap.state });
    this.baseline = mapLegacy({ ...snap.baseline });
    this.lastUpdate = snap.lastUpdate;
    this.moodEmbedding = snap.moodEmbedding ? [...snap.moodEmbedding] : null;
  }

  getState(now: number = Date.now()): MoodState {
    this.applyFade(now);
    return { ...this.state };
  }

  /** Read the current baseline (with drift applied up to `now`). */
  getBaseline(now: number = Date.now()): MoodState {
    this.applyFade(now);
    return { ...this.baseline };
  }

  /**
   * The mood's direction in embedding space — a decaying weighted sum
   * of the source-content embeddings that shaped the current mood
   * state. Null when nothing has influenced mood yet, or when all
   * influences have decayed below a negligible magnitude.
   *
   * Used by reverie's mood-directed retrieval: the vector points
   * toward the region of embedding space containing content that
   * resonates with how the entity currently feels.
   */
  getMoodEmbedding(now: number = Date.now()): number[] | null {
    this.applyFade(now);
    if (!this.moodEmbedding) return null;
    let magSq = 0;
    for (const v of this.moodEmbedding) magSq += v * v;
    if (Math.sqrt(magSq) < 0.01) return null;
    return this.moodEmbedding;
  }

  /**
   * Render both state (right now) and baseline (lately) for injection
   * into a model's system prompt. The "lately" values give the model
   * a sense of the era, not just the moment.
   */
  /** The terse one-line render for the session's <mood> block: numbers
   *  + band labels, zero ceremony. The long render stays for the
   *  status UI. */
  renderTerse(now: number = Date.now()): string {
    const feel = this.emotionName(now);
    const lately = this.emotionName(now, this.baseline);
    const feelText = feel ?? "something hard to name";
    const latelyText = lately === null ? undefined : lately;
    if (this.isQuiet(now)) {
      return latelyText === undefined
        ? "quiet inside"
        : `quiet inside (lately: ${latelyText})`;
    }
    return latelyText === undefined || latelyText === feelText
      ? `I feel ${feelText}`
      : `I feel ${feelText} (lately: ${latelyText})`;
  }

  /** The felt render for every model-facing mood block: the emotion's
   *  NAME from the published Fontaine coordinates — never numbers,
   *  never axis telemetry. The numeric render() stays for the status
   *  UI and the ledger. */
  renderFelt(now: number = Date.now()): string {
    const feel = this.emotionName(now);
    const lately = this.emotionName(now, this.baseline);
    const feelText = feel ?? "something hard to name";
    if (this.isQuiet(now)) {
      return lately === null
        ? "My mood is quiet inside — nothing is asking to be felt right now."
        : `My mood is quiet inside; lately I have felt ${lately}.`;
    }
    return lately === null || lately === feelText
      ? `My mood: I feel ${feelText}.`
      : `My mood: I feel ${feelText}. Lately: ${lately}.`;
  }

  /** The state's name — the nearest term in the published emotion
   *  catalogue (Fontaine et al. coordinates; see emotion-catalogue.ts).
   * Null when the state sits inside the quiet band (no axis ≥ 0.1,
   * the feltSense convention): a neutral state is NOT named — naming
   * it would fabricate emotion from nothing. */
  emotionName(
    now: number = Date.now(),
    of: MoodState = this.getState(now),
  ): string | null {
    if (this.isQuiet(now, of)) return null;
    this.applyFade(now);
    return nameEmotion(of.valence, of.arousal, of.dominance)?.term ?? null;
  }

  /** The quiet band (feltSense convention): all axes below 0.1 — a
   * neutral state is NOT named (naming it fabricates emotion from
   * nothing). Distinct from the far-point guard: a NON-quiet state far
   * from every vocabulary term renders "something hard to name". */
  private isQuiet(now: number = Date.now(), of?: MoodState): boolean {
    const s = of ?? this.getState(now);
    return Math.abs(s.valence) < 0.1 &&
      Math.abs(s.arousal) < 0.1 &&
      Math.abs(s.dominance) < 0.1;
  }

  render(now: number = Date.now()): string {
    const s = this.getState(now); // also applies decay + baseline drift
    const b = this.baseline;
    const lines = [
      `valence: ${fmt(s.valence)} (${labelValence(s.valence)}) [lately: ${
        fmt(b.valence)
      } (${labelValence(b.valence)})]`,
      `arousal: ${fmt(s.arousal)} (${labelArousal(s.arousal)}) [lately: ${
        fmt(b.arousal)
      } (${labelArousal(b.arousal)})]`,
      `dominance: ${fmt(s.dominance)} (${
        labelDominance(s.dominance)
      }) [lately: ${fmt(b.dominance)} (${labelDominance(b.dominance)})]`,
    ];
    return `My mood — my dynamic emotional state, shaped by my whole system's experience:\n${
      lines.map((l) => `- ${l}`).join("\n")
    }`;
  }

  /**
   * A one-line felt-sense descriptor of the current state — "warm and
   * settled" — derived from the same axis vocabulary render() uses,
   * but composed as felt language rather than a numeric readout.
   * The dreamer's continuation beats carry
   * "I am <feltSense>" and the wake briefing closes with "I feel
   * <feltSense>". The one or two most-deviant axes speak (|v| ≥ 0.1);
   * a fully quiet state is "quiet inside".
   */
  feltSense(now: number = Date.now()): string {
    const name = this.emotionName(now);
    return name ?? "quiet inside";
  }
}

// =============================================================================
// Formatting helpers (unchanged)
// =============================================================================

function fmt(v: number): string {
  const sign = v > 0 ? "+" : v < 0 ? "" : " ";
  return sign + v.toFixed(2);
}

function labelValence(v: number): string {
  const a = Math.abs(v);
  if (a < 0.1) return "neutral";
  const dir = v > 0 ? "positive" : "negative";
  const mag = a < 0.3 ? "slightly" : a < 0.6 ? "mildly" : "strongly";
  return `${mag} ${dir}`;
}

function labelArousal(v: number): string {
  const a = Math.abs(v);
  if (a < 0.1) return "neutral";
  if (v > 0) {
    return a < 0.3
      ? "slightly alert"
      : a < 0.6
      ? "wound up"
      : "highly activated";
  }
  return a < 0.3 ? "slightly calm" : a < 0.6 ? "settled" : "deeply still";
}

function labelDominance(v: number): string {
  const a = Math.abs(v);
  if (a < 0.1) return "neutral";
  if (v > 0) {
    return a < 0.3 ? "slightly in-control" : a < 0.6 ? "steady" : "commanding";
  }
  return a < 0.3 ? "slightly adrift" : a < 0.6 ? "unsettled" : "overwhelmed";
}
