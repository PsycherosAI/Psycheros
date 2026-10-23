/**
 * Flux settings persistence.
 *
 * Stored at `.psycheros/flux-settings.json`. Follows the voice-settings
 * pattern: interface + defaults + load (merges saved over defaults) +
 * save. No API-key masking — flux reuses existing LLM profiles for its
 * small model rather than holding credentials of its own.
 *
 * The master flag is `enabled`, defaulting to false. When off, the host
 * (Psycheros) must not touch any flux table, route, organ, or SA section
 * — baseline behavior is unchanged.
 */

import { join } from "@std/path";
// The host's data-layout convention (leaf import — the folder name is
// host policy, spelled out in one place).
import { psycherosDir } from "../../psycheros/src/utils/paths.ts";
import type { PromotionThresholds } from "./types.ts";
import type { SensoryMode } from "./situation.ts";

// =============================================================================
// Settings interface
// =============================================================================

/**
 * Configuration for the entity-flux subsystem. Every cadence and
 * threshold lives here rather than hardcoded so the user can tune the
 * nervous system to their hardware and their entity.
 */
export interface FluxSettings {
  /**
   * Master feature flag. When false, the entire flux subsystem is
   * disabled — no organs run, no driver ticks, no SA injection, no
   * routes. Baseline Psycheros behavior is unchanged.
   */
  enabled: boolean;

  /**
   * The LLM profile flux borrows from. The profile's main model is the
   * Ego model (deep cognition turns); its worker model is the small
   * noticing model. When null, flux uses the active LLM profile. Set to
   * a profile ID to dedicate a profile to flux (e.g. a local Gemma
   * endpoint whose main = small fast model, or a separate cloud key).
   */
  profileId: string | null;

  /**
   * A brief shorthand identity for the noticing layer — who I am, who
   * my user is, our relationship. NOT the full identity files (those
   * are for the Ego model); just enough context for the small model
   * to understand whose presence it's observing and why it cares.
   * Example: "I am Psycheros and my user is my partner. We are good friends."
   * Optional — when absent, the noticing layer runs without this context.
   */
  shorthandIdentity?: string;

  /**
   * Tier-1 retention in days. The ambient working stream ages out
   * observations older than this. Default 7 ("security footage"
   * lookback window). Lower for constrained storage.
   */
  retentionDays: number;

  /**
   * @deprecated Use `baseTickMs` instead. Kept for backward compatibility;
   * migrated to `baseTickMs` in `normalizeFluxSettings`.
   */
  driverTickMs: number;

  /**
   * Base tick interval for the adaptive loop, in ms. The loop recomputes
   * the actual delay each cycle based on mood arousal and activity.
   * Default 3000.
   */
  baseTickMs: number;

  /** Minimum tick interval (fastest — active conversation, high arousal). Default 1000. */
  minTickMs: number;

  /** Maximum tick interval (slowest — deep quiet). Default 30000. */
  maxTickMs: number;

  /** How much mood arousal scales tick rate [0..1]. 0.3 = arousal ±1 changes delay by 30%. Default 0.3. */
  arousalInfluence: number;

  /** Time since last organ event before entering quiet slowdown, in ms. Default 300000 (5 min). */
  quietThresholdMs: number;

  /**
   * Mood Organ decay rate constant (per second). Mood decays toward
   * neutral exponentially; lower = slower fade, higher = mood evaporates
   * fast. Default 0.005 (~2-minute half-life). Multi-timescale decay
   * (separate rates for startle / mood / temperament) is a future
   * refinement.
   */
  moodDecayPerSec: number;

  /**
   * Baseline drift rate (per second). The baseline is an EMA of recent
   * mood state — the entity's adaptive emotional home. Lower = more
   * stable, higher = baseline moves more readily with experience.
   * Default 0.0001 (~2-hour half-life).
   */
  baselineDriftPerSec: number;

  /** Small-model ambient speech cadence in ms. Default 120_000 (2 min). */
  ambientSpeechMs: number;

  /** Thoughtstream pull cadence in ms. Default 600_000 (10 min). */
  thoughtstreamMs: number;

  /**
   * Short-horizon compaction cadence in ms. The noticing layer's recent
   * observations are compressed into a first-person texture summary on
   * this interval, giving the small model a rolling context. Default
   * 900_000 (15 min).
   */
  compactionCadenceMs: number;

