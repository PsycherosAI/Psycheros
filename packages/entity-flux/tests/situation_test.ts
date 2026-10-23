/**
 * Situation detection tests — hysteresis (enter/exit), delta-driven
 * evaluation, inertness without a classifier, digest content.
 */

import { assertEquals } from "@std/assert";
import { DEFAULT_SENSORY_MODES, SituationDetector } from "../src/situation.ts";
import type { SituationClassifier } from "../src/situation.ts";

/** A classifier with a switchable verdict that counts its calls. */
function fake(topMode: string): {
  cls: SituationClassifier;
  calls: () => number;
  setTop: (m: string) => void;
  lastDigest: () => string;
} {
  let n = 0;
  let top = topMode;
  let digest = "";
  return {
    cls: (d) => {
      n++;
      digest = d;
      return Promise.resolve({ [top]: 1, other: 0.1 });
    },
    calls: () => n,
    setTop: (m) => top = m,
    lastDigest: () => digest,
  };
}

/** Note enough fresh material for one evaluation, then evaluate. */
async function cycle(det: SituationDetector, cls: SituationClassifier) {
  det.note("an observation of the moment");
  det.note("another line of narration");
  det.note("a third line accrues");
  return await det.maybeEvaluate(cls);
}

Deno.test("situation: enter requires sustained agreement", async () => {
  const det = new SituationDetector();
  const f = fake("absent");
  assertEquals(det.mode, null);
  assertEquals(await cycle(det, f.cls), null); // eval 1: pending, not entered
  assertEquals(f.calls(), 1);
  const change = await cycle(det, f.cls); // eval 2: agreement → enter
  assertEquals(change, { from: null, to: "absent" });
  assertEquals(det.mode, "absent");
});

Deno.test("situation: exit requires sustained disagreement", async () => {
  const det = new SituationDetector();
  const f = fake("absent");
  await cycle(det, f.cls);
  await cycle(det, f.cls);
  assertEquals(det.mode, "absent");
  f.setTop("intimate");
  assertEquals(await cycle(det, f.cls), null); // disagreement 1
  assertEquals(await cycle(det, f.cls), null); // disagreement 2
  assertEquals(det.mode, "absent"); // still holding
  const change = await cycle(det, f.cls); // disagreement 3 → switch
  assertEquals(change, { from: "absent", to: "intimate" });
});

Deno.test("situation: agreement resets exit pressure", async () => {
  const det = new SituationDetector();
  const f = fake("absent");
  await cycle(det, f.cls);
  await cycle(det, f.cls);
  f.setTop("intimate");
  await cycle(det, f.cls); // disagreement 1
  await cycle(det, f.cls); // disagreement 2
  f.setTop("absent"); // agreement returns
  assertEquals(await cycle(det, f.cls), null);
  f.setTop("intimate");
  assertEquals(await cycle(det, f.cls), null); // exit credit restarted
  assertEquals(await cycle(det, f.cls), null);
  assertEquals(det.mode, "absent"); // needed the full three again
  assertEquals((await cycle(det, f.cls))?.to, "intimate");
});

Deno.test("situation: delta gating — no material, no classifier call", async () => {
  const det = new SituationDetector();
  const f = fake("sleep");
  det.note("only one line");
  assertEquals(await det.maybeEvaluate(f.cls), null);
  assertEquals(f.calls(), 0); // never asked
});

Deno.test("situation: no classifier — inert", async () => {
  const det = new SituationDetector();
  for (let i = 0; i < 6; i++) det.note("narration with no engine attached");
  assertEquals(await det.maybeEvaluate(undefined), null);
  assertEquals(det.mode, null);
});

Deno.test("situation: digest carries the recent narration", async () => {
  const det = new SituationDetector();
  const f = fake("sleep");
  det.note("my user sat down at the desk");
  det.note("the lamp hums in the evening");
  det.note("a third observation arrives");
  await det.maybeEvaluate(f.cls);
  assertEquals(f.lastDigest().includes("lamp hums"), true);
});

Deno.test("situation: custom modes score; defaults ignored", async () => {
  const det = new SituationDetector([
    { name: "movie-night", description: "watching films together" },
  ]);
  const f = fake("movie-night");
  await cycle(det, f.cls);
  assertEquals((await cycle(det, f.cls))?.to, "movie-night");
});

Deno.test("situation: default mode set is the four", () => {
  assertEquals(
    DEFAULT_SENSORY_MODES.map((m) => m.name),
    ["normal", "absent", "intimate"],
  );
});

Deno.test("situation: sleep scores are ignored — postures own sleep", async () => {
  // A classifier that always says sleep: the detector must never enter
  // it (sleep is entity-chosen exclusively — THE SPLIT).
  const det = new SituationDetector();
  const f = fake("sleep");
  await cycle(det, f.cls);
  assertEquals(await cycle(det, f.cls), null);
  assertEquals(det.mode, null);
});
