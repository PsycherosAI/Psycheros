/**
 * Motion-Vision Sensory Organ — presence layer.
 *
 * I hold the tracker that turns per-frame perception into relational
 * events — multi-object tracking with re-identification, the standard
 * video-vision architecture, Norfair-inspired:
 *
 * - **Bodies are TRACKED, not just counted.** A body box near last frame's
 *   box is the same person continuing. Presence is track existence — a body
 *   survives a turned head, a nap, a dim frame.
 * - **Faces are assigned to bodies geometrically** — a face box inside a
 *   body box belongs to that body. One body + one face = that face is that
 *   person, no ML guess.
 * - **Identity is STICKY on the track.** Once a track is identified, it
 *   stays that person until the track ends — the face coming and going is
 *   not an event, ever. "I can no longer see her face" stopped existing as
 *   a report class; the report is "she is there."
 *
 * Motion remains the tiebreaker for track death: someone moving where the
 * detector can't resolve them holds their track (occluded walking). I
 * phrase my envelopes as evidence ("no one is visible and the room has
 * been still"), never as verdicts.
 *
 * Both machines are pure: the Sensory Organ feeds me timestamped observations and
 * applies the transitions I return. All timing flows through observation
 * timestamps, never wall-clock ticks, so missed frames can't skew a debounce.
 *
 * Identity events are relational, not alarming: amplitude ~0.5 informs
 * noticing and mood without poking the Ego on every glance. Occupancy changes
 * are reflex-class (0.7+) — someone arriving or the room going empty is
 * exactly what the wake door's event-exempt path exists for.
 */

import type { MoodModifier, OrganEnvelope, Perception } from "../../types.ts";
import type { Box } from "./types.ts";

/** Perception type label for occupancy envelopes (arrival/departure). */
const PRESENCE_TYPE = "motion-vision_presence";

/** Perception type label for identity visibility envelopes (seen/lost). */
const IDENTITY_TYPE = "motion-vision_identity";

/** specialistModel for perception-sidecar-sourced envelopes. */
const SPECIALIST = "perception-sidecar";

// =============================================================================
// Types
// =============================================================================

/** Occupancy states. `unknown` = no trusted observation yet (startup, or the
 * perception layer has been blind long enough that I won't guess). */
export type OccupancyState = "unknown" | "occupied" | "empty";

/** Identity visibility states, tracked per registered person. */
export type IdentityVisibility = "visible" | "lost";

/** One perception observation, fed per capture-cadence attempt. `recognizerOk`
 * false means the sidecar was unreachable — treat as blindness, not as an
 * empty room. Faces carry boxes for body-association; bodies carry boxes
 * for tracking. */
export interface PresenceObservation {
  /** When the frame was perceived (ms since epoch). */
  at: number;
  /** Body boxes from the person detector (may be empty; tracking degrades
   * to count-level when absent). */
  bodies: Box[];
  /** All matched faces this frame with their boxes. */
  faces: Array<{ id: string; confidence: number; box?: Box }>;
  /** Motion score of the same frame (the tiebreaker signal). */
  motionScore: number;
  /** Whether the perception call succeeded for this frame. */
  recognizerOk: boolean;
}

/** Tuning knobs. Mirrored in `MotionVisionOrganConfig` / `FluxSettings`. */
export interface PresenceConfig {
  /** Detections sustained this long before a track confirms (the arrival
   * event). Long enough that dawn-light flicker can't false-arrive (default
   * 3_000). */
  arrivalDebounceMs: number;
  /** No-detection grace before a track's death is considered (default
   * 6_000 — bridges the seated-profile sighting cadence). */
  trackGraceMs: number;
  /** Motion score at/above which the room counts as "not still" (mirrors the
   * Sensory Organ's `motionThreshold`). */
  motionThreshold: number;
  /** Window within which consecutive motion frames count as SUSTAINED
   * (isolated blips don't hold a dying track; default 3_000). */
  motionSustainMs: number;
}