  /**
   * Longform compaction cadence in ms. A broader texture summary covering
   * the last hour (or whatever this is set to). Gives the small model a
   * sense of the bigger arc, not just the last 15 minutes. Default
   * 3_600_000 (1 hour).
   */
  longformCompactionCadenceMs: number;

  /**
   * Reverie cadence in ms — the minimum gap between internally-generated
   * stimulation passes. Reverie is the mind's Default Mode Network
   * analogue: mind-wandering, spontaneous memory surfacing, creative
   * connections, and initiative. The DMN is always running; it
   * modulates with external activity but isn't gated by it. The model
   * self-regulates from its context. Default 180_000 (3 min).
   */
  reverieCadenceMs: number;

  /**
   * Dream pace in ms — the BASE interval between dream fragments while
   * sleeping. The live interval scales with
   * arousal: a calm interior stretches toward 1.5× (deeper sleep), a
   * worked-up one quickens toward 0.5× (shorter, hotter cycles). No
   * hard clamps — mood is the only dial. Default 600_000 (10 min).
   */
  dreamPaceMs: number;

  /**
   * Universal cap on text length fed to mood classification (chars),
   * applied at the classifyMood dispatch point BEFORE the injected
   * classifier sees it. Protects any classifier implementation from
   * unbounded input; the head of a message carries its emotional read.
   * Default 2000 (~500 English tokens — sized for the bundled
   * GoEmotions classifier's 514-position window). If you swap in a
   * longer-context classifier, raise this to match its window; set 0 to
   * disable the cap entirely.
   */
  moodClassifierMaxChars?: number;
  /** Mood classifier variant: int8 default
   *  (110MB, 2-2.6x faster, ~0.02 organ-delta drift); fp32 for exact
   *  lineage. Applies to the downloaded-model path. */
  moodClassifierVariant?: "int8" | "fp32";
  /** The HuggingFace repo hosting our vad-bert exports — "{variant}/"
   *  subdirectories (int8/, fp32/), each a transformers.js layout
   *  (config/tokenizer at root, onnx/model.onnx). Empty = downloader
   *  disabled (fresh installs run the worker-LLM fallback). NEVER
   *  guess this; the owner sets it to the real repo. */
  moodClassifierRepoId?: string;

  /**
   * Dream fragments per sleep cycle. A
   * placeholder body parameter, tunable per entity — every
   * Nth fragment closes the cycle (light moment + fresh dream with a
   * faded carry). Default 7 (the middle of the 6–8 band).
   */
  dreamCycleFragments: number;

  /** Promotion filter thresholds. */
  promotionThresholds: PromotionThresholds;

  /** Enabled Sensory Organ IDs. */
  enabledOrgans: string[];

  /**
   * Saved values for out-of-tree Sensory Organ plugins:
   * `{ "<organId>": { "<key>": value } }`. The
   * shape of each plugin's fields is declared by the plugin module
   * itself (`sensoryOrganSettings` export); this bag is values only —
   * hand-editing the settings file and the Settings UI write the same
   * place. Values reach the plugin as `context.settings` at composition
   * (restart-to-apply, like every other flux setting).
   */
  sensoryOrganSettings?: Record<string, Record<string, unknown>>;

  /**
   * The configured sensory modes for situation detection.
   * Modes are data, never code — this list is what
   * classifiers score against. Absent = the default set (ordinary,
   * sleep, absent, intimate).
   */
  sensoryModes?: SensoryMode[];

  /**
   * URL of the situation-detection classifier service.
   * Absent/empty = situation detection is inert —
   * the shipping-safe default. The service contract: POST JSON
   * {"text": digest} → {"scores": {modeName: number}}.
   */
  situationClassifierUrl?: string;

  /**
   * system-state Sensory Organ values live in the
   * `sensoryOrganSettings["system-state"]` bag; migrated automatically
   * in `normalizeFluxSettings`.
   */

  /**
   * Per-job model hookups. Each LLM-calling
   * Subconscious job can name its own model runtime; jobs without an
   * entry fall back to the shared profile (today's behavior). The
   * settings file is gitignored (`.psycheros/`), so URLs and API keys
   * here stay off any remote — same protection as every other
   * credential the daemon stores.
   */
  modelHookups?: Partial<Record<FluxModelJob, ModelHookup>>;

