/**
 * Tier-2 double-post tests — one observation, one timeline row. Two
 * writers race the same observation onto the timeline (the engagement
 * wire posting at wake-verdict time vs a promotion batch that already
 * passed its "already posted?" check): the partial unique index on
 * source_observation_id makes the insertion itself the arbiter, and
 * the losing writer's carriage (broadcast, ambient briefing) is
 * dropped — the same observation never reaches the Ego twice as two
 * identical thoughts.
 */

import { assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";
import { initializeFluxSchema } from "../src/schema.ts";
import {
  hasDurableEntryForObservation,
  insertDurableEntry,
} from "../src/tier2-store.ts";
import type { FluxDurableEntry } from "../src/types.ts";

function obsEntry(
  id: string,
  observationId: string,
  content: string,
): FluxDurableEntry {
  return {
    id,
    timestamp: new Date().toISOString(),
    role: "ambient",
    content,
    sourceObservationId: observationId,
    metadata: { organId: "motion-vision", salience: 0.6 },
  };
}

Deno.test("tier2 dedup: second writer's row is skipped, first survives", () => {
  const db = new Database(":memory:");
  initializeFluxSchema(db);
  const first = insertDurableEntry(
    db,
    obsEntry("r1", "obs-1", "the same caption, first writer"),
  );
  const second = insertDurableEntry(
    db,
    obsEntry("r2", "obs-1", "the same caption, second writer"),
  );
  assertEquals(first !== null, true); // the engagement wire's row lands
  assertEquals(second, null); // the racing writer is turned away
  assertEquals(hasDurableEntryForObservation(db, "obs-1"), true);
  const count = db.prepare(
    "SELECT count(*) c FROM flux_durable_entries WHERE source_observation_id = 'obs-1'",
  ).get() as { c: number };
  assertEquals(count.c, 1);
  db.close();
});

Deno.test("tier2 dedup: entries without an observation id post freely", () => {
  const db = new Database(":memory:");
  initializeFluxSchema(db);
  const murmur = (id: string): FluxDurableEntry => ({
    id,
    timestamp: new Date().toISOString(),
    role: "ambient",
    content: "a murmur may repeat itself",
    metadata: { organId: "musing", kind: "murmur" },
  });
  assertEquals(insertDurableEntry(db, murmur("m1")) !== null, true);
  assertEquals(insertDurableEntry(db, murmur("m2")) !== null, true);
  const count = db.prepare(
    "SELECT count(*) c FROM flux_durable_entries",
  ).get() as { c: number };
  assertEquals(count.c, 2);
  db.close();
});

Deno.test("tier2 dedup: startup migration sweeps the race's old rows", () => {
  const db = new Database(":memory:");
  initializeFluxSchema(db);
  // Recreate a pre-index database's state: drop the guard, let the
  // race's history in, then re-run the schema initializer — the sweep
  // removes the duplicates and the index comes back over clean rows.
  db.exec("DROP INDEX idx_flux_durable_one_row_per_obs");
  insertDurableEntry(db, obsEntry("a1", "obs-old", "older row"));
  insertDurableEntry(db, obsEntry("a2", "obs-old", "racing twin"));
  insertDurableEntry(db, obsEntry("a3", "obs-old2", "untouched row"));
  initializeFluxSchema(db);
  const rows = db.prepare(
    "SELECT id FROM flux_durable_entries ORDER BY rowid",
  ).all() as Array<{ id: string }>;
  assertEquals(rows.map((r) => r.id), ["a1", "a3"]); // earliest twin kept
  // And the index is live again: a new racing insert is refused.
  assertEquals(
    insertDurableEntry(db, obsEntry("a4", "obs-old", "late third")) === null,
    true,
  );
  db.close();
});
