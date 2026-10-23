/**
 * Foundational types for entity-flux.
 *
 * These are the typed surfaces every other module builds on. The shapes
 * here are the protocol — the minimal transport contract between organs,
 * the noticing layer, the promotion filter, and the Flux Space. Per-organ
 * schema sovereignty lives inside `Perception.data`: each Sensory Organ owns its
 * own structured payload, the envelope around it is the shared contract.
 */

// =============================================================================
// Perception layer — organ output
// =============================================================================

/**
 * Structured output from a frozen specialist model (the small neural net
 * inside a Sensory Organ — a classifier, embedder, or detector). This is what
 * raw sensory signal becomes before it reaches the noticing layer.
 */
export interface Perception {
  /** Category label, e.g. "motion_detected", "sound_classified". */
  type: string;
  /** Human-readable description of what I perceived. */
  description: string;
  /**
   * Structured key-value payload from the classifier. Shape is owned by
   * the Sensory Organ — per-organ schema sovereignty. The envelope around it is
   * the shared contract, not this field.
   */
  data: Record<string, unknown>;
  /** Specialist-model confidence [0..1]. */
  confidence: number;
}

/**
 * The envelope every Sensory Organ emits when it has a perception. This is the
 * typed pub/sub message format — the minimal transport contract. Each
 * organ owns its perception.data shape; no central schema authority.
 */
export interface OrganEnvelope {
  /** UUID for this event. */
  id: string;
  /** ISO timestamp of when the Sensory Organ produced this signal. */
  timestamp: string;
  /** The Sensory Organ that produced this signal (e.g. "motion-vision"). */
  organId: string;
  /** The specialist model that classified this signal. */
  specialistModel: string;
  /** Structured perception payload from the specialist model. */
  perception: Perception;
  /** Raw signal data — kept for replay/debugging, never sent to the LLM. */
  rawSignal?: unknown;
  /** Initial amplitude score from the specialist [0..1]. */
  amplitude: number;
  /**
   * Optional mood modifiers the Sensory Organ emits alongside the perception.
   * Ingested by the Mood Organ to shift affective state. Each organ
   * emits on whichever axes it has opinions about. See `mood-organ.ts`.
   */
  moodModifiers?: MoodModifier[];
}

// =============================================================================
// Mood — the Mood Organ (classical affective state)
// =============================================================================

/**
 * The three affective axes the Mood Organ tracks — VAD (valence /
 * arousal / dominance), the well-validated psychology model. The
 * connection axis (lonely ↔ connected) is temporarily dropped
 * along with the GoEmotions mood table —
 * no dataset annotates it; re-sourcing it behaviorally (presence,
 * conversation cadence) is pinned for a future arc. All axes range
 * -1 to +1, neutral at 0.
 */
export type MoodAxis = "valence" | "arousal" | "dominance";

/** A point-in-time affective state on the three axes. */
export interface MoodState {
  valence: number;
  arousal: number;
  dominance: number;
  /** ms timestamp — when this state was last computed. */
  asOf: number;
}

/**
 * A weighted shift to affective state. Emitted by organs (bottom-up),
 * and in future phases by the noticing and conscious layers (recursion).
 * `weight` [0..1] scales how strongly the deltas apply. `source` is the
 * origin for audit ("organ:motion-vision", "noticing", "conscious").
 */
export interface MoodModifier {
  valence?: number;
  arousal?: number;
  dominance?: number;
  /** [0..1] — scales the deltas. */
  weight: number;
  /** Origin label for audit. */
  source: string;
  /**
   * WHO this modifier is about — the person id the declaring organ matched
   * (a face id, a voice id, whatever identity the sensory layer resolved).
   * Purely declarative: the host MAY use it to apply relationship weighting
   * (per-face affinity settings); the declaring organ never knows whether
   * it does. Optional — modifiers about nothing in particular omit it.
   */
  subject?: string;
  /**
   * Embedding of the content that caused this modifier — the source
   * observation, response text, or perception. Tracked by the Mood
   * Organ to derive a mood-direction vector in embedding space (for
   * mood-directed retrieval in reverie). Optional; when absent the
   * modifier still shifts mood but doesn't contribute to the mood
   * embedding.
   */
  sourceEmbedding?: number[];
}

// =============================================================================
// Tier 1 — ambient working stream (flux-working.db)
// =============================================================================

/**
 * An ambient observation produced by the noticing layer after annotating
 * a perception. Lives in the tier-1 store (the separate, rolling,
 * security-footage-style buffer). Most of these dissolve within the
 * retention window; only salience-survivors get promoted to tier 2.
 */
