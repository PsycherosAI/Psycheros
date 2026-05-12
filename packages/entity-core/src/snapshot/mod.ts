/**
 * Snapshot Module
 *
 * Provides periodic snapshots of identity files with retention cleanup.
 * Snapshots are stored in .snapshots/{category}/{filename}_{timestamp}.md
 */

import { join } from "@std/path";
import type { FileStore } from "../storage/mod.ts";
import type {
  SnapshotCategory,
  SnapshotCleanupResult,
  SnapshotContentResult,
  SnapshotListResult,
  SnapshotMeta,
  SnapshotReason,
  SnapshotRestoreResult,
  SnapshotSource,
} from "./types.ts";

/**
 * Get the list of valid identity categories.
 */
export const IDENTITY_CATEGORIES: SnapshotCategory[] = [
  "self",
  "user",
  "relationship",
  "custom",
];

/**
 * Create a full snapshot of all identity files.
 *
 * @param store - The file store to use
 * @param reason - Why the snapshot is being created
 * @param source - Which system is creating the snapshot
 * @returns Array of created snapshot metadata
 */
export async function createFullSnapshot(
  store: FileStore,
  reason: SnapshotReason,
  source: SnapshotSource,
): Promise<SnapshotMeta[]> {
  const snapshots: SnapshotMeta[] = [];

  for (const category of IDENTITY_CATEGORIES) {
    const files = await store.readIdentityCategory(category);

    for (const file of files) {
      const snapshot = await createSnapshot(
        store,
        category,
        file.filename,
        file.content,
        reason,
        source,
      );

      if (snapshot) {
        snapshots.push(snapshot);
      }
    }
  }

  console.log(`[Snapshot] Created ${snapshots.length} snapshots (${reason})`);
  return snapshots;
}

/**
 * Create a snapshot of a single identity file.
 *
 * @param store - The file store to use
 * @param category - The identity category
 * @param filename - The filename to snapshot
 * @param content - The content to snapshot
 * @param reason - Why the snapshot is being created
 * @param source - Which system is creating the snapshot
 * @returns The created snapshot metadata, or null if failed
 */
export async function createSnapshot(
  store: FileStore,
  category: SnapshotCategory,
  filename: string,
  content: string,
  reason: SnapshotReason,
  source: SnapshotSource,
): Promise<SnapshotMeta | null> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const date = new Date().toISOString().split("T")[0];
  const snapshotFilename = `${filename.replace(/\.md$/, "")}_${timestamp}.md`;
  const snapshotDir = join(store.dataDirectory, ".snapshots", category);
  const snapshotPath = join(snapshotDir, snapshotFilename);

  try {
    await Deno.mkdir(snapshotDir, { recursive: true });

    const snapshotContent = `# Snapshot: ${category}/${filename}
# Date: ${date}
# Reason: ${reason}
# Source: ${source}

${content}
`;

    await Deno.writeTextFile(snapshotPath, snapshotContent);

    const meta: SnapshotMeta = {
      id: `${category}/${filename.replace(/\.md$/, "")}_${timestamp}`,
      category,
      filename,
      timestamp: new Date().toISOString(),
      date,
      reason,
      source,
    };

    console.log(`[Snapshot] Created: ${category}/${filename}`);
    return meta;
  } catch (error) {
    console.error(`[Snapshot] Failed to create snapshot:`, error);
    return null;
  }
}

/**
 * List available snapshots with optional filtering.
 *
 * @param store - The file store to use
 * @param category - Optional category filter
 * @param filename - Optional filename filter
 * @returns Object with success status and array of snapshot metadata
 */
