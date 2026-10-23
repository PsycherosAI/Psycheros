/**
 * Motion-vision's plugin-surface adapter: this shipped
 * Sensory Organ rides the SAME contract as out-of-tree plugins — one
 * factory taking (sink, context), settings values from the
 * `sensoryOrganSettings["motion-vision"]` bag, and a declared settings
 * descriptor the Settings UI renders its card from. Keys deliberately
 * match the legacy root FluxSettings field names so the settings-file
 * migration is a straight move.
 *
 * The only richer-than-plugin capability: the composition root may pass
 * the host's shared embedder (scene-baseline delta-captioning) and a
 * perceptual directive getter — compiled senses get typed seams.
 */

import type {
  EnvelopeSink,
  SensoryOrganFactoryContext,
  SensoryOrganSettingField,
} from "../../types.ts";
import {
  createMotionVisionOrgan,
  type MotionVisionOrgan,
} from "./motion-vision-organ.ts";
import {
  defaultMotionVisionConfig,
  type MotionVisionContext,
  type ProviderType,
} from "./types.ts";

/** The settings card descriptor — one source of truth for UI, defaults,
 *  and the bag's field names. */
export const motionVisionSettingsFields: SensoryOrganSettingField[] = [
  {
    key: "visionSource",
    label: "Camera source",
    type: "select",
    default: "server",
    options: [
      {
        value: "server",
        label: "Server camera — a webcam on this machine (device path below)",
      },
      {
        value: "browser",
        label: "Browser camera — the app's camera (phone or webcam, no setup)",
      },
    ],
    help:
      "Server: for always-on machines with their own webcam. Browser: the camera of whichever app is connected — permission is asked once, the newest connection is the eyes.",
  },
  {
    key: "visionDevice",
    label: "Camera device",
    type: "text",
    default: "/dev/video0",
    help: "Server-camera mode only: webcam device path.",
  },
  {
    key: "visionModelUrl",
    label: "Model server URL",
    type: "text",
    default: "http://localhost:8080/v1",
    help: "Include the /v1 prefix (e.g. http://localhost:8080/v1).",
  },
  {
    key: "visionModel",
    label: "Vision model",
    type: "text",
    default: "gemma4:e4b",
    help:
      "Whatever identifier the server expects (e.g. gemma4:e2b, moondream).",
  },
  {
    key: "visionCadenceMs",
    label: "Emit cadence (ms)",
    type: "number",
    default: 2000,
  },
  { key: "captureFps", label: "Capture FPS", type: "number", default: 3 },
  {
    key: "burstWindowMs",
    label: "Burst window (ms)",
    type: "number",
    default: 3000,
  },
  {
    key: "motionThreshold",
    label: "Motion threshold",
    type: "number",
    default: 0.02,
  },
  {
    key: "escalationMotionThreshold",
    label: "Escalation motion threshold",
    type: "number",
    default: 0.5,
  },
  {
    key: "maxQuietMs",
    label: "Max quiet before refresh (ms)",
    type: "number",
    default: 300000,
  },
  {
    key: "perceptionEnabled",
    label: "Perception sidecar (people + face identity)",
    type: "toggle",
    default: false,
    help:
      "Optional Python sidecar — see perception-sidecar/ in this organ's directory. Occupancy and identity join the captions when it's up; the organ degrades gracefully when it's not there.",
  },
  {
    key: "perceptionUrl",
    label: "Perception sidecar URL",
    type: "text",
    default: "http://localhost:18085",
  },
  {
    key: "arrivalDebounceMs",
    label: "Arrival debounce (ms)",
    type: "number",
    default: 3000,
  },
  {
    key: "trackGraceMs",
    label: "Track grace (ms)",
    type: "number",
    default: 6000,
  },
  {
    key: "audioCaptioningEnabled",
    label: "Audio captioning",
    type: "toggle",
    default: true,
    help:
      "The ears are part of the Sensory Organ — notable sounds land in captions. No mic? Video-only, no error.",
  },
  {
    key: "audioDevice",
    label: "Audio device",
    type: "text",
    default: "default",
    help: 'ALSA device, e.g. "default" or "hw:2,0".',
  },
  {
    key: "visionWidth",
    label: "Capture width",
    type: "number",
    default: 640,
  },
  {
    key: "visionHeight",
    label: "Capture height",
    type: "number",
    default: 480,
  },
  {
    key: "adaptiveBursts",
    label: "Adaptive bursts",
    type: "toggle",
    default: true,
    help:
      "Routine passes caption at the lean resolution; reflex passes go fat.",
  },
  { key: "leanWidth", label: "Lean width", type: "number", default: 480 },
  { key: "leanHeight", label: "Lean height", type: "number", default: 360 },
  {
    key: "sceneBaselineEnabled",
    label: "Scene baseline (delta-captioning)",
    type: "toggle",
    default: false,
    help:
      "Captions scored against a calibrated stage — conforming ones quiet down. Changes caption phrasing; flip deliberately.",
  },
];