export interface FluxObservation {
  id: string;
  /** ISO timestamp. */
  timestamp: string;
  /** The Sensory Organ whose envelope triggered this observation (the batch's
   * first — the PRIMARY, kept for exact-match query filters). */
  sourceOrganId: string;
  /** FULL provenance: every Sensory Organ that contributed an envelope
   * to the batch this observation narrates (mixed batches are one
   * observation woven from several organs — contextual noticing by
   * design). Absent on rows written before full provenance existed;
   * readers fall back to [sourceOrganId]. */
  sourceOrganIds?: string[];
  /** My first-person annotation of the perception. */
  content: string;
  /** Salience score [0..1] assigned by the noticing layer. */
  salience: number;
  /** 384-dim embedding of the content (from the shared embedder). */
  embedding?: number[];
  /** Tags from the noticing layer. */
  tags: string[];
  /** Whether this was promoted to tier 2. */
  promoted: boolean;
}

// =============================================================================
// Tier 2 — durable + promoted (shared psycheros.db, flux-owned tables)
// =============================================================================

/** Role of a Flux Space durable-stream entry on the timeline. */
export type FluxEntryRole = "user" | "entity" | "ambient";

/**
 * A durable stream entry — the relational record of the Flux Space.
 * Durable (role "user" and "entity") entries are permanent, like classic
 * conversation messages; ambient entries are the promoted observations
 * and thoughtstream summaries that surfaced on the timeline.
 */
export interface FluxDurableEntry {
  id: string;
  /** ISO timestamp. */
  timestamp: string;
  role: FluxEntryRole;
  content: string;
  /** For ambient entries promoted from tier 1, links back to the observation. */
  sourceObservationId?: string;
  /** For thoughtstream summaries, the classic conversation they summarize. */
  sourceConversationId?: string;
  /** Optional structured metadata (e.g. salience, organ, promotion reason). */
  metadata?: Record<string, unknown>;
}

/**
 * A promoted observation that survived the promotion filter. Kept as a
 * distinct record from the durable entry so the promotion decision and
 * its reason are queryable independently of the timeline view.
 */
export interface FluxPromotedObservation {
  id: string;
  /** ISO timestamp. */
  timestamp: string;
  /** The tier-1 observation this was promoted from. */
  originalObservationId: string;
  content: string;
  salience: number;
  /** Why the promotion filter let this through (amplitude/relevance/corroboration). */
  promotionReason: string;
}

// =============================================================================
// Flux state snapshot — what the SA formatter and driver consume
// =============================================================================

/** A salient observation surfaced in the snapshot. */
export interface FluxSalientItem {
  content: string;
  salience: number;
  organId: string;
  /** ISO timestamp. */
  timestamp: string;
}

/**
 * A point-in-time snapshot of the Flux Space, consumed by the SA
 * formatter (so the Ego model sees my ambient state during a classic
 * conversation) and by the continuous driver (to decide what to do next).
 */
export interface FluxStateSnapshot {
  /** Whether flux is active and running. */
  active: boolean;
  /** Count of tier-1 observations in the last hour (for UI/debug, not SA). */
  recentObservationCount: number;
  /** Highest-salience observations from the recent window (for UI/debug, not SA). */
  topSalient: FluxSalientItem[];
  /** Whether I have unsaid ambient thoughts queued (for UI/debug, not SA). */
  hasPendingThoughts: boolean;
  /** Brief first-person digest of recent Flux Space activity. */
  digest: string;
  /** Rendered current mood state from the Mood Organ. */
  mood?: string;
  /** Latest compaction texture summary — the compressed felt quality of the recent past. */
  texture?: string;
  /** Most recent observation's content — what's happening right now (SA presence). */
  presence?: string;
}

// =============================================================================
// Promotion filter
// =============================================================================

/**
 * Thresholds for the promotion filter — the load-bearing narrow waist
 * that decides which tier-1 observations survive into tier 2 and which
 * escalate to the Ego model. Does triple duty: quality control,
 * attention, and defense (memo-injection / slow-bias resistance via
 * corroboration). All knobs are configurable via FluxSettings.
 */
export interface PromotionThresholds {
  /** Minimum noticing-layer salience to be considered [0..1]. Default 0.5. */
  salience: number;
  /**
   * Minimum cosine similarity to the current focus embedding to pass
   * relevance. Default 0.3.
   */
  relevance: number;
  /**
   * Cosine similarity at or above which a nearby observation counts as
   * corroboration. Default 0.6.
   */
  corroboration: number;
  /** Combined weighted score required to promote. Default 0.5. */
  combined: number;
  /** Combined score required to actively escalate to the Ego model. Default 0.75. */
  escalation: number;
  /** Window in ms for corroboration lookback. Default 300_000 (5 min). */
  corroborationWindowMs: number;
}

