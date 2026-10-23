/**
 * Texture expiry: a texture dies when the
 * window it describes has fully passed — its own cadence is the expiry,
 * with no slack. Legacy snapshots (no stamp) count as expired. No LLM
 * needed: seed() places textures directly and get() applies the policy.
 */
import { assertEquals } from "@std/assert";
import { Compaction } from "../src/compaction.ts";
import type { SmallLLMRunner } from "../src/small-llm-runner.ts";
import type { Tier1Store } from "../src/tier1-store.ts";

function makeCompaction(): Compaction {
  return new Compaction(
    {
      tier1: null as unknown as Tier1Store,
      smallLLM: null as unknown as SmallLLMRunner,
      getMoodRender: () => "",
    },
    { cadenceMs: 15 * 60_000, longformCadenceMs: 60 * 60_000 },
  );
}

Deno.test("texture reads back within its window", () => {
  const c = makeCompaction();
  const now = Date.now();
  c.seed("noticing", {
    short: "a quiet stretch",
    shortWrittenAt: now - 5 * 60_000,
    long: "an uneventful hour",
    longWrittenAt: now - 30 * 60_000,
  });
  assertEquals(c.get("noticing", now).short, "a quiet stretch");
  assertEquals(c.get("noticing", now).long, "an uneventful hour");
});

Deno.test("short texture expires when its 15-minute window has passed", () => {
  const c = makeCompaction();
  const now = Date.now();
  c.seed("noticing", {
    short: "the previous window",
    shortWrittenAt: now - 16 * 60_000,
  });
  assertEquals(c.get("noticing", now).short, null);
});

Deno.test("long texture expires when its hour has passed", () => {
  const c = makeCompaction();
  const now = Date.now();
  c.seed("reverie", {
    long: "a warm era answering for a bad one",
    longWrittenAt: now - 61 * 60_000,
  });
  assertEquals(c.get("reverie", now).long, null);
});

Deno.test("missing stamp (legacy snapshot) reads as expired", () => {
  const c = makeCompaction();
  c.seed("noticing", { short: "written before expiry existed" });
  assertEquals(c.get("noticing").short, null);
  assertEquals(c.get("noticing").long, null);
});

Deno.test("expiry is per-scale, not per-chain", () => {
  const c = makeCompaction();
  const now = Date.now();
  c.seed("noticing", {
    short: "still inside its window",
    shortWrittenAt: now - 60_000,
    long: "past its hour",
    longWrittenAt: now - 2 * 60 * 60_000,
  });
  const t = c.get("noticing", now);
  assertEquals(t.short, "still inside its window");
  assertEquals(t.long, null);
});
