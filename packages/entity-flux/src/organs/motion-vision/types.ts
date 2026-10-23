/**
 * Motion-Vision organ — type definitions.
 *
 * This is the first real Sensory Organ: a webcam-based vision system that
 * captures frames on a cadence, detects motion locally (cheap reflex arc),
 * and runs a vision-language model on bursts of frames to produce scene
 * descriptions. The structure follows the three-part Sensory Organ template
 * (Perception / Processing / Response) documented in
 * `packages/entity-flux/docs/sensory-organ-template.md`.
 *
 * The Sensory Organ is self-contained: it emits `OrganEnvelope` events via the sink
 * and writes a standalone caption file. It knows nothing about the noticing
 * layer, the promotion filter, or the Ego model — envelopes out is the whole
 * seam.
 */

import type { OrganConfig } from "../../types.ts";
import type { EmbedFn } from "../../types.ts";
import type { SceneBaselineState } from "./scene-baseline.ts";

// =============================================================================
// Perception — captured frames
// =============================================================================

/**
 * A single captured frame from the webcam, as JPEG bytes. The grayscale
 * thumbnail for the motion gate is derived on demand by `jpegToGrayscale`
 * (decoding the JPEG) rather than captured separately — keeps the capture
 * path single-representation. Frames are transient: captured, processed,
 * discarded. Never persisted unless explicitly configured.
 */
export interface MotionVisionFrame {
  /** JPEG bytes, sent to the VLM as base64. */
  jpeg: Uint8Array;
  /** When this frame was captured (ms since epoch). */
  capturedAt: number;
}

// =============================================================================
// Processing — scene understanding result
// =============================================================================

/**
 * The result of running the VLM over a burst of frames — a natural-language
 * description of what happened in the captured window. Produced by the slow
 * path of Processing (scene-describer).
 */
export interface SceneResult {
  /** The VLM's description of the scene / action. */
  description: string;
  /** Which model produced this (e.g. "gemma4:e4b"). */
  model: string;
  /** How many frames were in the burst. */
  frameCount: number;
  /** The span of time the burst covered, in ms. */
  windowMs: number;
}

// =============================================================================
// Organ config + context
// =============================================================================

/**
 * The VLM runtime protocol — OpenAI-compatible chat-completions
 * (llama.cpp server, vLLM, LM Studio, cloud APIs). A saved "ollama"
 * value reads as openai-compatible at composition.
 */
export type ProviderType = "openai-compatible";

/**
 * Configuration for the motion-vision organ. Extends the base `OrganConfig`
 * with the vision-specific knobs (device, model runtime, cadences,
 * thresholds). All fields have defaults via `defaultMotionVisionConfig()` so
 * tests can construct a partial config; the runtime wiring passes values from
 * `FluxSettings`.
 */
