/**
 * Motion-Vision organ — the scene baseline (stage vs actor).
 *
 * I hold the entity's sense of what the CURRENT SETTING looks like — the
 * stage, never the actor. My baseline describes the room and where the
 * user is ("room with an orange couch, the user at the computer in the
 * chair") and deliberately contains nothing about what they are DOING.
 * Position is stage; action is event. That factorization is the whole
 * trick: a sneeze or a nose-pick can never be habituated away by my
 * baseline, because events were never in it — while the couch they sit on
 * fades into furniture exactly as fast as it should.
 *
 * The mechanic:
 *
 * - Captions that CONFORM (embedding-close to the current scene) EMA into
 *   it — lighting drifts, the day passes. Event captions never touch it.
 * - A caption that doesn't conform is a change. One is an event; sustained
 *   change that then SETTLES is a transition: recognize an earlier scene
 *   from my ring (the desk again — the user oscillates) or establish a new
 *   one (the café — mobility is just entries in the ring).
 * - The baseline's text rides into the captioner's prompt so it
 *   delta-captions: given the stage, describe what is happening NOW. The
 *   LLM performs the scene/event split in the caption text itself — the
 *   thing cosine similarity provably cannot do.
 *
 * I am pure: the Sensory Organ embeds captions (via the host's shared embedder)
 * and feeds me (summary, embedding, timestamp); I return the next state
 * and what happened. No wall-clock, no I/O — tests drive me with toy
 * embeddings the way they drive the presence machines.
 */

import { cosineSimilarity } from "../../vector-math.ts";

// =============================================================================
// Types
// =============================================================================

/** One scene in the ring — a calibrated stage. */
export interface SceneEntry {
  /** Compact scene summary (capped; injected into the captioner prompt). */
  summary: string;
  /** Embedding of the scene (EMA of conforming captions). */
  embedding: number[];
  /** When this scene was last the current one (ms since epoch). */
  lastSeenAt: number;
  /** Conforming-caption count — confidence in the calibration. */
  strength: number;
}

/** Tuning knobs (mirrored into organ config / FluxSettings when wired). */
export interface SceneBaselineConfig {
  /** Cosine at/above which a caption conforms to a scene (default 0.8). */
  recognizeThreshold: number;
  /** Sustained non-conforming time before a transition settles (default 8s). */
  settleMs: number;
  /** How many recent scenes the ring keeps (default 5). */
  ringSize: number;
  /** EMA rate for conforming embedding updates, per caption (default 0.15). */
  updateRate: number;
  /** Hard cap on the summary text — prefill discipline (default 280 chars). */
  summaryCapChars: number;
}

/** Everything the module persists (Sensory Organ state file slice). */
export interface SceneBaselineState {
  /** The ring of calibrated scenes. ring[currentIndex] is the active one
   * when currentIndex !== null. */
  ring: SceneEntry[];
  /** Index into the ring of the current scene; null before first settle. */
  currentIndex: number | null;
  /** When the current run of non-conforming captions began (null = none). */
  changeSince: number | null;
  /** Rolling novelty statistics (for contrast normalization). */
  noveltyMean: number;
  noveltySqMean: number;
  noveltySamples: number;
}

/** One caption observation fed to the module. */
export interface SceneObservation {
  /** The caption text (already delta-shaped once a baseline exists). */
  summary: string;
  /** Its embedding (host's shared embedder; toy vectors in tests). */
  embedding: number[];
  /** When the caption was produced (ms since epoch). */
  at: number;
}

/** What the step decided — the Sensory Organ emits/logs/uses accordingly. */
export interface SceneStepResult {
  kind:
    | "conforming" // matches the current stage; EMA'd in
    | "event" // a non-conforming caption (an action) — novelty, no scene change
    | "settling" // non-conforming change in progress, not yet sustained
    | "recognized" // settled onto a ring scene we've seen before
    | "established"; // settled onto a brand-new scene (ring grew/evicted)
  /** 1 − cosine to the current scene ([0..1] after the step). */
  novelty: number;
  /** Contrast-normalized novelty: how surprising given the recent rate of
   * surprise. High in a quiet room, unremarkable in a noisy one. */
  surprise: number;
  /** The scene text to inject into the captioner's next prompt (the
   * current stage after this step; null before the first settle). */
  promptPrefix: string | null;
  /** The summary that ESTABLISHED a new scene, when kind === "established"
   * (the calibration capture — compact, capped). */
  establishedSummary: string | null;
}

