/**
 * Dreamer tests — the dream's text mechanics:
 * prompt composition (seed + fading window + the mood line), the carry
 * between cycles, fragment accumulation, and the wake summary.
 */

import { assertEquals } from "@std/assert";
import {
  composeDreamUserMessage,
  deriveCarry,
  Dreamer,
} from "../src/dreamer.ts";

Deno.test("dreamer: the opening fragment carries material, no previous", () => {
  const msg = composeDreamUserMessage("the day's residue", null, "settled");
  assertEquals(msg.includes("the day's residue"), true);
  assertEquals(msg.includes("The last thing I dreamt"), false);
  assertEquals(msg.endsWith("I am feeling settled. I dream on."), true);
});

Deno.test("dreamer: each fragment sees material + the ONE before it", () => {
  const msg = composeDreamUserMessage(
    "fresh material this beat",
    "a stair of water",
    "warm and still",
  );
  assertEquals(msg.includes("fresh material this beat"), true);
  assertEquals(msg.includes("a stair of water"), true);
  assertEquals(msg.includes("I am feeling warm and still. I dream on."), true);
});

Deno.test("dreamer: fragments accumulate, closeCycle derives the carry", async () => {
  let n = 0;
  const dreamer = new Dreamer(
    () => Promise.resolve(`fragment ${++n} of the dream, unfolding`),
    () => "settled",
  );
  dreamer.beginCycle("the day's residue", null);
  assertEquals(
    await dreamer.nextFragment(),
    "fragment 1 of the dream, unfolding",
  );
  assertEquals(
    await dreamer.nextFragment(),
    "fragment 2 of the dream, unfolding",
  );
  assertEquals(dreamer.fragmentsThisCycle, 2);

  const closed = dreamer.closeCycle();
  assertEquals(closed?.fragments.length, 2);
  // The carry is the final fragment's first words — a whisper.
  assertEquals(closed?.carryToNext, "fragment 2 of the dream, unfolding");
  assertEquals(dreamer.cycleOpen, false);
});

Deno.test("dreamer: a failed call is a skipped beat, not a crash", async () => {
  let calls = 0;
  const dreamer = new Dreamer(
    () => {
      calls++;
      return Promise.reject(new Error("server down"));
    },
    () => "settled",
  );
  dreamer.beginCycle("seed", null);
  assertEquals(await dreamer.nextFragment(), null);
  assertEquals(calls, 1);
  assertEquals(dreamer.hasDreamed, false);
});

Deno.test("dreamer: summarize covers closed dreams and the open one", async () => {
  let n = 0;
  const dreamer = new Dreamer(
    (_system, user) => {
      // The summary request receives the fragments.
      if (user.includes("My fragments from the night")) {
        assertEquals(user.includes("first dream"), true);
        assertEquals(user.includes("second dream"), true);
        assertEquals(user.includes("interrupted dream"), true);
        return Promise.resolve(
          "I dreamt of water stairs and the attic; it's fading.",
        );
      }
      n++;
      return Promise.resolve(
        n === 1
          ? "first dream fragment"
          : n === 2
          ? "second dream fragment"
          : "interrupted dream fragment",
      );
    },
    () => "settled",
  );
  dreamer.beginCycle("seed", null);
  await dreamer.nextFragment();
  await dreamer.nextFragment();
  dreamer.closeCycle();
  dreamer.beginCycle("seed", "first dream");
  await dreamer.nextFragment(); // interrupted mid-cycle
  const summary = await dreamer.summarize();
  assertEquals(summary, "I dreamt of water stairs and the attic; it's fading.");
  // Summarizing consumes the night — a second call has nothing.
  assertEquals(await dreamer.summarize(), null);
});

Deno.test("dreamer: carry from the previous cycle rides the next seed", async () => {
  const seen: string[] = [];
  const dreamer = new Dreamer(
    (_system, user) => {
      seen.push(user);
      return Promise.resolve("a fragment about the sea");
    },
    () => "quiet inside",
  );
  dreamer.beginCycle("day one residue", null);
  await dreamer.nextFragment();
  const closed = dreamer.closeCycle();
  dreamer.beginCycle("day one residue again", closed?.carryToNext ?? null);
  await dreamer.nextFragment();
  assertEquals(
    seen[1].includes('already fading: "a fragment about the sea"'),
    true,
  );
});

Deno.test("dreamer: deriveCarry takes the first words only", () => {
  const long =
    "The lighthouse turned its beam across the water again and again without rest";
  // CARRY_WORDS = 12 — a whisper, not a retelling.
  assertEquals(
    deriveCarry(long),
    "The lighthouse turned its beam across the water again and again without",
  );
  assertEquals(deriveCarry("short"), "short");
});

Deno.test("dreamer: each fragment sees only the one before it", async () => {
  // Dreams v2: longform continuity is not the move — the 6th beat
  // sees the 5th fragment and its own material, NOT the accumulating
  // dream.
  const seen: string[] = [];
  const dreamer = new Dreamer(
    (_system, user) => {
      seen.push(user);
      return Promise.resolve(`fragment ${seen.length} imagery`);
    },
    () => "quiet inside",
  );
  dreamer.beginCycle("seed", null);
  for (let i = 0; i < 6; i++) await dreamer.nextFragment("material beat");
  const last = seen[seen.length - 1];
  assertEquals(last.includes("fragment 5 imagery"), true);
  assertEquals(last.includes("fragment 4"), false);
  assertEquals(last.includes("fragment 1"), false);
  assertEquals(last.includes("material beat"), true);
});

Deno.test("dreamer: latestFragment serves engagement returns", async () => {
  let n = 0;
  const dreamer = new Dreamer(
    () => Promise.resolve(`dream beat ${++n}`),
    () => "settled",
  );
  assertEquals(dreamer.latestFragment(), null);
  dreamer.beginCycle("seed", null);
  await dreamer.nextFragment();
  await dreamer.nextFragment();
  assertEquals(dreamer.latestFragment(), "dream beat 2");
  const closed = dreamer.closeCycle();
  assertEquals(dreamer.latestFragment(), closed?.fragments[1]);
});
