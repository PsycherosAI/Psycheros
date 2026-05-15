/**
 * Tests for stage-lock progress snapshot behavior.
 *
 * Module-level mutable state means tests must clean up via releaseStageLock().
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  acquireStageLock,
  getProgressSnapshot,
  getRunningStage,
  releaseStageLock,
  setProgressSnapshot,
} from "./stage-lock.ts";

// Reset state between tests
function reset() {
  releaseStageLock();
}

Deno.test("progress snapshot is null when no stage is running", () => {
  reset();
  assertEquals(getProgressSnapshot(), null);
});

Deno.test("acquiring a lock clears any previous snapshot", () => {
  reset();

  // Acquire and set a snapshot
  const sig1 = acquireStageLock("significant");
  assertNotEquals(sig1, null);
  setProgressSnapshot({ current: 50, total: 100, percent: 50 });
  assertEquals(getProgressSnapshot(), { current: 50, total: 100, percent: 50 });

  // Release and re-acquire — snapshot should be wiped
  releaseStageLock();
  assertEquals(getProgressSnapshot(), null);

  const sig2 = acquireStageLock("significant");
  assertNotEquals(sig2, null);
  assertEquals(getProgressSnapshot(), null);

  reset();
});

Deno.test("progress snapshot updates as stage advances", () => {
  reset();

  const sig = acquireStageLock("daily");
  assertNotEquals(sig, null);
  assertEquals(getRunningStage(), "daily");

  setProgressSnapshot({ current: 1, total: 10, percent: 10 });
  assertEquals(getProgressSnapshot(), { current: 1, total: 10, percent: 10 });

  setProgressSnapshot({ current: 5, total: 10, percent: 50 });
  assertEquals(getProgressSnapshot(), { current: 5, total: 10, percent: 50 });

  setProgressSnapshot({ current: 10, total: 10, percent: 100 });
  assertEquals(getProgressSnapshot(), { current: 10, total: 10, percent: 100 });

  reset();
});

Deno.test("release clears snapshot", () => {
  reset();

  const sig = acquireStageLock("graph");
  assertNotEquals(sig, null);
  setProgressSnapshot({ current: 3, total: 5, percent: 60 });
  assertEquals(getProgressSnapshot(), { current: 3, total: 5, percent: 60 });

  releaseStageLock();
  assertEquals(getRunningStage(), null);
  assertEquals(getProgressSnapshot(), null);
});

Deno.test("cannot acquire lock while another stage holds it", () => {
  reset();

  const sig1 = acquireStageLock("significant");
  assertNotEquals(sig1, null);

  const sig2 = acquireStageLock("daily");
  assertEquals(sig2, null);
  assertEquals(getRunningStage(), "significant");

  reset();
});
