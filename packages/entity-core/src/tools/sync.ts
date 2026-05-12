/**
 * Sync Tools
 *
 * MCP tools for synchronizing my core with embodiments.
 * Handles pull, push, and conflict resolution.
 */

import { z } from "zod";
import type { FileStore } from "../storage/mod.ts";
import type {
  IdentityFile,
  InstanceInfo,
  MemoryEntry,
  SyncResponse,
  SyncToken,
} from "../types.ts";
import { resolveIdentityConflict } from "../sync/mod.ts";
import { cleanupOldSnapshots, createSnapshot } from "../snapshot/mod.ts";
import { getExtractionHealth } from "../graph/memory-integration.ts";

/**
 * Input schema for sync/pull tool.
 */
export const SyncPullSchema = z.object({
  instanceId: z.string().min(1),
  lastSyncVersion: z.number().optional(),
});

/**
 * Input schema for sync/push tool.
 */
export const SyncPushSchema = z.object({
  instance: z.object({
    id: z.string().min(1),
    type: z.enum([
      "psycheros",
      "sby",
      "sillytavern",
      "openwebui",
      "claude-code",
      "other",
    ]),
    name: z.string().optional(),
    version: z.number(),
  }),
  identityChanges: z.array(z.object({
    category: z.enum(["self", "user", "relationship", "custom"]),
    filename: z.string(),
    content: z.string(),
    version: z.number(),
    lastModified: z.string(),
    modifiedBy: z.string(),
  })).optional(),
  memoryChanges: z.array(z.object({
    granularity: z.enum([
      "daily",
      "weekly",
      "monthly",
      "yearly",
      "significant",
    ]),
    date: z.string(),
    content: z.string(),
    chatIds: z.array(z.string()),
    sourceInstance: z.string(),
    participatingInstances: z.array(z.string()).optional(),
    version: z.number(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })).optional(),
  lastSyncVersion: z.number().optional(),
});

/**
 * Server state for tracking sync versions.
 */
interface SyncState {
  serverVersion: number;
  instances: Map<string, InstanceInfo>;
}

// Global sync state (in-memory for now, should persist)
const syncState: SyncState = {
  serverVersion: 1,
  instances: new Map(),
};

/**
 * Generate a sync token.
 */
function generateSyncToken(): SyncToken {
  return {
    serverVersion: syncState.serverVersion,
    timestamp: new Date().toISOString(),
    hash: crypto.randomUUID().slice(0, 8),
  };
}

/**
 * Create the sync/pull tool handler.
 */
export function createSyncPullHandler(store: FileStore) {
  return async (
    input: z.infer<typeof SyncPullSchema>,
  ): Promise<SyncResponse> => {
    const { instanceId } = input;

    // Update instance info
    const existingInstance = syncState.instances.get(instanceId);
    syncState.instances.set(instanceId, {
      id: instanceId,
      type: existingInstance?.type ?? "other",
      lastSync: new Date().toISOString(),
      version: existingInstance?.version ?? 1,
    });

    // Read all identity files
    const identityFiles = await store.readAllIdentity();

    // Read all memories
    const granularities = [
      "daily",
      "weekly",
      "monthly",
      "yearly",
      "significant",
    ] as const;
    const memories: MemoryEntry[] = [];

    for (const granularity of granularities) {
      const list = await store.listMemories(granularity);
      memories.push(...list);
    }

    return {
      success: true,
      identityFiles,
      memories,
      newSyncToken: generateSyncToken(),
    };
  };
}

/**
 * Create the sync/push tool handler.
 */
export function createSyncPushHandler(store: FileStore) {
  return async (
    input: z.infer<typeof SyncPushSchema>,
  ): Promise<SyncResponse> => {
    const { instance, identityChanges = [], memoryChanges = [] } = input;

    // Register/update instance
    syncState.instances.set(instance.id, {
      ...instance,
      lastSync: new Date().toISOString(),
    } as InstanceInfo);

    // Create targeted snapshots before applying identity changes
    if (identityChanges.length > 0) {
      try {
        for (const change of identityChanges) {
          const existingFiles = await store.readIdentityCategory(
            change.category,
          );
          const existing = existingFiles.find((f) =>
            f.filename === change.filename
          );
          if (existing && existing.content.trim().length > 0) {
            await createSnapshot(
              store,
              change.category,
              change.filename,
              existing.content,
              "pre-replace",
              "psycheros",
            );
          }
        }
        // Cleanup old snapshots
        const retentionDays = parseInt(
          Deno.env.get("ENTITY_CORE_SNAPSHOT_RETENTION_DAYS") || "30",
        );
        await cleanupOldSnapshots(store, retentionDays);
      } catch (error) {
        console.error("[Sync] Snapshot creation failed:", error);
        // Continue with sync even if snapshot fails
      }
    }

    const conflicts: SyncResponse["conflicts"] = [];

    // Process identity changes
    for (const change of identityChanges) {
      const identityFile: IdentityFile = change;

      // Read existing file to check for conflicts
      const existingFiles = await store.readIdentityCategory(change.category);
      const existing = existingFiles.find((f) =>
        f.filename === change.filename
      );

      if (existing && existing.content !== change.content) {
        // Conflict detected
        const { winner, resolution } = resolveIdentityConflict(
          identityFile,
          existing,
          "last_write_wins",
        );

        if (resolution === "merge") {
          // Need manual resolution
          conflicts.push({
            entityType: "identity",
            entityId: `${change.category}/${change.filename}`,
            localVersion: identityFile,
            serverVersion: existing,
            suggestedResolution: "merge",
          });
        } else {
          // Auto-resolve
          await store.writeIdentityFile(winner);
        }
      } else {
        // No conflict, write directly
        await store.writeIdentityFile(identityFile);
      }
    }

    // Process memory changes
    for (const change of memoryChanges) {
      const now = new Date().toISOString();
      const memoryEntry: MemoryEntry = {
        ...change,
        id: `${change.granularity}-${change.date}`,
        createdAt: change.createdAt || now,
        updatedAt: change.updatedAt || now,
      };

      // Always use the incoming version (last-write-wins).
      // With per-instance daily filenames, conflicts shouldn't occur for dailies.
      // For other granularities, the incoming edit is authoritative.
      await store.writeMemory(memoryEntry);
    }

    // Increment server version
    syncState.serverVersion++;

    return {
      success: true,
      newSyncToken: generateSyncToken(),
      conflicts: conflicts.length > 0 ? conflicts : undefined,
    };
  };
}

/**
 * Create the sync/status tool handler.
 */
export function createSyncStatusHandler() {
  // deno-lint-ignore require-await
  return async (): Promise<{
    serverVersion: number;
    connectedInstances: Array<{ id: string; lastSync: string }>;
    extraction: ReturnType<typeof getExtractionHealth>;
  }> => {
    return {
      serverVersion: syncState.serverVersion,
      connectedInstances: Array.from(syncState.instances.values()).map((i) => ({
        id: i.id,
        lastSync: i.lastSync ?? "never",
      })),
      extraction: getExtractionHealth(),
    };
  };
}

/**
 * Tool definitions for MCP registration.
 */
export const syncTools = {
  "sync/pull": {
    description:
      "Pull all my identity files and memories from my core. Use this when starting up to sync with my canonical state.",
    inputSchema: SyncPullSchema,
  },
  "sync/push": {
    description:
      "Push changes from an embodiment to my core. I'll resolve conflicts automatically when possible, or flag them for review.",
    inputSchema: SyncPushSchema,
  },
  "sync/status": {
    description:
      "Check the sync status of my core - what version I'm at and which embodiments have connected.",
    inputSchema: z.object({}),
  },
};