  // -------------------------------------------------------------------------
  // Thalamus (the Sensory subsystem's router). The slot is the MAXIMUM
  // wait between noticing calls — the resource knob, not a rate limiter
  // for the timeline. Many calls are fine; unmanageable inference load
  // is not. Defaults tuned for responsiveness; adjust to hardware or
  // cloud-finances.
  // -------------------------------------------------------------------------

  /** Noticing slot interval in ms — max wait before a non-empty batch
   * flushes. Default 3000 (near-real-time narration). */
  thalamusSlotMs?: number;
  /** Early-flush when pending importance mass crosses this. Default 1.6. */
  thalamusFlushMass?: number;
  /** Reflex amplitude threshold — passes and flushes unconditionally. Default 0.7. */
  thalamusReflexThreshold?: number;
  /** Hold cooldown: similar envelopes from a Sensory Organ held this long after
   * its last pass. Default 60000. */
  thalamusHoldCooldownMs?: number;

  /**
   * Familiarity (self-regulation): the recent-expression
   * pool behind habituation (novelty × salience on interior wakes) and
   * satiation (wake candidates clear novelty). Novelty is a RATIO
   * against the pool's own internal density — no fixed cosine band can
   * separate same-riff from unrelated text with this embedder. All
   * optional — defaults live in familiarity.ts's
   * DEFAULT_FAMILIARITY_CONFIG.
   */
  /** Pool half-life. Default 45 min — a topic re-earns salience as its
   * familiarity decays. */
  familiarityHalfLifeMs?: number;
  /** Top-k nearest pool entries forming the candidate's score. Default 3. */
  familiarityTopK?: number;
  /** Damping begins at this × pool density. Default 1.3. */
  familiarityRatioThreshold?: number;
  /** Damping completes at this × pool density. Default 1.7. */
  familiarityFullRatio?: number;
  /** Live pool cap (lowest-weight evicted). Default 64. */
  familiarityMaxEntries?: number;
  /** Below this many entries the pool can't judge — all novel. Default 4. */
  familiarityMinPoolSize?: number;

  // -------------------------------------------------------------------------
  // Sensory Organ values — shipped and plugin senses alike ride the
  // `sensoryOrganSettings` bag, keyed by organ id. Motion-vision's ~20
  // legacy root fields
  // (visionDevice, visionModelUrl, perception*, …) and system-state's
  // two (systemStateSshTarget, systemStateProbeMs) are migrated there
  // automatically in `normalizeFluxSettings`. Field shapes are declared
  // by each Sensory Organ (`motionVisionSettingsFields`,
  // `systemStateSettingsFields` — the Settings UI renders from them).
  // -------------------------------------------------------------------------

  /**
   * Per-person relationship weighting for declared mood modifiers —
   * face/voice id → affinity in [-1..+1]. The host scales the CONNECTION
   * component of any modifier whose `subject` matches (factor = 1 +
   * affinity, clamped [0..2]): +1 doubles a welcome, -1 nulls it. Unset
   * subjects pass through unchanged — affinity is opt-in, never a
   * surprise. Ids are whatever the perception layer enrolled (the faces/
   * directory names). Manual (file-edited) for now; entity-settable is
   * the eventual direction. Default {}.
   */
  faceAffinity?: Record<string, number>;
}

/** The LLM-calling jobs that can carry their own model hookup. Dreams
 * ride the `reverie` hookup — they are a function of reverie, not a
 * separate job. */
export type FluxModelJob =
  | "noticing"
  | "musing"
  | "reverie"
  | "compaction"
  | "mood-organ";

/**
 * One job's model runtime. `url` is a full chat-completions endpoint
 * (e.g. "http://localhost:8080/v1/chat/completions" or a gateway route).
 * `apiKey` is optional — local servers don't need one. `params` are
 * merged into the request (temperature etc.) and are per-job on purpose:
 * a job isn't just "where's the model," it's "how hot does this model
 * run for this job." `thinkingEnabled` defaults to FALSE — Gemma-family
 * models spend their whole budget on reasoning_content otherwise and
 * return empty content; flip it only for models whose visible answer
 * depends on thinking.
 */
export interface ModelHookup {
  url: string;
  model: string;
  apiKey?: string;
  /** Allow reasoning/thinking tokens (default false — see above). */
  thinkingEnabled?: boolean;
  params?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    max_tokens?: number;
  };
}

// =============================================================================
// Defaults
// =============================================================================

/**
 * Default promotion thresholds — the starting tuning for the narrow
 * waist. Adjust via FluxSettings once there's real observation data to
 * tune against.
 */
