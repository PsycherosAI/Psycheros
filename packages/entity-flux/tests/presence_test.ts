/**
 * Presence tracker tests — multi-object tracking with re-identification.
 * The canonical cases:
 *
 * - THE FLICKER: a tracked body with a sticky identity produces NO events
 *   when the face comes and goes — "I can't see her face" stopped existing
 *   as a report class; the report is "she is there";
 * - arrivals confirm after the debounce (dawn flicker never arrives);
 * - departures carry the track's identity and dwell time;
 * - occluded walking (body gone, sustained motion) holds the track;
 * - two people: the right one's departure is named;
 * - blindness freezes everything — a blind sensor is not an empty room.
 */

import { assertEquals } from "@std/assert";
import type { OrganEnvelope } from "../src/types.ts";
import {
  buildArrivalEnvelope,
  buildDepartureEnvelope,
  buildIdentityLostEnvelope,
  buildIdentitySeenEnvelope,
  freshPresence,
  type PresenceConfig,
  type PresenceObservation,
  type PresenceSnapshot,
  stepPresence,
} from "../src/organs/motion-vision/presence.ts";
import type { Box } from "../src/organs/motion-vision/types.ts";

const config: PresenceConfig = {
  arrivalDebounceMs: 3_000,
  trackGraceMs: 3_000,
  motionThreshold: 0.02,
  motionSustainMs: 3_000,
};

/** Person body box near (x,y). */
function body(x = 100, y = 100, w = 100, h = 180): Box {
  return [x, y, x + w, y + h];
}

/** Face box centered in the upper third of a body box. */
function faceIn(b: Box): Box {
  const w = b[2] - b[0], cx = (b[0] + b[2]) / 2;
  return [cx - w * 0.15, b[1] + 5, cx + w * 0.15, b[1] + 5 + w * 0.3];
}

/** Observation with a body (+ optionally a matched face inside it). */
function obs(
  at: number,
  opts: {
    bodies?: Box[];
    face?: { id: string; confidence: number } | null;
    motion?: number;
    ok?: boolean;
  } = {},
): PresenceObservation {
  const bodies = opts.bodies ?? [];
  const faceBox: Box = bodies.length > 0
    ? faceIn(bodies[0])
    : [130, 120, 170, 180]; // standalone face when the body flickered off
  const faces = opts.face ? [{ ...opts.face, box: faceBox }] : [];
  return {
    at,
    bodies,
    faces,
    motionScore: opts.motion ?? 0,
    recognizerOk: opts.ok ?? true,
  };
}

function drive(
  start: PresenceSnapshot,
  observations: PresenceObservation[],
): { snapshot: PresenceSnapshot; envelopes: OrganEnvelope[] } {
  let snap = start;
  const envelopes: OrganEnvelope[] = [];
  for (const o of observations) {
    const t = stepPresence(snap, o, config);
    snap = t.snapshot;
    envelopes.push(...t.envelopes);
  }
  return { snapshot: snap, envelopes };
}

const ALEX = { id: "alex", confidence: 0.8 };

Deno.test("THE FLICKER: face comes and goes, the track holds, no events", () => {
  const t0 = 100_000;
  // Arrive and get identified.
  let snap = freshPresence(t0);
  const arrived = drive(snap, [
    obs(t0, { bodies: [body()], face: ALEX }),
    obs(t0 + 1_000, { bodies: [body()], face: ALEX }),
    obs(t0 + 2_000, { bodies: [body()], face: ALEX }),
    obs(t0 + 3_500, { bodies: [body()], face: ALEX }),
  ]);
  snap = arrived.snapshot;
  assertEquals(snap.tracks.length, 1, "one track");
  assertEquals(snap.tracks[0].identity?.id, "alex", "identity sticky");
  assertEquals(
    arrived.envelopes.some((e) => e.perception.data.presence === "arrival"),
    true,
    "arrival fired at confirmation",
  );

  // The flicker: face visible / gone / visible / gone for minutes — body
  // always there. ZERO new events.
  const flicker = drive(snap, [
    obs(t0 + 5_000, { bodies: [body()], face: ALEX }),
    obs(t0 + 8_000, { bodies: [body()] }), // face gone
    obs(t0 + 12_000, { bodies: [body()], face: ALEX }),
    obs(t0 + 30_000, { bodies: [body()] }), // long face gap
    obs(t0 + 60_000, { bodies: [body()] }),
    obs(t0 + 90_000, { bodies: [body()], face: ALEX }),
    obs(t0 + 120_000, { bodies: [body()] }),
  ]);
  assertEquals(flicker.envelopes.length, 0, "no events during face flicker");
  assertEquals(
    flicker.snapshot.tracks[0].identity?.id,
    "alex",
    "identity survives face loss",
  );
});

