/**
 * Inactivity-pulse cooldown vs. retention pruning + catch-up replay —
 * regression tests for the accelerating-chime loop.
 *
 * Replays the reported failure shape on a sleep-wake host: an inactivity
 * pulse fires its 18h chime correctly, the every-minute eligibility ticks
 * keep writing `skipped` rows into the same job_runs cohort, and — pre-fix
 * — the 200-row retention cap evicted the cooldown's `success` row. The
 * cooldown query then found nothing, the gate re-armed while the user was
 * still inactive, and the pulse re-fired in a loop until the next real
 * user message. The catch-up replay (one stale minute-slot per 5s tick
 * after downtime) was the accelerants: ~12 tick rows/min meant eviction in
 * ~17 minutes — matching the observed 18h → 87m → 17m shrinking intervals.
 *
 * The engine constructor only stores references (no timers, no I/O), so
 * dummy LLM/tool handles are safe; the paths under test touch only
 * DBClient and scheduler state.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Database } from "@db/sqlite";
import { initializeSchema } from "../src/db/schema.ts";
import { DBClient } from "../src/db/client.ts";
import { Scheduler } from "../src/scheduler/scheduler.ts";
import { PulseEngine } from "../src/pulse/engine.ts";
import type { PulseRow } from "../src/types.ts";

const THRESHOLD_SECONDS = 7200; // 2h — keeps seeded timestamps compact

function makeEngine(): {
  client: DBClient;
  engine: PulseEngine;
  scheduler: Scheduler;
  rawDb: Database;
  cleanup: () => void;
} {
  const path = Deno.makeTempFileSync({
    prefix: "psycheros-cooldown-retention-",
    suffix: ".db",
  });
  const raw = new Database(path);
  initializeSchema(raw);
  raw.close();
  const client = new DBClient(path);

  const scheduler = new Scheduler({
    db: client.getRawDb(),
    workerId: "test-worker",
    tickIntervalMs: 3_600_000, // never ticks on its own during the test
  });
  const engine = new PulseEngine(
    client,
    scheduler,
    () => {
      throw new Error("LLM not reachable in gate tests");
    },
    () => {
      throw new Error("tools not reachable in gate tests");
    },
    { projectRoot: "/tmp", dataRoot: "/tmp" },
  );

  const cleanup = () => {
    client.close();
    try {
      Deno.removeSync(path);
    } catch { /* already gone */ }
  };
  return { client, engine, scheduler, rawDb: client.getRawDb(), cleanup };
}

function gate(engine: PulseEngine) {
  const inner = engine as unknown as {
    checkInactivityEligibility(
      pulse: PulseRow,
    ): { ok: true } | { ok: false; reason: string };
  };
  return (pulse: PulseRow) => inner.checkInactivityEligibility(pulse);
}