// =============================================================================
// The step
// =============================================================================

/**
 * Advance the scene baseline by one caption. Pure — returns the next state
 * plus a result describing what happened. All timing flows through the
 * observation's timestamp.
 */
export function stepSceneBaseline(
  state: SceneBaselineState,
  obs: SceneObservation,
  config: SceneBaselineConfig,
): { state: SceneBaselineState; result: SceneStepResult } {
  const capped = capSummary(obs.summary, config.summaryCapChars);
  const ring = state.ring.map((s) => ({ ...s, embedding: [...s.embedding] }));
  let currentIndex = state.currentIndex;
  let changeSince = state.changeSince;
  let kind: SceneStepResult["kind"];
  let establishedSummary: string | null = null;

  if (currentIndex === null) {
    // No scene yet — everything is calibration material. Establish on the
    // first caption (the Sensory Organ's startup pass seeds the stage).
    ring.push({
      summary: capped,
      embedding: [...obs.embedding],
      lastSeenAt: obs.at,
      strength: 1,
    });
    currentIndex = ring.length - 1;
    kind = "established";
    establishedSummary = capped;
  } else {
    const cos = cosineSimilarity(obs.embedding, ring[currentIndex].embedding);
    if (cos >= config.recognizeThreshold) {
      // Conforming: EMA the embedding in (the stage drifts), refresh, and
      // clear any pending change — settling happened.
      const a = config.updateRate;
      const entry = ring[currentIndex];
      for (let i = 0; i < entry.embedding.length; i++) {
        entry.embedding[i] = entry.embedding[i] * (1 - a) +
          obs.embedding[i] * a;
      }
      renormalize(entry.embedding);
      entry.lastSeenAt = obs.at;
      entry.strength += 1;
      // Adopt a fresher summary occasionally — keep the stage description
      // current without churning (every 5th conforming caption).
      if (entry.strength % 5 === 0 && capped.length > 0) {
        entry.summary = capped;
      }
      changeSince = null;
      kind = "conforming";
    } else {
      // Non-conforming: an event now; a transition if it sustains.
      changeSince ??= obs.at;
      const sustained = obs.at - changeSince >= config.settleMs;
      if (!sustained) {
        kind = "settling";
      } else {
        // Settled somewhere new (or old). Look for a ring match first —
        // recognition beats re-establishment (no churn on desk↔couch).
        let matchIdx = -1;
        let matchCos = config.recognizeThreshold;
        for (let i = 0; i < ring.length; i++) {
          if (i === currentIndex) continue;
          const c = cosineSimilarity(obs.embedding, ring[i].embedding);
          if (c >= matchCos) {
            matchCos = c;
            matchIdx = i;
          }
        }
        if (matchIdx >= 0) {
          currentIndex = matchIdx;
          const entry = ring[matchIdx];
          const a = config.updateRate;
          for (let i = 0; i < entry.embedding.length; i++) {
            entry.embedding[i] = entry.embedding[i] * (1 - a) +
              obs.embedding[i] * a;
          }
          renormalize(entry.embedding);
          entry.lastSeenAt = obs.at;
          entry.strength += 1;
          kind = "recognized";
        } else {
          if (ring.length >= config.ringSize) {
            // Evict the stalest scene we're not currently in.
            let stalest = -1;
            let staleAt = Infinity;
            for (let i = 0; i < ring.length; i++) {
              if (i === currentIndex) continue;
              if (ring[i].lastSeenAt < staleAt) {
                staleAt = ring[i].lastSeenAt;
                stalest = i;
              }
            }
            if (stalest >= 0) ring.splice(stalest, 1);
            else ring.shift(); // degenerate: everything is current
            if (currentIndex >= ring.length) currentIndex = ring.length - 1;
          }
          ring.push({
            summary: capped,
            embedding: [...obs.embedding],
            lastSeenAt: obs.at,
            strength: 1,
          });
          currentIndex = ring.length - 1;
          kind = "established";
          establishedSummary = capped;
        }
        changeSince = null;
      }
    }
  }

  // Novelty + rolling statistics (contrast normalization: surprise is
  // novelty RELATIVE to the recent rate of novelty — a 0.2 at home is a
  // big deviation; 0.2 in a café is the noise floor). The spread has a
  // FLOOR (not a formula switch): a stable denominator keeps quiet rooms
  // from amplifying micro-noise into fake surprises while still letting a
  // genuine deviation tower over a quiet baseline. Clamped to ±5 so a
  // pathological caption can't produce an unhinged z-score.
  const novelty = currentIndex !== null
    ? 1 - cosineSimilarity(obs.embedding, ring[currentIndex].embedding)
    : 1;
  const samples = state.noveltySamples + 1;
  // EMA of mean and squared mean over a long horizon.
  const emaA = 0.05;
  const noveltyMean = state.noveltyMean * (1 - emaA) + novelty * emaA;
  const noveltySqMean = state.noveltySqMean * (1 - emaA) +
    novelty * novelty * emaA;
  const variance = Math.max(0, noveltySqMean - noveltyMean * noveltyMean);
  const spread = Math.max(Math.sqrt(variance), 0.05);
  const surprise = Math.max(-5, Math.min(5, (novelty - noveltyMean) / spread));

  const next: SceneBaselineState = {
    ring,
    currentIndex,
    changeSince,
    noveltyMean,
    noveltySqMean,
    noveltySamples: samples,
  };

  const promptPrefix = currentIndex !== null
    ? buildScenePromptPrefix(ring[currentIndex].summary)
    : null;

  return {
    state: next,
    result: { kind, novelty, surprise, promptPrefix, establishedSummary },
  };
}