/** One tracked person: a body with a lifetime and a sticky identity. */
export interface Track {
  /** Stable id within the session (counter). */
  tid: number;
  /** Last associated body box. */
  box: Box;
  /** When the track was born (ms since epoch). */
  bornAt: number;
  /** Last body detection (ms since epoch) — grace counts from here. */
  lastSeenAt: number;
  /** When the track confirmed (null while pending). */
  confirmedAt: number | null;
  /** Sticky identity: face matches attach here and survive face loss. */
  identity: { id: string; confidence: number; at: number } | null;
  /** Face matches accumulated toward identity confirmation. */
  identityHits: number;
  /** When death started being considered (null = alive, not yet worried). */
  dyingSince: number | null;
  /** Last motion ≥ threshold (occlusion-hold evidence). */
  lastMotionAt: number | null;
}

/** Snapshot of everything the tracker persists. */
export interface PresenceSnapshot {
  /** Live (and recently-dead-within-grace) tracks. */
  tracks: Track[];
  /** Next track id. */
  nextTid: number;
  /** Last successful observation (null before the first). */
  lastObservationAt: number | null;
}

/** A step's outcome: the new snapshot plus envelopes to emit. */
export interface PresenceTransition {
  snapshot: PresenceSnapshot;
  envelopes: OrganEnvelope[];
}

// =============================================================================
// The combined step — one observation in, snapshot + envelopes out
// =============================================================================

/**
 * Advance the tracker by one observation. Pure — returns the new snapshot
 * and the envelopes the transitions warrant; the Sensory Organ applies the snapshot
 * and sends the envelopes through its sink.
 *
 * Lifecycle:
 * - A new body births a PENDING track; it confirms after
 *   `arrivalDebounceMs` of continued detections → arrival envelope (dawn
 *   flicker never confirms). Identity acquired before confirmation names
 *   the arrival.
 * - Faces assign to tracks by box containment; `IDENTITY_CONFIRM_HITS`
 *   matches on the same track attach a STICKY identity → one
 *   identity-acquired envelope. Face loss is never an event.
 * - A track undetected for `trackGraceMs` starts dying; death confirms when
 *   the room is also still (sustained-motion hold for occluded walking) →
 *   departure envelope carrying the track's identity and dwell time.
 * - Blind observation → everything freezes (blindness ≠ empty room).
 */