export async function listSnapshots(
  store: FileStore,
  category?: SnapshotCategory,
  filename?: string,
): Promise<SnapshotListResult> {
  const snapshots: SnapshotMeta[] = [];
  const snapshotsDir = join(store.dataDirectory, ".snapshots");

  const categories = category ? [category] : IDENTITY_CATEGORIES;

  for (const cat of categories) {
    const catDir = join(snapshotsDir, cat);
    try {
      const entries = Deno.readDir(catDir);
      for await (const entry of entries) {
        if (!entry.isFile || !entry.name.endsWith(".md")) continue;

        // Filter by filename if specified
        if (filename) {
          const baseName = filename.replace(/\.md$/, "");
          if (!entry.name.startsWith(baseName)) continue;
        }

        // Parse snapshot metadata from filename
        const meta = parseSnapshotFilename(cat, entry.name);
        if (meta) {
          // Read file header to extract actual reason and source
          try {
            const header = await readSnapshotHeader(join(catDir, entry.name));
            if (header.reason) meta.reason = header.reason;
            if (header.source) meta.source = header.source;
          } catch {
            // Keep defaults from parseSnapshotFilename
          }
          snapshots.push(meta);
        }
      }
    } catch {
      // Directory doesn't exist, skip
    }
  }

  // Sort by date descending
  snapshots.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return { success: true, snapshots };
}

/**
 * Parse snapshot metadata from filename.
 *
 * @param category - The category directory
 * @param filename - The snapshot filename
 * @returns Parsed metadata or null if invalid
 */
