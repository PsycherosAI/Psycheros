/**
 * Sync Module
 *
 * Handles synchronization between my core and embodiments.
 */

export {
  compare,
  createVectorClock,
  createVersionedEntity,
  happensBefore,
  increment,
  merge,
  updateVersion,
} from "./versioning.ts";

export {
  createConflictInfo,
  detectIdentityConflict,
  hasVersionConflict,
  type ResolutionStrategy,
  resolveIdentityConflict,
  resolveMemoryConflict,
} from "./conflict.ts";
