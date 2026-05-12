/**
 * Snapshot MCP tools (src/tools/snapshot.ts)
 *
 * MCP snapshot tools for the entity to manage snapshots of their identity files.
 */

import { z } from "zod";
import type { FileStore } from "../storage/mod.ts";
import {
  createFullSnapshot,
  getSnapshotContent,
  listSnapshots,
  restoreSnapshot,
} from "../snapshot/mod.ts";

/**
 * Input schema for snapshot_list tool.
 */
export const SnapshotListSchema = z.object({
  category: z.enum(["self", "user", "relationship", "custom"]).optional(),
  filename: z.string().optional(),
});

/**
 * Input schema for snapshot restore tool.
 */
export const SnapshotRestoreSchema = z.object({
  snapshotId: z.string().min(1),
});

/**
 * Input schema for snapshot get tool.
 */
export const SnapshotGetSchema = z.object({
  snapshotId: z.string().min(1),
});

/**
 * Input schema for snapshot create tool.
 */
export const SnapshotCreateSchema = z.object({});

/**
 * Output type for snapshot list tool.
 */
export type SnapshotListOutput = {
  success: boolean;
  snapshots: Array<{
    id: string;
    category: string;
    filename: string;
    timestamp: string;
    date: string;
    reason: string;
    source: string;
  }>;
  error?: string;
};

/**
 * Output type for snapshot restore tool.
 */
export type SnapshotRestoreOutput = {
  success: boolean;
  message: string;
  error?: string;
};

/**
 * Output type for snapshot create tool.
 */
export type SnapshotCreateOutput = {
  success: boolean;
  snapshots: Array<{
    id: string;
    category: string;
    filename: string;
    timestamp: string;
  }>;
  error?: string;
};

/**
 * Output type for snapshot get tool.
 */
export type SnapshotGetOutput = {
  success: boolean;
  content?: string;
  error?: string;
};

/**
 * Tool definitions for MCP registration.
 */
export const snapshotTools = {
  "snapshot/create": {
    description:
      "I create a snapshot of all my identity files. This backs up my current state so I can restore it later if needed.",
    inputSchema: SnapshotCreateSchema,
  },
  "snapshot/list": {
    description:
      "I list available snapshots of my identity files. Snapshots are grouped by date and show when they were created.",
    inputSchema: SnapshotListSchema,
  },
  "snapshot/get": {
    description:
      "I get the content of a specific snapshot. This returns the snapshot file contents for preview.",
    inputSchema: SnapshotGetSchema,
  },
  "snapshot/restore": {
    description:
      "I restore my identity files from a specific snapshot. This will replace my current files with the snapshot content.",
    inputSchema: SnapshotRestoreSchema,
  },
};

/**
 * Create the snapshot/list tool handler.
 */
export function createSnapshotListHandler(store: FileStore) {
  return async (
    input: z.infer<typeof SnapshotListSchema>,
  ): Promise<SnapshotListOutput> => {
    const result = await listSnapshots(store, input.category, input.filename);

    if (!result.success) {
      return { success: false, snapshots: [], error: result.error };
    }

    return {
      success: true,
      snapshots: result.snapshots.map((s) => ({
        id: s.id,
        category: s.category,
        filename: s.filename,
        timestamp: s.timestamp,
        date: s.date,
        reason: s.reason,
        source: s.source,
      })),
    };
  };
}

/**
 * Create the snapshot/restore tool handler.
 */
export function createSnapshotRestoreHandler(store: FileStore) {
  return async (
    input: z.infer<typeof SnapshotRestoreSchema>,
  ): Promise<SnapshotRestoreOutput> => {
    const result = await restoreSnapshot(store, input.snapshotId);
    return result;
  };
}

/**
 * Create the snapshot/get tool handler.
 */
export function createSnapshotGetHandler(store: FileStore) {
  return async (
    input: z.infer<typeof SnapshotGetSchema>,
  ): Promise<SnapshotGetOutput> => {
    const result = await getSnapshotContent(store, input.snapshotId);
    return result;
  };
}

/**
 * Create the snapshot/create tool handler.
 */
export function createSnapshotCreateHandler(store: FileStore) {
  return async (): Promise<SnapshotCreateOutput> => {
    const result = await createFullSnapshot(store, "manual", "entity-core");

    return {
      success: true,
      snapshots: result.map((s) => ({
        id: s.id,
        category: s.category,
        filename: s.filename,
        timestamp: s.timestamp,
      })),
    };
  };
}
