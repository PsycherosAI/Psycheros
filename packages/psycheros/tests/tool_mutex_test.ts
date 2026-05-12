/**
 * Tests for the tool execution mutex.
 *
 * Tests the mutex logic directly by reproducing the pattern from
 * ToolRegistry.executeAll() in isolation, avoiding imports that
 * pull in the full dependency tree (push, MCP, etc.).
 */

import { assertEquals } from "@std/assert";

// ---------------------------------------------------------------------------
// Reproduce the mutex pattern from ToolRegistry
// ---------------------------------------------------------------------------

class MutexLock {
  private lock: Promise<void> = Promise.resolve();

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const myTurn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.lock;
    this.lock = myTurn;

    await previous;

    try {
      return await fn();
    } finally {
      release();
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("single call runs immediately", async () => {
  const mutex = new MutexLock();
  let ran = false;
  await mutex.withLock(() => Promise.resolve(ran = true));
  assertEquals(ran, true);
});

Deno.test("concurrent calls serialize in FIFO order", async () => {
  const mutex = new MutexLock();
  const log: string[] = [];

  // Each "turn" takes 30ms — if serialized, total is ~90ms
  // If they ran in parallel, total would be ~30ms
  const turnA = mutex.withLock(async () => {
    log.push("A-start");
    await new Promise((r) => setTimeout(r, 30));
    log.push("A-end");
  });
  const turnB = mutex.withLock(async () => {
    log.push("B-start");
    await new Promise((r) => setTimeout(r, 30));
    log.push("B-end");
  });
  const turnC = mutex.withLock(async () => {
    log.push("C-start");
    await new Promise((r) => setTimeout(r, 30));
    log.push("C-end");
  });

  const start = performance.now();
  await Promise.all([turnA, turnB, turnC]);
  const elapsed = performance.now() - start;

  // Verify FIFO ordering — no interleaving
  assertEquals(log, [
    "A-start",
    "A-end",
    "B-start",
    "B-end",
    "C-start",
    "C-end",
  ]);

  // If serialized, elapsed >= 3 * 30ms = 90ms (with generous margin)
  // If parallel, elapsed would be ~30ms
  if (elapsed < 70) {
    throw new Error(
      `Calls ran in parallel: ${elapsed.toFixed(0)}ms (expected ~90ms)`,
    );
  }
});

Deno.test("error still releases the lock", async () => {
  const mutex = new MutexLock();
  let secondRan = false;

  // First call throws — should still release
  const first = mutex.withLock(() => Promise.reject(new Error("boom")));

  // Second call should succeed despite first failing
  const second = mutex.withLock(() => Promise.resolve(secondRan = true));

  const firstResult = await first.then(
    () => "resolved",
    (e) => e.message,
  );
  assertEquals(firstResult, "boom");
  await second;
  assertEquals(secondRan, true);
});

Deno.test("microtask race is prevented", async () => {
  // This test specifically targets the bug where two callers both pass
  // `await this.lock` before either replaces the promise. The fix is
  // replacing the promise BEFORE awaiting.
  const mutex = new MutexLock();
  const log: string[] = [];
  let ready = false;

  // Kick off many concurrent calls simultaneously
  const promises = Array.from(
    { length: 20 },
    (_, i) =>
      mutex.withLock(async () => {
        if (!ready) {
          // All callers arrive at roughly the same time
          await new Promise((r) => setTimeout(r, 0));
        }
        ready = true;
        log.push(String(i));
        // Small delay to widen the race window
        await new Promise((r) => setTimeout(r, 1));
      }),
  );

  await Promise.all(promises);

  // All 20 should have run, each exactly once, with no overlaps
  assertEquals(log.length, 20);
  assertEquals(new Set(log).size, 20);

  // Verify ordering — should be 0..19
  assertEquals(log, Array.from({ length: 20 }, (_, i) => String(i)));
});

Deno.test("lock is fair — later callers always wait", async () => {
  const mutex = new MutexLock();
  const log: string[] = [];

  // Start a long-held lock
  const blocker = mutex.withLock(async () => {
    log.push("blocker-start");
    await new Promise((r) => setTimeout(r, 50));
    log.push("blocker-end");
  });

  // After a small delay, two more callers arrive
  await new Promise((r) => setTimeout(r, 10));
  const waiterA = mutex.withLock(() => Promise.resolve(log.push("A")));
  const waiterB = mutex.withLock(() => Promise.resolve(log.push("B")));

  await Promise.all([blocker, waiterA, waiterB]);

  // A must come before B (FIFO), both after blocker
  assertEquals(log, ["blocker-start", "blocker-end", "A", "B"]);
});