export function getDefaultPromotionThresholds(): PromotionThresholds {
  return {
    salience: 0.5,
    relevance: 0.3,
    corroboration: 0.6,
    combined: 0.5,
    // 0.70 — the graded-damping bar. At 0.75 the near-novel cluster
    // dies by hundredths (0.72, 0.73 observed); 0.70 passes them —
    // engagement bids wake at factor ≥ ~0.78.
    escalation: 0.70,
    corroborationWindowMs: 300_000, // 5 minutes
  };
}

/**
 * Default flux settings. `enabled: false` is load-bearing — opt-in is
 * the contract with baseline Psycheros.
 */
export function getDefaultFluxSettings(): FluxSettings {
  return {
    enabled: false,
    profileId: null,
    retentionDays: 7,
    driverTickMs: 3_000,
    baseTickMs: 3_000,
    minTickMs: 1_000,
    maxTickMs: 30_000,
    arousalInfluence: 0.3,
    quietThresholdMs: 300_000,
    // moodDecayPerSec is the FADE toward neutral (era timescale —
    // feelings let go over hours); baselineDriftPerSec is the Lately
    // window rate (see mood-organ.ts).
    moodDecayPerSec: 0.0001,
    baselineDriftPerSec: 0.0001,
    ambientSpeechMs: 120_000,
    thoughtstreamMs: 600_000,
    compactionCadenceMs: 900_000,
    longformCompactionCadenceMs: 3_600_000,
    reverieCadenceMs: 180_000,
    dreamPaceMs: 600_000,
    moodClassifierMaxChars: 2000,
    moodClassifierVariant: "int8",
    // The product's fetch source — the owner's public repo, full tree
    // hosted.
    moodClassifierRepoId: "Psycheros/vad-bert",
    dreamCycleFragments: 7,
    promotionThresholds: getDefaultPromotionThresholds(),
    enabledOrgans: [],
    // Thalamus defaults — the slot is the resource knob (max wait, NOT
    // a timeline rate limiter): 3s keeps near-real-time narration.
    thalamusSlotMs: 3_000,
    thalamusFlushMass: 1.6,
    thalamusReflexThreshold: 0.7,
    thalamusHoldCooldownMs: 60_000,
    // Shipped Sensory Organ values ride the sensoryOrganSettings bag —
    // defaults are declared by each organ's settings descriptor
    // (motionVisionSettingsFields / systemStateSettingsFields), not here.
    faceAffinity: {},
  };
}

/**
 * Normalize a partial settings object against defaults so newly-added
 * fields get filled in from older persisted settings. Also normalizes
 * the promotion thresholds sub-object.
 */