const DESCRIPTOR_DEFAULTS: Record<string, unknown> = Object.fromEntries(
  motionVisionSettingsFields.map((f) => [f.key, f.default]),
);

/** The plugin-shaped factory: bag values over descriptor defaults,
 *  mapped onto the organ config, with the health probe self-declared
 *  (the model server's /models route — liveness, nothing more). */
export function createSensoryOrgan(
  sink: EnvelopeSink,
  context:
    & SensoryOrganFactoryContext
    & Pick<MotionVisionContext, "embed" | "getDirective" | "perceptionClient">,
): MotionVisionOrgan {
  const values = { ...DESCRIPTOR_DEFAULTS, ...context.settings };
  const str = (k: string, d: string) =>
    typeof values[k] === "string" && values[k] ? values[k] as string : d;
  const num = (k: string, d: number) =>
    typeof values[k] === "number" ? values[k] as number : d;
  const bool = (k: string, d: boolean) =>
    typeof values[k] === "boolean" ? values[k] as boolean : d;
  const base = defaultMotionVisionConfig();
  const modelUrl = str("visionModelUrl", base.modelUrl);
  // Provider is always OpenAI-compatible (no native-Ollama path); a
  // legacy saved "ollama" value just reads as this.
  const provider: ProviderType = "openai-compatible";
  return createMotionVisionOrgan(
    {
      id: "motion-vision",
      tickIntervalMs: num("visionCadenceMs", base.tickIntervalMs),
      enabled: true,
      source: str("visionSource", "server") === "browser"
        ? "browser" as const
        : "server" as const,
      device: str("visionDevice", base.device),
      provider,
      modelUrl,
      model: str("visionModel", base.model),
      captureFps: num("captureFps", base.captureFps),
      burstWindowMs: num("burstWindowMs", base.burstWindowMs),
      motionThreshold: num("motionThreshold", base.motionThreshold),
      escalationMotionThreshold: num(
        "escalationMotionThreshold",
        base.escalationMotionThreshold,
      ),
      maxQuietMs: num("maxQuietMs", base.maxQuietMs),
      perceptionEnabled: bool("perceptionEnabled", base.perceptionEnabled),
      perceptionUrl: str("perceptionUrl", base.perceptionUrl),
      arrivalDebounceMs: num("arrivalDebounceMs", base.arrivalDebounceMs),
      trackGraceMs: num("trackGraceMs", base.trackGraceMs),
      audioCaptioningEnabled: bool("audioCaptioningEnabled", true),
      audioDevice: str("audioDevice", base.audioDevice),
      visionWidth: num("visionWidth", base.visionWidth),
      visionHeight: num("visionHeight", base.visionHeight),
      adaptiveBursts: bool("adaptiveBursts", base.adaptiveBursts),
      leanWidth: num("leanWidth", base.leanWidth),
      leanHeight: num("leanHeight", base.leanHeight),
      sceneBaselineEnabled: bool(
        "sceneBaselineEnabled",
        base.sceneBaselineEnabled,
      ),
      // Self-declared liveness probe — the registration site stays
      // organ-agnostic.
      healthProbeUrl: modelUrl.replace(/\/$/, "") + "/models",
    },
    sink,
    {
      dataRoot: context.dataRoot,
      embed: context.embed,
      getDirective: context.getDirective,
      perceptionClient: context.perceptionClient,
    },
  );
}
