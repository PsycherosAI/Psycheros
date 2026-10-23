/**
 * FluxDriver — the continuous adaptive loop.
 *
 * Replaces the old fixed-interval driver with an adaptive cadence that
 * modulates tick rate based on mood arousal and Sensory Organ activity. The loop
 * runs continuously between user messages (the entity's interior life).
 * When the user speaks, EntityTurn handles it (via pendingTurns). When
 * the subconscious escalates, the Ego model wakes directly (via
 * pendingWake). Both are guarded by `inFlightTurn` so at most one Ego
 * operation is in progress at a time.
 *
 * Cadence is adaptive:
 * - High mood arousal → faster ticks (entity is activated)
 * - Low arousal / quiet period → slower ticks (entity idles)
 * - Sensory Organ urgency signal → immediate tick (reflex arc)
 *
 * All cadences are configurable via FluxSettings.
 */

import type { FluxManager } from "./flux-manager.ts";
import type { LoopSessionState } from "./types.ts";

// =============================================================================
// Pending Ego operations
// =============================================================================

interface PendingTurn {
  prompt: string;
  sourceDescription: string;
  pulseMeta?: { pulseId?: string; pulseName?: string };
}

interface PendingWake {
  contextQuery: string;
  sourceDescription: string;
  /** Dream material for the open sleep call's return (dreams v2). */
  dreamReturn?: import("./host.ts").DreamReturn;
}

// =============================================================================
// Driver config
// =============================================================================

export interface DriverConfig {
  baseTickMs: number;
  minTickMs: number;
  maxTickMs: number;
  arousalInfluence: number;
  quietThresholdMs: number;
  ambientMs: number;
  thoughtstreamMs: number;
  compactionMs: number;
  longformCompactionMs: number;
  reverieMs: number;
}

// =============================================================================
// Driver
// =============================================================================

export class FluxDriver {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlightTurn = false;
  private ticking = false;
  /** Whether the driver is actively running (not stopped/paused). Prevents
   * stale Sensory Organ ticks from re-arming the driver after stop(). */
  private running = false;

  // Session state — controls whether the loop is ticking or paused.
  private sessionState: LoopSessionState = "ambient";

  // Pending operations (queued by the manager).
  private pendingTurns: PendingTurn[] = [];
  private pendingWake: PendingWake | null = null;

  // Per-cadence "last run" timestamps (ms).
  private lastThoughtstream = 0;
  private lastCompaction = 0;
  private lastLongformCompaction = 0;
  private lastPromotion = 0;
  /** Export cadence timestamps for the consolidated volatile snapshot. */
  exportSnapshot(): {
    lastCompaction: number;
    lastLongformCompaction: number;
    lastPromotion: number;
  } {
    return {
      lastCompaction: this.lastCompaction,
      lastLongformCompaction: this.lastLongformCompaction,
      lastPromotion: this.lastPromotion,
    };
  }

  /** Restore cadence timestamps (await-ordered BEFORE the first tick). */
  restoreSnapshot(snap: {
    lastCompaction?: number;
    lastLongformCompaction?: number;
    lastPromotion?: number;
  }): void {
    if (snap.lastCompaction) this.lastCompaction = snap.lastCompaction;
    if (snap.lastLongformCompaction) {
      this.lastLongformCompaction = snap.lastLongformCompaction;
    }
    if (snap.lastPromotion) this.lastPromotion = snap.lastPromotion;
  }

  // Time of last Sensory Organ activity (for quiet detection).
  private lastEventTime = Date.now();

  // Cadence parameters (set by start).
  private config: DriverConfig | null = null;

  /** Promotion runs at most this often (ms), even if ticks are faster. */
  private readonly promotionMinGap = 5_000;

  constructor(private manager: FluxManager) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(config: DriverConfig): void {
    if (this.running) return;
    this.running = true;
    this.config = config;
    this.sessionState = "ambient";
    this.lastEventTime = Date.now();
    this.scheduleNextTick();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.sessionState = "ambient";
    this.pendingWake = null;
    this.pendingTurns = [];
  }

  // ---------------------------------------------------------------------------
  // Adaptive scheduling
  // ---------------------------------------------------------------------------

