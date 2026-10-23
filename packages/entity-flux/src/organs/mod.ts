/**
 * Organs — modular sensory units.
 *
 * Each Sensory Organ is a sensor + local processor (specialist model) + the
 * escalation logic that wraps its output in an `OrganEnvelope`. Organs
 * own their perception.data schema; the envelope around it is the
 * shared contract. Register organs with the FluxManager, which feeds
 * their envelopes through the noticing layer.
 *
 * @module
 */

// First real Sensory Organ — webcam-based vision. See organs/motion-vision/
// and docs/motion-vision.md.
export * from "./motion-vision/mod.ts";
export * from "./system-state/mod.ts";
