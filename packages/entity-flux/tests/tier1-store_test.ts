/**
 * Tier-1 store tests — insert, query, mark-promoted, cleanup round-trip
 * against a temp SQLite file.
 */

import { assertEquals } from "@std/assert";
import { Tier1Store } from "../src/tier1-store.ts";
import type { FluxObservation } from "../src/types.ts";

function makeObservation(
  id: string,
  salience: number,
  embedding: number[],
  ageMs = 0,
): FluxObservation {
  return {
    id,
    timestamp: new Date(Date.now() - ageMs).toISOString(),
    sourceOrganId: "test-organ",
    content: "observation " + id,
    salience,
    embedding,
    tags: ["t"],
    promoted: false,
  };
}

const EMB = [1, 0, 0];

Deno.test("tier1: organ provenance round-trips (mixed batches)", () => {
  const path = "./tmp-flux-tier1-" + crypto.randomUUID() + ".db";
  const store = new Tier1Store(path);
  const mixed: FluxObservation = {
    ...makeObservation("mixed", 0.5, EMB),
    sourceOrganId: "motion-vision",
    sourceOrganIds: ["motion-vision", "audio", "net-monitor"],
  };
  const legacy = makeObservation("legacy", 0.4, EMB); // no list — old shape
  store.insert(mixed);
  store.insert(legacy);

  const rows = store.queryTopSalient(10, "1970-01-01");
  const m = rows.find((r) => r.id === "mixed");
  const l = rows.find((r) => r.id === "legacy");
  // Full list survives the round-trip...
  assertEquals(m?.sourceOrganIds, ["motion-vision", "audio", "net-monitor"]);
  // ...and pre-list rows fall back to [primary].
  assertEquals(l?.sourceOrganIds, ["test-organ"]);
  // The primary stays exact-match filterable.
  assertEquals(m?.sourceOrganId, "motion-vision");
  store.close();
  try {
    Deno.removeSync(path);
  } catch { /* already gone */ }
});

Deno.test("tier1: insert and count", () => {
  const path = "./tmp-flux-tier1-" + crypto.randomUUID() + ".db";
  const store = new Tier1Store(path);
  try {
    store.insert(makeObservation("a", 0.5, EMB));
    store.insert(makeObservation("b", 0.7, EMB));
    assertEquals(store.count(), 2);
  } finally {
    store.close();
    try {
      Deno.removeSync(path);
    } catch { /* ignore */ }
  }
});

Deno.test("tier1: queryUnpromoted and markPromoted", () => {
  const path = "./tmp-flux-tier1-" + crypto.randomUUID() + ".db";
  const store = new Tier1Store(path);
  try {
    store.insert(makeObservation("a", 0.5, EMB));
    store.insert(makeObservation("b", 0.6, EMB));
    const unpromoted = store.queryUnpromoted(10, "1970-01-01T00:00:00.000Z");
    assertEquals(unpromoted.length, 2);
    store.markPromoted("a");
    const after = store.queryUnpromoted(10, "1970-01-01T00:00:00.000Z");
    assertEquals(after.length, 1);
    assertEquals(after[0].id, "b");
  } finally {
    store.close();
    try {
      Deno.removeSync(path);
    } catch { /* ignore */ }
  }
});

Deno.test("tier1: queryTopSalient orders by salience desc", () => {
  const path = "./tmp-flux-tier1-" + crypto.randomUUID() + ".db";
  const store = new Tier1Store(path);
  try {
    store.insert(makeObservation("low", 0.3, EMB));
    store.insert(makeObservation("high", 0.9, EMB));
    store.insert(makeObservation("mid", 0.6, EMB));
    const top = store.queryTopSalient(2, "1970-01-01T00:00:00.000Z");
    assertEquals(top.length, 2);
    assertEquals(top[0].id, "high");
    assertEquals(top[1].id, "mid");
  } finally {
    store.close();
    try {
      Deno.removeSync(path);
    } catch { /* ignore */ }
  }
});

Deno.test("tier1: cleanup removes old observations", () => {
  const path = "./tmp-flux-tier1-" + crypto.randomUUID() + ".db";
  const store = new Tier1Store(path);
  try {
    // 2 hours old
    store.insert(makeObservation("old", 0.5, EMB, 2 * 3600_000));
    store.insert(makeObservation("new", 0.5, EMB, 1_000));
    const removed = store.cleanup(1); // 1-day retention
    assertEquals(removed, 0); // 2 hours < 1 day, nothing removed
    // Use a sub-day retention to actually remove the 2h-old one.
    const removed2 = store.cleanup(0); // 0 days = remove everything older than now
    // "new" is 1s old, "old" is 2h old; 0-day cutoff = now, both older.
    assertEquals(store.count(), 0);
    void removed;
    void removed2;
  } finally {
    store.close();
    try {
      Deno.removeSync(path);
    } catch { /* ignore */ }
  }
});

Deno.test("tier1: embedding round-trips through BLOB", () => {
  const path = "./tmp-flux-tier1-" + crypto.randomUUID() + ".db";
  const store = new Tier1Store(path);
  try {
    const emb = [0.1, 0.2, 0.3, 0.4];
    store.insert(makeObservation("a", 0.5, emb));
    const got = store.queryUnpromoted(1, "1970-01-01T00:00:00.000Z")[0];
    // Float32 storage loses precision — compare rounded, not exact.
    const round = (arr: number[]) =>
      arr.map((v) => Math.round(v * 1000) / 1000);
    assertEquals(round(got.embedding!), round(emb));
  } finally {
    store.close();
    try {
      Deno.removeSync(path);
    } catch { /* ignore */ }
  }
});
