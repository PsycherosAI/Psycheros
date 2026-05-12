/**
 * Conflict Resolution
 *
 * Strategies for resolving conflicts when multiple embodiments
 * modify the same data concurrently.
 */

import type {
  ConflictInfo,
  IdentityFile,
  MemoryEntry,
  VectorClock,
} from "../types.ts";
import { compare } from "./versioning.ts";

/**
 * Priority order for embodiments (higher index = higher priority).
 * Used as a tie-breaker when timestamps are equal.
 */
const INSTANCE_PRIORITY: Record<string, number> = {
  "sby-harness": 3,
  "claude-code": 2,
  "sillytavern": 1,
  "openwebui": 0,
};

/**
 * Resolution strategy for conflicts.
 */
export type ResolutionStrategy =
  | "last_write_wins" // Use timestamp to decide
  | "instance_priority" // Use instance priority to decide
  | "merge" // Attempt to merge (for memories only)
  | "manual"; // Require human intervention

/**
 * Resolve a conflict between two identity files.
 */
export function resolveIdentityConflict(
  local: IdentityFile,
  server: IdentityFile,
  strategy: ResolutionStrategy = "last_write_wins",
): { winner: IdentityFile; resolution: ConflictInfo["suggestedResolution"] } {
  if (strategy === "last_write_wins") {
    const localTime = new Date(local.lastModified).getTime();
    const serverTime = new Date(server.lastModified).getTime();

    if (localTime > serverTime) {
      return { winner: local, resolution: "keep_local" };
    } else if (serverTime > localTime) {
      return { winner: server, resolution: "keep_server" };
    }
    // Timestamps equal, use instance priority as tiebreaker
  }

  if (strategy === "last_write_wins" || strategy === "instance_priority") {
    const localPriority = INSTANCE_PRIORITY[local.modifiedBy] ?? 0;
    const serverPriority = INSTANCE_PRIORITY[server.modifiedBy] ?? 0;

    if (localPriority >= serverPriority) {
      return { winner: local, resolution: "keep_local" };
    } else {
      return { winner: server, resolution: "keep_server" };
    }
  }

  // strategy === "manual"
  return { winner: server, resolution: "merge" }; // Default to server, flag for manual
}

/**
 * Resolve a conflict between two memory entries.
 * Memories are append-only, so conflicts result in both being preserved.
 */
export function resolveMemoryConflict(
  local: MemoryEntry,
  server: MemoryEntry,
): { winner: MemoryEntry; resolution: ConflictInfo["suggestedResolution"] } {
  // For memories, we typically want to merge by keeping both
  // The consolidation process will handle deduplication
  const merged: MemoryEntry = {
    ...server,
    content: `${server.content}\n\n---\n\n${local.content}`,
    chatIds: [...new Set([...server.chatIds, ...local.chatIds])],
    participatingInstances: [
      ...new Set([
        ...(server.participatingInstances ?? []),
        ...(local.participatingInstances ?? []),
      ]),
    ],
    updatedAt: new Date().toISOString(),
  };

  return { winner: merged, resolution: "merge" };
}

/**
 * Detect conflicts between local and server versions.
 */
export function detectIdentityConflict(
  local: IdentityFile,
  server: IdentityFile,
): boolean {
  // Conflict if both have been modified since last sync
  // and the content is different
  if (local.content === server.content) {
    return false;
  }

  // If versions are the same but content differs, it's a conflict
  if (local.version === server.version) {
    return true;
  }

  // If local is based on an older server version, no conflict
  // (server wins)
  return local.version > server.version;
}

/**
 * Create conflict info for reporting.
 */
export function createConflictInfo(
  entityType: "identity" | "memory",
  entityId: string,
  local: IdentityFile | MemoryEntry,
  server: IdentityFile | MemoryEntry,
  suggestedResolution: ConflictInfo["suggestedResolution"],
): ConflictInfo {
  return {
    entityType,
    entityId,
    localVersion: local,
    serverVersion: server,
    suggestedResolution,
  };
}

/**
 * Check if two vector clocks indicate a conflict.
 */
export function hasVersionConflict(
  localVersion: VectorClock,
  serverVersion: VectorClock,
  baseVersion?: VectorClock,
): boolean {
  if (!baseVersion) {
    // No base version, check if clocks are concurrent
    return compare(localVersion, serverVersion) === 0;
  }

  // Check if both local and server have diverged from base
  const localChanged = compare(localVersion, baseVersion) !== 0;
  const serverChanged = compare(serverVersion, baseVersion) !== 0;

  return localChanged && serverChanged;
}
