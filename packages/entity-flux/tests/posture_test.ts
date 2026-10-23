/**
 * Posture tests — enter/exit exclusivity, reverie-pass cycles, the
 * sleep threshold, snapshot round-trip.
 */

import { assertEquals } from "@std/assert";
import {
  CYCLE_PASSES,
  DREAM_CYCLE_FRAGMENTS,
  PostureState,
} from "../src/posture.ts";

Deno.test("posture: enter and exit are exclusive and reset cycles", () => {
  const p = new PostureState();
  assertEquals(p.enterSleep(), true);
  assertEquals(p.enterSleep(), false); // already sleeping
  p.noteReveriePass();
  assertEquals(p.exitSleep(), true);
  assertEquals(p.exitSleep(), false); // already awake
  assertEquals(p.sleepCycles, 0);
  assertEquals(p.passesInCycle, 0);
});

Deno.test("posture: passes only count while sleeping", () => {
  const p = new PostureState();
  for (let i = 0; i < 20; i++) {
    assertEquals(p.noteReveriePass().kind, "pass");
  }
  assertEquals(p.sleepCycles, 0);
});

Deno.test("posture: every CYCLE_PASSES-th pass is a cycle-top", () => {
  const p = new PostureState();
  p.enterSleep();
  let tops = 0;
  for (let i = 0; i < CYCLE_PASSES * 2 + 3; i++) {
    const r = p.noteReveriePass();
    if (r.kind === "cycle-top") {
      tops++;
      assertEquals(r.cycles, tops);
    }
  }
  assertEquals(tops, 2);
  assertEquals(p.sleepCycles, 2);
  assertEquals(p.passesInCycle, 3); // partial cycle remains
});

Deno.test("posture: sleep raises the escalation threshold", () => {
  const p = new PostureState();
  assertEquals(p.effectiveEscalationThreshold(0.75), 0.75);
  p.enterSleep();
  assertEquals(p.effectiveEscalationThreshold(0.75), 0.9);
});

Deno.test("posture: snapshot round-trip preserves a chosen sleep", () => {
  const a = new PostureState();
  a.enterSleep();
  for (let i = 0; i < 4; i++) a.noteReveriePass();
  const snap = a.export();
  const b = new PostureState();
  b.restore(snap);
  assertEquals(b.isSleeping, true);
  assertEquals(b.passesInCycle, 4);
});

Deno.test("posture: dream fragments are the sleep clock (dreams v1)", () => {
  const p = new PostureState();
  // Awake: fragments don't count.
  assertEquals(p.noteDreamFragment().kind, "pass");
  p.enterSleep();
  for (let i = 0; i < DREAM_CYCLE_FRAGMENTS - 1; i++) {
    assertEquals(p.noteDreamFragment().kind, "pass");
  }
  const top = p.noteDreamFragment();
  assertEquals(top.kind, "cycle-top");
  if (top.kind === "cycle-top") assertEquals(top.cycles, 1);
  assertEquals(p.passesInCycle, 0); // new cycle begins
});

Deno.test("posture: dream cycle threshold is parameterized (tunable setting)", () => {
  const p = new PostureState();
  p.enterSleep();
  assertEquals(p.noteDreamFragment(3).kind, "pass");
  assertEquals(p.noteDreamFragment(3).kind, "pass");
  assertEquals(p.noteDreamFragment(3).kind, "cycle-top");
});