  private scheduleNextTick(): void {
    if (!this.running) return; // stopped/paused — don't re-arm
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    if (this.sessionState !== "ambient") return; // paused
    if (!this.config) return;

    const delay = this.computeAdaptiveDelay();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick()
        .catch((error) => {
          console.error(
            "[Flux] Driver tick failed:",
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => {
          this.scheduleNextTick();
        });
    }, delay);
  }

  /**
   * Compute the adaptive tick delay based on mood arousal and quiet
   * detection. High arousal → faster. Quiet period → slower. Clamped
   * to [minTickMs, maxTickMs].
   */
  private computeAdaptiveDelay(): number {
    if (!this.config) return 3_000;

    const moodState = this.manager.getMoodState();
    const arousal = moodState.arousal; // -1 to +1

    // Base: start from baseTickMs.
    let delay = this.config.baseTickMs;

    // Arousal modulation: high arousal → faster, low → slower.
    const arousalFactor = 1 - (arousal * this.config.arousalInfluence);
    delay = delay * arousalFactor;

    // Quiet detection: if no Sensory Organ events for quietThresholdMs, slow down.
    const timeSinceEvent = Date.now() - this.lastEventTime;
    if (timeSinceEvent > this.config.quietThresholdMs) {
      const quietExcess = timeSinceEvent - this.config.quietThresholdMs;
      const rampFactor = Math.min(
        1,
        quietExcess / this.config.quietThresholdMs,
      );
      delay = delay + (this.config.maxTickMs - delay) * rampFactor;
    }

    // Clamp.
    return Math.round(
      Math.max(this.config.minTickMs, Math.min(this.config.maxTickMs, delay)),
    );
  }

  // ---------------------------------------------------------------------------
  // External requests
  // ---------------------------------------------------------------------------

  /** Queue a user-message Ego turn (EntityTurn). */
  requestEgoTurn(
    prompt: string,
    sourceDescription: string,
    pulseMeta?: { pulseId?: string; pulseName?: string },
  ): void {
    this.pendingTurns.push({ prompt, sourceDescription, pulseMeta });
  }

  /** Queue an Ego wake from escalation (self-initiated, no user message).
   *  `dreamReturn` carries sleep-call return material while sleeping. */
  requestEgoWake(
    contextQuery: string,
    sourceDescription: string,
    dreamReturn?: import("./host.ts").DreamReturn,
  ): void {
    this.pendingWake = { contextQuery, sourceDescription, dreamReturn };
  }

  /** ms since the last Sensory Organ event (readiness signal). Null if none yet. */
  msSinceOrganEvent(): number | null {
    return this.lastEventTime === 0 ? null : Date.now() - this.lastEventTime;
  }

  /** Whether an Ego turn/wake is generating right now (readiness signal —
   * remote inference can run minutes; the monologue must not murmur
   * beside a still-generating reply). */
  isEgoTurnInFlight(): boolean {
    return this.inFlightTurn;
  }

  /** Bypass the cadence — tick immediately (urgent Sensory Organ event or user message). */
  requestImmediateTick(): void {
    if (!this.running) return; // stopped/paused — ignore
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.sessionState !== "ambient") return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick()
        .catch((error) => {
          console.error(
            "[Flux] Driver tick failed:",
            error instanceof Error ? error.message : String(error),
          );
        })
        .finally(() => {
          this.scheduleNextTick();
        });
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // Tick
  // ---------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.ticking) return; // prevent overlap
    this.ticking = true;

