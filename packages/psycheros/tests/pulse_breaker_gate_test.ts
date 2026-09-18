/**
 * Inactivity-pulse circuit breaker — gate-level end-to-end tests.
 *
 * Drives the REAL `PulseEngine.checkInactivityEligibility()` against a
 * real DB seeded with run history, replaying the failure shape of the
 * 2026-09-15 incident: provider dies mid-night, every fire goes
 * error/dead, the success-only cooldown never arms, and the per-minute
 * tick would re-fire indefinitely without the breaker.
 *
 * The engine constructor only stores references (no timers, no I/O), so
 * dummy LLM/tool handles are safe; the gate under test touches only
 * DBClient state.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Database } from "@db/sqlite";
import { initializeSchema } from "../src/db/schema.ts";
import { DBClient } from "../src/db/client.ts";
import { Scheduler } from "../src/scheduler/scheduler.ts";
import { PulseEngine } from "../src/pulse/engine.ts";
import type { PulseRow } from "../src/types.ts";

const THRESHOLD_SECONDS = 7200; // 2h, matches the production pulse

function makeEngine(): {
  client: DBClient;
  engine: PulseEngine;
  rawDb: Database;
  cleanup: () => void;
} {
  const path = Deno.makeTempFileSync({
    prefix: "psycheros-breaker-gate-",
    suffix: ".db",
  });
  const raw = new Database(path);
  initializeSchema(raw);
  raw.close();
  const client = new DBClient(path);

  const scheduler = new Scheduler({
    db: client.getRawDb(),
    workerId: "test-worker",
    tickIntervalMs: 3_600_000, // never ticks during the test
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
  return { client, engine, rawDb: client.getRawDb(), cleanup };
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
  const conv = client.createConversation("breaker-test-conv");
  const t = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
  client.getRawDb().exec(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES (?, ?, 'user', 'seed message', ?)`,
    [crypto.randomUUID(), conv.id, t],
  );
}

function insertRun(
  rawDb: Database,
  opts: {
    pulseId: string;
    status: "success" | "error" | "dead";
    minutesAgo: number;
  },
): void {
  const t = new Date(Date.now() - opts.minutesAgo * 60_000).toISOString();
  rawDb.exec(
    `INSERT INTO job_runs
       (id, schedule_id, handler, payload_json, status, attempt,
        max_attempts, scheduled_for, started_at, completed_at,
        result_summary, created_at)
     VALUES (?, NULL, 'pulse.execute', ?, ?, 1, 1, ?, ?, ?, '', ?)`,
    [
      crypto.randomUUID(),
      JSON.stringify({ pulseId: opts.pulseId, triggerSource: "inactivity" }),
      opts.status,
      t,
      t,
      t,
      t,
    ],
  );
}

function makePulse(client: DBClient, createdMinutesAgo = 120): PulseRow {
  const created = client.createPulse({
    name: "Breaker Test Pulse",
    promptText: "test prompt",
    enabled: true,
    triggerType: "inactivity",
    inactivityThresholdSeconds: THRESHOLD_SECONDS,
  });
  // Backdate so `updated_at` predates the seeded failures — createPulse
  // stamps updated_at = now, which would otherwise trip the gate's
  // edit-lift clause. Re-fetch so the returned row carries the backdated
  // value (the gate reads the row it is handed, not the DB).
  client.getRawDb().exec(
    `UPDATE pulses SET updated_at = ? WHERE id = ?`,
    [
      new Date(Date.now() - createdMinutesAgo * 60_000).toISOString(),
      created.id,
    ],
  );
  return client.getPulse(created.id)!;
}

Deno.test("breaker gate: healthy state → eligible", () => {
  const { client, engine, rawDb, cleanup } = makeEngine();
  seedInactiveUserMessage(client, 3);
  const pulse = makePulse(client);
  insertRun(rawDb, {
    pulseId: pulse.id,
    status: "success",
    minutesAgo: 3 * 60,
  });
  const result = gate(engine)(pulse);
  assertEquals(result, { ok: true });
  cleanup();
});

Deno.test("breaker gate: two consecutive failures (under cap) → still eligible", () => {
  const { client, engine, rawDb, cleanup } = makeEngine();
  seedInactiveUserMessage(client, 3);
  const pulse = makePulse(client);
  insertRun(rawDb, { pulseId: pulse.id, status: "dead", minutesAgo: 3 });
  insertRun(rawDb, { pulseId: pulse.id, status: "dead", minutesAgo: 2 });
  assertEquals(gate(engine)(pulse), { ok: true });
  cleanup();
});

Deno.test("breaker gate: streak at cap → the NEXT fire is refused", () => {
  const { client, engine, rawDb, cleanup } = makeEngine();
  seedInactiveUserMessage(client, 3);
  const pulse = makePulse(client);
  // Three consecutive failed fires are ALLOWED (fires #1-#3, the
  // retries). By the time the gate sees a recorded streak of 3, those
  // three have already died — its job is refusing fire #4.
  insertRun(rawDb, { pulseId: pulse.id, status: "dead", minutesAgo: 4 });
  insertRun(rawDb, { pulseId: pulse.id, status: "dead", minutesAgo: 3 });
  insertRun(rawDb, { pulseId: pulse.id, status: "dead", minutesAgo: 2 });
  const result = gate(engine)(pulse);
  assert(!result.ok, "streak == cap must refuse the next fire");
  assertStringIncludes(result.reason, "Circuit breaker: 3 consecutive");
  cleanup();
});

Deno.test("breaker gate: failure at cap + fresh attempt → blocked with breaker reason", () => {
  const { client, engine, rawDb, cleanup } = makeEngine();
  seedInactiveUserMessage(client, 3);
  const pulse = makePulse(client);
  // 3 deads (streak = cap), newest 1 minute ago, then the tick fires a
  // 4th run which dies too → streak 4, last attempt 1 min ago.
  for (const m of [4, 3, 2, 1]) {
    insertRun(rawDb, { pulseId: pulse.id, status: "dead", minutesAgo: m });
  }
  const result = gate(engine)(pulse);
  assert(!result.ok, "expected the breaker to block the fire");
  assertStringIncludes(result.reason, "Circuit breaker");
  cleanup();
});

Deno.test("breaker gate: blocked during backoff window, eligible after threshold elapses", () => {
  const { client, engine, rawDb, cleanup } = makeEngine();
  seedInactiveUserMessage(client, 30); // far past the inactivity floor
  const pulse = makePulse(client, 200);
  // Simulate the incident window: 4 consecutive failures ending 1 min ago.
  for (const m of [5, 4, 3, 1]) {
    insertRun(rawDb, { pulseId: pulse.id, status: "dead", minutesAgo: m });
  }
  const blocked = gate(engine)(pulse);
  assert(!blocked.ok, "within the backoff window the fire must be blocked");

  // Same history, but the newest failure is a full threshold ago —
  // one retry attempt per window is allowed.
  const { client: client2, engine: engine2, rawDb: rawDb2, cleanup: cleanup2 } =
    makeEngine();
  seedInactiveUserMessage(client2, 30);
  const pulse2 = makePulse(client2, 200);
  for (
    const m of [
      THRESHOLD_SECONDS / 60 + 10,
      THRESHOLD_SECONDS / 60 + 9,
      THRESHOLD_SECONDS / 60 + 8,
      THRESHOLD_SECONDS / 60 + 2,
    ]
  ) {
    insertRun(rawDb2, { pulseId: pulse2.id, status: "dead", minutesAgo: m });
  }
  assertEquals(gate(engine2)(pulse2), { ok: true });
  cleanup2();
  cleanup();
});

Deno.test("breaker gate: a success mid-outage re-arms cooldown and clears the breaker", () => {
  const { client, engine, rawDb, cleanup } = makeEngine();
  seedInactiveUserMessage(client, 30);
  const pulse = makePulse(client, 300);
  // Failure streak, then a successful fire 3h ago (past cooldown), then
  // two fresh failures (streak 2 < cap): regular gates apply, breaker
  // does not — the success reset the count.
  for (const m of [200, 199]) {
    insertRun(rawDb, { pulseId: pulse.id, status: "dead", minutesAgo: m });
  }
  insertRun(rawDb, { pulseId: pulse.id, status: "success", minutesAgo: 180 });
  insertRun(rawDb, { pulseId: pulse.id, status: "dead", minutesAgo: 2 });
  insertRun(rawDb, { pulseId: pulse.id, status: "dead", minutesAgo: 1 });
  assertEquals(gate(engine)(pulse), { ok: true });
  cleanup();
});

Deno.test("breaker gate: editing the pulse (updated_at bump) lifts the breaker immediately", async () => {
  const { client, engine, rawDb, cleanup } = makeEngine();
  seedInactiveUserMessage(client, 3);
  const pulse = makePulse(client);
  for (const m of [4, 3, 2, 1]) {
    insertRun(rawDb, { pulseId: pulse.id, status: "dead", minutesAgo: m });
  }
  const before = gate(engine)(pulse);
  assert(!before.ok, "breaker should block before the edit");

  // The operator fixes the config (e.g. replaces the dead API key) —
  // any edit bumps updated_at, which must lift the breaker.
  await client.updatePulse(pulse.id, { description: "config repaired" });
  const fresh = client.getPulse(pulse.id)!;
  assertEquals(gate(engine)(fresh), { ok: true });
  cleanup();
});

Deno.test("breaker gate: unedited old pulse with stale breaker state stays blocked", () => {
  const { client, engine, rawDb, cleanup } = makeEngine();
  seedInactiveUserMessage(client, 30);
  const pulse = makePulse(client, 300);
  // Failures all newer than updated_at — the edit-lift must NOT apply.
  for (const m of [90, 60, 30, 1]) {
    insertRun(rawDb, { pulseId: pulse.id, status: "dead", minutesAgo: m });
  }
  const result = gate(engine)(pulse);
  assert(!result.ok);
  assertStringIncludes(result.reason, "Circuit breaker");
  cleanup();
});
