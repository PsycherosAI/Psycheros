/**
 * Motion-Vision organ — Response layer.
 *
 * Where motion + scene become a signal. I hold the helpers that:
 * - decide amplitude from motion (with habituation decay on repeat),
 * - package a perception into an `OrganEnvelope` (propagate),
 * - read/write the always-current caption state file.
 *
 * Response is the third part of the Sensory Organ template. It owns two emit
 * paths (immediate-escalation on a motion spike, fresh-caption on normal
 * motion) plus the always-on state file. Habituation applies to event
 * amplitudes only — the state file is always updated regardless, so presence
 * never goes "blind" from habituation.
 *
 * Reserved slots (directive, actuator) live in `MotionVisionContext`; they're
 * unwired in v1 but the shape is here so future phases drop in cleanly.
 */

import { join } from "@std/path";
// The host's data-layout convention (leaf import — one home for the name).
import { psycherosDir } from "../../../../psycheros/src/utils/paths.ts";
import type { MotionVisionState, SceneResult } from "./types.ts";
import type { OrganEnvelope, Perception } from "../../types.ts";

/** Perception type label for vision-sourced envelopes. */
const PERCEPTION_TYPE = "motion-vision_scene";

/**
 * Format a timestamp the same way the noticing layer does — weekday + time,
 * en-US locale. Mirrors `small-llm-runner.ts:222-226`. If the noticing layer's
 * format ever changes, update both call sites (or extract a shared helper).
 */
export function formatCaptionTime(now: Date): string {
  const weekday = now.toLocaleDateString("en-US", { weekday: "short" });
  const time = now.toLocaleString(
    "en-US",
    { hour: "2-digit", minute: "2-digit" },
  );
  return `${weekday} ${time}`;
}

/** Build the human-readable caption: `[weekday time] description`. */
export function buildCaption(description: string, now: Date): string {
  return `[${formatCaptionTime(now)}] ${description}`;
}

// =============================================================================
// State file — presence (read, not pushed)
// =============================================================================

/** Path to the motion-vision state file under the data root. */
export function stateFilePath(dataRoot: string): string {
  return join(psycherosDir(dataRoot), "organ-state", "motion-vision.json");
}

/**
 * Read the state file. Returns null if missing or unreadable (organ treats
 * that as "no cached caption — populate from a fresh VLM pass").
 */
export async function readStateFile(
  dataRoot: string,
): Promise<MotionVisionState | null> {
  try {
    const text = await Deno.readTextFile(stateFilePath(dataRoot));
    const parsed = JSON.parse(text) as Partial<MotionVisionState>;
    if (
      typeof parsed.caption !== "string" ||
      typeof parsed.timestamp !== "string"
    ) {
      return null;
    }
    const result: MotionVisionState = {
      caption: parsed.caption,
      timestamp: parsed.timestamp,
      model: typeof parsed.model === "string" ? parsed.model : "",
      motionScore: typeof parsed.motionScore === "number"
        ? parsed.motionScore
        : 0,
    };
    // Optional slices attach only when present — round-trip identity with
    // what writeStateFile persisted.
    if (parsed.presence) result.presence = parsed.presence;
    if (parsed.perception) result.perception = parsed.perception;
    if (parsed.scene) result.scene = parsed.scene;
    return result;
  } catch {
    return null;
  }
}

/**
 * Write the state file (creating the directory if needed). Best-effort —
 * failure to write the caption file is logged but never crashes the Sensory Organ.
 */
export async function writeStateFile(
  dataRoot: string,
  state: MotionVisionState,
): Promise<void> {
  const path = stateFilePath(dataRoot);
  try {
    await Deno.mkdir(join(psycherosDir(dataRoot), "organ-state"), {
      recursive: true,
    });
    // Drop undefined optional keys (presence/perception) so the file and the
    // in-memory shape round-trip identically — JSON.stringify would keep
    // them out of the file but the object comparison sees the key present.
    const clean = JSON.parse(JSON.stringify(state)) as MotionVisionState;
    await Deno.writeTextFile(path, JSON.stringify(clean, null, 2) + "\n");
  } catch (error) {
    console.error(
      `[motion-vision] failed to write state file: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// =============================================================================
// Amplitude + habituation
// =============================================================================

/**
 * Base amplitude from a motion score. Below the escalation threshold,
 * amplitude scales linearly from 0.15 (texture) to ~0.5 (approaching
 * escalation). At or above the threshold, it jumps to 0.9 — the immediate
 * escalation path. The promotion filter decides whether 0.9 wakes the Ego.
 */
export function amplitudeForMotion(
  motionScore: number,
  escalationThreshold: number,
): number {
  if (motionScore >= escalationThreshold) return 0.9;
  const clamped = Math.min(motionScore / escalationThreshold, 1);
  return 0.15 + clamped * 0.35;
}

/**
 * Habituation factor — how much to scale an event amplitude when the scene
 * description repeats. Compares descriptions after light normalization
 * (lowercase, collapsed whitespace). On a match, the factor halves (and
 * keeps halving with each repeat). On any change, it resets to 1.0.
 *
 * This is crude — the VLM will vary wording for identical scenes, so true
 * habituation needs embedding-based similarity. That's a future refinement;
 * for now this catches exact-and-near repeats and prevents the worst
 * flooding. The state file is updated regardless of habituation, so presence
 * is never re-blinded by decay.
 */
export function habituationFactor(
  description: string,
  lastDescription: string | null,
  prevFactor: number,
): number {
  if (!lastDescription) return 1.0;
  if (normalize(description) === normalize(lastDescription)) {
    return prevFactor * 0.5;
  }
  return 1.0;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// =============================================================================
// Envelope construction (propagate)
// =============================================================================

/**
 * Package a scene result + motion score into an `OrganEnvelope`, ready for the
 * sink. The perception.description is the raw scene text (no timestamp — the
 * noticing layer has its own time context); the timestamped caption lives in
 * the state file for human/file inspection.
 *
 * `confidence` is a heuristic (0.8) — the VLM doesn't return a confidence
 * number, and a successful response implies it saw *something*. A future
 * refinement could parse uncertainty from the description text.
 *
 * No mood modifiers in v1 — the synthetic organ's saturation lesson was that
 * emitting mood on every event floods the Mood Organ. Mood is reserved for a
 * later, more selective layer.
 */
export function buildEnvelope(
  organId: string,
  scene: SceneResult,
  motionScore: number,
  amplitude: number,
  people?: {
    count: number;
    identified: Array<{ id: string; confidence: number }>;
  } | null,
): OrganEnvelope {
  const perception: Perception = {
    type: PERCEPTION_TYPE,
    description: scene.description,
    data: {
      motionScore,
      frameCount: scene.frameCount,
      windowMs: scene.windowMs,
      model: scene.model,
      ...(people
        ? {
          people: {
            count: people.count,
            identified: people.identified,
            unidentified: Math.max(0, people.count - people.identified.length),
          },
        }
        : {}),
    },
    confidence: 0.8,
  };
  return {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    organId,
    specialistModel: scene.model,
    perception,
    amplitude,
  };
}
