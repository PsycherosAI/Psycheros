/**
 * Unified Backup Service — pre-write archival for all entity-data surfaces.
 *
 * Lives OUTSIDE psycheros.db. Backups are JSONL files on disk:
 *
 *   <dataRoot>/.psycheros/backups/<surface>/<target_id>.jsonl
 *
 * Each line is one snapshot. JSONL (vs one file per snapshot) keeps file
 * count bounded and gives us O(1) append — most writes are appends, prune
 * rewrites the whole file when needed.
 *
 * Optional batch manifest:
 *
 *   <dataRoot>/.psycheros/backups/batches/<batch_id>.json
 *
 * Generated for batch operations (write_entity_data with multiple items,
 * bulk cleanups). Each snapshot taken during a batch is tagged with the
 * batch_id; the manifest indexes them for "undo this whole batch" recovery.
 *
 * Prune rules (per surface+target_id):
 *   - Within 24h of most recent edit: keep up to 5 versions (newest first)
 *   - After 24h quiet: collapse to just the most recent version
 *
 * Lives outside psycheros.db on purpose. Same-DB-as-data was a real design
 * flaw — if psycheros.db corrupts, the backups corrupt with it. Filesystem
 * storage in a different format means SQLite bugs and DB file issues can't
 * take the backups down.
 */

import { join } from "@std/path";

/** Entity data surfaces covered by the backup service. */
export type BackupSurface =
  | "message"
  | "pulse"
  | "lorebook_entry"
  | "vault_doc"
  | "custom_tool";

/** One archived version of a row/file before a write modified it. */
export interface BackupSnapshot {
  id: string;
  surface: BackupSurface;
  targetId: string;
  /** Pre-edit state — JSON for DB rows, raw content for files. */
  contentSnapshot: string;
  archivedAt: string;
  reason?: string;
  /** Tagged when this snapshot was taken as part of a batch operation. */
  batchId?: string;
}

/** Index file for a batch — lists every snapshot taken during one operation. */
export interface BatchManifest {
  batchId: string;
  createdAt: string;
  description?: string;
  reason?: string;
  items: Array<{
    surface: BackupSurface;
    targetId: string;
    snapshotId: string;
  }>;
}

const BACKUPS_SUBDIR = join(".psycheros", "backups");
const CUTOFF_MS = 24 * 60 * 60 * 1000;
const MAX_VERSIONS = 5;