    try {
      const now = Date.now();

      if (this.sessionState !== "ambient") return;

      // 1. Ego wake (self-initiated, from escalation). Highest priority
      //    alongside user turns. Only one Ego operation at a time.
      if (!this.inFlightTurn && this.pendingWake) {
        const wake = this.pendingWake;
        this.pendingWake = null;
        this.inFlightTurn = true;
        this.sessionState = "ego_wake";
        try {
          await this.manager.runEgoWake(
            wake.contextQuery,
            wake.sourceDescription,
            wake.dreamReturn,
          );
        } catch (error) {
          console.error(
            "[Flux] Ego wake failed:",
            error instanceof Error ? error.message : String(error),
          );
        } finally {
          this.sessionState = "ambient";
          this.inFlightTurn = false;
        }
        return;
      }

      // 2. Ego turn (EntityTurn, from user message).
      if (!this.inFlightTurn && this.pendingTurns.length > 0) {
        const turn = this.pendingTurns.shift()!;
        this.inFlightTurn = true;
        try {
          await this.manager.runEgoTurn(
            turn.prompt,
            turn.sourceDescription,
            turn.pulseMeta,
          );
        } finally {
          this.inFlightTurn = false;
        }
        return;
      }
      if (this.inFlightTurn) return;

      // 3. Promotion batch — gated by a minimum gap.
      if (now - this.lastPromotion >= this.promotionMinGap) {
        this.lastPromotion = now;
        try {
          const promoted = await this.manager.runPromotionBatch();
          if (promoted > 0) {
            this.lastEventTime = now; // Sensory Organ activity detected
          }
        } catch (error) {
          console.error(
            "[Flux] Promotion batch failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      // 4. Musing — readiness decides (conversation quiet + material);
      //    the Subconscious's own
      //    timing sense says when the monologue runs. Suppressed while
      //    sleeping: the night's interior is
      //    the dreamer, not the monologue.
      if (!this.manager.isSleeping() && this.manager.isReady("musing")) {
        try {
          await this.manager.runMusing();
        } catch (error) {
          console.error(
            "[Flux] Musing failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      // 5. Thoughtstream — pull summaries from classic conversations.
      if (
        this.config &&
        now - this.lastThoughtstream >= this.config.thoughtstreamMs
      ) {
        this.lastThoughtstream = now;
        try {
          await this.manager.runThoughtstream();
        } catch (error) {
          console.error(
            "[Flux] Thoughtstream failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      // 6 + 7. Compaction — compress recent observations into texture.
      //    Both systems compact at the same cadence but process different
      //    observations (noticing excludes reverie, reverie only reverie).
      //    OVERLAP RULE: when the short and longform windows elapse in
      //    the same tick, only the longform pass runs and BOTH clocks
      //    reset — the hour window contains the 15-min window, so the
      //    short pass in that tick would be a second LLM call over a
      //    subset of the same observations. Per-chain by
      //    construction: each chain's short is subsumed by its own
      //    hour pass.
      const compactionDue = this.config !== null &&
        now - this.lastCompaction >= this.config.compactionMs;
      const longformDue = this.config !== null &&
        now - this.lastLongformCompaction >=
          this.config.longformCompactionMs;

      if (compactionDue && !longformDue) {
        this.lastCompaction = now;
        try {
          await this.manager.runCompactionPass();
        } catch (error) {
          console.error(
            "[Flux] Compaction failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
        try {
          await this.manager.runReverieCompactionPass();
        } catch (error) {
          console.error(
            "[Flux] Reverie compaction failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      if (longformDue) {
        this.lastLongformCompaction = now;
        // The longform pass satisfies the short cadence too.
        this.lastCompaction = now;
        try {
          await this.manager.runLongformCompactionPass();
        } catch (error) {
          console.error(
            "[Flux] Longform compaction failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
        try {
          await this.manager.runReverieLongformCompactionPass();
        } catch (error) {
          console.error(
            "[Flux] Reverie longform compaction failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      // 8. Reverie — readiness decides (room quiet + mind free). The
      //    DMN's disposition is constant; its expression waits for the
      //    quiet the interior needs. Suppressed while sleeping (dreams
      //    v1): the dreamer is the sleeping interior.
      if (!this.manager.isSleeping() && this.manager.isReady("reverie")) {
        try {
          await this.manager.runReverie();
        } catch (error) {
          console.error(
            "[Flux] Reverie failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      // 9. Dreams — while sleeping, the dreamer
      //    replaces musing + reverie: one fragment per due beat, paced
      //    by mood, counted in fragments, cycles ending in the light
      //    moment. Nulls are structurally impossible — the only move
      //    is to continue.
      if (this.manager.isDreamDue()) {
        try {
          await this.manager.runDreamFragment();
        } catch (error) {
          console.error(
            "[Flux] Dream fragment failed:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
