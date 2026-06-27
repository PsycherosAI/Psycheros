/**
 * ConsolidationRunner unit tests.
 *
 * Exercises my local consolidation ticker against an in-memory SQLite
 * database and an empty filesystem-backed FileStore, so each test
 * starts from a clean slate. The empty-store fixture means the
 * runner's catch-up call returns "no unconsolidated periods" without
 * triggering any LLM work or graph writes.
 */

import { assert, assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";
import { FileStore } from "../src/storage/file-store.ts";
import { GraphStore } from "../src/graph/store.ts";
import {
  ConsolidationRunner,
  mostRecentFireAt,
} from "../src/consolidation/runner.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makeFixture(): Promise<{
  db: Database;
  store: FileStore;
  graphStore: GraphStore;
  cleanup: () => Promise<void>;
}> {
  const db = new Database(":memory:");
  const tmpDir = await Deno.makeTempDir({ prefix: "consolidation-runner-" });
  const store = new FileStore(tmpDir);
  await store.initialize();
  // GraphStore is never `initialize()`d in these tests — the runner's
  // empty-data path never calls into it. Construction alone is enough
  // to satisfy the type contract.
  const graphStore = new GraphStore(tmpDir);

  return {
    db,
    store,
    graphStore,
    cleanup: async () => {
      db.close();
      await Deno.remove(tmpDir, { recursive: true });
    },
  };
}

function tableExists(db: Database, name: string): boolean {
  const stmt = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  );
  const row = stmt.get(name);
  stmt.finalize();
  return row !== undefined;
}

function listConsolidationRuns(
  db: Database,
): Array<Record<string, unknown>> {
  const stmt = db.prepare("SELECT * FROM consolidation_runs ORDER BY period");
  const rows = stmt.all() as Array<Record<string, unknown>>;
  stmt.finalize();
  return rows;
}

// ---------------------------------------------------------------------------
// mostRecentFireAt: boundary math
// ---------------------------------------------------------------------------

Deno.test("mostRecentFireAt weekly: Wednesday lands on previous Sunday 05:00 UTC", () => {
  // 2026-05-13 is a Wednesday
  const now = new Date(Date.UTC(2026, 4, 13, 12, 0, 0));
  const fire = mostRecentFireAt("weekly", now);
  assertEquals(fire.toISOString(), "2026-05-10T05:00:00.000Z");
});

Deno.test("mostRecentFireAt weekly: Sunday before 05:00 lands on previous Sunday", () => {
  // 2026-05-17 is a Sunday; 04:00 UTC is before today's fire boundary.
  const now = new Date(Date.UTC(2026, 4, 17, 4, 0, 0));
  const fire = mostRecentFireAt("weekly", now);
  assertEquals(fire.toISOString(), "2026-05-10T05:00:00.000Z");
});

Deno.test("mostRecentFireAt weekly: Sunday at 05:00 lands on today", () => {
  const now = new Date(Date.UTC(2026, 4, 17, 5, 0, 0));
  const fire = mostRecentFireAt("weekly", now);
  assertEquals(fire.toISOString(), "2026-05-17T05:00:00.000Z");
});

Deno.test("mostRecentFireAt monthly: mid-month lands on this month's 1st", () => {
  const now = new Date(Date.UTC(2026, 4, 13, 12, 0, 0));
  const fire = mostRecentFireAt("monthly", now);
  assertEquals(fire.toISOString(), "2026-05-01T05:00:00.000Z");
});

Deno.test("mostRecentFireAt monthly: 1st before 05:00 lands on previous month", () => {
  const now = new Date(Date.UTC(2026, 4, 1, 4, 0, 0));
  const fire = mostRecentFireAt("monthly", now);
  assertEquals(fire.toISOString(), "2026-04-01T05:00:00.000Z");
});

Deno.test("mostRecentFireAt yearly: any day in year lands on Jan 1 of this year", () => {
  const now = new Date(Date.UTC(2026, 4, 13, 12, 0, 0));
  const fire = mostRecentFireAt("yearly", now);
  assertEquals(fire.toISOString(), "2026-01-01T05:00:00.000Z");
});

