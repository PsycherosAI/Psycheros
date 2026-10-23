/**
 * Mood Organ tests — the event-driven redesign: state moves on input
 * and HOLDS between events (a slow fade toward neutral on the era
 * timescale is the only clock), Lately is a reporting window ticked
 * by external input only (the mirror-break: the entity's own voice
 * never feeds its era). The organ's math uses explicit `now`
 * timestamps, so time travel is arithmetic.
 */

import { assert, assertEquals } from "@std/assert";
import { MoodOrgan } from "../src/mood-organ.ts";

Deno.test("mood-organ: state HOLDS between events — no spring, no fast decay", () => {
  const t0 = 1_000_000;
  const organ = new MoodOrgan();
  organ.ingest(
    {
      valence: -0.8,
      arousal: 0.5,
      dominance: -0.6,
      weight: 1,
      source: "user-message",
    },
    t0,
  );
  // One hour later, NO input: the old design would have decayed back
  // to home (2-min half-life). The redesign fades ~30% at most (2h
  // half-life) — the feeling survives the silence.
  const s = organ.getState(t0 + 3_600_000);
  assert(s.valence < -0.55, `valence should hold (got ${s.valence})`);
  assert(s.arousal > 0.35, `arousal should hold (got ${s.arousal})`);
});

Deno.test("mood-organ: the slow fade lets go on the era timescale", () => {
  const t0 = Date.now();
  const organ = new MoodOrgan();
  organ.ingest({ valence: -0.8, weight: 1, source: "user-message" }, t0);
  const half = organ.getState(t0 + 2 * 3_600_000).valence; // ~2h half-life
  assert(
    Math.abs(half - -0.4) < 0.05,
    `one half-life should halve the feeling (got ${half})`,
  );
});

Deno.test("mood-organ: THE MIRROR-BREAK — his own voice never feeds Lately", () => {
  const t0 = Date.now();
  const external = new MoodOrgan();
  const internal = new MoodOrgan();
  for (let i = 0; i < 120; i++) {
    const t = t0 + i * 60_000;
    external.ingest(
      { valence: 0.3, weight: 0.4, source: "conscious-thinking" },
      t,
    );
    internal.ingest(
      { valence: 0.3, weight: 0.4, source: "conscious-thinking" },
      t,
    );
    external.ingest(
      { valence: -0.5, weight: 0.4, source: "user-message" },
      t + 30_000,
    );
  }
  const end = t0 + 2 * 3_600_000;
  const latelyExternal = external.getBaseline(end);
  const latelyInternal = internal.getBaseline(end);
  assert(
    latelyExternal.valence < -0.2,
    `external era should sink (got ${latelyExternal.valence})`,
  );
  assert(
    Math.abs(latelyInternal.valence - 0.1) < 0.01,
    `his voice alone must not move Lately (got ${latelyInternal.valence})`,
  );
});

Deno.test("mood-organ: state fades toward neutral, never toward Lately", () => {
  const t0 = Date.now();
  const organ = new MoodOrgan();
  // A long, hard external era (Lately sinks)...
  for (let i = 0; i < 121; i++) {
    organ.ingest(
      { valence: -0.6, weight: 0.4, source: "user-message" },
      t0 + i * 60_000,
    );
  }
  // ...then one strong positive event. Under the OLD spring, the
  // negative home would drag state back below zero within minutes;
  // the redesign only fades it gently toward neutral.
  organ.ingest(
    { valence: 1.0, weight: 1, source: "user-message" },
    t0 + 121 * 60_000,
  );
  const peak = organ.getState(t0 + 121 * 60_000).valence;
  const s = organ.getState(t0 + 121 * 60_000 + 3_600_000);
  // Design property: sustained input SATURATES the axis —
  // one counter-event cannot erase an era (state was clamped at -1; a
  // +1.0 lift lands at 0.0, not above). What must NOT happen is the
  // old spring: dragging back down toward the negative era within
  // minutes. An hour later, state sits at/above the lift, only gently
  // faded toward neutral.
  assert(
    Math.abs(peak) < 0.05,
    `the counter-event should land state at neutral (got ${peak})`,
  );
  assert(
    s.valence > -0.05,
    `an hour later state must not be dragged to the era (got ${s.valence})`,
  );
});

