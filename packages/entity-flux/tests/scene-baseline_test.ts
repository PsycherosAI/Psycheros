/**
 * Scene baseline tests — the stage/actor factorization pinned. The cases
 * that matter most (canonical, from the design conversation):
 *
 * - a sneeze inside a familiar scene is an EVENT — never habituated, never
 *   merged into the stage (events can't pollute the baseline);
 * - desk↔couch oscillation RECOGNIZES ring scenes instead of churning new
 *   ones;
 * - sustained change then settling establishes a new scene (the café);
 * - conforming captions EMA the stage along (lighting drift);
 * - surprise is contrast-normalized: the same novelty means more in a
 *   quiet room than a noisy one.
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildScenePromptPrefix,
  capSummary,
  currentSceneSummary,
  freshSceneBaseline,
  restoreSceneBaseline,
  type SceneBaselineConfig,
  type SceneObservation,
  stepSceneBaseline,
} from "../src/organs/motion-vision/scene-baseline.ts";

const config: SceneBaselineConfig = {
  recognizeThreshold: 0.8,
  settleMs: 8_000,
  ringSize: 3,
  updateRate: 0.15,
  summaryCapChars: 280,
};

/** Orthogonal toy embedding axes. */
function axis(dim: number, i: number): number[] {
  const v = new Array(dim).fill(0);
  v[i % dim] = 1;
  return v;
}

/** Blend two axes toward each other (similarity between axes). */
function blend(dim: number, i: number, j: number, t: number): number[] {
  const v = new Array(dim).fill(0);
  v[i % dim] = Math.cos(t * Math.PI / 2);
  v[j % dim] = Math.sin(t * Math.PI / 2);
  return v;
}

function obs(
  summary: string,
  embedding: number[],
  at: number,
): SceneObservation {
  return { summary, embedding, at: now0 + at };
}
const now0 = 1_000_000;

Deno.test("first caption establishes the initial stage", () => {
  const r = stepSceneBaseline(
    freshSceneBaseline(),
    obs("warm room, orange couch, user at the desk", axis(8, 0), 0),
    config,
  );
  assertEquals(r.result.kind, "established");
  assertEquals(
    r.result.establishedSummary,
    "warm room, orange couch, user at the desk",
  );
  assertEquals(
    currentSceneSummary(r.state),
    "warm room, orange couch, user at the desk",
  );
  assert(r.result.promptPrefix?.includes("orange couch"));
});

Deno.test("conforming captions EMA into the stage without changing kind", () => {
  let state = stepSceneBaseline(
    freshSceneBaseline(),
    obs("desk scene", axis(8, 0), 0),
    config,
  ).state;
  // Slight drift (lighting change) — still conforming.
  const r = stepSceneBaseline(
    state,
    obs("desk scene, slightly dimmer", blend(8, 0, 1, 0.1), 5_000),
    config,
  );
  assertEquals(r.result.kind, "conforming");
  assertEquals(
    r.result.novelty < 0.05,
    true,
    "conforming captions read low novelty",
  );
  state = r.state;
  // The stage embedding moved (EMA) — the next conforming check uses it.
  const r2 = stepSceneBaseline(
    state,
    obs("desk scene, slightly dimmer", blend(8, 0, 1, 0.1), 10_000),
    config,
  );
  assertEquals(r2.result.kind, "conforming");
});

