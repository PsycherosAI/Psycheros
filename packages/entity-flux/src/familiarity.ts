/**
 * Familiarity — the Subconscious's shared memory of what was recently
 * expressed (self-regulation design; see
 * vision.md → Self-regulation).
 *
 * One decaying pool of embeddings of what the system recently SAID or
 * was recently WOKEN about. Two rules read it:
 *
 * - HABITUATION — effective salience = model-judged salience × a
 *   code-computed novelty factor. The model names what matters; the
 *   pool keeps it honest about repetition.
 * - SATIATION — wake candidates must clear novelty against the pool;
 *   a wake's trigger enters the pool whether or not the wake fired,
 *   so repeated attempts at the same thing are themselves familiarity.
 *
 * NOVELTY IS A RATIO, NOT A THRESHOLD: with the
 * real embedder (MiniLM) and this entity's register, same-riff texts
 * score cosine ~0.3–0.55 while UNRELATED texts score ~0.3–0.65 — the
 * distributions overlap, so no fixed floor/ceiling band can separate
 * them. What
 * DOES separate them is comparison against the pool's own internal
 * density: a candidate is familiar when its top-k pool similarity
 * exceeds the pool's typical pairwise similarity by a ratio. The pool
 * defines its own baseline; the knob is the ratio, robust to embedder
 * and register drift.
 *
 * Scoping: reverie + musing get full habituation +
 * satiation; noticing escalations get satiation only, with the
 * EVENT-EXEMPT path — reflex-class amplitude skips damping entirely,
 * because an event is novel by definition (the sneeze case: same
 * scene, new event, must never be silenced). Direct-engagement wakes
 * clear novelty like every other interpreted signal — an interpreted
 * tag is not an amplitude event and can be the same wrong guess many
 * times — on the same shared clock. Perceptual novelty at
 * large is per-Sensory-Organ baselines' job, not this component's.
 *
 * Same pattern as readiness and compaction: deps-injected, in-memory,
 * snapshot-restorable. The embedder is the shared host EmbedFn (the
 * warm MiniLM singleton) — never a flux-owned one.
 */

import { cosineSimilarity } from "./tier1-store.ts";

/** What kind of thing entered the pool (observability + tuning).
 * All entries decay on
 * their own faster clock: "you just had
 * my attention" is minutes, not the interior 45-minute habituation
 * span, so a repeat bid soon after still wakes. */
export type FamiliarityKind = "wake-trigger" | "ego-speech";

/** One pool entry. Text is kept for damping-log readability only. */
export interface FamiliarityEntry {
  embedding: number[];
  /** ms epoch, when this entered the pool. */
  at: number;
  kind: FamiliarityKind;
  /** First ~80 chars of the source text — for logs, never matched on. */
  text: string;
}

/**
 * Tuning knobs (surface in FluxSettings; defaults via normalize).
 *
 * The half-life and cap behave as before. The band knobs are GONE; the
 * ratio design has:
 * - k — how many nearest pool entries form the candidate's "top-k"
 *   similarity score (mean). Small k tracks sharp duplicates; larger k
 *   tracks theme-level repetition.
 * - ratioThreshold — how many × the pool's internal density the top-k
 *   mean must reach before damping starts. 1.0 = "as close as the pool
 *   is to itself" (too aggressive); ~1.3 = clearly tighter than the
 *   pool's normal register.
 * - fullRatio — the ratio at/above which damping is complete.
 */
export interface FamiliarityConfig {
  /** Entries below this decayed weight are dropped. */
  halfLifeMs: number;
  /** Top-k nearest pool entries for the candidate score. */
  k: number;
  /** Damping begins when top-k mean ≥ ratio × pool density. */
  ratioThreshold: number;
  /** Damping is complete when top-k mean ≥ fullRatio × pool density. */
  fullRatio: number;
  /** Live-entry cap (lowest-weight evicted first; snapshot bound). */
  maxEntries: number;
  /** Pool entries below this count: not enough to judge — all novel. */
  minPoolSize: number;
}

export const DEFAULT_FAMILIARITY_CONFIG: FamiliarityConfig = {
  halfLifeMs: 45 * 60_000,
  k: 3,
  ratioThreshold: 1.3,
  fullRatio: 1.7,
  maxEntries: 64,
  minPoolSize: 4,
};

