/**
 * Snapshot Types
 *
 * Type definitions for the snapshot system.
 */

/**
 * Valid identity categories for snapshots.
 */
export type SnapshotCategory = "self" | "user" | "relationship" | "custom";

/**
 * Reason for creating a snapshot.
 */
export type SnapshotReason = "scheduled" | "manual" | "pre-replace";

/**
 * Source of the snapshot.
 */
export type SnapshotSource = "psycheros" | "entity-core";

/**
 * Metadata for a single snapshot.
 */
export interface SnapshotMeta {
  /** Unique identifier for restore (category/filename_timestamp) */
  id: string;
  /** The identity category */
  category: SnapshotCategory;
  /** Original filename */
  filename: string;
  /** ISO timestamp when snapshot was created */
  timestamp: string;
  /** Date portion (YYYY-MM-DD) */
  date: string;
  /** Why the snapshot was created */
  reason: SnapshotReason;
  /** Which system created this snapshot */
  source: SnapshotSource;
}

/**
 * Result of listing snapshots.
 */
export interface SnapshotListResult {
  success: boolean;
  snapshots: SnapshotMeta[];
  error?: string;
}

/**
 * Result of getting snapshot content.
 */
export interface SnapshotContentResult {
  success: boolean;
  content?: string;
  error?: string;
}

/**
 * Result of restoring a snapshot.
 */
export interface SnapshotRestoreResult {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Result of creating snapshots.
 */
export interface SnapshotCreateResult {
  success: boolean;
  snapshots: SnapshotMeta[];
  error?: string;
}

/**
 * Result of cleaning up old snapshots.
 */
export interface SnapshotCleanupResult {
  success: boolean;
  deleted: number;
  kept: number;
  error?: string;
}