Deno.test("THE SNEEZE: an event caption is novel and never merges into the stage", () => {
  let state = stepSceneBaseline(
    freshSceneBaseline(),
    obs("user sitting at the desk", axis(8, 0), 0),
    config,
  ).state;
  // Deeply habituate the stage.
  for (let t = 5_000; t <= 60_000; t += 5_000) {
    state = stepSceneBaseline(
      state,
      obs("user sitting at the desk", axis(8, 0), t),
      config,
    ).state;
  }
  const before = [...state.ring[state.currentIndex!].embedding];

  // The sneeze: same scene, new event. Embedding off-axis but recognizably
  // related (cos ≈ 0.76 — below conform, above unrelated).
  const sneeze = stepSceneBaseline(
    state,
    obs("the user sneezes", blend(8, 0, 2, 0.45), 65_000),
    config,
  );
  assertEquals(
    ["event", "settling"].includes(sneeze.result.kind),
    true,
    `a single delta caption is an event or brief settling, got ${sneeze.result.kind}`,
  );
  assertEquals(
    sneeze.result.novelty > 0.2,
    true,
    "the sneeze reads as novel against the stage",
  );

  // Back to conforming right after — the sneeze left no trace.
  const after = stepSceneBaseline(
    sneeze.state,
    obs("user sitting at the desk", axis(8, 0), 70_000),
    config,
  );
  assertEquals(after.result.kind, "conforming");
  const stage = after.state.ring[after.state.currentIndex!].embedding;
  let drift = 0;
  for (let i = 0; i < stage.length; i++) drift += (stage[i] - before[i]) ** 2;
  // The sneeze's embedding never EMA'd in (only the conforming caption did,
  // and it matched `before` exactly).
  assertEquals(drift < 1e-9, true, "events never pollute the stage");
});

Deno.test("couch→desk oscillation recognizes instead of churning", () => {
  let state = stepSceneBaseline(
    freshSceneBaseline(),
    obs("desk scene", axis(8, 0), 0),
    config,
  ).state;
  // Move to the couch: sustained non-conforming captions. The ESTABLISH
  // fires mid-loop (after settleMs); later couch captions conform to it —
  // so assert on what happened during the loop, not the last step.
  const couchKinds: string[] = [];
  for (let t = 5_000; t <= 30_000; t += 5_000) {
    const r = stepSceneBaseline(
      state,
      obs("couch scene", axis(8, 1), t),
      config,
    );
    state = r.state;
    couchKinds.push(r.result.kind);
  }
  assertEquals(
    couchKinds.includes("settling") && couchKinds.includes("established"),
    true,
    `sustained change settles then establishes: ${couchKinds.join(",")}`,
  );
  assertEquals(state.ring.length, 2, "the couch became a second ring scene");
  assertEquals(currentSceneSummary(state), "couch scene");

  // Back at the desk: sustained → RECOGNIZED (the ring holds it), and the
  // ring does not grow.
  const deskKinds: string[] = [];
  for (let t = 35_000; t <= 60_000; t += 5_000) {
    const r = stepSceneBaseline(
      state,
      obs("desk scene", axis(8, 0), t),
      config,
    );
    state = r.state;
    deskKinds.push(r.result.kind);
  }
  assertEquals(
    deskKinds.includes("recognized"),
    true,
    `returning to the desk recognizes the ring scene: ${deskKinds.join(",")}`,
  );
  assertEquals(state.ring.length, 2, "recognition, not churn");
  assertEquals(currentSceneSummary(state), "desk scene");
});

Deno.test("ring evicts the stalest scene at capacity", () => {
  let state = stepSceneBaseline(
    freshSceneBaseline(),
    obs("scene A", axis(8, 0), 0),
    config,
  ).state;
  // Fill the ring with B, C (capacity 3).
  let r;
  for (let t = 5_000; t <= 30_000; t += 5_000) {
    r = stepSceneBaseline(state, obs("scene B", axis(8, 1), t), config);
    state = r.state;
  }
  for (let t = 35_000; t <= 60_000; t += 5_000) {
    r = stepSceneBaseline(state, obs("scene C", axis(8, 2), t), config);
    state = r.state;
  }
  assertEquals(state.ring.length, 3);
  // A fourth scene evicts the stalest (A — left earliest).
  for (let t = 65_000; t <= 90_000; t += 5_000) {
    r = stepSceneBaseline(state, obs("scene D", axis(8, 3), t), config);
    state = r.state;
  }
  assertEquals(state.ring.length, 3, "ring stays at capacity");
  assertEquals(
    state.ring.some((s) => s.summary === "scene A"),
    false,
    "the stalest scene was evicted",
  );
});

