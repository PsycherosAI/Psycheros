import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { HookCache } from "../src/cache/hook-cache.ts";

async function makeTempStatePath(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "psycheros-cache-" });
}

Deno.test("HookCache.read returns undefined for unregistered key", async () => {
  const cache = new HookCache(await makeTempStatePath());
  try {
    assertEquals(cache.read("nope"), undefined);
    assertEquals(cache.meta("nope").hasData, false);
  } finally {
    await cache.stop();
  }
});

Deno.test("HookCache.write + read round-trips data", async () => {
  const cache = new HookCache(await makeTempStatePath());
  try {
    await cache.write("test", { value: 42 });
    assertEquals(cache.read<{ value: number }>("test"), { value: 42 });
    assertEquals(cache.meta("test").hasData, true);
    assert(cache.meta("test").fetchedAt !== undefined);
  } finally {
    await cache.stop();
  }
});

Deno.test("HookCache persists across instances via disk", async () => {
  const statePath = await makeTempStatePath();
  // First instance writes.
  const cache1 = new HookCache(statePath);
  try {
    await cache1.write("persistent", { hello: "world" });
    // Force flush — stop() flushes pending persist.
    await cache1.stop();
  } catch (e) {
    await cache1.stop();
    throw e;
  }

  // Second instance loads from disk.
  const cache2 = new HookCache(statePath);
  try {
    await cache2.load();
    assertEquals(cache2.read<{ hello: string }>("persistent"), {
      hello: "world",
    });
  } finally {
    await cache2.stop();
  }
});

Deno.test("HookCache.refresh calls the registered refresh function", async () => {
  const cache = new HookCache(await makeTempStatePath());
  let refreshCallCount = 0;
  try {
    cache.register("test", async () => {
      refreshCallCount++;
      await cache.write("test", { refreshed: refreshCallCount });
    }, 60_000);
    assertEquals(refreshCallCount, 0);
    await cache.refresh("test");
    assertEquals(refreshCallCount, 1);
    assertEquals(cache.read<{ refreshed: number }>("test")?.refreshed, 1);
  } finally {
    await cache.stop();
  }
});

Deno.test("HookCache.refresh deduplicates concurrent calls for same key", async () => {
  const cache = new HookCache(await makeTempStatePath());
  let refreshCallCount = 0;
  try {
    cache.register("test", async () => {
      refreshCallCount++;
      // Simulate slow refresh.
      await new Promise((r) => setTimeout(r, 50));
      await cache.write("test", { ok: true });
    }, 60_000);

    // Fire 5 concurrent refreshes.
    await Promise.all([
      cache.refresh("test"),
      cache.refresh("test"),
      cache.refresh("test"),
      cache.refresh("test"),
      cache.refresh("test"),
    ]);

    // Only one refresh actually ran.
    assertEquals(refreshCallCount, 1);
  } finally {
    await cache.stop();
  }
});

Deno.test("HookCache.invalidate clears data + triggers refresh", async () => {
  const cache = new HookCache(await makeTempStatePath());
  let refreshCallCount = 0;
  try {
    // Refresh function simulates a real async fetch (yields before write).
    cache.register("test", async () => {
      await new Promise((r) => setTimeout(r, 5)); // simulate API latency
      refreshCallCount++;
      await cache.write("test", { count: refreshCallCount });
    }, 60_000);

    // Initial populate.
    await cache.refresh("test");
    assertEquals(refreshCallCount, 1);
    assert(cache.read("test") !== undefined);

    // Invalidate: clears data immediately, triggers async refresh.
    cache.invalidate("test");
    // Data cleared synchronously — refresh hasn't run yet because of the
    // simulated latency above.
    assertEquals(cache.read("test"), undefined);
    // Wait for invalidate-triggered refresh to complete.
    await new Promise((r) => setTimeout(r, 50));
    assert(refreshCallCount >= 2);
    assert(cache.read("test") !== undefined);
  } finally {
    await cache.stop();
  }
});

Deno.test("HookCache.refresh captures error on failed refresh", async () => {
  const cache = new HookCache(await makeTempStatePath());
  try {
    cache.register(
      "test",
      async () => {
        throw new Error("network down");
      },
      60_000,
    );
    await cache.refresh("test");
    // Error captured, no throw.
    const meta = cache.meta("test");
    assertEquals(meta.hasData, false);
    assertStringIncludes(meta.lastError ?? "", "network down");
  } finally {
    await cache.stop();
  }
});

Deno.test("HookCache.refreshAll runs all registered refresh functions", async () => {
  const cache = new HookCache(await makeTempStatePath());
  const refreshed: string[] = [];
  try {
    cache.register("a", async () => {
      refreshed.push("a");
      await cache.write("a", { ok: true });
    }, 60_000);
    cache.register("b", async () => {
      refreshed.push("b");
      await cache.write("b", { ok: true });
    }, 60_000);
    await cache.refreshAll();
    assertEquals(refreshed.sort(), ["a", "b"]);
  } finally {
    await cache.stop();
  }
});

Deno.test("HookCache.load is silent no-op when cache file absent", async () => {
  const cache = new HookCache(await makeTempStatePath());
  try {
    await cache.load(); // should not throw
    assertEquals(cache.read("anything"), undefined);
  } finally {
    await cache.stop();
  }
});

Deno.test("HookCache.load handles corrupt cache file gracefully", async () => {
  const statePath = await makeTempStatePath();
  await Deno.writeTextFile(join(statePath, "hook-cache.json"), "not json");
  const cache = new HookCache(statePath);
  try {
    await cache.load(); // should not throw, just warn
    assertEquals(cache.read("anything"), undefined);
  } finally {
    await cache.stop();
  }
});

// Local helper (smaller than importing @std/assert just for one use).
function assertStringIncludes(haystack: string, needle: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`Expected "${needle}" in: ${haystack}`);
  }
}
