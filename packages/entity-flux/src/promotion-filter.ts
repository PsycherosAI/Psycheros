/**
 * Promotion filter — the load-bearing narrow waist.
 *
 * Decides which tier-1 observations survive into tier 2 and which
 * actively escalate to the Ego model. Does triple duty: quality
 * control (keep the small model's noise out of the durable stream),
 * attention (semantic relevance to current focus), and defense
 * (corroboration requirement resists memo injection and slow-bias).
 *
 * This is a pure function over pre-embedded observations. The
 * FluxManager embeds observations on insert and computes the focus
 * embedding before calling here; the corroboration lookup is injected
 * (wrapping `Tier1Store.querySimilar`). Keeping the filter pure makes
 * it trivially unit-testable — the narrow waist deserves direct tests.
 *
 * Scoring (per observation, all terms in [0..1]):
 *   combined = salience * 0.4 + relevance * 0.3 + corroborationBoost * 0.3
 *
 * Promote when combined >= thresholds.combined. Escalate to the Ego when
 * combined >= thresholds.escalation (highest scorer only).
 */

import { cosineSimilarity } from "./tier1-store.ts";
import type {
  FluxObservation,
  PromotionResult,
  PromotionThresholds,
} from "./types.ts";

// =============================================================================
// Injected dependencies
// =============================================================================

/**
 * Finds tier-1 observations whose embedding is similar (cosine ≥
 * threshold) to the given embedding within the time window. Injected by
 * the FluxManager, wrapping `Tier1Store.querySimilar`. Kept as a
 * callback so the filter stays pure and testable.
 */
export type CorroborationLookup = (
  embedding: number[],
  threshold: number,
  sinceISO: string,
) => FluxObservation[];

// =============================================================================
// Filter
// =============================================================================

/**
 * Run the promotion filter over a batch of unpromoted observations.
 *
 * Observations without an embedding are skipped (the FluxManager is
 * responsible for embedding on insert). Observations below the salience
 * gate are skipped without a corroboration lookup (cheap early exit).
 */
export function runPromotionFilter(
  observations: FluxObservation[],
  focusEmbedding: number[],
  thresholds: PromotionThresholds,
  findCorroboration: CorroborationLookup,
  now: Date = new Date(),
): PromotionResult {
  const windowSinceISO = new Date(
    now.getTime() - thresholds.corroborationWindowMs,
  ).toISOString();

  const promoted: PromotionResult["promoted"] = [];
  let escalate: PromotionResult["escalateToEgo"];

  for (const observation of observations) {
    // Need an embedding to judge relevance or corroboration.
    if (!observation.embedding) continue;

    // Effective salience (the agreed familiarity design: model-judged
    // relevance × code-computed novelty). The Sensory Organ declares surprise on
    // the envelope (the scene baseline's contrast-normalized novelty vs its
    // stage); it rides the observation as a `surprise:<n>` tag. A 0.85-
    // salience observation of a deeply familiar scene (surprise ≈ 0)
    // halves to ~0.43 effective — no escalation, no promotion flood —
    // while a genuinely novel observation (surprise ≥ ~1.4) passes at
    // full strength. No tag = no declared novelty = raw salience
    // (organs that don't declare are unaffected).
    const effectiveSalience = observation.salience *
      noveltyFactor(surpriseTagValue(observation.tags));

    // Amplitude gate — cheap early exit before any lookup.
    if (effectiveSalience < thresholds.salience) continue;

    // Semantic relevance to current focus.
    const relevance = cosineSimilarity(observation.embedding, focusEmbedding);
    const relevancePass = relevance >= thresholds.relevance;

    // Corroboration — independent nearby observations saying something
    // similar. Excludes the observation itself.
    const corroborators = findCorroboration(
      observation.embedding,
      thresholds.corroboration,
      windowSinceISO,
    ).filter((o) => o.id !== observation.id);
    // Boost saturates: one corroborator is most of the signal; more add
    // diminishing weight. This keeps a flood from over-boosting.
    const corroborationBoost = Math.min(1, corroborators.length * 0.4);

    const combined = effectiveSalience * 0.4 +
      relevance * 0.3 +
      corroborationBoost * 0.3;

    if (combined < thresholds.combined) continue;

    const reason = formatReason({
      salience: effectiveSalience,
      relevance,
      corroborationCount: corroborators.length,
      relevancePass,
      combined,
    });

    promoted.push({ observation, combinedScore: combined, reason });

    if (
      !escalate &&
      combined >= thresholds.escalation
    ) {
      escalate = { observation, combinedScore: combined, reason };
    }
  }

  // Sort promoted by score descending so the caller sees strongest first.
  promoted.sort((a, b) => b.combinedScore - a.combinedScore);

  return { promoted, ...(escalate ? { escalateToEgo: escalate } : {}) };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Parse the declared-novelty tag (`surprise:<n>`, set by the Thalamus from
 * envelope `perception.data.surprise`). Absent/unparseable = null — the
 * observation keeps its raw salience.
 */
export function surpriseTagValue(tags: string[]): number | null {
  for (const tag of tags) {
    if (tag.startsWith("surprise:")) {
      const value = Number.parseFloat(tag.slice("surprise:".length));
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

/**
 * Map a surprise score (contrast-normalized novelty, roughly z-scored —
 * 0 = exactly as surprising as this environment usually is) to a
 * multiplier on model-judged salience. 0 → 0.5 (halved — familiar scene),
 * ≈ +1.4 → 1.0 (full strength), negative → down toward 0.15 (the stage
 * just keeps confirming itself). Reflex-class events never reach this
 * path damped — their envelopes carry full amplitude by design.
 */
export function noveltyFactor(surprise: number | null): number {
  if (surprise === null) return 1;
  return Math.max(0.15, Math.min(1, 0.5 + 0.35 * surprise));
}

/** Build a human-readable reason string for the promotion record. */
function formatReason(args: {
  salience: number;
  relevance: number;
  corroborationCount: number;
  relevancePass: boolean;
  combined: number;
}): string {
  const parts: string[] = [];
  parts.push(`salience ${args.salience.toFixed(2)}`);
  parts.push(
    `relevance ${args.relevance.toFixed(2)}${
      args.relevancePass ? "" : " (below gate)"
    }`,
  );
  parts.push(`${args.corroborationCount} corroborator(s)`);
  parts.push(`combined ${args.combined.toFixed(2)}`);
  return parts.join(", ");
}
