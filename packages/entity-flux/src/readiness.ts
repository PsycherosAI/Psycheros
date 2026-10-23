/**
 * Readiness — the Subconscious's shared timing sense.
 *
 * A component IN the Subconscious (not a Thalamus function, not
 * per-module logic). The Thalamus gates Sensory throughput; it does not
 * schedule the mind. Readiness owns its own pulse and answers one
 * question per module per evaluation: is this one ripe to run?
 *
 * The checks are deliberately cheap — timestamps, tier-1 counts, mood
 * state. No model call happens here, ever. The model is touched only
 * when a check passes; a busy afternoon produces zero Reverie model
 * calls, not aborted ones. Suppression means "the check evaluates
 * not-now" — never cancelled work.
 *
 * Conditions (vision.md → Readiness):
 *
 * - Musing runs when the CONVERSATION is quiet and there's un-narrated
 *   material. Active dialogue suppresses it — the Ego already carries
 *   RAG, thinking chains, SA; the monologue speaks through the Ego's
 *   mouth then. When the exchange ends, Musing takes over narration of
 *   what it left behind.
 * - Reverie runs when the ROOM is quiet and the mind is free. Sensory
 *   activity occupies the exterior and the interior holds back; quiet
 *   fills it (the deprivation-tank mechanic).
 * - Genuinely speaking/surfacing something satisfies each module for a
 *   while; running and saying nothing does not.
 *
 * No invented constants: bases inherit the existing cadence settings
 * (ambientSpeechMs for Musing, reverieCadenceMs for Reverie). Clamp and
 * satisfaction tuning waits for lived behavior.
 */

import type { Tier1Store } from "./tier1-store.ts";

/** The signals readiness reads, provided by the manager each pulse. */
export interface ReadinessSignals {
  /** ms since the last Sensory Organ event (room activity). Infinity if none. */
  msSinceOrganEvent: number;
  /** ms since the last user activity in the Flux Space (message). Infinity if none. */
  msSinceUserActivity: number;
  /** Count of un-promoted salient tier-1 observations from the exterior. */
  unnarratedMaterial: number;
  /** Mood arousal, -1..+1. */
  arousal: number;
  /** Mood connection, -1..+1. Legacy (axis temporarily
   *  dropped): always 0 until it returns; kept so the historical
   *  shape and the warmth gate below stay discoverable. */
  connection: number;
}

/** What readiness needs from the outside world. */
export interface ReadinessDeps {
  tier1: Tier1Store;
  /** Read the mood state (arousal, connection). */
  getMoodState: () => { arousal: number; connection: number };
  /** ms since the last Sensory Organ envelope arrived. Null if never. */
  msSinceOrganEvent: () => number | null;
  /** ms since the last user activity in the Flux Space. Null if never. */
  msSinceUserActivity: () => number | null;
}

/** Tuning — bases inherited from settings; satisfaction is the only new
 * concept and it is expressed relative to nothing (just "a while"). */
export interface ReadinessConfig {
  /** Musing's base interval (inherits ambientSpeechMs). */
  musingBaseMs: number;
  /** Reverie's base interval (inherits reverieCadenceMs). */
  reverieBaseMs: number;
}

/**
 * How long a genuine utterance satisfies its module — a multiple of the
 * module's base interval. Relative by design: no new absolute constant.
 */
const SATISFACTION_FACTOR = 2;

/**
 * Readiness evaluation result per module.
 */
export interface ReadinessVerdict {
  musing: boolean;
  reverie: boolean;
}

export class Readiness {
  /** Last time Musing genuinely spoke (murmur/propose). */
  private musingSatisfiedAt = 0;
  /** Which satisfaction factor applies (proposals outlast murmurs). */
  private musingSatisfactionFactor = SATISFACTION_FACTOR;
  /** Last time Reverie genuinely surfaced something. */
  private reverieSatisfiedAt = 0;
  /** Which satisfaction factor applies to reverie (escalated = 4). */
  private reverieSatisfactionFactor = 2;
  /** Last time each module RAN (even silently) — the interval anchor. */
  private musingRanAt = 0;
  private reverieRanAt = 0;

