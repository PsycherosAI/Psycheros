/**
 * Mood affinity tests — the host-side relationship weighting over declared
 * modifiers. Pins the contract: only connection scales, factor = 1 +
 * affinity clamped [0..2], unset subjects and no-subject modifiers pass
 * through untouched, invalid settings values read as neutral.
 *
 * Dormant period: the connection axis is temporarily
 * dropped from MoodModifier, so connection-bearing modifiers are built
 * through the widened type the module itself reads. The scaling path
 * stays live for the day the axis returns (behavioral re-sourcing
 * pinned); live organs currently declare no connection fields.
 */

import { assertEquals } from "@std/assert";
import {
  affinityFactor,
  applyAffinity,
  normalizeAffinity,
} from "../src/mood-affinity.ts";
import type { MoodModifier } from "../src/types.ts";

/** The dormant-period shape: MoodModifier plus the resting axis. */
type WithConnection = MoodModifier & {
  connection?: number;
  pleasure?: number;
  arousal?: number;
};

Deno.test("affinityFactor: maps [-1..+1] to [0..2], clamps outside", () => {
  assertEquals(affinityFactor(0), 1);
  assertEquals(affinityFactor(1), 2);
  assertEquals(affinityFactor(-1), 0);
  assertEquals(affinityFactor(5), 2);
  assertEquals(affinityFactor(-5), 0);
});

Deno.test("normalizeAffinity: clamps and rejects junk", () => {
  assertEquals(normalizeAffinity(0.7), 0.7);
  assertEquals(normalizeAffinity(42), 1);
  assertEquals(normalizeAffinity("warm"), 0);
  assertEquals(normalizeAffinity(undefined), 0);
  assertEquals(normalizeAffinity(Number.NaN), 0);
});

Deno.test("applyAffinity: scales connection only", () => {
  const mod: WithConnection = {
    connection: 0.15,
    pleasure: 0.05,
    arousal: 0.05,
    weight: 1,
    source: "motion-vision:arrival",
    subject: "alex",
  };
  const out = applyAffinity(mod, { alex: 1 }) as WithConnection;
  assertEquals(out.connection, 0.30);
  assertEquals(out.pleasure, 0.05, "pleasure is not a relationship question");
  assertEquals(out.arousal, 0.05);
});

Deno.test("applyAffinity: unfavorable arrival nulls the welcome", () => {
  const mod: WithConnection = {
    connection: 0.15,
    weight: 1,
    source: "motion-vision:arrival",
    subject: "alex",
  };
  assertEquals(
    (applyAffinity(mod, { alex: -1 }) as WithConnection).connection,
    0,
  );
});

Deno.test("applyAffinity: departure sag scales with affinity too", () => {
  const mod: WithConnection = {
    connection: -0.12,
    weight: 1,
    source: "motion-vision:departure",
    subject: "alex",
  };
  // Someone favorable leaving hurts double; unfavorable barely registers.
  assertEquals(
    (applyAffinity(mod, { alex: 1 }) as WithConnection).connection,
    -0.24,
  );
  assertEquals(
    (applyAffinity(mod, { alex: -0.5 }) as WithConnection).connection,
    -0.06,
  );
});

Deno.test("applyAffinity: unset subject passes through unchanged", () => {
  const mod: WithConnection = {
    connection: 0.15,
    weight: 1,
    source: "motion-vision:arrival",
    subject: "someone-else",
  };
  assertEquals(applyAffinity(mod, { alex: 1 }), mod);
});

Deno.test("applyAffinity: no subject passes through unchanged", () => {
  const mod: MoodModifier = {
    arousal: 0.10,
    weight: 1,
    source: "motion-vision:arrival",
  };
  assertEquals(applyAffinity(mod, { alex: 1 }), mod);
});

Deno.test("applyAffinity: neutral entry (0) is exactly the declared value", () => {
  const mod: WithConnection = {
    connection: 0.15,
    weight: 1,
    source: "motion-vision:arrival",
    subject: "alex",
  };
  assertEquals(applyAffinity(mod, { alex: 0 }), mod);
});

Deno.test("applyAffinity: invalid settings value reads as neutral", () => {
  const mod: WithConnection = {
    connection: 0.15,
    weight: 1,
    source: "motion-vision:arrival",
    subject: "alex",
  };
  assertEquals(applyAffinity(mod, { alex: "very" as unknown as number }), mod);
});