Deno.test("arrival: track confirms after debounce; identity names it", () => {
  const t0 = 100_000;
  const { snapshot, envelopes } = drive(freshPresence(t0), [
    obs(t0, { bodies: [body()], face: ALEX }),
    obs(t0 + 1_000, { bodies: [body()], face: ALEX }),
    obs(t0 + 2_000, { bodies: [body()], face: ALEX }),
    obs(t0 + 3_200, { bodies: [body()], face: ALEX }),
  ]);
  assertEquals(snapshot.tracks[0].confirmedAt !== null, true, "confirmed");
  const arrivals = envelopes.filter((e) =>
    e.perception.data.presence === "arrival"
  );
  assertEquals(arrivals.length, 1);
  assertEquals(arrivals[0].perception.data.identity, "alex");
});

Deno.test("dawn flicker: sub-debounce bursts never arrive", () => {
  const t0 = 100_000;
  const { snapshot, envelopes } = drive(freshPresence(t0), [
    obs(t0, { bodies: [body()] }),
    obs(t0 + 1_500, { bodies: [body()] }),
    obs(t0 + 2_500, { bodies: [body()] }), // burst ends before 3s confirm
    obs(t0 + 20_000),
    obs(t0 + 40_000),
    obs(t0 + 60_000),
    obs(t0 + 80_000), // long gap: pending track dies silently
  ]);
  assertEquals(snapshot.tracks.length, 0, "phantom died unconfirmed");
  assertEquals(envelopes.length, 0, "no arrival, no departure for phantoms");
});

Deno.test("departure: track dies after grace + stillness, carries identity + dwell", () => {
  const t0 = 100_000;
  const present = drive(freshPresence(t0), [
    obs(t0, { bodies: [body()], face: ALEX }),
    obs(t0 + 1_500, { bodies: [body()], face: ALEX }),
    obs(t0 + 3_200, { bodies: [body()], face: ALEX }),
  ]).snapshot;

  const gone = drive(present, [
    obs(t0 + 5_000),
    obs(t0 + 8_000), // past grace — dying
    obs(t0 + 9_500), // still room — death confirms
  ]);
  assertEquals(gone.snapshot.tracks.length, 0, "track died");
  const departures = gone.envelopes.filter((e) =>
    e.perception.data.presence === "departure"
  );
  assertEquals(departures.length, 1);
  assertEquals(departures[0].perception.data.lastIdentity, "alex");
  assertEquals(
    (departures[0].perception.data.occupiedMs as number) >= 3_000,
    true,
    "dwell time carried",
  );
});

Deno.test("occluded walking: sustained motion holds the dying track", () => {
  const t0 = 100_000;
  const present = drive(freshPresence(t0), [
    obs(t0, { bodies: [body()], face: ALEX }),
    obs(t0 + 1_500, { bodies: [body()], face: ALEX }),
    obs(t0 + 3_200, { bodies: [body()], face: ALEX }),
  ]).snapshot;

  // Body gone but moving continuously (frames within the sustain window).
  const held = drive(present, [
    obs(t0 + 4_500, { motion: 0.1 }),
    obs(t0 + 5_500, { motion: 0.1 }),
    obs(t0 + 6_500, { motion: 0.1 }),
    obs(t0 + 7_500, { motion: 0.1 }),
  ]);
  assertEquals(held.snapshot.tracks.length, 1, "track held by motion");
  assertEquals(
    held.envelopes.filter((e) => e.perception.data.presence === "departure")
      .length,
    0,
  );
});