  constructor(
    private deps: ReadinessDeps,
    private config: ReadinessConfig,
  ) {}

  /** Export timestamps for the consolidated volatile snapshot. */
  exportSnapshot(): {
    musingSatisfiedAt: number;
    musingRanAt: number;
    musingSatisfactionFactor: number;
    reverieSatisfiedAt: number;
    reverieRanAt: number;
    reverieSatisfactionFactor: number;
  } {
    return {
      musingSatisfiedAt: this.musingSatisfiedAt,
      musingRanAt: this.musingRanAt,
      musingSatisfactionFactor: this.musingSatisfactionFactor,
      reverieSatisfiedAt: this.reverieSatisfiedAt,
      reverieRanAt: this.reverieRanAt,
      reverieSatisfactionFactor: this.reverieSatisfactionFactor,
    };
  }

  /** Restore from the consolidated snapshot (await-ordered at boot). */
  restoreSnapshot(snap: {
    musingSatisfiedAt?: number;
    musingRanAt?: number;
    musingSatisfactionFactor?: number;
    reverieSatisfiedAt?: number;
    reverieRanAt?: number;
    reverieSatisfactionFactor?: number;
  }): void {
    if (snap.musingSatisfiedAt) this.musingSatisfiedAt = snap.musingSatisfiedAt;
    if (snap.musingRanAt) this.musingRanAt = snap.musingRanAt;
    if (snap.musingSatisfactionFactor) {
      this.musingSatisfactionFactor = snap.musingSatisfactionFactor;
    }
    if (snap.reverieSatisfiedAt) {
      this.reverieSatisfiedAt = snap.reverieSatisfiedAt;
    }
    if (snap.reverieRanAt) this.reverieRanAt = snap.reverieRanAt;
    if (snap.reverieSatisfactionFactor) {
      this.reverieSatisfactionFactor = snap.reverieSatisfactionFactor;
    }
  }

  /** The manager calls this when Musing genuinely speaks (not silence).
   *  `proposal` — speaking TO the user — satisfies 4× base (proposals
   *  are the monologue's biggest act; three in six minutes read as
   *  pressure). Murmurs satisfy 2×. */
  noteMusingSpoke(proposal = false): void {
    const now = Date.now();
    this.musingSatisfiedAt = now;
    this.musingRanAt = now;
    this.musingSatisfactionFactor = proposal ? 4 : 2;
  }

  /** The manager calls this when Musing runs (any outcome). */
  noteMusingRan(): void {
    this.musingRanAt = Date.now();
  }

  /**
   * The manager calls this when Reverie genuinely surfaces (not null).
   * `factor` — how many base intervals this satisfies: a silent
   * surfacing satisfies the usual 2×; an ESCALATED surfacing (one that
   * woke the Ego) satisfies 4× — the interior's biggest act, same
   * treatment as a musing proposal (three wakes in six minutes read as
   * pressure).
   */
  noteReverieSurfaced(factor = 2): void {
    const now = Date.now();
    this.reverieSatisfiedAt = now;
    this.reverieRanAt = now;
    this.reverieSatisfactionFactor = factor;
  }

  /** The manager calls this when Reverie runs (any outcome). */
  noteReverieRan(): void {
    this.reverieRanAt = Date.now();
  }

  /** Evaluate both modules. Cheap; no model calls. */
  evaluate(): ReadinessVerdict {
    const now = Date.now();
    const organGap = this.deps.msSinceOrganEvent();
    const userGap = this.deps.msSinceUserActivity();
    const mood = this.deps.getMoodState();

    // Un-narrated material: salient exterior observations still
    // un-promoted (the near-miss shape — the narrator's domain).
    const oneHourAgo = new Date(now - 3_600_000).toISOString();
    let unnarrated = 0;
    try {
      unnarrated = this.deps.tier1.queryTopSalient(10, oneHourAgo, {
        excludeSource: "reverie",
      }).filter((o) => !o.promoted).length;
    } catch {
      // Tier-1 unavailable — treat as no material.
    }

    const signals: ReadinessSignals = {
      msSinceOrganEvent: organGap ?? Number.POSITIVE_INFINITY,
      msSinceUserActivity: userGap ?? Number.POSITIVE_INFINITY,
      unnarratedMaterial: unnarrated,
      arousal: mood.arousal,
      connection: mood.connection,
    };

    return {
      musing: this.musingReady(now, signals),
      reverie: this.reverieReady(now, signals),
    };
  }