function parseSnapshotFilename(
  category: SnapshotCategory,
  filename: string,
): SnapshotMeta | null {
  // Format: {originalFilename}_{ISO-timestamp}.md
  // Timestamp format: 2026-03-02T07-21-27-605Z (colons and dots replaced with dashes)
  const match = filename.match(/^(.+)_(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.md$/);
  if (!match) return null;

  const [, originalFilename, timestamp] = match;
  // Extract date from timestamp (first 10 characters: YYYY-MM-DD)
  const date = timestamp.substring(0, 10);

  return {
    id: `${category}/${originalFilename}_${timestamp}`,
    category,
    filename: `${originalFilename}.md`,
    timestamp,
    date,
    reason: "manual" as SnapshotReason,
    source: "entity-core" as SnapshotSource,
  };
}

/**
 * Read the header of a snapshot file to extract reason and source.
 * Only reads the first 5 lines to avoid loading full file content.
 */
async function readSnapshotHeader(
  filePath: string,
): Promise<{ reason?: SnapshotReason; source?: SnapshotSource }> {
  const file = await Deno.open(filePath, { read: true });
  const buf = new Uint8Array(512); // Header is ~120 bytes, 512 is plenty
  const bytesRead = await file.read(buf);
  file.close();
  if (!bytesRead) return {};

  const header = new TextDecoder().decode(buf.subarray(0, bytesRead));
  const lines = header.split("\n").slice(0, 5);

  let reason: SnapshotReason | undefined;
  let source: SnapshotSource | undefined;

  for (const line of lines) {
    const reasonMatch = line.match(/^# Reason:\s*(.+)$/);
    if (reasonMatch) {
      const val = reasonMatch[1].trim();
      if (val === "scheduled" || val === "manual" || val === "pre-replace") {
        reason = val;
      }
    }
    const sourceMatch = line.match(/^# Source:\s*(.+)$/);
    if (sourceMatch) {
      const val = sourceMatch[1].trim();
      if (val === "psycheros" || val === "entity-core") {
        source = val;
      }
    }
  }

  return { reason, source };
}

/**
 * Get the content of a specific snapshot.
 *
 * @param store - The file store to use
 * @param snapshotId - The snapshot ID (category/filename_timestamp)
 * @returns Object with success status and content
 */
export async function getSnapshotContent(
  store: FileStore,
  snapshotId: string,
): Promise<SnapshotContentResult> {
  // Parse the snapshot ID
  const match = snapshotId.match(/^(.+)\/(.+)$/);
  if (!match) {
    return { success: false, error: "Invalid snapshot ID format" };
  }

  const [, categoryStr, filenamePart] = match;
  if (!IDENTITY_CATEGORIES.includes(categoryStr as SnapshotCategory)) {
    return { success: false, error: "Invalid category" };
  }

  const category = categoryStr as SnapshotCategory;
  const snapshotPath = join(
    store.dataDirectory,
    ".snapshots",
    category,
    `${filenamePart}.md`,
  );

  try {
    const content = await Deno.readTextFile(snapshotPath);
    return { success: true, content };
  } catch {
    return { success: false, error: "Snapshot not found" };
  }
}

/**
 * Restore a snapshot to the current identity file.
 *
 * @param store - The file store to use
 * @param snapshotId - The snapshot ID to restore
 * @returns Object with success status and message
 */
export async function restoreSnapshot(
  store: FileStore,
  snapshotId: string,
): Promise<SnapshotRestoreResult> {
  // Get the snapshot content
  const contentResult = await getSnapshotContent(store, snapshotId);
  if (!contentResult.success || !contentResult.content) {
    return {
      success: false,
      message: contentResult.error || "Failed to read snapshot",
      error: contentResult.error,
    };
  }

  // Parse snapshot ID to get category and filename
  const match = snapshotId.match(/^(.+)\/(.+)_\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
  if (!match) {
    return {
      success: false,
      message: "Invalid snapshot ID format",
      error: "Invalid snapshot ID format",
    };
  }

  const [, categoryStr, filenamePart] = match;
  const category = categoryStr as SnapshotCategory;
  const filename = `${filenamePart}.md`;

  // Extract the actual content (skip the header comments)
  const lines = contentResult.content.split("\n");
  let contentStart = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "" && i > 2) {
      contentStart = i + 1;
      break;
    }
  }
  const content = lines.slice(contentStart).join("\n");

  // Create a snapshot of current file before restoring
  try {
    const existingFiles = await store.readIdentityCategory(category);
    const existing = existingFiles.find((f) => f.filename === filename);
    if (existing) {
      await createSnapshot(
        store,
        category,
        filename,
        existing.content,
        "pre-replace",
        "entity-core",
      );
    }
  } catch {
    // File doesn't exist, that's fine
  }

  // Write the restored content
  try {
    await store.writeIdentityFile({
      category,
      filename,
      content,
      version: 1,
      lastModified: new Date().toISOString(),
      modifiedBy: "snapshot-restore",
    });

    return {
      success: true,
      message: `Restored ${category}/${filename} from snapshot`,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: "Failed to restore snapshot",
      error: errorMessage,
    };
  }
}

/**
 * Clean up snapshots older than the retention period.
 *
 * @param store - The file store to use
 * @param retentionDays - Number of days to keep snapshots
 * @returns Object with deleted and kept counts
 */
export async function cleanupOldSnapshots(
  store: FileStore,
  retentionDays: number,
): Promise<SnapshotCleanupResult> {
  const cutoffDate = new Date();
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - retentionDays);

  let deleted = 0;
  let kept = 0;

  for (const category of IDENTITY_CATEGORIES) {
    const catDir = join(store.dataDirectory, ".snapshots", category);
    try {
      const entries = Deno.readDir(catDir);
      for await (const entry of entries) {
        if (!entry.isFile || !entry.name.endsWith(".md")) continue;

        const meta = parseSnapshotFilename(category, entry.name);
        if (!meta) {
          // Can't parse, keep it
          kept++;
          continue;
        }

        const snapshotDate = new Date(meta.timestamp);
        if (snapshotDate < cutoffDate) {
          try {
            await Deno.remove(join(catDir, entry.name));
            deleted++;
          } catch {
            // Failed to delete, count as kept
            kept++;
          }
        } else {
          kept++;
        }
      }
    } catch {
      // Directory doesn't exist, skip
    }
  }

  console.log(`[Snapshot] Cleanup: deleted ${deleted}, kept ${kept}`);
  return { success: true, deleted, kept };
}