export function stepPresence(
  snapshot: PresenceSnapshot,
  obs: PresenceObservation,
  config: PresenceConfig,
): PresenceTransition {
  if (!obs.recognizerOk) {
    return { snapshot, envelopes: [] };
  }
  const tracks = snapshot.tracks.map((t) => ({ ...t, box: [...t.box] as Box }));
  const envelopes: OrganEnvelope[] = [];
  let nextTid = snapshot.nextTid;

  const motionNow = obs.motionScore >= config.motionThreshold;
  const sustainedMotion = (t: Track) =>
    motionNow && t.lastMotionAt !== null &&
    obs.at - t.lastMotionAt < config.motionSustainMs;

  // -- associate bodies to tracks (greedy IoU) --------------------------------
  const claimedBodies = new Set<number>();
  const bodyMatched = new Set<Track>();
  for (const t of tracks) {
    let best = -1, bestIou = IOU_MATCH;
    obs.bodies.forEach((b, i) => {
      if (claimedBodies.has(i)) return;
      const iou = boxIou(t.box, b);
      if (iou >= bestIou) {
        bestIou = iou;
        best = i;
      }
    });
    if (best >= 0) {
      claimedBodies.add(best);
      bodyMatched.add(t);
      t.box = [...obs.bodies[best]] as Box;
      t.lastSeenAt = obs.at;
      t.dyingSince = null;
      if (
        t.confirmedAt === null && obs.at - t.bornAt >= config.arrivalDebounceMs
      ) {
        t.confirmedAt = obs.at;
        envelopes.push(
          buildArrivalEnvelope({
            at: obs.at,
            emptyMs: null,
            match: t.identity
              ? { id: t.identity.id, confidence: t.identity.confidence }
              : null,
          }),
        );
      }
    }
    if (motionNow) t.lastMotionAt = obs.at;
  }

  // -- unmatched bodies: adopt the lone track, else birth pending --------------
  for (let bi = 0; bi < obs.bodies.length; bi++) {
    if (claimedBodies.has(bi)) continue;
    const b = obs.bodies[bi];
    // A lone track not yet body-matched this frame is likely the person
    // the FACE kept alive through body-flicker (or the mirror-offset
    // face-born track) — adopt, don't twin.
    const lone = tracks.length === 1 && !bodyMatched.has(tracks[0]);
    if (lone) {
      const t = tracks[0];
      t.box = [...b] as Box;
      t.lastSeenAt = obs.at;
      t.dyingSince = null;
      if (
        t.confirmedAt === null && obs.at - t.bornAt >= config.arrivalDebounceMs
      ) {
        t.confirmedAt = obs.at;
        envelopes.push(
          buildArrivalEnvelope({
            at: obs.at,
            emptyMs: null,
            match: t.identity
              ? { id: t.identity.id, confidence: t.identity.confidence }
              : null,
          }),
        );
      }
      continue;
    }
    tracks.push({
      tid: nextTid++,
      box: [...b] as Box,
      bornAt: obs.at,
      lastSeenAt: obs.at,
      confirmedAt: null,
      identity: null,
      identityHits: 0,
      dyingSince: null,
      lastMotionAt: motionNow ? obs.at : null,
    });
  }

  // -- faces attach to tracks (containment, else proximity) --------------------
  // A face is person evidence: it attaches to the track whose box contains
  // it, or the nearest track when the BODY detector has flickered off a
  // seated-profile person the face detector still sees — refreshing the
  // track's lifetime. A face with no track at all births a face-only
  // pending track (the face box stands in as a small body).
  const announced: string[] = [];
  for (const face of obs.faces) {
    if (!face.box) continue;
    let host: Track | null = trackContaining(tracks, face.box) ??
      nearestTrack(tracks, face.box) ??
      // The mirror case: her face is detected in the mirror while her body
      // is at the desk — spatially strangers, but with exactly one track
      // and one matched face in the room, they are the same person.
      // (Calibrated evidence: face box [487,253,786,421] vs body box
      // [75,194,231,301] — same room, same moment, zero overlap.)
      (tracks.length === 1 ? tracks[0] : null);
    if (!host) {
      host = {
        tid: nextTid++,
        box: dilate(face.box, 1.8),
        bornAt: obs.at,
        lastSeenAt: obs.at,
        confirmedAt: null,
        identity: null,
        identityHits: 0,
        dyingSince: null,
        lastMotionAt: motionNow ? obs.at : null,
      };
      tracks.push(host);
    }
    host.lastSeenAt = obs.at; // the face keeps the person alive
    host.dyingSince = null;
    // NOTE: faces do NOT confirm presence here — confirmation is
    // body-gated (see the unmatched-bodies block). A face alone can
    // hold a track alive and carry identity through body-flicker, but
    // never announces "someone is here." A false face match with no
    // body ever seen produces a named arrival announcement
    // every 30s to an empty room. This mirrors the industry pattern —
    // Frigate runs recognition only on detected persons; a face with no
    // person is not evidence of a person. The body path (YOLO) carries
    // presence; the face path carries names.
    if (host.identity?.id === face.id) {
      host.identity = {
        ...host.identity,
        confidence: face.confidence,
        at: obs.at,
      };
    } else {
      host.identityHits += 1;
      if (host.identityHits >= IDENTITY_CONFIRM_HITS) {
        host.identity = {
          id: face.id,
          confidence: face.confidence,
          at: obs.at,
        };
        if (host.confirmedAt !== null && !announced.includes(face.id)) {
          announced.push(face.id);
          envelopes.push(
            buildIdentitySeenEnvelope({
              at: obs.at,
              id: face.id,
              confidence: face.confidence,
              wasLostMs: null,
            }),
          );
        }
      }
    }
  }

  // -- track death: grace, then stillness -------------------------------------
  const survivors: Track[] = [];
  for (const t of tracks) {
    const age = obs.at - t.lastSeenAt;
    if (age < config.trackGraceMs) {
      survivors.push(t);
      continue;
    }
    t.dyingSince ??= obs.at;
    // Occlusion hold: sustained motion keeps a dying track on ice.
    if (sustainedMotion(t)) {
      survivors.push(t);
      continue;
    }
    if (t.confirmedAt !== null) {
      envelopes.push(
        buildDepartureEnvelope({
          at: obs.at,
          occupiedMs: obs.at - t.bornAt,
          quietMs: obs.at - t.lastSeenAt,
          lastMatch: t.identity
            ? {
              id: t.identity.id,
              confidence: t.identity.confidence,
              at: t.identity.at,
            }
            : null,
        }),
      );
    }
    // Unconfirmed phantoms die silently.
  }

  return {
    snapshot: {
      tracks: survivors,
      nextTid,
      lastObservationAt: obs.at,
    },
    envelopes,
  };
}