export interface MotionVisionOrganConfig extends OrganConfig {
  /**
   * Where frames come from: "server" = the
   * local device below via ffmpeg (the always-on dedicated-machine
   * shape — unchanged behavior, the default); "browser" = a connected
   * app's camera, pushed over the host seam (last-connected app is the
   * single active source).
   */
  source?: "server" | "browser";
  /** Webcam device path (e.g. "/dev/video0") — the "server" source. */
  device: string;
  /** The VLM runtime protocol (openai-compatible). */
  provider: ProviderType;
  /**
   * Base URL of the model server. For Ollama, the root (e.g.
   * "http://localhost:11434"); for OpenAI-compatible, the `/v1` prefix (e.g.
   * "http://192.168.5.212:8080/v1"). The provider appends the endpoint path.
   */
  modelUrl: string;
  /** Model identifier the server expects (e.g. "gemma4:e4b" or "gemma4-26b"). */
  model: string;
  /** Capture rate in frames per second (default 3). */
  captureFps: number;
  /** Rolling buffer window in ms — bursts draw frames from this window (default 3000). */
  burstWindowMs: number;
  /** Motion score at or above which a normal VLM pass fires (default 0.02). */
  motionThreshold: number;
  /** Motion score at or above which an immediate high-amplitude envelope fires (default 0.5). */
  escalationMotionThreshold: number;
  /** Max quiet period in ms before a fresh VLM pass refreshes the caption (default 300000). */
  maxQuietMs: number;
  /** Whether the perception sidecar (person detection + face identity) is
   * consulted. Off = today's behavior exactly (no presence envelopes, no
   * identity in prompts). Default false. */
  perceptionEnabled: boolean;
  /** Base URL of the perception sidecar (default "http://localhost:18085"). */
  perceptionUrl: string;
  /** Detections sustained this long before a track confirms — the arrival
   * event (default 3000; dawn-flicker guard). */
  arrivalDebounceMs: number;
  /** No-detection grace before a track's death is considered (default
   * 6000 — bridges the face-detection cadence at a seated profile, where
   * sightings arrive every ~2s and a 3s grace churns tracks; face loss
   * never kills a track that still sees the person). */
  trackGraceMs: number;
  /** Window within which consecutive motion frames count as SUSTAINED
   * (isolated blips don't reset the departure clock; default 3000). */
  motionSustainMs: number;
  /** Minimum gap between emitted envelopes for CONFORMING captions (the
   * stage hasn't changed; default 30000 — texture cadence). Events,
   * transitions, and reflex spikes emit immediately regardless. */
  familiarEmitGapMs: number;
  /** Capture resolution — the FAT end of the adaptive-burst range and the
   * size the captioner receives on motion-spike (reflex) passes. Frames are
   * always captured at this size; lean passes downscale in-process. Defaults
   * 640×480 (the measured-good baseline). */
  visionWidth: number;
  visionHeight: number;
  /** Adaptive bursts: routine passes caption at the LEAN resolution below
   * (in-process downscale of the fat-captured frames — image tokens ∝
   * pixels, frame COUNT never changes), while motion-spike reflex passes go
   * fat at the full capture resolution. Off = every pass at
   * visionWidth×visionHeight, exactly the pre-adaptive behavior. Default
   * true. */
  adaptiveBursts: boolean;
  /** The LEAN resolution for routine caption passes (leanWidth×leanHeight ≈
   * 44% of 640×480's image-token cost). Defaults 480×360 (detail parity
   * A/B-verified for posture/expression/space). */
  leanWidth: number;
  leanHeight: number;
  /** Audio captioning: attach the mic's last burst-window of audio to
   * caption calls as an `input_audio` block, so the captioner hears the
   * same moments it sees (laughter/shouts/music land in the description).
   * Off = frames-only, exactly as before. Default false. */
  audioCaptioningEnabled: boolean;
  /** ALSA capture device for audio captioning (e.g. "default", "hw:2,0").
   * Default "default". */
  audioDevice: string;
  /**
   * The scene baseline (stage vs actor — change-blindness fix). When on,
   * captions are embedded (via the context's shared embedder) and scored
   * against a calibrated stage: conforming captions quiet down, events stay
   * fresh, sustained change transitions to a recognized/established scene,
   * and the stage text rides into the captioner prompt for
   * delta-captioning. Needs `context.embed`; without it the Sensory Organ falls
   * back to string habituation (slower but functional). Default false —
   * delta-captioning changes caption phrasing, which re-calibrates
   * salience downstream; flip deliberately.
   */
  sceneBaselineEnabled: boolean;
}

/**
 * The factory default config. One source of truth: `FluxSettings` defaults
 * mirror these values, and tests use this to construct partial configs.
 */
export function defaultMotionVisionConfig(): MotionVisionOrganConfig {
  return {
    id: "motion-vision",
    tickIntervalMs: 2_000,
    enabled: true,
    device: "/dev/video0",
    provider: "openai-compatible",
    modelUrl: "http://localhost:8080/v1",
    model: "gemma4:e4b",
    captureFps: 3,
    burstWindowMs: 3_000,
    motionThreshold: 0.02,
    escalationMotionThreshold: 0.5,
    maxQuietMs: 300_000,
    perceptionEnabled: false,
    perceptionUrl: "http://localhost:18085",
    arrivalDebounceMs: 3_000,
    trackGraceMs: 6_000,
    motionSustainMs: 3_000,
    audioCaptioningEnabled: false,
    audioDevice: "default",
    visionWidth: 640,
    visionHeight: 480,
    adaptiveBursts: true,
    leanWidth: 480,
    leanHeight: 360,
    familiarEmitGapMs: 30_000,
    sceneBaselineEnabled: false,
  };
}

/**
 * Injected context the Sensory Organ may consult. Kept minimal and fully optional so
 * the Sensory Organ runs standalone in tests. Reserved for future wiring.
 */
export interface MotionVisionContext {
  /**
   * Data root for the state file (`${dataRoot}/.psycheros/organ-state/motion-vision.json`).
   * The runtime wiring passes this from server deps. When absent (e.g. tests),
   * state-file reads/writes are skipped — the Sensory Organ still emits envelopes, it
   * just doesn't publish a presence file.
   */
  dataRoot?: string;
  /**
   * Test injection seam for classical perception. When present, the Sensory Organ uses
   * this client instead of constructing `HttpPerceptionClient` from config —
   * tests drive occupancy/identity transitions through `gate()` with a fake.
   * The runtime wiring leaves it undefined.
   */
  perceptionClient?: PerceptionClient;
  /**
   * The host's shared embedder (the same singleton the promotion filter and
   * mood embedding use — one embedding space everywhere). The scene baseline
   * embeds captions through it. Optional: without it (standalone organ,
   * minimal tests) the baseline stays off and the Sensory Organ falls back to
   * string-comparison habituation.
   */
  embed?: EmbedFn;
  /**
   * Optional organ-specific perceptual directive — a concrete target like
   * "flag blue Subarus." Deliberately NOT the noticing layer's
   * `getAttentionDirective` (which is abstract, relationship-level prose for
   * the small model). Different animals. When present, the scene-describer
   * appends it to the VLM prompt so the model knows what to flag.
   *
   * Unwired in v1 — how organ directives get populated (file, tool, UI) is an
   * open thread documented in `sensory-organ-template.md`.
   */
  getDirective?: () => string | null;
}