  /**
   * Musing: the CONVERSATION must be quiet (the Ego carries active
   * dialogue — RAG, thinking, SA all flow there; a murmur mid-exchange
   * is noise beside real speech). Then: either enough time since it last
   * genuinely spoke (satisfaction), or material accumulating faster than
   * the base interval (something's on the mind — speak sooner). Having
   * just spoken satisfies; running silent does not shorten the wait.
   */
  private musingReady(now: number, s: ReadinessSignals): boolean {
    // Conversation active — the monologue is being spoken through the
    // Ego. Not now. "Recently" rather than "currently": after the
    // exchange ends the user may still be reading the reply or deciding
    // how to answer — 5 minutes of grace (remote generations alone can
    // run 2+, and an in-flight turn suppresses regardless via the
    // msSinceUserActivity=0 signal).
    const conversationActiveMs = 300_000;
    if (s.msSinceUserActivity < conversationActiveMs) return false;

    const msSinceSpoke = now - this.musingSatisfiedAt;
    const satisfactionMs = this.config.musingBaseMs *
      this.musingSatisfactionFactor;
    if (msSinceSpoke < satisfactionMs && this.musingSatisfiedAt > 0) {
      return false; // genuinely spoke recently — satisfied for a while
    }

    // Interval anchor: time since last RUN (silent runs reset the
    // mundane clock, but speaking resets it too via noteMusingSpoke).
    const msSinceRan = now - this.musingRanAt;
    if (msSinceRan >= this.config.musingBaseMs) return true; // due

    // Early fire: material is piling up while the monologue is quiet —
    // roughly "as much un-narrated material as minutes past half the
    // base interval" pulls it forward.
    if (
      s.unnarratedMaterial >= 3 && msSinceRan >= this.config.musingBaseMs / 2
    ) {
      return true;
    }

    // Warmth is talkative: strong positive connection while otherwise
    // due-adjacent nudges the monologue awake a little early. Dormant
    // with the connection axis (temporarily dropped) — the
    // signal reads 0 until the axis returns.
    if (s.connection > 0.3 && msSinceRan >= this.config.musingBaseMs * 0.75) {
      return true;
    }

    return false;
  }

  /**
   * Reverie: the ROOM must be quiet (sensory activity occupies the
   * exterior; the interior holds back — DMN suppression). Quiet fills
   * it: the longer the quiet, the shorter the effective interval. High
   * arousal also defers (the exterior has the mind). Having genuinely
   * surfaced satisfies for a while.
   */
  private reverieReady(now: number, s: ReadinessSignals): boolean {
    // Room busy — the exterior is occupied. Not now.
    const roomBusyMs = 60_000;
    if (s.msSinceOrganEvent < roomBusyMs) return false;

    const msSinceSurfaced = now - this.reverieSatisfiedAt;
    const satisfactionMs = this.config.reverieBaseMs *
      this.reverieSatisfactionFactor;
    if (msSinceSurfaced < satisfactionMs && this.reverieSatisfiedAt > 0) {
      return false; // genuinely surfaced recently — satisfied
    }

    // Effective interval: the base, shortened by sustained quiet (the
    // tank filling — after a full quietThreshold of quiet, reverie is
    // invited at half-interval), lengthened by high arousal.
    let effective = this.config.reverieBaseMs;
    if (s.msSinceOrganEvent > 300_000) {
      effective = effective * 0.5; // deep quiet invites the interior
    }
    if (s.arousal > 0.3) {
      effective = effective * 1.5; // aroused mind is externally busy
    }

    return now - this.reverieRanAt >= effective;
  }
}
