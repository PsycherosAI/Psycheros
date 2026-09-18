/**
 * Inactivity-pulse circuit breaker tests.
 *
 * Backs the gate added to `PulseEngine.checkInactivityEligibility()`:
 * after INACTIVITY_MAX_CONSECUTIVE_FAILURES consecutive failed fires
 * (error/dead), the gate backs off to one attempt per threshold window
 * so a provider outage cannot burn a full LLM context assembly every
 * minute. These tests exercise the DB projections the gate reads:
 * `getLastPulseTerminalRun()` and `getPulseFailureStreak()`.
 *
 * Observed incident this guards against (2026-09-15): NanoGPT session
 * expiry → every fire 401'd → success-only cooldown never armed →
 * 125 per-minute fires over ~2.5h.
 */

import { assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";
import { initializeSchema } from "../src/db/schema.ts";
import { DBClient } from "../src/db/client.ts";

function makePopulatedDb(): {
  db: Database;
  client: DBClient;
  cleanup: () => void;
} {
  const path = Deno.makeTempFileSync({
    prefix: "psycheros-pulse-breaker-test-",
    suffix: ".db",
  });
  const raw = new Database(path);
  initializeSchema(raw);
  raw.close();
  const client = new DBClient(path);
  const cleanup = () => {
    client.close();
    try {
      Deno.removeSync(path);
    } catch { /* already gone */ }
  };
  return { db: client.getRawDb(), client, cleanup };
}

function insertPulseRun(
  db: Database,
  opts: {
    id: string;
    pulseId: string;
    status: "success" | "error" | "dead" | "skipped";
    /** Minutes before now this run completed. */
    minutesAgo: number;
    seq?: number;
  },
): void {
  const t = new Date(Date.now() - opts.minutesAgo * 60_000).toISOString();
  const payload = JSON.stringify({
    pulseId: opts.pulseId,
    triggerSource: "inactivity",
  });
  db.exec(
    `INSERT INTO job_runs
       (id, schedule_id, handler, payload_json, status, attempt,
        max_attempts, scheduled_for, started_at, completed_at,
        result_summary, created_at)
     VALUES (?, NULL, 'pulse.execute', ?, ?, 1, 1, ?, ?, ?, '', ?)`,
    [opts.id, payload, opts.status, t, t, t, t],
  );
}

Deno.test("getLastPulseTerminalRun: newest terminal run wins regardless of status", () => {
  const { db, client, cleanup } = makePopulatedDb();
  insertPulseRun(db, {
    id: "r1",
    pulseId: "P",
    status: "success",
    minutesAgo: 60,
  });
  insertPulseRun(db, { id: "r2", pulseId: "P", status: "dead", minutesAgo: 5 });
  const last = client.getLastPulseTerminalRun("P");
  assertEquals(last?.status, "dead");
  cleanup();
});

Deno.test("getLastPulseTerminalRun: ignores skipped rows", () => {
  const { db, client, cleanup } = makePopulatedDb();
  insertPulseRun(db, {
    id: "r1",
    pulseId: "P",
    status: "dead",
    minutesAgo: 60,
  });
  insertPulseRun(db, {
    id: "r2",
    pulseId: "P",
    status: "skipped",
    minutesAgo: 5,
  });
  const last = client.getLastPulseTerminalRun("P");
  assertEquals(last?.status, "dead");
  cleanup();
});

Deno.test("getLastPulseTerminalRun: no runs → null", () => {
  const { client, cleanup } = makePopulatedDb();
  assertEquals(client.getLastPulseTerminalRun("P"), null);
  cleanup();
});

Deno.test("getPulseFailureStreak: counts consecutive errors back from newest", () => {
  const { db, client, cleanup } = makePopulatedDb();
  insertPulseRun(db, {
    id: "r1",
    pulseId: "P",
    status: "success",
    minutesAgo: 300,
  });
  insertPulseRun(db, {
    id: "r2",
    pulseId: "P",
    status: "dead",
    minutesAgo: 20,
  });
  insertPulseRun(db, {
    id: "r3",
    pulseId: "P",
    status: "dead",
    minutesAgo: 10,
  });
  insertPulseRun(db, {
    id: "r4",
    pulseId: "P",
    status: "error",
    minutesAgo: 5,
  });
  assertEquals(client.getPulseFailureStreak("P"), 3);
  cleanup();
});

Deno.test("getPulseFailureStreak: a success resets the streak to zero", () => {
  const { db, client, cleanup } = makePopulatedDb();
  insertPulseRun(db, {
    id: "r1",
    pulseId: "P",
    status: "dead",
    minutesAgo: 30,
  });
  insertPulseRun(db, {
    id: "r2",
    pulseId: "P",
    status: "dead",
    minutesAgo: 20,
  });
  insertPulseRun(db, {
    id: "r3",
    pulseId: "P",
    status: "success",
    minutesAgo: 10,
  });
  assertEquals(client.getPulseFailureStreak("P"), 0);
  cleanup();
});

Deno.test("getPulseFailureStreak: a skipped tick stops the count", () => {
  const { db, client, cleanup } = makePopulatedDb();
  insertPulseRun(db, {
    id: "r1",
    pulseId: "P",
    status: "dead",
    minutesAgo: 30,
  });
  insertPulseRun(db, {
    id: "r2",
    pulseId: "P",
    status: "dead",
    minutesAgo: 20,
  });
  insertPulseRun(db, {
    id: "r3",
    pulseId: "P",
    status: "skipped",
    minutesAgo: 10,
  });
  insertPulseRun(db, { id: "r4", pulseId: "P", status: "dead", minutesAgo: 5 });
  assertEquals(client.getPulseFailureStreak("P"), 1);
  cleanup();
});

Deno.test("getPulseFailureStreak: no runs → 0", () => {
  const { client, cleanup } = makePopulatedDb();
  assertEquals(client.getPulseFailureStreak("P"), 0);
  cleanup();
});

Deno.test("getPulseFailureStreak: bounded at 50 regardless of outage length", () => {
  const { db, client, cleanup } = makePopulatedDb();
  for (let i = 0; i < 60; i++) {
    insertPulseRun(db, {
      id: `r${i}`,
      pulseId: "P",
      status: "dead",
      minutesAgo: 120 - i,
      seq: i,
    });
  }
  assertEquals(client.getPulseFailureStreak("P"), 50);
  cleanup();
});

Deno.test("streaks are per-pulse, not global", () => {
  const { db, client, cleanup } = makePopulatedDb();
  insertPulseRun(db, {
    id: "r1",
    pulseId: "A",
    status: "dead",
    minutesAgo: 10,
  });
  insertPulseRun(db, { id: "r2", pulseId: "A", status: "dead", minutesAgo: 5 });
  insertPulseRun(db, {
    id: "r3",
    pulseId: "B",
    status: "success",
    minutesAgo: 5,
  });
  assertEquals(client.getPulseFailureStreak("A"), 2);
  assertEquals(client.getPulseFailureStreak("B"), 0);
  cleanup();
});