/** What a damping query returns — full answer, for logs and tests. */
export interface NoveltyVerdict {
  /** 0..1 — effective novelty multiplier on salience. */
  factor: number;
  /** The candidate's top-k mean similarity (0 when unjudgeable). */
  topkSimilarity: number;
  /** The pool's internal pairwise density baseline. */
  poolDensity: number;
  /** The ratio topk/density (0 when unjudgeable). */
  ratio: number;
  /** The nearest pool entry when one was compared; else null. */
  matched: FamiliarityEntry | null;
}

export class Familiarity {
  private pool: FamiliarityEntry[] = [];
  /** Cached pool density (recomputed on ingest; the pool only changes
   * on note()). NaN means "not computed — pool below minPoolSize." */
  private densityValue = NaN;

  constructor(
    private embed: (text: string) => Promise<number[]>,
    private config: FamiliarityConfig = DEFAULT_FAMILIARITY_CONFIG,
  ) {}

  /**
   * Decayed weight of a pool entry, 1 → 0. Engagement entries fade on
   * their own faster clock — the class exists so a repeat bid for
   * attention stops being "familiar" in minutes rather than on the
   * interior half-life.
   */
  private decayWeight(e: FamiliarityEntry, now = Date.now()): number {
    const halfLife = this.config.halfLifeMs;
    return Math.pow(0.5, (now - e.at) / halfLife);
  }

  // ---------------------------------------------------------------------------
  // Ingest
  // ---------------------------------------------------------------------------