/** Seed an old-enough real user message so the inactivity floor passes. */
function seedInactiveUserMessage(client: DBClient, hoursAgo: number): void {
  const conv = client.createConversation("cooldown-retention-test-conv");
  const t = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  client.getRawDb().exec(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES (?, ?, 'user', 'seed message', ?)`,
    [crypto.randomUUID(), conv.id, t],
  );
}

/**
 * Seed a run row in the pulse's SCHEDULE cohort (schedule_id set), the way
 * tick-materialized fires land — unlike the ad-hoc NULL-cohort helper in
 * the breaker tests.
 */
function insertScheduledRun(
  rawDb: Database,
  opts: {
    pulseId: string;
    status: "success" | "skipped";
    at: Date;
  },
): void {
  const iso = opts.at.toISOString();
  rawDb.exec(
    `INSERT INTO job_runs
       (id, schedule_id, handler, payload_json, status, attempt,
        max_attempts, scheduled_for, started_at, completed_at,
        result_summary, created_at)
     VALUES (?, ?, 'pulse.execute', ?, ?, 1, 1, ?, ?, ?, '', ?)`,
    [
      crypto.randomUUID(),
      `pulse-${opts.pulseId}`,
      JSON.stringify({ pulseId: opts.pulseId, triggerSource: "inactivity" }),
      opts.status,
      iso,
      iso,
      iso,
      iso,
    ],
  );
}

Deno.test("cooldown anchor survives the skipped-tick flood and prune", async () => {
  const { client, engine, scheduler, rawDb, cleanup } = makeEngine();
  try {
    seedInactiveUserMessage(client, 5); // 5h quiet — inactivity floor passes
    const pulse = client.createPulse({
      name: "Inactivity Doorbell",
      promptText: "chime",
      enabled: true,
      triggerType: "inactivity",
      inactivityThresholdSeconds: THRESHOLD_SECONDS,
    });

    // Register the handler + the pulse's every-minute tick schedule
    // first — seeded cohort rows carry its schedule_id, which is a
    // foreign key onto the schedules row this creates.
    engine.start();

    // The 18h-style chime: a successful fire 100 minutes ago. Cooldown
    // (same threshold, 2h) must hold for another 20 minutes.
    const chimeAt = new Date(Date.now() - 100 * 60_000);
    insertScheduledRun(rawDb, {
      pulseId: pulse.id,
      status: "success",
      at: chimeAt,
    });

    // The flood: 250 guard-tick skips newer than the chime, 20s apart
    // (spanning ~83 minutes). Pre-fix, the 200-row mixed cap evicted the
    // chime's success row once ~200 of these existed.
    for (let i = 0; i < 250; i++) {
      insertScheduledRun(rawDb, {
        pulseId: pulse.id,
        status: "skipped",
        at: new Date(chimeAt.getTime() + (i + 1) * 20_000),
      });
    }

    // Backdate the schedule pointer so one real tick materializes a
    // fire, runs the gate, completes as `skipped`, and triggers the
    // prune.
    rawDb.exec(
      `UPDATE schedules SET next_fire_at = ? WHERE id = ?`,
      [new Date(Date.now() - 30_000).toISOString(), `pulse-${pulse.id}`],
    );
    await scheduler.tick();
    await new Promise((r) => setTimeout(r, 100)); // let dispatch complete

    // THE regression: the cooldown's evidence survived the flood + prune.
    const lastSuccess = client.getLastSuccessfulPulseRunAt(pulse.id);
    assert(
      lastSuccess !== null,
      "the chime's success row must survive the skipped-tick flood",
    );

    // And the gate still refuses to re-fire on the next tick.
    const fresh = client.getPulse(pulse.id)!;
    const result = gate(engine)(fresh);
    assert(!result.ok, "cooldown must still gate the next fire");
    assertStringIncludes(result.reason, "Cooldown active");

    // Pruning still bounds the table: skipped rows capped at 200, and the
    // carve-out held exactly one survivor outside that cap (the success).
    const countStmt = (status: string): number => {
      const stmt = rawDb.prepare(
        `SELECT COUNT(*) AS c FROM job_runs
         WHERE schedule_id = ? AND status = ?`,
      );
      const row = stmt.get(`pulse-${pulse.id}`, status) as { c: number };
      stmt.finalize();
      return row.c;
    };
    assertEquals(
      countStmt("skipped"),
      200,
      "skipped ticks are still capped at 200",
    );
    assertEquals(
      countStmt("success"),
      1,
      "exactly the chime's success row remains",
    );
  } finally {
    cleanup();
  }
});

Deno.test("backlogged skip_missed / fire_once_then_align realigns instead of replaying", async () => {
  for (const policy of ["skip_missed", "fire_once_then_align"] as const) {
    const raw = new Database(":memory:");
    initializeSchema(raw);
    const scheduler = new Scheduler({
      db: raw,
      workerId: "test-worker",
      tickIntervalMs: 3_600_000,
    });
    let calls = 0;
    scheduler.register("test.tick", async () => {
      calls++;
      return { status: "skipped", result: "tick" };
    });
    scheduler.defineSchedule({
      id: "backlogged",
      kind: "recurring",
      handler: "test.tick",
      payload: {},
      intervalSeconds: 60,
      catchupPolicy: policy,
      maxAttempts: 1,
    });

    // The daemon slept for 3h: the schedule pointer is far behind now.
    raw.exec(
      `UPDATE schedules SET next_fire_at = ? WHERE id = 'backlogged'`,
      [new Date(Date.now() - 3 * 3_600_000).toISOString()],
    );

    // Two ticks. Pre-fix, each tick materialized ONE stale slot (the
    // advance step only moved one interval past the fired slot), so the
    // backlog replayed at ~12 fires/min — the flood accelerant.
    await scheduler.tick();
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(calls, 1, `${policy}: one catch-up fire`);
    await scheduler.tick();
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(
      calls,
      1,
      `${policy}: the backlog must not replay one slot per tick`,
    );

    const schedule = scheduler.getSchedule("backlogged")!;
    assert(
      schedule.nextFireAt !== null &&
        new Date(schedule.nextFireAt).getTime() > Date.now(),
      `${policy}: next_fire_at realigned into the future`,
    );
    raw.close();
  }
});