export function normalizeFluxSettings(
  saved: Partial<FluxSettings>,
): FluxSettings {
  const defaults = getDefaultFluxSettings();
  const savedThresholds = saved.promotionThresholds ?? {};
  // Migrate the old field name (early PoC) to the unified profileId.
  const profileId = saved.profileId ??
    (saved as { smallModelProfileId?: string | null }).smallModelProfileId ??
    null;
  // Migrate old driverTickMs → baseTickMs if baseTickMs isn't set.
  const baseTickMs = saved.baseTickMs ?? saved.driverTickMs ??
    defaults.baseTickMs;
  // Migrate legacy root Sensory-Organ fields into the settings bag
  // (motion-vision's ~20, system-state's two): moved verbatim when the
  // bag doesn't already carry an entry for that sense. Only fields the
  // file actually has move — descriptor defaults fill the rest at
  // composition.
  const legacy = saved as Partial<FluxSettings> & Record<string, unknown>;
  const bag: Record<string, Record<string, unknown>> = {
    ...(typeof saved.sensoryOrganSettings === "object" &&
        saved.sensoryOrganSettings !== null
      ? saved.sensoryOrganSettings
      : {}),
  };
  const MOTION_VISION_LEGACY_KEYS = [
    "visionDevice",
    "visionProvider",
    "visionModelUrl",
    "visionModel",
    "visionCadenceMs",
    "captureFps",
    "burstWindowMs",
    "motionThreshold",
    "escalationMotionThreshold",
    "maxQuietMs",
    "perceptionEnabled",
    "perceptionUrl",
    "arrivalDebounceMs",
    "trackGraceMs",
    "audioCaptioningEnabled",
    "audioDevice",
    "visionWidth",
    "visionHeight",
    "adaptiveBursts",
    "leanWidth",
    "leanHeight",
    "sceneBaselineEnabled",
  ];
  if (!bag["motion-vision"]) {
    const moved = Object.fromEntries(
      MOTION_VISION_LEGACY_KEYS.filter((k) => legacy[k] !== undefined)
        .map((k) => [k, legacy[k]]),
    );
    if (Object.keys(moved).length > 0) bag["motion-vision"] = moved;
  }
  if (!bag["system-state"]) {
    const moved: Record<string, unknown> = {};
    if (legacy.systemStateSshTarget !== undefined) {
      moved.systemStateSshTarget = legacy.systemStateSshTarget;
    }
    if (legacy.systemStateProbeMs !== undefined) {
      moved.systemStateProbeMs = legacy.systemStateProbeMs;
    }
    if (Object.keys(moved).length > 0) bag["system-state"] = moved;
  }
  const result: FluxSettings = {
    ...defaults,
    ...saved,
    profileId,
    baseTickMs,
    // Mood-classifier provisioning: variant validates to the two
    // hosted exports; repo id is the owner's to set (never a guess) —
    // anything non-string reads as "downloader off".
    moodClassifierVariant: saved.moodClassifierVariant === "fp32"
      ? "fp32"
      : "int8",
    // Absent OR empty falls back to the committed default — the
    // bug-written "" of broken upgrades persists in files, so empty is
    // not a meaningful "off" for this field; the id only gates the
    // download button. A real value passes through trimmed.
    moodClassifierRepoId: typeof saved.moodClassifierRepoId === "string" &&
        saved.moodClassifierRepoId.trim() !== ""
      ? saved.moodClassifierRepoId.trim()
      : defaults.moodClassifierRepoId,
    // Merge threshold sub-object field-by-field so a partial override
    // doesn't drop the defaults for unmentioned fields.
    promotionThresholds: {
      ...defaults.promotionThresholds,
      ...savedThresholds,
    },
    enabledOrgans: (saved.enabledOrgans ?? defaults.enabledOrgans)
      // synthetic-test is retired — strip it from saved lists so it
      // never ghosts around.
      .filter((id) => id !== "synthetic-test"),
    // Sensory Organ setting values (shipped and plugin alike) pass
    // through with the legacy migration applied — the field shape is
    // organ-declared, so normalization is existence-only beyond that.
    sensoryOrganSettings: bag,
    // Configured modes pass through verbatim — mode shape is the
    // classifier's contract, not the settings' business.
    sensoryModes: Array.isArray(saved.sensoryModes)
      ? saved.sensoryModes
      : undefined,
    situationClassifierUrl: saved.situationClassifierUrl?.trim() || undefined,
  };
  // Drop the migrated legacy keys — the spread above still carries them
  // when the file predates the bag.
  for (
    const k of [
      ...MOTION_VISION_LEGACY_KEYS,
      "systemStateSshTarget",
      "systemStateProbeMs",
    ]
  ) {
    delete (result as unknown as Record<string, unknown>)[k];
  }
  return result;
}

// =============================================================================
// Load / Save
// =============================================================================

/**
 * Load flux settings from disk, merged over defaults. Returns defaults
 * if the file is missing or unreadable — flux starts disabled in that
 * case, which is the safe baseline.
 */
export async function loadFluxSettings(
  dataRoot: string,
): Promise<FluxSettings> {
  const settingsPath = join(
    psycherosDir(dataRoot),
    "flux-settings.json",
  );

  try {
    const text = await Deno.readTextFile(settingsPath);
    const saved = JSON.parse(text) as Partial<FluxSettings>;
    return normalizeFluxSettings(saved);
  } catch {
    return getDefaultFluxSettings();
  }
}

/**
 * Save flux settings to disk. Writes to `.psycheros/flux-settings.json`,
 * creating the directory if needed. Returns the normalized settings
 * actually persisted.
 */
export async function saveFluxSettings(
  dataRoot: string,
  settings: FluxSettings,
): Promise<FluxSettings> {
  const settingsDir = psycherosDir(dataRoot);
  const settingsPath = join(settingsDir, "flux-settings.json");

  await Deno.mkdir(settingsDir, { recursive: true });

  const normalized = normalizeFluxSettings(settings);

  await Deno.writeTextFile(
    settingsPath,
    JSON.stringify(normalized, null, 2) + "\n",
  );

  return normalized;
}
