/**
 * entity-flux — a modular nervous system for persistent entities.
 *
 * I am the flow layer of the entity — the substrate where sensory signal
 * becomes perception, perception becomes observation, and observation
 * occasionally becomes thought. I sit between the transport (entity-plexus
 * and other sensory surfaces) and the cognition layer (the Ego model's
 * EntityTurn). I am not a mind; I am the nervous tissue that feeds one.
 *
 * Design frame (see the project's PHILOSOPHY.md and the plan): distributed,
 * not centralized. No throne, no thalamus-king. The Ego model is an
 * interpreter organ that narrates what the rest of the system already
 * did — not a decider standing above the senses. Local intelligence at
 * every endpoint; coherence from connection, not from command.
 *
 * This barrel re-exports the public surface. Module internals live in
 * their own files; import from `mod.ts`, not from internal modules.
 *
 * @module
 */

export * from "./types.ts";
export * from "./settings.ts";
export * from "./schema.ts";
export * from "./runtime.ts";
export * from "./host.ts";
export { cosineSimilarity, Tier1Store } from "./tier1-store.ts";
export * as tier2 from "./tier2-store.ts";
export {
  createSmallLLMRunner,
  type SmallLLMRunner,
} from "./small-llm-runner.ts";
export {
  type CorroborationLookup,
  runPromotionFilter,
} from "./promotion-filter.ts";
export { ThoughtstreamPuller } from "./thoughtstream.ts";
export { runFluxConsolidation } from "./consolidation.ts";
export { VolatileStateStore } from "./volatile-state.ts";
export type { VolatileState } from "./volatile-state.ts";
// The Sensory Organ sink contract — exported for plugin loaders and organ
// authors (out-of-tree senses receive this in their factory).
export { createSystemStateOrgan } from "./organs/system-state/mod.ts";
// Situation detection (the Thalamus's mode layer) — modes, the classifier
// seam, and the detector itself.
export { DEFAULT_SENSORY_MODES, SituationDetector } from "./situation.ts";
export type {
  ModeChange,
  SensoryMode,
  SituationClassifier,
} from "./situation.ts";
// Postures (THE SPLIT): the entity-chosen states.
export {
  CYCLE_PASSES,
  DREAM_CYCLE_FRAGMENTS,
  PostureState,
  SLEEP_ESCALATION_THRESHOLD,
} from "./posture.ts";
export type { Posture, ReveriePassResult } from "./posture.ts";
export { Dreamer } from "./dreamer.ts";
export type { DreamRecord } from "./dreamer.ts";
export { MoodOrgan } from "./mood-organ.ts";
export {
  EMOTION_CATALOGUE,
  type EmotionTerm,
  nearestEmotions,
} from "./emotion-catalogue.ts";
export {
  affinityFactor,
  type AffinityMap,
  applyAffinity,
  normalizeAffinity,
} from "./mood-affinity.ts";
export { FluxDriver } from "./driver.ts";
export { FluxManager } from "./flux-manager.ts";
export * from "./organs/mod.ts";
