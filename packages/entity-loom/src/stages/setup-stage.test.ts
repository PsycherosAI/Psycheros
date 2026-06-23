/**
 * Tests for stale-running checkpoint recovery on package resume.
 *
 * If the process dies mid-stage, the persisted checkpoint still says
 * status: "running" even though nothing is actually running in memory. On
 * the next resume the UI would trust the stale value and hide the Start
 * button. recoverStaleRunningStages() flips stale "running" statuses on
 * resumable background stages to "aborted", preserving processedItems and
 * failedItems so resume picks up where the crashed run left off.
 */

import { assertEquals } from "@std/assert";
import type { CheckpointStateV2 } from "../types.ts";
import { acquireStageLock, releaseStageLock } from "../server/stage-lock.ts";
import { recoverStaleRunningStages } from "./setup-stage.ts";

function makeCheckpoint(
  overrides: Partial<CheckpointStateV2["stages"]> = {},
): CheckpointStateV2 {
  const base = {
    status: "pending",
    completed: false,
    processedItems: [] as string[],
    failedItems: [] as string[],
  } as const;
  return {
    version: 2,
    currentStage: "significant",
    platform: "chatgpt",
    instanceId: "entity-loom",
    entityName: "TestEntity",
    userName: "TestUser",
    contextNotes: "",
    inputPath: "",
    startedAt: new Date().toISOString(),
    stages: {
      setup: { ...base },
      convert: { ...base },
      significant: { ...base, ...overrides.significant },
      daily: { ...base, ...overrides.daily },
      graph: { ...base, ...overrides.graph },
    },
  };
}

Deno.test({
  name: "flips stale 'running' significant stage to 'aborted', preserves items",
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    releaseStageLock();
    const cp = makeCheckpoint({
      significant: {
        status: "running",
        completed: false,
        processedItems: ["conv-1", "conv-2", "conv-3"],
        failedItems: ["conv-broken"],
      },
    });

    const changed = recoverStaleRunningStages(cp);

    assertEquals(changed, true);
    assertEquals(cp.stages.significant.status, "aborted");
    assertEquals(cp.stages.significant.completed, false);
    assertEquals(cp.stages.significant.processedItems, [
      "conv-1",
      "conv-2",
      "conv-3",
    ]);
    assertEquals(cp.stages.significant.failedItems, ["conv-broken"]);
  },
});

Deno.test({
  name: "flips stale 'running' on daily and graph stages too",
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    releaseStageLock();
    const cp = makeCheckpoint({
      daily: {
        status: "running",
        completed: false,
        processedItems: ["2026-06-12"],
        failedItems: [],
      },
      graph: {
        status: "running",
        completed: false,
        processedItems: ["batch-1"],
        failedItems: [],
      },
    });

    const changed = recoverStaleRunningStages(cp);

    assertEquals(changed, true);
    assertEquals(cp.stages.daily.status, "aborted");
    assertEquals(cp.stages.graph.status, "aborted");
    assertEquals(cp.stages.daily.processedItems, ["2026-06-12"]);
    assertEquals(cp.stages.graph.processedItems, ["batch-1"]);
  },
});

Deno.test({
  name:
    "leaves setup and convert alone even if marked 'running' (not resumable background)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    releaseStageLock();
    const cp = makeCheckpoint();
    // Forcibly mark setup/convert as running — they should NOT be touched
    cp.stages.setup.status = "running";
    cp.stages.convert.status = "running";

    const changed = recoverStaleRunningStages(cp);

    // No background stages are stale, so nothing changed
    assertEquals(changed, false);
    assertEquals(cp.stages.setup.status, "running");
    assertEquals(cp.stages.convert.status, "running");
  },
});

Deno.test({
  name: "no-op when nothing is stale",
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    releaseStageLock();
    const cp = makeCheckpoint({
      significant: {
        status: "completed",
        completed: true,
        processedItems: ["conv-1"],
        failedItems: [],
      },
    });

    const changed = recoverStaleRunningStages(cp);

    assertEquals(changed, false);
    assertEquals(cp.stages.significant.status, "completed");
    assertEquals(cp.stages.significant.completed, true);
  },
});

Deno.test({
  name:
    "no-op when a stage is genuinely running in memory (don't fight the live run)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn() {
    releaseStageLock();
    const signal = acquireStageLock("significant");
    assertEquals(signal !== null, true, "test should acquire the lock");

    try {
      const cp = makeCheckpoint({
        significant: {
          status: "running",
          completed: false,
          processedItems: ["conv-1"],
          failedItems: [],
        },
        daily: {
          status: "running",
          completed: false,
          processedItems: [],
          failedItems: [],
        },
      });

      const changed = recoverStaleRunningStages(cp);

      // Live stage running — don't touch the checkpoint.
      assertEquals(changed, false);
      assertEquals(cp.stages.significant.status, "running");
      assertEquals(cp.stages.daily.status, "running");
    } finally {
      releaseStageLock();
    }
  },
});