  /**
   * Enter a text into the pool (wake triggers enter whether or not the
   * wake fired; Ego speech enters via the host's record hook).
   */
  async note(text: string, kind: FamiliarityKind): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    let embedding: number[];
    try {
      embedding = await this.embed(trimmed);
    } catch {
      // Embedding unavailable — skipping is safe (pool only ever damps).
      return;
    }
    this.pool.push({
      embedding,
      at: Date.now(),
      kind,
      text: trimmed.slice(0, 80),
    });
    this.prune();
    this.densityValue = NaN; // invalidate
  }

  // ---------------------------------------------------------------------------
  // Query
  // ---------------------------------------------------------------------------

  /**
   * The novelty verdict for a candidate: how UN-familiar is this text?
   * `factor` multiplies salience (1 = fully novel, →0 = near-duplicate).
   * One embedding call; no model calls.
   */
  async novelty(text: string): Promise<NoveltyVerdict> {
    const unjudgeable: NoveltyVerdict = {
      factor: 1,
      topkSimilarity: 0,
      poolDensity: 0,
      ratio: 0,
      matched: null,
    };
    const trimmed = text.trim();
    if (!trimmed || this.pool.length < this.config.minPoolSize) {
      return unjudgeable;
    }
    let embedding: number[];
    try {
      embedding = await this.embed(trimmed);
    } catch {
      // Can't judge — treat as novel (never damp on infrastructure
      // failure; damping is an optimization, not a guarantee).
      return unjudgeable;
    }

    const now = Date.now();
    const weight = (e: FamiliarityEntry) => this.decayWeight(e, now);

    // Candidate score: decay-weighted similarity to every entry, top-k.
    const scored = this.pool
      .map((e) => ({
        e,
        sim: cosineSimilarity(embedding, e.embedding) * weight(e),
      }))
      .filter((s) => s.sim > 0)
      .sort((a, b) => b.sim - a.sim);
    if (scored.length === 0) return unjudgeable;
    const k = Math.min(this.config.k, scored.length);
    const topk = scored.slice(0, k);
    const topkMean = topk.reduce((s, x) => s + x.sim, 0) / k;

    // Pool density: the pool's own pairwise similarity — what THIS
    // system's register produces between unrelated thoughts. Cached;
    // recomputed only when the pool changes.
    const density = this.poolDensity(weight);

    // Degenerate case: a maximally diverse pool has density ~0, making
    // the ratio undefined — but that is exactly when repetition is most
    // obvious (top-k high against a pool where nothing relates). Fall
    // back to an absolute top-k check: near-duplicate of SOME entry.
    if (density < 0.05) {
      if (topkMean >= 0.85) {
        return {
          factor: 0,
          topkSimilarity: topkMean,
          poolDensity: density,
          ratio: Number.POSITIVE_INFINITY,
          matched: topk[0]?.e ?? null,
        };
      }
      return {
        factor: 1,
        topkSimilarity: topkMean,
        poolDensity: density,
        ratio: topkMean > 0 ? topkMean / 0.05 : 0,
        matched: topk[0]?.e ?? null,
      };
    }
    if (topkMean <= 0) return unjudgeable;
    const ratio = topkMean / density;

    if (ratio < this.config.ratioThreshold) {
      return {
        factor: 1,
        topkSimilarity: topkMean,
        poolDensity: density,
        ratio,
        matched: topk[0]?.e ?? null,
      };
    }
    // Ramp: threshold → factor 1; fullRatio → factor 0.
    const t = (ratio - this.config.ratioThreshold) /
      (this.config.fullRatio - this.config.ratioThreshold);
    const clamped = Math.max(0, Math.min(1, t));
    return {
      factor: 1 - clamped,
      topkSimilarity: topkMean,
      poolDensity: density,
      ratio,
      matched: topk[0]?.e ?? null,
    };
  }

  /**
   * The pool's internal pairwise similarity density, decay-weighted.
   * O(n²) on the capped pool (≤64 entries = ≤2k pairs) — cheap enough
   * to compute per-ingest and cache.
   */
  private poolDensity(
    weight: (e: FamiliarityEntry) => number,
  ): number {
    if (!Number.isNaN(this.densityValue)) return this.densityValue;
    const n = this.pool.length;
    if (n < this.config.minPoolSize) {
      this.densityValue = 0;
      return 0;
    }
    let sum = 0;
    let totalWeight = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const w = weight(this.pool[i]) * weight(this.pool[j]);
        sum +=
          cosineSimilarity(this.pool[i].embedding, this.pool[j].embedding) * w;
        totalWeight += w;
      }
    }
    this.densityValue = totalWeight > 0 ? sum / totalWeight : 0;
    return this.densityValue;
  }

  /** Current live entry count (status/observability). */
  get size(): number {
    return this.pool.length;
  }

  /** The most recently damped candidate's matched text, for status. */
  private lastDampedText: string | null = null;
  get lastDamped(): string | null {
    return this.lastDampedText;
  }
  /** Called by the manager when a wake is actually damped (status feed). */
  noteDamped(text: string): void {
    this.lastDampedText = text.slice(0, 80);
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  /** Drop expired entries and enforce the cap. Cheap; called on ingest. */
  private prune(): void {
    this.pool = this.pool.filter((e) => this.decayWeight(e) >= 0.01);
    if (this.pool.length > this.config.maxEntries) {
      // Evict lowest decayed weight.
      this.pool.sort((a, b) => this.decayWeight(b) - this.decayWeight(a));
      this.pool = this.pool.slice(0, this.config.maxEntries);
    }
  }

  // ---------------------------------------------------------------------------
  // Snapshot (restart containment — VolatileState carries this)
  // ---------------------------------------------------------------------------

  /** Export for the consolidated volatile snapshot. Embeddings are
   * rounded to 3 decimals to keep the JSON blob cheap. */
  exportSnapshot(): FamiliarityEntry[] {
    return this.pool.map((e) => ({
      ...e,
      embedding: e.embedding.map((v) => Math.round(v * 1000) / 1000),
    }));
  }

  /** Restore (await-ordered at boot, before the first tick). */
  restoreSnapshot(entries: FamiliarityEntry[] | undefined): void {
    if (!Array.isArray(entries)) return;
    this.pool = entries
      .filter((e) =>
        Array.isArray(e.embedding) && e.embedding.length > 0 &&
        typeof e.at === "number"
      )
      .map((e) => ({
        ...e,
        // Snapshot compat: old snapshots may carry kind:"engagement"
        // (the legacy fast-clock kind) — load them as
        // wake-triggers on the one shared clock. (Widened compare —
        // the union no longer names the legacy kind.)
        kind: (e.kind as string) === "engagement" ? "wake-trigger" : e.kind,
      }));
    this.prune();
    this.densityValue = NaN;
  }
}