// =============================================================================
// Prompt prefix — the captioner injection
// =============================================================================

/**
 * The text injected into the captioner's prompt: the current stage, so the
 * captioner delta-captions (describes what is happening NOW over the known
 * stage, instead of re-describing the room every pass). Kept SHORT —
 * prefill discipline: the summary is capped, this wrapper is fixed.
 *
 * The grounding sentence is load-bearing (validated on a real
 * empty dark frame): without it, a small VLM trusts the stage text over
 * its own eyes and CONFABULATES the baseline's person into an empty room —
 * overnight, every max-quiet refresh painted the user at a desk she'd left
 * hours before, which the whole downstream (noticing, mood, reverie seeds)
 * then experienced as real. What the frames show outranks what the
 * baseline remembers. Always.
 */
export function buildScenePromptPrefix(sceneSummary: string): string {
  return `Known scene (how this setting usually looks — not who's present now): ${sceneSummary}. Describe what's happening NOW, not the setting. The frames outrank this baseline; if they're dark, empty, or unclear, say so — never invent presence.`;
}

// =============================================================================
// Fresh state + helpers
// =============================================================================

/** A blank scene-baseline state. */
export function freshSceneBaseline(): SceneBaselineState {
  return {
    ring: [],
    currentIndex: null,
    changeSince: null,
    noveltyMean: 0,
    noveltySqMean: 0,
    noveltySamples: 0,
  };
}

/** The active scene summary, or null before the first settle. */
export function currentSceneSummary(
  state: SceneBaselineState,
): string | null {
  return state.currentIndex !== null
    ? state.ring[state.currentIndex].summary
    : null;
}

/** Cap a summary for prompt injection (prefill discipline). */
export function capSummary(summary: string, cap: number): string {
  const trimmed = summary.trim();
  if (trimmed.length <= cap) return trimmed;
  // Cut at a word boundary near the cap.
  const cut = trimmed.slice(0, cap);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > cap * 0.6 ? cut.slice(0, lastSpace) : cut) + "…";
}

/** Renormalize an EMA'd embedding back to unit length. */
function renormalize(v: number[]): void {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm > 0) { for (let i = 0; i < v.length; i++) v[i] /= norm; }
}

/** Rebuild from a persisted state-file slice (defaults for old fields). */
export function restoreSceneBaseline(
  saved: Partial<SceneBaselineState>,
): SceneBaselineState {
  return {
    ring: Array.isArray(saved.ring)
      ? saved.ring.filter((s) =>
        Array.isArray(s.embedding) && typeof s.summary === "string"
      )
      : [],
    currentIndex: typeof saved.currentIndex === "number" &&
        saved.currentIndex >= 0 &&
        saved.currentIndex < (saved.ring?.length ?? 0)
      ? saved.currentIndex
      : null,
    changeSince: typeof saved.changeSince === "number"
      ? saved.changeSince
      : null,
    noveltyMean: typeof saved.noveltyMean === "number" ? saved.noveltyMean : 0,
    noveltySqMean: typeof saved.noveltySqMean === "number"
      ? saved.noveltySqMean
      : 0,
    noveltySamples: typeof saved.noveltySamples === "number"
      ? saved.noveltySamples
      : 0,
  };
}
