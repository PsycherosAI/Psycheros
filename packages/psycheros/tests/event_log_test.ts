import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  formatEventForFile,
  type PluginEvent,
  PluginEventLog,
  PluginEventLogRegistry,
} from "../src/plugins/event-log.ts";

async function withLog<T>(
  fn: (log: PluginEventLog, dir: string) => Promise<T>,
  options?: { bufferMax?: number; rotateBytes?: number },
): Promise<T> {
  const dir = await Deno.makeTempDir();
  const log = new PluginEventLog("test-plugin", dir, options);
  try {
    return await fn(log, dir);
  } finally {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch {
      // best-effort cleanup
    }
  }
}

Deno.test("formatEventForFile produces a single-line, greppable record", () => {
  const event: PluginEvent = {
    timestamp: "2026-07-17T14:23:01.123Z",
    pluginId: "speech",
    level: "warn",
    category: "env",
    message: "env file refused 2 denied var(s)",
    details: { names: ["HTTP_PROXY", "NODE_TLS_REJECT_UNAUTHORIZED"] },
  };
  const line = formatEventForFile(event);
  // No embedded newlines — survives cat/copy/paste.
  assertEquals(line.includes("\n"), false);
  // Fixed prefix ordering: timestamp, level, category, message.
  assertStringIncludes(line, "[2026-07-17T14:23:01.123Z] [WARN] [env]");
  assertStringIncludes(line, "env file refused 2 denied var(s)");
  // Details render as compact JSON at the tail.
  assertStringIncludes(line, '"names":["HTTP_PROXY');
  // Level is uppercased in the file format.
  assertEquals(line.includes("[warn]"), false);
});

Deno.test("formatEventForFile omits details blob when none are present", () => {
  const line = formatEventForFile({
    timestamp: "2026-07-17T14:23:01.000Z",
    pluginId: "p",
    level: "info",
    category: "lifecycle",
    message: "loaded v1.0.0",
  });
  // No trailing JSON, no trailing space.
  assertEquals(
    line,
    "[2026-07-17T14:23:01.000Z] [INFO] [lifecycle] loaded v1.0.0",
  );
});

Deno.test("formatEventForFile collapses embedded newlines in message", () => {
  const line = formatEventForFile({
    timestamp: "t",
    pluginId: "p",
    level: "error",
    category: "hook",
    message: "first line\nsecond line\nthird",
  });
  // Newlines become spaces — keeps one-event-per-line file invariant.
  assertEquals(line.includes("\n"), false);
  assertStringIncludes(line, "first line second line third");
});

Deno.test("PluginEventLog records to ring buffer and plain-text file", async () => {
  await withLog(async (log, dir) => {
    await log.record({
      level: "info",
      category: "lifecycle",
      message: "loaded v1.0.0",
    });
    await log.record({
      level: "warn",
      category: "budget",
      message: "hook truncated",
      details: { hook: "search", originalChars: 8000, truncatedChars: 1840 },
    });

    const snapshot = log.snapshot();
    assertEquals(snapshot.length, 2);
    assertEquals(snapshot[0].level, "info");
    assertEquals(snapshot[1].level, "warn");
    assertEquals(snapshot[1].details?.hook, "search");
    // Snapshots are copies — mutating the returned array doesn't affect the log.
    snapshot.push({
      timestamp: "fake",
      pluginId: "test-plugin",
      level: "error",
      category: "hook",
      message: "should not stick",
    });
    assertEquals(log.snapshot().length, 2);

    const fileContent = await Deno.readTextFile(join(dir, "test-plugin.log"));
    assertEquals(fileContent.split("\n").filter(Boolean).length, 2);
    assertStringIncludes(fileContent, "[INFO] [lifecycle] loaded v1.0.0");
    assertStringIncludes(fileContent, "[WARN] [budget] hook truncated");
    assertStringIncludes(fileContent, '"hook":"search"');
  });
});

Deno.test("PluginEventLog ring buffer drops oldest when over capacity", async () => {
  await withLog(async (log) => {
    for (let i = 0; i < 5; i++) {
      await log.record({
        level: "info",
        category: "lifecycle",
        message: `event-${i}`,
      });
    }
    const all = log.snapshot();
    assertEquals(all.length, 3);
    // Oldest two are gone; newest three remain in order.
    assertEquals(all[0].message, "event-2");
    assertEquals(all[2].message, "event-4");
  }, { bufferMax: 3 });
});

Deno.test("PluginEventLog rotates file when it crosses the rotate threshold", async () => {
  // Use a tiny rotate threshold so the test doesn't have to write MBs.
  // Each line is ~150 bytes; rotation check fires every 64 appends, so
  // after 70+ appends at least one rotation is guaranteed.
  await withLog(async (log, dir) => {
    for (let i = 0; i < 80; i++) {
      await log.record({
        level: "info",
        category: "lifecycle",
        message: `event-${i}-${"x".repeat(80)}`,
      });
    }
    // Rotation renames the active file to .log.1. After 80 appends with
    // rotation checks at append 64, the prior 63 events live in the rotated
    // file and the active file contains only events written since.
    const rotatedStat = await Deno.stat(join(dir, "test-plugin.log.1"));
    assert(rotatedStat.isFile, "rotated file .log.1 should exist");
    const activeStat = await Deno.stat(join(dir, "test-plugin.log"));
    assert(activeStat.isFile);
    // Active file holds only events since the last rotation (~16 events),
    // so it should be meaningfully smaller than the rotated file.
    assert(
      activeStat.size < rotatedStat.size,
      `active (${activeStat.size}B) should be smaller than rotated (${rotatedStat.size}B)`,
    );
    // The in-memory ring buffer is unaffected by file rotation (default
    // cap is 200, we wrote 80).
    assertEquals(log.snapshot().length, 80);
  }, { rotateBytes: 1024 });
});

Deno.test("PluginEventLogRegistry shares one log per plugin id", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const registry = new PluginEventLogRegistry(dir);
    const a = registry.for("alpha");
    const b = registry.for("alpha");
    assertEquals(a, b);
    const c = registry.for("beta");
    assert(a !== c);

    await registry.record("alpha", {
      level: "info",
      category: "lifecycle",
      message: "hello alpha",
    });
    assertEquals(registry.snapshot("alpha").length, 1);
    // Plugins with no events yet return empty snapshot.
    assertEquals(registry.snapshot("beta").length, 0);
    // File path is consistent regardless of whether events exist.
    assertEquals(
      registry.filePath("gamma"),
      join(dir, "gamma.log"),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("PluginEventLogRegistry drops events when disabled", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const registry = new PluginEventLogRegistry(dir);
    registry.enabled = false;
    await registry.record("alpha", {
      level: "info",
      category: "lifecycle",
      message: "should be dropped",
    });
    assertEquals(registry.snapshot("alpha").length, 0);
    // File should not exist either.
    try {
      await Deno.stat(join(dir, "alpha.log"));
      assert(false, "file should not exist when registry is disabled");
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