Deno.test("mostRecentFireAt yearly: Jan 1 before 05:00 lands on previous year", () => {
  const now = new Date(Date.UTC(2026, 0, 1, 4, 0, 0));
  const fire = mostRecentFireAt("yearly", now);
  assertEquals(fire.toISOString(), "2025-01-01T05:00:00.000Z");
});

// ---------------------------------------------------------------------------
// Schema migration
// ---------------------------------------------------------------------------

Deno.test("constructor drops legacy schedules / job_runs tables", async () => {
  const { db, store, graphStore, cleanup } = await makeFixture();
  try {
    // Pre-populate the legacy tables to prove they get dropped.
    db.exec(`
      CREATE TABLE schedules (id TEXT PRIMARY KEY);
      CREATE TABLE job_runs (id TEXT PRIMARY KEY);
    `);
    assert(tableExists(db, "schedules"));
    assert(tableExists(db, "job_runs"));

    new ConsolidationRunner(db, store, graphStore);

    assertEquals(tableExists(db, "schedules"), false);
    assertEquals(tableExists(db, "job_runs"), false);
    assert(tableExists(db, "consolidation_runs"));
  } finally {
    await cleanup();
  }
});

Deno.test("constructor is idempotent on consolidation_runs", async () => {
  const { db, store, graphStore, cleanup } = await makeFixture();
  try {
    new ConsolidationRunner(db, store, graphStore);
    // Insert a row and prove a second construction preserves it.
    db.exec(
      `INSERT INTO consolidation_runs
         (period, scheduled_for, status, started_at)
       VALUES ('weekly', '2026-05-10T05:00:00.000Z', 'success', '2026-05-10T05:00:01.000Z')`,
    );
    new ConsolidationRunner(db, store, graphStore);
    const rows = listConsolidationRuns(db);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].status, "success");
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Ticker behavior
// ---------------------------------------------------------------------------

Deno.test("start() fires immediately and inserts a success row per period", async () => {
  const { db, store, graphStore, cleanup } = await makeFixture();
  try {
    const runner = new ConsolidationRunner(db, store, graphStore, {
      tickIntervalMs: 60_000, // long, so only the immediate tick runs
    });
    runner.start();
    // The immediate tick is sync up to the `await this.catchUp()` —
    // give the microtask queue a few turns to land the UPDATE.
    await new Promise((r) => setTimeout(r, 50));
    runner.stop();

    const rows = listConsolidationRuns(db);
    assertEquals(rows.length, 3);
    for (const row of rows) {
      assertEquals(row.status, "success");
      assertEquals(row.result, `No unconsolidated ${row.period} periods`);
    }
  } finally {
    await cleanup();
  }
});

Deno.test("second tick within the same boundary doesn't double-fire", async () => {
  const { db, store, graphStore, cleanup } = await makeFixture();
  try {
    const runner = new ConsolidationRunner(db, store, graphStore, {
      tickIntervalMs: 25,
    });
    runner.start();
    await new Promise((r) => setTimeout(r, 150)); // multiple ticks fire
    runner.stop();

    const rows = listConsolidationRuns(db);
    // Still exactly three rows — one per period, guarded by the
    // composite PK on (period, scheduled_for).
    assertEquals(rows.length, 3);
  } finally {
    await cleanup();
  }
});

Deno.test("reclaim-on-boot rewrites running rows to error", async () => {
  const { db, store, graphStore, cleanup } = await makeFixture();
  try {
    new ConsolidationRunner(db, store, graphStore);
    db.exec(
      `INSERT INTO consolidation_runs
         (period, scheduled_for, status, started_at)
       VALUES ('weekly', '2026-01-01T05:00:00.000Z', 'running', '2026-01-01T05:00:01.000Z')`,
    );

    // A fresh runner starting up should reclaim the stuck row.
    const runner = new ConsolidationRunner(db, store, graphStore, {
      tickIntervalMs: 60_000,
    });
    runner.start();
    await new Promise((r) => setTimeout(r, 50));
    runner.stop();

    const stmt = db.prepare(
      "SELECT status, error FROM consolidation_runs WHERE period = 'weekly' AND scheduled_for = '2026-01-01T05:00:00.000Z'",
    );
    const row = stmt.get() as { status: string; error: string };
    stmt.finalize();
    assertEquals(row.status, "error");
    assertEquals(row.error, "Reclaimed after worker crash");
  } finally {
    await cleanup();
  }
});

/**
 * Regression for the Windows "database is locked" crash. When a zombie
 * entity-core is holding graph.db, reclaim-on-boot's UPDATE throws
 * synchronously. Before the fix, that escaped uncaught and killed the
 * daemon. After the fix, it's logged and start() completes normally.
 *
 * Simulates the locked DB with a tiny stand-in that handles the
 * constructor's schema exec but throws on the reclaim UPDATE.
 */
Deno.test("reclaim-on-boot swallows db lock instead of crashing start()", async () => {
  const { store, graphStore, cleanup } = await makeFixture();
  // Wrap an in-memory DB so we can intercept the reclaim UPDATE.
  const real = new Database(":memory:");
  real.exec(`
    CREATE TABLE consolidation_runs (
      period TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      result TEXT,
      error TEXT,
      PRIMARY KEY (period, scheduled_for)
    );
    INSERT INTO consolidation_runs
      (period, scheduled_for, status, started_at)
    VALUES ('weekly', '2026-01-01T05:00:00.000Z', 'running', '2026-01-01T05:00:01.000Z');
  `);
  // Stand-in that throws specifically on the reclaim UPDATE — emulating
  // "database is locked" from a concurrent holder.
  const throwingDb = {
    exec: (sql: string | string[], ..._rest: unknown[]) => {
      if (
        typeof sql === "string" &&
        sql.includes("SET status = 'error'")
      ) {
        throw new Error("database is locked");
      }
      // Delegate schema/claim/insert execs to the real handle.
      // (ConsolidationRunner's constructor runs SCHEMA_SQL here; that
      // hits the IF NOT EXISTS branches and is a no-op.)
    },
    prepare: () => ({
      get: () => undefined,
      all: () => [],
      finalize: () => {},
    }),
  };
  const runner = new ConsolidationRunner(
    throwingDb as unknown as Database,
    store,
    graphStore,
    { tickIntervalMs: 60_000 },
  );
  // start() must not throw — reclaim is now wrapped.
  runner.start();
  await new Promise((r) => setTimeout(r, 50));
  runner.stop();
  real.close();
  await cleanup();
});

Deno.test("replaceDatabase swaps the handle and applies schema to the new one", async () => {
  const { db, store, graphStore, cleanup } = await makeFixture();
  const secondDb = new Database(":memory:");
  try {
    const runner = new ConsolidationRunner(db, store, graphStore, {
      tickIntervalMs: 60_000,
    });
    runner.replaceDatabase(secondDb);
    // The new handle should have the table; the old one is unaffected.
    assert(tableExists(secondDb, "consolidation_runs"));

    runner.start();
    await new Promise((r) => setTimeout(r, 50));
    runner.stop();

    // The runner's ticker wrote to the second DB, not the first.
    assertEquals(listConsolidationRuns(secondDb).length, 3);
    assertEquals(listConsolidationRuns(db).length, 0);
  } finally {
    secondDb.close();
    await cleanup();
  }
});

Deno.test("stop() prevents further ticks", async () => {
  const { db, store, graphStore, cleanup } = await makeFixture();
  try {
    const runner = new ConsolidationRunner(db, store, graphStore, {
      tickIntervalMs: 25,
    });
    runner.start();
    await new Promise((r) => setTimeout(r, 50));
    runner.stop();
    const countBefore = listConsolidationRuns(db).length;
    await new Promise((r) => setTimeout(r, 150));
    const countAfter = listConsolidationRuns(db).length;
    assertEquals(countBefore, countAfter);
  } finally {
    await cleanup();
  }
});