Deno.test("surprise is contrast-normalized", () => {
  // Quiet room: identical conforming captions — novelty ~0, and a
  // modest novelty spike towers over that baseline.
  let state = stepSceneBaseline(
    freshSceneBaseline(),
    obs("quiet room", axis(8, 0), 0),
    config,
  ).state;
  for (let t = 5_000; t <= 120_000; t += 5_000) {
    state =
      stepSceneBaseline(state, obs("quiet room", axis(8, 0), t), config).state;
  }
  const quietSpike = stepSceneBaseline(
    state,
    obs("something moved", blend(8, 0, 2, 0.45), 125_000),
    config,
  );
  const quietSurprise = quietSpike.result.surprise;
  const quietNovelty = quietSpike.result.novelty;

  // Busy room: a stable stage with constant mild jitter (each caption a
  // little novel — the bustle noise floor), no scene churn. The SAME-SIZED
  // spike is less remarkable against that raised floor.
  let noisyState = stepSceneBaseline(
    freshSceneBaseline(),
    obs("busy café", blend(8, 4, 5, 0.25), 0),
    config,
  ).state;
  for (let t = 5_000; t <= 120_000; t += 5_000) {
    // Jitter around the stage: alternating off-axis blends, all conforming
    // (cos ≥ 0.8) but each ~0.1 novel — a sustained noise floor.
    const e = (t / 5_000) % 2 === 0 ? blend(8, 4, 5, 0.0) : blend(8, 4, 5, 0.5);
    noisyState = stepSceneBaseline(
      noisyState,
      obs("busy café bustle", e, t),
      config,
    ).state;
  }
  const noisySpike = stepSceneBaseline(
    noisyState,
    obs("something moved", blend(8, 4, 6, 0.45), 125_000),
    config,
  );
  assertEquals(
    Math.abs(noisySpike.result.novelty - quietNovelty) < 0.15,
    true,
    `spikes are comparably novel (${quietNovelty.toFixed(2)} vs ${
      noisySpike.result.novelty.toFixed(2)
    })`,
  );
  assertEquals(
    quietSurprise > noisySpike.result.surprise,
    true,
    `same novelty means more in a quiet room (${quietSurprise.toFixed(2)} vs ${
      noisySpike.result.surprise.toFixed(2)
    })`,
  );
});

Deno.test("prompt prefix carries the stage, delta instruction, and grounding", () => {
  const p = buildScenePromptPrefix("orange couch, warm lamp");
  assert(p.includes("orange couch"));
  assert(p.includes("NOW"));
  // The grounding sentence — validated on a real empty dark frame:
  // without it the captioner confabulates the baseline's person into
  // an empty room. Never remove.
  assert(p.includes("never invent presence"));
  assert(p.includes("frames outrank this baseline"));
  assert(p.length < 700, "prefix stays short — prefill discipline");
});

Deno.test("capSummary cuts at word boundaries", () => {
  const long = "a".repeat(100) + " " + "b".repeat(200);
  const capped = capSummary(long, 280);
  assert(capped.length <= 281); // cap + ellipsis
  assert(capped.endsWith("…"));
});

Deno.test("restoreSceneBaseline tolerates old/missing fields", () => {
  const r = restoreSceneBaseline({});
  assertEquals(r.ring.length, 0);
  assertEquals(r.currentIndex, null);
  const bad = restoreSceneBaseline({
    ring: [{ summary: "x", embedding: "not-an-array" } as unknown as never],
    currentIndex: 5,
  });
  assertEquals(bad.ring.length, 0, "invalid ring entries dropped");
  assertEquals(bad.currentIndex, null, "dangling index nulled");
});