/** Sanitize target_id for filesystem — replace unsafe chars. */
function safeTargetId(id: string): string {
  // Most target IDs are UUIDs or filenames (already safe). This is defense
  // against anything unexpected — never write user-controlled strings
  // directly into a path without sanitizing.
  return id.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

function jsonlPath(
  dataRoot: string,
  surface: string,
  targetId: string,
): string {
  return join(
    dataRoot,
    BACKUPS_SUBDIR,
    surface,
    `${safeTargetId(targetId)}.jsonl`,
  );
}

function batchesDir(dataRoot: string): string {
  return join(dataRoot, BACKUPS_SUBDIR, "batches");
}

function batchManifestPath(dataRoot: string, batchId: string): string {
  return join(batchesDir(dataRoot), `${batchId}.json`);
}

async function ensureDir(path: string): Promise<void> {
  try {
    await Deno.mkdir(path, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
  }
}

export class BackupService {
  constructor(private dataRoot: string) {}

  /**
   * Archive the current state of a row/file before a write modifies it.
   * Returns the snapshot ID. When `batchId` is present, also indexes the
   * snapshot in the batch manifest so the batch can be rolled back as a unit.
   */
  async archive(
    surface: BackupSurface,
    targetId: string,
    contentSnapshot: string,
    options?: { reason?: string; batchId?: string },
  ): Promise<string> {
    const id = crypto.randomUUID();
    const archivedAt = new Date().toISOString();
    const snapshot: BackupSnapshot = {
      id,
      surface,
      targetId,
      contentSnapshot,
      archivedAt,
      ...(options?.reason ? { reason: options.reason } : {}),
      ...(options?.batchId ? { batchId: options.batchId } : {}),
    };

    const path = jsonlPath(this.dataRoot, surface, targetId);
    await ensureDir(join(path, ".."));

    // Atomic write via read-modify-write + rename.
    let existing = "";
    try {
      existing = await Deno.readTextFile(path);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    const updated = existing + JSON.stringify(snapshot) + "\n";
    const tmpPath = `${path}.tmp`;
    await Deno.writeTextFile(tmpPath, updated);
    await Deno.rename(tmpPath, path);

    // Index in batch manifest if part of a batch.
    if (options?.batchId) {
      await this.appendToBatch(options.batchId, snapshot);
    }

    // Prune after every archive.
    await this.prune(surface, targetId);

    return id;
  }

  /**
   * List archived versions for a target, newest first.
   */
  async list(
    surface: BackupSurface,
    targetId: string,
    limit = 100,
  ): Promise<BackupSnapshot[]> {
    const path = jsonlPath(this.dataRoot, surface, targetId);
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return [];
      throw err;
    }
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const snapshots: BackupSnapshot[] = [];
    for (const line of lines) {
      try {
        snapshots.push(JSON.parse(line) as BackupSnapshot);
      } catch {
        // Skip corrupt lines rather than fail the whole read.
      }
    }
    snapshots.sort((a, b) =>
      new Date(b.archivedAt).getTime() - new Date(a.archivedAt).getTime()
    );
    return snapshots.slice(0, limit);
  }

  /**
   * Get the most recent backup for a target. Used by restore operations
   * that don't specify a version.
   */
  async getLatest(
    surface: BackupSurface,
    targetId: string,
  ): Promise<BackupSnapshot | null> {
    const snapshots = await this.list(surface, targetId, 1);
    return snapshots[0] ?? null;
  }

  /**
   * Get a specific snapshot by ID. Searches the target's JSONL file. Caller
   * must know the surface + targetId — we don't scan all files.
   */
  async get(
    surface: BackupSurface,
    targetId: string,
    snapshotId: string,
  ): Promise<BackupSnapshot | null> {
    const snapshots = await this.list(surface, targetId, 1000);
    return snapshots.find((s) => s.id === snapshotId) ?? null;
  }

  /**
   * Apply the prune rule for a (surface, target_id):
   *   - Most recent ≥ 24h old → keep only that one.
   *   - Otherwise → keep versions within 24h, capped at 5 newest.
   * Returns count pruned.
   */
  async prune(
    surface: BackupSurface,
    targetId: string,
  ): Promise<number> {
    const snapshots = await this.list(surface, targetId, 1000);
    if (snapshots.length <= 1) return 0;

    const nowMs = Date.now();
    const mostRecentMs = new Date(snapshots[0].archivedAt).getTime();
    let toKeep: BackupSnapshot[];
    if (nowMs - mostRecentMs >= CUTOFF_MS) {
      toKeep = [snapshots[0]];
    } else {
      toKeep = snapshots
        .filter((s) => nowMs - new Date(s.archivedAt).getTime() < CUTOFF_MS)
        .slice(0, MAX_VERSIONS);
    }

    if (toKeep.length === snapshots.length) return 0;

    // Rewrite the file with kept snapshots in chronological order (so appends
    // at the end stay sensible). Atomic write via rename.
    const toWrite = [...toKeep].reverse();
    const path = jsonlPath(this.dataRoot, surface, targetId);
    const text = toWrite.map((s) => JSON.stringify(s)).join("\n") +
      (toWrite.length > 0 ? "\n" : "");
    const tmpPath = `${path}.tmp`;
    await Deno.writeTextFile(tmpPath, text);
    await Deno.rename(tmpPath, path);

    return snapshots.length - toKeep.length;
  }

  // ===========================================================================
  // Batch operations
  // ===========================================================================

  /**
   * Start a new batch. Returns the batch_id. Caller passes this to
   * `archive()` for each item in the batch; the manifest is updated as
   * snapshots are taken.
   */
  async startBatch(
    description?: string,
    reason?: string,
  ): Promise<string> {
    const batchId = crypto.randomUUID();
    const manifest: BatchManifest = {
      batchId,
      createdAt: new Date().toISOString(),
      ...(description ? { description } : {}),
      ...(reason ? { reason } : {}),
      items: [],
    };
    await ensureDir(batchesDir(this.dataRoot));
    await Deno.writeTextFile(
      batchManifestPath(this.dataRoot, batchId),
      JSON.stringify(manifest, null, 2),
    );
    return batchId;
  }

  /**
   * Record a snapshot in a batch's manifest. Called automatically by
   * `archive()` when `batchId` is passed — usually callers don't invoke
   * this directly.
   */
  async appendToBatch(
    batchId: string,
    snapshot: BackupSnapshot,
  ): Promise<void> {
    const manifestPath = batchManifestPath(this.dataRoot, batchId);
    try {
      const text = await Deno.readTextFile(manifestPath);
      const manifest = JSON.parse(text) as BatchManifest;
      manifest.items.push({
        surface: snapshot.surface,
        targetId: snapshot.targetId,
        snapshotId: snapshot.id,
      });
      const tmpPath = `${manifestPath}.tmp`;
      await Deno.writeTextFile(tmpPath, JSON.stringify(manifest, null, 2));
      await Deno.rename(tmpPath, manifestPath);
    } catch (err) {
      // If the manifest is missing, the batch was never started. Log and
      // continue — the snapshot still exists in its JSONL file, just not
      // indexed in a manifest.
      console.warn(
        `[backup] failed to append to batch ${batchId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * List recent batches, newest first.
   */
  async listBatches(limit = 50): Promise<BatchManifest[]> {
    const dir = batchesDir(this.dataRoot);
    let entries: Deno.DirEntry[];
    try {
      entries = Array.from(Deno.readDirSync(dir));
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return [];
      throw err;
    }
    const manifests: BatchManifest[] = [];
    for (const entry of entries) {
      if (!entry.isFile || !entry.name.endsWith(".json")) continue;
      try {
        const text = await Deno.readTextFile(join(dir, entry.name));
        manifests.push(JSON.parse(text) as BatchManifest);
      } catch {
        // skip corrupt
      }
    }
    manifests.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return manifests.slice(0, limit);
  }

  /**
   * Get a specific batch manifest.
   */
  async getBatch(batchId: string): Promise<BatchManifest | null> {
    try {
      const text = await Deno.readTextFile(
        batchManifestPath(this.dataRoot, batchId),
      );
      return JSON.parse(text) as BatchManifest;
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null;
      throw err;
    }
  }
}

// =============================================================================
// Singleton — mirrors the getQueryQueue / getWorkspaceSupervisor pattern.
// Constructed once during Server.init() with the dataRoot; call sites use
// getBackupService() to access it. Returns null before init / after stop.
// =============================================================================

let activeService: BackupService | null = null;

export function initBackupService(dataRoot: string): BackupService {
  activeService = new BackupService(dataRoot);
  return activeService;
}

export function getBackupService(): BackupService | null {
  return activeService;
}

/**
 * Convenience wrapper for the common pattern: "archive if service exists."
 * Returns the snapshot ID or null if the service isn't initialized (e.g.
 * during early startup or tests) or the archive failed. Backup errors are
 * logged but don't propagate — writes should still succeed even if the
 * backup layer is broken (availability over safety here; the alternative
 * is the entity can't edit anything if the disk is full, which is worse).
 */
export async function archiveIfAvailable(
  surface: BackupSurface,
  targetId: string,
  contentSnapshot: string,
  options?: { reason?: string; batchId?: string },
): Promise<string | null> {
  const service = getBackupService();
  if (!service) return null;
  try {
    const snapshotId = await service.archive(
      surface,
      targetId,
      contentSnapshot,
      options,
    );
    if (options?.batchId) {
      const snapshot = await service.get(surface, targetId, snapshotId);
      if (snapshot) {
        await service.appendToBatch(options.batchId, snapshot);
      }
    }
    return snapshotId;
  } catch (err) {
    console.error(
      `[backup] archive failed for ${surface}/${targetId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
