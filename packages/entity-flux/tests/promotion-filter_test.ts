/**
 * Promotion filter tests — the narrow waist deserves direct tests.
 *
 * Constructs observations with known embeddings (orthogonal vs. similar)
 * and verifies the amplitude / relevance / corroboration / combined
 * decisions, plus the escalation threshold.
 */

import { assertEquals, assertExists } from "@std/assert";
import { runPromotionFilter } from "../src/promotion-filter.ts";
import { getDefaultPromotionThresholds } from "../src/settings.ts";
import type { FluxObservation } from "../src/types.ts";

/** Build a 384-dim unit-ish vector with a 1.0 at index `i` (orthogonal family). */
function basisVector(i: number, len = 384): number[] {
  const v = new Array(len).fill(0);
  v[i] = 1;
  return v;
}

function makeObservation(
  id: string,
  salience: number,
  embedding: number[],
): FluxObservation {
  return {
    id,
    timestamp: new Date().toISOString(),
    sourceOrganId: "test-organ",
    content: "test observation " + id,
    salience,
    embedding,
    tags: [],
    promoted: false,
  };
}

const T = getDefaultPromotionThresholds();

Deno.test("promotion filter: below salience gate is not promoted", () => {
  const obs = makeObservation("a", T.salience - 0.1, basisVector(0));
  const result = runPromotionFilter(
    [obs],
    basisVector(0),
    T,
    () => [],
  );
  assertEquals(result.promoted.length, 0);
});

Deno.test("promotion filter: high salience + matching focus + corroboration promotes", () => {
  // Two observations with the SAME embedding → corroboration. Salience
  // high enough that, with relevance 1.0 and one corroborator (boost
  // 0.4), combined = 0.9*0.4 + 1.0*0.3 + 0.4*0.3 = 0.78 ≥ escalation.
  const focus = basisVector(1);
  const obs1 = makeObservation("a", 0.9, basisVector(1));
  const obs2 = makeObservation("b", 0.9, basisVector(1));
  const lookup = (emb: number[], _threshold: number, _since: string) =>
    [obs1, obs2].filter((o) =>
      o.embedding!.some((v, i) => v !== 0 && emb[i] !== 0)
    );
  const result = runPromotionFilter([obs1, obs2], focus, T, lookup);
  assertEquals(result.promoted.length, 2);
  assertExists(result.escalateToEgo);
});

Deno.test("promotion filter: orthogonal embedding to focus has low relevance", () => {
  const focus = basisVector(0);
  const obs = makeObservation("a", 0.9, basisVector(1)); // orthogonal
  const result = runPromotionFilter([obs], focus, T, () => []);
  // Relevance ~0, no corroboration. combined = 0.9*0.4 + 0 + 0 = 0.36.
  // Below default combined threshold (0.5) → not promoted.
  assertEquals(result.promoted.length, 0);
});

Deno.test("promotion filter: observation without embedding is skipped", () => {
  const obs = makeObservation("a", 0.99, []);
  obs.embedding = undefined;
  const result = runPromotionFilter([obs], basisVector(0), T, () => []);
  assertEquals(result.promoted.length, 0);
});

Deno.test("promotion filter: promoted sorted by combined score descending", () => {
  const focus = basisVector(0);
  const low = makeObservation("low", 0.6, basisVector(0));
  const high = makeObservation("high", 0.95, basisVector(0));
  const result = runPromotionFilter([low, high], focus, T, () => []);
  assertEquals(result.promoted.length, 2);
  assertEquals(result.promoted[0].observation.id, "high");
  assertEquals(result.promoted[1].observation.id, "low");
});

// =============================================================================
// Effective salience — declared novelty (surprise tag) multiplies in
// =============================================================================

Deno.test("effective salience: familiar scene (surprise 0) halves a hot salience", () => {
  // The live case: noticing rates settled presence 0.85, the stage says
  // it's the same room as always (surprise ≈ 0) → effective ~0.43, below
  // the promote gate.
  const obs = makeObservation("familiar", 0.85, basisVector(0));
  obs.tags = ["presence", "thalamus:slot", "surprise:0.00"];
  const result = runPromotionFilter(
    [obs],
    basisVector(0),
    T,
    () => [],
  );
  assertEquals(
    result.promoted.length,
    0,
    "0.85 on a familiar scene must not promote",
  );
});

Deno.test("effective salience: novel observation (surprise ≥ 1.5) keeps full strength", () => {
  const obs = makeObservation("novel", 0.85, basisVector(0));
  obs.tags = ["surprise:1.50"];
  const corroborators = [
    makeObservation("c1", 0.8, basisVector(0)),
    makeObservation("c2", 0.8, basisVector(0)),
  ];
  const result = runPromotionFilter(
    [obs],
    basisVector(0),
    T,
    () => corroborators,
  );
  assertEquals(
    result.promoted.length,
    1,
    "genuinely novel observation promotes",
  );
  assertExists(result.escalateToEgo, "and escalates");
});

Deno.test("effective salience: no tag = raw salience, existing behavior unchanged", () => {
  const obs = makeObservation("plain", 0.85, basisVector(0));
  const result = runPromotionFilter(
    [obs],
    basisVector(0),
    T,
    () => [],
  );
  assertEquals(
    result.promoted.length,
    1,
    "organs that declare nothing are unaffected",
  );
});

Deno.test("effective salience: deeply conforming (negative surprise) floors at 0.15x", () => {
  const obs = makeObservation("boring", 0.9, basisVector(0));
  obs.tags = ["surprise:-2.00"];
  const result = runPromotionFilter(
    [obs],
    basisVector(0),
    T,
    () => [],
  );
  assertEquals(result.promoted.length, 0, "0.9 × 0.15 = 0.135, below any gate");
});
