/**
 * Mood affinity — relationship weighting applied HOST-side to declared
 * modifiers.
 *
 * A Sensory Organ declares what its event means affectively ("arrival of
 * this person: connection +0.15") and WHO it's about (`MoodModifier.subject`)
 * — but it never holds relationship knowledge; "who matters to me and how
 * much" is not a camera's business. This module is the other half: the host
 * scales the CONNECTION component of a declared modifier by the per-subject
 * affinity from settings (`faceAffinity`), so a favorable face's arrival
 * lifts more, an unfavorable one's barely at all (or not at all).
 *
 * Only connection scales — valence/arousal stay as declared. Seeing anyone
 * at all is still mild news; how much their presence bonds me is the
 * relationship question, and that's the only thing affinity answers.
 *
 * Affinity range [-1..+1]: factor = 1 + affinity, clamped to [0..2]. Zero
 * (or unset) = factor 1 = exactly the declared value — affinity is
 * opt-in per subject, never a surprise.
 */

import type { MoodModifier } from "./types.ts";

/** The per-subject affinity map from FluxSettings (id → [-1..+1]). */
export type AffinityMap = Record<string, number>;

/** Connection-multiplier for an affinity value. */
export function affinityFactor(affinity: number): number {
  return Math.max(0, Math.min(2, 1 + affinity));
}

/** Clamp + validate a raw affinity value from settings; 0 when invalid. */
export function normalizeAffinity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

/**
 * Apply relationship weighting to a declared modifier. Scales connection by
 * the subject's affinity factor; everything else passes through untouched.
 * Modifiers without a subject, or whose subject has no affinity entry,
 * return unchanged.
 *
 * Dormant-period shape: the connection axis is temporarily
 * dropped from MoodModifier, so connection is read/written through a
 * widened view — every modifier currently passes through unchanged, and
 * the scaling reactivates automatically the day the axis returns
 * (behavioral re-sourcing pinned for a future arc).
 */
export function applyAffinity(
  mod: MoodModifier,
  affinities: AffinityMap,
): MoodModifier {
  const m = mod as MoodModifier & { connection?: number };
  if (!m.subject || m.connection === undefined) return mod;
  const raw = affinities[m.subject];
  if (raw === undefined) return mod;
  const factor = affinityFactor(normalizeAffinity(raw));
  if (factor === 1) return mod;
  return { ...mod, connection: m.connection * factor } as MoodModifier;
}
