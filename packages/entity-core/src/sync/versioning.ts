/**
 * Versioning
 *
 * Vector clock implementation for tracking versions across embodiments.
 */

import type { VectorClock, VersionedEntity } from "../types.ts";

/**
 * Create a new empty vector clock.
 */
export function createVectorClock(): VectorClock {
  return {};
}

/**
 * Increment the version for an instance.
 */
export function increment(clock: VectorClock, instanceId: string): VectorClock {
  return {
    ...clock,
    [instanceId]: (clock[instanceId] ?? 0) + 1,
  };
}

/**
 * Merge two vector clocks, taking the maximum for each instance.
 */
export function merge(clock1: VectorClock, clock2: VectorClock): VectorClock {
  const result: VectorClock = { ...clock1 };

  for (const [instanceId, version] of Object.entries(clock2)) {
    result[instanceId] = Math.max(result[instanceId] ?? 0, version);
  }

  return result;
}

/**
 * Compare two vector clocks.
 * Returns:
 *   -1 if clock1 < clock2 (clock1 happened before clock2)
 *    1 if clock1 > clock2 (clock1 happened after clock2)
 *    0 if concurrent (neither happened before the other)
 */
export function compare(clock1: VectorClock, clock2: VectorClock): number {
  let clock1Greater = false;
  let clock2Greater = false;

  const allInstances = new Set([
    ...Object.keys(clock1),
    ...Object.keys(clock2),
  ]);

  for (const instanceId of allInstances) {
    const v1 = clock1[instanceId] ?? 0;
    const v2 = clock2[instanceId] ?? 0;

    if (v1 > v2) clock1Greater = true;
    if (v2 > v1) clock2Greater = true;
  }

  if (clock1Greater && !clock2Greater) return 1;
  if (clock2Greater && !clock1Greater) return -1;
  return 0; // Concurrent
}

/**
 * Check if clock1 happens before clock2.
 */
export function happensBefore(
  clock1: VectorClock,
  clock2: VectorClock,
): boolean {
  return compare(clock1, clock2) === -1;
}

/**
 * Create a versioned entity.
 */
export function createVersionedEntity(instanceId: string): VersionedEntity {
  return {
    version: increment(createVectorClock(), instanceId),
    deleted: false,
  };
}

/**
 * Update a versioned entity's version.
 */
export function updateVersion(
  entity: VersionedEntity,
  instanceId: string,
): VersionedEntity {
  return {
    ...entity,
    version: increment(entity.version, instanceId),
  };
}