Deno.test("two people: the right departure is named", () => {
  const t0 = 100_000;
  const both = drive(freshPresence(t0), [
    obs(t0, { bodies: [body(100), body(500)], face: ALEX }),
    obs(t0 + 1_500, { bodies: [body(100), body(500)], face: ALEX }),
    obs(t0 + 3_200, { bodies: [body(100), body(500)], face: ALEX }),
    obs(t0 + 5_000, { bodies: [body(100), body(500)], face: ALEX }),
  ]).snapshot;
  assertEquals(both.tracks.length, 2, "two tracks");
  const named = both.tracks.find((t) => t.identity?.id === "alex");
  const unnamed = both.tracks.find((t) => !t.identity);
  assertEquals(
    named !== undefined && unnamed !== undefined,
    true,
    "face assigned to exactly one body",
  );

  // The UNNAMED person leaves (their box disappears).
  const after = drive(both, [
    obs(t0 + 7_000, { bodies: [body(100)], face: ALEX }),
    obs(t0 + 11_000, { bodies: [body(100)], face: ALEX }),
    obs(t0 + 12_500, { bodies: [body(100)], face: ALEX }),
  ]);
  assertEquals(after.snapshot.tracks.length, 1, "one track remains");
  const departures = after.envelopes.filter((e) =>
    e.perception.data.presence === "departure"
  );
  assertEquals(departures.length, 1);
  assertEquals(
    departures[0].perception.data.lastIdentity,
    null,
    "the unnamed departure is honestly unnamed",
  );
});

Deno.test("blindness freezes everything", () => {
  const t0 = 100_000;
  const present = drive(freshPresence(t0), [
    obs(t0, { bodies: [body()], face: ALEX }),
    obs(t0 + 1_500, { bodies: [body()], face: ALEX }),
    obs(t0 + 3_200, { bodies: [body()], face: ALEX }),
  ]).snapshot;

  const blind = drive(present, [
    obs(t0 + 5_000, { ok: false }),
    obs(t0 + 60_000, { ok: false }),
    obs(t0 + 300_000, { ok: false }),
  ]);
  assertEquals(blind.snapshot.tracks.length, 1, "blind ≠ empty");
  assertEquals(blind.envelopes.length, 0);
});

Deno.test("identity-acquired: named once when the face sticks", () => {
  const t0 = 100_000;
  const { envelopes } = drive(freshPresence(t0), [
    obs(t0, { bodies: [body()], face: ALEX }),
    obs(t0 + 1_000, { bodies: [body()], face: ALEX }),
    obs(t0 + 2_000, { bodies: [body()], face: ALEX }), // 2nd hit: identity
    obs(t0 + 3_200, { bodies: [body()], face: ALEX }), // confirm arrival
    obs(t0 + 5_000, { bodies: [body()], face: ALEX }),
    obs(t0 + 8_000, { bodies: [body()], face: ALEX }), // no repeat "I see"
  ]);
  const seen = envelopes.filter((e) => e.perception.data.event === "seen");
  // Identity confirmed BEFORE arrival → the arrival names them; the
  // identity-acquired envelope is suppressed in favor of it.
  assertEquals(
    envelopes.filter((e) => e.perception.data.presence === "arrival")[0]
      .perception.data.identity,
    "alex",
  );
  assertEquals(seen.length, 0, "no duplicate seen when arrival names them");
});

Deno.test("mood: arrival of a known person carries the relational lift", () => {
  const e = buildArrivalEnvelope({
    at: 200_000,
    emptyMs: 60_000,
    match: { id: "alex", confidence: 0.8 },
  });
  const mod = e.moodModifiers?.[0];
  assertEquals(mod?.valence, 0.05);
  assertEquals(mod?.arousal, 0.05);
  assertEquals(mod?.weight, 1);
  assertEquals(mod?.source, "motion-vision:arrival");
});

Deno.test("mood: arrival lift no longer scales with absence duration", () => {
  // The absence-scaled lift WAS the connection axis (temporarily
  // dropped); the remaining axes are duration-independent.
  // Reactivates with the behavioral-connection arc.
  const short = buildArrivalEnvelope({
    at: 200_000,
    emptyMs: 60_000,
    match: { id: "alex", confidence: 0.8 },
  });
  const long = buildArrivalEnvelope({
    at: 200_000,
    emptyMs: 2 * 3_600_000,
    match: { id: "alex", confidence: 0.8 },
  });
  assertEquals(short.moodModifiers?.[0]?.valence, 0.05);
  assertEquals(long.moodModifiers?.[0]?.valence, 0.05);
});

Deno.test("mood: unknown arrival is pure novelty", () => {
  const e = buildArrivalEnvelope({ at: 200_000, emptyMs: 60_000, match: null });
  const mod = e.moodModifiers?.[0];
  assertEquals(mod?.arousal, 0.10);
  assertEquals(mod?.valence, undefined);
});

