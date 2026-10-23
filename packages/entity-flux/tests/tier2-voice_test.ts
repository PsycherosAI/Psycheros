/**
 * Tier-2 musing-voice query — the backing store for the musing voice
 * layer: organ filtering, role filtering, window semantics,
 * cap, and oldest-first read order.
 */

import { assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";
import { initializeFluxSchema } from "../src/schema.ts";
import {
  getRecentMusingEntries,
  insertDurableEntry,
} from "../src/tier2-store.ts";
import type { FluxDurableEntry } from "../src/types.ts";

function ambient(
  id: string,
  organId: string,
  minutesAgo: number,
  content: string,
): FluxDurableEntry {
  return {
    id,
    timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    role: "ambient",
    content,
    metadata: { organId, kind: "murmur" },
  };
}

const SINCE = () => new Date(Date.now() - 24 * 3_600_000).toISOString();

Deno.test("tier2 voice query: only my recent ambient sayings, oldest-first", () => {
  const db = new Database(":memory:");
  initializeFluxSchema(db);
  // Beyond the 24h window — a yesterday that no longer rides.
  insertDurableEntry(
    db,
    ambient("old", "musing", 25 * 60, "yesterday's murmur"),
  );
  // Another organ's entry — the world, not my voice.
  insertDurableEntry(db, ambient("ext", "motion-vision", 5, "she walked in"));
  // A user-role row wearing musing metadata — never mine to carry.
  insertDurableEntry(db, {
    ...ambient("usr", "musing", 4, "user said hi"),
    role: "user",
  });
  insertDurableEntry(db, ambient("m1", "musing", 30, "first murmur"));
  insertDurableEntry(db, ambient("m2", "musing", 5, "latest murmur"));
  const got = getRecentMusingEntries(db, SINCE(), 6);
  assertEquals(got.map((e) => e.id), ["m1", "m2"]);
  db.close();
});

Deno.test("tier2 voice query: cap keeps the most recent sayings", () => {
  const db = new Database(":memory:");
  initializeFluxSchema(db);
  for (let i = 0; i < 8; i++) {
    insertDurableEntry(db, ambient(`m${i}`, "musing", 60 - i, `murmur ${i}`));
  }
  const got = getRecentMusingEntries(db, SINCE(), 6);
  assertEquals(got.length, 6);
  // m2..m7 are the six most recent, read oldest-first.
  assertEquals(
    got.map((e) => e.content),
    Array.from({ length: 6 }, (_, i) => `murmur ${i + 2}`),
  );
  db.close();
});
