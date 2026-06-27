/**
 * Regression test for the concurrent-restart race that caused the Windows
 * "database is locked" crash.
 *
 * Background: MCPClient.restart() had no mutex. The scheduled-reconnect
 * timer (set by scheduleReconnect when a health ping failed) and direct
 * callers like EntityData's export-retry path could both fire restart()
 * concurrently. Each spawned a fresh StdioClientTransport, so two
 * entity-core subprocesses opened graph.db at once → SQLite lock
 * contention → reclaimRunningOnBoot threw uncaught → daemon crashed.
 *
 * Fix: restart() is now mutex-guarded. If a restart is in flight,
 * subsequent callers await and return the same promise instead of
 * spawning a second subprocess.
 *
 * Test strategy: monkey-patch the private doRestart to count invocations
 * and gate on a promise we control, then issue concurrent restart()
 * calls and assert doRestart fired exactly once.
 */

import { assertEquals } from "@std/assert";
import { MCPClient } from "../src/mcp-client/mod.ts";

function makeClient(): MCPClient {
  return new MCPClient({
    command: "mock",
    instanceId: "restart-mutex-test",
  });
}

Deno.test("MCPClient.restart(): concurrent callers share a single in-flight restart", async () => {
  const client = makeClient();
  let doRestartCalls = 0;
  let resolveDoRestart!: (ok: boolean) => void;
  const doRestartPromise = new Promise<boolean>((r) => {
    resolveDoRestart = r;
  });

  // Replace the private doRestart with a counting gate.
  (client as unknown as { doRestart: () => Promise<boolean> }).doRestart =
    () => {
      doRestartCalls++;
      return doRestartPromise;
    };

  // Fire two concurrent restarts.
  const all = Promise.all([client.restart(), client.restart()]);
  // Let the microtask queue drain so both restart() invocations have
  // checked the mutex.
  await new Promise((r) => setTimeout(r, 10));

  assertEquals(doRestartCalls, 1, "doRestart should fire exactly once");

  // Release the in-flight restart.
  resolveDoRestart(true);

  const [r1, r2] = await all;
  assertEquals(r1, true);
  assertEquals(r2, true);
  assertEquals(
    doRestartCalls,
    1,
    "doRestart still fires once after both callers settle",
  );
});

Deno.test("MCPClient.restart(): after settle, a new caller gets a fresh restart", async () => {
  const client = makeClient();
  let doRestartCalls = 0;

  (client as unknown as { doRestart: () => Promise<boolean> }).doRestart =
    async () => {
      doRestartCalls++;
      return true;
    };

  await client.restart();
  assertEquals(doRestartCalls, 1);
  // After the first restart settles, restartInProgress is cleared — a
  // subsequent caller must trigger a real doRestart, not piggyback.
  await client.restart();
  assertEquals(doRestartCalls, 2);
});

Deno.test("MCPClient.restart(): failed restart releases the mutex so retry works", async () => {
  const client = makeClient();
  let doRestartCalls = 0;

  (client as unknown as { doRestart: () => Promise<boolean> }).doRestart =
    async () => {
      doRestartCalls++;
      if (doRestartCalls === 1) throw new Error("upstream blew up");
      return true;
    };

  const r1 = await client.restart().catch(() => false);
  assertEquals(r1, false, "first restart surfaces failure");
  assertEquals(doRestartCalls, 1);

  // Mutex must be released even on throw — otherwise we'd be wedged.
  const r2 = await client.restart();
  assertEquals(r2, true);
  assertEquals(doRestartCalls, 2);
});