Deno.test("mood: departure is quieter, not sadder", () => {
  const e = buildDepartureEnvelope({
    at: 200_000,
    occupiedMs: 100_000,
    quietMs: 45_000,
    lastMatch: { id: "alex", confidence: 0.8, at: 155_000 },
  });
  const mod = e.moodModifiers?.[0];
  assertEquals(mod?.arousal, -0.04);
  assertEquals(
    mod?.valence,
    undefined,
    "no valence hit — aloneness is not unpleasant",
  );
});

Deno.test("mood: unknown departure is gentler", () => {
  const e = buildDepartureEnvelope({
    at: 200_000,
    occupiedMs: 100_000,
    quietMs: 45_000,
    lastMatch: null,
  });
  assertEquals(e.moodModifiers?.[0]?.arousal, -0.03);
});

Deno.test("mood: identity seen/lost carry no mood modifiers", () => {
  // The seen/lost blips existed purely for the connection axis
  // (temporarily dropped).
  const seen = buildIdentitySeenEnvelope({
    at: 200_000,
    id: "alex",
    confidence: 0.9,
    wasLostMs: 120_000,
  });
  const lost = buildIdentityLostEnvelope({
    at: 200_000,
    id: "alex",
    lastSeenAt: 190_000,
    stillPresent: true,
  });
  assertEquals(seen.moodModifiers, undefined);
  assertEquals(lost.moodModifiers, undefined);
});

Deno.test("body-flicker: face evidence keeps the track alive", () => {
  const t0 = 100_000;
  // Arrive + identify.
  const snap = drive(freshPresence(t0), [
    obs(t0, { bodies: [body()], face: ALEX }),
    obs(t0 + 1_000, { bodies: [body()], face: ALEX }),
    obs(t0 + 3_200, { bodies: [body()], face: ALEX }),
  ]).snapshot;
  assertEquals(snap.tracks.length, 1);

  // The desk-profile reality: body detector misses for LONG stretches
  // while the face detector still sees her. The face must keep the track.
  const held = drive(snap, [
    obs(t0 + 4_000, { face: ALEX }), // body missed, face present
    obs(t0 + 5_000, { face: ALEX }),
    obs(t0 + 6_000, { face: ALEX }),
    obs(t0 + 7_000, { face: ALEX }), // >trackGrace of no bodies — alive via face
    obs(t0 + 8_000, { bodies: [body()], face: ALEX }), // body back
  ]);
  assertEquals(held.snapshot.tracks.length, 1, "face kept the person alive");
  assertEquals(
    held.envelopes.filter((e) => e.perception.data.presence === "departure")
      .length,
    0,
    "no false departure during body flicker",
  );
  assertEquals(held.snapshot.tracks[0].identity?.id, "alex");
});

Deno.test("mirror geometry: face far from body still identifies the person", () => {
  const t0 = 100_000;
  const deskBody: Box = [75, 194, 231, 301]; // calibrated desk body
  const mirrorFace: Box = [487, 253, 786, 421]; // calibrated mirror face
  const { snapshot, envelopes } = drive(freshPresence(t0), [
    {
      at: t0,
      bodies: [deskBody],
      faces: [{ ...ALEX, box: mirrorFace }],
      motionScore: 0.1,
      recognizerOk: true,
    },
    {
      at: t0 + 1_000,
      bodies: [deskBody],
      faces: [{ ...ALEX, box: mirrorFace }],
      motionScore: 0.1,
      recognizerOk: true,
    },
    {
      at: t0 + 2_000,
      bodies: [deskBody],
      faces: [{ ...ALEX, box: mirrorFace }],
      motionScore: 0.1,
      recognizerOk: true,
    },
    {
      at: t0 + 3_200,
      bodies: [deskBody],
      faces: [{ ...ALEX, box: mirrorFace }],
      motionScore: 0.1,
      recognizerOk: true,
    },
  ]);
  assertEquals(
    snapshot.tracks.length,
    1,
    "one person — face adopted onto the lone track",
  );
  assertEquals(
    snapshot.tracks[0].identity?.id,
    "alex",
    "mirror face identifies the body",
  );
  const arrivals = envelopes.filter((e) =>
    e.perception.data.presence === "arrival"
  );
  assertEquals(arrivals.length, 1);
  assertEquals(arrivals[0].perception.data.identity, "alex");
});