/** Outcome of running the promotion filter over a batch of observations. */
export interface PromotionResult {
  /** Observations that survived, with their combined scores and reasons. */
  promoted: Array<{
    observation: FluxObservation;
    combinedScore: number;
    reason: string;
  }>;
  /** The highest-scoring promotion, if any, that should actively wake the Ego model. */
  escalateToEgo?: {
    observation: FluxObservation;
    combinedScore: number;
    reason: string;
  };
}

// =============================================================================
// Organs
// =============================================================================

/**
 * The sink every Sensory Organ emits envelopes through — the host's
 * ingest entry (FluxManager.ingestEnvelope). One function is the whole
 * out-of-the-organ seam.
 */
export type EnvelopeSink = (
  envelope: OrganEnvelope,
) => void | Promise<void>;

/** Configuration for a Sensory Organ. */
export interface OrganConfig {
  /** Unique Sensory Organ id, e.g. "motion-vision". */
  id: string;
  /** Cadence in milliseconds between signal emissions. */
  tickIntervalMs: number;
  /** Whether this Sensory Organ is enabled. */
  enabled: boolean;
  /**
   * OPTIONAL health-probe URL, self-declared by the Sensory Organ (the
   * Thalamus's monitor pings it — USB-flavored liveness, never asked of
   * the organ itself). Motion-vision points this at its model server's
   * /models; senses without an HTTP surface omit it. Declared here, by
   * the organ, so no registration-site code needs to know which organ
   * is which.
   */
  healthProbeUrl?: string | null;
}

/**
 * One field in a Sensory Organ's settings descriptor (the uniform
 * declaration shipped and plugin senses both use — the Settings UI
 * renders cards from it). `select` requires `options`.
 */
export interface SensoryOrganSettingField {
  key: string;
  label: string;
  type: "text" | "number" | "toggle" | "select";
  default?: unknown;
  options?: Array<{ value: string; label: string }>;
  help?: string;
}

/** The context every Sensory Organ factory receives besides the sink. */
export interface SensoryOrganFactoryContext {
  /** The daemon's data root — state files belong under `.psycheros/`. */
  dataRoot: string;
  /**
   * This sense's setting values (descriptor defaults merged under
   * whatever was saved in flux-settings.json's sensoryOrganSettings
   * bag). Restart-to-apply, same as every other flux setting.
   */
  settings: Record<string, unknown>;
}

/**
 * A Sensory Organ unit: sensor + local processor (specialist model) + escalation
 * logic. Each organ owns its perception.data schema; the envelope is the
 * shared contract. Organs are started and stopped with the FluxManager
 * lifecycle.
 */
export interface Organ {
  config: OrganConfig;
  /** Called on each tick; produce an envelope or null (null = nothing to report). */
  tick(): Promise<OrganEnvelope | null>;
  /** Start the Sensory Organ's internal timer or signal source. */
  start(): void;
  /** Stop the Sensory Organ. */
  stop(): void;
}

/**
 * The SENSORY Organ contract — what the Thalamus routes to. Organs
 * exist throughout Flux (Noticing/Musing/Reverie's model calls are
 * organs in the ranked sense), but only Sensory Organs are sensate and
 * only they receive modulation: these inlets extend the sensory
 * contract specifically, not the Organ interface. The Thalamus's
 * registry holds Sensory Organ capabilities and resolves
 * conscious-layer instructions against them.
 */
export interface SensoryOrgan extends Organ {
  /**
   * OPTIONAL modulation inlet (the Thalamus's down-chain): a semantic
   * directive that alters what the Sensory Organ perceives — e.g. "specifically
   * watch for a blue Subaru" rides into a vision organ's perception
   * model. Pure sensors omit this; the Thalamus registry marks them
   * non-directable and conscious-layer attention falls back to
   * content-directed scoring.
   */
  receiveDirective?(text: string): void;
  /**
   * OPTIONAL classic control inlet: typed key/value commands for organs
   * with knobs (thresholds, fps, volume — setVolume(5)-style).
   */
  applyControl?(key: string, value: unknown): void;
}

// =============================================================================
// Loop session state
// =============================================================================

/**
 * The continuous-presence loop's current session state.
 * - "ambient" — loop is ticking (promotion, ambient speech, compaction, etc.)
 * - "user_turn" — paused while EntityTurn processes a user message
 * - "ego_wake" — an Ego wake (from escalation) is in progress
 */
export type LoopSessionState = "ambient" | "user_turn" | "ego_wake";

/** The injected embedder contract (defined in runtime.ts — re-exported
 * here so Sensory Organs import ONLY the contract file, never Flux
 * runtime modules). */
export type { EmbedFn } from "./runtime.ts";