Deno.test("mood-organ: sleep still calms arousal", () => {
  const t0 = Date.now();
  const awake = new MoodOrgan();
  const asleep = new MoodOrgan();
  awake.ingest(
    { arousal: 0.8, valence: 0.5, weight: 1, source: "user-message" },
    t0,
  );
  asleep.ingest(
    { arousal: 0.8, valence: 0.5, weight: 1, source: "user-message" },
    t0,
  );
  asleep.setSleepDrift(true);
  const t1 = t0 + 300_000;
  const a = awake.getState(t1);
  const s = asleep.getState(t1);
  assertEquals(a.arousal > 0.7, true, "awake arousal holds (slow fade only)");
  assertEquals(s.arousal < a.arousal, true, "sleep pulls arousal toward calm");
});

Deno.test("mood-organ: the felt render names the emotion, never numbers", () => {
  const t0 = Date.now();
  const organ = new MoodOrgan();
  organ.ingest(
    {
      valence: -0.75,
      arousal: -0.35,
      dominance: -0.55,
      weight: 1,
      source: "user-message",
    },
    t0,
  );
  const terse = organ.renderTerse(t0);
  const felt = organ.renderFelt(t0);
  assertEquals(/I feel [a-z ]+/.test(terse), true);
  assertEquals(felt.includes("I feel"), true);
  assertEquals(/-?\d\.\d/.test(felt), false);
  assertEquals(/-?\d\.\d/.test(terse), false);
});

Deno.test("mood-organ: a quiet state is quiet inside, not a fabricated emotion", () => {
  const t0 = Date.now();
  const organ = new MoodOrgan();
  const terse = organ.renderTerse(t0);
  assertEquals(terse.includes("quiet inside"), true);
  assertEquals(organ.feltSense(t0), "quiet inside");
});

Deno.test("mood-organ: seedState sets state from the read, era untouched", () => {
  const organ = new MoodOrgan();
  organ.ingest(
    { valence: 0.5, weight: 1, source: "user-message" },
    Date.now(),
  );
  const before = organ.getState(Date.now());
  organ.seedState({ valence: -0.6, arousal: 0.3 });
  const after = organ.getState(Date.now());
  assertEquals(after.valence < 0.2, true);
  assertEquals(after.arousal > 0.2, true);
  const moved = Math.abs(after.valence - before.valence);
  assertEquals(moved > 0.4, true);
});

Deno.test("mood-organ: legacy snapshots (pleasure key) restore onto valence", () => {
  const organ = new MoodOrgan();
  const legacy = {
    state: {
      pleasure: 0.9,
      arousal: 0.3,
      dominance: 0.4,
      connection: 0.8,
      asOf: 1_000_000,
    },
    baseline: {
      pleasure: 0.85,
      arousal: 0.35,
      dominance: 0.39,
      connection: 0.77,
      asOf: 1_000_000,
    },
    lastUpdate: 1_000_000,
    moodEmbedding: null,
  };
  organ.restoreSnapshot(
    legacy as unknown as Parameters<MoodOrgan["restoreSnapshot"]>[0],
  );
  const s = organ.getState(1_000_000);
  assertEquals(s.valence, 0.9);
  assertEquals(organ.getBaseline(1_000_000).valence, 0.85);
});

Deno.test("mood-organ: a far-from-vocabulary state is hard to name, not mislabeled", () => {
  const t0 = Date.now();
  const organ = new MoodOrgan();
  // Elated-and-helpless: an axis-inconsistent blend with no vocabulary
  // word (grid-scan worst-covered point).
  organ.ingest(
    {
      valence: 1,
      arousal: 1,
      dominance: -1,
      weight: 1,
      source: "user-message",
    },
    t0,
  );
  const terse = organ.renderTerse(t0);
  assertEquals(
    terse.includes("hard to name"),
    true,
    `a true-gap state must not borrow a wrong word (got "${terse}")`,
  );
});