// =============================================================================
// State file — presence (read, not pushed)
// =============================================================================

/**
 * The shape of `.psycheros/organ-state/motion-vision.json`. Always-current
 * caption + metadata, written on every VLM result and read on startup to
 * pre-populate. Standalone artifact — Flux-side consumption of this file is
 * out of scope for this build; my job is to produce it.
 */
export interface MotionVisionState {
  /** Human-readable caption, prefixed with the noticing layer's weekday+time format. */
  caption: string;
  /** ISO timestamp of when the caption was generated, for staleness checks. */
  timestamp: string;
  /** Which model produced this caption. */
  model: string;
  /** Motion score at capture time. */
  motionScore: number;
  /** Presence layer (occupancy + identity), when the perception sidecar is
   * enabled. Restored on startup so a daemon restart doesn't emit a spurious
   * arrival. */
  presence?: PresenceStateFile;
  /** Perception sidecar availability, for debugging. */
  perception?: { available: boolean; lastOkAt?: string };
  /**
   * The scene baseline slice (stage ring + novelty stats), when enabled.
   * Restored on startup so a restart doesn't relearn the room.
   */
  scene?: SceneBaselineState;
}

/**
 * The persisted slice of the presence machines. Times are ISO strings;
 * `identities` keeps only what a fresh start needs (visibility + last seen).
 */
export interface PresenceStateFile {
  /** Derived occupancy state ("unknown" before any track ever confirmed). */
  state: "unknown" | "occupied" | "empty";
  /** Confirmed-track count at last observation (informational). */
  peopleCount?: number;
  /** First named track's identity and confidence (informational). */
  identity?: string | null;
  identityConfidence?: number | null;
  /** ISO timestamp of the named track's birth. */
  since?: string;
  /** ISO timestamp of the named identity's last face sighting. */
  lastSeenAt?: string;
  /** The tracker's live tracks — what actually restores. */
  tracks?: Array<{
    tid: number;
    identity: string | null;
    bornAt: string;
  }>;
}

// =============================================================================
// Reserved interfaces — deferred to future phases
// =============================================================================

/**
 * A discrete actuator command — a one-shot action on the Sensory Organ's actuator
 * (e.g. "pan camera to X"). Reserved for future actuators (motorized mount).
 * v1 defines the shape; nothing drives it yet. Folded into Response rather
 * than a separate component: an actuator is just a Response that acts on the
 * organ's own hardware.
 */
export interface ActuatorCommand {
  /** The actuator kind (e.g. "pan", "tilt", "set_exposure"). */
  kind: string;
  /** Command payload (actuator-specific). */
  params: Record<string, unknown>;
}

/**
 * The perception sidecar's answer for one frame: how many people are visible
 * (bodies — the stable presence layer) and which registered faces matched
 * (identity). Produced by the sidecar's classical models (person detector +
 * face embedder), consumed by the presence machines and the scene prompt.
 */
/** Axis-aligned box: [x1, y1, x2, y2] in source-image pixels. */
export type Box = [number, number, number, number];

export interface PerceptionResult {
  /** Bodies counted by the person detector; boxes when the sidecar sent
   * them (it always does) — the tracker's geometric substrate. */
  people: { count: number; boxes?: Box[] };
  /** Matched faces only — an unmatched person is visible as
   * `people.count > faces.length` ("present, identity unknown"), never a
   * fake "unknown" id. Face boxes ride along for body-association. */
  faces: Array<{ id: string; confidence: number; box?: Box }>;
}

/**
 * The Sensory Organ's seam to classical perception (person detection + face
 * identity), served by the shared perception sidecar. `perceive` returns
 * null on any failure — the caller treats null as blindness (hold state),
 * never as an empty room. Evolves the reserved `FaceRecognizer` seam:
 * presence needed bodies as well as names.
 */
export interface PerceptionClient {
  /** Perceive one frame; null = unreachable/failed. */
  perceive(frame: MotionVisionFrame): Promise<PerceptionResult | null>;
}
