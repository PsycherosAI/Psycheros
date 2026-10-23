/**
 * Motion-Vision organ — the first real Sensory Organ.
 *
 * Webcam-based vision: captures frames on a cadence, detects motion locally
 * (cheap reflex arc), runs a vision-language model on bursts of frames to
 * produce scene descriptions, and publishes an always-current caption file.
 *
 * Structure follows the three-part Sensory Organ template (Perception /
 * Processing / Response). See `packages/entity-flux/docs/sensory-organ-template.md`
 * for the canonical reference and `motion-vision.md` for this Sensory Organ's specifics.
 *
 * @module
 */

export { captureFrame, downscaleJpeg, FrameStream } from "./capture.ts";
export {
  computeMotionScore,
  GRAY_H,
  GRAY_W,
  jpegToGrayscale,
} from "./motion-gate.ts";
export {
  createVisionProvider,
  OpenAICompatibleVisionProvider,
} from "./scene-describer.ts";
export type {
  DescribeSceneOptions,
  SceneIdentity,
  VisionModelProvider,
} from "./scene-describer.ts";
export {
  amplitudeForMotion,
  buildCaption,
  buildEnvelope,
  formatCaptionTime,
  habituationFactor,
  readStateFile,
  stateFilePath,
  writeStateFile,
} from "./response.ts";
export {
  createMotionVisionOrgan,
  MotionVisionOrgan,
} from "./motion-vision-organ.ts";
export type {
  ActuatorCommand,
  Box,
  MotionVisionContext,
  MotionVisionFrame,
  MotionVisionOrganConfig,
  MotionVisionState,
  PerceptionClient,
  PerceptionResult,
  PresenceStateFile,
  ProviderType,
  SceneResult,
} from "./types.ts";
export { freshPresence, restorePresence, stepPresence } from "./presence.ts";
export type {
  PresenceConfig,
  PresenceObservation,
  PresenceSnapshot,
  PresenceTransition,
  Track,
} from "./presence.ts";
export {
  buildScenePromptPrefix,
  capSummary,
  currentSceneSummary,
  freshSceneBaseline,
  restoreSceneBaseline,
  stepSceneBaseline,
} from "./scene-baseline.ts";
export type {
  SceneBaselineConfig,
  SceneBaselineState,
  SceneEntry,
  SceneObservation,
  SceneStepResult,
} from "./scene-baseline.ts";
export { HttpPerceptionClient } from "./perception-client.ts";
export { defaultMotionVisionConfig } from "./types.ts";
export {
  createSensoryOrgan as createMotionVisionSensoryOrgan,
  motionVisionSettingsFields,
} from "./sensory-organ-surface.ts";