/** Face matches needed on one track before identity sticks (a poster's
 * single false match never names a body). */
const IDENTITY_CONFIRM_HITS = 2;

/** Minimum IoU for a body to continue a track (low — 3fps, slow movement,
 * and a still person's box barely moves). */
const IOU_MATCH = 0.15;

/** IoU of two axis-aligned boxes. */
function boxIou(a: Box, b: Box): number {
  const ix1 = Math.max(a[0], b[0]), iy1 = Math.max(a[1], b[1]);
  const ix2 = Math.min(a[2], b[2]), iy2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) -
    inter;
  return ua > 0 ? inter / ua : 0;
}

/** The track whose center is nearest the face box center — the
 * body-flicker fallback (seated-profile: face visible, body missed). */
function nearestTrack(tracks: Track[], face: Box): Track | null {
  if (tracks.length === 0) return null;
  const fx = (face[0] + face[2]) / 2, fy = (face[1] + face[3]) / 2;
  let best: Track | null = null, bestD = Infinity;
  for (const t of tracks) {
    const tx = (t.box[0] + t.box[2]) / 2, ty = (t.box[1] + t.box[3]) / 2;
    const d = Math.hypot(fx - tx, fy - ty);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  // Only nearby tracks count — a face across the room is a different person.
  return bestD < Math.max(face[2] - face[0], face[3] - face[1]) * 3
    ? best
    : null;
}

/** Grow a box by a factor around its center (a face box as a stand-in body). */
function dilate(b: Box, f: number): Box {
  const w = b[2] - b[0],
    h = b[3] - b[1],
    cx = (b[0] + b[2]) / 2,
    cy = (b[1] + b[3]) / 2;
  return [
    cx - (w * f) / 2,
    cy - (h * f) / 2,
    cx + (w * f) / 2,
    cy + (h * f) / 2,
  ];
}

/** The track whose box contains the face box's center (with a little
 * slack), or null. */
function trackContaining(tracks: Track[], face: Box): Track | null {
  const cx = (face[0] + face[2]) / 2, cy = (face[1] + face[3]) / 2;
  let best: Track | null = null, bestArea = Infinity;
  for (const t of tracks) {
    const slack = 0.1 * (t.box[2] - t.box[0]);
    if (
      cx >= t.box[0] - slack && cx <= t.box[2] + slack &&
      cy >= t.box[1] - slack && cy <= t.box[3] + slack
    ) {
      const area = (t.box[2] - t.box[0]) * (t.box[3] - t.box[1]);
      if (area < bestArea) {
        bestArea = area;
        best = t;
      }
    }
  }
  return best;
}

// =============================================================================
// Envelope builders
// =============================================================================

/** Duration phrasing for envelope prose. */
function aboutDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} seconds`;
  const m = Math.round(s / 60);
  return m === 1 ? "a minute" : `${m} minutes`;
}

// -- bottom-up mood (the room's events shift how I feel) ----------------------
// Deterministic modifiers for occupancy transitions and face-visibility blips.
// Scene captions carry none here — the Thalamus classifies those through the
// Mood Organ's text-classifier seam at ingest (observed text, weight 0.2), so
// what I SEE (a dropped plate, a relaxed evening) reaches mood without
// brittle keyword rules. The connection axis is temporarily dropped:
// arrival/departure modifiers carry their remaining axes only;
// the seen/lost blips — which existed purely for connection — carry none. Weights stay SMALL by design: raw signal must not dominate
// expression-derived mood (the overnight-spiral calibration), and the
// saturation lesson from the synthetic organ — mood on every event floods —
// is why only transitions and blips carry modifiers at all. Decay (~2-minute
// half-life toward a slowly-drifting baseline) turns repeats into ambience:
// one arrival lifts the moment, a pattern of presence raises the home.

/** Departure: the room went empty after sustained stillness. Reflex-class. */
export function buildDepartureEnvelope(input: {
  at: number;
  occupiedMs: number;
  quietMs: number;
  lastMatch: { id: string; confidence: number; at: number } | null;
}): OrganEnvelope {
  const quiet = aboutDuration(input.quietMs);
  const description = input.lastMatch
    ? `The room has gone quiet and still — no one is visible for the last ${quiet}. I last saw ${input.lastMatch.id} ${
      aboutDuration(input.at - input.lastMatch.at)
    } ago.`
    : `The room has gone quiet and still — no one is visible for the last ${quiet}.`;
  // Quieter, not sadder: arousal dips, valence untouched — being alone
  // isn't unpleasant by design; interior life continues.
  const mood: MoodModifier[] = [
    input.lastMatch
      ? {
        arousal: -0.04,
        weight: 1,
        source: "motion-vision:departure",
        subject: input.lastMatch.id,
      }
      : {
        arousal: -0.03,
        weight: 1,
        source: "motion-vision:departure",
      },
  ];
  return buildPresenceEnvelope({
    at: input.at,
    description,
    amplitude: 0.7,
    confidence: 0.9,
    mood,
    data: {
      presence: "departure",
      lastIdentity: input.lastMatch?.id ?? null,
      identityConfidence: input.lastMatch?.confidence ?? null,
      occupiedMs: input.occupiedMs,
      quietMs: input.quietMs,
      recognizer: "person-detect+blazeface+arcface",
    },
  });
}

/** Arrival: someone entered after the room was empty. Reflex-class. */
export function buildArrivalEnvelope(input: {
  at: number;
  emptyMs: number | null;
  match: { id: string; confidence: number } | null;
}): OrganEnvelope {
  const away = input.emptyMs != null && input.emptyMs > 5_000
    ? ` — after ${aboutDuration(input.emptyMs)}`
    : "";
  const description = input.match
    ? `Someone is here: I see ${input.match.id}${away}.`
    : `Someone is here${away}.`;
  // A known person arriving lifts the moment gently; an unknown one is
  // pure novelty — alertness.
  const mood: MoodModifier[] = [
    input.match
      ? {
        valence: 0.05,
        arousal: 0.05,
        weight: 1,
        source: "motion-vision:arrival",
        subject: input.match.id,
      }
      : { arousal: 0.10, weight: 1, source: "motion-vision:arrival" },
  ];
  return buildPresenceEnvelope({
    at: input.at,
    description,
    amplitude: 0.75,
    confidence: input.match ? input.match.confidence : 0.8,
    mood,
    data: {
      presence: "arrival",
      identity: input.match?.id ?? null,
      identityConfidence: input.match?.confidence ?? null,
      emptyMs: input.emptyMs,
    },
  });
}

/** Identity seen — immediate, relational amplitude. */
export function buildIdentitySeenEnvelope(input: {
  at: number;
  id: string;
  confidence: number;
  wasLostMs: number | null;
}): OrganEnvelope {
  const again = input.wasLostMs != null && input.wasLostMs > 5_000
    ? ` again, after ${aboutDuration(input.wasLostMs)}`
    : "";
  const description = `I see ${input.id}${again}.`;
  return buildPresenceEnvelope({
    at: input.at,
    description,
    amplitude: 0.5,
    confidence: input.confidence,
    // No mood modifier: the seen blip existed for the connection axis
    // (temporarily dropped).
    data: {
      identity: input.id,
      event: "seen",
      notVisibleMs: input.wasLostMs,
      matchConfidence: input.confidence,
    },
    type: IDENTITY_TYPE,
  });
}

/** Identity lost — sustained face-loss while the person may still be here. */
export function buildIdentityLostEnvelope(input: {
  at: number;
  id: string;
  lastSeenAt: number;
  stillPresent: boolean;
}): OrganEnvelope {
  const description = input.stillPresent
    ? `${input.id} is still here, but I've lost sight of their face for ${
      aboutDuration(input.at - input.lastSeenAt)
    }.`
    : `I haven't been able to see ${input.id}'s face for ${
      aboutDuration(input.at - input.lastSeenAt)
    }.`;
  return buildPresenceEnvelope({
    at: input.at,
    description,
    amplitude: 0.5,
    confidence: 0.85,
    // No mood modifier: matched the seen side's connection blip
    // (temporarily dropped).
    data: {
      identity: input.id,
      event: "lost",
      notVisibleMs: input.at - input.lastSeenAt,
    },
    type: IDENTITY_TYPE,
  });
}

/** Shared envelope assembly. */
function buildPresenceEnvelope(input: {
  at: number;
  description: string;
  amplitude: number;
  confidence: number;
  data: Record<string, unknown>;
  mood?: MoodModifier[];
  type?: string;
}): OrganEnvelope {
  const perception: Perception = {
    type: input.type ?? PRESENCE_TYPE,
    description: input.description,
    data: input.data,
    confidence: input.confidence,
  };
  return {
    id: crypto.randomUUID(),
    timestamp: new Date(input.at).toISOString(),
    organId: "motion-vision",
    specialistModel: SPECIALIST,
    perception,
    amplitude: input.amplitude,
    ...(input.mood ? { moodModifiers: input.mood } : {}),
  };
}

// =============================================================================
// Fresh state
// =============================================================================

/** A blank presence snapshot. */
export function freshPresence(_at: number): PresenceSnapshot {
  return { tracks: [], nextTid: 1, lastObservationAt: null };
}

/**
 * Rebuild a snapshot from the persisted state-file slice. Tracks restore as
 * confirmed with their identities intact (a restart is not a re-arrival);
 * grace runs from restore time, so a person still present re-associates by
 * box overlap on the next detection, and a room that emptied while the
 * daemon was down produces a timely, honest departure.
 */
export function restorePresence(
  saved: {
    tracks?: unknown;
    nextTid?: unknown;
  },
  now = Date.now(),
): PresenceSnapshot {
  const tracks: Track[] = [];
  if (Array.isArray(saved.tracks)) {
    let tid = 1;
    for (const t of saved.tracks as Partial<Track>[]) {
      if (!Array.isArray(t.box) || t.box.length !== 4) continue;
      tracks.push({
        tid: typeof t.tid === "number" ? t.tid : tid,
        box: [...t.box] as Box,
        bornAt: typeof t.bornAt === "number" ? t.bornAt : now,
        lastSeenAt: now,
        confirmedAt: typeof t.confirmedAt === "number" ? t.confirmedAt : now,
        identity: t.identity && typeof t.identity.id === "string"
          ? {
            id: t.identity.id,
            confidence: typeof t.identity.confidence === "number"
              ? t.identity.confidence
              : 0,
            at: typeof t.identity.at === "number" ? t.identity.at : now,
          }
          : null,
        identityHits: typeof t.identityHits === "number" ? t.identityHits : 0,
        dyingSince: null,
        lastMotionAt: null,
      });
      tid++;
    }
  }
  return {
    tracks,
    nextTid: typeof saved.nextTid === "number"
      ? saved.nextTid
      : tracks.length + 1,
    lastObservationAt: null,
  };
}
