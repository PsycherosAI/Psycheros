/**
 * Scheduler unit tests.
 *
 * Exercises the core durability paths against an in-memory SQLite
 * database so each test starts from a clean slate.
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { Database } from "@db/sqlite";
import {
  initSchedulerTables,
  nextFireAtFromCron,
  Scheduler,
} from "../src/scheduler/mod.ts";

function makeDb(): Database {
  const db = new Database(":memory:");
  initSchedulerTables(db);
  return db;
}

function nowPlus(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function newScheduler(db: Database): Scheduler {
  return new Scheduler({
    db,
    workerId: "test-worker",
    tickIntervalMs: 50,
    leaseDurationMs: 200,
    concurrency: 4,
    retryBackoffMs: 100,
    logger: () => {},
  });
}

// ---------------------------------------------------------------------------
// Cron next-fire
// ---------------------------------------------------------------------------

Deno.test("nextFireAtFromCron: hourly at minute 0", () => {
  const after = new Date(Date.UTC(2026, 4, 13, 12, 30, 15));
  const next = nextFireAtFromCron("0 * * * *", after);
  assertEquals(next, "2026-05-13T13:00:00.000Z");
});

Deno.test("nextFireAtFromCron: every minute", () => {
  const after = new Date(Date.UTC(2026, 4, 13, 12, 30, 15));
  const next = nextFireAtFromCron("* * * * *", after);
  assertEquals(next, "2026-05-13T12:31:00.000Z");
});

Deno.test("nextFireAtFromCron: daily at 5 AM UTC", () => {
  const after = new Date(Date.UTC(2026, 4, 13, 12, 0, 0));
  const next = nextFireAtFromCron("0 5 * * *", after);
  assertEquals(next, "2026-05-14T05:00:00.000Z");
});

Deno.test("nextFireAtFromCron: weekly Sunday at 5 AM UTC", () => {
  // 2026-05-13 is a Wednesday
  const after = new Date(Date.UTC(2026, 4, 13, 12, 0, 0));
  const next = nextFireAtFromCron("0 5 * * 0", after);
  // Next Sunday is 2026-05-17
  assertEquals(next, "2026-05-17T05:00:00.000Z");
});

Deno.test("nextFireAtFromCron: 7 normalizes to Sunday", () => {
  const after = new Date(Date.UTC(2026, 4, 13, 12, 0, 0));
  const next = nextFireAtFromCron("0 5 * * 7", after);
  assertEquals(next, "2026-05-17T05:00:00.000Z");
});

// ---------------------------------------------------------------------------
// Schedule definition + tick
// ---------------------------------------------------------------------------

Deno.test("defineSchedule + tick fires the handler", async () => {
  const db = makeDb();
  const scheduler = newScheduler(db);

  let fired = 0;
  scheduler.register("test.echo", () => {
    fired++;
    return Promise.resolve({ status: "success", result: "ok" });
  });

  scheduler.defineSchedule({
    id: "echo-now",
    kind: "oneshot",
    handler: "test.echo",
    runAt: nowPlus(-1), // already due
    maxAttempts: 1,
  });

  await scheduler.tick();
  // Handler is async; wait briefly for dispatch to complete.
  await new Promise((r) => setTimeout(r, 50));

  assertEquals(fired, 1);

  const { runs } = scheduler.listJobRuns({ handler: "test.echo" });
  assertEquals(runs.length, 1);
  assertEquals(runs[0].status, "success");

  db.close();
});

Deno.test("oneshot schedule disables itself after firing", async () => {
  const db = makeDb();
  const scheduler = newScheduler(db);

  scheduler.register(
    "test.noop",
    () => Promise.resolve({ status: "success", result: "ok" }),
  );

  scheduler.defineSchedule({
    id: "fire-once",
    kind: "oneshot",
    handler: "test.noop",
    runAt: nowPlus(-1),
    maxAttempts: 1,
  });

  await scheduler.tick();
  await new Promise((r) => setTimeout(r, 50));

  const schedule = scheduler.getSchedule("fire-once");
  assertExists(schedule);
  assertEquals(schedule.enabled, false);
  assertEquals(schedule.nextFireAt, null);

  // A second tick must not produce a new fire.
  await scheduler.tick();
  await new Promise((r) => setTimeout(r, 30));
  const { runs } = scheduler.listJobRuns({ handler: "test.noop" });
  assertEquals(runs.length, 1);

  db.close();
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

Deno.test("enqueue with existing successful idempotency key returns prior run", async () => {
  const db = makeDb();
  const scheduler = newScheduler(db);

  scheduler.register(
    "test.echo",
    () => Promise.resolve({ status: "success", result: "ok" }),
  );

  const first = scheduler.enqueue({
    handler: "test.echo",
    idempotencyKey: "unique-1",
    maxAttempts: 1,
  });
  await scheduler.tick();
  await new Promise((r) => setTimeout(r, 50));

  const completed = scheduler.getJobRun(first.id);
  assertExists(completed);
  assertEquals(completed.status, "success");

  const second = scheduler.enqueue({
    handler: "test.echo",
    idempotencyKey: "unique-1",
    maxAttempts: 1,
  });
  // Same id as the first successful run.
  assertEquals(second.id, first.id);

  db.close();
});

// ---------------------------------------------------------------------------
// Lease reclamation
// ---------------------------------------------------------------------------

Deno.test("reclaimOnBoot rescues stuck 'running' rows", () => {
  const db = makeDb();
  // Hand-write a stuck running row whose lease is still in the future.
  // Single-process daemon — on boot, an unfinished `running` row
  // belongs to a dead worker regardless of lease.
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 30_000).toISOString();
  db.exec(
    `INSERT INTO job_runs
       (id, handler, payload_json, status, attempt, max_attempts,
        scheduled_for, claimed_at, lease_until, worker_id,
        started_at, created_at)
     VALUES ('stuck-1', 'test.echo', '{}', 'running', 1, 1, ?, ?, ?, 'dead-worker', ?, ?)`,
    [now, now, future, now, now],
  );

  const scheduler = newScheduler(db);
  scheduler.register(
    "test.echo",
    () => Promise.resolve({ status: "success", result: "ok" }),
  );

  const reclaimed = scheduler.reclaimOnBoot();
  assertEquals(reclaimed, 1);

  const row = scheduler.getJobRun("stuck-1");
  assertExists(row);
  // max_attempts=1 → dead, not retried.
  assertEquals(row.status, "dead");
  assert(row.errorMessage?.includes("Reclaimed"));

  db.close();
});

Deno.test("reclaimOnBoot expedites pending retries deferred from previous boot", () => {
  const db = makeDb();
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  db.exec(
    `INSERT INTO job_runs
       (id, handler, payload_json, status, attempt, max_attempts,
        scheduled_for, next_attempt_at, created_at)
     VALUES ('deferred', 'test.echo', '{}', 'pending', 2, 5, ?, ?, ?)`,
    [now, future, now],
  );

  const scheduler = newScheduler(db);
  scheduler.register(
    "test.echo",
    () => Promise.resolve({ status: "success", result: "ok" }),
  );
  scheduler.reclaimOnBoot();

  const row = scheduler.getJobRun("deferred");
  assertExists(row);
  // Status still pending, attempt unchanged, but next_attempt_at cleared
  // so the next tick claims it immediately.
  assertEquals(row.status, "pending");
  assertEquals(row.attempt, 2);
  assertEquals(row.nextAttemptAt, null);

  db.close();
});

Deno.test("reclaimOnBoot retries when attempt < max_attempts", () => {
  const db = makeDb();
  const now = new Date().toISOString();
  // Lease in the future — boot reclaim still rescues it.
  const future = new Date(Date.now() + 30_000).toISOString();
  db.exec(
    `INSERT INTO job_runs
       (id, handler, payload_json, status, attempt, max_attempts,
        scheduled_for, claimed_at, lease_until, worker_id,
        started_at, created_at)
     VALUES ('retryable', 'test.echo', '{}', 'running', 1, 3, ?, ?, ?, 'dead-worker', ?, ?)`,
    [now, now, future, now, now],
  );

  const scheduler = newScheduler(db);
  scheduler.register(
    "test.echo",
    () => Promise.resolve({ status: "success", result: "ok" }),
  );

  scheduler.reclaimOnBoot();

  const row = scheduler.getJobRun("retryable");
  assertExists(row);
  assertEquals(row.status, "pending");
  assertEquals(row.attempt, 2);

  db.close();
});

// ---------------------------------------------------------------------------
// Handler error → retry → dead
// ---------------------------------------------------------------------------

Deno.test("handler throw retries until max_attempts then marks dead", async () => {
  const db = makeDb();
  const scheduler = newScheduler(db);

  let attempts = 0;
  scheduler.register("test.flake", () => {
    attempts++;
    return Promise.reject(new Error(`attempt ${attempts} failed`));
  });

  scheduler.enqueue({
    handler: "test.flake",
    maxAttempts: 2,
  });

  // First tick — first attempt fails, requeues.
  await scheduler.tick();
  await new Promise((r) => setTimeout(r, 50));

  // Wait past retry backoff so the retry is eligible.
  await new Promise((r) => setTimeout(r, 150));

  // Second tick — second attempt fails, marked dead.
  await scheduler.tick();
  await new Promise((r) => setTimeout(r, 50));

  assertEquals(attempts, 2);
  const { runs } = scheduler.listJobRuns({ handler: "test.flake" });
  assertEquals(runs.length, 1);
  assertEquals(runs[0].status, "dead");
  assertEquals(runs[0].attempt, 2);

  db.close();
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Lease auto-renewal
// ---------------------------------------------------------------------------

Deno.test("tick auto-renews leases for in-flight handlers", async () => {
  const db = makeDb();
  const scheduler = new Scheduler({
    db,
    workerId: "test-worker",
    tickIntervalMs: 50,
    leaseDurationMs: 100, // short — would expire quickly without renewal
    concurrency: 4,
    retryBackoffMs: 100,
    logger: () => {},
  });

  // Hold the handler via an externally-resolved promise so the test
  // controls when it finishes — no time-based race.
  let resolveStarted: () => void;
  const handlerStarted = new Promise<void>((r) => (resolveStarted = r));
  let releaseHandler: () => void;
  const handlerHeld = new Promise<void>((r) => (releaseHandler = r));

  scheduler.register("test.slow", async () => {
    resolveStarted!();
    await handlerHeld;
    return { status: "success", result: "done" };
  });

  scheduler.enqueue({
    handler: "test.slow",
    maxAttempts: 3,
  });

  // Kick the first tick to start the handler.
  await scheduler.tick();
  await handlerStarted;

  // Run additional ticks while the handler is held. Without auto-renew
  // the second tick (≥100ms after claim) would see the lease expired
  // and reclaim it — incrementing attempt and possibly dispatching a
  // second handler instance.
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 80));
    await scheduler.tick();
  }

  const { runs: midflight } = scheduler.listJobRuns({ handler: "test.slow" });
  assertEquals(midflight.length, 1);
  assertEquals(midflight[0].status, "running");
  assertEquals(midflight[0].attempt, 1);

  // Release the handler — it should complete normally.
  releaseHandler!();
  await new Promise((r) => setTimeout(r, 100));

  const { runs: final } = scheduler.listJobRuns({ handler: "test.slow" });
  assertEquals(final[0].status, "success");
  assertEquals(final[0].attempt, 1);

  db.close();
});

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

Deno.test("retention: skipped runs beyond the minimum get pruned on completion", async () => {
  const db = makeDb();
  const scheduler = newScheduler(db);

  scheduler.register(
    "test.always-skip",
    () => Promise.resolve({ status: "skipped", result: "nope" }),
  );

  // Hand-write 60 stale skipped rows for the same cohort.
  const staleTime = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  for (let i = 0; i < 60; i++) {
    db.exec(
      `INSERT INTO job_runs
         (id, schedule_id, handler, payload_json, status, attempt,
          max_attempts, scheduled_for, started_at, completed_at,
          created_at)
       VALUES (?, NULL, 'test.always-skip',
               '{"pulseId":"p1"}', 'skipped', 1, 1, ?, ?, ?, ?)`,
      [
        `stale-${i}`,
        staleTime,
        staleTime,
        staleTime,
        staleTime,
      ],
    );
  }

  // Enqueue + run one more skipped completion to trigger the prune.
  scheduler.enqueue({
    handler: "test.always-skip",
    payload: { pulseId: "p1" },
    maxAttempts: 1,
  });
  await scheduler.tick();
  await new Promise((r) => setTimeout(r, 50));

  // Prune keeps the 50 most-recent skipped rows from the cohort. With
  // 60 stale + 1 fresh = 61 total, the 11 oldest get pruned and 50
  // remain (the new row is in the kept top-50).
  const { total } = scheduler.listJobRuns({
    handler: "test.always-skip",
  });
  assertEquals(total, 50);

  db.close();
});

Deno.test("getHandlerStats returns success and error counts", async () => {
  const db = makeDb();
  const scheduler = newScheduler(db);

  let mode: "ok" | "fail" = "ok";
  scheduler.register("test.alternating", () => {
    if (mode === "fail") return Promise.reject(new Error("nope"));
    return Promise.resolve({ status: "success", result: "ok" });
  });

  scheduler.enqueue({ handler: "test.alternating", maxAttempts: 1 });
  await scheduler.tick();
  await new Promise((r) => setTimeout(r, 50));

  mode = "fail";
  scheduler.enqueue({ handler: "test.alternating", maxAttempts: 1 });
  await scheduler.tick();
  await new Promise((r) => setTimeout(r, 50));

  const stats = scheduler.getHandlerStats("test.alternating");
  assertEquals(stats.successCount, 1);
  assertEquals(stats.errorCount, 1);

  db.close();
});
